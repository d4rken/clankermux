import type { AnthropicUsageData, FullUsageData } from "@clankermux/types";
import {
	isAnthropicUsageShape,
	normalizeAnthropicUsage,
} from "./usage-normalizer";

/**
 * Read the two ACCOUNT-WIDE quota windows (rolling 5-hour, rolling weekly) out
 * of whatever shape a provider's usage payload happens to have.
 *
 * These used to live in the dashboard (`lib/pool-usage.ts`), which was fine
 * while the only consumer was the browser. `GET /api/runway` computes the same
 * projection server-side and `@clankermux/http-api` cannot import from
 * `dashboard-web`, so they live here: everything they need is
 * `@clankermux/types` plus core's own Anthropic usage normalizer.
 *
 * Both extractors return `null` when the payload is a shape they do not
 * recognise (the caller decides whether that is "unmetered" or "unreadable"),
 * and `{ pct: null }` when the shape IS recognised but carries no percentage.
 * Those two are deliberately different answers.
 */

/**
 * Providers whose accounts report an account-wide 5-hour quota window. A
 * provider in NEITHER set has no account-wide quota window at all and must not
 * be treated as an unreadable account.
 */
export const FIVE_HOUR_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"codex",
	"alibaba-coding-plan",
	"zai",
]);

/** Providers whose accounts report an account-wide weekly quota window. */
export const SEVEN_DAY_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set([
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
