import { isAnthropicUsageShape } from "@clankermux/core";
import type { AnthropicUsageData, FullUsageData } from "@clankermux/types";

/** localStorage key for the per-account "show secondary limits" preference. */
export const SECONDARY_LIMITS_STORAGE_KEY = "clankermux:show-secondary-limits";

export interface ScopedWeeklyLimit {
	key: string;
	label: string;
	utilization: number;
	resetsAt: string;
}

/**
 * Extract per-model-family weekly quotas (e.g. "Fable") from Anthropic's
 * generic `limits[]` array. Replaces the old `seven_day_opus`/`seven_day_sonnet`
 * flat-field reads, which are always null under Anthropic's current API shape.
 * Does not filter on `is_active` — mirrors the old "any window with data
 * renders" rule; scoped windows are mutual fallbacks so in practice only one
 * is populated at a time.
 *
 * Gated by `isAnthropicUsageShape` (flat five_hour/seven_day OR a non-empty
 * `limits[]`) rather than the old both-flat-keys guard, so a `limits[]`-only
 * payload (upstream is dropping the flat keys) still surfaces its scoped windows.
 */
export function getScopedWeeklyLimits(
	usageData: FullUsageData | null | undefined,
): ScopedWeeklyLimit[] {
	if (
		!isAnthropicUsageShape(usageData as AnthropicUsageData | null | undefined)
	)
		return [];
	const anthropicData = usageData as AnthropicUsageData;
	const results: ScopedWeeklyLimit[] = [];
	for (const entry of anthropicData.limits ?? []) {
		if (entry.kind !== "weekly_scoped") continue;
		if (typeof entry.percent !== "number") continue;
		if (entry.resets_at == null) continue;
		const displayName = entry.scope?.model?.display_name;
		if (!displayName) continue;
		results.push({
			key: entry.scope?.model?.id ?? displayName,
			label: displayName,
			utilization: entry.percent,
			resetsAt: entry.resets_at,
		});
	}
	return results;
}

/**
 * True iff the account's usage data is Anthropic-shaped AND has at least one
 * scoped weekly window that would render. Gates the "Show secondary limits"
 * toggle in AccountListItem.tsx so it's never offered when toggling it would
 * be a no-op.
 */
export function hasSecondaryWeeklyWindows(
	usageData: FullUsageData | null | undefined,
): boolean {
	return getScopedWeeklyLimits(usageData).length > 0;
}

/**
 * Parse a JSON array of account-id strings from localStorage. Returns `[]` for
 * null / invalid / non-array / parse errors. Filters to strings only and
 * de-duplicates, preserving first-seen order.
 */
export function parseSecondaryLimitIds(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const seen = new Set<string>();
		const ids: string[] = [];
		for (const entry of parsed) {
			if (typeof entry === "string" && !seen.has(entry)) {
				seen.add(entry);
				ids.push(entry);
			}
		}
		return ids;
	} catch {
		return [];
	}
}
