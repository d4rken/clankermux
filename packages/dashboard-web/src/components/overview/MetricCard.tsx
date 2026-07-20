import { formatPercentage } from "@clankermux/ui-common";
import { Info, TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent } from "../ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

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
}: MetricCardProps) {
	const trendElement = trend !== "flat" && change !== undefined && (
		<div
			className={`flex items-center gap-1 text-sm font-medium ${
				trend === "up" ? "text-success" : "text-destructive"
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
				<p className="text-2xl font-bold">{value}</p>
				{subRows && subRows.length > 0 && (
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
