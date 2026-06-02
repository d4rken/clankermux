import {
	CHART_HEIGHTS,
	CHART_TOOLTIP_STYLE,
	type TimeRange,
} from "../../constants";
import type { TooltipLabelFormatter } from "../../lib/chart-utils";
import type { ChartClickHandler, ChartDataPoint } from "./types";

/**
 * X-axis layout props for time-series charts: multi-day ranges get angled,
 * taller ticks so the longer date labels don't overlap. Returned in the shape
 * `BaseAreaChart`/`BaseLineChart` expect, so callers can spread it directly.
 */
export function longRangeAxisProps(range: TimeRange): {
	xAxisAngle: number;
	xAxisTextAnchor: "start" | "middle" | "end";
	xAxisHeight: number;
} {
	const isLong = range === "7d" || range === "30d";
	return {
		xAxisAngle: isLong ? -45 : 0,
		xAxisTextAnchor: isLong ? "end" : "middle",
		xAxisHeight: isLong ? 60 : 30,
	};
}

/**
 * Calculate chart height from height prop
 */
export function getChartHeight(
	height: keyof typeof CHART_HEIGHTS | number,
): number {
	return typeof height === "number" ? height : CHART_HEIGHTS[height];
}

/**
 * Check if chart data is empty
 */
export function isChartEmpty(data: ChartDataPoint[] | undefined): boolean {
	return !data || data.length === 0;
}

/**
 * Get tooltip styles from prop
 */
export function getTooltipStyles(
	tooltipStyle: keyof typeof CHART_TOOLTIP_STYLE | object,
): object {
	return typeof tooltipStyle === "string"
		? CHART_TOOLTIP_STYLE[tooltipStyle]
		: tooltipStyle;
}

/**
 * Common chart axis props
 */
export interface CommonAxisProps {
	xAxisKey?: string;
	xAxisAngle?: number;
	xAxisTextAnchor?: "start" | "middle" | "end";
	xAxisHeight?: number;
	xAxisTickFormatter?: (value: number | string) => string;
	yAxisDomain?: [number | "auto", number | "auto"];
	yAxisTickFormatter?: (value: number | string) => string;
}

/**
 * Common chart props shared across all chart types
 */
export interface CommonChartProps extends CommonAxisProps {
	data: ChartDataPoint[];
	loading?: boolean;
	height?: keyof typeof CHART_HEIGHTS | number;
	className?: string;
	error?: Error | null;
	emptyState?: React.ReactNode;
	margin?: { top?: number; right?: number; bottom?: number; left?: number };
	showLegend?: boolean;
	legendHeight?: number;
	tooltipFormatter?: (value: number, name: string) => [string, string];
	tooltipLabelFormatter?: TooltipLabelFormatter;
	tooltipStyle?: keyof typeof CHART_TOOLTIP_STYLE | object;
	animationDuration?: number;
	onChartClick?: ChartClickHandler;
}
