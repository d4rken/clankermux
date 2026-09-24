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
 *    that window resets on its own no sooner than
 *    {@link BANKED_RESET_WEEKLY_LIMIT_MIN_GAIN_MS} from now, and no other
 *    Anthropic account can serve the same scope (one whose claim restored it
 *    within the hour serves until a later usage reading says otherwise). A
 *    grant that expires before that window resets passes the last two gates.
 *
 * Only the server's `next_grant_id` is ever claimed, and only a grant that
 * clears a weekly window: a 5h-only grant is manual-only.
 *
 * Every tick replays due pending auto claims first, with their stored request
 * id. An account with a pending manual claim starts no new attempt.
 * Discovery then reads only caches; a candidate it finds gets a forced
 * status read (at most one per account per
 * {@link BANKED_RESET_CONFIRM_READ_INTERVAL_MS}) and the decision is taken on
 * that before the ledger claim. Expiry claims are sent during the account
 * loop. Weekly-limit candidates are ranked latest natural reset first and
 * confirmed in that order until one claim is sent, so a tick spends at most
 * one grant on a weekly limit; a pending weekly-limit claim that may replay
 * takes that slot, whether it replays now or is backing off.
 */

import {
	FAMILY_PRIORITY,
	intervalManager,
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
	parseCleared,
} from "./anthropic-banked-reset-coordinator";
import { cooldownRulesOutAlternative } from "./banked-reset-alternative";
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
 * Weekly-limit trigger: a grant keeps the account's weekly reset day, so a
 * claim gains only the time until the cleared window would reset anyway. It
 * needs at least this much of it, unless the grant expires first.
 */
export const BANKED_RESET_WEEKLY_LIMIT_MIN_GAIN_MS = 12 * 60 * 60 * 1_000;
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
			/** The latest known natural reset among those windows. */
			resetsAt: number;
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
				| "weekly-reset-unknown"
				| "reset-soon"
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
 * When `window` resets on its own: the usage reading's time, else the status's
 * weekly reset for `seven_day`; null when neither knows.
 */
function naturalResetAt(
	window: AnthropicBankedResetWindow,
	windowResetsAt: Partial<Record<AnthropicBankedResetWindow, number>>,
	status: AnthropicBankedResetStatus | null,
): number | null {
	return (
		windowResetsAt[window] ??
		(window === "seven_day" ? (status?.weeklyResetsAt ?? null) : null)
	);
}

/** The grant expires before one of the windows resets on its own. */
function isLastChance(
	grantEndsAt: number | null,
	resets: Array<number | null>,
): boolean {
	return (
		grantEndsAt !== null &&
		resets.some((resetsAt) => resetsAt !== null && grantEndsAt < resetsAt)
	);
}

function latestReset(resets: Array<number | null>): number | null {
	const known = resets.filter((resetsAt) => resetsAt !== null);
	return known.length > 0 ? Math.max(...known) : null;
}

/**
 * Pure decision for one account. Shared gates first (a toggle on, Anthropic
 * OAuth, not needs-reauth), then the next grant's gates (usable now, not
 * paused, not expired, server cooldown passed, clears a weekly window), then
 * EXPIRY before WEEKLY-LIMIT so a claim both would make is audited as expiry.
 * WEEKLY-LIMIT needs one of the windows it clears to reset on its own no
 * sooner than {@link BANKED_RESET_WEEKLY_LIMIT_MIN_GAIN_MS} from now, unless
 * `lastChance` is set; an unknown reset fails closed. The weekly
 * "another account can serve the scope" gate is async and left to the
 * caller, which skips it when `lastChance` is set.
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
			const resets = windows.map((window) =>
				naturalResetAt(window, windowResetsAt, status),
			);
			const lastChance = isLastChance(grant.endsAt, resets);
			const resetsAt = latestReset(resets);
			if (resetsAt === null) {
				weeklySkip = { action: "skip", reason: "weekly-reset-unknown" };
			} else if (
				lastChance ||
				resetsAt - now >= BANKED_RESET_WEEKLY_LIMIT_MIN_GAIN_MS
			) {
				return {
					action: "claim",
					grantId: grant.id,
					grantEndsAt: grant.endsAt,
					cause: "weekly-limit",
					windows,
					resetsAt,
					lastChance,
				};
			} else {
				weeklySkip = { action: "skip", reason: "reset-soon" };
			}
		}
	}

	return (
		weeklySkip ?? expirySkip ?? { action: "skip", reason: "toggle-disabled" }
	);
}

type BankedResetClaimDecision = Extract<
	BankedResetApplyDecision,
	{ action: "claim" }
>;

function nextGrant(status: AnthropicBankedResetStatus | null) {
	return (
		status?.grants.find((grant) => grant.id === status.nextGrantId) ?? null
	);
}

/** Family-weekly memo entries: when each exhausted family's window resets. */
export type FamilyWeeklyMemo = Partial<Record<ModelFamily, number>>;

/**
 * When each weekly window resets: the usage reading's time, else, for a
 * family window, the family-weekly memo's.
 */
function windowResets(
	usage: UsageData | null,
	memo: FamilyWeeklyMemo,
	now: number,
): Partial<Record<AnthropicBankedResetWindow, number>> {
	const resets: Partial<Record<AnthropicBankedResetWindow, number>> = {};
	for (const window of WEEKLY_WINDOWS) {
		const family = bankedResetWindowFamily(window);
		const resetMs =
			readUsageWindow(usage, window, now)?.resetMs ??
			(family === null ? undefined : memo[family]);
		if (resetMs != null) resets[window] = resetMs;
	}
	return resets;
}

/** Weekly windows at their limit in usage, the family-weekly memo or `status`. */
function atLimitWeeklyWindows(
	usage: UsageData | null,
	memo: FamilyWeeklyMemo,
	status: AnthropicBankedResetStatus | null,
	now: number,
): AnthropicBankedResetWindow[] {
	return WEEKLY_WINDOWS.filter((window) => {
		const family = bankedResetWindowFamily(window);
		return (
			(readUsageWindow(usage, window, now)?.utilization ?? 0) >= 100 ||
			(family !== null && memo[family] !== undefined) ||
			(status?.exhausted.includes(window) ?? false)
		);
	});
}

/** A weekly-limit claim that passed discovery and awaits ranking. */
interface WeeklyProposal {
	candidate: { id: string; name: string };
	/** The latest known natural reset among the windows it would clear. */
	resetsAt: number | null;
	grantEndsAt: number | null;
}

/**
 * Pick order among weekly proposals: latest natural reset first (the grant
 * gains the most time there), then the grant that ends first; unknowns last.
 */
function compareWeeklyProposals(a: WeeklyProposal, b: WeeklyProposal): number {
	return (
		compareKnownFirst(a.resetsAt, b.resetsAt, (x, y) => y - x) ||
		compareKnownFirst(a.grantEndsAt, b.grantEndsAt, (x, y) => x - y)
	);
}

function compareKnownFirst(
	a: number | null,
	b: number | null,
	compare: (a: number, b: number) => number,
): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return compare(a, b);
}

/** Injectable dependencies; production wiring is {@link createAnthropicBankedResetApplyScheduler}. */
export interface BankedResetApplyDeps {
	/** Anthropic OAuth accounts with either toggle on. */
	listCandidateAccounts(): Promise<Array<{ id: string; name: string }>>;
	/** Resolve claims whose replay window closed as `failed`; returns how many. */
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
	/** The account's family-weekly memo entries. */
	getFamilyWeeklyMemo(accountId: string): FamilyWeeklyMemo;
	/**
	 * Whether other accounts can serve every one of these exhausted windows.
	 * A usable account whose usage stays unknown counts as able to serve.
	 * So does one with a `reset` or `already_used` claim resolved within
	 * {@link BANKED_RESET_WEEKLY_LIMIT_COOLDOWN_MS}, for each window the claim
	 * cleared (every window when `cleared` is unknown), until a usage reading
	 * observed after the claim decides instead; an overage pause does not
	 * exclude it.
	 */
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
					`Banked-reset applier: gave up ${expired} claim(s) whose replay window closed`,
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
		const readThisTick = new Set<string>();
		const weekly: WeeklyProposal[] = [];
		let weeklyHeld = false;
		for (const candidate of candidates) {
			try {
				const pass = await this.processAccount(candidate, readThisTick);
				if (pass === "weekly-held") weeklyHeld = true;
				else if (pass) weekly.push(pass);
			} catch (error) {
				log.error(
					`Banked-reset applier: failed for account ${candidate.name} (${candidate.id}):`,
					error,
				);
			}
		}

		// A pending weekly-limit claim that may replay is this tick's weekly
		// claim, whatever it answered and whether or not it was due.
		if (weeklyHeld) return;
		weekly.sort(compareWeeklyProposals);
		for (const proposal of weekly) {
			const { candidate } = proposal;
			try {
				const decision = await this.confirm(candidate, readThisTick);
				if (!decision || !(await this.claimAndDispatch(candidate, decision))) {
					continue;
				}
				if (decision.cause !== "weekly-limit") continue;
				if (weekly.length > 1) {
					log.info(
						`Banked-reset applier: the weekly-limit claim went to '${candidate.name}' (natural reset ${new Date(decision.resetsAt).toISOString()}) out of ${weekly.length} candidates`,
					);
				}
				return;
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

	/**
	 * Replays a due pending claim, or runs discovery. An expiry claim is
	 * confirmed and dispatched here; a weekly-limit one is returned for ranking.
	 */
	private async processAccount(
		candidate: { id: string; name: string },
		readThisTick: Set<string>,
	): Promise<WeeklyProposal | "weekly-held" | null> {
		const { id, name } = candidate;
		const account = await this.deps.getAccount(id);
		if (!account) return null;

		const allPending = await this.deps.getPendingAttempts(id);
		const pending = allPending.filter((row) => row.trigger === "auto");
		if (pending.length > 0) {
			const now = this.now();
			// Its outcome stays unknown until a replay lands, and meanwhile its
			// account still reads as exhausted to every pool check.
			const held = pending.some(
				(row) => row.cause === "weekly-limit" && this.mayReplay(account, row),
			)
				? "weekly-held"
				: null;
			// A backed-off claim holds the account until it is due: any new claim
			// for its grant would reuse its row and replay early.
			if (
				pending.some(
					(row) => row.next_attempt_at !== null && row.next_attempt_at > now,
				)
			) {
				return held;
			}
			const replayable = pending.find((row) => this.mayReplay(account, row));
			if (replayable) {
				const cause = replayable.cause ?? "expiry";
				await this.dispatch(id, name, cause, {
					grantId: replayable.grant_id,
					requestId: replayable.request_id,
					autoApply: {
						ledgerRowId: replayable.id,
						cause,
						replay: true,
					},
				});
				return held;
			}
		}

		// Any unconfirmed claim may already have spent a reset; a new attempt
		// waits until it resolves or expires. A dormant auto row (its toggle off
		// or its pause not liftable) holds expiry protection too.
		if (allPending.length > 0) {
			log.debug(
				`Banked-reset applier: '${name}' has an unconfirmed claim; no new attempt`,
			);
			return null;
		}

		const now = this.now();
		const usage = this.deps.getUsage(id);
		const memo = this.deps.getFamilyWeeklyMemo(id);
		// Discovery trusts the cached next grant, so a weekly limit keeps it
		// within the cache's own TTL.
		if (
			account.anthropic_auto_apply_banked_resets_enabled ||
			(account.anthropic_auto_apply_banked_reset_on_weekly_limit_enabled &&
				(Object.keys(memo).length > 0 ||
					atLimitWeeklyWindows(usage, memo, null, now).length > 0))
		) {
			await this.deps.refreshStatus(id, false);
		}
		const status = this.deps.getCachedStatus(id);
		const discovery = this.discover(account, status, usage, memo, now);
		if (!discovery) return null;

		// An ineligible account stays ineligible until the cache's own TTL (6 h
		// for a stable reason) says to look again.
		if (status && !status.eligible && !this.deps.statusNeedsRefresh(id)) {
			return null;
		}

		if (discovery.kind === "weekly") {
			return this.weeklyProposal(
				candidate,
				status,
				discovery.windows,
				usage,
				memo,
			);
		}
		const decision = await this.confirm(candidate, readThisTick);
		if (!decision) return null;
		if (decision.cause === "weekly-limit") {
			return {
				candidate,
				resetsAt: decision.resetsAt,
				grantEndsAt: decision.grantEndsAt,
			};
		}
		await this.claimAndDispatch(candidate, decision);
		return null;
	}

	/**
	 * A weekly-only candidate, ranked on cached readings; its forced read waits
	 * for confirmation. Null when the cached readings already fail the
	 * decision's minimum-gain or cooldown gate, or when another account can
	 * serve the at-limit windows and the grant outlives them. Without a cached
	 * grant the last chance is unknowable and taken as false.
	 */
	private async weeklyProposal(
		candidate: { id: string; name: string },
		status: AnthropicBankedResetStatus | null,
		windows: AnthropicBankedResetWindow[],
		usage: UsageData | null,
		memo: FamilyWeeklyMemo,
	): Promise<WeeklyProposal | null> {
		const { id, name } = candidate;
		const now = this.now();
		const windowResetsAt = windowResets(usage, memo, now);
		const resets = windows.map((window) =>
			naturalResetAt(window, windowResetsAt, status),
		);
		const grantEndsAt = nextGrant(status)?.endsAt ?? null;
		const lastChance = isLastChance(grantEndsAt, resets);
		const resetsAt = latestReset(resets);
		// An unknown reset still goes to the forced read, which may supply one.
		if (
			!lastChance &&
			resetsAt !== null &&
			resetsAt - now < BANKED_RESET_WEEKLY_LIMIT_MIN_GAIN_MS
		) {
			log.debug(
				`Banked-reset applier: '${name}' resets on its own within the minimum gain; no status read`,
			);
			return null;
		}
		const cooldownAnchorAt = await this.deps.getAutoApplyCooldownAnchorAt(id);
		if (
			cooldownAnchorAt !== null &&
			now - cooldownAnchorAt < BANKED_RESET_WEEKLY_LIMIT_COOLDOWN_MS
		) {
			log.debug(
				`Banked-reset applier: '${name}' is in its weekly-limit cooldown; no status read`,
			);
			return null;
		}
		if (
			!lastChance &&
			windows.length > 0 &&
			(await this.deps.hasOtherAvailableAccount(id, windows))
		) {
			log.debug(
				`Banked-reset applier: another account can serve '${name}' at its weekly limit; no status read`,
			);
			return null;
		}
		return { candidate, resetsAt, grantEndsAt };
	}

	/**
	 * The forced status read a claim follows, at most one per account per
	 * {@link BANKED_RESET_CONFIRM_READ_INTERVAL_MS} and reused within the tick,
	 * then the decision on it. Null unless that decision is a claim.
	 */
	private async confirm(
		candidate: { id: string; name: string },
		readThisTick: Set<string>,
	): Promise<BankedResetClaimDecision | null> {
		const { id, name } = candidate;
		if (!readThisTick.has(id)) {
			const lastRead = this.confirmReadAt.get(id);
			const now = this.now();
			if (
				lastRead !== undefined &&
				now - lastRead < BANKED_RESET_CONFIRM_READ_INTERVAL_MS
			) {
				return null;
			}
			this.confirmReadAt.set(id, now);
			if (!(await this.deps.refreshStatus(id, true))) {
				log.debug(`Banked-reset applier: status read failed for '${name}'`);
				return null;
			}
			readThisTick.add(id);
		}
		const decision = await this.evaluate(id);
		if (!decision || decision.action !== "claim") {
			log.debug(
				`Banked-reset applier: no claim for '${name}' (${decision?.action === "skip" ? decision.reason : "account vanished"})`,
			);
			return null;
		}
		return decision;
	}

	/** False when the ledger refused the claim. */
	private async claimAndDispatch(
		candidate: { id: string; name: string },
		decision: BankedResetClaimDecision,
	): Promise<boolean> {
		const { id, name } = candidate;
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
			return false;
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
		return true;
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

	/**
	 * Cheap: caches only. The weekly trigger fires on a weekly window at its
	 * limit in usage, the family-weekly memo or the cached status; once a
	 * status is cached, only on one its next grant clears. The expiry trigger
	 * takes precedence: its forced read decides both.
	 */
	private discover(
		account: Account,
		status: AnthropicBankedResetStatus | null,
		usage: UsageData | null,
		memo: FamilyWeeklyMemo,
		now: number,
	):
		| { kind: "expiry" }
		| { kind: "weekly"; windows: AnthropicBankedResetWindow[] }
		| null {
		const grant = nextGrant(status);
		if (
			account.anthropic_auto_apply_banked_resets_enabled &&
			grant?.endsAt != null &&
			grant.endsAt > now &&
			grant.endsAt - now <= BANKED_RESET_AUTO_APPLY_LEAD_MS
		) {
			return { kind: "expiry" };
		}
		if (!account.anthropic_auto_apply_banked_reset_on_weekly_limit_enabled) {
			return null;
		}
		const atLimit = atLimitWeeklyWindows(usage, memo, status, now);
		if (!status) {
			// The forced read fills in the status.
			return atLimit.length > 0 || Object.keys(memo).length > 0
				? { kind: "weekly", windows: atLimit }
				: null;
		}
		const windows = grant
			? atLimit.filter((window) => grant.clears.includes(window))
			: [];
		return windows.length > 0 ? { kind: "weekly", windows } : null;
	}

	private async evaluate(
		accountId: string,
	): Promise<BankedResetApplyDecision | null> {
		const account = await this.deps.getAccount(accountId);
		if (!account) return null;
		const now = this.now();
		const decision = decideBankedResetAction({
			account,
			status: this.deps.getCachedStatus(accountId),
			autoApplyCooldownAnchorAt:
				await this.deps.getAutoApplyCooldownAnchorAt(accountId),
			rearmAt: await this.deps.getRearmAt(accountId),
			windowResetsAt: windowResets(
				this.deps.getUsage(accountId),
				this.deps.getFamilyWeeklyMemo(accountId),
				now,
			),
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
		| "getRestoringAnthropicBankedResetEventsSince"
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
	// One usage read per unknown alternative per forced-read interval: unknown
	// already blocks the claim, so reading it sooner saves nothing.
	const usageRefreshAttempts = new Map<string, number>();
	const reachable = (account: Account, now: number) =>
		account.provider === "anthropic" &&
		Boolean(account.refresh_token) &&
		!account.disabled &&
		!cooldownRulesOutAlternative(account, now) &&
		account.pause_reason !== PAUSE_REASON_NEEDS_REAUTH;
	const usable = (account: Account, now: number) =>
		reachable(account, now) && !account.paused;
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
		getFamilyWeeklyMemo: (accountId) => {
			const now = nowMs();
			const memo: FamilyWeeklyMemo = {};
			for (const family of FAMILY_PRIORITY) {
				const until = getFamilyWeeklyExhaustedUntil(accountId, family, now);
				if (until !== null) memo[family] = until;
			}
			return memo;
		},
		hasOtherAvailableAccount: async (accountId, windows) => {
			const now = nowMs();
			const [accounts, keys, restoringRows] = await Promise.all([
				dbOps.getAllAccounts(),
				dbOps.getActiveApiKeys(),
				dbOps.getRestoringAnthropicBankedResetEventsSince(
					now - BANKED_RESET_WEEKLY_LIMIT_COOLDOWN_MS,
				),
			]);
			// Traffic pinned to this account has no substitute.
			if (keys.some((key) => key.pinnedAccountId === accountId)) return false;
			for (const [id, attemptedAt] of usageRefreshAttempts) {
				if (now - attemptedAt >= BANKED_RESET_CONFIRM_READ_INTERVAL_MS) {
					usageRefreshAttempts.delete(id);
				}
			}
			const restoring = new Map<string, AnthropicBankedResetEventRow[]>();
			for (const row of restoringRows) {
				if (row.account_id === accountId) continue;
				restoring.set(row.account_id, [
					...(restoring.get(row.account_id) ?? []),
					row,
				]);
			}
			// The windows an alternative's restoring claims still hold open: those
			// no usage reading taken since the claim has settled.
			const heldWindows = (id: string): AnthropicBankedResetWindow[] => {
				const rows = restoring.get(id);
				if (!rows) return [];
				const observedAt = usage.peekWithAge(id)?.observedAtMs ?? null;
				return windows.filter((window) =>
					rows.some((row) => {
						if (row.resolved_at === null) return false;
						if (observedAt !== null && observedAt > row.resolved_at) {
							return false;
						}
						const cleared = parseCleared(row.cleared);
						return cleared.length === 0 || cleared.includes(window);
					}),
				);
			};
			const holders: string[] = [];
			const served = new Set<AnthropicBankedResetWindow>();
			const coversAll = () => {
				const covered = new Set(served);
				for (const id of holders) {
					for (const window of heldWindows(id)) covered.add(window);
				}
				return covered.size === windows.length;
			};
			const unknown: Account[] = [];
			const note = (
				account: Account,
				at: number,
				unknownServes: boolean,
			): boolean => {
				let anyUnknown = false;
				for (const window of windows) {
					const serves = servesWindow(
						account.id,
						readUsage(account.id),
						window,
						at,
					);
					if (serves === true || (serves === null && unknownServes)) {
						served.add(window);
					}
					if (serves === null) anyUnknown = true;
				}
				return anyUnknown;
			};
			for (const account of accounts) {
				if (account.id === accountId) continue;
				if (usable(account, now)) {
					if (restoring.has(account.id)) holders.push(account.id);
					if (note(account, now, false)) unknown.push(account);
				} else if (
					// The weekly trigger claims through an overage pause, and only a
					// post-claim reading lifts it.
					restoring.has(account.id) &&
					account.paused &&
					reachable(account, now)
				) {
					const marker = await dbOps.getAccountPauseMarker(account.id);
					if (marker && isOveragePause(marker)) holders.push(account.id);
				}
			}
			// One read each; a reading that stays unknown counts as able to serve.
			for (const account of unknown) {
				if (coversAll()) break;
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
				if (current && usable(current, nowMs())) note(current, nowMs(), true);
			}
			return coversAll();
		},
		claimAutoAttempt: (input) =>
			dbOps.claimAnthropicBankedResetAutoAttempt(input),
		dispatchClaim: (accountId, request) =>
			claimAnthropicBankedResetForAccount(accountId, request),
		...overrides,
	});
}
