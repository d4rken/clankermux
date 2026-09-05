import { formatTokens } from "@clankermux/ui-common";
import { AlertCircle } from "lucide-react";
import { useMemo } from "react";
import { CHART_HEIGHTS } from "../../constants";
import { useSeriesPalette } from "../../hooks/useSeriesPalette";
import { formatCompactNumber } from "../../lib/chart-utils";
import type { OverviewTimeSeriesRow } from "../../lib/overview-timeseries";
import {
	type ProjectTokensRow,
	toProjectDonutData,
} from "../../lib/project-donut";
import { BasePieChart, RequestVolumeSuccessChart } from "../charts";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

interface ChartsSectionProps {
	timeSeriesData: OverviewTimeSeriesRow[];
	/** Selected dashboard range — forwarded to the time-series chart for labelling. */
	timeRange: string;
	modelData: Array<{ name: string; value: number }>;
	/**
	 * Per-key × model request counts. `apiKeyId` is the identity — `null` is the
	 * no-key bucket — and `apiKey` is only a label, so two ids sharing a name
	 * stay two entries.
	 */
	apiKeyModelUsageData: Array<{
		apiKeyId: string | null;
		apiKey: string;
		model: string;
		count: number;
	}>;
	projectBreakdownData: ProjectTokensRow[];
	loading: boolean;
	/**
	 * Set when the analytics read FAILED with nothing cached.
	 *
	 * Distinct from `loading` and from a genuinely empty range: an axis with no
	 * series on it reads as "no traffic in this range", which is a measurement
	 * claim a failed read never made.
	 */
	unavailable?: boolean;
}

/**
 * Stands in for a chart whose data could not be read.
 *
 * Takes the same `CHART_HEIGHTS` key as the chart it replaces, not a height
 * class of its own. The two used to be spelled independently — `h-64` (256px)
 * standing in for a `medium` chart drawn at 300px, `h-40` (160px) for a
 * `compact` one at 180px — so every panel jumped by 20 to 44px at the moment
 * data arrived, which is the one moment the reader is looking at it.
 *
 * This renders INSTEAD of `ChartContainer`, not inside it, so it has to reserve
 * that height itself. Reserving the full height is the point: a failed read
 * holds the space its chart would occupy rather than collapsing the page.
 */
/**
 * Stands in for `apiKeyId: null` as a Map key and a React key.
 *
 * A sentinel is safe here where it would not be on the wire: the ids it sits
 * beside are opaque row ids, never names, so it cannot collide with a key the
 * user named "No key".
 */
const NO_KEY_ID = "__no_key__";

function ChartUnavailable({ height }: { height: keyof typeof CHART_HEIGHTS }) {
	return (
		<div
			className="flex items-center justify-center gap-item text-xs text-warning-strong"
			style={{ height: CHART_HEIGHTS[height] }}
		>
			<AlertCircle className="h-3.5 w-3.5 shrink-0" />
			Chart data unavailable
		</div>
	);
}

export function ChartsSection({
	timeSeriesData,
	timeRange,
	modelData,
	apiKeyModelUsageData,
	projectBreakdownData,
	loading,
	unavailable = false,
}: ChartsSectionProps) {
	const series = useSeriesPalette();
	// Aggregate per-key model usage into per-key totals for the donut.
	//
	// Keyed on the IDENTITY, never on the label: two keys can carry the same
	// name (a live one and a hard-deleted one whose snapshot name matches), and
	// the no-key bucket's label "No key" is also a name a real key can be given.
	// Grouping by label would silently merge those into one slice.
	const apiKeyUsageDonutData = useMemo(() => {
		const totals = new Map<string, { name: string; value: number }>();
		for (const row of apiKeyModelUsageData) {
			const id = row.apiKeyId ?? NO_KEY_ID;
			const entry = totals.get(id);
			if (entry) entry.value += row.count;
			else totals.set(id, { name: row.apiKey, value: row.count });
		}
		return Array.from(totals.entries())
			.map(([id, entry]) => ({ id, name: entry.name, value: entry.value }))
			.sort((a, b) => b.value - a.value);
	}, [apiKeyModelUsageData]);

	// Per-key model breakdown for the sub-rows, on the same identity.
	const apiKeyModelBreakdown = useMemo(() => {
		const breakdown = new Map<
			string,
			Array<{ model: string; count: number }>
		>();
		for (const row of apiKeyModelUsageData) {
			const id = row.apiKeyId ?? NO_KEY_ID;
			if (!breakdown.has(id)) breakdown.set(id, []);
			breakdown.get(id)?.push({ model: row.model, count: row.count });
		}
		return breakdown;
	}, [apiKeyModelUsageData]);

	// Prepare project donut data (total tokens per project)
	const projectDonutData = useMemo(
		() => toProjectDonutData(projectBreakdownData),
		[projectBreakdownData],
	);

	return (
		<>
			{/* Charts Row 1 — request volume + success rate, combined full width */}
			<Card>
				<CardHeader>
					<CardTitle>Request Volume, Success &amp; Cache Hit</CardTitle>
					<CardDescription>
						Requests per bucket (left axis), success and cache-hit percentages
						(right axis), and distinct active sessions (own scale — compare
						shape, not height) over time. Sessions are attributed for new
						requests only.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{unavailable ? (
						<ChartUnavailable height="medium" />
					) : (
						<RequestVolumeSuccessChart
							data={timeSeriesData}
							timeRange={timeRange}
							loading={loading}
							height="medium"
						/>
					)}
				</CardContent>
			</Card>

			{/* Charts Row 2 — three donut charts */}
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-group">
				{/* Model Distribution */}
				<Card>
					<CardHeader className="p-4">
						<CardTitle>Model Usage</CardTitle>
						<CardDescription>
							Distribution of API calls by model
						</CardDescription>
					</CardHeader>
					<CardContent className="p-4 pt-0">
						{unavailable ? (
							<ChartUnavailable height="compact" />
						) : (
							<BasePieChart
								data={modelData}
								loading={loading}
								height="compact"
								innerRadius={48}
								outerRadius={72}
								paddingAngle={5}
							/>
						)}
						<div className="mt-row space-y-item">
							{modelData.map((model, index) => (
								<div
									key={model.name}
									className="flex items-center justify-between text-sm"
								>
									<div className="flex items-center gap-item">
										<div
											className="h-3 w-3 rounded-full"
											style={{
												backgroundColor:
													series.sequence[index % series.sequence.length],
											}}
										/>
										<span className="text-muted-foreground">{model.name}</span>
									</div>
									<span className="font-medium">{model.value}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>

				{/* Usage by API key */}
				<Card>
					<CardHeader className="p-4">
						<CardTitle>Usage by API key</CardTitle>
						<CardDescription>
							Request distribution across API keys
						</CardDescription>
					</CardHeader>
					<CardContent className="p-4 pt-0">
						{unavailable ? (
							<ChartUnavailable height="compact" />
						) : (
							<BasePieChart
								data={apiKeyUsageDonutData}
								loading={loading}
								height="compact"
								innerRadius={48}
								outerRadius={72}
								paddingAngle={5}
							/>
						)}
						<div className="mt-row space-y-item">
							{apiKeyUsageDonutData.map((apiKey, index) => {
								const models = apiKeyModelBreakdown.get(apiKey.id) ?? [];
								return (
									<div key={apiKey.id} className="space-y-tight">
										<div className="flex items-center justify-between text-sm">
											<div className="flex items-center gap-item">
												<div
													className="h-3 w-3 rounded-full"
													style={{
														backgroundColor:
															series.sequence[index % series.sequence.length],
													}}
												/>
												<span className="text-muted-foreground font-medium">
													{apiKey.name}
												</span>
											</div>
											<span className="font-medium">{apiKey.value}</span>
										</div>
										{models.length > 1 && (
											// `pl-5` is an ALIGNMENT, not a rhythm step, so it stays
											// off the scale: 20px is the key row's swatch (12px)
											// plus its `gap-item` (8px), which is what puts these
											// per-model lines under the key NAME rather than under
											// its dot.
											<div className="pl-5 space-y-tight">
												{models.map((m) => (
													<div
														key={m.model}
														className="flex items-center justify-between text-xs text-muted-foreground"
													>
														<span>{m.model}</span>
														<span>{m.count}</span>
													</div>
												))}
											</div>
										)}
									</div>
								);
							})}
						</div>
					</CardContent>
				</Card>

				{/* Usage by Project */}
				<Card>
					<CardHeader className="p-4">
						<CardTitle>Usage by Project</CardTitle>
						<CardDescription>
							Token usage distribution across projects
						</CardDescription>
					</CardHeader>
					<CardContent className="p-4 pt-0">
						{unavailable ? (
							<ChartUnavailable height="compact" />
						) : (
							<BasePieChart
								data={projectDonutData}
								loading={loading}
								height="compact"
								innerRadius={48}
								outerRadius={72}
								paddingAngle={5}
								tooltipFormatter={(value) => [
									formatTokens(Number(value)),
									"Tokens",
								]}
							/>
						)}
						<div className="mt-row space-y-item">
							{projectDonutData.map((project, index) => (
								<div
									key={project.name}
									className="flex items-center justify-between text-sm"
								>
									<div className="flex items-center gap-item min-w-0">
										<div
											className="h-3 w-3 shrink-0 rounded-full"
											style={{
												backgroundColor:
													series.sequence[index % series.sequence.length],
											}}
										/>
										<span className="text-muted-foreground truncate">
											{project.name}
										</span>
									</div>
									<span className="font-medium">
										{formatCompactNumber(project.value)}
									</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			</div>
		</>
	);
}
