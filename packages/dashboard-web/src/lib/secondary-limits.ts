import {
	FAMILY_WEEKLY_EXHAUSTED_THRESHOLD_PERCENT,
	getModelFamily,
	isAnthropicUsageShape,
} from "@clankermux/core";
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

/** One model family whose scoped weekly window is currently exhausted. */
export interface ExhaustedScopedFamily {
	/**
	 * Stable grouping key: the resolved model family (e.g. "fable" — duplicate
	 * scoped entries like Mythos + Fable collapse to one), or the entry's own
	 * key when no family resolves (e.g. Codex's synthetic per-model windows).
	 */
	familyKey: string;
	/** Display label of the entry that won the group (highest percent). */
	label: string;
	/** Parsed reset, epoch ms (finite and in the future). */
	resetsAtMs: number;
	/** The winning entry's reported percent (>= the exhaustion threshold). */
	percent: number;
}

/**
 * The scoped weekly windows currently EXHAUSTED (at/above the same threshold
 * routing's family gate uses), deduplicated by model family. Built on
 * {@link getScopedWeeklyLimits} rather than core's family-resolved
 * normalization so provider-agnostic entries (Codex's synthetic per-model
 * windows, whose display names resolve to no Claude family) still surface —
 * they keep their own key. Within one family the highest-percent entry wins;
 * a percent tie goes to the sooner reset. Sorted soonest-reset first.
 */
export function getExhaustedScopedFamilies(
	usageData: FullUsageData | null | undefined,
	now: number,
): ExhaustedScopedFamily[] {
	const byFamily = new Map<string, ExhaustedScopedFamily>();
	for (const limit of getScopedWeeklyLimits(usageData)) {
		if (limit.utilization < FAMILY_WEEKLY_EXHAUSTED_THRESHOLD_PERCENT) continue;
		const resetsAtMs = Date.parse(limit.resetsAt);
		if (!Number.isFinite(resetsAtMs) || resetsAtMs <= now) continue;
		const familyKey = getModelFamily(limit.label) ?? limit.key;
		const candidate: ExhaustedScopedFamily = {
			familyKey,
			label: limit.label,
			resetsAtMs,
			percent: limit.utilization,
		};
		const existing = byFamily.get(familyKey);
		if (
			!existing ||
			candidate.percent > existing.percent ||
			(candidate.percent === existing.percent &&
				candidate.resetsAtMs < existing.resetsAtMs)
		) {
			byFamily.set(familyKey, candidate);
		}
	}
	return [...byFamily.values()].sort((a, b) => a.resetsAtMs - b.resetsAtMs);
}
