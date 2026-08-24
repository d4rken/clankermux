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
 * The name of the routing context these predictions are made in, so a surface
 * that publishes a candidate can say WHICH question it answered.
 *
 * "Fresh" (no affinity to an earlier turn), "unpinned" (no API-key pin) and
 * "nominal" (a normal-size prompt, so the context-window gate is not modelled).
 * Every exclusion listed on {@link evaluateDefaultCandidates} is a property of
 * this context, not a bug in the prediction — a caller that publishes the
 * candidate without publishing the context invites a client to read it as "the
 * account the load balancer is currently using", which is not a thing that
 * exists.
 */
export const DEFAULT_ROUTING_CONTEXT = "fresh_unpinned_nominal";

/** Why one of the two hard gates removed a ranked account from the candidates. */
export type PeekExclusionReason = "provider_overload" | "usage_throttled";

/**
 * A ranked account the prediction excluded, and WHEN that ONE exclusion lifts.
 *
 * Both modelled exclusions are timed: the provider-wide overload breaker and
 * the proactive usage throttle each hold until a known instant. That is what
 * lets a caller publishing `candidateIds.length` also say when a pool of zero
 * recovers, instead of reporting an empty pool with no known recovery.
 *
 * One entry per ACTIVE GATE, not per account: an account under a provider-wide
 * overload that is ALSO usage-throttled appears twice, once per gate. It is
 * routable again only when its LAST gate lifts, so a caller deriving a recovery
 * instant must take the MAXIMUM across one account's entries — see
 * {@link earliestExclusionRecoveryMs}, which is that derivation.
 */
export interface PeekExclusion {
	accountId: string;
	reason: PeekExclusionReason;
	/** INSTANT the exclusion lifts, always in the future relative to `now`. */
	recoversAtMs: number;
}

/**
 * One evaluation of the default routing context: the candidates, and what the
 * gates did to everything else.
 *
 * Returned together on purpose. The candidate COUNT, the HEAD candidate and the
 * earliest recovery instant are three readings of one evaluation, and a caller
 * that recomputed any of them separately could publish "nothing is routable"
 * beside "nothing is waiting on a clock" while an overload breaker was
 * plainly counting down.
 */
export interface DefaultCandidateEvaluation {
	/** Candidates, best first. Empty when every ranked account is gated. */
	candidateIds: string[];
	/**
	 * The gate exclusions the two hard gates produced, one entry per ACTIVE
	 * gate — an account held by both is listed twice.
	 */
	exclusions: PeekExclusion[];
	/**
	 * Accounts the pool-liveness reserve DEMOTED. They are still in
	 * `candidateIds`, at the back — routing demotes rather than excludes, so
	 * they are not exclusions and have no recovery instant.
	 */
	livenessReservedIds: string[];
}

/**
 * The accounts a FRESH, no-affinity, unpinned, NOMINAL-size request would
 * consider RIGHT NOW, best first, applying the same proxy gates the real
 * request path applies in the same order: provider-overload (the shared 529
 * `anthropic-upstream` cooldown) THEN usage-throttle THEN the pool-liveness
 * reserve.
 *
 * Modeled scope (intentionally narrow — a single fresh nominal request):
 *  - Walks the strategy's `peekRanked()` ordering, which has already dropped
 *    everything `isPeekAvailable` rejects (paused without a simulatable
 *    auto-unpause, cooling off), and drops the accounts the two hard gates
 *    reject. Because the ranking spans providers, **cross-provider fallback to
 *    Codex IS modeled**: when every Anthropic account is gated, a healthy Codex
 *    account further down the ranking becomes the candidate.
 *  - The pool-liveness reserve is a SOFT demotion in routing, never a removal,
 *    so reserved accounts are moved to the BACK rather than dropped. That is
 *    what keeps the head of this list equal to the account routing would pick
 *    while the list itself stays a count of what can be routed to at all.
 *  - Empty when every ranked account is gated.
 *
 * Deliberately NOT modeled (would require request-specific inputs a pool-level
 * prediction has no business assuming):
 *  - The context-window gate — a nominal request is assumed, so Codex stays
 *    eligible (a huge prompt that wouldn't fit Codex is not the "next session").
 *  - Burst-throttle — it only delays a request, it does not change its target.
 *  - Combo / model-family routing — request-shape dependent.
 *  - API-key pins — key-shape dependent, and the pool has no key in hand.
 *  - Family-scoped overload buckets — request-shape dependent for the same
 *    reason: which family bucket applies depends on the request's model. Only
 *    a PROVIDER-WIDE open bucket skips an account here (via
 *    `getProviderWideOverloadUntil`); a Haiku-only incident must not move the
 *    prediction while Sonnet/Opus traffic still routes to the account.
 *
 * Purity note: this reads usage via `usageCache.peek`, which is fully read-only —
 * it returns null for a stale entry but never evicts it. (The inspection must
 * not mutate cache state that routing / window-reset comparisons depend on.)
 *
 * Silent, unlike {@link peekPrimaryAccountId}: the change-only diagnostic there
 * describes the DASHBOARD's badge moving, and an unauthenticated widget polling
 * every few seconds must not be able to drive that log. Nothing outside this
 * call is mutated either — the skip lists travel in the RETURN VALUE, so two
 * callers can never read each other's evaluation.
 */
export function evaluateDefaultCandidates(
	accounts: Account[],
	strategy: LoadBalancingStrategy | null | undefined,
	config: Pick<
		Config,
		"getUsageThrottlingFiveHourEnabled" | "getUsageThrottlingWeeklyEnabled"
	>,
	now = Date.now(),
): DefaultCandidateEvaluation {
	if (!strategy) {
		return { candidateIds: [], exclusions: [], livenessReservedIds: [] };
	}

	// Mirror applyUsageThrottling() in proxy.ts exactly.
	const settings = {
		fiveHourEnabled: config.getUsageThrottlingFiveHourEnabled(),
		weeklyEnabled: config.getUsageThrottlingWeeklyEnabled(),
	};
	const throttlingActive = settings.fiveHourEnabled || settings.weeklyEnabled;

	const exclusions: PeekExclusion[] = [];
	const skippedLivenessReserved: string[] = [];

	// PASS 1 — the hard gates. Everything that survives BOTH is the pool the
	// liveness reserve is then evaluated against. Order matters: counting an
	// overloaded or throttled account as an absorbable peer would make the
	// prediction skip an account that real routing keeps.
	const survivors: Account[] = [];
	for (const account of strategy.peekRanked(accounts)) {
		// EVERY active gate is recorded, not just the first one that hits. The two
		// gates are independent holds on the same account and can run to different
		// deadlines: a provider-wide overload until T1 alongside a usage throttle
		// until a later T2 leaves the account gated until T2. Stopping at the first
		// gate would leave the second deadline undiscovered, and a caller taking
		// the earliest recovery across the pool would then publish T1 — a moment at
		// which nothing is actually routable. Both reads are pure (a non-evicting
		// `usageCache.peek` and a breaker inspection), so evaluating the second gate
		// for an already-gated account costs nothing and mutates nothing.
		let gated = false;

		const ov = getProviderWideOverloadUntil(account.provider, now);
		if (ov && ov > now) {
			exclusions.push({
				accountId: account.id,
				reason: "provider_overload",
				recoversAtMs: ov,
			});
			gated = true;
		}

		if (throttlingActive) {
			const tu = getUsageThrottleUntil(
				usageCache.peek(account.id),
				settings,
				now,
			);
			if (tu && tu > now) {
				exclusions.push({
					accountId: account.id,
					reason: "usage_throttled",
					recoversAtMs: tu,
				});
				gated = true;
			}
		}

		// Membership is unchanged by the above: an account survives exactly when
		// NEITHER gate held it, as before.
		if (gated) continue;

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
	// gate itself is not modeled: it is request-shape dependent and this models a
	// fresh, nominal request.
	//
	// TIER CONVENTION: a generic fresh request is modeled, so this always uses
	// the NON-PROTECTED tier — the deeper protected tier is a privilege of
	// actual Fable traffic, and assuming it here would report a candidate that
	// ordinary traffic would never be routed to. The burn slope IS per account and
	// is validated exactly as routing validates it (same helper, same binding
	// weekly-window check), so the modeled release horizon matches routing's.
	const reserveThresholdPct = resolveLivenessReserveThreshold(false);
	const unreserved: string[] = [];
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
		unreserved.push(account.id);
	}

	// Routing DEMOTES rather than excludes, so the reserved accounts go to the
	// BACK of the ranking rather than out of it: they are still routed to when
	// nothing else is left, and dropping them here would understate what the
	// pool can serve.
	return {
		candidateIds: [...unreserved, ...skippedLivenessReserved],
		exclusions,
		livenessReservedIds: skippedLivenessReserved,
	};
}

/**
 * The earliest instant at which the pool regains a routable account, judged
 * only by the gate exclusions — or null when no account was gated.
 *
 * MAXIMUM within one account, MINIMUM across accounts. An account held by two
 * gates at once is not routable when the first of them lifts, it is routable
 * when its LAST one does; taking the global minimum over the raw entries would
 * publish the earlier deadline and promise a recovery that does not happen.
 * Across accounts the minimum is right, because the pool recovers as soon as
 * ANY one account does.
 *
 * Pure: derived entirely from the passed evaluation, so two callers can never
 * read each other's.
 */
export function earliestExclusionRecoveryMs(
	exclusions: readonly PeekExclusion[],
): number | null {
	const lastGateByAccount = new Map<string, number>();
	for (const exclusion of exclusions) {
		const held = lastGateByAccount.get(exclusion.accountId);
		if (held === undefined || exclusion.recoversAtMs > held) {
			lastGateByAccount.set(exclusion.accountId, exclusion.recoversAtMs);
		}
	}

	let earliest: number | null = null;
	for (const recoversAtMs of lastGateByAccount.values()) {
		if (earliest === null || recoversAtMs < earliest) earliest = recoversAtMs;
	}
	return earliest;
}

/**
 * The ids alone, for a caller that has no use for WHY an account is out.
 */
export function peekDefaultCandidateIds(
	accounts: Account[],
	strategy: LoadBalancingStrategy | null | undefined,
	config: Pick<
		Config,
		"getUsageThrottlingFiveHourEnabled" | "getUsageThrottlingWeeklyEnabled"
	>,
	now = Date.now(),
): string[] {
	return evaluateDefaultCandidates(accounts, strategy, config, now)
		.candidateIds;
}

/**
 * The single account a fresh, unpinned, nominal-size request would route to
 * right now — the head of {@link peekDefaultCandidateIds}, which is where the
 * whole prediction lives. Drives the dashboard "Primary" badge, and emits the
 * change-only diagnostic that goes with it.
 *
 * `null` when every ranked account is gated (the badge shows on no one).
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
	const evaluation = evaluateDefaultCandidates(accounts, strategy, config, now);
	const primaryId = evaluation.candidateIds[0] ?? null;

	// Cheap, change-only diagnostic: only emit when the chosen primary actually
	// moves (mirrors the spirit of the old strategy-level logPeekChange).
	if (primaryId !== lastPrimaryAccountId) {
		const idsExcludedFor = (reason: PeekExclusionReason): string[] =>
			evaluation.exclusions
				.filter((exclusion) => exclusion.reason === reason)
				.map((exclusion) => exclusion.accountId);
		const overloaded = idsExcludedFor("provider_overload");
		const throttled = idsExcludedFor("usage_throttled");
		const skips: string[] = [];
		if (overloaded.length) {
			skips.push(`overload-skipped=[${overloaded.join(", ")}]`);
		}
		if (throttled.length) {
			skips.push(`throttle-skipped=[${throttled.join(", ")}]`);
		}
		if (evaluation.livenessReservedIds.length) {
			skips.push(
				`liveness-reserved=[${evaluation.livenessReservedIds.join(", ")}]`,
			);
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
