import type { ComponentProps, ReactNode } from "react";
import {
	Cell,
	Legend,
	Pie,
	PieChart,
	ResponsiveContainer,
	Tooltip,
} from "recharts";
import type { CHART_HEIGHTS } from "../../constants";
import { useSeriesPalette } from "../../hooks/useSeriesPalette";
import { ChartContainer } from "./ChartContainer";
import { getChartHeight, getTooltipStyles } from "./chart-utils";
import { legendLabelFormatter } from "./legend-format";
import type { ChartClickHandler, TooltipFormatterFunction } from "./types";

type TooltipFormatterProp = ComponentProps<typeof Tooltip>["formatter"];

interface BasePieChartProps {
	data: Array<{ name: string; value: number; [key: string]: string | number }>;
	dataKey?: string;
	nameKey?: string;
	/** Entry field used as the React key of each slice. Defaults to nameKey, which is only safe while names are unique. */
	cellKey?: string;
	loading?: boolean;
	height?: keyof typeof CHART_HEIGHTS | number;
	innerRadius?: number;
	outerRadius?: number;
	paddingAngle?: number;
	cx?: string | number;
	cy?: string | number;
	/** Overrides the palette. Omit to follow the active theme's chart ground. */
	colors?: string[];
	tooltipFormatter?: TooltipFormatterFunction;
	tooltipStyle?: object;
	animationDuration?: number;
	showLegend?: boolean;
	legendLayout?: "horizontal" | "vertical";
	legendAlign?: "left" | "center" | "right";
	legendVerticalAlign?: "top" | "middle" | "bottom";
	renderLabel?: boolean;
	className?: string;
	error?: Error | null;
	emptyState?: ReactNode;
	onPieClick?: ChartClickHandler;
}

export function BasePieChart({
	data,
	dataKey = "value",
	nameKey = "name",
	cellKey,
	loading = false,
	height = "medium",
	innerRadius = 0,
	outerRadius = 80,
	paddingAngle = 0,
	cx = "50%",
	cy = "50%",
	colors,
	tooltipFormatter,
	tooltipStyle,
	animationDuration = 1000,
	showLegend = false,
	legendLayout = "horizontal",
	legendAlign = "center",
	legendVerticalAlign = "bottom",
	renderLabel = false,
	className = "",
	error = null,
	emptyState,
	onPieClick,
}: BasePieChartProps) {
	// Not a parameter default: the fallback sequence depends on which ground is
	// being painted, and a default expression has no access to the theme. An
	// explicit `colors` prop still wins.
	const series = useSeriesPalette();
	const cellColors = colors ?? series.sequence;
	const chartHeight = getChartHeight(height);
	const isEmpty = !data || data.length === 0;
	const tooltipStyles = getTooltipStyles(tooltipStyle);

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
				<PieChart>
					<Pie
						data={data}
						cx={cx}
						cy={cy}
						innerRadius={innerRadius}
						outerRadius={outerRadius}
						paddingAngle={paddingAngle}
						dataKey={dataKey}
						nameKey={nameKey}
						animationDuration={animationDuration}
						label={renderLabel}
						onClick={onPieClick}
					>
						{data.map((entry, index) => (
							<Cell
								key={`cell-${entry[cellKey ?? nameKey]}`}
								fill={cellColors[index % cellColors.length]}
							/>
						))}
					</Pie>
					<Tooltip
						contentStyle={tooltipStyles}
						formatter={tooltipFormatter as TooltipFormatterProp}
					/>
					{showLegend && (
						<Legend
							formatter={legendLabelFormatter}
							layout={legendLayout}
							align={legendAlign}
							verticalAlign={legendVerticalAlign}
						/>
					)}
				</PieChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
