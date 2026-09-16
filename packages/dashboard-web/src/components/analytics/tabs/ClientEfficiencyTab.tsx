import type { AnalyticsSection, CostCoverage } from "@clankermux/types";
import { useAnalyticsData } from "../../../hooks/useAnalyticsData";
import { CostCoverageNote } from "../../CostCoverage";
import {
	AnalyticsControls,
	ClientEfficiencyTable,
	ClientModelEfficiencyPanel,
	MissingSectionsNotice,
} from "..";
import type { ClientEfficiencyTabProps } from "./types";

export const CLIENT_SECTIONS: readonly AnalyticsSection[] = [
	"clientEfficiency",
];

/**
 * The server's floor for a (client × model) pair, restated so the panel's
 * caption says what was left out. Pinned by ClientEfficiencyTab.test.tsx
 * against the handler's own constant.
 */
export const CLIENT_MODEL_MIN_REQUESTS = 5;

/**
 * Clients view. Owns the per-client efficiency rollup and the within-model
 * comparison, both from one `clientEfficiency` read.
 */
export function ClientEfficiencyTab(props: ClientEfficiencyTabProps) {
	const {
		filters,
		setFilters,
		availableAccounts,
		availableModels,
		availableApiKeys,
		availableProjects,
		hasNoAccountBucket,
		hasNoProjectBucket,
		activeFilterCount,
		filterOpen,
		setFilterOpen,
		range,
		onRangeChange,
	} = props;

	const { analytics, loading, refetch } = useAnalyticsData(range, filters, {
		sections: CLIENT_SECTIONS,
	});

	const rows = analytics?.clientEfficiency?.rows ?? [];
	const unpricedRequests = rows.reduce(
		(total, row) => total + row.unpricedRequests,
		0,
	);
	// Only the priced/unpriced split travels on this section's wire shape, so
	// the three provenance buckets are left at zero rather than filled with a
	// guess: the note then states the unpriced count and claims nothing about
	// where the known costs came from.
	const coverage: CostCoverage = {
		reportedUsd: 0,
		estimatedUsd: 0,
		unknownSourceUsd: 0,
		pricedRequests: rows.reduce((total, row) => total + row.pricedRequests, 0),
		unpricedRequests,
		reportedRequests: 0,
		estimatedRequests: 0,
		unknownSourceRequests: 0,
	};

	return (
		<div className="space-y-section">
			<AnalyticsControls
				timeRange={range}
				setTimeRange={onRangeChange}
				filterProps={{
					filters,
					setFilters,
					availableAccounts,
					availableModels,
					availableApiKeys,
					availableProjects,
					hasNoAccountBucket,
					hasNoProjectBucket,
					activeFilterCount,
					filterOpen,
					setFilterOpen,
				}}
				refresh={{ loading, onRefresh: refetch }}
			/>

			<MissingSectionsNotice
				analytics={analytics}
				requested={CLIENT_SECTIONS}
			/>

			{unpricedRequests > 0 && (
				<p className="text-xs text-muted-foreground">
					Cost coverage in this range: <CostCoverageNote coverage={coverage} />
				</p>
			)}

			<ClientEfficiencyTable
				rows={rows}
				truncated={analytics?.clientEfficiency?.truncated ?? false}
				loading={loading}
			/>

			<ClientModelEfficiencyPanel
				rows={analytics?.clientModelEfficiency ?? []}
				minRequests={CLIENT_MODEL_MIN_REQUESTS}
				loading={loading}
			/>
		</div>
	);
}
