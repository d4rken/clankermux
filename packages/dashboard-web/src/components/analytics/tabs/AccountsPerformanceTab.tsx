import type { TimeRange } from "../../../constants";
import { useAnalytics } from "../../../hooks/queries";
import { dataAvailability } from "../../../lib/data-availability";
import { AccountPerformanceSection } from "../../limits/AccountPerformanceSection";
export function AccountsPerformanceTab({
	range,
	onRangeChange,
}: {
	range: TimeRange;
	onRangeChange: (range: TimeRange) => void;
}) {
	const query = useAnalytics(
		range,
		{ accounts: [], models: [], status: "all" },
		"normal",
		false,
		{ sections: ["accountPerformance"] },
	);
	const state = dataAvailability(query, query.isLoading);
	return (
		<>
			<AccountPerformanceSection
				view="performance"
				accountPerformance={query.data?.accountPerformance ?? []}
				loading={state.state === "loading"}
				unavailable={state.state === "unavailable"}
				range={range}
				onRangeChange={onRangeChange}
				costSummary={{
					planCostUsd: null,
					avgDailyPlanCostUsd: null,
					avgWeeklyPlanCostUsd: null,
				}}
			/>
			{state.state === "stale" && (
				<p className="text-sm text-warning-strong">
					Showing saved performance data; refresh failed.
				</p>
			)}
		</>
	);
}
