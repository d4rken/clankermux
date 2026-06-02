import { getModelShortName } from "@clankermux/core";
import type { SpeedTimePoint } from "@clankermux/types";
import { formatTokensPerSecond } from "@clankermux/ui-common";
import { Activity, Clock, Gauge, Zap } from "lucide-react";
import type { TimeRange } from "../../constants";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { SpeedOverTimeChart } from "./SpeedOverTimeChart";

interface TokenSpeedAnalyticsProps {
	/** Per-model median output-speed time series (artifact-filtered upstream). */
	speedTimeSeries: SpeedTimePoint[];
	/** Global median (p50) output speed across all in-range requests. */
	medianTokensPerSecond: number | null;
	/** Global p95 output speed across all in-range requests. */
	p95TokensPerSecond: number | null;
	/** Avg response time (ms) across all in-range requests. */
	avgResponseTimeMs: number;
	modelPerformance: Array<{
		model: string;
		medianTokensPerSecond: number | null;
	}>;
	loading?: boolean;
	timeRange: TimeRange;
}

function formatSpeed(value: number | null): string {
	return value != null && value > 0 ? formatTokensPerSecond(value) : "—";
}

export function TokenSpeedAnalytics({
	speedTimeSeries,
	medianTokensPerSecond,
	p95TokensPerSecond,
	avgResponseTimeMs,
	modelPerformance,
	loading = false,
	timeRange,
}: TokenSpeedAnalyticsProps) {
	// Fastest model by median (p50) speed — robust to the artifacts that used to
	// make a near-cached request look like "the fastest model".
	const fastestModel = modelPerformance
		.filter(
			(m) => m.medianTokensPerSecond != null && m.medianTokensPerSecond > 0,
		)
		.sort(
			(a, b) => (b.medianTokensPerSecond || 0) - (a.medianTokensPerSecond || 0),
		)[0];

	return (
		<div className="space-y-6">
			{/* Statistics Cards */}
			<div className="grid grid-cols-1 md:grid-cols-4 gap-4">
				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							Typical Output Speed
						</CardTitle>
						<Activity className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{formatSpeed(medianTokensPerSecond)}
						</div>
						<p className="text-xs text-muted-foreground">
							Median (p50) across requests
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							Peak Output Speed
						</CardTitle>
						<Gauge className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{formatSpeed(p95TokensPerSecond)}
						</div>
						<p className="text-xs text-muted-foreground">
							p95 across requests in {timeRange}
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							Avg Response Time
						</CardTitle>
						<Clock className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{avgResponseTimeMs > 0
								? `${Math.round(avgResponseTimeMs)} ms`
								: "—"}
						</div>
						<p className="text-xs text-muted-foreground">
							Across all models and requests
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Fastest Model</CardTitle>
						<Zap className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{fastestModel ? getModelShortName(fastestModel.model) : "N/A"}
						</div>
						<p className="text-xs text-muted-foreground">
							{fastestModel
								? `Median: ${formatSpeed(fastestModel.medianTokensPerSecond)}`
								: "No data"}
						</p>
					</CardContent>
				</Card>
			</div>

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
