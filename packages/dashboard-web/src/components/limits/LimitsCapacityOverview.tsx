import type { KeyRunway, Outlook, PoolUsageResult } from "@clankermux/core";
import { effectiveRunwayOutcome, summarizeKeyRunways } from "@clankermux/core";
import { ChevronDown, Hourglass, Info } from "lucide-react";
import { describePinTarget } from "../../lib/api-key-pin-label";
import {
	describeRunwayCause,
	formatRunwayBand,
	formatRunwayValue,
	runwayQualifier,
	runwayUnavailableReason,
} from "../../lib/runway-display";
import { cn } from "../../lib/utils";
import { StatusChip } from "../accounts/StatusChip";
import { TONE_CLASSES } from "../quota/outlook-tone";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { InsetPanel } from "../ui/inset-panel";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { FiveHourPacingPanel } from "./FiveHourPacingPanel";
import { WeeklyBudgetPanel } from "./WeeklyBudgetPanel";

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
	// Worst STATEABLE key, not the worst outright: a key with no readable window
	// would otherwise replace a figure ten other keys have evidence for. The
	// count it was measured over is rendered beside it below, because dropping a
	// key can only make the surviving figure longer.
	const headline = summarizeKeyRunways(runways, now);
	const worst = headline.worst;
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
	// `worst === null` now covers two different situations, because the headline
	// ranks only the keys it can state: no active key AT ALL, or active keys none
	// of which has quota evidence. Reporting the first when it is the second
	// contradicts the per-key breakdown standing right underneath, which lists
	// the keys this line just claimed do not exist.
	const outcomeReason = dataResolved
		? worst === null
			? headline.activeKeyCount === 0
				? "No active API keys or accounts"
				: "No quota evidence for any account"
			: runwayUnavailableReason(worst.outcome)
		: null;
	const blockingReason = unavailableReason ?? outcomeReason;
	const stated = dataResolved && worst !== null && outcomeReason == null;
	const outlook = runwayOutlook(worst, blockingReason, loading, now);
	const toneClasses = TONE_CLASSES[outlook.tone];
	// Same reason as the Overview tile: the row-level `≥` asserts "at least this
	// long", and a key set aside for want of evidence could run out sooner.
	const value =
		worst && stated
			? formatRunwayValue(worst.outcome, now, {
					suppressBound: headline.unobservedKeyCount > 0,
				})
			: null;
	const qualifier =
		worst && stated ? runwayQualifier(worst.outcome, now) : null;
	const cause =
		worst && stated ? describeRunwayCause(worst.outcome, accounts, now) : null;
	// Text only here; the Overview card carries the shaded strip. The headline is
	// a single duration built on whole-percent readings, so the interval it
	// really lies in belongs on the line under it — see formatRunwayBand.
	const bandLabel =
		worst && stated ? formatRunwayBand(worst.band ?? null, now) : null;

	return (
		<section
			className="flex min-w-0 flex-col p-group"
			aria-label="Quota runway"
		>
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
							: [
									qualifier ?? "At the current pace",
									bandLabel,
									headline.unobservedKeyCount > 0
										? `${headline.unobservedKeyCount} key${headline.unobservedKeyCount === 1 ? "" : "s"} with no quota evidence`
										: null,
								]
									.filter(Boolean)
									.join(" · "))}
				</p>
			</div>

			<InsetPanel as="dl" className="mt-group grid grid-cols-2 divide-x p-0">
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
			</InsetPanel>

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
	const effective = effectiveRunwayOutcome(worst.outcome, now);
	switch (effective.kind) {
		case "out-now":
			// Same hedge the figure takes: accounts with no readable window are
			// dropped BEFORE the scan runs, so a pool that was not fully seen can
			// read as spent while a dropped account is healthy. A destructive chip
			// asserting a fact the evidence cannot support is worse than a warning
			// that says what was actually observed.
			return effective.unprojectableAccountIds.length > 0
				? { label: "Spent, unconfirmed", tone: "warning" }
				: { label: "Out of quota", tone: "destructive" };
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
	/**
	 * State of the `/api/accounts` read the two window panels are computed from.
	 * Scoped to those panels alone: it says nothing about the runway beside them,
	 * which comes from its own endpoint.
	 */
	windowsLoading?: boolean;
	windowsUnavailableReason?: string;
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
	windowsLoading = false,
	windowsUnavailableReason,
	runwaysLoading,
	runwaysUnavailableReason,
}: LimitsCapacityOverviewProps) {
	// Union of both windows' fallbacks. An account outside the 5-hour window is
	// not necessarily outside the weekly one — Codex reports a weekly window and
	// no 5-hour one — so listing either window's fallbacks alone would silently
	// drop accounts the panels above do not account for. Deduped by ACCOUNT ID,
	// since the same account appears in both lists when it has neither window —
	// and never by name, which is user-set and need not be unique: keying on it
	// dropped every account after the first that shared one.
	const fallbackNames = [
		...new Map(
			[...fiveHour.fallback, ...sevenDay.fallback].map((f) => [
				f.accountId,
				`${f.name} (${f.provider})`,
			]),
		).values(),
	];

	return (
		<Card>
			<CardHeader>
				<div className="flex items-start justify-between gap-row">
					<div className="min-w-0">
						<CardTitle>Quota overview</CardTitle>
						<CardDescription>
							Latest reported quota per servable class. This is polled quota
							state, not routing availability.
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
								Weekly budget: for each servable class (accounts that can cover
								for each other) the account with the most weekly room is the
								real constraint; the headline names the tightest class.
							</p>
							<p className="text-muted-foreground">
								5-hour pacing: how many accounts are currently held by the
								5-hour rate limit and when the earliest one lifts; 'running hot'
								means an account is projected to hit its 5-hour limit before it
								resets. Accounts without a reading are counted as unknown, never
								as 0%.
							</p>
							<p className="text-muted-foreground">
								Accounts not on a rolling quota are listed beneath the panels.
								Dashboard projections never control request routing.
							</p>
						</PopoverContent>
					</Popover>
				</div>
			</CardHeader>
			<CardContent>
				{/* Three panels: stacked and full-width on narrow viewports, side by
				    side once there is room for them. */}
				<div className="grid overflow-hidden rounded-md border divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
					<WeeklyBudgetPanel
						sevenDay={sevenDay}
						now={now}
						loading={windowsLoading}
						unavailableReason={windowsUnavailableReason}
					/>
					<FiveHourPacingPanel
						fiveHour={fiveHour}
						sevenDay={sevenDay}
						now={now}
						loading={windowsLoading}
						unavailableReason={windowsUnavailableReason}
					/>
					<RunwayPanel
						runways={runways}
						accounts={accounts}
						now={now}
						loading={runwaysLoading}
						unavailableReason={runwaysUnavailableReason}
					/>
				</div>
				{fallbackNames.length > 0 && (
					<p className="mt-row text-xs text-muted-foreground">
						Not on a rolling quota: {fallbackNames.join(", ")}
					</p>
				)}
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
