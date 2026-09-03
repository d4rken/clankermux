import { AlertCircle, Gauge } from "lucide-react";
import {
	type ClassPacing,
	computeFiveHourPacing,
} from "../../lib/five-hour-pacing";
import { formatDurationDhm } from "../../lib/format-prediction";
import type { Outlook, PoolUsageResult } from "../../lib/pool-usage";
import { cn } from "../../lib/utils";
import { StatusChip } from "../accounts/StatusChip";
import { TONE_CLASSES } from "../quota/outlook-tone";
import { Skeleton } from "../ui/skeleton";

interface FiveHourPacingPanelProps {
	fiveHour: PoolUsageResult;
	/** The weekly result, so an account spent on BOTH windows is not sold as merely waiting. */
	sevenDay: PoolUsageResult;
	now: number;
	loading: boolean;
	unavailableReason?: string;
}

/** The segment list for one class row. Zero counts are omitted, except "with room". */
function rowSegments(pacing: ClassPacing): string {
	// A class with no reading at all would otherwise render as "0 with room",
	// which states a measured absence of capacity rather than an absent
	// measurement.
	if (
		pacing.room === 0 &&
		pacing.waiting === 0 &&
		pacing.unavailable === 0 &&
		pacing.unknown > 0
	) {
		return "no 5h reading";
	}
	const segments = [`${pacing.room} with room`];
	if (pacing.runningHot > 0) segments.push(`${pacing.runningHot} running hot`);
	if (pacing.waiting > 0) segments.push(`${pacing.waiting} waiting`);
	if (pacing.unavailable > 0)
		segments.push(`${pacing.unavailable} unavailable`);
	if (pacing.unknown > 0) segments.push(`${pacing.unknown} unknown`);
	return segments.join(" · ");
}

/**
 * How hard the 5-hour rate limit is pacing the pool right now.
 *
 * The 5-hour window is a GOVERNOR, not a budget: an account it holds comes back
 * on its own, usually within the hour, and no amount of waiting for it creates
 * weekly capacity. So the headline is a COUNT of held accounts and the time the
 * first one lifts — not a percentage, which would invite the reader to compare
 * it against the weekly figure beside it as though the two were the same
 * quantity.
 *
 * A resolved zero renders "0", never "—". Nobody waiting is the reassuring
 * answer, and a dash would hide it behind the same glyph an unread pool shows.
 */
export function FiveHourPacingPanel({
	fiveHour,
	sevenDay,
	now,
	loading,
	unavailableReason,
}: FiveHourPacingPanelProps) {
	const pending = loading && unavailableReason == null;
	const resolved = !pending && unavailableReason == null;
	const pacing = computeFiveHourPacing(fiveHour, sevenDay, now);
	const outlook: Outlook = resolved
		? pacing.outlook
		: { label: pending ? "Loading" : "Unavailable", tone: "neutral" };
	const toneClasses = TONE_CLASSES[outlook.tone];

	const subLine =
		pacing.nextLiftMs != null
			? `next lift in ${formatDurationDhm(pacing.nextLiftMs - now)}${
					pacing.nextLiftAccountName ? ` · ${pacing.nextLiftAccountName}` : ""
				}`
			: pacing.waiting === 0
				? "Nothing waiting to lift"
				: "Lift time not reported";

	return (
		<section
			className="flex min-w-0 flex-col p-group"
			aria-label="5-hour pacing"
		>
			<div className="flex items-center justify-between gap-row">
				<div className="flex min-w-0 items-center gap-item">
					<Gauge className="h-4 w-4 shrink-0 text-muted-foreground" />
					<h4 className="truncate text-sm font-medium">5-hour pacing</h4>
				</div>
				<StatusChip className={toneClasses.chip}>{outlook.label}</StatusChip>
			</div>

			<div className="mt-group">
				{unavailableReason != null ? (
					<>
						<p className="figure-xl text-muted-foreground">—</p>
						<p className="mt-tight flex items-center gap-item text-xs text-warning-strong">
							<AlertCircle className="h-3.5 w-3.5 shrink-0" />
							{unavailableReason}
						</p>
					</>
				) : pending ? (
					<>
						{/* Same line box as the resolved headline, so the panel keeps its
						    height when the accounts land. */}
						<Skeleton className="h-7 w-20" />
						<p className="mt-tight text-xs text-muted-foreground">
							Reading accounts
						</p>
					</>
				) : fiveHour.classes.length === 0 ? (
					<>
						<p className="figure-xl text-muted-foreground">—</p>
						<p className="mt-tight text-xs text-muted-foreground">
							No rolling-quota accounts
						</p>
					</>
				) : (
					<>
						<div className="flex items-baseline justify-between gap-row">
							<p className={cn("figure-xl", toneClasses.figure)}>
								{pacing.waiting}
							</p>
							<p className="text-xs text-muted-foreground">
								{pacing.waiting === 1
									? "account waiting on 5h"
									: "accounts waiting on 5h"}
							</p>
						</div>
						<p className="mt-tight truncate text-xs text-muted-foreground">
							{subLine}
						</p>
					</>
				)}
			</div>

			{resolved && pacing.classes.length > 0 && (
				<ul
					className="mt-group space-y-item"
					aria-label="5-hour pacing by class"
				>
					{pacing.classes.map((pool) => (
						<li
							key={pool.classId}
							className={cn(
								"min-w-0 truncate text-xs",
								pool.noPath
									? "text-destructive-strong"
									: "text-muted-foreground",
							)}
						>
							<span className={pool.noPath ? undefined : "text-foreground"}>
								{pool.label}
							</span>
							{" · "}
							{rowSegments(pool)}
							{pool.noPath && pool.nextLiftMs != null
								? ` · lifts in ${formatDurationDhm(pool.nextLiftMs - now)}`
								: null}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
