import { ANALYTICS_SECTIONS, type AnalyticsSection } from "@clankermux/types";

/**
 * Parsing + validation for the `/api/analytics?sections=` query param.
 *
 * Lives in its own module because BOTH sides need it: the runner validates and
 * canonicalizes on the main thread (before worker dispatch, so a typo returns
 * 400 immediately instead of queuing behind a slow heavy query and surfacing as
 * a 503 soft timeout), and the direct handler parses the same param inside the
 * worker to decide which query phases to run.
 */

const SECTION_NAMES: ReadonlySet<string> = new Set<string>(ANALYTICS_SECTIONS);

/**
 * Sections that cannot be produced alone, and what they need alongside them.
 *
 * Each entry exists because the dependent section writes INTO an object another
 * section owns, and zero-filling that parent would contradict the
 * omitted-means-absent contract:
 *
 * - `contextComposition` reuses the consolidated query's `total_requests` for
 *   `coverage.totalRequests`, which the `totals` phase computes.
 * - `speedTotals` produces only two properties *inside* the `totals` object.
 * - `activeSessionsByAccount` produces only `activeSessions.perAccount`, and
 *   the dashboard's ActiveSessionsPanel reads `activeSessions.timeSeries`
 *   unguarded once the object exists.
 */
const IMPLIED_DEPENDENCIES: Readonly<
	Partial<Record<AnalyticsSection, readonly AnalyticsSection[]>>
> = {
	contextComposition: ["totals"],
	speedTotals: ["totals"],
	activeSessionsByAccount: ["activeSessions"],
};

export type SectionParseResult =
	| {
			ok: true;
			/**
			 * The resolved, canonical (deduped + sorted) section set, or `null`
			 * when the caller sent no `sections` param at all — which means
			 * "compute everything" and is the pre-sections behaviour.
			 */
			sections: AnalyticsSection[] | null;
	  }
	| { ok: false; message: string };

/**
 * Resolve implied dependencies and canonicalize (dedupe + sort).
 *
 * Sorting is what makes `sections=a,b` and `sections=b,a` a single React Query
 * key and a single server response-cache entry.
 */
export function resolveSections(
	requested: Iterable<AnalyticsSection>,
): AnalyticsSection[] {
	const resolved = new Set<AnalyticsSection>();
	for (const section of requested) {
		resolved.add(section);
		for (const dependency of IMPLIED_DEPENDENCIES[section] ?? []) {
			resolved.add(dependency);
		}
	}
	return [...resolved].sort();
}

/** Every section, resolved and canonical — what the unscoped path computes. */
export function allSections(): AnalyticsSection[] {
	return resolveSections(ANALYTICS_SECTIONS);
}

/**
 * Parse a raw `sections` param value.
 *
 * - absent (`null`) => `{ sections: null }`, i.e. compute everything
 * - present but empty (`sections=`, `sections=,,`) => 400. The client rejects an
 *   empty selection rather than dropping the param, so `[]` can never silently
 *   mean "compute everything" — the single most expensive fallback there is.
 * - any unknown name => 400 naming the offenders, so a typo can't degrade into
 *   a silently-missing panel.
 */
export function parseSectionsParam(raw: string | null): SectionParseResult {
	if (raw === null) return { ok: true, sections: null };

	const tokens = raw
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token.length > 0);

	if (tokens.length === 0) {
		return {
			ok: false,
			message:
				"The 'sections' parameter was empty. Omit it entirely to compute every section.",
		};
	}

	const unknown = tokens.filter((token) => !SECTION_NAMES.has(token));
	if (unknown.length > 0) {
		return {
			ok: false,
			message: `Unknown analytics section(s): ${unknown.join(", ")}. Valid sections: ${ANALYTICS_SECTIONS.join(", ")}.`,
		};
	}

	return {
		ok: true,
		sections: resolveSections(tokens as AnalyticsSection[]),
	};
}

/**
 * Rewrite `params.sections` to its canonical resolved form (or leave it absent).
 *
 * Called on the main thread before the cache key is derived, so callers that
 * differ only in section ORDER or in an unstated implied dependency share one
 * cache entry and one worker round-trip.
 */
export function canonicalizeSectionsParam(
	params: URLSearchParams,
	sections: AnalyticsSection[] | null,
): URLSearchParams {
	if (sections === null) {
		if (!params.has("sections")) return params;
		const copy = new URLSearchParams(params);
		copy.delete("sections");
		return copy;
	}
	const copy = new URLSearchParams(params);
	copy.set("sections", sections.join(","));
	return copy;
}
