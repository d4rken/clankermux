import type { ModelFamily } from "@clankermux/core";
import {
	computeWindowStartMs,
	estimateWindowExhaustion,
	extractFiveHour,
	extractSevenDay,
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	isAnthropicStyleShape,
	normalizeAnthropicUsage,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
} from "@clankermux/core";
import type {
	AccountResponse,
	AnthropicUsageData,
	UsagePrediction,
} from "@clankermux/types";
import {
	usageObservedAtMs,
	weeklyLifetimeConfidence,
} from "./lifetime-confidence";

export type PoolWindow = "five_hour" | "seven_day";

export type ExcludedReason =
	| "paused"
	| "rate_limited"
	| "token_expired"
	| "usage_rate_limited"
	| "five_hour_exhausted"
	| "seven_day_exhausted"
	| "no_usage_data";

export interface PoolUsageContribution {
	/** Stable join key. Names are user-set and need not be unique. */
	accountId: string;
	name: string;
	pct: number;
	resetMs: number | null;
}

export interface PoolUsageProjection
	extends Omit<PoolUsageContribution, "resetMs"> {
	resetMs: number;
	exhaustsAtMs: number;
	timeToExhaustMs: number;
	remainingMs: number;
}

export interface PoolUsageExclusion {
	name: string;
	reason: ExcludedReason;
	resetMs: number | null;
}

export interface PoolUsageFallback {
	name: string;
	provider: string;
}

/**
 * Percent at/above which a per-model-family weekly window is surfaced as
 * "elevated" in the pool view (worth a callout even when account-wide capacity
 * is healthy). Inline named constant — NO env var / feature gate.
 */
export const FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT = 80;

/** One account's contribution to a per-family weekly bucket. */
export interface FamilyWeeklyAccountUsage {
	name: string;
	pct: number;
	resetMs: number;
	/**
	 * Projected instant this account reaches 100% of THIS family's weekly cap,
	 * or null when it is not projected to get there before `resetMs` (and null
	 * at/above 100%, which is spent rather than projected — those are counted by
	 * `exhaustedCount`).
	 *
	 * ALWAYS the lifetime-average estimate, never the server regression: the only
	 * predictions we receive are `prediction.fiveHour` / `prediction.sevenDay`,
	 * both fitted to the ACCOUNT-WIDE utilization series. A family-scoped cap has
	 * a different numerator, so that slope is in %/hour of the wrong quantity —
	 * feeding it in here would emit a `lowConfidence: false` projection built on
	 * a mismatched denominator. Passing `prediction: null` makes
	 * `estimateWindowExhaustion` take its lifetime-average branch.
	 *
	 * It takes the LOW-confidence, now-anchored form of that branch, because
	 * {@link weeklyLifetimeConfidence} grants `"full"` to the account-wide weekly
	 * window only — the scoped family windows were never measured against a
	 * regression and reset on their own schedules. That policy is asked rather
	 * than assumed, so if the measurement is ever extended to family windows this
	 * projection follows it without another edit here. Low confidence is why the
	 * popover renders it muted and never red.
	 */
	exhaustsAtMs: number | null;
}

/**
 * Aggregated per-model-family weekly usage across the pool. A family limit is
 * independent, actionable info even when the account-wide weekly window reads
 * healthy, so this is computed separately from the pool average. Accounts whose
 * own account-wide window is spent are excluded — see
 * {@link computeFamilyWeeklyUsage}. Exactly one row per account per family.
 */
export interface FamilyWeeklyUsage {
	family: ModelFamily;
	/** Anthropic display name for the family, e.g. "Fable". */
	label: string;
	/**
	 * Max pct across contributing accounts for this family. This is ONE
	 * account's number, not a pool aggregate — pair it with `exhaustedCount` /
	 * `elevatedCount` over `accounts.length` before stating anything pool-wide.
	 */
	worstPct: number;
	/** The account driving worstPct. */
	worstAccountName: string;
	/** Soonest reset across this family's accounts. */
	earliestResetMs: number;
	/** worstPct >= FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT. */
	elevated: boolean;
	/** Accounts of `accounts` at/above 100% — i.e. actually out of this family. */
	exhaustedCount: number;
	/** Accounts of `accounts` at/above FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT. */
	elevatedCount: number;
	/**
	 * Accounts of `accounts` with a non-null `exhaustsAtMs`. Disjoint from
	 * `exhaustedCount` by construction — an account is either already out of
	 * this family or projected to run out of it, never both.
	 */
	atRiskCount: number;
	/**
	 * Soonest `exhaustsAtMs` across `accounts`; null when none is at risk. Low
	 * confidence for the reason documented on
	 * {@link FamilyWeeklyAccountUsage.exhaustsAtMs}.
	 */
	soonestExhaustsAtMs: number | null;
	/** Per-account rows, sorted desc by pct. */
	accounts: FamilyWeeklyAccountUsage[];
}

export interface PoolUsageResult {
	average: number | null;
	activeAverage: number | null;
	worst: { name: string; pct: number } | null;
	contributing: PoolUsageContribution[];
	exhausted: PoolUsageExclusion[];
	excluded: PoolUsageExclusion[];
	fallback: PoolUsageFallback[];
	earliestResetMs: number | null;
	earliestResetAccountName: string | null;
	atRisk: PoolUsageProjection[];
	familyWeekly: FamilyWeeklyUsage[];
}

function eligibleProvidersFor(window: PoolWindow): ReadonlySet<string> {
	return window === "five_hour"
		? FIVE_HOUR_ELIGIBLE_PROVIDERS
		: SEVEN_DAY_ELIGIBLE_PROVIDERS;
}

function classifyExclusion(
	account: AccountResponse,
	now: number,
): { reason: ExcludedReason; resetMs: number | null } | null {
	if (account.paused === true) return { reason: "paused", resetMs: null };
	if (account.rateLimitedUntil != null && account.rateLimitedUntil > now) {
		return { reason: "rate_limited", resetMs: account.rateLimitedUntil };
	}
	if (account.hasRefreshToken === true && account.tokenExpiresAt) {
		const expiresMs = Date.parse(account.tokenExpiresAt);
		if (Number.isFinite(expiresMs) && expiresMs < now) {
			return { reason: "token_expired", resetMs: null };
		}
	}
	if (
		account.usageRateLimitedUntil != null &&
		account.usageRateLimitedUntil > now &&
		!account.usageData
	) {
		return {
			reason: "usage_rate_limited",
			resetMs: account.usageRateLimitedUntil,
		};
	}
	return null;
}

function classifyQuotaExhaustion(
	account: AccountResponse,
): { reason: ExcludedReason; resetMs: number | null } | null {
	if (!account.usageData) return null;

	const fiveHour = extractFiveHour(account.usageData);
	if (fiveHour?.pct != null && fiveHour.pct >= 100) {
		return { reason: "five_hour_exhausted", resetMs: fiveHour.resetMs };
	}

	const sevenDay = extractSevenDay(account.usageData);
	if (sevenDay?.pct != null && sevenDay.pct >= 100) {
		return { reason: "seven_day_exhausted", resetMs: sevenDay.resetMs };
	}

	return null;
}

/**
 * Aggregate per-model-family weekly usage across the pool. A family's weekly
 * quota is independent of the account-wide 5h/7d windows, so a family can be
 * spent while the pool headline reads healthy — that is the case this exists to
 * surface.
 *
 * Accounts are excluded on the same terms the pool tile itself uses: structural
 * unavailability via {@link classifyExclusion} (paused / rate-limited /
 * token-expired / usage-429-with-no-data) AND account-wide quota exhaustion via
 * {@link classifyQuotaExhaustion}. The quota filter is deliberate: an account
 * whose own 5h/7d window is spent cannot serve ANY family, so folding its
 * per-family number in here inflated `worstPct` with an account the tile had
 * already moved to its "Exhausted" section — the badge then cited an account
 * the same card listed as unavailable. Those accounts are not hidden, they are
 * reported where they belong (`exhausted`), so do not "restore" them here.
 *
 * Only Anthropic-style payloads carry scoped windows.
 *
 * The per-family scoped windows come from {@link normalizeAnthropicUsage}, which
 * already filters to finite percent, resolvable family, and finite FUTURE reset
 * (stale/rolled-over windows are dropped) — so no staleness re-filtering here.
 */
/**
 * When one account reaches 100% of one family-scoped weekly cap, or null when
 * it is not projected to before `resetMs`.
 *
 * Runs the same shared estimator as the account-wide at-risk list so the two
 * agree on what "at risk" means, with two deliberate differences:
 *
 *  - `prediction` is null. See {@link FamilyWeeklyAccountUsage.exhaustsAtMs}:
 *    the server only fits the account-wide series, so its slope does not apply
 *    to a scoped cap.
 *  - Accounts at/above 100% are rejected. The estimator answers
 *    `already-exhausted` with `exhaustsAtMs: now` for those, which is correct
 *    but would make them count twice — once in `exhaustedCount` and again in
 *    `atRiskCount`. The account-wide path never sees this because
 *    `classifyQuotaExhaustion` removes spent accounts before its projection
 *    loop; the family path keeps them, because a family-exhausted account is
 *    still a live member of the pool for every other family.
 */
/**
 * The window kind for a per-model-family weekly cap. Used for BOTH the duration
 * lookup and the lifetime-confidence policy, so the two can never be asked about
 * different windows.
 */
const SCOPED_WEEKLY_WINDOW = "seven_day_scoped";

/** Earlier of two projected instants, treating null as "not projected". */
function soonerOf(a: number | null, b: number | null): number | null {
	if (a === null) return b;
	if (b === null) return a;
	return Math.min(a, b);
}

function projectFamilyExhaustion(
	pct: number,
	resetMs: number,
	observedAtMs: number | null,
	now: number,
): number | null {
	if (pct >= 100) return null;
	const estimate = estimateWindowExhaustion(
		{
			utilizationPct: pct,
			resetsAtMs: resetMs,
			windowStartMs: computeWindowStartMs(resetMs, SCOPED_WEEKLY_WINDOW),
			prediction: null,
			// Asked, not assumed: today this returns undefined (= "low") for the
			// scoped kind, which is the same as omitting the field, but going
			// through the policy keeps this projection tied to the one definition
			// the progress bar, the pool at-risk list and the forecast line share.
			lifetimeConfidence: weeklyLifetimeConfidence(SCOPED_WEEKLY_WINDOW),
			// Supplied even though the low path ignores it. The estimator needs the
			// policy AND an observation instant together, and degrades to "low"
			// when either is missing — so passing only the policy would make a
			// future "full" for scoped windows silently do nothing.
			observedAtMs,
		},
		now,
	);
	if (estimate.exhaustsAtMs === null) return null;
	if (estimate.exhaustsAtMs >= resetMs) return null;
	return estimate.exhaustsAtMs;
}

export function computeFamilyWeeklyUsage(
	accounts: AccountResponse[],
	now: number,
): FamilyWeeklyUsage[] {
	// Rows are keyed by account id, not pushed: ONE account can report several
	// scoped windows that collapse onto the same family — getModelFamily() maps
	// Mythos-class display names onto "fable". Left as a plain push, that account
	// would occupy two rows and inflate `accounts.length`, which is the
	// denominator of a user-visible "N of M accounts" claim (and would collide as
	// a React key in the per-account popover list). Keyed by id rather than name
	// because names are user-set and need not be unique.
	const buckets = new Map<
		ModelFamily,
		{ label: string; accounts: Map<string, FamilyWeeklyAccountUsage> }
	>();

	for (const account of accounts) {
		if (classifyExclusion(account, now) !== null) continue;
		if (!account.usageData) continue;
		if (classifyQuotaExhaustion(account) !== null) continue;
		if (!isAnthropicStyleShape(account.usageData)) continue;

		const scoped = normalizeAnthropicUsage(
			account.usageData as AnthropicUsageData,
			now,
		).weeklyScoped;
		// One reading time for every scoped window this account reports: they all
		// come out of the same `usageData` payload.
		const observedAtMs = usageObservedAtMs(account.usageAsOfIso);

		for (const limit of scoped) {
			let bucket = buckets.get(limit.family);
			if (bucket === undefined) {
				bucket = { label: limit.displayName, accounts: new Map() };
				buckets.set(limit.family, bucket);
			}
			const previous = bucket.accounts.get(account.id);
			// Keep the binding window for this account: highest percent, and on a
			// tie the one that clears first.
			const supersedes =
				previous === undefined ||
				limit.percent > previous.pct ||
				(limit.percent === previous.pct && limit.resetsAtMs < previous.resetMs);
			const binding =
				supersedes || previous === undefined
					? {
							name: account.name,
							pct: limit.percent,
							resetMs: limit.resetsAtMs,
						}
					: {
							name: previous.name,
							pct: previous.pct,
							resetMs: previous.resetMs,
						};
			// The PROJECTION is folded across every window in this family, not taken
			// from the binding one. Percent alone does not decide risk when the resets
			// differ: 90% clearing in 12h is not projected to exhaust, while 80%
			// clearing in 3d is projected to exhaust in 1d — and both can fold onto
			// `fable`. Keeping only the binding window's projection would report that
			// account as not at risk. The account runs out of the family when its
			// FIRST constituent window does, so take the earliest.
			bucket.accounts.set(account.id, {
				...binding,
				exhaustsAtMs: soonerOf(
					previous?.exhaustsAtMs ?? null,
					projectFamilyExhaustion(
						limit.percent,
						limit.resetsAtMs,
						observedAtMs,
						now,
					),
				),
			});
		}
	}

	const result: FamilyWeeklyUsage[] = [];
	for (const [family, bucket] of buckets) {
		// An account whose BINDING window is spent is already out of this family,
		// so it must not also be reported as projected to run out of it: that would
		// put one account in both `exhaustedCount` and `atRiskCount`, and would
		// print a run-out time next to the 100% the same row shows. The folded
		// projection makes this reachable even though no single window at/above
		// 100% projects — Fable at 100% with Mythos at 80% binds on Fable and
		// inherits Mythos's projection. Resolved HERE rather than at fold time
		// because a later window can still supersede the binding one.
		const rows = [...bucket.accounts.values()].map((row) =>
			row.pct >= 100 ? { ...row, exhaustsAtMs: null } : row,
		);
		const sortedAccounts = rows.sort((a, b) => b.pct - a.pct);
		const worst = sortedAccounts[0];
		const earliestResetMs = Math.min(...rows.map((a) => a.resetMs));
		const projected = sortedAccounts
			.map((a) => a.exhaustsAtMs)
			.filter((ms): ms is number => ms !== null);
		result.push({
			family,
			label: bucket.label,
			worstPct: worst.pct,
			worstAccountName: worst.name,
			earliestResetMs,
			elevated: worst.pct >= FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT,
			exhaustedCount: sortedAccounts.filter((a) => a.pct >= 100).length,
			elevatedCount: sortedAccounts.filter(
				(a) => a.pct >= FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT,
			).length,
			atRiskCount: projected.length,
			soonestExhaustsAtMs:
				projected.length === 0 ? null : Math.min(...projected),
			accounts: sortedAccounts,
		});
	}

	result.sort((a, b) => b.worstPct - a.worstPct);
	return result;
}

export function computePoolUsage(
	accounts: AccountResponse[],
	window: PoolWindow,
	now: number,
): PoolUsageResult {
	const contributing: PoolUsageContribution[] = [];
	const exhausted: PoolUsageExclusion[] = [];
	const excluded: PoolUsageExclusion[] = [];
	const fallback: PoolUsageFallback[] = [];
	// Captured while iterating the accounts so the at-risk projection below can
	// reach each contribution's server-side prediction. Keyed by account id —
	// NEVER by name, which is user-set and need not be unique.
	const predictions = new Map<string, UsagePrediction | undefined>();
	// Likewise for WHEN each contribution's reading was sampled: the weekly
	// window's full-confidence estimate anchors its ETA there instead of at
	// `now`, so a list rebuilt on an unchanged poll reports the same instants.
	const observedAt = new Map<string, number | null>();

	const eligible = eligibleProvidersFor(window);

	for (const account of accounts) {
		if (!eligible.has(account.provider)) {
			fallback.push({ name: account.name, provider: account.provider });
			continue;
		}

		const exclusion =
			classifyExclusion(account, now) ?? classifyQuotaExhaustion(account);
		if (exclusion) {
			exhausted.push({
				name: account.name,
				reason: exclusion.reason,
				resetMs: exclusion.resetMs,
			});
			continue;
		}

		if (!account.usageData) {
			excluded.push({
				name: account.name,
				reason: "no_usage_data",
				resetMs: null,
			});
			continue;
		}

		const extracted =
			window === "five_hour"
				? extractFiveHour(account.usageData)
				: extractSevenDay(account.usageData);

		if (extracted === null) {
			fallback.push({ name: account.name, provider: account.provider });
			continue;
		}

		if (extracted.pct === null) {
			excluded.push({
				name: account.name,
				reason: "no_usage_data",
				resetMs: extracted.resetMs,
			});
			continue;
		}

		contributing.push({
			accountId: account.id,
			name: account.name,
			pct: extracted.pct,
			resetMs: extracted.resetMs,
		});
		predictions.set(
			account.id,
			window === "five_hour"
				? account.prediction?.fiveHour
				: account.prediction?.sevenDay,
		);
		observedAt.set(account.id, usageObservedAtMs(account.usageAsOfIso));
	}

	const activeAverage =
		contributing.length === 0
			? null
			: contributing.reduce((sum, c) => sum + c.pct, 0) / contributing.length;
	const capacityCount = contributing.length + exhausted.length;
	const average =
		capacityCount === 0
			? null
			: (contributing.reduce((sum, c) => sum + c.pct, 0) +
					exhausted.length * 100) /
				capacityCount;

	let worst: { name: string; pct: number } | null = null;
	for (const c of contributing) {
		if (worst === null || c.pct > worst.pct) {
			worst = { name: c.name, pct: c.pct };
		}
	}
	for (const e of exhausted) {
		if (worst === null || 100 > worst.pct) {
			worst = { name: e.name, pct: 100 };
		}
	}

	const resetCandidates = [...contributing, ...exhausted].filter(
		(
			c,
		): c is (PoolUsageContribution | PoolUsageExclusion) & {
			resetMs: number;
		} => c.resetMs != null && c.resetMs > now,
	);
	const earliestResetMs =
		resetCandidates.length === 0
			? null
			: Math.min(...resetCandidates.map((c) => c.resetMs));
	const earliestResetAccountName =
		earliestResetMs === null
			? null
			: (resetCandidates.find((c) => c.resetMs === earliestResetMs)?.name ??
				null);

	// At-risk projection, via the shared estimator: regression-backed when the
	// server prediction for this window is trustworthy, lifetime-average
	// otherwise. That makes this list agree with the per-account progress bars
	// and the forecast lines, which already prefer the regression.
	const atRisk: PoolUsageProjection[] = [];
	for (const c of contributing) {
		if (c.resetMs == null) continue;
		const estimate = estimateWindowExhaustion(
			{
				utilizationPct: c.pct,
				resetsAtMs: c.resetMs,
				windowStartMs: computeWindowStartMs(c.resetMs, window),
				prediction: predictions.get(c.accountId),
				lifetimeConfidence: weeklyLifetimeConfidence(window),
				observedAtMs: observedAt.get(c.accountId) ?? null,
			},
			now,
		);
		if (estimate.exhaustsAtMs == null) continue;
		if (estimate.exhaustsAtMs >= c.resetMs) continue;
		atRisk.push({
			accountId: c.accountId,
			name: c.name,
			pct: c.pct,
			resetMs: c.resetMs,
			exhaustsAtMs: estimate.exhaustsAtMs,
			timeToExhaustMs: estimate.exhaustsAtMs - now,
			remainingMs: c.resetMs - now,
		});
	}

	const familyWeekly =
		window === "seven_day" ? computeFamilyWeeklyUsage(accounts, now) : [];

	return {
		average,
		activeAverage,
		worst,
		contributing,
		exhausted,
		excluded,
		fallback,
		earliestResetMs,
		earliestResetAccountName,
		atRisk,
		familyWeekly,
	};
}
