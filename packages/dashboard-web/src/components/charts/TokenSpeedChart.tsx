import { formatTokensPerSecond } from "@clankermux/ui-common";
import { CHART_TOKENS, type TimeRange } from "../../constants";
import { formatCompactNumber } from "../../lib/chart-utils";
import { makeTimeTooltipLabelFormatter } from "../../lib/time-format";
import { BaseAreaChart } from "./BaseAreaChart";
import { longRangeAxisProps } from "./chart-utils";

interface TokenSpeedChartProps {
	data: Array<{
		time: string;
		avgTokensPerSecond: number;
		[key: string]: string | number;
	}>;
	loading?: boolean;
	height?: number;
	timeRange?: TimeRange;
}

export function TokenSpeedChart({
	data,
	loading = false,
	height = 400,
	timeRange = "24h",
}: TokenSpeedChartProps) {
	// Filter out null values for better chart display
	const filteredData = data.map((point) => ({
		...point,
		avgTokensPerSecond: point.avgTokensPerSecond || 0,
	}));

	return (
		<BaseAreaChart
			data={filteredData}
			dataKey="avgTokensPerSecond"
			loading={loading}
			height={height}
			color={CHART_TOKENS.purple}
			gradientId="colorSpeed"
			strokeWidth={2}
			{...longRangeAxisProps(timeRange)}
			yAxisTickFormatter={formatCompactNumber}
			tooltipFormatter={(value) => [
				formatTokensPerSecond(value as number),
				"Output Speed",
			]}
			tooltipLabelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
			animationDuration={1000}
		/>
	);
}
