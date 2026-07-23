import { getRateLimitResetStabilityMs } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	type CodexCreditsInfo,
	type CodexUsageStatus,
	isGenuineWindowRoll,
	parseCodexCreditsHeaders,
	parseCodexUsageHeaders,
	type RateLimitInfo,
	toEpochMs,
	type UsageData,
	usageCache,
} from "@clankermux/providers";
import type { Account, RateLimitReason } from "@clankermux/types";
import type { ProxyContext } from "./proxy-types";
import { applyRateLimitCooldown } from "./rate-limit-cooldown";

const log = new Logger("CodexObservation");

/**
 * Where the Codex response being observed came from. Discriminates the two
 * ownership regimes:
 *
 *   - `"real-traffic"`: applyCodexObservation is a *component within* the
 *     proxy request pipeline (processProxyResponse / the proxy-operations
 *     early-429 short-circuits). In that pipeline the 429 cooldown and the
 *     success-cooldown recovery are still owned by processProxyResponse /
 *     applyRateLimitCooldown at the call site, so this function must NOT also
 *     perform success recovery (it would double-handle the shared cross-provider
 *     success path). Cooldown for these callers is driven explicitly via
 *     `rateLimitAction`.
 *   - `"scheduled-prime"` / `"manual-refresh"`: applyCodexObservation is the
 *     *standalone owner* of the observation — those callers never pass through
 *     processProxyResponse, so this function performs success recovery for them.
 *     (No such caller exists yet; they are wired in later refactor steps.)
 */
export type CodexObservationSource =
	| "real-traffic"
	| "scheduled-prime"
	| "manual-refresh";

/**
 * Request-count accounting mode.
 *   - `"session"`: the normal per-request session accounting
 *     (`dbOps.updateAccountUsage`).
 *   - `"count-only"`: increment last_used / request_count / total_requests
 *     WITHOUT touching session tracking (the `bypassSession` auto-refresh path).
 *   - `"none"`: no accounting (short-circuit 429 sites, priming probes).
 */
export type CodexRequestAccounting = "session" | "count-only" | "none";

/**
 * What to do about a rate-limit cooldown.
 *   - `{ kind: "apply", ... }`: apply a 429 cooldown exactly once via
 *     {@link applyRateLimitCooldown}. `reason`/`floorUntil`/`reprobe` are
 *     forwarded verbatim so specialized audit reasons (e.g. `model_fallback_429`)
 *     and the out-of-credits/hold semantics are preserved. `cooldownUntil`
 *     overrides the cooldown *deadline* (epoch ms) independently of the
 *     status-meta reset persisted from `rateLimitInfo` — the proxy-operations
 *     429 sites derive that deadline from `extractCooldownUntil(...)`, which is
 *     distinct from the provider-parsed window reset. When omitted the cooldown
 *     uses `rateLimitInfo.resetTime`.
 *   - `{ kind: "skip" }`: never touch the cooldown (the caller — e.g.
 *     processProxyResponse on the real-traffic main path — already applied it,
 *     or the response is a success).
 */
export type CodexRateLimitAction =
	| {
			kind: "apply";
			reason?: RateLimitReason;
			floorUntil?: number;
			reprobe?: boolean;
			cooldownUntil?: number;
	  }
	| { kind: "skip" };

export interface ApplyCodexObservationOptions {
	source: CodexObservationSource;
	/**
	 * Pre-parsed rate-limit view of the response (`provider.parseRateLimit`).
	 * Passed in so this function never reparses — the caller owns which provider
	 * did the parse. Drives status-meta persistence, `isRateLimited`, and the
	 * default cooldown reset.
	 */
	rateLimitInfo: RateLimitInfo;
	requestAccounting: CodexRequestAccounting;
	rateLimitAction: CodexRateLimitAction;
	/**
	 * Flavor of success-cooldown recovery for standalone (non-real-traffic)
	 * callers. `"standard"` matches today's processProxyResponse recovery;
	 * `"scheduled-prime"` is a placeholder that currently behaves identically —
	 * it exists so a later step can diverge priming recovery without a signature
	 * change. Ignored for `source: "real-traffic"` (recovery stays in
	 * processProxyResponse there).
	 */
	successRecovery: "standard" | "scheduled-prime";
}

export interface CodexObservationResult {
	/** The usage snapshot written to the cache, or null when the response
	 * carried no meaningful Codex usage windows (cache left untouched). */
	usage: UsageData | null;
	/** The credits state attached to the cached usage (fresh, carried-forward,
	 * or null). */
	effectiveCredits: CodexCreditsInfo | null;
	/** Earliest of the 5h/7d resets (epoch ms) parsed from this response, or
	 * null. */
	earliestResetMs: number | null;
	/** True when a genuine 5h window roll was detected (session was reset). */
	windowRolledOver: boolean;
	/** Mirror of `rateLimitInfo.isRateLimited`. */
	isRateLimited: boolean;
	/** `response.status`. */
	responseStatus: number;
}

/**
 * Apply request-count accounting for a Codex observation. Shared by the header
 * path ({@link applyCodexObservation}) and the free-GET JSON path
 * ({@link applyCodexUsageStatus}) so both interpret `session`/`count-only`/`none`
 * identically.
 */
function applyCodexRequestAccounting(
	account: Account,
	ctx: Pick<ProxyContext, "asyncWriter" | "dbOps">,
	mode: CodexRequestAccounting,
): void {
	switch (mode) {
		case "session":
			ctx.asyncWriter.enqueue(() => ctx.dbOps.updateAccountUsage(account.id));
			break;
		case "count-only":
			// Increment request count + total without touching session tracking.
			ctx.asyncWriter.enqueue(async () => {
				const db = ctx.dbOps.getAdapter();
				const now = Date.now();
				await db.run(
					`UPDATE accounts
					 SET last_used = ?, request_count = request_count + 1, total_requests = total_requests + 1
					 WHERE id = ?`,
					[now, account.id],
				);
			});
			break;
		case "none":
			break;
	}
}

/**
 * The Codex usage-cache / credits-carry-forward / window-roll / earliest-reset
 * bookkeeping, factored out of {@link applyCodexObservation} so the header path
 * (real traffic) and the free-GET JSON path ({@link applyCodexUsageStatus}) share
 * ONE implementation without either faking a `Response`.
 *
 * `codexUsage` is the already-parsed window snapshot (its `codexCredits` is
 * (re)assigned here). `freshCredits` is the credits state parsed from THIS
 * observation, or `null` when the source carried no credits info — in which case
 * the last known credits are carried FORWARD (a single credits-less observation
 * must not silently drop learned credits/overage state, since `usageCache.set`
 * fully replaces the prior entry).
 */
function applyCodexUsageBookkeeping(
	account: Account,
	ctx: Pick<ProxyContext, "asyncWriter" | "dbOps">,
	codexUsage: UsageData,
	freshCredits: CodexCreditsInfo | null,
): {
	usage: UsageData;
	effectiveCredits: CodexCreditsInfo | null;
	earliestResetMs: number | null;
	windowRolledOver: boolean;
} {
	const prevUsage = usageCache.get(account.id);
	const prevResetAt = (
		prevUsage as { five_hour?: { resets_at: string | null } } | null
	)?.five_hour?.resets_at;
	const newResetAt = codexUsage.five_hour?.resets_at;
	// Detect a genuine 5h window roll: only when the previous reset has actually
	// arrived (prevResetMs <= now) and the new reset is strictly later. Rejects
	// sub-second forward drift of a still-future reset (which would otherwise churn
	// session_start and flap the Primary badge).
	const prevResetMs = toEpochMs(prevResetAt);
	const newResetMs = toEpochMs(newResetAt);
	const windowRolledOver = isGenuineWindowRoll(
		prevResetMs,
		newResetMs,
		Date.now(),
	);

	// Attach Codex credits state. Only overwrite when THIS observation carried
	// credits; absence signals a non-credits-aware response, not "off credits", so
	// carry the last known credits forward.
	if (freshCredits !== null) {
		codexUsage.codexCredits = freshCredits;
	} else {
		const prevCredits = (
			prevUsage as { codexCredits?: CodexCreditsInfo | null } | null
		)?.codexCredits;
		if (prevCredits != null) {
			codexUsage.codexCredits = prevCredits;
		}
	}
	const effectiveCredits = codexUsage.codexCredits ?? null;

	usageCache.set(account.id, codexUsage);
	log.debug(
		`Updated Codex usage cache for ${account.name}: 5h=${codexUsage.five_hour?.utilization ?? "n/a"}%, 7d=${codexUsage.seven_day.utilization}%`,
	);

	// Persist rate_limit_reset from usage windows (earliest of 5h/7d) so
	// auto-refresh can track windows.
	const earliestResetOf = (
		u: {
			five_hour?: { resets_at: string | null } | null;
			seven_day?: { resets_at: string | null };
		} | null,
	): number | null => {
		const resetTimes = [u?.five_hour?.resets_at, u?.seven_day?.resets_at]
			.map((t) => toEpochMs(t))
			.filter((ms): ms is number => ms != null);
		return resetTimes.length > 0 ? Math.min(...resetTimes) : null;
	};
	const earliestResetMs = earliestResetOf(codexUsage);
	// Compare against the PERSISTED account value (not the cache, which the set()
	// above already overwrote): a failed async write leaves the DB stale, so
	// comparing against account.rate_limit_reset lets the next observation retry it
	// while still suppressing sub-second forward drift once a value has committed.
	if (
		earliestResetMs != null &&
		(account.rate_limit_reset == null ||
			Math.abs(earliestResetMs - account.rate_limit_reset) >= 1000)
	) {
		ctx.asyncWriter.enqueue(() =>
			ctx.dbOps
				.getAdapter()
				.run("UPDATE accounts SET rate_limit_reset = ? WHERE id = ?", [
					earliestResetMs,
					account.id,
				]),
		);
	}

	if (windowRolledOver) {
		log.info(
			`Codex window rolled over for ${account.name}: ${prevResetAt} → ${newResetAt}, resetting session`,
		);
		// Direct call (not enqueued) — mirrors the original updateAccountMetadata
		// codex block.
		ctx.dbOps
			.resetAccountSession(account.id, Date.now())
			.catch((err) =>
				log.warn(
					`Failed to reset Codex session for ${account.name} on window reset: ${err}`,
				),
			);
	}

	return {
		usage: codexUsage,
		effectiveCredits,
		earliestResetMs,
		windowRolledOver,
	};
}

/**
 * Success-cooldown recovery for a standalone (non-real-traffic) observation of a
 * healthy account: clear the consecutive-limit stability counter and the
 * `rate_limited_until` lock. Factored out so both the header path and the free-
 * GET JSON path share it. Callers gate WHEN to run this — the JSON path in
 * particular must only call it on a POSITIVE recovery signal (never for a 200
 * that still reports the account as exhausted).
 */
function applyCodexSuccessRecovery(
	account: Account,
	ctx: Pick<ProxyContext, "asyncWriter" | "dbOps">,
): void {
	// (a) Stability reset — gated only on rate_limited_at.
	if (
		account.rate_limited_at &&
		Date.now() - account.rate_limited_at > getRateLimitResetStabilityMs()
	) {
		account.consecutive_rate_limits = 0;
		account.rate_limited_at = null;
		ctx.asyncWriter.enqueue(() =>
			ctx.dbOps.resetConsecutiveRateLimits(account.id),
		);
	}
	// (b) Clear rate_limited_until (only if still set in-memory).
	if (account.rate_limited_until) {
		account.rate_limited_until = null;
		ctx.asyncWriter.enqueue(async () => {
			const db = ctx.dbOps.getAdapter();
			await db.run(
				"UPDATE accounts SET rate_limited_until = NULL WHERE id = ? AND rate_limited_until IS NOT NULL",
				[account.id],
			);
			log.debug(
				`Cleared rate_limited_until for account ${account.name} on successful response`,
			);
		});
	}
}

/**
 * The single owner of Codex response side-effects driven off the response
 * headers: request accounting, rate-limit status-meta persistence, 429 cooldown
 * application, success-cooldown recovery, and the Codex usage-cache /
 * credits-carry-forward / window-roll / earliest-reset bookkeeping.
 *
 * Reads ONLY `response.status` and `response.headers`. It NEVER reads, clones,
 * cancels, or replaces the body — callers on short-circuit/failover paths still
 * own body disposal, and the main path still forwards it.
 *
 * NOT in scope (left with the callers): the generic requestId-keyed
 * request-body / token-usage extraction, request-row/audit persistence,
 * routing/failover decisions, scheduler failure counters, and token/network
 * transport.
 */
export function applyCodexObservation(
	account: Account,
	response: Response,
	ctx: Pick<ProxyContext, "asyncWriter" | "dbOps">,
	opts: ApplyCodexObservationOptions,
): CodexObservationResult {
	const { rateLimitInfo } = opts;
	const responseStatus = response.status;
	const isRateLimited = rateLimitInfo.isRateLimited;

	// ── 1. Request accounting ──────────────────────────────────────────────
	applyCodexRequestAccounting(account, ctx, opts.requestAccounting);

	// ── 2. Rate-limit status-meta persistence ──────────────────────────────
	// Persist status/reset/remaining only when the unified-status header was
	// present (mirrors persistRateLimitStatusMeta). Uses the PASSED rateLimitInfo
	// — the caller already parsed with the account-specific provider.
	if (rateLimitInfo.statusHeader) {
		const status = rateLimitInfo.statusHeader;
		ctx.asyncWriter.enqueue(() =>
			ctx.dbOps.updateAccountRateLimitMeta(
				account.id,
				status,
				rateLimitInfo.resetTime ?? null,
				rateLimitInfo.remaining,
			),
		);
	}

	// ── 3. 429 cooldown application (exactly once) ─────────────────────────
	if (opts.rateLimitAction.kind === "apply") {
		const action = opts.rateLimitAction;
		// applyRateLimitCooldown only touches ctx.asyncWriter + ctx.dbOps; the
		// narrow ctx satisfies that at runtime, so the cast is safe.
		applyRateLimitCooldown(
			account,
			{
				resetTime: action.cooldownUntil ?? rateLimitInfo.resetTime,
				remaining: rateLimitInfo.remaining,
				reason: action.reason,
				floorUntil: action.floorUntil,
			},
			ctx as ProxyContext,
			action.reprobe ? { reprobe: true } : undefined,
		);
	}

	// ── 4. Codex usage-cache / credits / window-roll / earliest-reset ──────
	let usage: UsageData | null = null;
	let effectiveCredits: CodexCreditsInfo | null = null;
	let earliestResetMs: number | null = null;
	let windowRolledOver = false;

	const codexUsage = parseCodexUsageHeaders(response.headers, {
		defaultUtilization: responseStatus === 429 ? 100 : 0,
	});
	if (codexUsage) {
		const freshCredits = parseCodexCreditsHeaders(response.headers);
		const bookkeeping = applyCodexUsageBookkeeping(
			account,
			ctx,
			codexUsage,
			freshCredits,
		);
		usage = bookkeeping.usage;
		effectiveCredits = bookkeeping.effectiveCredits;
		earliestResetMs = bookkeeping.earliestResetMs;
		windowRolledOver = bookkeeping.windowRolledOver;
	}

	// ── 5. Success-cooldown recovery (standalone callers only) ─────────────
	// For real-traffic, processProxyResponse still owns this (see
	// CodexObservationSource docs) — performing it here too would double-handle
	// the shared cross-provider success path. `standard` and `scheduled-prime`
	// are identical for now.
	if (!isRateLimited && opts.source !== "real-traffic") {
		applyCodexSuccessRecovery(account, ctx);
	}

	return {
		usage,
		effectiveCredits,
		earliestResetMs,
		windowRolledOver,
		isRateLimited,
		responseStatus,
	};
}

export interface ApplyCodexUsageStatusOptions {
	/**
	 * Request-count accounting for this read. A manual "Refresh usage" is an
	 * operator action, not app traffic, so it passes `"none"`. Parameterized so a
	 * later periodic/on-demand free-status caller can choose its own accounting.
	 */
	requestAccounting: CodexRequestAccounting;
}

/**
 * Apply a FREE `GET /wham/usage` observation (see `fetchCodexUsageStatus`). This
 * is the JSON sibling of {@link applyCodexObservation}: it shares the exact same
 * usage-cache / credits-carry-forward / window-roll / earliest-reset bookkeeping
 * ({@link applyCodexUsageBookkeeping}) and success-recovery
 * ({@link applyCodexSuccessRecovery}) WITHOUT faking a `Response`.
 *
 * A free read is NOT a spend and NOT a 429: it NEVER applies a rate-limit
 * cooldown and NEVER persists rate-limit status-meta (the GET carries no unified
 * status header). It only observes usage windows + credits.
 *
 * CRITICAL GUARD: a 200 for an EXHAUSTED account (the backend reports
 * `limit_reached: true` / `allowed: false`) must NOT run success recovery — that
 * would clear `rate_limited_until` for an account that is still locked. Recovery
 * fires ONLY on a positive "allowed"/"not limit-reached" signal. When the
 * backend omits both fields (`null`) we cannot confirm recovery, so the lock is
 * left intact (fail-safe).
 *
 * Callers must only invoke this for `status.ok === true`.
 */
export function applyCodexUsageStatus(
	account: Account,
	status: CodexUsageStatus,
	ctx: Pick<ProxyContext, "asyncWriter" | "dbOps">,
	opts: ApplyCodexUsageStatusOptions,
): CodexObservationResult {
	const responseStatus = status.status ?? 200;

	// The backend reports the account as still limited when limit_reached is true
	// or allowed is false. Recovery requires a POSITIVE not-limited signal; a
	// missing signal (both null) is treated as "cannot confirm" → not recovered.
	const observedLimited =
		status.limitReached === true || status.allowed === false;
	const confirmedRecovered =
		!observedLimited &&
		(status.allowed === true || status.limitReached === false);

	// ── 1. Request accounting ──────────────────────────────────────────────
	applyCodexRequestAccounting(account, ctx, opts.requestAccounting);

	// (No rate-limit status-meta persistence and no 429 cooldown: a free read is
	// neither a unified-status response nor a spend. See the CRITICAL GUARD.)

	// ── 2. Codex usage-cache / credits / window-roll / earliest-reset ──────
	let usage: UsageData | null = null;
	let effectiveCredits: CodexCreditsInfo | null = null;
	let earliestResetMs: number | null = null;
	let windowRolledOver = false;

	if (status.usage) {
		// The JSON parser already folds credits into `usage.codexCredits` when the
		// body carried a `credits` object; treat its absence as "no credits info"
		// so the shared bookkeeping carries prior credits forward.
		const freshCredits = status.usage.codexCredits ?? null;
		const bookkeeping = applyCodexUsageBookkeeping(
			account,
			ctx,
			status.usage,
			freshCredits,
		);
		usage = bookkeeping.usage;
		effectiveCredits = bookkeeping.effectiveCredits;
		earliestResetMs = bookkeeping.earliestResetMs;
		windowRolledOver = bookkeeping.windowRolledOver;
	}

	// ── 3. Success-cooldown recovery (positive recovery signal ONLY) ───────
	if (confirmedRecovered) {
		applyCodexSuccessRecovery(account, ctx);
	}

	return {
		usage,
		effectiveCredits,
		earliestResetMs,
		windowRolledOver,
		isRateLimited: observedLimited,
		responseStatus,
	};
}
