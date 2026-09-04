import type { AccountResponse } from "@clankermux/types";
import { type BurnRatio, burnRatioTone, computeBurnRatio } from "./burn-ratio";
import { computeFiveHourPacing, type FiveHourPacing } from "./five-hour-pacing";
import {
	computePoolUsage,
	type OutlookTone,
	type PoolUsageResult,
	poolClassOutlook,
	type ServableClassPool,
	scopeResultToClass,
	willRunOutCount,
} from "./pool-usage";

/**
 * The pacing scan: how fast the pool is spending its weekly budget, and how
 * hard the 5-hour limit is governing it right now.
 *
 * Lives in core, not in the server, because THREE surfaces consume it: the
 * dashboard renders it, `GET /api/pacing` serves it whole with account names,
 * and `GET /public/v1/pacing` serves a de-identified projection of the same
 * scan. Recomputing it anywhere is how one of them comes to disagree with
 * another about whether a pace is sustainable.
 *
 * Pure: accounts in, figures out. The database read that feeds it is
 * `computePacingScan` in http-api, which is the only part that cannot live
 * here.
 *
 * TWO DIFFERENT QUESTIONS, deliberately kept apart in the output:
 *
 *  - The WEEKLY burn ratio is the budget question — is this class spending its
 *    week faster than the week is passing. It is a per-account reading (keyed on
 *    the class's least-used account, the one the headline percentage names) and
 *    it is NOT the figure that answers "should I run more work". A pool of
 *    staggered accounts with failover routinely shows several accounts over pace
 *    while the pool as a whole is fine.
 *  - The 5-hour rollup is the governor question — is anything being held right
 *    now, and when does it lift. Deferred capacity, not lost capacity.
 *
 * Neither is the signed pace headroom. That comes from the runway scan
 * (`runwayPaceHeadroom`), is pool-level rather than per-class, and is served on
 * the runway resource where it is computed. Publishing it here as well would put
 * one measurement in two places and let them drift — see the one-canonical-home
 * rule in `handlers/public/dto.ts`.
 *
 * FRESHNESS is the DISPLAY view, not the routing-fresh view, and that is a
 * deliberate departure from `runway-scan.ts`. This scan is built from the same
 * account array `/api/accounts` serves, so its figures describe exactly the bars
 * the dashboard draws beside them. The runway takes the stricter view because it
 * DERIVES a future instant; a burn ratio is arithmetic on an observation, and an
 * observation carries an age rather than being disqualified by one.
 */

/** One servable class's weekly budget position and rate. */
export interface ClassBudget {
	classId: string;
	label: string;
	/** The least-used account's weekly utilization — the class's real headroom. */
	utilizationPct: number | null;
	/** That account, so a reader can see WHICH one the figures describe. */
	leastUsedAccountId: string | null;
	leastUsedAccountName: string | null;
	/**
	 * Burn against an even spend of the window, keyed on the SAME account the
	 * percentage names. Null when no honest comparison exists: no reset to
	 * measure against, or a window so young the expected percentage is too small
	 * to divide by.
	 */
	burn: BurnRatio | null;
	burnTone: OutlookTone | null;
	/** The class's own verdict chip, from the shared threshold policy. */
	outlookLabel: string;
	outlookTone: OutlookTone;
	/** Accounts reporting a weekly reading, out of those that could. */
	reportingCount: number;
	eligibleTotal: number;
	/**
	 * Accounts with no weekly reading at all. NEVER folded into a zero: "nobody
	 * has polled this account" and "this account is untouched" are opposite
	 * facts, and only one of them is reassuring.
	 */
	unknownCount: number;
	/** How many will reach 100% before their own reset, and how many already have. */
	willRunOut: number;
	willRunOutCapacity: number;
	alreadySpent: number;
	/** Earliest weekly reset in the class, and whose. */
	earliestResetMs: number | null;
	earliestResetAccountId: string | null;
	earliestResetAccountName: string | null;
	/** No account in this class can serve a request. */
	singlePointOfFailure: boolean;
}

export interface PacingSnapshot {
	generatedAtMs: number;
	/** Weekly budget, one row per servable class, tightest first is NOT assumed. */
	classes: ClassBudget[];
	/** The class that binds — the tightest one — or null when none reports. */
	bindingClassId: string | null;
	/** The 5-hour governor rollup, per class plus a pool verdict. */
	fiveHour: FiveHourPacing;
}

/** The per-class budget row for one class, from the already-scoped result. */
function classBudget(
	sevenDay: PoolUsageResult,
	pool: ServableClassPool,
	now: number,
): ClassBudget {
	const scoped = scopeResultToClass(sevenDay, pool);
	const { willRunOut, capacity, spent } = willRunOutCount(scoped, "seven_day");
	const leastUsed = pool.leastUsed;
	// Keyed on the least-used account, matching the percentage above it. A ratio
	// computed over any other account would sit beside a figure it does not
	// describe — the dashboard learned that one the hard way.
	const burn =
		leastUsed == null
			? null
			: computeBurnRatio(leastUsed.pct, leastUsed.resetMs, "seven_day", now);
	const outlook = poolClassOutlook(pool);

	return {
		classId: pool.classId,
		label: pool.label,
		utilizationPct: leastUsed?.pct ?? null,
		leastUsedAccountId: leastUsed?.accountId ?? null,
		leastUsedAccountName: leastUsed?.name ?? null,
		burn,
		burnTone: burn == null ? null : burnRatioTone(burn),
		outlookLabel: outlook.label,
		outlookTone: outlook.tone,
		reportingCount: pool.reportingCount,
		eligibleTotal: pool.eligibleTotal,
		unknownCount: pool.eligibleTotal - pool.capacityCount,
		willRunOut,
		willRunOutCapacity: capacity,
		alreadySpent: spent,
		earliestResetMs: pool.earliestResetMs,
		earliestResetAccountId: pool.earliestResetAccountId ?? null,
		earliestResetAccountName: pool.earliestResetAccountName,
		singlePointOfFailure: pool.singlePointOfFailure,
	};
}

/**
 * Compute the pacing scan from an already-built account array.
 *
 * Split from {@link computePacingScan} so tests can drive it with fixture
 * accounts without a database, and so the reader that memoizes it has one
 * obvious thing to call.
 */
export function computePacingFromAccounts(
	accounts: AccountResponse[],
	now: number,
): PacingSnapshot {
	const sevenDay = computePoolUsage(accounts, "seven_day", now);
	const fiveHour = computePoolUsage(accounts, "five_hour", now);

	return {
		generatedAtMs: now,
		classes: sevenDay.classes.map((pool) => classBudget(sevenDay, pool, now)),
		bindingClassId: sevenDay.bindingClass?.classId ?? null,
		// BOTH windows, because the 5-hour picture cannot be read from the 5-hour
		// result alone: an account out of its weekly quota too is not merely
		// waiting for a lift, and reporting it as waiting promises capacity that
		// will not arrive.
		fiveHour: computeFiveHourPacing(fiveHour, sevenDay, now),
	};
}
