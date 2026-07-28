import type { Config } from "@clankermux/config";
import { Logger } from "@clankermux/logger";
import { getAccountCapacitySignal, usageCache } from "@clankermux/providers";
import type {
	Account,
	CapacitySignal,
	LoadBalancingStrategy,
} from "@clankermux/types";
import { FAMILY_WEEKLY_MAX_USAGE_AGE_MS } from "./handlers/family-weekly-gate";
import {
	isAbsorbablePeer,
	resolveLivenessReserveThreshold,
	resolvePoolLivenessDemotion,
} from "./handlers/pool-liveness-gate";
import { hasCapacityRestoredProbePending } from "./handlers/rate-limit-cooldown";
import { getUsageThrottleUntil } from "./handlers/usage-throttling";
import { getProviderWideOverloadUntil } from "./provider-overload-cooldown";
import { resolveEffectiveWeeklySlope } from "./weekly-burn-slope";

const log = new Logger("PrimaryAccountPeek");

// Last computed primary id, for change-only diagnostic logging. `undefined`
// means "never computed"; `null` means "computed, but nothing was eligible".
let lastPrimaryAccountId: string | null | undefined;

/**
 * Predict the account a FRESH, no-affinity, NOMINAL-size request would route to
 * RIGHT NOW, applying the same proxy gates the real request path applies — in
 * the same order: provider-overload (the shared 529 `anthropic-upstream`
 * cooldown) THEN usage-throttle THEN the pool-liveness reserve. Used to drive
 * the dashboard "Primary" badge so it reflects where traffic actually goes
 * during an outage instead of the raw, gate-blind strategy ranking.
 *
 * Modeled scope (intentionally narrow — a single fresh nominal request):
 *  - Walks the strategy's `peekRanked()` ordering and returns the first account
 *    that passes both hard gates and is not liveness-reserved. Because the
 *    ranking spans providers, **cross-provider fallback to Codex IS modeled**:
 *    when every Anthropic account is gated, a healthy Codex account further down
 *    the ranking becomes the primary.
 *  - The pool-liveness reserve is a SOFT demotion in routing, so a reserved
 *    account is still the primary when nothing else survives.
 *  - Returns `null` when every ranked account is gated (badge shows on no one).
 *
 * Deliberately NOT modeled (would require request-specific inputs the badge has
 * no business assuming):
 *  - The context-window gate — we assume a normal-size request, so Codex stays
 *    eligible (a huge prompt that wouldn't fit Codex is not the "next session").
 *  - Burst-throttle — it only delays a request, it does not change its target.
 *  - Combo / model-family routing — request-shape dependent.
 *  - Family-scoped overload buckets — request-shape dependent for the same
 *    reason: which family bucket applies depends on the request's model. Only
 *    a PROVIDER-WIDE open bucket skips an account here (via
 *    `getProviderWideOverloadUntil`); a Haiku-only incident must not move the
 *    badge while Sonnet/Opus traffic still routes to the account.
 *
 * Purity note: this reads usage via `usageCache.peek`, which is fully read-only —
 * it returns null for a stale entry but never evicts it. (The badge inspection
 * must not mutate cache state that routing / window-reset comparisons depend on.)
 */
export function peekPrimaryAccountId(
	accounts: Account[],
	strategy: LoadBalancingStrategy | null | undefined,
	config: Pick<
		Config,
		"getUsageThrottlingFiveHourEnabled" | "getUsageThrottlingWeeklyEnabled"
	>,
	now = Date.now(),
): string | null {
	if (!strategy) return null;

	// Mirror applyUsageThrottling() in proxy.ts exactly.
	const settings = {
		fiveHourEnabled: config.getUsageThrottlingFiveHourEnabled(),
		weeklyEnabled: config.getUsageThrottlingWeeklyEnabled(),
	};
	const throttlingActive = settings.fiveHourEnabled || settings.weeklyEnabled;

	const skippedOverloaded: string[] = [];
	const skippedThrottled: string[] = [];
	const skippedLivenessReserved: string[] = [];
	let primaryId: string | null = null;

	// PASS 1 — the hard gates. Everything that survives BOTH is the pool the
	// liveness reserve is then evaluated against. Order matters: counting an
	// overloaded or throttled account as an absorbable peer would make the badge
	// skip an account that real routing keeps.
	const survivors: Account[] = [];
	for (const account of strategy.peekRanked(accounts)) {
		const ov = getProviderWideOverloadUntil(account.provider, now);
		if (ov && ov > now) {
			skippedOverloaded.push(account.id);
			continue;
		}

		if (throttlingActive) {
			const tu = getUsageThrottleUntil(
				usageCache.peek(account.id),
				settings,
				now,
			);
			if (tu && tu > now) {
				skippedThrottled.push(account.id);
				continue;
			}
		}

		survivors.push(account);
	}

	// PASS 2 — capacity snapshot for the surviving pool, bounded by the SAME
	// freshness window routing uses. `usageCache.peek()` accepts data up to 10
	// minutes old, but routing's liveness path reads through getFreshCapacity's
	// 180s FAMILY_WEEKLY_MAX_USAGE_AGE_MS bound. Without this gate, between 3 and
	// 10 minutes routing would fail open while the badge demoted on stale
	// evidence. peekAge()/peek() are both non-evicting: the badge never mutates
	// cache state that routing depends on.
	const capacityById = new Map<string, CapacitySignal | null>();
	for (const account of survivors) {
		const age = usageCache.peekAge(account.id);
		capacityById.set(
			account.id,
			age !== null && age <= FAMILY_WEEKLY_MAX_USAGE_AGE_MS
				? getAccountCapacitySignal(
						usageCache.peek(account.id),
						account.provider,
						now,
					)
				: null,
		);
	}

	// PASS 3 — the pool-liveness reserve, via the same pure helpers routing uses.
	// The family-reservation input is `false` here for the same reason the family
	// gate itself is not modeled: it is request-shape dependent and the badge
	// assumes a fresh, nominal request.
	//
	// TIER CONVENTION: a generic fresh request is modeled, so the badge always
	// uses the NON-PROTECTED tier — the deeper protected tier is a privilege of
	// actual Fable traffic, and assuming it here would report a primary that
	// ordinary traffic would never be routed to. The burn slope IS per account and
	// is validated exactly as routing validates it (same helper, same binding
	// weekly-window check), so the modeled release horizon matches routing's.
	const reserveThresholdPct = resolveLivenessReserveThreshold(false);
	for (const account of survivors) {
		let absorbablePeerCount = 0;
		for (const peer of survivors) {
			if (peer.id === account.id) continue;
			if (
				isAbsorbablePeer(
					capacityById.get(peer.id) ?? null,
					false,
					hasCapacityRestoredProbePending(peer.id),
					reserveThresholdPct,
				)
			) {
				absorbablePeerCount++;
			}
		}
		const accountCapacity = capacityById.get(account.id) ?? null;
		if (
			resolvePoolLivenessDemotion(accountCapacity, absorbablePeerCount, now, {
				reserveThresholdPct,
				weeklySlopePctPerHour: resolveEffectiveWeeklySlope(
					account.id,
					accountCapacity,
					now,
				),
			})
		) {
			skippedLivenessReserved.push(account.id);
			continue;
		}
		primaryId = account.id;
		break;
	}

	// Routing DEMOTES rather than excludes, so a reserved account is still served
	// when nothing else is left. Mirror that: fall back to the first reserved
	// account rather than reporting no primary.
	if (primaryId === null && skippedLivenessReserved.length > 0) {
		primaryId = skippedLivenessReserved[0];
	}

	// Cheap, change-only diagnostic: only emit when the chosen primary actually
	// moves (mirrors the spirit of the old strategy-level logPeekChange).
	if (primaryId !== lastPrimaryAccountId) {
		const skips: string[] = [];
		if (skippedOverloaded.length) {
			skips.push(`overload-skipped=[${skippedOverloaded.join(", ")}]`);
		}
		if (skippedThrottled.length) {
			skips.push(`throttle-skipped=[${skippedThrottled.join(", ")}]`);
		}
		if (skippedLivenessReserved.length) {
			skips.push(`liveness-reserved=[${skippedLivenessReserved.join(", ")}]`);
		}
		log.info(
			`Primary account → ${primaryId ?? "none"}${
				skips.length ? ` (${skips.join(" ")})` : ""
			}`,
		);
		lastPrimaryAccountId = primaryId;
	}

	return primaryId;
}
