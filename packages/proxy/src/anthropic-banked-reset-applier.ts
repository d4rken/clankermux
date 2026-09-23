/**
 * Anthropic banked-reset auto-applier: opt-in per-account automation that
 * claims a banked reset before its grant expires unused, or when the account
 * hits a weekly limit the grant clears, backed by the
 * `anthropic_banked_reset_events` ledger.
 *
 * Two per-account toggles:
 *  - EXPIRY (`anthropic_auto_apply_banked_resets_enabled`): the next grant's
 *    use-by date is within {@link BANKED_RESET_AUTO_APPLY_LEAD_MS}, and the
 *    claim would be accepted (the grant needs no limit, or a window it clears
 *    is at its limit). Protects paused accounts too.
 *  - WEEKLY-LIMIT (`anthropic_auto_apply_banked_reset_on_weekly_limit_enabled`):
 *    a weekly window the grant clears is at its limit, the pause (if any) is
 *    one a reset lifts, the last cooldown-anchoring auto claim is an hour old,
 *    and no other Anthropic account can serve the same scope, unless the grant
 *    expires before that window resets on its own.
 *
 * Only the server's `next_grant_id` is ever claimed, and only a grant that
 * clears a weekly window: a 5h-only grant is manual-only.
 *
 * Every tick replays due pending auto claims first, with their stored request
 * id. An account with a pending manual claim starts no new attempt.
 * Discovery then reads only caches; a candidate it finds gets a forced
 * status read (at most one per account per
 * {@link BANKED_RESET_CONFIRM_READ_INTERVAL_MS}) and the decision is taken on
 * that before the ledger claim.
 */

import {
	FAMILY_PRIORITY,
	intervalManager,
	isAccountAvailable,
	type ModelFamily,
	normalizeAnthropicUsage,
	PAUSE_REASON_NEEDS_REAUTH,
} from "@clankermux/core";
import type {
	AccountPauseMarker,
	AnthropicBankedResetAutoClaim,
	AnthropicBankedResetEventRow,
	DatabaseOperations,
} from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import {
	anthropicBankedResetCache,
	type UsageData,
	usageCache,
} from "@clankermux/providers";
import {
	type Account,
	ANTHROPIC_BANKED_RESET_WINDOWS,
	type AnthropicBankedResetClaimRequest,
	type AnthropicBankedResetStatus,
	type AnthropicBankedResetWindow,
	type AnthropicUsageData,
} from "@clankermux/types";
import {
	isOveragePause,
	overagePauseVerdict,
} from "./anthropic-banked-reset-coordinator";
import { weeklyResetCanLiftPause } from "./codex-reset-credit-applier";
import { getFamilyWeeklyExhaustedUntil } from "./family-weekly-memo";
import {
	type AnthropicBankedResetClaimDispatchOutcome,
	claimAnthropicBankedResetForAccount,
} from "./handlers/token-manager";

const log = new Logger("AnthropicBankedResetApplier");

/** Expiry trigger: act once the next grant is within 10 minutes of its use-by date. */
export const BANKED_RESET_AUTO_APPLY_LEAD_MS = 10 * 60 * 1_000;
export const BANKED_RESET_AUTO_APPLY_TICK_MS = 60_000;
/**
 * Weekly-limit trigger: quiet for an hour after an auto claim resolved `reset`
 * or `already_used`, so a usage reading that lags the reset cannot spend a
 * second one. `not_limited`, `cooldown` and `ineligible` answers hold both
 * triggers through the ledger's re-arm deadline instead.
 */
export const BANKED_RESET_WEEKLY_LIMIT_COOLDOWN_MS = 60 * 60 * 1_000;
/**
 * At most one forced status read per account in this span. The read shares
 * the usage poll's rate-limit bucket, and an account held at its limit (a
 * grant conserved for another account's headroom) stays a candidate every
 * tick. Half the expiry lead, so an expiring grant still gets two chances.
 */
export const BANKED_RESET_CONFIRM_READ_INTERVAL_MS = 5 * 60 * 1_000;

export type BankedResetApplyCause = "expiry" | "weekly-limit";

export type BankedResetApplyDecision =
	| {
			action: "claim";
			grantId: string;
			grantEndsAt: number | null;
			cause: "expiry";
	  }
	| {
			action: "claim";
			grantId: string;
			grantEndsAt: number | null;
			cause: "weekly-limit";
			/** The exhausted weekly windows the grant clears. */
			windows: AnthropicBankedResetWindow[];
			/** The grant expires before one of those windows resets on its own. */
			lastChance: boolean;
	  }
	| {
			action: "skip";
			reason:
				| "account-disabled"
				| "toggle-disabled"
				| "not-anthropic-oauth"
				| "needs-reauth"
				| "no-status"
				| "ineligible"
				| "no-next-grant"
				| "grant-not-usable"
				| "grant-paused"
				| "grant-expired"
				| "server-cooldown"
				| "rearm"
				| "no-weekly-window"
				| "not-near-expiry"
				| "not-at-limit"
				| "weekly-not-exhausted"
				| "paused"
				| "cooldown"
				| "other-account-available";
	  };

type BankedResetSkip = Extract<BankedResetApplyDecision, { action: "skip" }>;

function isWeeklyWindow(window: AnthropicBankedResetWindow): boolean {
	return window.startsWith("seven_day");
}

const WEEKLY_WINDOWS = ANTHROPIC_BANKED_RESET_WINDOWS.filter(isWeeklyWindow);

/**
 * The model family a window limits, or null for an account-wide window
 * (`seven_day` and every other `seven_day*` window, and `five_hour`).
 */
export function bankedResetWindowFamily(
	window: AnthropicBankedResetWindow,
): ModelFamily | null {
	if (window === "seven_day_opus") return "opus";
	if (window === "seven_day_sonnet") return "sonnet";
	return null;
}

/**
 * One window's utilization and reset from a usage-cache reading, or null when
 * the reading does not report it. Scoped weekly windows come from the flat key
 * or, failing that, the `limits[]` entry for their family.
 */
export function readUsageWindow(
	usage: UsageData | null,
	window: AnthropicBankedResetWindow,
	now: number,
): { utilization: number; resetMs: number | null } | null {
	if (!usage) return null;
	const normalized = normalizeAnthropicUsage(
		usage as unknown as AnthropicUsageData,
		now,
	);
	if (window === "five_hour") return normalized.session;
	if (window === "seven_day") return normalized.weeklyAll;
	const flat = usage[window] as
		| { utilization?: unknown; resets_at?: unknown }
		| null
		| undefined;
	if (flat && typeof flat.utilization === "number") {
		const resetMs =
			typeof flat.resets_at === "string" ? Date.parse(flat.resets_at) : NaN;
		return {
			utilization: flat.utilization,
			resetMs: Number.isFinite(resetMs) ? resetMs : null,
		};
	}
	const family = bankedResetWindowFamily(window);
	const scoped = family
		? normalized.weeklyScoped.find((entry) => entry.family === family)
		: undefined;
	return scoped
		? { utilization: scoped.percent, resetMs: scoped.resetsAtMs }
		: null;
}

/**
 * Pure decision for one account. Shared gates first (a toggle on, Anthropic
 * OAuth, not needs-reauth), then the next grant's gates (usable now, not
 * paused, not expired, server cooldown passed, clears a weekly window), then
 * EXPIRY before WEEKLY-LIMIT so a claim both would make is audited as expiry.
 * The weekly "another account can serve the scope" gate is async and left to
 * the caller, which skips it when `lastChance` is set.
 */
export function decideBankedResetAction(inputs: {
	account: Pick<
		Account,
		| "provider"
		| "disabled"
		| "anthropic_auto_apply_banked_resets_enabled"
		| "anthropic_auto_apply_banked_reset_on_weekly_limit_enabled"
		| "pause_reason"
		| "paused"
		| "auto_pause_on_overage_enabled"
		| "refresh_token"
	>;
	status: AnthropicBankedResetStatus | null;
	/** MAX resolved_at of auto reset/already_used rows; weekly trigger only. */
	autoApplyCooldownAnchorAt: number | null;
	/**
	 * The ledger's re-arm deadline after a not_limited, cooldown or ineligible
	 * answer; holds both triggers. Null when none.
	 */
	rearmAt: number | null;
	/** When each window resets, from the usage cache; absent = unknown. */
	windowResetsAt: Partial<Record<AnthropicBankedResetWindow, number>>;
	now: number;
}): BankedResetApplyDecision {
	const {
		account,
		status,
		autoApplyCooldownAnchorAt,
		rearmAt,
		windowResetsAt,
		now,
	} = inputs;
	if (account.disabled) return { action: "skip", reason: "account-disabled" };
	const expiryEnabled = account.anthropic_auto_apply_banked_resets_enabled;
	const weeklyEnabled =
		account.anthropic_auto_apply_banked_reset_on_weekly_limit_enabled;
	if (!expiryEnabled && !weeklyEnabled) {
		return { action: "skip", reason: "toggle-disabled" };
	}
	if (account.provider !== "anthropic" || !account.refresh_token) {
		return { action: "skip", reason: "not-anthropic-oauth" };
	}
	if (account.pause_reason === PAUSE_REASON_NEEDS_REAUTH) {
		return { action: "skip", reason: "needs-reauth" };
	}
	if (!status) return { action: "skip", reason: "no-status" };
	if (!status.eligible) return { action: "skip", reason: "ineligible" };
	const grant = status.grants.find(
		(candidate) => candidate.id === status.nextGrantId,
	);
	if (!grant) return { action: "skip", reason: "no-next-grant" };
	if (!grant.usableNow) return { action: "skip", reason: "grant-not-usable" };
	if (grant.paused) return { action: "skip", reason: "grant-paused" };
	if (grant.endsAt !== null && grant.endsAt <= now) {
		return { action: "skip", reason: "grant-expired" };
	}
	if (status.cooldownUntil !== null && status.cooldownUntil > now) {
		return { action: "skip", reason: "server-cooldown" };
	}
	if (rearmAt !== null && rearmAt > now) {
		return { action: "skip", reason: "rearm" };
	}
	if (!grant.clears.some(isWeeklyWindow)) {
		return { action: "skip", reason: "no-weekly-window" };
	}

	let expirySkip: BankedResetSkip | null = null;
	if (expiryEnabled) {
		if (
			grant.endsAt === null ||
			grant.endsAt - now > BANKED_RESET_AUTO_APPLY_LEAD_MS
		) {
			expirySkip = { action: "skip", reason: "not-near-expiry" };
		} else if (
			grant.useRequiresLimit &&
			!grant.clears.some((window) => status.exhausted.includes(window))
		) {
			// The server would only answer not_limited.
			expirySkip = { action: "skip", reason: "not-at-limit" };
		} else {
			return {
				action: "claim",
				grantId: grant.id,
				grantEndsAt: grant.endsAt,
				cause: "expiry",
			};
		}
	}

	let weeklySkip: BankedResetSkip | null = null;
	if (weeklyEnabled) {
		const windows = grant.clears.filter(
			(window) => isWeeklyWindow(window) && status.exhausted.includes(window),
		);
		if (windows.length === 0) {
			weeklySkip = { action: "skip", reason: "weekly-not-exhausted" };
		} else if (!weeklyResetCanLiftPause(account)) {
			weeklySkip = { action: "skip", reason: "paused" };
		} else if (
			autoApplyCooldownAnchorAt !== null &&
			now - autoApplyCooldownAnchorAt < BANKED_RESET_WEEKLY_LIMIT_COOLDOWN_MS
		) {
			weeklySkip = { action: "skip", reason: "cooldown" };
		} else {
			const endsAt = grant.endsAt;
			const lastChance =
				endsAt !== null &&
				windows.some((window) => {
					const resetsAt =
						windowResetsAt[window] ??
						(window === "seven_day" ? status.weeklyResetsAt : null);
					return resetsAt != null && endsAt < resetsAt;
				});
			return {
				action: "claim",
				grantId: grant.id,
				grantEndsAt: endsAt,
				cause: "weekly-limit",
				windows,
				lastChance,
			};
		}
	}

	return (
		weeklySkip ?? expirySkip ?? { action: "skip", reason: "toggle-disabled" }
	);
}

/** Injectable dependencies; production wiring is {@link createAnthropicBankedResetApplyScheduler}. */
export interface BankedResetApplyDeps {
	/** Anthropic OAuth accounts with either toggle on. */
	listCandidateAccounts(): Promise<Array<{ id: string; name: string }>>;
	/** Resolve claims unconfirmed for an hour as `failed`; returns how many. */
	expireStaleAttempts(now: number): Promise<number>;
	/** Rows owing an overage-pause verdict, every account. */
	getRecoveryPending(): Promise<AnthropicBankedResetEventRow[]>;
	clearRecoveryPending(rowId: string): Promise<boolean>;
	/** The account's pause and its identity now; null for an unknown account. */
	getPauseMarker(accountId: string): Promise<AccountPauseMarker | null>;
	/** Lift the overage pause identified by `pauseEpoch`, and no later one. */
	resumeIfOveragePausedAt(
		accountId: string,
		pauseEpoch: number,
	): Promise<boolean>;
	/** The cached usage reading and when it was observed; never a network call. */
	peekUsageObservation(
		accountId: string,
	): { data: UsageData; observedAtMs: number | null } | null;
	/** One free usage read; false when it failed or the shared deadline held it. */
	refreshUsage(accountId: string): Promise<boolean>;
	getAccount(accountId: string): Promise<Account | null>;
	getCachedStatus(accountId: string): AnthropicBankedResetStatus | null;
	/** Non-forced is a cache-gated no-op while the status is fresh. */
	refreshStatus(accountId: string, force: boolean): Promise<boolean>;
	/** Unresolved claims of either trigger, oldest first. */
	getPendingAttempts(
		accountId: string,
	): Promise<AnthropicBankedResetEventRow[]>;
	getAutoApplyCooldownAnchorAt(accountId: string): Promise<number | null>;
	getRearmAt(accountId: string): Promise<number | null>;
	/** The status cache's own TTL rules: whether a read is due. */
	statusNeedsRefresh(accountId: string): boolean;
	/** Pure usage-cache read; never a network call. */
	getUsage(accountId: string): UsageData | null;
	/** Whether the family-weekly memo holds any entry for the account. */
	hasFamilyWeeklyMemo(accountId: string): boolean;
	/** Whether other accounts can serve every one of these exhausted windows. */
	hasOtherAvailableAccount(
		accountId: string,
		windows: AnthropicBankedResetWindow[],
	): Promise<boolean>;
	claimAutoAttempt(input: {
		accountId: string;
		accountName: string;
		grantId: string;
		grantEndsAt: number | null;
		cause: BankedResetApplyCause;
		now?: number;
	}): Promise<AnthropicBankedResetAutoClaim | null>;
	dispatchClaim(
		accountId: string,
		request: AnthropicBankedResetClaimRequest,
	): Promise<AnthropicBankedResetClaimDispatchOutcome>;
	now?(): number;
}

/**
 * Periodic auto-applier on `intervalManager`: an immediate tick, then one a
 * minute, never overlapping. Per-account failures are logged and never abort
 * the tick.
 */
export class AnthropicBankedResetApplyScheduler {
	private readonly deps: BankedResetApplyDeps;
	private stopInterval: (() => void) | null = null;
	private readonly intervalId = "anthropic-banked-reset-applier";
	private readonly confirmReadAt = new Map<string, number>();

	constructor(deps: BankedResetApplyDeps) {
		this.deps = { ...deps };
		this.deps.now ??= Date.now;
	}

	start(): void {
		log.info(
			`Anthropic banked-reset auto-applier starting: immediate tick, then every ${Math.round(BANKED_RESET_AUTO_APPLY_TICK_MS / 1_000)}s (lead ${Math.round(BANKED_RESET_AUTO_APPLY_LEAD_MS / 60_000)}min)`,
		);
		this.stopInterval = intervalManager.register({
			id: this.intervalId,
			callback: () => this.tick(),
			intervalMs: BANKED_RESET_AUTO_APPLY_TICK_MS,
			immediate: true,
			maxConcurrent: 1,
			description:
				"Anthropic banked-reset auto-applier (expiring-grant + weekly-limit claims)",
		});
	}

	stop(): void {
		if (this.stopInterval) {
			this.stopInterval();
			this.stopInterval = null;
		}
	}

	async tick(): Promise<void> {
		try {
			const expired = await this.deps.expireStaleAttempts(this.now());
			if (expired > 0) {
				log.info(
					`Banked-reset applier: gave up ${expired} claim(s) unconfirmed for an hour`,
				);
			}
		} catch (error) {
			log.warn(`Banked-reset applier: failed to expire stale claims: ${error}`);
		}
		await this.settleOwedOveragePauses();
		let candidates: Array<{ id: string; name: string }>;
		try {
			candidates = await this.deps.listCandidateAccounts();
		} catch (error) {
			log.warn(`Banked-reset applier: failed to list accounts: ${error}`);
			return;
		}
		for (const candidate of candidates) {
			try {
				await this.processAccount(candidate);
			} catch (error) {
				log.error(
					`Banked-reset applier: failed for account ${candidate.name} (${candidate.id}):`,
					error,
				);
			}
		}
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	/**
	 * Settle the overage-pause verdicts that spent resets still owe, for every
	 * account whatever its toggles: a reset whose post-claim usage read was
	 * unavailable left the pause standing, and nothing else lifts it when
	 * auto-fallback and auto-refresh are off. Only a reading observed after the
	 * claim resolved decides; this path never claims.
	 */
	private async settleOwedOveragePauses(): Promise<void> {
		let rows: AnthropicBankedResetEventRow[];
		try {
			rows = await this.deps.getRecoveryPending();
		} catch (error) {
			log.warn(`Banked-reset applier: failed to list owed verdicts: ${error}`);
			return;
		}
		const refreshed = new Set<string>();
		for (const row of rows) {
			try {
				await this.settleOwedOveragePause(row, refreshed);
			} catch (error) {
				log.error(
					`Banked-reset applier: failed to settle the overage pause owed by ${row.id}:`,
					error,
				);
			}
		}
	}

	private async settleOwedOveragePause(
		row: AnthropicBankedResetEventRow,
		refreshed: Set<string>,
	): Promise<void> {
		const until = row.recovery_pending_until;
		if (until === null) return;
		const name = row.account_name;
		if (this.now() >= until) {
			await this.deps.clearRecoveryPending(row.id);
			log.warn(
				`Banked-reset applier: no usage reading confirmed the reset of '${name}' within the hour; its overage pause stays`,
			);
			return;
		}
		// The verdict is owed to the pause standing when the claim was sent.
		// One lifted or replaced since is not that pause: a reading cannot speak
		// for it, and the obligation is void.
		const pauseEpoch = row.recovery_pause_epoch;
		const marker = await this.deps.getPauseMarker(row.account_id);
		if (
			pauseEpoch === null ||
			!marker ||
			marker.pauseEpoch !== pauseEpoch ||
			!isOveragePause(marker)
		) {
			await this.deps.clearRecoveryPending(row.id);
			log.info(
				`Banked-reset applier: the overage pause of '${name}' changed since its banked reset; nothing owed`,
			);
			return;
		}
		// Evidence must postdate both the claim and the pause it is for.
		const after = Math.max(
			row.resolved_at ?? row.created_at,
			row.recovery_pause_changed_at ?? 0,
		);
		const postClaimReading = () => {
			const observation = this.deps.peekUsageObservation(row.account_id);
			return observation?.observedAtMs != null &&
				observation.observedAtMs > after
				? observation.data
				: null;
		};
		let reading = postClaimReading();
		if (!reading && !refreshed.has(row.account_id)) {
			refreshed.add(row.account_id);
			await this.deps.refreshUsage(row.account_id).catch(() => false);
			reading = postClaimReading();
		}
		if (!reading) return;
		const verdict = overagePauseVerdict(reading, this.now());
		if (verdict.kind === "unknown") return;
		if (verdict.kind === "lift") {
			if (await this.deps.resumeIfOveragePausedAt(row.account_id, pauseEpoch)) {
				log.info(
					`Resumed '${name}' from its overage pause: a later usage reading confirmed its banked reset`,
				);
			}
		} else {
			log.info(
				`Overage pause of '${name}' kept: the reading after its banked reset is at a limit (${verdict.detail})`,
			);
		}
		await this.deps.clearRecoveryPending(row.id);
	}

	private async processAccount(candidate: {
		id: string;
		name: string;
	}): Promise<void> {
		const { id, name } = candidate;
		const account = await this.deps.getAccount(id);
		if (!account) return;

		const allPending = await this.deps.getPendingAttempts(id);
		const pending = allPending.filter((row) => row.trigger === "auto");
		if (pending.length > 0) {
			const now = this.now();
			// A backed-off claim holds the account until it is due: any new claim
			// for its grant would reuse its row and replay early.
			if (
				pending.some(
					(row) => row.next_attempt_at !== null && row.next_attempt_at > now,
				)
			) {
				return;
			}
			const replayable = pending.find((row) => this.mayReplay(account, row));
			if (replayable) {
				await this.dispatch(id, name, replayable.cause ?? "expiry", {
					grantId: replayable.grant_id,
					requestId: replayable.request_id,
					autoApply: {
						ledgerRowId: replayable.id,
						cause: replayable.cause ?? "expiry",
						replay: true,
					},
				});
				return;
			}
		}

		// Any unconfirmed claim may already have spent a reset; a new attempt
		// waits until it resolves or expires. A dormant auto row (its toggle off
		// or its pause not liftable) holds expiry protection too.
		if (allPending.length > 0) {
			log.debug(
				`Banked-reset applier: '${name}' has an unconfirmed claim; no new attempt`,
			);
			return;
		}

		if (account.anthropic_auto_apply_banked_resets_enabled) {
			await this.deps.refreshStatus(id, false);
		}
		if (!this.discover(account)) return;

		// An ineligible account stays ineligible until the cache's own TTL (6 h
		// for a stable reason) says to look again.
		const cached = this.deps.getCachedStatus(id);
		if (cached && !cached.eligible && !this.deps.statusNeedsRefresh(id)) {
			return;
		}

		// A claim only ever follows a forced read in the same tick.
		const lastRead = this.confirmReadAt.get(id);
		const now = this.now();
		if (
			lastRead !== undefined &&
			now - lastRead < BANKED_RESET_CONFIRM_READ_INTERVAL_MS
		) {
			return;
		}
		this.confirmReadAt.set(id, now);
		if (!(await this.deps.refreshStatus(id, true))) {
			log.debug(`Banked-reset applier: status read failed for '${name}'`);
			return;
		}
		const decision = await this.evaluate(id);
		if (!decision || decision.action !== "claim") {
			log.debug(
				`Banked-reset applier: no claim for '${name}' (${decision?.action === "skip" ? decision.reason : "account vanished"})`,
			);
			return;
		}

		const claim = await this.deps.claimAutoAttempt({
			accountId: id,
			accountName: name,
			grantId: decision.grantId,
			grantEndsAt: decision.grantEndsAt,
			cause: decision.cause,
			now: this.now(),
		});
		if (!claim) {
			log.debug(
				`Banked-reset applier: claim refused for '${name}' grant ${decision.grantId} (another claim is pending)`,
			);
			return;
		}
		await this.dispatch(id, name, decision.cause, {
			grantId: decision.grantId,
			requestId: claim.requestId,
			autoApply: {
				ledgerRowId: claim.id,
				cause: decision.cause,
				replay: claim.reused,
			},
		});
	}

	private mayReplay(
		account: Account,
		row: AnthropicBankedResetEventRow,
	): boolean {
		if (
			account.disabled ||
			account.provider !== "anthropic" ||
			!account.refresh_token ||
			account.pause_reason === PAUSE_REASON_NEEDS_REAUTH
		) {
			return false;
		}
		return row.cause === "weekly-limit"
			? account.anthropic_auto_apply_banked_reset_on_weekly_limit_enabled &&
					weeklyResetCanLiftPause(account)
			: account.anthropic_auto_apply_banked_resets_enabled;
	}

	/** Cheap: caches only. */
	private discover(account: Account): boolean {
		const now = this.now();
		const status = this.deps.getCachedStatus(account.id);
		if (account.anthropic_auto_apply_banked_reset_on_weekly_limit_enabled) {
			const usage = this.deps.getUsage(account.id);
			const weeklyAtLimit = WEEKLY_WINDOWS.some(
				(window) =>
					(readUsageWindow(usage, window, now)?.utilization ?? 0) >= 100,
			);
			if (
				weeklyAtLimit ||
				this.deps.hasFamilyWeeklyMemo(account.id) ||
				status?.exhausted.some(isWeeklyWindow)
			) {
				return true;
			}
		}
		if (account.anthropic_auto_apply_banked_resets_enabled && status) {
			const next = status.grants.find(
				(grant) => grant.id === status.nextGrantId,
			);
			if (
				next?.endsAt != null &&
				next.endsAt > now &&
				next.endsAt - now <= BANKED_RESET_AUTO_APPLY_LEAD_MS
			) {
				return true;
			}
		}
		return false;
	}

	private async evaluate(
		accountId: string,
	): Promise<BankedResetApplyDecision | null> {
		const account = await this.deps.getAccount(accountId);
		if (!account) return null;
		const now = this.now();
		const usage = this.deps.getUsage(accountId);
		const windowResetsAt: Partial<Record<AnthropicBankedResetWindow, number>> =
			{};
		for (const window of WEEKLY_WINDOWS) {
			const resetMs = readUsageWindow(usage, window, now)?.resetMs;
			if (resetMs != null) windowResetsAt[window] = resetMs;
		}
		const decision = decideBankedResetAction({
			account,
			status: this.deps.getCachedStatus(accountId),
			autoApplyCooldownAnchorAt:
				await this.deps.getAutoApplyCooldownAnchorAt(accountId),
			rearmAt: await this.deps.getRearmAt(accountId),
			windowResetsAt,
			now,
		});
		if (
			decision.action === "claim" &&
			decision.cause === "weekly-limit" &&
			!decision.lastChance &&
			(await this.deps.hasOtherAvailableAccount(accountId, decision.windows))
		) {
			return { action: "skip", reason: "other-account-available" };
		}
		return decision;
	}

	private async dispatch(
		accountId: string,
		name: string,
		cause: BankedResetApplyCause,
		request: AnthropicBankedResetClaimRequest,
	): Promise<void> {
		let outcome: AnthropicBankedResetClaimDispatchOutcome;
		try {
			outcome = await this.deps.dispatchClaim(accountId, request);
		} catch (error) {
			log.warn(
				`Banked-reset applier: claim threw for '${name}' grant ${request.grantId}; the pending row replays with the same request id: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (outcome.status === "failed") {
			log.warn(
				`Banked-reset applier: no claim sent for '${name}' grant ${request.grantId}: ${outcome.message}`,
			);
			return;
		}
		log.info(
			`Banked-reset applier: auto claim for '${name}' grant ${request.grantId} (cause ${cause}${request.autoApply?.replay ? ", replay" : ""}): ${outcome.result?.result ?? "already settled"}, ledger ${outcome.ledgerStatus}`,
		);
	}
}

/**
 * Whether `usage` shows an account able to serve `window`: the account-wide
 * 5-hour and weekly windows below their limits and, for another window, that
 * window below its limit too (a scoped window the reading omits is not a
 * limit). Null when either account-wide window is missing or stale.
 */
function servesWindow(
	accountId: string,
	usage: UsageData | null,
	window: AnthropicBankedResetWindow,
	now: number,
): boolean | null {
	const session = readUsageWindow(usage, "five_hour", now);
	const weekly = readUsageWindow(usage, "seven_day", now);
	const stale = (reading: { resetMs: number | null }) =>
		reading.resetMs !== null && reading.resetMs <= now;
	if (!session || !weekly || stale(session) || stale(weekly)) return null;
	if (session.utilization >= 100 || weekly.utilization >= 100) return false;
	if (window === "seven_day") return true;
	const family = bankedResetWindowFamily(window);
	if (
		family &&
		getFamilyWeeklyExhaustedUntil(accountId, family, now) !== null
	) {
		return false;
	}
	const scoped = readUsageWindow(usage, window, now);
	return !scoped || scoped.utilization < 100;
}

/**
 * Production wiring over DatabaseOperations, the coordinator's status read,
 * the shared caches and the token-manager claim registry.
 */
export function createAnthropicBankedResetApplyScheduler(wiring: {
	dbOps: Pick<
		DatabaseOperations,
		| "getAllAccounts"
		| "getAccount"
		| "getActiveApiKeys"
		| "expireStaleAnthropicBankedResetAttempts"
		| "getAnthropicBankedResetRecoveryPending"
		| "clearAnthropicBankedResetRecoveryPending"
		| "getAccountPauseMarker"
		| "resumeAccountIfOveragePausedAt"
		| "getPendingAnthropicBankedResetAttempts"
		| "getAnthropicBankedResetAutoApplyCooldownAnchorAt"
		| "getAnthropicBankedResetRearmAt"
		| "claimAnthropicBankedResetAutoAttempt"
	>;
	coordinator: {
		refreshStatus(
			accountId: string,
			force?: boolean,
		): Promise<{ success: boolean }>;
	};
	usage?: Pick<typeof usageCache, "get" | "peekWithAge" | "refreshNow">;
	overrides?: Partial<BankedResetApplyDeps>;
}): AnthropicBankedResetApplyScheduler {
	const { dbOps, coordinator, overrides } = wiring;
	const usage = wiring.usage ?? usageCache;
	const nowMs = overrides?.now ?? Date.now;
	// One usage read per unknown alternative per tick at most.
	const usageRefreshAttempts = new Map<string, number>();
	const usable = (account: Account, now: number) =>
		account.provider === "anthropic" &&
		Boolean(account.refresh_token) &&
		isAccountAvailable(account, now) &&
		account.pause_reason !== PAUSE_REASON_NEEDS_REAUTH;
	const readUsage = (accountId: string) =>
		usage.get(accountId) as UsageData | null;

	return new AnthropicBankedResetApplyScheduler({
		listCandidateAccounts: async () =>
			(await dbOps.getAllAccounts())
				.filter(
					(account) =>
						!account.disabled &&
						account.provider === "anthropic" &&
						Boolean(account.refresh_token) &&
						(account.anthropic_auto_apply_banked_resets_enabled ||
							account.anthropic_auto_apply_banked_reset_on_weekly_limit_enabled),
				)
				.map((account) => ({ id: account.id, name: account.name })),
		expireStaleAttempts: (now) =>
			dbOps.expireStaleAnthropicBankedResetAttempts(now),
		getRecoveryPending: () => dbOps.getAnthropicBankedResetRecoveryPending(),
		clearRecoveryPending: (rowId) =>
			dbOps.clearAnthropicBankedResetRecoveryPending(rowId),
		getPauseMarker: (accountId) => dbOps.getAccountPauseMarker(accountId),
		resumeIfOveragePausedAt: (accountId, pauseEpoch) =>
			dbOps.resumeAccountIfOveragePausedAt(accountId, pauseEpoch),
		peekUsageObservation: (accountId) => {
			const entry = usage.peekWithAge(accountId);
			return entry
				? { data: entry.data as UsageData, observedAtMs: entry.observedAtMs }
				: null;
		},
		// refreshNow sends nothing while the shared usage deadline stands.
		refreshUsage: (accountId) => usage.refreshNow(accountId),
		getAccount: (accountId) => dbOps.getAccount(accountId),
		getCachedStatus: (accountId) =>
			anthropicBankedResetCache.get(accountId)?.status ?? null,
		refreshStatus: async (accountId, force) =>
			(await coordinator.refreshStatus(accountId, force)).success,
		getPendingAttempts: (accountId) =>
			dbOps.getPendingAnthropicBankedResetAttempts(accountId),
		getAutoApplyCooldownAnchorAt: (accountId) =>
			dbOps.getAnthropicBankedResetAutoApplyCooldownAnchorAt(accountId),
		getRearmAt: (accountId) => dbOps.getAnthropicBankedResetRearmAt(accountId),
		statusNeedsRefresh: (accountId) =>
			anthropicBankedResetCache.needsRefresh(accountId, nowMs()),
		getUsage: readUsage,
		hasFamilyWeeklyMemo: (accountId) => {
			const now = nowMs();
			return FAMILY_PRIORITY.some(
				(family) =>
					getFamilyWeeklyExhaustedUntil(accountId, family, now) !== null,
			);
		},
		hasOtherAvailableAccount: async (accountId, windows) => {
			const [accounts, keys] = await Promise.all([
				dbOps.getAllAccounts(),
				dbOps.getActiveApiKeys(),
			]);
			// Traffic pinned to this account has no substitute.
			if (keys.some((key) => key.pinnedAccountId === accountId)) return false;
			const now = nowMs();
			for (const [id, attemptedAt] of usageRefreshAttempts) {
				if (now - attemptedAt >= BANKED_RESET_AUTO_APPLY_TICK_MS) {
					usageRefreshAttempts.delete(id);
				}
			}
			const served = new Set<AnthropicBankedResetWindow>();
			const unknown: Account[] = [];
			const note = (account: Account, at: number): boolean => {
				let anyUnknown = false;
				for (const window of windows) {
					const serves = servesWindow(
						account.id,
						readUsage(account.id),
						window,
						at,
					);
					if (serves === true) served.add(window);
					if (serves === null) anyUnknown = true;
				}
				return anyUnknown;
			};
			for (const account of accounts) {
				if (account.id === accountId || !usable(account, now)) continue;
				if (note(account, now)) unknown.push(account);
			}
			for (const account of unknown) {
				if (served.size === windows.length) break;
				if (!usageRefreshAttempts.has(account.id)) {
					usageRefreshAttempts.set(account.id, nowMs());
					try {
						// The free usage poll, never a model request.
						await usage.refreshNow(account.id);
					} catch (error) {
						log.debug(
							`Banked-reset pool usage read failed for '${account.name}': ${error}`,
						);
					}
				}
				const current = await dbOps.getAccount(account.id);
				if (current && usable(current, nowMs())) note(current, nowMs());
			}
			return served.size === windows.length;
		},
		claimAutoAttempt: (input) =>
			dbOps.claimAnthropicBankedResetAutoAttempt(input),
		dispatchClaim: (accountId, request) =>
			claimAnthropicBankedResetForAccount(accountId, request),
		...overrides,
	});
}
