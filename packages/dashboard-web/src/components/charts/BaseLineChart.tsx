import {
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { CHART_PROPS, COLORS } from "../../constants";
import { ChartContainer } from "./ChartContainer";
import {
	type CommonChartProps,
	getChartHeight,
	getTooltipStyles,
	isChartEmpty,
} from "./chart-utils";

// Recharts' string curve types. `CurveType` is not re-exported from the
// "recharts" package root (only `Curve`/`CurveProps` are), so we mirror the
// string members of recharts' own `CurveType` union here.
type LineCurveType =
	| "monotone"
	| "linear"
	| "step"
	| "stepAfter"
	| "stepBefore"
	| "natural"
	| "basis";

export interface LineConfig {
	dataKey: string;
	stroke?: string;
	strokeWidth?: number;
	dot?: boolean;
	name?: string;
	/** Per-line override for the curve type. Falls back to the chart-level `lineType`. */
	type?: LineCurveType;
	/** Dash pattern, e.g. "5 3" for a dashed (forecast) line. Solid when omitted. */
	strokeDasharray?: string;
	/** Draw across null gaps. Defaults to false (nulls render as gaps). */
	connectNulls?: boolean;
	/** Legend marker. Set "none" to hide a line from the legend (e.g. forecast twins). */
	legendType?: "line" | "none";
}

interface ReferenceLineConfig {
	y: number;
	stroke?: string;
	strokeDasharray?: string;
	label?: string;
}

interface BaseLineChartProps extends CommonChartProps {
	lines: LineConfig | LineConfig[];
	referenceLines?: ReferenceLineConfig[];
	/**
	 * Curve interpolation for all lines. Defaults to "monotone" (smoothed).
	 * Use "linear" (or a "step*" variant) to keep reset drops sharp, e.g. for
	 * sawtooth graphs. Overridable per line via `LineConfig.type`.
	 */
	lineType?: LineCurveType;
}

export function BaseLineChart({
	data,
	lines,
	xAxisKey = "time",
	loading = false,
	height = "medium",
	xAxisAngle = 0,
	xAxisTextAnchor = "middle",
	xAxisHeight = 30,
	xAxisTickFormatter,
	yAxisDomain,
	yAxisTickFormatter,
	tooltipFormatter,
	tooltipLabelFormatter,
	tooltipStyle = "default",
	animationDuration = 1000,
	showLegend = false,
	legendHeight = 36,
	referenceLines = [],
	lineType = "monotone",
	margin,
	className = "",
	error = null,
	emptyState,
	onChartClick,
}: BaseLineChartProps) {
	const chartHeight = getChartHeight(height);
	const isEmpty = isChartEmpty(data);
	const tooltipStyles = getTooltipStyles(tooltipStyle);
	const lineConfigs = Array.isArray(lines) ? lines : [lines];

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
				<LineChart data={data} margin={margin} onClick={onChartClick}>
					<CartesianGrid
						strokeDasharray={CHART_PROPS.strokeDasharray}
						className={CHART_PROPS.gridClassName}
					/>
					<XAxis
						dataKey={xAxisKey}
						className="text-xs"
						angle={xAxisAngle}
						textAnchor={xAxisTextAnchor}
						height={xAxisHeight}
						tickFormatter={xAxisTickFormatter}
					/>
					<YAxis
						className="text-xs"
						domain={yAxisDomain}
						tickFormatter={yAxisTickFormatter}
					/>
					<Tooltip
						contentStyle={tooltipStyles}
						// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened Formatter to include undefined
						formatter={tooltipFormatter as any}
						// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened labelFormatter label to ReactNode
						labelFormatter={tooltipLabelFormatter as any}
					/>
					{showLegend && <Legend height={legendHeight} />}
					{lineConfigs.map((lineConfig, _index) => (
						<Line
							key={lineConfig.dataKey}
							type={lineConfig.type ?? lineType}
							dataKey={lineConfig.dataKey}
							stroke={lineConfig.stroke || COLORS.primary}
							strokeWidth={lineConfig.strokeWidth || 2}
							strokeDasharray={lineConfig.strokeDasharray}
							connectNulls={lineConfig.connectNulls ?? false}
							legendType={lineConfig.legendType}
							dot={lineConfig.dot ?? false}
							name={lineConfig.name || lineConfig.dataKey}
							animationDuration={animationDuration}
						/>
					))}
					{referenceLines.map((refLine) => (
						<ReferenceLine
							key={`ref-line-${refLine.y}`}
							y={refLine.y}
							stroke={refLine.stroke || COLORS.primary}
							strokeDasharray={
								refLine.strokeDasharray || CHART_PROPS.strokeDasharray
							}
							label={refLine.label}
						/>
					))}
				</LineChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
