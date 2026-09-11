/** Provenance of the best available request cost; unknown also covers legacy rows. */
export type CostSource = "reported" | "estimated" | "unknown";

export function resolveCostSource(
	cost: number | null | undefined,
	source: unknown,
): CostSource {
	return cost != null &&
		Number.isFinite(cost) &&
		cost >= 0 &&
		(source === "reported" || source === "estimated")
		? source
		: "unknown";
}

/** Coverage of known usage costs. Numeric legacy costs have unknown provenance. */
export interface CostCoverage {
	reportedUsd: number;
	estimatedUsd: number;
	unknownSourceUsd: number;
	pricedRequests: number;
	unpricedRequests: number;
	reportedRequests: number;
	estimatedRequests: number;
	unknownSourceRequests: number;
}
