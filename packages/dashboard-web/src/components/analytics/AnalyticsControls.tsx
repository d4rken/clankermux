import { RefreshCw } from "lucide-react";
import type { TimeRange } from "../../constants";
import { TimeRangeSelector } from "../overview/TimeRangeSelector";
import { Button } from "../ui/button";
import { AnalyticsFilters } from "./AnalyticsFilters";
import type { SharedFilterProps } from "./tabs/types";

/**
 * The control row every analytics tab puts above its content.
 *
 * It used to hand-roll its own range `Select` while `CachingTab` rendered
 * `TimeRangeSelector` in a right-aligned row of its own, so the picker moved
 * across the page and changed appearance between tabs while offering the very
 * same six ranges. There is one picker now, and it lives here.
 *
 * `filterProps` and `refresh` are optional objects rather than flags plus a
 * flat prop list: a tab either has filters or it does not, and omitting the
 * object is the only way to say so — there is no way to ask for the Filters
 * button and then not supply its options.
 */
interface AnalyticsControlsProps {
	timeRange: TimeRange;
	setTimeRange: (range: TimeRange) => void;
	/** Omitted ⇒ no Filters button. */
	filterProps?: SharedFilterProps;
	/** Omitted ⇒ no Refresh button. */
	refresh?: { loading: boolean; onRefresh: () => void };
}

export function AnalyticsControls({
	timeRange,
	setTimeRange,
	filterProps,
	refresh,
}: AnalyticsControlsProps) {
	return (
		<div className="flex flex-col sm:flex-row gap-group justify-between">
			<div className="flex flex-wrap gap-item">
				<TimeRangeSelector value={timeRange} onChange={setTimeRange} />

				{filterProps && <AnalyticsFilters {...filterProps} />}
			</div>

			{refresh && (
				<div className="flex gap-item">
					<Button
						variant="outline"
						size="sm"
						onClick={refresh.onRefresh}
						disabled={refresh.loading}
					>
						<RefreshCw
							className={`h-4 w-4 mr-item ${refresh.loading ? "animate-spin" : ""}`}
						/>
						Refresh
					</Button>
				</div>
			)}
		</div>
	);
}
