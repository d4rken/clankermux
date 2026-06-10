import type { TimePoint } from "@clankermux/types";
import { formatCost, formatNumber, formatTokens } from "@clankermux/ui-common";
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
	COLORS,
	type TimeRange,
} from "../../constants";
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
	BaseBarChart,
	BaseLineChart,
	ModelPerformanceChart,
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
				<div className="flex items-center justify-between">
					<div>
						<CardTitle>Traffic Analytics</CardTitle>
						<CardDescription>
							{modelBreakdown
								? "Per-model breakdown over time"
								: "Request volume and performance metrics over time"}
						</CardDescription>
					</div>
					<div className="flex items-center gap-4">
						<div className="flex items-center gap-2">
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
								<SelectItem value="cost">Cost ($)</SelectItem>
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
													stopColor="#14b8a6"
													stopOpacity={0.9}
												/>
												<stop
													offset="100%"
													stopColor="#14b8a6"
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
													stopColor="#f97316"
													stopOpacity={0.9}
												/>
												<stop
													offset="100%"
													stopColor="#f97316"
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
													name === "planCost"
														? "Plan Cost"
														: "API/Overage Cost",
												]) as TooltipFormatter
											}
											labelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
										/>
										<Legend height={36} />
										<Area
											type="monotone"
											dataKey="planCost"
											name="Plan Cost"
											stroke="#14b8a6"
											strokeWidth={strokeW}
											fillOpacity={1}
											fill="url(#colorPlanCost)"
											stackId="cost"
											animationDuration={1000}
										/>
										<Area
											type="monotone"
											dataKey="apiCost"
											name="API/Overage Cost"
											stroke="#f97316"
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
									color={COLORS.primary}
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
							stroke: COLORS.error,
							name: "Error Rate %",
						},
						{
							dataKey: "cacheHitRate",
							stroke: COLORS.success,
							name: "Cache Hit %",
						},
					]}
					loading={loading}
					height="medium"
					showLegend={true}
					tooltipLabelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
					referenceLines={[
						{ y: 90, stroke: COLORS.success },
						{ y: 5, stroke: COLORS.error },
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

interface TokenUsageBreakdownProps {
	tokenBreakdown: TokenBreakdownItem[];
	timeRange: TimeRange;
}

export function TokenUsageBreakdown({
	tokenBreakdown,
	timeRange,
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
				<div className="space-y-4">
					{tokenBreakdown.map((item, index) => (
						<div key={item.type}>
							<div className="flex items-center justify-between mb-2">
								<span className="text-sm font-medium">{item.type}</span>
								<div className="flex items-center gap-2">
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
												? COLORS.blue
												: index === 1
													? COLORS.success
													: index === 2
														? COLORS.warning
														: COLORS.purple,
									}}
								/>
							</div>
						</div>
					))}
					<div className="pt-4 border-t">
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
			</CardContent>
		</Card>
	);
}

interface ModelComparisonChartsProps {
	modelPerformance: Array<{
		model: string;
		avgTime: number;
		p95Time: number;
		errorRate: number;
	}>;
	costByModel: Array<{ model: string; cost: number; requests: number }>;
	loading: boolean;
	timeRange: TimeRange;
}

export function ModelComparisonCharts({
	modelPerformance,
	costByModel,
	loading,
	timeRange,
}: ModelComparisonChartsProps) {
	return (
		<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
			{/* Model Performance */}
			<Card>
				<CardHeader>
					<CardTitle>Model Performance Comparison</CardTitle>
					<CardDescription>
						Response times and error rates by model
					</CardDescription>
				</CardHeader>
				<CardContent>
					<ModelPerformanceChart
						data={modelPerformance}
						loading={loading}
						height={CHART_HEIGHTS.medium}
					/>
				</CardContent>
			</Card>

			{/* Cost by Model */}
			<Card>
				<CardHeader>
					<CardTitle>Cost Analysis by Model</CardTitle>
					<CardDescription>
						Top models by cost in the last {timeRange}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<BaseBarChart
						data={costByModel}
						bars={{ dataKey: "cost", radius: [0, 4, 4, 0] }}
						xAxisKey="model"
						loading={loading}
						height="medium"
						layout="vertical"
						yAxisWidth={120}
						tooltipFormatter={(value, name) => {
							if (name === "cost") return [formatCost(Number(value)), "Cost"];
							return [formatNumber(value as number), "Requests"];
						}}
					/>
				</CardContent>
			</Card>
		</div>
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
		<Card className="bg-gradient-to-br from-background to-muted/10 border-muted">
			<CardHeader>
				<CardTitle className="text-2xl font-bold">
					Cumulative Growth Analysis
				</CardTitle>
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
								<stop offset="0%" stopColor={COLORS.blue} stopOpacity={0.9} />
								<stop offset="100%" stopColor={COLORS.blue} stopOpacity={0.1} />
							</linearGradient>
							<linearGradient id="cumulativeCost" x1="0" y1="0" x2="0" y2="1">
								<stop
									offset="0%"
									stopColor={COLORS.warning}
									stopOpacity={0.9}
								/>
								<stop
									offset="100%"
									stopColor={COLORS.warning}
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
							stroke={COLORS.blue}
							tickFormatter={formatCompactNumber}
						/>
						<YAxis
							yAxisId="cost"
							orientation="right"
							className="text-xs"
							stroke={COLORS.warning}
							tickFormatter={formatCompactCurrency}
						/>
						<Tooltip
							labelClassName="font-bold"
							contentStyle={getTooltipStyles("default")}
							labelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
							formatter={
								((value: number | string, name: string) => {
									if (name === "Total Cost")
										return [formatCost(Number(value)), "Total Cost"];
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
							stroke={COLORS.blue}
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
							stroke={COLORS.warning}
							strokeWidth={3}
							fillOpacity={1}
							fill="url(#cumulativeCost)"
							filter="url(#cumulativeGlow)"
							name="Total Cost"
						/>
					</AreaChart>
				</ResponsiveContainer>
			</CardContent>
		</Card>
	);
}

interface CumulativeTokenCompositionProps {
	tokenBreakdown: TokenBreakdownItem[];
}

export function CumulativeTokenComposition({
	tokenBreakdown,
}: CumulativeTokenCompositionProps) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Cumulative Token Composition</CardTitle>
				<CardDescription>Token type distribution over time</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-6">
					<div className="relative h-24 bg-muted rounded-lg overflow-hidden">
						{(() => {
							let offset = 0;
							return tokenBreakdown.map((item, index) => {
								const width = item.percentage;
								const currentOffset = offset;
								offset += width;
								return (
									<div
										key={item.type}
										className="absolute h-full transition-all duration-1000 hover:opacity-80"
										style={{
											left: `${currentOffset}%`,
											width: `${width}%`,
											background: `linear-gradient(135deg, ${
												index === 0
													? COLORS.blue
													: index === 1
														? COLORS.success
														: index === 2
															? COLORS.warning
															: COLORS.purple
											} 0%, ${
												index === 0
													? COLORS.purple
													: index === 1
														? COLORS.blue
														: index === 2
															? COLORS.primary
															: COLORS.warning
											} 100%)`,
										}}
									>
										<div className="flex items-center justify-center h-full">
											{width > 10 && (
												<span className="text-white font-medium text-xs">
													{item.percentage}%
												</span>
											)}
										</div>
									</div>
								);
							});
						})()}
					</div>
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
						{tokenBreakdown.map((item, index) => (
							<div key={item.type} className="flex items-center gap-2">
								<div
									className="w-3 h-3 rounded-full"
									style={{
										background:
											index === 0
												? COLORS.blue
												: index === 1
													? COLORS.success
													: index === 2
														? COLORS.warning
														: COLORS.purple,
									}}
								/>
								<div>
									<p className="text-xs text-muted-foreground">{item.type}</p>
									<p className="text-sm font-medium">
										{formatTokens(item.value)}
									</p>
								</div>
							</div>
						))}
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
