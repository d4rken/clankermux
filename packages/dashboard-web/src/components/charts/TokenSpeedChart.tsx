import { formatTokensPerSecond } from "@clankermux/ui-common";
import { COLORS, type TimeRange } from "../../constants";
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

	const gradient = (
		<linearGradient id="colorSpeed" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stopColor={COLORS.purple} stopOpacity={0.9} />
			<stop offset="100%" stopColor={COLORS.purple} stopOpacity={0.1} />
		</linearGradient>
	);

	return (
		<BaseAreaChart
			data={filteredData}
			dataKey="avgTokensPerSecond"
			loading={loading}
			height={height}
			color={COLORS.purple}
			gradientId="colorSpeed"
			customGradient={gradient}
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
