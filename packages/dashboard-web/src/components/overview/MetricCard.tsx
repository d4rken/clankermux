import { formatPercentage } from "@clankermux/ui-common";
import {
	AlertCircle,
	Clock,
	Info,
	TrendingDown,
	TrendingUp,
} from "lucide-react";
import { Card, CardContent } from "../ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";

export interface MetricCardSubRow {
	label: string;
	value: string | number;
	tooltip?: string;
	inlineExplainer?: string; // when set, render as muted text below the value instead of a click-popover
}

export interface MetricCardProps {
	title: string;
	value: string | number;
	change?: number;
	icon: React.ComponentType<{ className?: string }>;
	trend?: "up" | "down" | "flat";
	trendPeriod?: string;
	subRows?: MetricCardSubRow[];
	caption?: string;
	/**
	 * Rendered directly under the value, above the sub-row divider. For a visual
	 * adornment the figure alone cannot carry — a scale it should be read
	 * against, say.
	 *
	 * Gated on the SAME resolved branch as the value and the sub-rows, so it can
	 * never appear beside a skeleton or an unavailable dash: anything drawn here
	 * is derived from the same read the figure is, and a read that failed or has
	 * not landed is entitled to draw neither.
	 */
	afterValue?: React.ReactNode;
	/**
	 * Set when the backing read FAILED and nothing is cached. Renders an
	 * explicit "unavailable" state in place of the value and sub-rows — a metric
	 * card must never present a fallback zero as a measurement.
	 */
	unavailableReason?: string;
	/**
	 * Set when the value is real but the most recent refresh failed. The numbers
	 * still render; the card says how old they are.
	 */
	staleNote?: string;
	/**
	 * Set while the FIRST fetch for this card's source is in flight and nothing
	 * is cached. The value, trend, stale note and sub-rows are replaced by
	 * placeholders; icon, title and caption stay so the grid does not reflow when
	 * the data lands.
	 *
	 * Precedence is `unavailableReason` → `loading` → resolved: a read that
	 * failed outright must never be presented as "still loading".
	 */
	loading?: boolean;
}

export function MetricCard({
	title,
	value,
	change,
	icon: Icon,
	trend,
	trendPeriod,
	subRows,
	caption,
	afterValue,
	unavailableReason,
	staleNote,
	loading = false,
}: MetricCardProps) {
	// See the `loading` prop doc: unavailable wins, so a failed read is never
	// dressed up as a pending one.
	const pending = loading && !unavailableReason;
	const trendElement = !pending && trend !== "flat" && change !== undefined && (
		<div
			className={`flex items-center gap-tight text-sm font-medium ${
				trend === "up" ? "text-success-strong" : "text-destructive-strong"
			}`}
		>
			{trend === "up" ? (
				<TrendingUp className="h-4 w-4" />
			) : (
				<TrendingDown className="h-4 w-4" />
			)}
			<span>{formatPercentage(Math.abs(change), 0)}</span>
		</div>
	);

	return (
		<Card>
			{/* p-4, not the bare default: CardContent ships `pt-0` so a header and a
			    body do not double their facing edges, and this card has no header.
			    Passing the padding explicitly is what lets tailwind-merge cancel
			    that `pt-0`. */}
			<CardContent className="p-4">
				<div className="flex items-center justify-between gap-item mb-1.5">
					<div className="flex items-center gap-item min-w-0">
						<Icon className="h-4 w-4 shrink-0 text-muted-foreground/40" />
						{/* The TITLE is the protected element: it is a short fixed
						    string, so it cannot overflow the card, while a caption is
						    caller-generated and unbounded. With the two reversed a long
						    caption won the row and truncated the title to nothing. */}
						<p className="text-sm text-muted-foreground shrink-0">{title}</p>
						{caption && (
							<span
								className="text-xs text-muted-foreground/70 truncate min-w-0"
								title={caption}
							>
								{caption}
							</span>
						)}
					</div>
					{trendPeriod && trendElement ? (
						<Popover>
							<PopoverTrigger asChild>
								<div className="flex items-center gap-tight cursor-help shrink-0">
									{trendElement}
									<Info className="h-3 w-3 text-muted-foreground" />
								</div>
							</PopoverTrigger>
							<PopoverContent className="w-auto p-2 text-xs">
								<p>Compared to {trendPeriod}</p>
							</PopoverContent>
						</Popover>
					) : (
						trendElement
					)}
				</div>
				{unavailableReason ? (
					<>
						<p className="figure-xl text-muted-foreground/60">—</p>
						<p className="mt-1 flex items-center gap-item text-xs text-warning-strong">
							<AlertCircle className="h-3.5 w-3.5 shrink-0" />
							{unavailableReason}
						</p>
					</>
				) : pending ? (
					// Matches the resolved value's line box (.figure-xl is a fixed
					// 1.75rem = h-7), so the tile keeps its height when the number
					// arrives.
					<Skeleton className="h-7 w-24" />
				) : (
					<>
						<p className="figure-xl">{value}</p>
						{afterValue}
					</>
				)}
				{pending && subRows && subRows.length > 0 && (
					<div className="mt-3 pt-3 border-t border-border/50 space-y-tight">
						{subRows.map((row) => (
							<Skeleton key={row.label} className="h-3 w-full" />
						))}
					</div>
				)}
				{!unavailableReason && !pending && staleNote && (
					<p className="mt-1 flex items-center gap-item text-xs text-muted-foreground">
						<Clock className="h-3.5 w-3.5 shrink-0" />
						{staleNote}
					</p>
				)}
				{!unavailableReason && !pending && subRows && subRows.length > 0 && (
					<div className="mt-3 pt-3 border-t border-border/50 space-y-tight">
						{subRows.map((row) => {
							if (row.inlineExplainer) {
								return (
									<div key={row.label} className="text-xs">
										<div className="flex items-baseline justify-between">
											<span className="text-muted-foreground">{row.label}</span>
											<span className="font-medium tabular-nums">
												{row.value}
											</span>
										</div>
										<p className="mt-0.5 text-muted-foreground/70">
											{row.inlineExplainer}
										</p>
									</div>
								);
							}
							return (
								<div
									key={row.label}
									className="flex items-baseline justify-between text-xs"
								>
									<span className="text-muted-foreground">{row.label}</span>
									{row.tooltip ? (
										<Popover>
											<PopoverTrigger asChild>
												<span className="font-medium tabular-nums cursor-help">
													{row.value}
												</span>
											</PopoverTrigger>
											<PopoverContent className="w-auto p-2 text-xs">
												<p>{row.tooltip}</p>
											</PopoverContent>
										</Popover>
									) : (
										<span className="font-medium tabular-nums">
											{row.value}
										</span>
									)}
								</div>
							);
						})}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
