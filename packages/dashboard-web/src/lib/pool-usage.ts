import type { ModelFamily } from "@clankermux/core";
import {
	computeWindowStartMs,
	isAnthropicUsageShape,
	normalizeAnthropicUsage,
} from "@clankermux/core";
import type {
	AccountResponse,
	AnthropicUsageData,
	FullUsageData,
} from "@clankermux/types";

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
}

/**
 * Aggregated per-model-family weekly usage across the pool. A family limit is
 * independent, actionable info even when the account-wide weekly window is
 * healthy (or exhausted), so this is computed separately from the pool average.
 */
export interface FamilyWeeklyUsage {
	family: ModelFamily;
	/** Anthropic display name for the family, e.g. "Fable". */
	label: string;
	/** Max pct across contributing accounts for this family. */
	worstPct: number;
	/** The account driving worstPct. */
	worstAccountName: string;
	/** Soonest reset across this family's accounts. */
	earliestResetMs: number;
	/** worstPct >= FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT. */
	elevated: boolean;
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

const FIVE_HOUR_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"codex",
	"alibaba-coding-plan",
	"zai",
]);

const SEVEN_DAY_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"codex",
	"alibaba-coding-plan",
]);

export function normalizeResetMs(
	value: string | number | null | undefined,
): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

export function isAlibabaShape(
	usageData: FullUsageData | null | undefined,
): boolean {
	return usageData != null && "five_hour" in usageData && "weekly" in usageData;
}

export function isZaiShape(
	usageData: FullUsageData | null | undefined,
): boolean {
	return (
		usageData != null &&
		("time_limit" in usageData || "tokens_limit" in usageData)
	);
}

export function isAnthropicStyleShape(
	usageData: FullUsageData | null | undefined,
): boolean {
	if (usageData == null) return false;
	if (isAlibabaShape(usageData)) return false;
	if (isZaiShape(usageData)) return false;
	// Flat five_hour/seven_day OR a non-empty `limits[]` (upstream is dropping the
	// flat keys). Alibaba/Zai were already excluded above, so a bare `limits[]`
	// array here is unambiguously an Anthropic-style payload.
	return isAnthropicUsageShape(usageData as AnthropicUsageData);
}

export interface ExtractedValue {
	pct: number | null;
	resetMs: number | null;
}

export function extractFiveHour(
	usageData: FullUsageData,
): ExtractedValue | null {
	if (isAlibabaShape(usageData)) {
		const data = usageData as {
			five_hour: { percentUsed: number | null; resetAt: number | null };
		};
		return {
			pct: data.five_hour?.percentUsed ?? null,
			resetMs: normalizeResetMs(data.five_hour?.resetAt ?? null),
		};
	}
	if (isZaiShape(usageData)) {
		const data = usageData as {
			tokens_limit?: {
				percentage: number | null;
				resetAt: number | null;
			} | null;
		};
		const tokens = data.tokens_limit;
		if (!tokens) {
			return { pct: null, resetMs: null };
		}
		return {
			pct: tokens.percentage ?? null,
			resetMs: normalizeResetMs(tokens.resetAt ?? null),
		};
	}
	if (isAnthropicStyleShape(usageData)) {
		// Read the session (5h) window via the normalizer so a `limits[]`-only
		// payload resolves too. For a flat payload this reads the same
		// five_hour.utilization / resets_at the direct field access did. `now`
		// only gates scoped windows (unused here), so a constant is fine.
		const session = normalizeAnthropicUsage(
			usageData as AnthropicUsageData,
			Date.now(),
		).session;
		return {
			pct: session?.utilization ?? null,
			resetMs: session?.resetMs ?? null,
		};
	}
	return null;
}

export function extractSevenDay(
	usageData: FullUsageData,
): ExtractedValue | null {
	if (isAlibabaShape(usageData)) {
		const data = usageData as {
			weekly: { percentUsed: number | null; resetAt: number | null };
		};
		return {
			pct: data.weekly?.percentUsed ?? null,
			resetMs: normalizeResetMs(data.weekly?.resetAt ?? null),
		};
	}
	if (isZaiShape(usageData)) {
		return null;
	}
	if (isAnthropicStyleShape(usageData)) {
		// Read the account-wide weekly window via the normalizer so a `limits[]`-only
		// payload resolves too. For a flat payload this reads the same
		// seven_day.utilization / resets_at (model-scoped opus/sonnet windows are
		// deliberately NOT counted, matching the old behavior). `now` only gates
		// scoped windows (unused here), so a constant is fine.
		const weeklyAll = normalizeAnthropicUsage(
			usageData as AnthropicUsageData,
			Date.now(),
		).weeklyAll;
		return {
			pct: weeklyAll?.utilization ?? null,
			resetMs: weeklyAll?.resetMs ?? null,
		};
	}
	return null;
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
 * quota is independent of the account-wide 5h/7d windows, so this is NOT gated
 * on quota exhaustion — it's still actionable info when an account-wide window
 * is also spent. Accounts unavailable for structural reasons (paused /
 * rate-limited / token-expired / usage-429-with-no-data) are excluded via
 * {@link classifyExclusion}. Only Anthropic-style payloads carry scoped windows.
 *
 * The per-family scoped windows come from {@link normalizeAnthropicUsage}, which
 * already filters to finite percent, resolvable family, and finite FUTURE reset
 * (stale/rolled-over windows are dropped) — so no staleness re-filtering here.
 */
export function computeFamilyWeeklyUsage(
	accounts: AccountResponse[],
	now: number,
): FamilyWeeklyUsage[] {
	const buckets = new Map<
		ModelFamily,
		{ label: string; accounts: FamilyWeeklyAccountUsage[] }
	>();

	for (const account of accounts) {
		if (classifyExclusion(account, now) !== null) continue;
		if (!account.usageData) continue;
		if (!isAnthropicStyleShape(account.usageData)) continue;

		const scoped = normalizeAnthropicUsage(
			account.usageData as AnthropicUsageData,
			now,
		).weeklyScoped;

		for (const limit of scoped) {
			let bucket = buckets.get(limit.family);
			if (bucket === undefined) {
				bucket = { label: limit.displayName, accounts: [] };
				buckets.set(limit.family, bucket);
			}
			bucket.accounts.push({
				name: account.name,
				pct: limit.percent,
				resetMs: limit.resetsAtMs,
			});
		}
	}

	const result: FamilyWeeklyUsage[] = [];
	for (const [family, bucket] of buckets) {
		const sortedAccounts = [...bucket.accounts].sort((a, b) => b.pct - a.pct);
		const worst = sortedAccounts[0];
		const earliestResetMs = Math.min(...bucket.accounts.map((a) => a.resetMs));
		result.push({
			family,
			label: bucket.label,
			worstPct: worst.pct,
			worstAccountName: worst.name,
			earliestResetMs,
			elevated: worst.pct >= FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT,
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
			name: account.name,
			pct: extracted.pct,
			resetMs: extracted.resetMs,
		});
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

	const atRisk: PoolUsageProjection[] = [];
	for (const c of contributing) {
		if (c.resetMs == null) continue;
		const startMs = computeWindowStartMs(c.resetMs, window);
		if (startMs == null) continue;
		const elapsed = now - startMs;
		const remainingMs = c.resetMs - now;
		if (elapsed <= 0 || remainingMs <= 0) continue;
		const f = c.pct / 100;
		if (f <= 0 || f >= 1) continue;
		const timeToExhaustMs = ((1 - f) / f) * elapsed;
		if (timeToExhaustMs < remainingMs) {
			atRisk.push({
				name: c.name,
				pct: c.pct,
				resetMs: c.resetMs,
				exhaustsAtMs: now + timeToExhaustMs,
				timeToExhaustMs,
				remainingMs,
			});
		}
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
