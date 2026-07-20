import type { TimeRange } from "../constants";

export const TAB_IDS = ["traffic", "models", "caching", "projects"] as const;
export type AnalyticsTabId = (typeof TAB_IDS)[number];
export const DEFAULT_TAB: AnalyticsTabId = "traffic";

// Per-tab default time window. Traffic keeps the page's historical 1h default;
// the slower-moving views default to 7d where their data is more meaningful.
export const DEFAULT_RANGES: Record<AnalyticsTabId, TimeRange> = {
	traffic: "1h",
	models: "7d",
	caching: "7d",
	projects: "7d",
};

/** Map a raw ?tab= search-param value to a valid tab id, falling back to the default. */
export function sanitizeTab(raw: string | null | undefined): AnalyticsTabId {
	return TAB_IDS.includes(raw as AnalyticsTabId)
		? (raw as AnalyticsTabId)
		: DEFAULT_TAB;
}
