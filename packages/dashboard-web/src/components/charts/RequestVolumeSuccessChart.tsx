import { formatNumber } from "@clankermux/ui-common";
import {
	Area,
	CartesianGrid,
	ComposedChart,
	Legend,
	Line,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { CHART_PROPS, COLORS } from "../../constants";
import { formatCompactNumber } from "../../lib/chart-utils";
import { ChartContainer } from "./ChartContainer";
import { ChartTooltip } from "./ChartTooltip";
import { getChartHeight } from "./chart-utils";

interface RequestVolumeSuccessChartProps {
	data: Array<{
		time: string;
		requests: number;
		successRate: number;
	}>;
	loading?: boolean;
	height?: "small" | "medium" | "large" | number;
}

const GRADIENT_ID = "requestVolumeGradient";

/**
 * Combined Overview chart: request volume (filled area, left axis) and success
 * rate (line, right axis fixed at 0–100%). Built directly on recharts
 * primitives — like `CumulativeGrowthChart` — because the dual-axis composition
 * can't be expressed through the single-axis Base* chart wrappers. Tooltip uses
 * the shared `ChartTooltip` with per-series formatters keyed by `dataKey`.
 */
export function RequestVolumeSuccessChart({
	data,
	loading = false,
	height = "medium",
}: RequestVolumeSuccessChartProps) {
	const chartHeight = getChartHeight(height);
	const isEmpty = !data || data.length === 0;

	return (
		<ChartContainer
			loading={loading}
			height={height}
			isEmpty={isEmpty}
			emptyState={
				<p className="text-sm text-muted-foreground">
					No request data in this range
				</p>
			}
		>
			<ResponsiveContainer width="100%" height={chartHeight}>
				<ComposedChart data={data} margin={{ top: 8, right: 8, left: 0 }}>
					<defs>
						<linearGradient id={GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
							<stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.8} />
							<stop offset="95%" stopColor={COLORS.primary} stopOpacity={0.1} />
						</linearGradient>
					</defs>
					<CartesianGrid
						strokeDasharray={CHART_PROPS.strokeDasharray}
						className={CHART_PROPS.gridClassName}
					/>
					<XAxis dataKey="time" className="text-xs" height={30} />
					<YAxis
						yAxisId="requests"
						className="text-xs"
						tickFormatter={formatCompactNumber}
					/>
					<YAxis
						yAxisId="successRate"
						orientation="right"
						className="text-xs"
						domain={[0, 100]}
						tickFormatter={(value) => `${value}%`}
					/>
					<Tooltip
						content={
							<ChartTooltip
								formatters={{
									requests: (value) => formatNumber(Number(value)),
									successRate: (value) => `${Number(value).toFixed(1)}%`,
								}}
							/>
						}
					/>
					<Legend verticalAlign="top" height={36} iconType="rect" />
					<Area
						yAxisId="requests"
						type="monotone"
						dataKey="requests"
						name="Requests"
						stroke={COLORS.primary}
						strokeWidth={2}
						fillOpacity={1}
						fill={`url(#${GRADIENT_ID})`}
					/>
					<Line
						yAxisId="successRate"
						type="monotone"
						dataKey="successRate"
						name="Success Rate"
						stroke={COLORS.success}
						strokeWidth={2}
						dot={false}
					/>
				</ComposedChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
