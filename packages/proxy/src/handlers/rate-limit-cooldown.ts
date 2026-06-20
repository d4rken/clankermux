import {
	computeRateLimitBackoffMs,
	logError,
	RateLimitError,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { Account, RateLimitReason } from "@clankermux/types";
import type { ProxyContext } from "./proxy-types";

const log = new Logger("RateLimitCooldown");

/**
 * Single entry point for applying a 429-driven cooldown to an account.
 * Computes exponential-backoff cooldown capped by upstream reset (if any), updates
 * in-memory state, and enqueues the DB-side atomic increment.
 *
 * Must be called from every 429 path (response-processor, model_fallback_429,
 * all_models_exhausted_429) — never reach into rate_limited_until manually.
 *
 * @param account - The account that just received a 429 (mutated in place).
 * @param rateLimitInfo - Parsed rate-limit hints from the provider. `resetTime`
 *   caps the computed cooldown via `min(resetTime, now + backoff)`. `remaining`
 *   is forwarded to the emitted `RateLimitError` for observability. `reason`
 *   overrides the auto-derived audit reason (use for `model_fallback_429` /
 *   `all_models_exhausted_429` paths so the audit trail is preserved).
 * @param ctx - The proxy context (provides `asyncWriter` + `dbOps`).
 * @param options - Optional behaviour flags. See {@link applyRateLimitCooldown}'s
 *   `reprobe` documentation below.
 *
 * ### Re-probe semantics (`options.reprobe === true`)
 *
 * The transparent burst-retry feature re-probes a held cache account *while it is
 * still inside its existing cooldown window* (a deliberate, bounded retry on the
 * same throttled IP). Those re-probe 429s must NOT escalate the account's streak
 * state, otherwise every gentle re-probe would inflate the backoff tier and delay
 * the streak-reset-on-success. When `reprobe` is set, this function therefore:
 *
 *   - DOES NOT touch `account.consecutive_rate_limits` (no streak escalation).
 *   - DOES NOT touch `account.rate_limited_at` (so a later genuine success can
 *     still reset the streak via the stability window — see response-processor's
 *     `(a) Stability reset`, which is gated on `rate_limited_at` alone).
 *   - DOES NOT enqueue the DB-side `markAccountRateLimited` increment.
 *   - ONLY refreshes `account.rate_limited_until` to the upstream-provided
 *     `resetTime` (if any) so the hold orchestrator's next wait is computed from
 *     a fresh deadline. With no `resetTime`, in-memory state is left untouched
 *     entirely (the orchestrator computes its own bounded wait).
 *
 * The default (no `options`, or `reprobe` falsy) path is byte-for-byte identical
 * to the original behaviour.
 */
export function applyRateLimitCooldown(
	account: Account,
	rateLimitInfo: {
		resetTime?: number;
		remaining?: number;
		reason?: RateLimitReason;
		/**
		 * Hard minimum cooldown deadline (epoch ms). After the normal
		 * `min(resetTime, now + backoff)` computation the cooldown is raised to
		 * `floorUntil` if it is larger — letting a deliberately LONG cooldown (e.g.
		 * out-of-credits depletion) survive the exponential-backoff cap, which would
		 * otherwise pin every no-reset 429 at the backoff ceiling. Omitted on all
		 * normal paths (no behavioural change). Ignored in `reprobe` mode.
		 */
		floorUntil?: number;
	},
	ctx: ProxyContext,
	options?: { reprobe?: boolean },
): void {
	const now = Date.now();

	// Re-probe path: a gentle retry of a held account inside its existing
	// cooldown. Never escalate the streak or its anchor; only advance
	// rate_limited_until from a fresh upstream reset so the next wait is right.
	if (options?.reprobe) {
		if (rateLimitInfo.resetTime && rateLimitInfo.resetTime > now) {
			account.rate_limited_until = rateLimitInfo.resetTime;
		}
		// Deliberately do NOT touch consecutive_rate_limits, rate_limited_at, or
		// enqueue a DB write. Emit only an observability error (no DB reconcile).
		const rateLimitError = new RateLimitError(
			account.id,
			account.rate_limited_until ?? now,
			rateLimitInfo.remaining,
		);
		logError(rateLimitError, log);
		return;
	}

	// Best-effort in-memory computation. The DB write does the authoritative atomic
	// increment; under parallel 429s the second concurrent request may compute one
	// tier short, but the persisted counter still ramps correctly.
	const nextCount = account.consecutive_rate_limits + 1;
	const backoffMs = computeRateLimitBackoffMs(nextCount);
	const candidateUntil = now + backoffMs;
	let cooldownUntil = rateLimitInfo.resetTime
		? Math.min(rateLimitInfo.resetTime, candidateUntil)
		: candidateUntil;
	// A hard floor (e.g. out-of-credits depletion) overrides the backoff cap
	// upward so a deliberately long cooldown is not shortened by the exponential
	// ramp's min(resetTime, backoff).
	if (rateLimitInfo.floorUntil && rateLimitInfo.floorUntil > cooldownUntil) {
		cooldownUntil = rateLimitInfo.floorUntil;
	}
	const reason: RateLimitReason =
		rateLimitInfo.reason ??
		(rateLimitInfo.resetTime
			? "upstream_429_with_reset"
			: "upstream_429_no_reset_probe_cooldown");

	// In-memory update so the rest of this request sees consistent state.
	account.rate_limited_until = cooldownUntil;
	account.rate_limited_at = now;
	account.consecutive_rate_limits = nextCount;

	ctx.asyncWriter.enqueue(async () => {
		const persistedCount = await ctx.dbOps.markAccountRateLimited(
			account.id,
			cooldownUntil,
			reason,
		);
		// Reconcile in-memory counter with the authoritative DB value (may differ
		// under concurrent 429s for the same account).
		account.consecutive_rate_limits = persistedCount;
		// Log AFTER the DB write so the reported `consecutive=` reflects the
		// persisted counter — not the in-memory pre-write estimate (which may
		// be one tier short under concurrent 429s for the same account).
		log.warn(
			`[clankermux] account=${account.name} cooldown_applied reason=${reason} until=${new Date(cooldownUntil).toISOString()} consecutive=${persistedCount}`,
		);
	});

	const rateLimitError = new RateLimitError(
		account.id,
		cooldownUntil,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
}
