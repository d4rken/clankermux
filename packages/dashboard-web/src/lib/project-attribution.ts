import type { ProjectAttributionSource } from "@clankermux/types";

/**
 * Presentation for `requests.project_attribution_source` — which tier produced
 * a request's project (see ProjectAttributionSource).
 *
 * An UNDEFINED source is not the same as `"none"`: it means the row predates
 * the column or the request was never eligible for attribution, so nothing is
 * claimed about it. `"none"` means the request WAS eligible and no tier fired.
 */

const SOURCE_LABELS: Record<ProjectAttributionSource, string> = {
	header: "x-project header",
	path_override: "configured path override",
	repo_root: "repository root",
	wd_primary: "primary working directory",
	wd_plain: "working directory",
	codex_cwd: "Codex working directory",
	session_inherited: "inherited from session",
	session_ambiguous: "ambiguous session",
	none: "no project signal",
};

/** Full label for any known source; null when the source is unknown. */
export function projectAttributionLabel(
	source: ProjectAttributionSource | undefined,
): string | null {
	return source ? SOURCE_LABELS[source] : null;
}

/**
 * Row-level chip. Only the two NON-anchored outcomes get one: an anchored
 * project is the normal case and a chip on every row would be noise, while
 * "this project was guessed" and "we refused to guess" are the states a reader
 * must be able to distrust.
 */
export function projectAttributionChip(
	source: ProjectAttributionSource | undefined,
): { label: string; title: string } | null {
	if (source === "session_inherited") {
		return {
			label: "inherited",
			title:
				"Project inherited from an earlier request in the same session, not from this request",
		};
	}
	if (source === "session_ambiguous") {
		return {
			label: "ambiguous",
			title:
				"This session used more than one project, so no project was attributed",
		};
	}
	return null;
}

/**
 * Live summaries carry the source directly; hydrated historical rows only have
 * the stored payload envelope's meta block. Preferring the summary keeps a
 * freshly re-emitted row authoritative over an older stored envelope.
 */
export function resolveProjectAttributionSource(
	summarySource: ProjectAttributionSource | undefined,
	payloadMetaSource: ProjectAttributionSource | undefined,
): ProjectAttributionSource | undefined {
	return summarySource ?? payloadMetaSource;
}

/**
 * Whether a request row has anything to show in the attribution row. The
 * source MUST be part of this test: an ambiguous request has no project (and
 * may have no API key or combo either), so keying only on project/key/combo
 * would silently hide exactly the rows the chip exists to expose.
 */
export function hasAttributionMetadata(row: {
	apiKeyName?: string | null;
	project?: string | null;
	comboName?: string | null;
	source?: ProjectAttributionSource;
}): boolean {
	return Boolean(
		row.apiKeyName ||
			row.project ||
			row.comboName ||
			projectAttributionChip(row.source),
	);
}

/** The per-bucket attribution counters carried by an analytics project row. */
export interface ProjectAttributionCounts {
	project: string | null;
	requests: number;
	measuredRequests: number;
	inferredRequests: number;
	ambiguousRequests: number;
}

/**
 * One-line attribution summary for a project-breakdown row.
 *
 * The inference share is reported over MEASURED rows only. Reporting it over
 * total requests would silently dilute every range that spans the deploy of
 * the source column — legacy rows have no recorded source, and counting them
 * as "not inferred" under-reports inference exactly when the number matters.
 *
 * The no-project bucket gets a breakdown instead of a share: "0% inferred"
 * there is meaningless (an inherited project is never null), while the
 * no-signal / ambiguous / unknown split is the actual information.
 */
export function describeProjectAttribution(
	row: ProjectAttributionCounts,
): string {
	if (row.measuredRequests <= 0) return "not measured";

	if (row.project === null) {
		const unknown = Math.max(0, row.requests - row.measuredRequests);
		const noSignal = Math.max(
			0,
			row.measuredRequests - row.ambiguousRequests - row.inferredRequests,
		);
		const parts: string[] = [];
		if (noSignal > 0) parts.push(`${noSignal} no signal`);
		if (row.ambiguousRequests > 0) {
			parts.push(`${row.ambiguousRequests} ambiguous`);
		}
		if (unknown > 0) parts.push(`${unknown} unknown`);
		return parts.join(" · ");
	}

	const percent = Math.round(
		(row.inferredRequests / row.measuredRequests) * 100,
	);
	return `${percent}% inferred (${row.inferredRequests} of ${row.measuredRequests} measured)`;
}

/**
 * How much of the range has a recorded attribution source at all. Rendered as
 * a note beside the breakdown so a partially-measured range is labeled instead
 * of silently reading as fully known.
 *
 * Takes the server's range-wide aggregate, NOT the project-breakdown rows:
 * that array is truncated to the top-N projects, so summing it would report
 * full coverage for any range whose unmeasured rows fall outside the cut.
 * `undefined` (an older server that doesn't send the aggregate) yields a null
 * percent, which renders as "not available" rather than a fabricated 0%.
 */
export function attributionCoverage(
	coverage: { measured: number; total: number } | undefined,
): { measured: number; total: number; percent: number | null } {
	const measured = coverage?.measured ?? 0;
	const total = coverage?.total ?? 0;
	return {
		measured,
		total,
		percent: total > 0 ? Math.round((measured / total) * 100) : null,
	};
}
