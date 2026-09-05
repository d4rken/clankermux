/**
 * Codex reset-credit auto-applier — opt-in per-account automation that redeems
 * an earned usage-limit reset credit shortly before it expires, backed by the
 * durable `codex_reset_credit_events` claim/resolve ledger.
 *
 * Design notes:
 *  - Two independent per-account OPT-IN triggers:
 *      EXPIRY (`codex_auto_apply_reset_credits_enabled`) — redeem a credit
 *      shortly before it expires; and
 *      WEEKLY-LIMIT (`codex_auto_apply_reset_on_weekly_limit_enabled`) —
 *      redeem a credit when the cached 7-day usage window is exhausted
 *      (>= 100%) and no other usable Codex account has quota available,
 *      rate-limited by a 1h cooldown anchored on the last auto
 *      resolution (reset/alreadyRedeemed/nothingToReset) so stale usage data
 *      can't drain credits back-to-back and a stuck 100% reading can't hammer
 *      the redeem endpoint every tick. When both
 *      triggers apply to the same credit the audit cause is "expiry" (the
 *      more urgent reason — the credit was about to be lost anyway).
 *    Expiry protection includes paused accounts. Weekly redemption skips any
 *    pause the restored window cannot lift — everything except an overage
 *    pause that auto-resume will clear (see {@link weeklyResetCanLiftPause}).
 *    Needs-reauth accounts are excluded from both triggers.
 *  - Two-phase tick per candidate: DISCOVERY runs on the cheap TTL-gated cache
 *    read; only when discovery says "consume" does CONFIRMATION force a fresh
 *    metadata read and re-run every gate (last-moment toggle flip, credit
 *    vanished/redeemed elsewhere) before touching the ledger.
 *  - The ledger claim happens BEFORE the dispatch so a crash mid-consume
 *    retries with the SAME idempotency key (the pending row is reused). The
 *    applier never resolves ledger rows — the spend coordinator does that when
 *    the consume yields a business outcome; a dispatch failure/throw leaves the
 *    row pending on purpose.
 *  - One credit per account per tick: the next near-expiry credit is picked up
 *    on a later tick once the first attempt resolves.
 *  - Everything is injectable ({@link CodexResetCreditApplyDeps}) so tests use
 *    plain doubles + a fake clock — no mock.module.
 */

import {
	intervalManager,
	isAccountAvailable,
	PAUSE_REASON_NEEDS_REAUTH,
} from "@clankermux/core";
import type {
	CodexResetCreditAutoClaim,
	CodexResetCreditEventRow,
	DatabaseOperations,
} from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import {
	type CodexRateLimitResetCredit,
	type CodexRateLimitResetCreditsCacheEntry,
	codexRateLimitResetCreditsCache,
	getAccountCapacitySignal,
	type UsageData,
	usageCache,
} from "@clankermux/providers";
import type {
	Account,
	CodexRateLimitResetCreditConsumeRequest,
} from "@clankermux/types";
import {
	type CodexResetCreditConsumeDispatchOutcome,
	consumeCodexResetCreditForAccount,
} from "./handlers/token-manager";

const log = new Logger("CodexResetCreditApplier");

/** Apply window: act once a credit is within 10 minutes of expiring. */
export const RESET_CREDIT_AUTO_APPLY_LEAD_MS = 10 * 60 * 1_000;
/** Tick cadence (1 min) — comfortably inside the 10-minute lead window. */
export const RESET_CREDIT_AUTO_APPLY_TICK_MS = 60_000;
/**
 * Weekly-limit trigger cooldown: after ANY cooldown-anchoring auto resolution
 * (`reset`/`alreadyRedeemed`/`nothingToReset`), the weekly-limit trigger stays
 * quiet for an hour. The 7-day used percent it consumes is a cache that may
 * lag the applied reset, so without this floor a stale "100%" reading would
 * drain a second (and third…) credit back-to-back — and a `nothingToReset`
 * outcome (which re-arms the claim) would otherwise retry the redeem endpoint
 * every tick while weekly usage stays >= 100%. Gates ONLY the weekly-limit
 * trigger; the EXPIRY trigger ignores it entirely.
 */
export const RESET_CREDIT_WEEKLY_LIMIT_COOLDOWN_MS = 60 * 60 * 1_000;

/** Why a consume fired: the ledger's audit `cause`. */
export type ResetCreditApplyCause = "expiry" | "weekly-limit";

/**
 * What the applier should do for one account right now. `expiresAt` is the
 * credit's expiry in unix SECONDS (the ledger's `credit_expires_at` unit);
 * null = a non-expiring credit (only reachable via the weekly-limit trigger).
 */
export type ResetCreditApplyDecision =
	| {
			action: "consume";
			creditId: string;
			expiresAt: number | null;
			cause: ResetCreditApplyCause;
	  }
	| {
			action: "skip";
			reason:
				| "toggle-disabled"
				| "not-codex"
				| "needs-reauth"
				| "no-tokens"
				| "no-credit-near-expiry"
				| "weekly-not-exhausted"
				| "other-account-available"
				| "paused"
				| "cooldown"
				| "no-credit-available"
				| "already-resolved";
	  };

type ResetCreditSkip = Extract<ResetCreditApplyDecision, { action: "skip" }>;

/**
 * Whether a restored weekly window can lift this account's pause.
 *
 * Mirrors the auto-resume guard in auto-refresh-scheduler
 * (`auto_pause_on_overage_enabled` AND `pause_reason` IN (NULL, 'overage')).
 * That guard is the only thing that un-pauses an account without an operator,
 * so it is also the only pause a weekly reset credit buys anything for: the
 * account is on paid credits because its week is spent, the reset ends that,
 * and the next prime resumes it. Every other pause — manual, failure
 * threshold, subscription expiry, a reason this code has never seen — keeps
 * the account out of routing after the reset, and the credit is better kept
 * for the expiry trigger or a later exhaustion. Unpaused accounts pass.
 */
export function weeklyResetCanLiftPause(
	account: Pick<
		Account,
		"paused" | "pause_reason" | "auto_pause_on_overage_enabled"
	>,
): boolean {
	if (!account.paused) return true;
	return (
		Boolean(account.auto_pause_on_overage_enabled) &&
		(account.pause_reason == null || account.pause_reason === "overage")
	);
}

/**
 * Pure decision function — no I/O, injectable clock. Shared gates run first:
 * at least one opt-in toggle → codex provider → not needs-reauth (a dead
 * refresh token means no consume can succeed) → holds a refresh token. Then each enabled
 * trigger is evaluated, EXPIRY first so a credit that satisfies both is
 * audited under the more urgent cause:
 *
 *  - EXPIRY: `available` credits whose expiry is in the future but within
 *    {@link RESET_CREDIT_AUTO_APPLY_LEAD_MS}, soonest-first.
 *  - WEEKLY-LIMIT: fires only when the cached 7-day used percent is a known
 *    number >= 100 (null/unknown FAILS CLOSED), any pause is one the reset
 *    can lift ({@link weeklyResetCanLiftPause}), and no cooldown-anchoring auto
 *    resolution happened within {@link RESET_CREDIT_WEEKLY_LIMIT_COOLDOWN_MS}.
 *    Any
 *    unexpired `available` credit qualifies, soonest-expiring first with
 *    non-expiring credits eligible last.
 *
 * In both triggers, ids the ledger has terminally resolved are skipped (their
 * automation is done). When neither trigger fires, the more specific skip
 * reason wins: an expiry "already-resolved" beats a weekly reason, otherwise
 * the weekly reason (weekly-not-exhausted/cooldown/…) beats the generic
 * "no-credit-near-expiry".
 */
export function decideResetCreditAction(inputs: {
	account: Pick<
		Account,
		| "provider"
		| "codex_auto_apply_reset_credits_enabled"
		| "codex_auto_apply_reset_on_weekly_limit_enabled"
		| "pause_reason"
		| "paused"
		| "auto_pause_on_overage_enabled"
		| "refresh_token"
		| "access_token"
	>;
	credits: CodexRateLimitResetCredit[] | null;
	terminallyResolvedCreditIds: ReadonlySet<string>;
	/** Cached 7-day used percent; null = unknown → weekly trigger stays off. */
	weeklyUsedPercent: number | null;
	/**
	 * MAX resolved_at (ms) of cooldown-anchoring auto resolutions
	 * (reset/alreadyRedeemed/nothingToReset); null = never. Gates ONLY the
	 * weekly-limit trigger.
	 */
	autoApplyCooldownAnchorAt: number | null;
	/** Current time in ms. */
	now: number;
}): ResetCreditApplyDecision {
	const {
		account,
		credits,
		terminallyResolvedCreditIds,
		weeklyUsedPercent,
		autoApplyCooldownAnchorAt,
		now,
	} = inputs;

	const expiryEnabled = account.codex_auto_apply_reset_credits_enabled;
	const weeklyEnabled = account.codex_auto_apply_reset_on_weekly_limit_enabled;
	if (!expiryEnabled && !weeklyEnabled) {
		return { action: "skip", reason: "toggle-disabled" };
	}
	if (account.provider !== "codex") {
		return { action: "skip", reason: "not-codex" };
	}
	if (account.pause_reason === PAUSE_REASON_NEEDS_REAUTH) {
		return { action: "skip", reason: "needs-reauth" };
	}
	if (!account.refresh_token) {
		return { action: "skip", reason: "no-tokens" };
	}

	// Unexpired `available` credits, soonest-expiring first, non-expiring last
	// (an already-expired credit is no longer actionable for EITHER trigger).
	const available = (credits ?? [])
		.flatMap((credit) =>
			credit.status === "available"
				? [{ id: credit.id, expiresAt: credit.expiresAt }]
				: [],
		)
		.filter(({ expiresAt }) => expiresAt === null || expiresAt * 1_000 > now)
		.sort(
			(a, b) =>
				(a.expiresAt ?? Number.POSITIVE_INFINITY) -
				(b.expiresAt ?? Number.POSITIVE_INFINITY),
		);

	// EXPIRY trigger — expiring credits inside the lead window.
	let expirySkip: ResetCreditSkip | null = null;
	if (expiryEnabled) {
		const nearExpiry = available.filter(
			(credit): credit is { id: string; expiresAt: number } =>
				credit.expiresAt !== null &&
				credit.expiresAt * 1_000 - now <= RESET_CREDIT_AUTO_APPLY_LEAD_MS,
		);
		if (nearExpiry.length === 0) {
			expirySkip = { action: "skip", reason: "no-credit-near-expiry" };
		} else {
			const survivor = nearExpiry.find(
				({ id }) => !terminallyResolvedCreditIds.has(id),
			);
			if (survivor) {
				return {
					action: "consume",
					creditId: survivor.id,
					expiresAt: survivor.expiresAt,
					cause: "expiry",
				};
			}
			expirySkip = { action: "skip", reason: "already-resolved" };
		}
	}

	// WEEKLY-LIMIT trigger — exhausted 7-day window, cooldown-gated.
	let weeklySkip: ResetCreditSkip | null = null;
	if (weeklyEnabled) {
		if (!weeklyResetCanLiftPause(account)) {
			weeklySkip = { action: "skip", reason: "paused" };
		} else if (weeklyUsedPercent === null || weeklyUsedPercent < 100) {
			// Includes the fail-closed null/unknown case.
			weeklySkip = { action: "skip", reason: "weekly-not-exhausted" };
		} else if (
			autoApplyCooldownAnchorAt !== null &&
			now - autoApplyCooldownAnchorAt < RESET_CREDIT_WEEKLY_LIMIT_COOLDOWN_MS
		) {
			weeklySkip = { action: "skip", reason: "cooldown" };
		} else if (available.length === 0) {
			weeklySkip = { action: "skip", reason: "no-credit-available" };
		} else {
			const survivor = available.find(
				({ id }) => !terminallyResolvedCreditIds.has(id),
			);
			if (survivor) {
				return {
					action: "consume",
					creditId: survivor.id,
					expiresAt: survivor.expiresAt,
					cause: "weekly-limit",
				};
			}
			weeklySkip = { action: "skip", reason: "already-resolved" };
		}
	}

	// Neither trigger fired — surface the most informative skip reason.
	if (expirySkip && weeklySkip) {
		return expirySkip.reason === "already-resolved" ? expirySkip : weeklySkip;
	}
	return (
		expirySkip ?? weeklySkip ?? { action: "skip", reason: "toggle-disabled" }
	);
}

/**
 * Injectable dependencies for {@link CodexResetCreditApplyScheduler}. Every
 * field is a plain function so tests pass closures/doubles; production wiring
 * comes from {@link createCodexResetCreditApplyScheduler}.
 */
export interface CodexResetCreditApplyDeps {
	/** Codex accounts with EITHER auto-apply toggle ON (no pause/rate-limit filter). */
	listCandidateAccounts(): Promise<Array<{ id: string; name: string }>>;
	/** Fresh account row for the decision gates (re-read per phase). */
	getAccount(accountId: string): Promise<Account | null>;
	/** Current cached reset-credit metadata (null when never fetched). */
	getCachedCredits(
		accountId: string,
	): CodexRateLimitResetCreditsCacheEntry | null;
	/** Refresh the metadata cache; non-forced is a cheap no-op while fresh. */
	refreshCredits(accountId: string, force: boolean): Promise<boolean>;
	/** Recovery must look at the ledger, even if the credit vanished from metadata. */
	getPendingAttempt(
		accountId: string,
	): Promise<CodexResetCreditEventRow | null>;
	/** Credit ids whose automation the ledger has terminally resolved. */
	getTerminallyResolvedCreditIds(accountId: string): Promise<Set<string>>;
	/**
	 * Cached 7-day used percent for the weekly-limit trigger. MUST be a pure
	 * read (no network call, no quota spend); return null when unknown/stale —
	 * the trigger fails closed on null.
	 */
	getWeeklyUsedPercent(
		accountId: string,
	): Promise<number | null> | number | null;
	/** Re-read the pool before weekly redemption; expiry never consults this gate. */
	hasOtherAvailableCodexAccount(accountId: string): Promise<boolean>;
	/**
	 * MAX resolved_at (ms) of cooldown-anchoring auto resolutions
	 * (reset/alreadyRedeemed/nothingToReset) — the weekly-limit trigger's 1h
	 * cooldown input. The EXPIRY trigger ignores it.
	 */
	getAutoApplyCooldownAnchorAt(accountId: string): Promise<number | null>;
	/** Durably claim (or reuse) the next auto attempt; null = terminal. */
	claimAutoAttempt(input: {
		accountId: string;
		accountName: string;
		creditId: string;
		creditExpiresAt: number | null;
		cause: "expiry" | "weekly-limit";
		now?: number;
	}): Promise<CodexResetCreditAutoClaim | null>;
	/** The registry dispatch (consumeCodexResetCreditForAccount). */
	dispatchConsume(
		accountId: string,
		request: CodexRateLimitResetCreditConsumeRequest,
	): Promise<CodexResetCreditConsumeDispatchOutcome>;
	/** Injectable clock (ms epoch) for deterministic tests. */
	now?(): number;
}

/**
 * Periodic auto-applier. Each tick, per candidate account:
 *  1) DISCOVERY: non-forced metadata refresh → fresh account + cache + ledger
 *     terminality → {@link decideResetCreditAction}. Skip = done.
 *  2) CONFIRMATION (discovery said consume): FORCED metadata refresh → re-read
 *     everything → re-decide. Still consume → durable ledger claim → dispatch.
 *
 * Registered through `intervalManager` with `maxConcurrent: 1` so a slow tick
 * can never overlap the next; `immediate: true` catches credits that came near
 * expiry while the server was down. Per-account try/catch so one failure never
 * aborts the tick.
 */
export class CodexResetCreditApplyScheduler {
	private readonly deps: CodexResetCreditApplyDeps;
	private stopInterval: (() => void) | null = null;
	private readonly intervalId = "codex-reset-credit-applier";

	constructor(deps: CodexResetCreditApplyDeps) {
		this.deps = { ...deps };
		this.deps.now ??= Date.now;
	}

	/** Start the applier: immediate catch-up tick, then every minute. */
	start(): void {
		log.info(
			`Codex reset-credit auto-applier starting: immediate tick, then every ${Math.round(RESET_CREDIT_AUTO_APPLY_TICK_MS / 1_000)}s (lead ${Math.round(RESET_CREDIT_AUTO_APPLY_LEAD_MS / 60_000)}min)`,
		);
		this.stopInterval = intervalManager.register({
			id: this.intervalId,
			callback: () => this.tick(),
			intervalMs: RESET_CREDIT_AUTO_APPLY_TICK_MS,
			immediate: true,
			maxConcurrent: 1,
			description:
				"Codex reset-credit auto-applier (expiring-credit + weekly-limit redemption)",
		});
	}

	/** Stop the applier: unregister the interval. */
	stop(): void {
		if (this.stopInterval) {
			this.stopInterval();
			this.stopInterval = null;
		}
	}

	/** One applier tick (exposed for tests / manual triggering). */
	async tick(): Promise<void> {
		let candidates: Array<{ id: string; name: string }>;
		try {
			candidates = await this.deps.listCandidateAccounts();
		} catch (err) {
			log.warn(
				`Reset-credit applier: failed to list candidate accounts: ${err}`,
			);
			return;
		}

		for (const candidate of candidates) {
			try {
				await this.processAccount(candidate);
			} catch (err) {
				// One bad account must not abort the batch — log and move on.
				log.error(
					`Reset-credit applier: failed for account ${candidate.name} (${candidate.id}):`,
					err,
				);
			}
		}
	}

	/** Re-read account + cache + ledger + usage inputs and run the pure decision. */
	private async evaluate(
		accountId: string,
	): Promise<ResetCreditApplyDecision | null> {
		const account = await this.deps.getAccount(accountId);
		if (!account) return null;
		const cached = this.deps.getCachedCredits(accountId);
		const [terminallyResolvedCreditIds, weeklyUsedPercent, cooldownAnchorAt] =
			await Promise.all([
				this.deps.getTerminallyResolvedCreditIds(accountId),
				this.deps.getWeeklyUsedPercent(accountId),
				this.deps.getAutoApplyCooldownAnchorAt(accountId),
			]);
		const decision = decideResetCreditAction({
			account,
			credits: cached?.summary.credits ?? null,
			terminallyResolvedCreditIds,
			weeklyUsedPercent,
			autoApplyCooldownAnchorAt: cooldownAnchorAt,
			now: (this.deps.now ?? Date.now)(),
		});
		// Check in BOTH discovery and confirmation, and separately for each
		// candidate. A preceding reset can restore another account during this
		// tick. Keep expiry independent, including when reading the pool fails.
		if (
			decision.action === "consume" &&
			decision.cause === "weekly-limit" &&
			(await this.deps.hasOtherAvailableCodexAccount(accountId))
		) {
			return { action: "skip", reason: "other-account-available" };
		}
		return decision;
	}

	private async processAccount(candidate: {
		id: string;
		name: string;
	}): Promise<void> {
		const { id, name } = candidate;
		const pending = await this.deps.getPendingAttempt(id);
		if (pending) {
			// A lost response may already have spent this credit. Reconcile it
			// before selecting a different credit for weekly exhaustion.
			if (!(await this.deps.refreshCredits(id, true))) return;
			const account = await this.deps.getAccount(id);
			if (
				!account ||
				account.provider !== "codex" ||
				!account.refresh_token ||
				account.pause_reason === PAUSE_REASON_NEEDS_REAUTH ||
				!pending.credit_id
			)
				return;
			const mayReplay =
				pending.cause === "weekly-limit"
					? account.codex_auto_apply_reset_on_weekly_limit_enabled &&
						weeklyResetCanLiftPause(account)
					: account.codex_auto_apply_reset_credits_enabled;
			// Replay the SAME key even when usage recovered or the metadata now
			// says redeemed/missing/expired. This retrieves the uncertain outcome
			// instead of treating a stale 100% reading as permission for credit B.
			if (mayReplay) {
				await this.dispatchAttempt(
					id,
					name,
					pending.credit_id,
					pending.cause ?? "expiry",
					{
						id: pending.id,
						idempotencyKey: pending.idempotency_key,
						attemptSeq: pending.attempt_seq ?? 1,
						reused: true,
					},
				);
				return;
			}
			// A pause the reset can't lift, or a toggle flip, stops a weekly retry
			// but must not disable the independent protection for credits about
			// to expire.
		}

		// Phase 1 — DISCOVERY on the cheap TTL-gated cache read.
		await this.deps.refreshCredits(id, false);
		const discovery = await this.evaluate(id);
		if (!discovery) {
			log.debug(`Reset-credit applier: account '${name}' vanished mid-tick`);
			return;
		}
		if (discovery.action === "skip") {
			if (
				discovery.reason === "needs-reauth" ||
				discovery.reason === "already-resolved"
			) {
				log.debug(
					`Reset-credit applier: skipping '${name}' (${discovery.reason})`,
				);
			}
			return;
		}

		// Phase 2 — CONFIRMATION on a forced fresh read. The toggle may have been
		// flipped off and the credit may have been redeemed/expired meanwhile.
		if (!(await this.deps.refreshCredits(id, true))) {
			log.debug(
				`Reset-credit applier: confirmation refresh failed for '${name}'`,
			);
			return;
		}
		const confirmed = await this.evaluate(id);
		if (!confirmed || confirmed.action !== "consume") {
			log.debug(
				`Reset-credit applier: confirmation aborted for '${name}' (${
					confirmed?.action === "skip" ? confirmed.reason : "account vanished"
				})`,
			);
			return;
		}
		if (pending && confirmed.cause === "weekly-limit") return;

		const claim = await this.deps.claimAutoAttempt({
			accountId: id,
			accountName: name,
			creditId: confirmed.creditId,
			creditExpiresAt: confirmed.expiresAt,
			// The decision carries WHY this consume fired ("expiry" when the credit
			// was about to be lost, "weekly-limit" when the 7-day window ran dry) —
			// the ledger persists it for the audit trail.
			cause: confirmed.cause,
			now: (this.deps.now ?? Date.now)(),
		});
		if (!claim) {
			// Terminal credit, or another unresolved account attempt won the race.
			log.debug(
				`Reset-credit applier: claim refused for '${name}' credit ${confirmed.creditId} (terminal or unresolved account attempt)`,
			);
			return;
		}

		await this.dispatchAttempt(
			id,
			name,
			confirmed.creditId,
			confirmed.cause,
			claim,
		);
	}

	private async dispatchAttempt(
		id: string,
		name: string,
		creditId: string,
		cause: ResetCreditApplyCause,
		claim: CodexResetCreditAutoClaim,
	): Promise<void> {
		let outcome: CodexResetCreditConsumeDispatchOutcome;
		try {
			outcome = await this.deps.dispatchConsume(id, {
				idempotencyKey: claim.idempotencyKey,
				creditId,
				autoApply: { ledgerRowId: claim.id },
			});
		} catch (err) {
			// Row stays pending → the next tick retries with the SAME key.
			log.warn(
				`Reset-credit applier: dispatch threw for '${name}' credit ${creditId} (attempt ${claim.attemptSeq}); will retry with the same key: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		if (outcome.status === "failed") {
			// Row stays pending → same-key retry on a later tick.
			log.warn(
				`Reset-credit applier: consume failed for '${name}' credit ${creditId} (attempt ${claim.attemptSeq}); will retry with the same key: ${outcome.message}`,
			);
			return;
		}

		log.info(
			`Reset-credit applier: auto-applied for '${name}' credit ${creditId} (cause: ${cause}, attempt ${claim.attemptSeq}, ${claim.reused ? "reused pending claim" : "fresh claim"}, outcome: ${outcome.result.outcome}, windowsReset: ${outcome.result.windowsReset})`,
		);
	}
}

/**
 * Production wiring: build a scheduler whose deps come from the live
 * DatabaseOperations, the spend coordinator's read-only metadata refresher,
 * the shared reset-credit cache singleton, and the token-manager consume
 * registry. `overrides` lets callers swap any dep (used by tests and available
 * to server.ts if it ever needs to).
 */
export function createCodexResetCreditApplyScheduler(wiring: {
	dbOps: Pick<
		DatabaseOperations,
		| "getAllAccounts"
		| "getAccount"
		| "getActiveApiKeys"
		| "getPendingCodexResetCreditAttempt"
		| "getTerminallyResolvedCodexResetCreditIds"
		| "claimCodexResetCreditAutoAttempt"
		| "getCodexResetCreditAutoApplyCooldownAnchorAt"
	>;
	coordinator: {
		refreshResetCredits(
			accountId: string,
			force?: boolean,
		): Promise<{ success: boolean }>;
		readUsageStatus(accountId: string): Promise<{ success: boolean }>;
	};
	overrides?: Partial<CodexResetCreditApplyDeps>;
}): CodexResetCreditApplyScheduler {
	const { dbOps, coordinator, overrides } = wiring;
	// Bound retries of unknown alternatives across discovery/confirmation and
	// candidates. Failed free reads must not hold up reset redemption forever.
	const usageRefreshAttempts = new Map<string, number>();
	const nowMs = overrides?.now ?? Date.now;
	const usable = (account: Account, now: number) =>
		account.provider === "codex" &&
		isAccountAvailable(account, now) &&
		account.pause_reason !== PAUSE_REASON_NEEDS_REAUTH &&
		Boolean(
			account.refresh_token ||
				(account.access_token &&
					(!account.expires_at || account.expires_at > now)),
		);
	return new CodexResetCreditApplyScheduler({
		listCandidateAccounts: async () =>
			(await dbOps.getAllAccounts())
				.filter(
					(account) =>
						account.provider === "codex" &&
						(account.codex_auto_apply_reset_credits_enabled ||
							account.codex_auto_apply_reset_on_weekly_limit_enabled),
				)
				.map((account) => ({ id: account.id, name: account.name })),
		getAccount: (accountId) => dbOps.getAccount(accountId),
		getPendingAttempt: (accountId) =>
			dbOps.getPendingCodexResetCreditAttempt(accountId),
		getCachedCredits: (accountId) =>
			codexRateLimitResetCreditsCache.get(accountId),
		refreshCredits: async (accountId, force) => {
			return (await coordinator.refreshResetCredits(accountId, force)).success;
		},
		getTerminallyResolvedCreditIds: (accountId) =>
			dbOps.getTerminallyResolvedCodexResetCreditIds(accountId),
		// Weekly used percent comes from the in-memory usage poller cache
		// (usageCache) — a pure read that never spends quota. Its get() already
		// evicts entries older than 10 minutes, so a stalled poller degrades to
		// null and the weekly trigger FAILS CLOSED.
		getWeeklyUsedPercent: (accountId) => {
			const usage = usageCache.get(accountId) as UsageData | null;
			const pct = usage?.seven_day?.utilization;
			return typeof pct === "number" && Number.isFinite(pct) ? pct : null;
		},
		hasOtherAvailableCodexAccount: async (accountId) => {
			const [accounts, keys] = await Promise.all([
				dbOps.getAllAccounts(),
				dbOps.getActiveApiKeys(),
			]);
			// A configured account pin has no substitute. Provider-class pins
			// allowing Codex admit the same Codex alternatives as the global pool.
			if (keys.some((key) => key.pinnedAccountId === accountId)) return false;
			const now = nowMs();
			for (const [id, attemptedAt] of usageRefreshAttempts) {
				if (now - attemptedAt >= RESET_CREDIT_AUTO_APPLY_TICK_MS)
					usageRefreshAttempts.delete(id);
			}
			const unknown: Account[] = [];
			for (const account of accounts) {
				if (account.id === accountId || !usable(account, now)) continue;
				// Check both included-quota windows, irrespective of reset toggles.
				const capacity = getAccountCapacitySignal(
					usageCache.get(account.id),
					account.provider,
					now,
				);
				if (capacity && capacity.minHeadroom > 0) return true;
				if (!capacity) unknown.push(account);
			}
			for (const account of unknown) {
				if (!usageRefreshAttempts.has(account.id)) {
					usageRefreshAttempts.set(account.id, nowMs());
					try {
						// Free GET, bounded by the coordinator's timeout; never a ping.
						await coordinator.readUsageStatus(account.id);
					} catch (error) {
						log.debug(
							`Reset-credit pool usage refresh failed for '${account.name}': ${error}`,
						);
					}
				}
				const current = await dbOps.getAccount(account.id);
				if (!current || !usable(current, nowMs())) continue;
				const capacity = getAccountCapacitySignal(
					usageCache.get(account.id),
					"codex",
					nowMs(),
				);
				if (capacity) {
					if (capacity.minHeadroom > 0) return true;
					continue;
				}
				// A just-resolved reset (or nothingToReset) is evidence against
				// another immediate redemption while usage catches up. After one
				// tick, an alternative we still cannot verify no longer blocks.
				const restoredAt =
					await dbOps.getCodexResetCreditAutoApplyCooldownAnchorAt(account.id);
				if (
					restoredAt !== null &&
					nowMs() - restoredAt < RESET_CREDIT_AUTO_APPLY_TICK_MS
				)
					return true;
			}
			return false;
		},
		getAutoApplyCooldownAnchorAt: (accountId) =>
			dbOps.getCodexResetCreditAutoApplyCooldownAnchorAt(accountId),
		claimAutoAttempt: (input) => dbOps.claimCodexResetCreditAutoAttempt(input),
		dispatchConsume: (accountId, request) =>
			consumeCodexResetCreditForAccount(accountId, request),
		...overrides,
	});
}
