import type { WorkloadHeadroomRow } from "./workload-headroom";

/** Advisory direction at snapshot time, never an automatic concurrency target. */
export type WorkloadGuidanceState =
	| "increase"
	| "reduce"
	| "exhausted"
	| "learning"
	| "unknown"
	| "no-accounts"
	| "uncertain"
	| "unquantified"
	| "other";

type Coverage = Pick<
	WorkloadHeadroomRow,
	| "eligibleAccountIds"
	| "unreadableAccountIds"
	| "unopenedAccountIds"
	| "learningAccountIds"
>;
type Forecast = Pick<
	WorkloadHeadroomRow,
	"outcome" | "headroom" | "projectionBasis"
>;

/**
 * Both horizons use the same eligibility/readability classification. Coverage
 * must include rejected and unopened family accounts OUTSIDE the scan inputs.
 * Evidence qualifies the baseline model, not every hypothetical pace probe.
 */
export function classifyWorkloadGuidance(
	coverage: Coverage,
	forecast: Forecast,
): WorkloadGuidanceState {
	const { outcome, headroom, projectionBasis } = forecast;
	const kinds = [
		"no-accounts",
		"unknown",
		"out-now",
		"runway",
		"beyond-horizon",
	];
	if (!kinds.includes(outcome.kind)) return "other";
	if (
		headroom !== null &&
		(!Number.isFinite(headroom.pct) ||
			headroom.pct <= 0 ||
			!(
				(headroom.direction === "margin" &&
					outcome.kind === "beyond-horizon") ||
				(headroom.direction === "deficit" && outcome.kind === "runway")
			))
	) {
		return "other";
	}
	if (
		projectionBasis !== null &&
		projectionBasis !== "measured" &&
		projectionBasis !== "structural"
	)
		return "other";

	const eligible = new Set(coverage.eligibleAccountIds);
	const omitted = new Set([
		...coverage.unreadableAccountIds,
		...coverage.unopenedAccountIds,
	]);
	const learning = new Set(coverage.learningAccountIds);
	if ([...omitted, ...learning].some((id) => !eligible.has(id))) return "other";
	if (outcome.kind === "no-accounts") {
		return eligible.size === 0 ? "no-accounts" : "other";
	}
	if (eligible.size === 0) return "other";
	if (outcome.kind === "unknown") {
		// A missing account alongside a learner might never become readable.
		return learning.size === eligible.size &&
			coverage.unopenedAccountIds.length === 0
			? "learning"
			: "unknown";
	}
	if (omitted.size > 0 || learning.size > 0 || projectionBasis !== "measured") {
		return "uncertain";
	}
	if (outcome.kind === "out-now") return "exhausted";
	if (headroom !== null)
		return headroom.direction === "margin" ? "increase" : "reduce";
	return "unquantified";
}
