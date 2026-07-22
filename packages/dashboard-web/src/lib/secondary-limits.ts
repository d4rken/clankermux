import { isAnthropicUsageShape } from "@clankermux/core";
import type { AnthropicUsageData, FullUsageData } from "@clankermux/types";

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
