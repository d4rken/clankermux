import { CHART_TOOLTIP_STYLE } from "../../constants";
import type { TooltipLabelFormatter } from "../../lib/chart-utils";
import type { TooltipFormatterValue } from "./types";

interface PayloadItem {
	dataKey: string;
	value: TooltipFormatterValue;
	name?: string;
	color?: string;
	// The full data row recharts attaches to each payload entry; lets a
	// labelFormatter derive a rich label from raw fields (e.g. `ts`).
	payload?: Record<string, unknown>;
}

interface ChartTooltipProps {
	active?: boolean;
	payload?: PayloadItem[];
	label?: string;
	formatters?: Record<string, (value: TooltipFormatterValue) => string>;
	/** Recharts-style label formatter; receives the label and payload rows. */
	labelFormatter?: TooltipLabelFormatter;
	style?: keyof typeof CHART_TOOLTIP_STYLE | object;
}

export function ChartTooltip({
	active,
	payload,
	label,
	formatters = {},
	labelFormatter,
	style = "default",
}: ChartTooltipProps) {
	if (!active || !payload?.length) {
		return null;
	}

	const tooltipStyle =
		typeof style === "string" ? CHART_TOOLTIP_STYLE[style] : style;

	const formattedLabel = labelFormatter
		? labelFormatter(
				label,
				payload as unknown as Parameters<TooltipLabelFormatter>[1],
			)
		: label;

	return (
		<div className="p-3 rounded-md shadow-lg" style={tooltipStyle}>
			{formattedLabel && <p className="font-medium mb-2">{formattedLabel}</p>}
			<div className="space-y-1">
				{payload.map((entry, index) => {
					const formatter = formatters[entry.dataKey] || formatters.default;
					const value = formatter ? formatter(entry.value) : entry.value;

					return (
						<div
							key={
								// biome-ignore lint/suspicious/noArrayIndexKey: index tiebreaks if a ComposedChart maps multiple payload entries (e.g. Line + Bar) to the same dataKey
								`${entry.dataKey}-${index}`
							}
							className="flex items-center gap-2"
						>
							<div
								className="w-3 h-3 rounded-full"
								style={{ backgroundColor: entry.color }}
							/>
							<span className="text-sm">
								{entry.name}: <strong>{value}</strong>
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}
