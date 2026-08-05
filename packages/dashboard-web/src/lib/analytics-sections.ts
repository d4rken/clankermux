import type { AnalyticsResponse, AnalyticsSection } from "@clankermux/types";

/**
 * Canonicalize a section list: dedupe + sort.
 *
 * Applied to BOTH the React Query key and the request URL so two callers that
 * differ only in the order they listed their sections share one client cache
 * entry, one request, and one server response-cache entry. The server
 * canonicalizes independently; doing it here as well is what keeps the query
 * key aligned with what the server actually computed.
 */
export function canonicalSections(
	sections: readonly AnalyticsSection[],
): AnalyticsSection[] {
	return [...new Set(sections)].sort();
}

/**
 * Did the server actually compute this section?
 *
 * Distinguishes "the server omitted this section" from "the section is present
 * but empty in this range" — the latter is real data (render the empty state),
 * the former is a contract mismatch that must NOT be drawn as an empty panel.
 *
 * A pre-sections server sends no `meta.sections` at all; in that case anything
 * present is assumed computed.
 */
export function hasSection(
	analytics: AnalyticsResponse | undefined,
	section: AnalyticsSection,
): boolean {
	if (!analytics) return false;
	const sections = analytics.meta?.sections;
	if (!sections) return true;
	return sections.includes(section);
}
