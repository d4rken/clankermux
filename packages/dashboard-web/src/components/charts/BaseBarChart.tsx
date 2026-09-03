import {
	Bar,
	BarChart,
	CartesianGrid,
	Legend,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { CHART_PROPS, CHART_TOKENS } from "../../constants";
import { ChartContainer } from "./ChartContainer";
import {
	type CommonChartProps,
	getChartHeight,
	getTooltipStyles,
	isChartEmpty,
} from "./chart-utils";
import { legendLabelFormatter } from "./legend-format";

interface BarConfig {
	dataKey: string;
	fill?: string;
	name?: string;
	yAxisId?: string;
	radius?: [number, number, number, number];
	/**
	 * Bars sharing a `stackId` are stacked instead of drawn side by side.
	 *
	 * Needed where the series are PARTS OF ONE TOTAL — stops per cause in a
	 * bucket, say. Side by side, the reader has to add the bars up by eye to see
	 * how bad the bucket was, and a bucket with many small causes looks calmer
	 * than one with a single large one of the same total.
	 */
	stackId?: string;
}

interface BaseBarChartProps extends CommonChartProps {
	bars: BarConfig | BarConfig[];
	layout?: "horizontal" | "vertical";
	xAxisType?: "number" | "category";
	yAxisType?: "number" | "category";
	yAxisWidth?: number;
	yAxisOrientation?: "left" | "right";
	secondaryYAxis?: boolean;
}

export function BaseBarChart({
	data,
	bars,
	xAxisKey = "name",
	loading = false,
	height = "medium",
	layout = "horizontal",
	xAxisAngle = 0,
	xAxisTextAnchor = "middle",
	xAxisHeight = 30,
	xAxisTickFormatter,
	xAxisType = layout === "vertical" ? "number" : "category",
	yAxisType = layout === "vertical" ? "category" : "number",
	yAxisWidth,
	yAxisDomain,
	yAxisTickFormatter,
	yAxisOrientation = "left",
	secondaryYAxis = false,
	tooltipFormatter,
	tooltipLabelFormatter,
	tooltipStyle,
	animationDuration = 1000,
	showLegend = false,
	legendHeight = 36,
	margin,
	className = "",
	error = null,
	emptyState,
	onChartClick,
}: BaseBarChartProps) {
	const chartHeight = getChartHeight(height);
	const isEmpty = isChartEmpty(data);
	const tooltipStyles = getTooltipStyles(tooltipStyle);
	const barConfigs = Array.isArray(bars) ? bars : [bars];

	return (
		<ChartContainer
			loading={loading}
			height={height}
			className={className}
			error={error}
			isEmpty={isEmpty}
			emptyState={emptyState}
		>
			<ResponsiveContainer width="100%" height={chartHeight}>
				<BarChart
					data={data}
					layout={layout}
					margin={margin}
					onClick={onChartClick}
				>
					<CartesianGrid
						strokeDasharray={CHART_PROPS.strokeDasharray}
						className={CHART_PROPS.gridClassName}
					/>
					{layout === "vertical" ? (
						<>
							<XAxis
								{...CHART_PROPS.axis}
								type={xAxisType as "number"}
								className="text-xs"
								tickFormatter={xAxisTickFormatter}
							/>
							<YAxis
								{...CHART_PROPS.axis}
								dataKey={xAxisKey}
								type={yAxisType as "category"}
								className="text-xs"
								width={yAxisWidth}
								tickFormatter={yAxisTickFormatter}
							/>
						</>
					) : (
						<>
							<XAxis
								{...CHART_PROPS.axis}
								dataKey={xAxisKey}
								type={xAxisType as "category"}
								className="text-xs"
								angle={xAxisAngle}
								textAnchor={xAxisTextAnchor}
								height={xAxisHeight}
								tickFormatter={xAxisTickFormatter}
							/>
							<YAxis
								{...CHART_PROPS.axis}
								yAxisId={secondaryYAxis ? "left" : undefined}
								type={yAxisType as "number"}
								className="text-xs"
								domain={yAxisDomain}
								orientation={yAxisOrientation}
								tickFormatter={yAxisTickFormatter}
							/>
							{secondaryYAxis && (
								<YAxis
									{...CHART_PROPS.axis}
									yAxisId="right"
									orientation="right"
									className="text-xs"
									tickFormatter={yAxisTickFormatter}
								/>
							)}
						</>
					)}
					<Tooltip
						cursor={CHART_PROPS.cursorBand}
						contentStyle={tooltipStyles}
						// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened Formatter to include undefined
						formatter={tooltipFormatter as any}
						// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened labelFormatter label to ReactNode
						labelFormatter={tooltipLabelFormatter as any}
					/>
					{showLegend && (
						<Legend height={legendHeight} formatter={legendLabelFormatter} />
					)}
					{barConfigs.map((barConfig) => (
						<Bar
							key={barConfig.dataKey}
							dataKey={barConfig.dataKey}
							fill={barConfig.fill || CHART_TOKENS.primary}
							name={barConfig.name || barConfig.dataKey}
							yAxisId={barConfig.yAxisId}
							stackId={barConfig.stackId}
							radius={barConfig.radius}
							animationDuration={animationDuration}
						/>
					))}
				</BarChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
