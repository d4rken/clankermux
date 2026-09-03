import { formatPercentage } from "@clankermux/ui-common";
import { AlertCircle, Clock, Info } from "lucide-react";
import {
	eligibleAccountTotal,
	type PoolUsageResult,
	type PoolWindow,
	poolOutlook,
	willRunOutCount,
} from "../../lib/pool-usage";
import { cn } from "../../lib/utils";
import { TONE_FIGURE_CLASS } from "../quota/outlook-tone";
import {
	atRiskBadge,
	familyWeeklyBadge,
	PoolDetailSection,
	windowTimeLabel,
} from "../quota/PoolDetailSection";
import { Card, CardContent } from "../ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";

interface PoolMetricCardProps {
	title: string;
	icon: React.ComponentType<{ className?: string }>;
	result: PoolUsageResult;
	window: PoolWindow;
	/**
	 * Set while the first `/api/accounts` fetch is in flight and nothing is
	 * cached.
	 *
	 * Required rather than inferable from `result`: `computePoolUsage([], …)`
	 * returns an all-empty result that is indistinguishable from "no accounts
	 * contribute to this pool" — a claim this card must not make about accounts
	 * it has not read yet.
	 */
	loading?: boolean;
	/**
	 * Set when that read FAILED with nothing cached. Same reasoning as `loading`:
	 * an empty pool would read as measured capacity of zero.
	 *
	 * Precedence is `unavailableReason` → `loading` → resolved.
	 */
	unavailableReason?: string;
	/**
	 * Set when the pool is real but the most recent `/api/accounts` refresh
	 * failed. The quota numbers, next-checkpoint line and badges still render;
	 * the card says how old they are.
	 */
	staleNote?: string;
}

export function PoolMetricCard({
	title,
	icon: Icon,
	result,
	window,
	loading = false,
	unavailableReason,
	staleNote,
}: PoolMetricCardProps) {
	const { average, contributing, earliestResetMs, familyWeekly } = result;

	// Both derivations come from lib/pool-usage so this card and the Usage
	// panel cannot answer the same question differently — they used to, with
	// two at-risk numerators and two colour rules for one number.
	const eligibleTotal = eligibleAccountTotal(result);
	const { willRunOut, capacity } = willRunOutCount(result);
	const { label: willRunOutText, colorClass: willRunOutColor } = atRiskBadge(
		willRunOut,
		capacity,
	);
	const { label: familyWeeklyText, colorClass: familyWeeklyColor } =
		familyWeeklyBadge(familyWeekly);
	// See the prop docs: an unread account list must not be rendered as a
	// measured pool, and a failed read wins over a pending one.
	const pending = loading && !unavailableReason;
	const resolved = !pending && !unavailableReason;
	const showChip = resolved && eligibleTotal > 0;
	const colorClass = TONE_FIGURE_CLASS[poolOutlook(result).tone];
	const headline = average != null ? formatPercentage(average, 0) : "—";
	const nextCheckpointText =
		!resolved || earliestResetMs == null
			? null
			: `next checkpoint at ${windowTimeLabel(earliestResetMs, window)}`;

	const triggerNode = showChip ? (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="flex items-center gap-tight shrink-0 text-xs text-muted-foreground cursor-help focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
				>
					<span className="tabular-nums">
						({contributing.length}/{eligibleTotal} active)
					</span>
					<Info className="h-3 w-3" />
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-72 text-xs space-y-row">
				<PoolDetailSection result={result} window={window} />
			</PopoverContent>
		</Popover>
	) : null;

	return (
		<Card>
			{/* p-4, not the bare default: CardContent ships `pt-0` so a header and a
			    body do not double their facing edges, and this card has no header.
			    Passing the padding explicitly is what lets tailwind-merge cancel
			    that `pt-0`.

			    The floor is the common RESOLVED tile, summed from its own line
			    boxes so the ordinary pending→resolved transition moves nothing:
			    1.25rem title row + 0.25rem (mb-tight) + 1.75rem headline
			    (.figure-xl's pinned line box, which the h-7 skeleton matches)
			    + 0.25rem + 1rem "capacity used" + 0.25rem + 1rem next-checkpoint
			    line + 2rem padding = 7.75rem. The checkpoint line is in the sum
			    because it is what the pending state is missing; it is still only
			    drawn once resolved.

			    A FLOOR, not a fixed height, and the residual is larger here than
			    on MetricCard: the stale note, the at-risk line and the
			    family-weekly line are each conditional on data that a RESOLVED
			    read may or may not contain, so a resolved tile can legitimately
			    stand three lines taller than this. */}
			<CardContent className="p-4 min-h-[7.75rem]">
				<div className="flex items-center justify-between gap-item mb-tight">
					<div className="flex items-center gap-item min-w-0">
						<Icon className="h-4 w-4 shrink-0 text-muted-foreground/40" />
						<p className="text-sm text-muted-foreground truncate">{title}</p>
					</div>
					{triggerNode}
				</div>
				<div className="space-y-tight">
					{unavailableReason ? (
						<>
							<p className="figure-xl text-muted-foreground/60">—</p>
							<p className="flex items-center gap-item text-xs text-warning-strong">
								<AlertCircle className="h-3.5 w-3.5 shrink-0" />
								{unavailableReason}
							</p>
						</>
					) : pending ? (
						// Same line box as the resolved headline (.figure-xl is a fixed
						// 1.75rem = h-7), so the tile keeps its height when the accounts
						// land.
						<Skeleton className="h-7 w-20" />
					) : (
						<p className={cn("figure-xl", colorClass)}>{headline}</p>
					)}
					<p className="text-xs text-muted-foreground truncate">
						capacity used
					</p>
					{resolved && staleNote && (
						<p className="flex items-center gap-item text-xs text-muted-foreground">
							<Clock className="h-3.5 w-3.5 shrink-0" />
							{staleNote}
						</p>
					)}
					{nextCheckpointText && (
						<p className="text-xs text-muted-foreground truncate">
							{nextCheckpointText}
						</p>
					)}
					{resolved && willRunOutText && (
						<p className={cn("text-xs truncate", willRunOutColor)}>
							{willRunOutText}
						</p>
					)}
					{resolved && familyWeeklyText && (
						<p className={cn("text-xs truncate", familyWeeklyColor)}>
							{familyWeeklyText}
						</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
