import type { ReactNode } from "react";
import { CHART_HEIGHTS } from "../../constants";
import { cn } from "../../lib/utils";
import { Skeleton } from "../ui/skeleton";

interface ChartContainerProps {
	children: ReactNode;
	loading?: boolean;
	height?: keyof typeof CHART_HEIGHTS | number;
	className?: string;
	error?: Error | null;
	/**
	 * A string takes the one house empty-state treatment below. The `ReactNode`
	 * form stays for the structured cases (a sentence plus a link, say) — five
	 * spellings across three measures, two sizes and two alignments existed
	 * before the string form did.
	 */
	emptyState?: ReactNode;
	isEmpty?: boolean;
}

export function ChartContainer({
	children,
	loading = false,
	height = "medium",
	className,
	error = null,
	emptyState,
	isEmpty = false,
}: ChartContainerProps) {
	const chartHeight =
		typeof height === "number" ? height : CHART_HEIGHTS[height];

	if (error) {
		return (
			<div
				className={cn("flex items-center justify-center", className)}
				style={{ height: chartHeight }}
			>
				<div className="text-center space-y-item">
					<p className="text-sm text-destructive-strong">
						Error loading chart data
					</p>
					<p className="text-xs text-muted-foreground">{error.message}</p>
				</div>
			</div>
		);
	}

	if (loading) {
		// A Skeleton sized to the plot, not a spinning RefreshCw. This was the
		// third pending vocabulary in the app; the other 10+ surfaces already
		// stand in for their content with a pulsing block of its shape, which
		// also reserves the plot's box instead of centring an icon in it.
		return (
			<div className={className}>
				<Skeleton className="w-full" style={{ height: chartHeight }} />
			</div>
		);
	}

	if (isEmpty && emptyState) {
		return (
			<div
				className={cn("flex items-center justify-center", className)}
				style={{ height: chartHeight }}
			>
				{typeof emptyState === "string" ? (
					<p className="max-w-prose text-center text-sm text-muted-foreground">
						{emptyState}
					</p>
				) : (
					emptyState
				)}
			</div>
		);
	}

	return <div className={className}>{children}</div>;
}
