// RELATIVE imports, never the "@clankermux/core" barrel. This module now lives
// inside core, and a module importing its own package entry is a cycle: the
// barrel would have to finish evaluating to satisfy an import that the barrel
// itself is in the middle of pulling in. Every non-test module in this package
// imports its siblings by path for that reason.

// `AccountResponse` is named outright here, which is the first time core does
// so. `api-key-runway.ts` deliberately avoids it, shaping `RunwayAccountSource`
// so the response type structurally satisfies it instead. That convention is
// right for a module that merely needs a few fields; this one is ABOUT the
// account response — it reads usage payloads, predictions, pause state and
// rate-limit columns — and a parallel structural mirror of it would be exactly
// the duplicated definition this move exists to remove. Direction is legal:
// core already depends on types, and types must never depend on core.
import type {
	AccountResponse,
	AnthropicUsageData,
	FullUsageData,
	UsageBurnAnchor,
	UsagePrediction,
} from "@clankermux/types";
import { estimateWindowExhaustion } from "./capacity-runway";
import {
	usageObservedAtMs,
	weeklyLifetimeConfidence,
	windowBurnAnchor,
} from "./lifetime-confidence";
import type { ModelFamily } from "./model-mappings";
import { compareServableClasses, servableClassFor } from "./pool-classes";
import type { ScopedFamilyLimit } from "./scoped-limits";
import { computeWindowStartMs } from "./throttle-utils";
import { normalizeAnthropicUsage } from "./usage-normalizer";
import {
	extractFiveHour,
	extractSevenDay,
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	isAnthropicStyleShape,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
} from "./usage-window-extract";

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
	/**
	 * Stable join key. Present so a consumer can match an exclusion to an
	 * account without going through `name`, which is user-set and need not be
	 * unique — two identically-named accounts in different servable classes
	 * otherwise put a row in the wrong class's breakdown.
	 */
	accountId: string;
	name: string;
	reason: ExcludedReason;
	resetMs: number | null;
}

export interface PoolUsageFallback {
	/**
	 * Stable join key, for the same reason the exclusion rows carry one: a
	 * consumer deduping these across both windows has to key on the account, not
	 * on `name`, which is user-set and need not be unique.
	 */
	accountId: string;
	name: string;
	provider: string;
}

/** One account's row in a class's distribution strip. */
export interface PoolAccountBar {
	accountId: string;
	name: string;
	provider: string;
	/**
	 * Utilization, or null when there is no reading.
	 *
	 * Null is NOT zero and must never be drawn as an empty bar: "nobody has
	 * polled this account" and "this account is untouched" are opposite facts,
	 * and the second one is the reassuring one.
	 */
	pct: number | null;
	state: "reporting" | "exhausted" | "unknown";
	reason: ExcludedReason | null;
	resetMs: number | null;
}

/**
 * One pool of accounts that can actually cover for each other.
 *
 * See lib/pool-classes: a Claude request cannot be served by a Codex account, so
 * a figure averaged across both describes no decision anyone makes.
 */
export interface ServableClassPool {
	classId: string;
	label: string;
	/** Ascending by utilization, unknowns last. */
	accounts: PoolAccountBar[];
	/**
	 * The account with the most headroom, and the real constraint on this class.
	 *
	 * Routing picks ONE account, so what matters is whether any account still has
	 * room — not the mean, which mixes a spent account with a fresh one and
	 * describes neither. Measured over 45 days of production data this is also
	 * far the steadier statistic: it climbed 0% to 25% monotonically across a
	 * week while the runway it sits beside swung by a day between polls.
	 */
	leastUsed: PoolUsageContribution | null;
	/** The most-spent account, for the distribution's other end. */
	worst: PoolUsageContribution | null;
	reportingCount: number;
	/** Reporting + exhausted: accounts that could serve if they had room. */
	capacityCount: number;
	/** Capacity + unknown: every account eligible for this window. */
	eligibleTotal: number;
	/**
	 * One account or fewer can serve this class, so a single failure stops it.
	 *
	 * This is the condition behind every hard stop in the production sample that
	 * motivated the redesign, and no pooled average can express it: the pool read
	 * comfortable throughout because five healthy accounts of another class were
	 * averaged in.
	 */
	singlePointOfFailure: boolean;
	earliestResetMs: number | null;
	earliestResetAccountName: string | null;
	/**
	 * The same account as {@link earliestResetAccountName}, by id.
	 *
	 * Carried alongside the name because a published surface needs a JOIN KEY:
	 * `/public/v1/pacing` may not re-serve account names (they live once, on the
	 * accounts resource), so a consumer resolves this id against that list. The
	 * name stays for the dashboard, which renders it directly.
	 */
	earliestResetAccountId: string | null;
}

/**
 * Percent at/above which a per-model-family weekly window is surfaced as
 * "elevated" in the pool view (worth a callout even when account-wide capacity
 * is healthy). Inline named constant — NO env var / feature gate.
 */
export const FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT = 80;

export type OutlookTone = "neutral" | "success" | "warning" | "destructive";

export interface Outlook {
	label: string;
	tone: OutlookTone;
}

/**
 * How many accounts are projected to run out before this window resets, over
 * how many could.
 *
 * The two pages disagreed here too: the Overview badge counted
 * `atRisk + exhausted`, the Usage alert counted `atRisk` alone. Same window,
 * same instant, two different numerators for "will run out". Exhausted accounts
 * belong in it — an account already at 100% has run out, and excluding it makes
 * the count shrink at the moment the pool got worse.
 *
 * Only quota exhaustion OF THIS WINDOW counts, which is why the window has to be
 * passed. `exhausted` is a mixed list: it also holds paused accounts, accounts
 * in a cooldown, accounts whose token expired and accounts a usage-429 hid. Not
 * one of those is "projected to run out before reset" — a paused account is a
 * choice someone made, and the badge claimed it as a forecast.
 *
 * `spent` is reported ALONGSIDE the total rather than folded silently into it,
 * because callers render the count in a sentence and the two halves need
 * different verbs. An account at 100% is not "projected" to reach it; it is
 * there. With `spent > 0` a caller that says only "projected" describes
 * measured, already-lost capacity as a forecast — which also understates it,
 * since a forecast invites the reader to think it might not happen.
 */
export function willRunOutCount(
	result: PoolUsageResult,
	window: PoolWindow,
): {
	willRunOut: number;
	capacity: number;
	/** Of `willRunOut`, how many are ALREADY at 100% rather than projected. */
	spent: number;
} {
	const spentOnThisWindow = result.exhausted.filter(
		(e) => e.reason === `${window}_exhausted`,
	).length;
	return {
		willRunOut: result.atRisk.length + spentOnThisWindow,
		capacity: result.contributing.length + spentOnThisWindow,
		spent: spentOnThisWindow,
	};
}

/**
 * The verdict for ONE servable class, tinting the figure that class shows.
 *
 * Keyed on the least-used account, because that is the number on the card. A
 * verdict computed from the whole pool's average would tint a figure it does not
 * describe — and on a per-class card it would paint every class the same colour
 * regardless of which one is actually in trouble.
 */
export function poolClassOutlook(pool: ServableClassPool): Outlook {
	if (pool.leastUsed == null) {
		return { label: "No reading", tone: "neutral" };
	}
	const pct = pool.leastUsed.pct;
	if (pct >= 100) return { label: "Exhausted", tone: "destructive" };
	if (pct >= 80) return { label: "High usage", tone: "destructive" };
	if (pct >= 60) return { label: "Watch", tone: "warning" };
	// An account nobody has a reading for is not evidence of health, and it is
	// omitted from every figure above. Same rule as the pool-wide outlook.
	if (pool.eligibleTotal > pool.capacityCount) {
		return { label: "Watch", tone: "warning" };
	}
	// "On pace" claims a projection exists, so it may only be said when every
	// reporting account actually has a reset to project against. Without one
	// there is nothing to be on pace FOR, and the honest word is the weaker
	// "Low usage" — same distinction the pool-wide outlook draws.
	const everyReportingAccountCanBeProjected = pool.accounts.every(
		(account) => account.state !== "reporting" || account.resetMs != null,
	);
	return everyReportingAccountCanBeProjected
		? { label: "On pace", tone: "success" }
		: { label: "Low usage", tone: "success" };
}

/**
 * Narrow a whole-pool result to one servable class.
 *
 * The per-class cards render the shared breakdown and the family badge, both of
 * which take a `PoolUsageResult`. Handing them the pool-wide one made every card
 * show every account — a Codex card claiming a Claude model family was
 * exhausted, and a one-account card whose popover listed six.
 *
 * Membership is by account id throughout — the exclusion lists and the family
 * rows both carry `accountId` for exactly this reason. Matching on name would
 * misfile a row whenever two accounts in different classes share a name, and
 * names are user-set.
 */
export function scopeResultToClass(
	result: PoolUsageResult,
	pool: ServableClassPool,
): PoolUsageResult {
	const ids = new Set(pool.accounts.map((a) => a.accountId));
	const contributing = result.contributing.filter((c) => ids.has(c.accountId));
	const exhausted = result.exhausted.filter((e) => ids.has(e.accountId));
	const excluded = result.excluded.filter((e) => ids.has(e.accountId));
	const familyWeekly = result.familyWeekly
		.map((family) => ({
			...family,
			accounts: family.accounts.filter((a) => ids.has(a.accountId)),
		}))
		// A family none of this class's accounts reports is not this class's
		// concern. Dropping it is what stops a GPT card announcing a Fable limit.
		.filter((family) => family.accounts.length > 0);

	return {
		...result,
		contributing,
		exhausted,
		excluded,
		fallback: [],
		atRisk: result.atRisk.filter((a) => ids.has(a.accountId)),
		familyWeekly,
		earliestResetMs: pool.earliestResetMs,
		earliestResetAccountName: pool.earliestResetAccountName,
		classes: [pool],
		bindingClass: pool,
	};
}

/** One account's contribution to a per-family weekly bucket. */
export interface FamilyWeeklyAccountUsage {
	/** Stable join key, for the same reason the exclusion rows carry one. */
	accountId: string;
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

/**
 * One window's read of the pool.
 *
 * There is deliberately NO pool-wide average here, and the omission is the
 * point. A Claude request cannot be served by a Codex account, so a figure
 * averaged across both describes no decision anyone makes — and even inside one
 * servable class, routing picks ONE account, so a mean of a spent account and a
 * fresh one describes neither. {@link classes} is the answer to both: per
 * class, and headlined by the account with the most room. What the average used
 * to be read for lives on {@link ServableClassPool.leastUsed} and
 * {@link ServableClassPool.worst}.
 *
 * `contributing` / `exhausted` / `excluded` are the flat VIEWS over the same
 * verdicts `classes` groups — see {@link projectAccountBars}. They are a
 * projection of `classes.flatMap(c => c.accounts)`, not a parallel computation,
 * so the two cannot disagree about an account.
 */
export interface PoolUsageResult {
	contributing: PoolUsageContribution[];
	exhausted: PoolUsageExclusion[];
	excluded: PoolUsageExclusion[];
	fallback: PoolUsageFallback[];
	earliestResetMs: number | null;
	earliestResetAccountName: string | null;
	atRisk: PoolUsageProjection[];
	familyWeekly: FamilyWeeklyUsage[];
	/** One pool per group of accounts that can cover for each other. */
	classes: ServableClassPool[];
	/** The tightest class — the one that will stop you first. */
	bindingClass: ServableClassPool | null;
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

/**
 * Whether an account is spent, and on which window.
 *
 * WHICH accounts this excludes does not depend on `window` — an account spent on
 * either window cannot serve a request right now, and that is the semantics
 * every surface wants. The window decides only which reason is REPORTED when the
 * account is spent on both: the window being computed is tested first, so an
 * account out of both reads "weekly spent" on the weekly surfaces and
 * "waiting on 5h" on the 5-hour ones. Reporting the 5-hour reason on a weekly
 * panel told the reader to wait for a lift that would not restore weekly
 * capacity.
 */
function classifyQuotaExhaustion(
	account: AccountResponse,
	window: PoolWindow,
): { reason: ExcludedReason; resetMs: number | null } | null {
	if (!account.usageData) return null;

	const fiveHour = extractFiveHour(account.usageData);
	const sevenDay = extractSevenDay(account.usageData);
	const spentFiveHour =
		fiveHour?.pct != null && fiveHour.pct >= 100
			? ({ reason: "five_hour_exhausted", resetMs: fiveHour.resetMs } as const)
			: null;
	const spentSevenDay =
		sevenDay?.pct != null && sevenDay.pct >= 100
			? ({ reason: "seven_day_exhausted", resetMs: sevenDay.resetMs } as const)
			: null;

	return window === "seven_day"
		? (spentSevenDay ?? spentFiveHour)
		: (spentFiveHour ?? spentSevenDay);
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

/**
 * The scoped limit that BINDS out of several the same account reports for one
 * family: highest percent, and on a tie the one that clears first.
 *
 * One account can report two scoped windows that collapse onto one family —
 * getModelFamily() maps Mythos-class display names onto "fable" — and every
 * surface that shows "this account's Fable number" has to name the same one.
 * Shared by the family aggregate here and the family forecast line
 * (usage-forecast.ts), and mirrored by the recorded history's SQL tie-break,
 * so the solid line, the dashed line and the popover cannot disagree.
 */
export function pickBindingScopedLimit(
	limits: ScopedFamilyLimit[],
): ScopedFamilyLimit | null {
	let binding: ScopedFamilyLimit | null = null;
	for (const limit of limits) {
		if (
			binding === null ||
			limit.percent > binding.percent ||
			(limit.percent === binding.percent &&
				limit.resetsAtMs < binding.resetsAtMs)
		) {
			binding = limit;
		}
	}
	return binding;
}

/** A model family the pool is currently reporting a scoped weekly window for. */
export interface LiveScopedFamily {
	family: ModelFamily;
	/** Anthropic's own scope label for the family, e.g. "Fable". */
	displayName: string;
}

/**
 * Every family ANY account currently reports a scoped weekly window for.
 *
 * Deliberately unfiltered, unlike {@link computeFamilyWeeklyUsage}: this
 * decides whether a family's CHART exists, and a paused or spent account's
 * recorded history is exactly what someone opens that chart to look at. The
 * exclusion rules belong to the aggregate number, not to the axis.
 */
export function listLiveScopedFamilies(
	accounts: readonly { usageData: FullUsageData | null }[],
	now: number,
): LiveScopedFamily[] {
	const byFamily = new Map<ModelFamily, string>();
	for (const account of accounts) {
		if (!account.usageData) continue;
		if (!isAnthropicStyleShape(account.usageData)) continue;
		const scoped = normalizeAnthropicUsage(
			account.usageData as AnthropicUsageData,
			now,
		).weeklyScoped;
		for (const limit of scoped) {
			if (!byFamily.has(limit.family)) {
				byFamily.set(limit.family, limit.displayName);
			}
		}
	}
	return [...byFamily].map(([family, displayName]) => ({
		family,
		displayName,
	}));
}

/** One model family's weekly cap, with the accounts that could not report it. */
export interface FamilyRow {
	family: ModelFamily;
	/** Anthropic's own scope label, e.g. "Fable". */
	displayName: string;
	/**
	 * The aggregate over accounts that can actually serve this family, or null
	 * when every account reporting the family is unavailable.
	 */
	usage: FamilyWeeklyUsage | null;
	/** Accounts contributing to `usage`. */
	reportingCount: number;
	/**
	 * Accounts that report this family's scoped window but are paused, cooling
	 * down, token-expired, hidden by a usage-429, or out of their account-wide
	 * quota.
	 *
	 * Stated rather than dropped: {@link computeFamilyWeeklyUsage} excludes them
	 * for good reason (an account that cannot serve anything must not inflate a
	 * family's worst percentage), but silently excluding them makes a family
	 * reported by ONE paused account vanish from the card entirely — the reader
	 * cannot tell "no such limit" from "nobody who has it can be reached".
	 */
	unavailableReporters: number;
}

/**
 * Every model family currently reporting a weekly cap, with its aggregate.
 *
 * LIVE discovery only, unlike the Usage page's charts: this card describes the
 * pool right now, and a family that no live account reports has no current cap
 * to state. The recorded-history union belongs to the charts, whose whole
 * purpose is showing a series that outlives the reading.
 *
 * Codex's synthetic per-model weekly windows do NOT appear here. They carry
 * display names that resolve to no Claude family, so `normalizeAnthropicUsage`
 * drops them, and this card is family-resolved by construction. They stay on the
 * Accounts tab and in Account Utilization, which read them through
 * `lib/secondary-limits.ts` instead.
 */
export function listFamilyRows(
	accounts: AccountResponse[],
	now: number,
): FamilyRow[] {
	const usageByFamily = new Map(
		computeFamilyWeeklyUsage(accounts, now).map((u) => [u.family, u]),
	);

	// Which families each UNAVAILABLE account reports, so the card can say a
	// family exists but nobody who has it can serve it.
	const unavailableByFamily = new Map<ModelFamily, number>();
	for (const account of accounts) {
		if (!account.usageData) continue;
		if (!isAnthropicStyleShape(account.usageData)) continue;
		const unavailable =
			classifyExclusion(account, now) !== null ||
			classifyQuotaExhaustion(account, "seven_day") !== null;
		if (!unavailable) continue;
		const scoped = normalizeAnthropicUsage(
			account.usageData as AnthropicUsageData,
			now,
		).weeklyScoped;
		// One account reporting two windows that fold onto one family counts once.
		for (const family of new Set(scoped.map((limit) => limit.family))) {
			unavailableByFamily.set(
				family,
				(unavailableByFamily.get(family) ?? 0) + 1,
			);
		}
	}

	const rows: FamilyRow[] = [];
	for (const live of listLiveScopedFamilies(accounts, now)) {
		const usage = usageByFamily.get(live.family) ?? null;
		rows.push({
			family: live.family,
			displayName: live.displayName,
			usage,
			reportingCount: usage?.accounts.length ?? 0,
			unavailableReporters: unavailableByFamily.get(live.family) ?? 0,
		});
	}
	// Worst first, and families nobody can report last: an unstated cap is not
	// evidence of a problem, so it must not head the list.
	rows.sort((a, b) => (b.usage?.worstPct ?? -1) - (a.usage?.worstPct ?? -1));
	return rows;
}

/**
 * Union of the families seen live and the families with recorded history,
 * sorted by family.
 *
 * Both sources are needed. Live-only discovery makes a panel disappear at
 * every rollover — `normalizeWeeklyScoped` drops a limit the moment its reset
 * passes, so between the reset and the next successful poll no account reports
 * the family at all — and it takes the panel away entirely whenever the
 * accounts read fails. History-only discovery cannot show a family whose first
 * snapshot has not been written yet. The live label wins where both have one:
 * it names the model generation currently in force.
 */
export function mergeScopedFamilies(
	live: LiveScopedFamily[],
	recorded: Array<{ family: string; displayName: string }>,
): LiveScopedFamily[] {
	const merged = new Map<string, string>();
	for (const entry of recorded) merged.set(entry.family, entry.displayName);
	for (const entry of live) merged.set(entry.family, entry.displayName);
	return [...merged]
		.map(([family, displayName]) => ({
			family: family as ModelFamily,
			displayName,
		}))
		.sort((a, b) => a.family.localeCompare(b.family));
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
		// The weekly window: this aggregate is about weekly family caps, and the
		// reason is unused here — only whether the account is spent at all.
		if (classifyQuotaExhaustion(account, "seven_day") !== null) continue;
		if (!isAnthropicStyleShape(account.usageData)) continue;

		const scoped = normalizeAnthropicUsage(
			account.usageData as AnthropicUsageData,
			now,
		).weeklyScoped;
		// One reading time for every scoped window this account reports: they all
		// come out of the same `usageData` payload.
		const observedAtMs = usageObservedAtMs(account.usageAsOfIso);

		// Grouped first so the binding window is chosen by one shared rule rather
		// than folded in incrementally — see pickBindingScopedLimit.
		const byFamily = new Map<ModelFamily, ScopedFamilyLimit[]>();
		for (const limit of scoped) {
			const group = byFamily.get(limit.family);
			if (group) group.push(limit);
			else byFamily.set(limit.family, [limit]);
		}

		for (const [family, limits] of byFamily) {
			const binding = pickBindingScopedLimit(limits);
			if (binding === null) continue;
			let bucket = buckets.get(family);
			if (bucket === undefined) {
				bucket = { label: limits[0].displayName, accounts: new Map() };
				buckets.set(family, bucket);
			}
			// The PROJECTION is folded across every window in this family, not taken
			// from the binding one. Percent alone does not decide risk when the resets
			// differ: 90% clearing in 12h is not projected to exhaust, while 80%
			// clearing in 3d is projected to exhaust in 1d — and both can fold onto
			// `fable`. Keeping only the binding window's projection would report that
			// account as not at risk. The account runs out of the family when its
			// FIRST constituent window does, so take the earliest.
			let exhaustsAtMs: number | null = null;
			for (const limit of limits) {
				exhaustsAtMs = soonerOf(
					exhaustsAtMs,
					projectFamilyExhaustion(
						limit.percent,
						limit.resetsAtMs,
						observedAtMs,
						now,
					),
				);
			}
			bucket.accounts.set(account.id, {
				accountId: account.id,
				name: account.name,
				pct: binding.percent,
				resetMs: binding.resetsAtMs,
				exhaustsAtMs,
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
	const fallback: PoolUsageFallback[] = [];
	// Captured while iterating the accounts so the at-risk projection below can
	// reach each contribution's server-side prediction. Keyed by account id —
	// NEVER by name, which is user-set and need not be unique.
	const predictions = new Map<string, UsagePrediction | undefined>();
	// Likewise for WHEN each contribution's reading was sampled: the weekly
	// window's full-confidence estimate anchors its ETA there instead of at
	// `now`, so a list rebuilt on an unchanged poll reports the same instants.
	const observedAt = new Map<string, number | null>();
	// And the server-detected mid-window revision (gift reset / applied credit)
	// for this window, which re-anchors the lifetime slope's origin.
	const anchors = new Map<string, UsageBurnAnchor | null>();

	// Every eligible account with the verdict this pass reached about it, in one
	// place, and the ONLY place a verdict is recorded. The flat
	// contributing/exhausted/excluded lists are projected off this afterwards
	// rather than pushed to alongside it: while both were built in the loop, one
	// account's state was written twice, and nothing stopped a later edit from
	// updating one and not the other.
	const accountBars: PoolAccountBar[] = [];

	const eligible = eligibleProvidersFor(window);

	for (const account of accounts) {
		if (!eligible.has(account.provider)) {
			fallback.push({
				accountId: account.id,
				name: account.name,
				provider: account.provider,
			});
			continue;
		}

		const exclusion =
			classifyExclusion(account, now) ??
			classifyQuotaExhaustion(account, window);
		if (exclusion) {
			accountBars.push({
				accountId: account.id,
				name: account.name,
				provider: account.provider,
				pct: null,
				state: "exhausted",
				reason: exclusion.reason,
				resetMs: exclusion.resetMs,
			});
			continue;
		}

		if (!account.usageData) {
			accountBars.push({
				accountId: account.id,
				name: account.name,
				provider: account.provider,
				pct: null,
				state: "unknown",
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
			fallback.push({
				accountId: account.id,
				name: account.name,
				provider: account.provider,
			});
			continue;
		}

		if (extracted.pct === null) {
			accountBars.push({
				accountId: account.id,
				name: account.name,
				provider: account.provider,
				pct: null,
				state: "unknown",
				reason: "no_usage_data",
				resetMs: extracted.resetMs,
			});
			continue;
		}

		accountBars.push({
			accountId: account.id,
			name: account.name,
			provider: account.provider,
			pct: extracted.pct,
			state: "reporting",
			reason: null,
			resetMs: extracted.resetMs,
		});
		predictions.set(
			account.id,
			window === "five_hour"
				? account.prediction?.fiveHour
				: account.prediction?.sevenDay,
		);
		observedAt.set(account.id, usageObservedAtMs(account.usageAsOfIso));
		anchors.set(account.id, windowBurnAnchor(account.burnAnchors, window));
	}

	const { contributing, exhausted, excluded } = projectAccountBars(accountBars);

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
				anchor: anchors.get(c.accountId) ?? null,
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

	const classes = groupIntoServableClasses(accountBars, now);

	return {
		contributing,
		exhausted,
		excluded,
		fallback,
		earliestResetMs,
		earliestResetAccountName,
		atRisk,
		familyWeekly,
		classes,
		bindingClass: pickBindingClass(classes),
	};
}

/**
 * The flat lists, as VIEWS over the per-account verdicts.
 *
 * One account, one verdict, projected three ways. While the lists were pushed
 * to inside the classification loop they were a second recording of the same
 * decision, and a bar could say "exhausted" while the flat list said
 * "contributing" if either push site was edited alone. Derived here, that
 * disagreement is unrepresentable.
 *
 * A `reporting` bar always carries a percentage — that is what makes it
 * reporting — but the type does not know it, so the narrowing is written out
 * rather than cast. A bar that somehow lacked one would be counted as unknown,
 * which is the honest reading of a missing number and never a 0%.
 */
function projectAccountBars(bars: PoolAccountBar[]): {
	contributing: PoolUsageContribution[];
	exhausted: PoolUsageExclusion[];
	excluded: PoolUsageExclusion[];
} {
	const contributing: PoolUsageContribution[] = [];
	const exhausted: PoolUsageExclusion[] = [];
	const excluded: PoolUsageExclusion[] = [];
	for (const bar of bars) {
		if (bar.state === "reporting" && bar.pct !== null) {
			contributing.push({
				accountId: bar.accountId,
				name: bar.name,
				pct: bar.pct,
				resetMs: bar.resetMs,
			});
			continue;
		}
		const exclusion: PoolUsageExclusion = {
			accountId: bar.accountId,
			name: bar.name,
			reason: bar.reason ?? "no_usage_data",
			resetMs: bar.resetMs,
		};
		if (bar.state === "exhausted") exhausted.push(exclusion);
		else excluded.push(exclusion);
	}
	return { contributing, exhausted, excluded };
}

/** Group the per-account verdicts into pools that can cover for each other. */
function groupIntoServableClasses(
	bars: PoolAccountBar[],
	now: number,
): ServableClassPool[] {
	const byClass = new Map<string, { label: string; bars: PoolAccountBar[] }>();
	for (const bar of bars) {
		const servable = servableClassFor(bar.provider);
		const bucket = byClass.get(servable.classId);
		if (bucket) bucket.bars.push(bar);
		else byClass.set(servable.classId, { label: servable.label, bars: [bar] });
	}

	const pools: ServableClassPool[] = [];
	for (const [classId, { label, bars: classBars }] of byClass) {
		// Ascending by utilization with unknowns last: the strip reads left to
		// right from most headroom to least, and an account with no reading
		// belongs at the end rather than sorted as if it were at 0%.
		const sorted = [...classBars].sort((a, b) => {
			if (a.pct == null && b.pct == null) return a.name.localeCompare(b.name);
			if (a.pct == null) return 1;
			if (b.pct == null) return -1;
			return a.pct - b.pct;
		});

		let leastUsed: PoolUsageContribution | null = null;
		let classWorst: PoolUsageContribution | null = null;
		let reportingCount = 0;
		let exhaustedCount = 0;
		let unknownCount = 0;
		let earliestResetMs: number | null = null;
		let earliestResetAccountName: string | null = null;
		let earliestResetAccountId: string | null = null;

		for (const bar of sorted) {
			if (bar.state === "reporting" && bar.pct != null) {
				reportingCount++;
				const entry: PoolUsageContribution = {
					accountId: bar.accountId,
					name: bar.name,
					pct: bar.pct,
					resetMs: bar.resetMs,
				};
				if (leastUsed === null || bar.pct < leastUsed.pct) leastUsed = entry;
				if (classWorst === null || bar.pct > classWorst.pct) classWorst = entry;
			} else if (bar.state === "exhausted") {
				exhaustedCount++;
				// A spent account is the worst possible reading, and must be able to
				// take that slot: leaving it out would let the strip's high end be a
				// reporting account at 80% while a sibling sits dead at 100%.
				if (classWorst === null || classWorst.pct < 100) {
					classWorst = {
						accountId: bar.accountId,
						name: bar.name,
						pct: 100,
						resetMs: bar.resetMs,
					};
				}
			} else {
				unknownCount++;
			}
			// Soonest still-future reset in this class, over accounts that have one.
			// A reset in the PAST is a stale reading, not an imminent recovery: the
			// old `> 0` test admitted it, and the class then advertised a lift that
			// had already come and gone as the next one. The pool-wide
			// `earliestResetMs` has always used `> now`; this makes the per-class
			// figure agree with it.
			if (
				bar.resetMs != null &&
				bar.resetMs > now &&
				(earliestResetMs === null || bar.resetMs < earliestResetMs)
			) {
				earliestResetMs = bar.resetMs;
				earliestResetAccountName = bar.name;
				earliestResetAccountId = bar.accountId;
			}
		}

		const capacityCount = reportingCount + exhaustedCount;
		pools.push({
			classId,
			label,
			accounts: sorted,
			leastUsed,
			worst: classWorst,
			reportingCount,
			capacityCount,
			eligibleTotal: capacityCount + unknownCount,
			singlePointOfFailure:
				capacityCount <= 1 && capacityCount + unknownCount > 0,
			earliestResetMs,
			earliestResetAccountName,
			earliestResetAccountId,
		});
	}

	pools.sort((a, b) => compareServableClasses(a.classId, b.classId));
	return pools;
}

/**
 * The class that constrains the pool: the one whose MOST-IDLE account is the
 * most spent.
 *
 * Within a class, any account with headroom can serve the request, so the
 * class's least-used account is its real limit. Across classes the constraint is
 * the tightest class, because the classes cannot cover for each other — a global
 * minimum would be the most optimistic number available and would hide a Claude
 * pool at 90% behind an idle account of some other class.
 *
 * Null when no class has a reporting account. Callers must render their explicit
 * unavailable state for that, never "100% left".
 */
function pickBindingClass(
	classes: ServableClassPool[],
): ServableClassPool | null {
	let binding: ServableClassPool | null = null;
	for (const pool of classes) {
		if (pool.leastUsed == null) continue;
		if (
			binding?.leastUsed == null ||
			pool.leastUsed.pct > binding.leastUsed.pct
		) {
			binding = pool;
		}
	}
	return binding;
}
