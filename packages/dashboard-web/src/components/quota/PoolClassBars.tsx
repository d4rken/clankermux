import type { PoolAccountBar } from "@clankermux/core";
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
	formatPct = (pct) => `${Math.round(pct)}%`,
}: {
	accounts: PoolAccountBar[];
	/** Emphasised as the one the headline names. */
	leastUsedAccountId?: string | null;
	/**
	 * How a reading is SPOKEN, in the row title, the accessible value text and
	 * the trailing figure. Defaults to rounding.
	 *
	 * It exists so a card can print its bars in the same frame as its own
	 * headline: rounding here beneath a headline that floors showed 79.6% as
	 * "80%" on the bar and "79% used" above it, two readings of one number. The
	 * RAW value still drives the bar width and `aria-valuenow` — the quantity is
	 * unchanged, only its wording.
	 */
	formatPct?: (pct: number) => string;
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
								: `${bar.name} — ${formatPct(bar.pct)} used`
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
						{/* Explicit progressbar semantics. The panel this replaced used a
					    real <Progress>, and dropping to bare spans left the figures
					    available only as text beside a decorative bar — a screen reader
					    got no sense of magnitude, and an unknown reading was
					    indistinguishable from zero. `aria-valuenow` is omitted entirely
					    when there is no reading, which is how ARIA spells
					    "indeterminate". */}
						<span
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={bar.pct ?? undefined}
							aria-valuetext={
								bar.pct == null
									? `${bar.name}: no reading`
									: `${bar.name}: ${formatPct(bar.pct)} used`
							}
							className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
						>
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
								: formatPct(bar.pct)}
						</span>
					</li>
				);
			})}
		</ul>
	);
}
