import { resolveCostSource } from "@clankermux/types";
import { formatCost } from "@clankermux/ui-common";
import type { RequestSummary } from "../api";

export function RequestCostDetails({ summary }: { summary?: RequestSummary }) {
	if (!summary) return null;
	const source = resolveCostSource(summary.costUsd, summary.costSource);
	// The billing trust gate in proxy/usage-collector currently admits only OpenRouter.
	const label =
		summary.billingType === "plan"
			? "Plan value (API equivalent)"
			: source === "reported"
				? "Charged by OpenRouter"
				: source === "estimated"
					? "Estimated cost"
					: "Cost (source unknown)";
	return (
		<div className="text-sm space-y-tight">
			<p>
				{summary.costUsd == null
					? "Cost unavailable"
					: `${label}: ${formatCost(summary.costUsd)}`}
				{summary.costIsByok === true && " · BYOK"}
			</p>
			{source === "reported" && summary.estimatedCostUsd != null && (
				<p className="text-xs text-muted-foreground">
					Catalogue estimate: {formatCost(summary.estimatedCostUsd)}
				</p>
			)}
		</div>
	);
}
