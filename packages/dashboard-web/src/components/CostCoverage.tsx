import type { CostCoverage } from "@clankermux/types";
import { formatUsd } from "@clankermux/ui-common";

export function formatKnownCost(
	value: number,
	coverage?: CostCoverage,
): string {
	return coverage &&
		coverage.pricedRequests === 0 &&
		coverage.unpricedRequests > 0
		? "—"
		: formatUsd(value);
}

export function CostCoverageNote({ coverage }: { coverage?: CostCoverage }) {
	if (!coverage) return <span>Cost source unavailable</span>;
	const parts: string[] = [];
	if (coverage.reportedRequests > 0)
		parts.push(`${formatUsd(coverage.reportedUsd)} reported`);
	if (coverage.estimatedRequests > 0)
		parts.push(`${formatUsd(coverage.estimatedUsd)} estimated`);
	if (coverage.unknownSourceRequests > 0)
		parts.push(`${formatUsd(coverage.unknownSourceUsd)} source unknown`);
	if (coverage.unpricedRequests > 0)
		parts.push(
			`${coverage.unpricedRequests.toLocaleString()} ${coverage.unpricedRequests === 1 ? "request" : "requests"} unpriced`,
		);
	return (
		<span>{parts.length ? parts.join(" · ") : "No API usage recorded"}</span>
	);
}
