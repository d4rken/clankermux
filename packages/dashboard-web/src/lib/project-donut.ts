/**
 * Maps per-project analytics rows to donut-chart data points.
 *
 * The API keeps the no-project bucket as `project: null` (never a sentinel
 * string), so a project literally named "(no project)" can't collide — the
 * label is display-only.
 */
export const NO_PROJECT_LABEL = "(no project)";

export interface ProjectRequestsRow {
	project: string | null;
	requests: number;
}

export function toProjectDonutData(
	rows: ProjectRequestsRow[],
): Array<{ name: string; value: number }> {
	return rows
		.filter((row) => row.requests > 0)
		.map((row) => ({
			name: row.project ?? NO_PROJECT_LABEL,
			value: row.requests,
		}))
		.sort((a, b) => b.value - a.value);
}
