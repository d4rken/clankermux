import type { KeyRunway } from "@clankermux/core";
import { effectiveRunwayOutcome, worstKeyRunway } from "@clankermux/core";
import { formatPercentage } from "@clankermux/ui-common";
import {
	AlertTriangle,
	BarChart3,
	ChevronDown,
	Gauge,
	Hourglass,
	Info,
} from "lucide-react";
import type { ComponentType } from "react";
import { describePinTarget } from "../../lib/api-key-pin-label";
import { formatDurationDhm } from "../../lib/format-prediction";
import type { PoolUsageResult, PoolWindow } from "../../lib/pool-usage";
import {
	describeRunwayCause,
	formatRunwayValue,
	runwayQualifier,
	runwayUnavailableReason,
} from "../../lib/runway-display";
import { cn } from "../../lib/utils";
import { StatusChip } from "../accounts/StatusChip";
import {
	familyWeeklyBadge,
	PoolDetailSection,
} from "../overview/PoolMetricCard";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Progress } from "../ui/progress";

type OutlookTone = "neutral" | "success" | "warning" | "destructive";

interface Outlook {
	label: string;
	tone: OutlookTone;
}

const TONE_CLASSES: Record<
	OutlookTone,
	{ chip: string; figure: string; progress: string }
> = {
	neutral: {
		chip: "bg-secondary text-secondary-foreground",
		figure: "text-muted-foreground",
		progress: "bg-muted-foreground/40",
	},
	success: {
		chip: "bg-success/15 text-success-strong",
		figure: "text-success-strong",
		progress: "bg-success",
	},
	warning: {
		chip: "bg-warning/15 text-warning-strong",
		figure: "text-warning-strong",
		progress: "bg-warning",
	},
	destructive: {
		chip: "bg-destructive/15 text-destructive-strong",
		figure: "text-destructive-strong",
		progress: "bg-destructive",
	},
};

function quotaOutlook(result: PoolUsageResult): Outlook {
	if (result.average == null) {
		return { label: "Account-wide unknown", tone: "neutral" };
	}

	const allUnavailable =
		result.contributing.length === 0 && result.exhausted.length > 0;

	if (result.average >= 100 || allUnavailable) {
		return { label: "Constrained", tone: "destructive" };
	}
	if (result.average >= 80) {
		return { label: "High usage", tone: "destructive" };
	}
	if (
		result.average >= 60 ||
		result.atRisk.length > 0 ||
		result.exhausted.length > 0 ||
		result.excluded.length > 0
	) {
		return { label: "Watch", tone: "warning" };
	}

	const everyReportingAccountCanBeProjected =
		result.contributing.length > 0 &&
		result.contributing.every((account) => account.resetMs != null);
	return everyReportingAccountCanBeProjected
		? { label: "On pace", tone: "success" }
		: { label: "Low usage", tone: "success" };
}

function formatCheckpointStamp(resetMs: number, window: PoolWindow): string {
	const reset = new Date(resetMs);
	return window === "seven_day"
		? reset.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			})
		: reset.toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			});
}

function countLabel(count: number, state: string): string {
	return `${count} ${state}`;
}

interface WindowPanelProps {
	title: string;
	icon: ComponentType<{ className?: string }>;
	result: PoolUsageResult;
	window: PoolWindow;
	now: number;
}

function WindowPanel({
	title,
	icon: Icon,
	result,
	window,
	now,
}: WindowPanelProps) {
	const outlook = quotaOutlook(result);
	const toneClasses = TONE_CLASSES[outlook.tone];
	const eligibleTotal =
		result.contributing.length +
		result.exhausted.length +
		result.excluded.length;
	const clampedAverage =
		result.average == null ? 0 : Math.max(0, Math.min(100, result.average));
	const checkpointRemaining =
		result.earliestResetMs == null
			? null
			: Math.max(0, result.earliestResetMs - now);
	const familyAlert = familyWeeklyBadge(result.familyWeekly);
	const hasBreakdown =
		result.contributing.length > 0 ||
		result.exhausted.length > 0 ||
		result.excluded.length > 0 ||
		result.fallback.length > 0 ||
		result.familyWeekly.length > 0;
	const reportingNotes = [
		result.exhausted.length > 0
			? countLabel(result.exhausted.length, "unavailable")
			: null,
		result.excluded.length > 0
			? countLabel(result.excluded.length, "unknown")
			: null,
	].filter((note): note is string => note != null);

	return (
		<section className="flex min-w-0 flex-col p-4" aria-label={title}>
			<div className="flex items-center justify-between gap-row">
				<div className="flex min-w-0 items-center gap-item">
					<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
					<h4 className="truncate text-sm font-medium">{title}</h4>
				</div>
				<StatusChip className={toneClasses.chip}>{outlook.label}</StatusChip>
			</div>

			<div className="mt-group">
				{result.average == null ? (
					<>
						<p className={cn("figure-xl", toneClasses.figure)}>—</p>
						<p className="mt-tight text-xs text-muted-foreground">
							No reported account-wide average
						</p>
					</>
				) : (
					<>
						<div className="flex items-baseline justify-between gap-row">
							<p className={cn("figure-xl", toneClasses.figure)}>
								{formatPercentage(result.average, 0)}
							</p>
							<p className="text-xs text-muted-foreground">
								Average quota used
							</p>
						</div>
						<Progress
							value={clampedAverage}
							className="mt-item h-2.5"
							indicatorClassName={toneClasses.progress}
							aria-label={`${title} average quota used`}
							aria-valuetext={`${formatPercentage(result.average, 0)} average quota used`}
						/>
					</>
				)}
			</div>

			<dl className="mt-group grid grid-cols-2 divide-x rounded-md border bg-muted/20">
				<div className="min-w-0 p-row">
					<dt className="label-caps">Reporting</dt>
					<dd className="mt-tight min-w-0">
						<span className="block truncate text-sm font-medium">
							{result.contributing.length} of {eligibleTotal} accounts
						</span>
						<span className="mt-tight block truncate text-xs text-muted-foreground">
							{reportingNotes.length > 0
								? reportingNotes.join(" · ")
								: eligibleTotal > 0
									? "All reporting"
									: "No eligible accounts"}
						</span>
					</dd>
				</div>
				<div className="min-w-0 p-row">
					<dt className="label-caps">Next checkpoint</dt>
					<dd
						className="mt-tight min-w-0"
						title={result.earliestResetAccountName ?? undefined}
					>
						<span className="block truncate text-sm font-medium">
							{checkpointRemaining == null
								? "—"
								: `in ${formatDurationDhm(checkpointRemaining)}`}
						</span>
						<span className="mt-tight block truncate text-xs text-muted-foreground">
							{result.earliestResetMs == null
								? "No checkpoint reported"
								: [
										result.earliestResetAccountName,
										formatCheckpointStamp(result.earliestResetMs, window),
									]
										.filter(Boolean)
										.join(" · ")}
						</span>
					</dd>
				</div>
			</dl>

			{(result.atRisk.length > 0 || familyAlert.label != null) && (
				<div className="mt-group space-y-item">
					{result.atRisk.length > 0 && (
						<div className="flex items-start gap-item rounded-md border border-warning/30 bg-warning/10 px-row py-item text-xs text-warning-strong">
							<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
							<span>
								{result.atRisk.length}{" "}
								{result.atRisk.length === 1 ? "account" : "accounts"} may
								exhaust before reset
							</span>
						</div>
					)}
					{familyAlert.label != null && (
						<div
							className={cn(
								"flex items-start gap-item rounded-md border px-row py-item text-xs",
								familyAlert.colorClass === "text-destructive-strong"
									? "border-destructive/30 bg-destructive/10 text-destructive-strong"
									: "border-warning/30 bg-warning/10 text-warning-strong",
							)}
						>
							<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
							<span>{familyAlert.label}</span>
						</div>
					)}
				</div>
			)}

			{hasBreakdown && (
				<div className="mt-auto pt-group">
					<details className="group border-t border-border/60 pt-item">
						<summary className="flex cursor-pointer list-none items-center justify-between gap-item rounded-sm py-tight text-xs font-medium text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
							Full breakdown
							<ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
						</summary>
						<div className="mt-item border-t border-border/50 pt-row text-xs">
							<PoolDetailSection result={result} window={window} />
						</div>
					</details>
				</div>
			)}
		</section>
	);
}

interface RunwayPanelProps {
	runways: KeyRunway[];
	accounts: { id: string; name: string }[];
	/**
	 * The tab's ticking clock. Rendered durations are derived from
	 * `outcome.exhaustsAtMs` against this, so a countdown served by
	 * `/api/runway` keeps running between polls rather than freezing at the
	 * server's snapshot.
	 */
	now: number;
	loading: boolean;
	/** Set when the runway read failed and nothing is cached. */
	unavailableReason?: string;
}

/**
 * How long the pool can keep going at the current pace before an API key has no
 * account with quota left, worst active key first.
 *
 * QUOTA, not availability: pauses, cooldowns, usage throttling and the
 * provider-overload breaker are deliberately not counted, so the copy here must
 * never promise routability.
 */
function RunwayPanel({
	runways,
	accounts,
	now,
	loading,
	unavailableReason,
}: RunwayPanelProps) {
	const worst = worstKeyRunway(runways, now);
	const activeRunways = runways.filter((runway) => runway.isActive);
	// Three distinct states, kept apart on purpose:
	//  - readBlocked: the backing read failed, or is still in flight. The parent
	//    computes runways from `apiKeys ?? []` either way, so `worst` is a
	//    SYNTHETIC row then — commonly the unauthenticated-pool one, whose
	//    outcome would render as a real figure. Nothing derived from it may be
	//    shown while this holds.
	//  - outcomeReason: the read resolved but the outcome cannot be stated. It
	//    replaces the figure, yet leaves the per-key breakdown standing, because
	//    one key's missing evidence must not hide another key's definite runway.
	//  - otherwise the outcome speaks for itself.
	// Precedence is unavailable -> loading -> resolved: a read that failed must
	// never be presented as still loading, and neither may render a fallback 0.
	const readBlocked = loading || unavailableReason != null;
	const dataResolved = !readBlocked;
	const outcomeReason = dataResolved
		? worst === null
			? "No active API keys or accounts"
			: runwayUnavailableReason(worst.outcome)
		: null;
	const blockingReason = unavailableReason ?? outcomeReason;
	const stated = dataResolved && worst !== null && outcomeReason == null;
	const outlook = runwayOutlook(worst, blockingReason, loading, now);
	const toneClasses = TONE_CLASSES[outlook.tone];
	const value = worst && stated ? formatRunwayValue(worst.outcome, now) : null;
	const qualifier =
		worst && stated ? runwayQualifier(worst.outcome, now) : null;
	const cause =
		worst && stated ? describeRunwayCause(worst.outcome, accounts, now) : null;

	return (
		<section className="flex min-w-0 flex-col p-4" aria-label="Quota runway">
			<div className="flex items-center justify-between gap-row">
				<div className="flex min-w-0 items-center gap-item">
					<Hourglass className="h-4 w-4 shrink-0 text-muted-foreground" />
					<h4 className="truncate text-sm font-medium">Quota runway</h4>
				</div>
				<StatusChip className={toneClasses.chip}>{outlook.label}</StatusChip>
			</div>

			<div className="mt-group">
				<div className="flex items-baseline justify-between gap-row">
					<p className={cn("figure-xl", toneClasses.figure)}>{value ?? "—"}</p>
					<p className="text-xs text-muted-foreground">Until a key runs dry</p>
				</div>
				<p className="mt-tight text-xs text-muted-foreground">
					{blockingReason ??
						(loading
							? "Reading keys and accounts"
							: (qualifier ?? "At the current pace"))}
				</p>
			</div>

			<dl className="mt-group grid grid-cols-2 divide-x rounded-md border bg-muted/20">
				<div className="min-w-0 p-row">
					<dt className="label-caps">Eligible accounts</dt>
					<dd className="mt-tight min-w-0">
						<span className="block truncate text-sm font-medium">
							{worst && stated
								? `${worst.eligibleAccountIds.length} ${
										worst.eligibleAccountIds.length === 1
											? "account"
											: "accounts"
									}`
								: "—"}
						</span>
						<span className="mt-tight block truncate text-xs text-muted-foreground">
							{worst && stated
								? describePinTarget(worst.pin, accounts)
								: "Not reported"}
						</span>
					</dd>
				</div>
				<div className="min-w-0 p-row">
					<dt className="label-caps">Binding window</dt>
					<dd className="mt-tight min-w-0" title={cause ?? undefined}>
						<span className="block truncate text-sm font-medium">
							{cause ?? "—"}
						</span>
						<span className="mt-tight block truncate text-xs text-muted-foreground">
							{stated
								? cause == null
									? "No run-out projected"
									: "First to run out"
								: "Not reported"}
						</span>
					</dd>
				</div>
			</dl>

			{activeRunways.length > 0 && dataResolved && (
				<div className="mt-auto pt-group">
					<details className="group border-t border-border/60 pt-item">
						<summary className="flex cursor-pointer list-none items-center justify-between gap-item rounded-sm py-tight text-xs font-medium text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
							Full breakdown
							<ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
						</summary>
						<div className="mt-item border-t border-border/50 pt-row text-xs">
							<ul className="space-y-tight">
								{activeRunways.map((runway) => (
									<li
										key={runway.keyId ?? runway.keyName}
										className="flex items-baseline justify-between gap-item"
									>
										<span className="min-w-0 truncate">
											<span className="font-medium">{runway.keyName}</span>
											<span className="text-muted-foreground">
												{" · "}
												{describePinTarget(runway.pin, accounts)}
												{" · "}
												{runway.eligibleAccountIds.length}{" "}
												{runway.eligibleAccountIds.length === 1
													? "account"
													: "accounts"}
											</span>
										</span>
										<span className="shrink-0 tabular-nums">
											{formatRunwayValue(runway.outcome, now) ??
												runwayUnavailableReason(runway.outcome) ??
												"—"}
										</span>
									</li>
								))}
							</ul>
						</div>
					</details>
				</div>
			)}
		</section>
	);
}

/**
 * Chip for the runway panel, in the same idiom as {@link quotaOutlook}: a
 * projected run-out inside the modelled horizon is worth watching, no projected
 * run-out is the reassuring case, and anything unreadable stays neutral rather
 * than borrowing a severity it has not earned.
 */
function runwayOutlook(
	worst: KeyRunway | null,
	blockingReason: string | null,
	loading: boolean,
	now: number,
): Outlook {
	if (loading && blockingReason == null) {
		return { label: "Loading", tone: "neutral" };
	}
	if (blockingReason != null || worst === null) {
		return { label: "Runway unknown", tone: "neutral" };
	}
	// Read the outcome AT `now`, so a served runway whose deadline has passed
	// takes the out-of-quota chip rather than still reading "Runs out".
	switch (effectiveRunwayOutcome(worst.outcome, now).kind) {
		case "out-now":
			return { label: "Out of quota", tone: "destructive" };
		case "runway":
			return { label: "Runs out", tone: "warning" };
		default:
			return { label: "No run-out projected", tone: "success" };
	}
}

interface LimitsCapacityOverviewProps {
	fiveHour: PoolUsageResult;
	sevenDay: PoolUsageResult;
	now: number;
	/** Per-key runway rows, straight from `/api/runway`. */
	runways: KeyRunway[];
	/** Account names for the pin labels and causes, from the same response. */
	accounts: { id: string; name: string }[];
	runwaysLoading: boolean;
	runwaysUnavailableReason?: string;
}

/**
 * Limits-page headline for the two rolling quota classes. The default view is
 * deliberately a summary; the account audit remains available in the native
 * disclosures and in the full Account Utilization card immediately below.
 */
export function LimitsCapacityOverview({
	fiveHour,
	sevenDay,
	now,
	runways,
	accounts,
	runwaysLoading,
	runwaysUnavailableReason,
}: LimitsCapacityOverviewProps) {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-start justify-between gap-row">
					<div className="min-w-0">
						<CardTitle>Quota overview</CardTitle>
						<CardDescription>
							Latest reported usage across rolling quota accounts. This is
							polled quota state, not routing availability.
						</CardDescription>
					</div>
					<Popover>
						<PopoverTrigger asChild>
							<button
								type="button"
								aria-label="About quota calculations"
								className="shrink-0 rounded-md p-item text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<Info className="h-4 w-4" />
							</button>
						</PopoverTrigger>
						<PopoverContent align="end" className="space-y-item text-xs">
							<p className="font-medium">How the overview is calculated</p>
							<p className="text-muted-foreground">
								Each percentage is an equal-weight average. Reporting accounts
								use their latest window percentage; eligible accounts currently
								unavailable count as 100% used. Accounts without usage evidence
								are marked unknown and omitted from the average.
							</p>
							<p className="text-muted-foreground">
								Pay-as-you-go accounts and providers without this rolling window
								are not part of its figure. The next checkpoint may be a quota
								reset, cooldown expiry, or usage-poll retry deadline. Dashboard
								projections never control request routing.
							</p>
						</PopoverContent>
					</Popover>
				</div>
			</CardHeader>
			<CardContent>
				{/* Three panels: stacked and full-width on narrow viewports, side by
				    side once there is room for them. */}
				<div className="grid overflow-hidden rounded-md border divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
					<WindowPanel
						title="5-hour window"
						icon={Gauge}
						result={fiveHour}
						window="five_hour"
						now={now}
					/>
					<WindowPanel
						title="7-day window"
						icon={BarChart3}
						result={sevenDay}
						window="seven_day"
						now={now}
					/>
					<RunwayPanel
						runways={runways}
						accounts={accounts}
						now={now}
						loading={runwaysLoading}
						unavailableReason={runwaysUnavailableReason}
					/>
				</div>
				<div className="mt-row flex justify-end">
					<a
						href="#account-utilization"
						className="text-xs font-medium text-primary underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						View account usage
					</a>
				</div>
			</CardContent>
		</Card>
	);
}
