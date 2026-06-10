/**
 * Maps per-project analytics rows to donut-chart data points.
 *
 * The API keeps the no-project bucket as `project: null` (never a sentinel
 * string), so a project literally named "(no project)" can't collide — the
 * label is display-only.
 */
export const NO_PROJECT_LABEL = "(no project)";

export interface ProjectTokensRow {
	project: string | null;
	totalTokens: number;
}

export function toProjectDonutData(
	rows: ProjectTokensRow[],
): Array<{ name: string; value: number }> {
	return rows
		.filter((row) => row.totalTokens > 0)
		.map((row) => ({
			name: row.project ?? NO_PROJECT_LABEL,
			value: row.totalTokens,
		}))
		.sort((a, b) => b.value - a.value);
}
