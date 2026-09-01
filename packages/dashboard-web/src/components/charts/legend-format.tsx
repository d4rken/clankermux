import type { ReactNode } from "react";

/**
 * The label treatment for every chart legend in the app.
 *
 * Recharts' `DefaultLegendContent` sets the label's CSS `color` to the series
 * hue. The `--chart-*` tokens are designed to clear 3:1, the threshold for a
 * graphical object; used as ~14px text that is the wrong bar, and
 * `--chart-blue` (#0284c7) on white measures ~4.10:1. Wrapping the label in an
 * element that carries its own `color` beats the inherited inline style, so
 * the text reads at the foreground contrast while the swatch beside it keeps
 * the hue that identifies the series. Dark mode was already fine.
 *
 * Applied per `<Legend>` element rather than per consumer: the three Base
 * charts take a `showLegend` flag, so counting the flags would miss the
 * legends the Analytics panels and MemoryUsageChart render directly.
 */
export function legendLabelFormatter(value: ReactNode): ReactNode {
	return <span className="text-foreground">{value}</span>;
}
