/**
 * Codex reset-credit auto-applier — opt-in per-account automation that redeems
 * an earned usage-limit reset credit shortly before it expires, backed by the
 * durable `codex_reset_credit_events` claim/resolve ledger.
 *
 * Design notes:
 *  - Per-account OPT-IN via `codex_auto_apply_reset_credits_enabled`. PAUSED
 *    accounts are deliberately NOT skipped — a paused account's credit still
 *    expires; only a needs-reauth pause (dead refresh token) disqualifies,
 *    because no consume could succeed anyway.
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

import { intervalManager, PAUSE_REASON_NEEDS_REAUTH } from "@clankermux/core";
import type {
	CodexResetCreditAutoClaim,
	DatabaseOperations,
} from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import {
	type CodexRateLimitResetCredit,
	type CodexRateLimitResetCreditsCacheEntry,
	codexRateLimitResetCreditsCache,
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
 * What the applier should do for one account right now. `expiresAt` is the
 * credit's expiry in unix SECONDS (the ledger's `credit_expires_at` unit).
 */
export type ResetCreditApplyDecision =
	| { action: "consume"; creditId: string; expiresAt: number }
	| {
			action: "skip";
			reason:
				| "toggle-disabled"
				| "not-codex"
				| "needs-reauth"
				| "no-tokens"
				| "no-credit-near-expiry"
				| "already-resolved";
	  };

/**
 * Pure decision function — no I/O, injectable clock. Gates run in order:
 * opt-in toggle → codex provider → not needs-reauth (a dead refresh token
 * means no consume can succeed; any OTHER pause state is deliberately not an
 * input) → holds a refresh token → a near-expiry actionable credit exists.
 *
 * Candidates are `available` credits whose expiry is in the future but within
 * {@link RESET_CREDIT_AUTO_APPLY_LEAD_MS}, soonest-first; ids the ledger has
 * terminally resolved are skipped (their automation is done).
 */
export function decideResetCreditAction(inputs: {
	account: Pick<
		Account,
		| "provider"
		| "codex_auto_apply_reset_credits_enabled"
		| "pause_reason"
		| "refresh_token"
		| "access_token"
	>;
	credits: CodexRateLimitResetCredit[] | null;
	terminallyResolvedCreditIds: ReadonlySet<string>;
	/** Current time in ms. */
	now: number;
}): ResetCreditApplyDecision {
	const { account, credits, terminallyResolvedCreditIds, now } = inputs;

	if (!account.codex_auto_apply_reset_credits_enabled) {
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

	// Near-expiry candidates: available, expiring, inside the lead window but
	// NOT already past (an expired credit is no longer actionable), soonest
	// first.
	const candidates = (credits ?? [])
		.flatMap((credit) =>
			credit.status === "available" && credit.expiresAt !== null
				? [{ id: credit.id, expiresAt: credit.expiresAt }]
				: [],
		)
		.filter(({ expiresAt }) => {
			const expiresAtMs = expiresAt * 1_000;
			return (
				expiresAtMs > now &&
				expiresAtMs - now <= RESET_CREDIT_AUTO_APPLY_LEAD_MS
			);
		})
		.sort((a, b) => a.expiresAt - b.expiresAt);

	if (candidates.length === 0) {
		return { action: "skip", reason: "no-credit-near-expiry" };
	}

	const survivor = candidates.find(
		({ id }) => !terminallyResolvedCreditIds.has(id),
	);
	if (!survivor) {
		return { action: "skip", reason: "already-resolved" };
	}
	return {
		action: "consume",
		creditId: survivor.id,
		expiresAt: survivor.expiresAt,
	};
}

/**
 * Injectable dependencies for {@link CodexResetCreditApplyScheduler}. Every
 * field is a plain function so tests pass closures/doubles; production wiring
 * comes from {@link createCodexResetCreditApplyScheduler}.
 */
export interface CodexResetCreditApplyDeps {
	/** Codex accounts with the auto-apply toggle ON (no pause/rate-limit filter). */
	listCandidateAccounts(): Promise<Array<{ id: string; name: string }>>;
	/** Fresh account row for the decision gates (re-read per phase). */
	getAccount(accountId: string): Promise<Account | null>;
	/** Current cached reset-credit metadata (null when never fetched). */
	getCachedCredits(
		accountId: string,
	): CodexRateLimitResetCreditsCacheEntry | null;
	/** Refresh the metadata cache; non-forced is a cheap no-op while fresh. */
	refreshCredits(accountId: string, force: boolean): Promise<void>;
	/** Credit ids whose automation the ledger has terminally resolved. */
	getTerminallyResolvedCreditIds(accountId: string): Promise<Set<string>>;
	/** Durably claim (or reuse) the next auto attempt; null = terminal. */
	claimAutoAttempt(input: {
		accountId: string;
		accountName: string;
		creditId: string;
		creditExpiresAt: number | null;
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
				"Codex reset-credit auto-applier (expiring-credit redemption)",
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

	/** Re-read account + cache + ledger terminality and run the pure decision. */
	private async evaluate(
		accountId: string,
	): Promise<ResetCreditApplyDecision | null> {
		const account = await this.deps.getAccount(accountId);
		if (!account) return null;
		const cached = this.deps.getCachedCredits(accountId);
		const terminallyResolvedCreditIds =
			await this.deps.getTerminallyResolvedCreditIds(accountId);
		return decideResetCreditAction({
			account,
			credits: cached?.summary.credits ?? null,
			terminallyResolvedCreditIds,
			now: (this.deps.now ?? Date.now)(),
		});
	}

	private async processAccount(candidate: {
		id: string;
		name: string;
	}): Promise<void> {
		const { id, name } = candidate;

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
		await this.deps.refreshCredits(id, true);
		const confirmed = await this.evaluate(id);
		if (!confirmed || confirmed.action !== "consume") {
			log.debug(
				`Reset-credit applier: confirmation aborted for '${name}' (${
					confirmed?.action === "skip" ? confirmed.reason : "account vanished"
				})`,
			);
			return;
		}

		const claim = await this.deps.claimAutoAttempt({
			accountId: id,
			accountName: name,
			creditId: confirmed.creditId,
			creditExpiresAt: confirmed.expiresAt,
			now: (this.deps.now ?? Date.now)(),
		});
		if (!claim) {
			// The ledger says automation is terminal for this credit.
			log.debug(
				`Reset-credit applier: claim refused for '${name}' credit ${confirmed.creditId} (terminal)`,
			);
			return;
		}

		let outcome: CodexResetCreditConsumeDispatchOutcome;
		try {
			outcome = await this.deps.dispatchConsume(id, {
				idempotencyKey: claim.idempotencyKey,
				creditId: confirmed.creditId,
				autoApply: { ledgerRowId: claim.id },
			});
		} catch (err) {
			// Row stays pending → the next tick retries with the SAME key.
			log.warn(
				`Reset-credit applier: dispatch threw for '${name}' credit ${confirmed.creditId} (attempt ${claim.attemptSeq}); will retry with the same key: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		if (outcome.status === "failed") {
			// Row stays pending → same-key retry on a later tick.
			log.warn(
				`Reset-credit applier: consume failed for '${name}' credit ${confirmed.creditId} (attempt ${claim.attemptSeq}); will retry with the same key: ${outcome.message}`,
			);
			return;
		}

		log.info(
			`Reset-credit applier: auto-applied for '${name}' credit ${confirmed.creditId} (attempt ${claim.attemptSeq}, ${claim.reused ? "reused pending claim" : "fresh claim"}, outcome: ${outcome.result.outcome}, windowsReset: ${outcome.result.windowsReset})`,
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
		| "getTerminallyResolvedCodexResetCreditIds"
		| "claimCodexResetCreditAutoAttempt"
	>;
	coordinator: {
		refreshResetCredits(accountId: string, force?: boolean): Promise<unknown>;
	};
	overrides?: Partial<CodexResetCreditApplyDeps>;
}): CodexResetCreditApplyScheduler {
	const { dbOps, coordinator, overrides } = wiring;
	return new CodexResetCreditApplyScheduler({
		listCandidateAccounts: async () =>
			(await dbOps.getAllAccounts())
				.filter(
					(account) =>
						account.provider === "codex" &&
						account.codex_auto_apply_reset_credits_enabled,
				)
				.map((account) => ({ id: account.id, name: account.name })),
		getAccount: (accountId) => dbOps.getAccount(accountId),
		getCachedCredits: (accountId) =>
			codexRateLimitResetCreditsCache.get(accountId),
		refreshCredits: async (accountId, force) => {
			await coordinator.refreshResetCredits(accountId, force);
		},
		getTerminallyResolvedCreditIds: (accountId) =>
			dbOps.getTerminallyResolvedCodexResetCreditIds(accountId),
		claimAutoAttempt: (input) => dbOps.claimCodexResetCreditAutoAttempt(input),
		dispatchConsume: (accountId, request) =>
			consumeCodexResetCreditForAccount(accountId, request),
		...overrides,
	});
}
