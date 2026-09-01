import { formatTokens } from "@clankermux/ui-common";
import { CHART_TOKENS, type TimeRange } from "../../constants";
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
	return (
		<BaseAreaChart
			data={data}
			dataKey="tokens"
			loading={loading}
			height={height}
			color={CHART_TOKENS.primary}
			gradientId="colorTokens"
			strokeWidth={2}
			{...longRangeAxisProps(timeRange)}
			yAxisTickFormatter={formatCompactNumber}
			tooltipFormatter={(value) => [formatTokens(value as number), "Tokens"]}
			tooltipLabelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
			animationDuration={1000}
		/>
	);
}
