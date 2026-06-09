import type {
	AnthropicUsageData,
	FullUsageData,
	UsageWindowData,
} from "@clankermux/types";

/** localStorage key for the per-account "show secondary limits" preference. */
export const SECONDARY_LIMITS_STORAGE_KEY = "clankermux:show-secondary-limits";

/**
 * True iff a model-specific weekly window (`seven_day_opus`/`seven_day_sonnet`)
 * has a numeric utilization AND a non-null reset — i.e. it would render as its
 * own bar. Shared by {@link hasSecondaryWeeklyWindows} and the push blocks in
 * RateLimitProgress.tsx so the gate and the actual rendering stay in lockstep.
 */
export function hasAnthropicSecondaryWindow(
	window: UsageWindowData | null | undefined,
): boolean {
	return (
		window != null &&
		typeof window.utilization === "number" &&
		window.resets_at != null
	);
}

/**
 * True iff the account's usage data is Anthropic-shaped (the only shape with
 * model-specific weekly windows) AND has at least one secondary window that
 * would render. The `five_hour`/`seven_day` presence check mirrors
 * `hasAnthropicStyleData` in RateLimitProgress.tsx — the branch that renders
 * the Opus/Sonnet bars — so the "Show secondary limits" toggle is never offered
 * when toggling it would be a no-op. Zai/Alibaba/Kilo and null data return false.
 */
export function hasSecondaryWeeklyWindows(
	usageData: FullUsageData | null | undefined,
): boolean {
	if (!usageData) return false;
	if (!("five_hour" in usageData) || !("seven_day" in usageData)) return false;
	const anthropicData = usageData as AnthropicUsageData;
	return (
		hasAnthropicSecondaryWindow(anthropicData.seven_day_opus) ||
		hasAnthropicSecondaryWindow(anthropicData.seven_day_sonnet)
	);
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
