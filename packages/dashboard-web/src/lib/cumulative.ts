/** The accumulating fields of an analytics time-series point. */
export interface CumulativePoint {
	ts: number;
	requests: number;
	tokens: number;
	cost: number;
	planCost: number;
	apiCost: number;
}

/**
 * Turn a per-bucket time-series into a running-total ("cumulative") series.
 *
 * The input may contain more than one row per timestamp — the backend returns
 * one row per (ts, model) when a model breakdown is active — so rows are first
 * collapsed to a single row per timestamp (summing the accumulating fields),
 * sorted chronologically, then accumulated into running totals.
 *
 * Non-accumulating fields (e.g. the `time` label) are taken from the first row
 * seen for each timestamp and passed through unchanged. The original rows are
 * not mutated.
 */
export function toCumulativeSeries<T extends CumulativePoint>(rows: T[]): T[] {
	const byTs = new Map<number, T>();
	for (const point of rows) {
		const existing = byTs.get(point.ts);
		if (existing) {
			existing.requests += point.requests;
			existing.tokens += point.tokens;
			existing.cost += point.cost;
			existing.planCost += point.planCost;
			existing.apiCost += point.apiCost;
		} else {
			byTs.set(point.ts, { ...point });
		}
	}

	const aggregated = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);

	let runningRequests = 0;
	let runningTokens = 0;
	let runningCost = 0;
	let runningPlanCost = 0;
	let runningApiCost = 0;
	return aggregated.map((point) => {
		runningRequests += point.requests;
		runningTokens += point.tokens;
		runningCost += point.cost;
		runningPlanCost += point.planCost;
		runningApiCost += point.apiCost;
		return {
			...point,
			requests: runningRequests,
			tokens: runningTokens,
			cost: parseFloat(runningCost.toFixed(2)),
			planCost: runningPlanCost,
			apiCost: runningApiCost,
		};
	});
}
