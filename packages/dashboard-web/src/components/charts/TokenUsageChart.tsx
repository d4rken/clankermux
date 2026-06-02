import { formatTokens } from "@clankermux/ui-common";
import { COLORS, type TimeRange } from "../../constants";
import { formatCompactNumber } from "../../lib/chart-utils";
import { makeTimeTooltipLabelFormatter } from "../../lib/time-format";
import { BaseAreaChart } from "./BaseAreaChart";
import { longRangeAxisProps } from "./chart-utils";

interface TokenUsageChartProps {
	data: Array<{
		time: string;
		tokens: number;
		[key: string]: string | number;
	}>;
	loading?: boolean;
	height?: number;
	timeRange?: TimeRange;
}

export function TokenUsageChart({
	data,
	loading = false,
	height = 400,
	timeRange = "24h",
}: TokenUsageChartProps) {
	const gradient = (
		<linearGradient id="colorTokens" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stopColor={COLORS.primary} stopOpacity={0.9} />
			<stop offset="100%" stopColor={COLORS.primary} stopOpacity={0.1} />
		</linearGradient>
	);

	return (
		<BaseAreaChart
			data={data}
			dataKey="tokens"
			loading={loading}
			height={height}
			color={COLORS.primary}
			gradientId="colorTokens"
			customGradient={gradient}
			strokeWidth={2}
			{...longRangeAxisProps(timeRange)}
			yAxisTickFormatter={formatCompactNumber}
			tooltipFormatter={(value) => [formatTokens(value as number), "Tokens"]}
			tooltipLabelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
			animationDuration={1000}
		/>
	);
}
