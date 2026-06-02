import { COLORS, type TimeRange } from "../../constants";
import { makeTimeTooltipLabelFormatter } from "../../lib/time-format";
import { BaseAreaChart } from "./BaseAreaChart";
import { longRangeAxisProps } from "./chart-utils";

interface ResponseTimeChartProps {
	data: Array<{
		time: string;
		responseTime: number;
		[key: string]: string | number;
	}>;
	loading?: boolean;
	height?: number;
	timeRange?: TimeRange;
}

export function ResponseTimeChart({
	data,
	loading = false,
	height = 400,
	timeRange = "24h",
}: ResponseTimeChartProps) {
	return (
		<BaseAreaChart
			data={data}
			dataKey="responseTime"
			loading={loading}
			height={height}
			color={COLORS.primary}
			strokeWidth={2}
			{...longRangeAxisProps(timeRange)}
			tooltipFormatter={(value) => [`${value}ms`, "Response Time"]}
			tooltipLabelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
			animationDuration={1000}
		/>
	);
}
