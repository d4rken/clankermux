import type { PoolAccountBar } from "@clankermux/core";
import { cn } from "../../lib/utils";

export type PoolClassBar = Omit<PoolAccountBar, "reason"> & {
	reason: string | null;
};

const REASON_SHORT: Record<string, string> = {
	paused: "paused",
	rate_limited: "cooling down",
	token_expired: "token expired",
	usage_rate_limited: "usage unavailable",
	five_hour_exhausted: "5h spent",
	seven_day_exhausted: "weekly spent",
	no_usage_data: "no reading",
};

function barTone(bar: PoolClassBar): string {
	if (bar.state !== "reporting" || bar.pct == null)
		return "bg-muted-foreground/30";
	if (bar.pct >= 90) return "bg-destructive";
	if (bar.pct >= 70) return "bg-warning";
	return "bg-success";
}

/** Per-account readings stay visible during temporary holds, with muted bars. */
export function PoolClassBars({
	accounts,
	leastUsedAccountId,
	formatPct = (pct) => `${Math.round(pct)}%`,
}: {
	accounts: PoolClassBar[];
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
				const reason = bar.reason
					? (REASON_SHORT[bar.reason] ?? bar.reason)
					: null;
				const pct = bar.pct;
				const status = reason && bar.pct != null ? ` · ${reason}` : "";
				const width = pct == null ? 100 : Math.max(0, Math.min(100, pct));
				return (
					<li
						key={bar.accountId}
						className={cn(
							"flex items-center gap-item text-xs",
							bar.state !== "reporting" && "text-muted-foreground",
						)}
						title={
							bar.pct == null
								? `${bar.name} — ${reason ?? "no reading"}`
								: `${bar.name} — ${formatPct(pct as number)} used${status}`
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
							aria-valuenow={pct ?? undefined}
							aria-valuetext={
								bar.pct == null
									? `${bar.name}: no reading`
									: `${bar.name}: ${formatPct(pct as number)} used${status}`
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
								"w-14 shrink-0 truncate text-right tabular-nums",
								bar.pct == null ? "text-muted-foreground" : undefined,
							)}
						>
							{bar.pct == null ? (reason ?? "—") : formatPct(pct as number)}
						</span>
						{reason && bar.pct != null && (
							<span className="max-w-24 shrink-0 truncate text-muted-foreground">
								{reason}
							</span>
						)}
					</li>
				);
			})}
		</ul>
	);
}
