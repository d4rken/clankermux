import { getRateLimitResetStabilityMs } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	type CodexCreditsInfo,
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
	switch (opts.requestAccounting) {
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
		const prevUsage = usageCache.get(account.id);
		const prevResetAt = (
			prevUsage as { five_hour?: { resets_at: string | null } } | null
		)?.five_hour?.resets_at;
		const newResetAt = codexUsage.five_hour?.resets_at;
		// Detect a genuine 5h window roll: only when the previous reset has
		// actually arrived (prevResetMs <= now) and the new reset is strictly
		// later. Rejects sub-second forward drift of a still-future reset (which
		// would otherwise churn session_start and flap the Primary badge).
		const prevResetMs = toEpochMs(prevResetAt);
		const newResetMs = toEpochMs(newResetAt);
		windowRolledOver = isGenuineWindowRoll(prevResetMs, newResetMs, Date.now());

		// Attach Codex credits state. Only overwrite when the header is present;
		// absence signals a non-credits-aware response, not "off credits". Since
		// usageCache.set below fully replaces the prior entry, carry the last
		// known credits FORWARD onto the freshly-built usage so a single
		// credits-less response can't silently drop learned credits/overage state.
		const creditsInfo = parseCodexCreditsHeaders(response.headers);
		if (creditsInfo !== null) {
			codexUsage.codexCredits = creditsInfo;
		} else {
			const prevCredits = (
				prevUsage as { codexCredits?: CodexCreditsInfo | null } | null
			)?.codexCredits;
			if (prevCredits != null) {
				codexUsage.codexCredits = prevCredits;
			}
		}
		effectiveCredits = codexUsage.codexCredits ?? null;

		usageCache.set(account.id, codexUsage);
		usage = codexUsage;
		log.debug(
			`Updated Codex usage cache for ${account.name}: 5h=${codexUsage.five_hour.utilization}%, 7d=${codexUsage.seven_day.utilization}%`,
		);

		// Persist rate_limit_reset from usage headers (earliest of 5h/7d) so
		// auto-refresh can track windows.
		const earliestResetOf = (
			u: {
				five_hour?: { resets_at: string | null };
				seven_day?: { resets_at: string | null };
			} | null,
		): number | null => {
			const resetTimes = [u?.five_hour?.resets_at, u?.seven_day?.resets_at]
				.map((t) => toEpochMs(t))
				.filter((ms): ms is number => ms != null);
			return resetTimes.length > 0 ? Math.min(...resetTimes) : null;
		};
		const newEarliestReset = earliestResetOf(codexUsage);
		earliestResetMs = newEarliestReset;
		// Compare against the PERSISTED account value (not the cache, which the
		// set() above already overwrote): a failed async write leaves the DB
		// stale, so comparing against account.rate_limit_reset lets the next
		// response retry it while still suppressing sub-second forward drift once
		// a value has been committed.
		if (
			newEarliestReset != null &&
			(account.rate_limit_reset == null ||
				Math.abs(newEarliestReset - account.rate_limit_reset) >= 1000)
		) {
			ctx.asyncWriter.enqueue(() =>
				ctx.dbOps
					.getAdapter()
					.run("UPDATE accounts SET rate_limit_reset = ? WHERE id = ?", [
						newEarliestReset,
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
	}

	// ── 5. Success-cooldown recovery (standalone callers only) ─────────────
	// For real-traffic, processProxyResponse still owns this (see
	// CodexObservationSource docs) — performing it here too would double-handle
	// the shared cross-provider success path. `standard` and `scheduled-prime`
	// are identical for now.
	if (!isRateLimited && opts.source !== "real-traffic") {
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

	return {
		usage,
		effectiveCredits,
		earliestResetMs,
		windowRolledOver,
		isRateLimited,
		responseStatus,
	};
}
