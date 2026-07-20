import type { ActiveSessionsTimePoint } from "@clankermux/types";
import { COLORS } from "../constants";

/**
 * Pure transforms for the Active Sessions panel (Analytics tab). Kept out of the
 * component so the pivot logic is unit-testable, mirroring lib/tool-errors.ts.
 */

/** One scope's stable identity: raw scope, collision-safe chart key, and label. */
export interface ActiveSessionScope {
	scope: ActiveSessionsTimePoint["scope"];
	/** Prefixed dataKey so a scope can never collide with row fields like `ts`. */
	key: string;
	/** Human-readable name for the legend/tooltip. */
	label: string;
}

/**
 * Fixed, stable scope order. Series and 0-fill both derive from this so colors
 * and legend order stay identical between refreshes regardless of input order.
 */
export const SCOPE_ORDER: readonly ActiveSessionScope[] = [
	{ scope: "claude_session", key: "scope:claude_session", label: "Claude" },
	{ scope: "codex_thread", key: "scope:codex_thread", label: "Codex" },
	{ scope: "project", key: "scope:project", label: "Other (project)" },
] as const;

/**
 * Per-scope color keyed by chart dataKey, so each scope keeps its identity color
 * even when a sibling scope is absent (index-based coloring would shift). Sourced
 * from the shared COLORS palette in @clankermux/ui-constants.
 */
export const SESSION_SCOPE_COLORS: Record<string, string> = {
	"scope:claude_session": COLORS.primary,
	"scope:codex_thread": COLORS.blue,
	"scope:project": COLORS.purple,
};

/**
 * Synthetic "Total" line: the per-bucket sum across all client scopes. Kept out
 * of SCOPE_ORDER/SESSION_SCOPE_COLORS because it is an aggregate, not a client.
 * Rendered dashed in a neutral slate so it reads as an aggregate and stays
 * legible on both light and dark chart backgrounds. NOTE: this per-bucket total
 * is legitimately summable per bucket, but it is NOT `totalDistinctSessions`
 * (the range badge), which COUNT-DISTINCTs a session once across the whole range
 * while this counts it in every bucket it was active in.
 */
export const SESSION_TOTAL_KEY = "scope:total";
export const SESSION_TOTAL_COLOR = "#94a3b8";

/**
 * Compact client labels for the Overview live-gauge sub-rows, keyed by the
 * ActiveSessionCounts field names (claude/codex/other). Single source of truth
 * for the client naming so the gauge and the chart legend can't drift — the
 * chart's fuller "Other (project)" legend label (in SCOPE_ORDER) is an
 * intentional expansion of the gauge's compact "Other".
 */
export const SESSION_SCOPE_SHORT_LABELS: Record<
	"claude" | "codex" | "other",
	string
> = {
	claude: "Claude",
	codex: "Codex",
	other: "Other",
};

/** One chart row: a bucket timestamp plus per-scope session counts keyed by scopeKey. */
export interface ActiveSessionsTrendRow {
	ts: number;
	[scopeKey: string]: number;
}

export interface ActiveSessionsTrendSeries {
	/** Stable, collision-safe dataKey for the chart (see SCOPE_ORDER). */
	key: string;
	/** Human-readable scope name for the legend/tooltip. */
	label: string;
}

export interface ActiveSessionsTrend {
	rows: ActiveSessionsTrendRow[];
	/** Present scopes only, in the fixed SCOPE_ORDER relative order. */
	series: ActiveSessionsTrendSeries[];
}

/**
 * Pivot the flat per-(bucket, scope) time series into one wide chart row per
 * bucket. Every row 0-fills all scope keys so an absent scope renders a line to
 * zero rather than a gap. Rows come back sorted by ts asc; series lists only
 * scopes present anywhere, in the fixed SCOPE_ORDER relative order.
 */
export function buildActiveSessionsTrend(
	timeSeries: ActiveSessionsTimePoint[],
): ActiveSessionsTrend {
	const byTs = new Map<number, ActiveSessionsTrendRow>();

	for (const point of timeSeries) {
		let row = byTs.get(point.ts);
		if (!row) {
			row = { ts: point.ts };
			for (const s of SCOPE_ORDER) row[s.key] = 0; // 0-fill all scopes
			byTs.set(point.ts, row);
		}
		const entry = SCOPE_ORDER.find((s) => s.scope === point.scope);
		if (entry) row[entry.key] = point.sessions;
	}

	// Per-bucket total across all client scopes (scopes are 0-filled, so summing
	// SCOPE_ORDER keys covers absent scopes correctly). Drives the "Total" line.
	for (const row of byTs.values()) {
		let total = 0;
		for (const s of SCOPE_ORDER) total += row[s.key] ?? 0;
		row[SESSION_TOTAL_KEY] = total;
	}

	const series = SCOPE_ORDER.filter((s) =>
		timeSeries.some((p) => p.scope === s.scope),
	).map(({ key, label }) => ({ key, label }));

	const rows = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
	return { rows, series };
}
