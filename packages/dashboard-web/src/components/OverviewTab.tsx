import React from "react";
import { Link } from "react-router";
import { REFRESH_INTERVALS } from "../constants";
import { useStats } from "../hooks/queries";
import { useQuotaSummary } from "../hooks/useQuotaSummary";
import { dataAvailability, staleAgeLabel } from "../lib/data-availability";
import { LiveActivityLanes } from "./overview/LiveActivityLanes";
import { PricingGapBanner } from "./overview/PricingGapBanner";
import { StorageIntegrityBanner } from "./overview/StorageIntegrity";
import { SystemHealthStrip } from "./overview/SystemHealthStrip";
import { CompactRecentErrors } from "./overview/system-status/CompactRecentErrors";
import { useVisibleRecentErrors } from "./overview/system-status/useVisibleRecentErrors";
import { QuotaAttention } from "./quota/QuotaAttention";
import { QuotaSummary } from "./quota/QuotaSummary";

export const OVERVIEW_ERROR_WINDOW_HOURS = 1;
export const OverviewTab = React.memo(() => {
	const summary = useQuotaSummary();
	const stats = useStats(
		REFRESH_INTERVALS.default,
		OVERVIEW_ERROR_WINDOW_HOURS,
	);
	const availability = dataAvailability(stats, stats.isLoading);
	const errors = useVisibleRecentErrors(stats.data?.recentErrors);
	return (
		<div className="space-y-section">
			<StorageIntegrityBanner />
			<PricingGapBanner />
			<QuotaSummary {...summary} />
			<QuotaAttention rows={summary.rows} now={summary.now} />
			<LiveActivityLanes />
			<div className="flex flex-wrap gap-group text-sm">
				<Link to="/analytics" className="underline">
					Traffic and performance →
				</Link>
				<Link to="/limits" className="underline">
					Explore quota usage →
				</Link>
				<Link to="/costs" className="underline">
					Costs and payments →
				</Link>
			</div>
			<SystemHealthStrip
				errorGroupCount={
					availability.state === "loading"
						? undefined
						: availability.state === "unavailable"
							? null
							: errors.visible.length
				}
			/>
			<CompactRecentErrors
				errors={errors.visible}
				accounts={summary.accounts}
				onDismiss={errors.dismiss}
				onDismissAll={errors.dismissAll}
				unavailable={availability.state === "unavailable"}
				staleNote={
					availability.state === "stale"
						? `Last updated ${staleAgeLabel(availability.lastUpdatedAt, summary.now)}`
						: undefined
				}
			/>
		</div>
	);
});
