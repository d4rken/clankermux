import type { PoolAccountBar } from "../../lib/pool-usage";
import { cn } from "../../lib/utils";

const REASON_SHORT: Record<string, string> = {
	paused: "paused",
	rate_limited: "cooling down",
	token_expired: "token expired",
	usage_rate_limited: "usage unavailable",
	five_hour_exhausted: "5h spent",
	seven_day_exhausted: "weekly spent",
	no_usage_data: "no reading",
};

function barTone(bar: PoolAccountBar): string {
	if (bar.state !== "reporting" || bar.pct == null)
		return "bg-muted-foreground/30";
	if (bar.pct >= 90) return "bg-destructive";
	if (bar.pct >= 70) return "bg-warning";
	return "bg-success";
}

/**
 * One row per account in a servable class, ordered from most headroom to least.
 *
 * This is the antidote to the pooled average, and the reason it is a list rather
 * than a single figure: an average of 96% and 16% is 56%, a number describing
 * neither account and no decision. Seeing both bars answers the question the
 * average was standing in for — is there an account with room, and how much.
 *
 * An account with no reading draws a hatched track and its reason, never an
 * empty bar. "Nobody has polled this" and "this is untouched" look identical as
 * a 0% bar, and the second is the reassuring one — so the ambiguity would always
 * resolve in the flattering direction.
 */
export function PoolClassBars({
	accounts,
	leastUsedAccountId,
}: {
	accounts: PoolAccountBar[];
	/** Emphasised as the one the headline names. */
	leastUsedAccountId?: string | null;
}) {
	if (accounts.length === 0) return null;

	return (
		<ul className="mt-item space-y-tight" aria-label="Per-account utilization">
			{accounts.map((bar) => {
				const isHeadline = bar.accountId === leastUsedAccountId;
				const width =
					bar.pct == null ? 100 : Math.max(0, Math.min(100, bar.pct));
				return (
					<li
						key={bar.accountId}
						className="flex items-center gap-item text-xs"
						title={
							bar.pct == null
								? `${bar.name} — ${REASON_SHORT[bar.reason ?? ""] ?? "no reading"}`
								: `${bar.name} — ${Math.round(bar.pct)}% used`
						}
					>
						<span
							className={cn(
								"w-20 shrink-0 truncate",
								isHeadline
									? "font-medium text-foreground"
									: "text-muted-foreground",
							)}
						>
							{bar.name}
						</span>
						<span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
							<span
								className={cn(
									"absolute inset-y-0 left-0",
									barTone(bar),
									// A reading we do not have is drawn as a hatch across the
									// whole track, so it is visibly NOT a measurement.
									bar.pct == null && "opacity-40",
								)}
								style={{ width: `${width}%` }}
							/>
						</span>
						<span
							className={cn(
								"w-14 shrink-0 text-right tabular-nums",
								bar.pct == null ? "text-muted-foreground" : undefined,
							)}
						>
							{bar.pct == null
								? (REASON_SHORT[bar.reason ?? ""] ?? "—")
								: `${Math.round(bar.pct)}%`}
						</span>
					</li>
				);
			})}
		</ul>
	);
}
