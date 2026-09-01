import type { TimePoint } from "@clankermux/types";
import { formatCost, formatTokens } from "@clankermux/ui-common";
import type { ComponentProps } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	Legend,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import {
	CHART_HEIGHTS,
	CHART_PROPS,
	CHART_TOKENS,
	type TimeRange,
} from "../../constants";
import { useSeriesPalette } from "../../hooks/useSeriesPalette";
import {
	formatCompactCurrency,
	formatCompactNumber,
	type TooltipFormatter,
} from "../../lib/chart-utils";
import {
	formatAxisTime,
	makeTimeTooltipLabelFormatter,
} from "../../lib/time-format";
import {
	BaseAreaChart,
	BaseLineChart,
	MultiModelChart,
	RequestVolumeChart,
	ResponseTimeChart,
	TokenSpeedChart,
	TokenUsageChart,
} from "../charts";
import { getTooltipStyles, longRangeAxisProps } from "../charts/chart-utils";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";

type TooltipFormatterProp = ComponentProps<typeof Tooltip>["formatter"];

interface ChartData {
	time: string;
	ts: number;
	requests: number;
	tokens: number;
	cost: number;
	planCost: number;
	apiCost: number;
	responseTime: number;
	errorRate: number;
	cacheHitRate: number;
	avgTokensPerSecond: number;
	[key: string]: string | number;
}

interface MainMetricsChartProps {
	data: ChartData[];
	rawTimeSeries?: TimePoint[];
	loading: boolean;
	timeRange: TimeRange;
	selectedMetric: string;
	setSelectedMetric: (metric: string) => void;
	modelBreakdown?: boolean;
	onModelBreakdownChange?: (enabled: boolean) => void;
}

export function MainMetricsChart({
	data,
	rawTimeSeries,
	loading,
	timeRange,
	selectedMetric,
	setSelectedMetric,
	modelBreakdown = false,
	onModelBreakdownChange,
}: MainMetricsChartProps) {
	const series = useSeriesPalette();
	// Process data for multi-model chart if model breakdown is enabled
	const processedMultiModelData =
		rawTimeSeries && modelBreakdown
			? (() => {
					// Group by timestamp and pivot models. Rows are keyed by the raw
					// timestamp so the compact axis label and the rich tooltip stay in
					// sync (see time-format.ts); `ts` rides along for the tooltip.
					const grouped: Record<
						number,
						{ time: string; ts: number; [model: string]: string | number }
					> = {};
					const models = new Set<string>();
					const timestamps = new Set<number>();

					// First pass: collect all time points and models
					rawTimeSeries.forEach((point) => {
						if (point.model) {
							models.add(point.model);
							timestamps.add(point.ts);
						}
					});

					// Sort time points chronologically
					const sortedTs = Array.from(timestamps).sort((a, b) => a - b);

					// Initialize data structure
					const modelArrays = Array.from(models).sort();

					// Process time points in order
					sortedTs.forEach((ts) => {
						grouped[ts] = { time: formatAxisTime(ts, timeRange), ts };

						// Initialize all models for this time point
						modelArrays.forEach((model) => {
							// Default to 0 for missing data points
							grouped[ts][model] = 0;
						});
					});

					// Fill in actual values
					rawTimeSeries.forEach((point) => {
						if (point.model) {
							// Map the metric value
							let value = 0;
							switch (selectedMetric) {
								case "requests":
									value = point.requests;
									break;
								case "tokens":
									value = point.tokens;
									break;
								case "cost":
									value = point.costUsd;
									break;
								case "responseTime":
									value = point.avgResponseTime;
									break;
								case "tokensPerSecond":
									value = point.avgTokensPerSecond || 0;
									break;
							}

							grouped[point.ts][point.model] = value;
						}
					});

					// Sort and return the data
					const finalData = sortedTs.map((ts) => grouped[ts]);

					return {
						data: finalData,
						models: modelArrays,
					};
				})()
			: null;

	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-start justify-between gap-row">
					<div>
						<CardTitle>Traffic Analytics</CardTitle>
						<CardDescription>
							{modelBreakdown
								? "Per-model breakdown over time"
								: "Request volume and performance metrics over time"}
						</CardDescription>
					</div>
					<div className="flex items-center gap-group">
						<div className="flex items-center gap-item">
							<Switch
								id="model-breakdown"
								checked={modelBreakdown}
								onCheckedChange={onModelBreakdownChange}
							/>
							<Label htmlFor="model-breakdown" className="text-sm">
								Per Model
							</Label>
						</div>
						<Select value={selectedMetric} onValueChange={setSelectedMetric}>
							<SelectTrigger className="w-40">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="requests">Requests</SelectItem>
								<SelectItem value="tokens">Token Usage</SelectItem>
								<SelectItem value="cost">Token Cost ($)</SelectItem>
								<SelectItem value="responseTime">Response Time</SelectItem>
								<SelectItem value="tokensPerSecond">Output Speed</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				{(() => {
					// Show multi-model chart if breakdown is enabled
					if (modelBreakdown && processedMultiModelData) {
						return (
							<MultiModelChart
								data={processedMultiModelData.data}
								models={processedMultiModelData.models}
								metric={
									selectedMetric as
										| "requests"
										| "tokens"
										| "cost"
										| "responseTime"
										| "tokensPerSecond"
								}
								loading={loading}
								height={CHART_HEIGHTS.large}
								timeRange={timeRange}
							/>
						);
					}

					// Otherwise show normal charts
					const commonProps = {
						data,
						loading,
						height: CHART_HEIGHTS.large,
						timeRange,
					};

					switch (selectedMetric) {
						case "tokens":
							return <TokenUsageChart {...commonProps} />;
						case "cost": {
							const isLongRange =
								timeRange === "7d" ||
								timeRange === "30d" ||
								timeRange === "all";
							const strokeW = 2;
							return (
								<ResponsiveContainer width="100%" height={CHART_HEIGHTS.large}>
									<AreaChart
										data={data}
										margin={{
											top: 10,
											right: 10,
											left: 0,
											bottom: isLongRange ? 60 : 30,
										}}
									>
										<defs>
											<linearGradient
												id="colorPlanCost"
												x1="0"
												y1="0"
												x2="0"
												y2="1"
											>
												<stop
													offset="0%"
													stopColor={series.hue.mint}
													stopOpacity={0.9}
												/>
												<stop
													offset="100%"
													stopColor={series.hue.mint}
													stopOpacity={0.1}
												/>
											</linearGradient>
											<linearGradient
												id="colorApiCost"
												x1="0"
												y1="0"
												x2="0"
												y2="1"
											>
												<stop
													offset="0%"
													stopColor={series.hue.tan}
													stopOpacity={0.9}
												/>
												<stop
													offset="100%"
													stopColor={series.hue.tan}
													stopOpacity={0.1}
												/>
											</linearGradient>
										</defs>
										<CartesianGrid
											strokeDasharray={CHART_PROPS.strokeDasharray}
											className={CHART_PROPS.gridClassName}
										/>
										<XAxis
											dataKey="time"
											className="text-xs"
											angle={isLongRange ? -45 : 0}
											textAnchor={isLongRange ? "end" : "middle"}
											height={isLongRange ? 60 : 30}
										/>
										<YAxis
											className="text-xs"
											tickFormatter={formatCompactCurrency}
										/>
										<Tooltip
											formatter={
												((value: number, name: string) => [
													formatCost(Number(value)),
													name === "planCost" ? "Plan Cost" : "Token Cost",
												]) as TooltipFormatter
											}
											labelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
										/>
										<Legend height={36} />
										<Area
											type="monotone"
											dataKey="planCost"
											name="Plan Cost"
											stroke={series.hue.mint}
											strokeWidth={strokeW}
											fillOpacity={1}
											fill="url(#colorPlanCost)"
											stackId="cost"
											animationDuration={1000}
										/>
										<Area
											type="monotone"
											dataKey="apiCost"
											name="Token Cost"
											stroke={series.hue.tan}
											strokeWidth={strokeW}
											fillOpacity={1}
											fill="url(#colorApiCost)"
											stackId="cost"
											animationDuration={1000}
										/>
									</AreaChart>
								</ResponsiveContainer>
							);
						}
						case "requests":
							return <RequestVolumeChart {...commonProps} />;
						case "responseTime":
							return <ResponseTimeChart {...commonProps} />;
						case "tokensPerSecond":
							return <TokenSpeedChart {...commonProps} />;
						default:
							return (
								<BaseAreaChart
									data={data}
									dataKey={selectedMetric}
									loading={loading}
									height="large"
									color={CHART_TOKENS.primary}
									strokeWidth={2}
									{...longRangeAxisProps(timeRange)}
									tooltipLabelFormatter={makeTimeTooltipLabelFormatter(
										timeRange,
									)}
								/>
							);
					}
				})()}
			</CardContent>
		</Card>
	);
}

interface PerformanceIndicatorsChartProps {
	data: ChartData[];
	loading: boolean;
	timeRange?: TimeRange;
}

export function PerformanceIndicatorsChart({
	data,
	loading,
	timeRange = "24h",
}: PerformanceIndicatorsChartProps) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Performance Indicators</CardTitle>
				<CardDescription>Error rate and cache hit rate trends</CardDescription>
			</CardHeader>
			<CardContent>
				<BaseLineChart
					data={data}
					lines={[
						{
							dataKey: "errorRate",
							stroke: CHART_TOKENS.error,
							name: "Error Rate %",
						},
						{
							dataKey: "cacheHitRate",
							stroke: CHART_TOKENS.success,
							name: "Cache Hit %",
						},
					]}
					loading={loading}
					height="medium"
					showLegend={true}
					tooltipLabelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
					referenceLines={[
						{ y: 90, stroke: CHART_TOKENS.success },
						{ y: 5, stroke: CHART_TOKENS.error },
					]}
				/>
			</CardContent>
		</Card>
	);
}

interface TokenBreakdownItem {
	type: string;
	value: number;
	percentage: number;
}

// The four rows are a fixed schema (input, cache read, cache creation, output),
// so the loading state can stand in for exactly what will arrive.
const TOKEN_BREAKDOWN_ROWS = 4;

interface TokenUsageBreakdownProps {
	tokenBreakdown: TokenBreakdownItem[];
	timeRange: TimeRange;
	loading: boolean;
}

export function TokenUsageBreakdown({
	tokenBreakdown,
	timeRange,
	loading,
}: TokenUsageBreakdownProps) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Token Usage Breakdown</CardTitle>
				<CardDescription>
					Distribution of token types in the last {timeRange}
				</CardDescription>
			</CardHeader>
			<CardContent>
				{/* This sits beside PerformanceIndicatorsChart, which takes `loading`
				    and forwards it. Without the same treatment here, a refetch left
				    one half of the row showing zero-percentage bars while the other
				    showed its loading state. */}
				{loading ? (
					<div className="space-y-group">
						{Array.from(
							{ length: TOKEN_BREAKDOWN_ROWS },
							(_, i) => `token-row-${i}`,
						).map((key) => (
							<div key={key}>
								<div className="mb-item flex items-center justify-between">
									<Skeleton className="h-4 w-28" />
									<Skeleton className="h-4 w-24" />
								</div>
								<Skeleton className="h-2 w-full rounded-full" />
							</div>
						))}
						<div className="pt-group border-t">
							<div className="flex items-center justify-between">
								<span className="text-sm font-medium">Total Tokens</span>
								<Skeleton className="h-6 w-32" />
							</div>
						</div>
					</div>
				) : (
					<div className="space-y-group">
						{tokenBreakdown.map((item, index) => (
							<div key={item.type}>
								<div className="flex items-center justify-between mb-item">
									<span className="text-sm font-medium">{item.type}</span>
									<div className="flex items-center gap-item">
										<span className="text-sm text-muted-foreground">
											{formatTokens(item.value)} tokens
										</span>
										<Badge variant="outline">{item.percentage}%</Badge>
									</div>
								</div>
								<div className="w-full bg-muted rounded-full h-2">
									<div
										className="h-2 rounded-full transition-all"
										style={{
											width: `${item.percentage}%`,
											backgroundColor:
												index === 0
													? CHART_TOKENS.blue
													: index === 1
														? CHART_TOKENS.success
														: index === 2
															? CHART_TOKENS.warning
															: CHART_TOKENS.purple,
										}}
									/>
								</div>
							</div>
						))}
						<div className="pt-group border-t">
							<div className="flex items-center justify-between">
								<span className="text-sm font-medium">Total Tokens</span>
								<span className="text-lg font-bold">
									{formatTokens(
										tokenBreakdown.reduce((acc, item) => acc + item.value, 0),
									)}{" "}
									tokens
								</span>
							</div>
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

interface CumulativeGrowthChartProps {
	data: ChartData[];
	timeRange: TimeRange;
}

export function CumulativeGrowthChart({
	data,
	timeRange,
}: CumulativeGrowthChartProps) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Cumulative Growth Analysis</CardTitle>
				<CardDescription>
					Token usage vs. cost accumulation over time
				</CardDescription>
			</CardHeader>
			<CardContent>
				<ResponsiveContainer width="100%" height={CHART_HEIGHTS.large}>
					<AreaChart
						data={data}
						margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
					>
						{/* Unique ids: this chart is always mounted alongside the main
						    metric charts, so generic ids like "colorTokens" would collide
						    with TokenUsageChart's gradient and swap fills. */}
						<defs>
							<linearGradient id="cumulativeTokens" x1="0" y1="0" x2="0" y2="1">
								<stop
									offset="0%"
									stopColor={CHART_TOKENS.blue}
									stopOpacity={0.9}
								/>
								<stop
									offset="100%"
									stopColor={CHART_TOKENS.blue}
									stopOpacity={0.1}
								/>
							</linearGradient>
							<linearGradient id="cumulativeCost" x1="0" y1="0" x2="0" y2="1">
								<stop
									offset="0%"
									stopColor={CHART_TOKENS.warning}
									stopOpacity={0.9}
								/>
								<stop
									offset="100%"
									stopColor={CHART_TOKENS.warning}
									stopOpacity={0.1}
								/>
							</linearGradient>
							<filter id="cumulativeGlow">
								<feGaussianBlur stdDeviation="4" result="coloredBlur" />
								<feMerge>
									<feMergeNode in="coloredBlur" />
									<feMergeNode in="SourceGraphic" />
								</feMerge>
							</filter>
						</defs>
						<CartesianGrid
							strokeDasharray={CHART_PROPS.strokeDasharray}
							className={CHART_PROPS.gridClassName}
						/>
						<XAxis dataKey="time" className="text-xs" />
						<YAxis
							yAxisId="tokens"
							className="text-xs"
							stroke={CHART_TOKENS.blue}
							tickFormatter={formatCompactNumber}
						/>
						<YAxis
							yAxisId="cost"
							orientation="right"
							className="text-xs"
							stroke={CHART_TOKENS.warning}
							tickFormatter={formatCompactCurrency}
						/>
						<Tooltip
							labelClassName="font-bold"
							contentStyle={getTooltipStyles()}
							labelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
							formatter={
								((value: number | string, name: string) => {
									if (name === "Total Token Cost")
										return [formatCost(Number(value)), "Total Token Cost"];
									return [formatTokens(value as number), "Total Tokens"];
								}) as TooltipFormatterProp
							}
						/>
						<Legend
							verticalAlign="top"
							height={36}
							iconType="rect"
							wrapperStyle={{
								paddingBottom: "20px",
							}}
						/>
						<Area
							yAxisId="tokens"
							type="monotone"
							dataKey="tokens"
							stroke={CHART_TOKENS.blue}
							strokeWidth={3}
							fillOpacity={1}
							fill="url(#cumulativeTokens)"
							filter="url(#cumulativeGlow)"
							name="Total Tokens"
						/>
						<Area
							yAxisId="cost"
							type="monotone"
							dataKey="cost"
							stroke={CHART_TOKENS.warning}
							strokeWidth={3}
							fillOpacity={1}
							fill="url(#cumulativeCost)"
							filter="url(#cumulativeGlow)"
							name="Total Token Cost"
						/>
					</AreaChart>
				</ResponsiveContainer>
			</CardContent>
		</Card>
	);
}
