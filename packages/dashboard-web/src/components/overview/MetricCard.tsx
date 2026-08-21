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
	unavailableReason,
	staleNote,
	loading = false,
}: MetricCardProps) {
	// See the `loading` prop doc: unavailable wins, so a failed read is never
	// dressed up as a pending one.
	const pending = loading && !unavailableReason;
	const trendElement = !pending && trend !== "flat" && change !== undefined && (
		<div
			className={`flex items-center gap-1 text-sm font-medium ${
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
			<CardContent className="p-4">
				<div className="flex items-center justify-between gap-2 mb-1.5">
					<div className="flex items-center gap-1.5 min-w-0">
						<Icon className="h-4 w-4 shrink-0 text-muted-foreground/40" />
						<p className="text-sm text-muted-foreground truncate">{title}</p>
						{caption && (
							<span className="text-xs text-muted-foreground/70 shrink-0">
								{caption}
							</span>
						)}
					</div>
					{trendPeriod && trendElement ? (
						<Popover>
							<PopoverTrigger asChild>
								<div className="flex items-center gap-1 cursor-help shrink-0">
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
						<p className="text-2xl font-bold text-muted-foreground/60">—</p>
						<p className="mt-1 flex items-center gap-1.5 text-xs text-warning-strong">
							<AlertCircle className="h-3.5 w-3.5 shrink-0" />
							{unavailableReason}
						</p>
					</>
				) : pending ? (
					// Matches the resolved value's line box (text-2xl ⇒ 2rem), so the
					// tile keeps its height when the number arrives.
					<Skeleton className="h-8 w-24" />
				) : (
					<p className="text-2xl font-bold">{value}</p>
				)}
				{pending && subRows && subRows.length > 0 && (
					<div className="mt-3 pt-3 border-t border-border/50 space-y-1">
						{subRows.map((row) => (
							<Skeleton key={row.label} className="h-3 w-full" />
						))}
					</div>
				)}
				{!unavailableReason && !pending && staleNote && (
					<p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
						<Clock className="h-3.5 w-3.5 shrink-0" />
						{staleNote}
					</p>
				)}
				{!unavailableReason && !pending && subRows && subRows.length > 0 && (
					<div className="mt-3 pt-3 border-t border-border/50 space-y-1">
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
