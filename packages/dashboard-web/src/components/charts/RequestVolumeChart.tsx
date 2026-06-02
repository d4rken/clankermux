import { formatNumber } from "@clankermux/ui-common";
import { COLORS, type TimeRange } from "../../constants";
import { formatCompactNumber } from "../../lib/chart-utils";
import { makeTimeTooltipLabelFormatter } from "../../lib/time-format";
import { BaseAreaChart } from "./BaseAreaChart";
import { longRangeAxisProps } from "./chart-utils";

interface RequestVolumeChartProps {
	data: Array<{
		time: string;
		requests: number;
		[key: string]: string | number;
	}>;
	loading?: boolean;
	height?: number;
	timeRange?: TimeRange;
}

export function RequestVolumeChart({
	data,
	loading = false,
	height = 400,
	timeRange = "24h",
}: RequestVolumeChartProps) {
	return (
		<BaseAreaChart
			data={data}
			dataKey="requests"
			loading={loading}
			height={height}
			color={COLORS.primary}
			gradientId="colorRequests"
			strokeWidth={2}
			{...longRangeAxisProps(timeRange)}
			yAxisTickFormatter={formatCompactNumber}
			tooltipFormatter={(value) => [formatNumber(value as number), "Requests"]}
			tooltipLabelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
			animationDuration={1000}
		/>
	);
}
