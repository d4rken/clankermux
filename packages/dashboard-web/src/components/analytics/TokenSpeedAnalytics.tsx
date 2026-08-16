import type { SpeedTimePoint } from "@clankermux/types";
import { Activity } from "lucide-react";
import type { TimeRange } from "../../constants";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { SpeedOverTimeChart } from "./SpeedOverTimeChart";

interface TokenSpeedAnalyticsProps {
	/** Per-model median output-speed time series (artifact-filtered upstream). */
	speedTimeSeries: SpeedTimePoint[];
	loading?: boolean;
	timeRange: TimeRange;
}

export function TokenSpeedAnalytics({
	speedTimeSeries,
	loading = false,
	timeRange,
}: TokenSpeedAnalyticsProps) {
	return (
		<div className="space-y-6">
			{/* Output Speed Over Time — per-model trend lines */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Activity className="h-5 w-5" />
						Output Speed Over Time
					</CardTitle>
				</CardHeader>
				<CardContent>
					<SpeedOverTimeChart
						speedTimeSeries={speedTimeSeries}
						loading={loading}
						timeRange={timeRange}
						height={340}
					/>
				</CardContent>
			</Card>
		</div>
	);
}
