import type { ComponentProps } from "react";
import type { Tooltip as RechartsTooltip } from "recharts";

/**
 * Format numbers in compact notation for chart axes
 * 1000 -> 1k
 * 1000000 -> 1M
 * 1000000000 -> 1B
 */
export function formatCompactNumber(value: number | string): string {
	const numValue = typeof value === "string" ? Number(value) : value;
	if (Number.isNaN(numValue)) return String(value);

	const absValue = Math.abs(numValue);
	const sign = numValue < 0 ? "-" : "";

	if (absValue >= 1e9) {
		return `${sign}${(absValue / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
	}
	if (absValue >= 1e6) {
		return `${sign}${(absValue / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (absValue >= 1e3) {
		return `${sign}${(absValue / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
	}
	return `${sign}${absValue.toString()}`;
}

/**
 * Format currency in compact notation
 * $1234 -> $1.2k
 */
export function formatCompactCurrency(value: number | string): string {
	return `$${formatCompactNumber(value)}`;
}

/**
 * Recharts `<Tooltip>` prop types.
 *
 * recharts v3.8 widened `formatter` to accept `value: ValueType | undefined`
 * and `labelFormatter` to accept `label: ReactNode`. Our inline callbacks use
 * narrower parameter types, so they are cast to these prop types at the call
 * site. Deriving the types from the component props keeps them in sync with the
 * installed recharts version without resorting to `any`.
 */
type TooltipPropsType = ComponentProps<typeof RechartsTooltip>;
export type TooltipFormatter = NonNullable<TooltipPropsType["formatter"]>;
export type TooltipLabelFormatter = NonNullable<
	TooltipPropsType["labelFormatter"]
>;
