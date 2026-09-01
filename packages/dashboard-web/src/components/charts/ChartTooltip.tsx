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
	/**
	 * Overrides merged on top of the one token-defined tooltip surface, so a
	 * partial object keeps the token background, border and shadow.
	 */
	style?: object;
}

export function ChartTooltip({
	active,
	payload,
	label,
	formatters = {},
	labelFormatter,
	style,
}: ChartTooltipProps) {
	if (!active || !payload?.length) {
		return null;
	}

	const formattedLabel = labelFormatter
		? labelFormatter(
				label,
				payload as unknown as Parameters<TooltipLabelFormatter>[1],
			)
		: label;

	return (
		<div className="p-row" style={{ ...CHART_TOOLTIP_STYLE, ...style }}>
			{formattedLabel && (
				<p className="text-xs figure text-muted-foreground mb-item">
					{formattedLabel}
				</p>
			)}
			<div className="space-y-tight">
				{payload.map((entry, index) => {
					const formatter = formatters[entry.dataKey] || formatters.default;
					const value = formatter ? formatter(entry.value) : entry.value;

					return (
						<div
							key={
								// biome-ignore lint/suspicious/noArrayIndexKey: index tiebreaks if a ComposedChart maps multiple payload entries (e.g. Line + Bar) to the same dataKey
								`${entry.dataKey}-${index}`
							}
							className="flex items-center gap-item"
						>
							<div
								className="w-3 h-3 rounded-full"
								style={{ backgroundColor: entry.color }}
							/>
							<span className="text-sm">
								{entry.name}:{" "}
								<strong className="figure font-medium">{value}</strong>
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}
