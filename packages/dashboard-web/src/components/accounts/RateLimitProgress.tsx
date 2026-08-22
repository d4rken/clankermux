import { computeWindowStartMs, registerUIRefresh } from "@clankermux/core";
import type {
	AccountUsagePrediction,
	FullUsageData,
	StaleUsageInfo,
	UsagePrediction,
} from "@clankermux/types";
import { isUsablePrediction } from "@clankermux/types";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
	formatDuration,
	formatPredictionMessage,
	type ProjectedUsage,
	type ProjectionTone,
	RESETS_BEFORE_EXHAUSTION_MESSAGE,
} from "../../lib/format-prediction";
import {
	classifyUsageCard,
	usageWindowCategoryKey,
	usageWindowLabel,
} from "../../lib/usage-windows";
import { cn } from "../../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Progress } from "../ui/progress";

interface RateLimitProgressProps {
	resetIso: string | null;
	usageUtilization?: number | null; // Actual utilization from API (0-100)
	usageWindow?: string | null; // Window name (e.g., "five_hour")
	usageData?: FullUsageData | null; // Full usage data from API
	staleUsage?: StaleUsageInfo | null; // Last-known weekly usage when live data is unavailable
	usageAsOfIso?: string | null; // When the live reading in usageData was sampled
	usageRateLimitedUntil?: number | null; // Timestamp (ms) until usage API 429 clears
	usageThrottledUntil?: number | null; // Timestamp (ms) until proactive usage throttling clears
	usageThrottledWindows?: string[]; // Exact usage windows currently being throttled
	provider: string;
	className?: string;
	showWeekly?: boolean; // Whether to show weekly usage as well
	inlineProjection?: boolean; // Render projection message as visible text instead of a click popover
	prediction?: AccountUsagePrediction | null; // Server-computed regression prediction (Anthropic 5h/7d only)
	compact?: boolean; // Tighter card padding and a single-row window strip on wide viewports
	// Still-future reset endpoints per window category across all accounts on the
	// page, from `computeWindowResetExtremes`. Matching countdowns are emphasized
	// as the first (green) or last (red) capacity to return. Omitted when the card
	// renders alone, where there is nothing to compare.
	earliestResets?: ReadonlyMap<string, number>;
	latestResets?: ReadonlyMap<string, number>;
}

// Maps a render-loop window name to its server-computed prediction. Only the
// primary Anthropic 5-hour and (unscoped) weekly windows have a server
// prediction; scoped-weekly and all non-Anthropic windows return undefined and
// fall through to the legacy single-snapshot projection.
function predictionForWindow(
	prediction: AccountUsagePrediction | null | undefined,
	window: string | null,
): UsagePrediction | undefined {
	if (!prediction || !window) return undefined;
	if (window === "five_hour") return prediction.fiveHour;
	if (window === "seven_day") return prediction.sevenDay;
	return undefined;
}

// How old a LIVE reading may get before its age is worth surfacing. Mirrors the
// server's routing freshness TTL (USAGE_CACHE_TTL_MS in @clankermux/providers,
// which the browser bundle deliberately does not depend on): under it the value
// is "current" and an age annotation would be noise; over it the reading is
// still shown — it is real data, just older — but labelled with its "as of"
// time so nobody reads a stale number as current. Genuinely absent live data is
// a different state entirely and keeps the amber last-known-snapshot fallback.
const LIVE_USAGE_FRESH_MS = 10 * 60 * 1000;

// Each usage window renders as its own card. Primary windows (the 5-hour and
// unscoped weekly quota) get a filled muted card; the secondary,
// model-family-specific weekly cards are left unfilled (outline only). A
// filled-vs-outline distinction reads clearly in BOTH light and dark themes,
// whereas a mere opacity difference on `bg-muted` is near-invisible in light
// mode (muted is ~96% lightness, so it barely differs from a white surface).
const WINDOW_CARD_CLASS = "rounded-lg border p-3";
// Compact variant: same card, two fewer pixels of padding on every side. Used
// by the Accounts list, where a dozen accounts stack vertically and the padding
// is paid once per window card per account. The Limits tab keeps the roomy
// default — it shows one account's quota at a time and has the space.
const COMPACT_WINDOW_CARD_CLASS = "rounded-lg border p-2";
const PRIMARY_WINDOW_TINT = "border-border/60 bg-muted/50";
const SECONDARY_WINDOW_TINT = "border-border/50 bg-transparent";

// The three standalone message blocks (rate-limited, stale, Kilo credits) all
// render as a single primary card. They sit behind early returns, so they take
// the density from the same `compact` flag rather than from the per-window
// values computed further down.
function primaryCardClass(compact: boolean): string {
	return cn(
		compact ? COMPACT_WINDOW_CARD_CLASS : WINDOW_CARD_CLASS,
		PRIMARY_WINDOW_TINT,
		compact ? "space-y-tight" : "space-y-item",
	);
}

function computeExpectedPct(
	resetTime: string | null,
	window: string | null,
	now: number,
): number | null {
	if (!resetTime || !window) return null;
	const resetMs = new Date(resetTime).getTime();
	const startMs = computeWindowStartMs(resetMs, window);
	if (startMs === null) return null;
	const durationMs = resetMs - startMs;
	const elapsed = now - startMs;
	return Math.min(100, Math.max(0, (elapsed / durationMs) * 100));
}

/**
 * Full length of the window a reset belongs to, derived backwards from the reset
 * the same way the pace tick derives its start. Null when the reset or the
 * window name is missing or unparseable, which callers must read as "unknown"
 * rather than substituting a default length.
 */
function computeWindowDurationMs(
	resetMs: number | null,
	window: string | null,
): number | null {
	if (resetMs === null || !Number.isFinite(resetMs) || !window) return null;
	const startMs = computeWindowStartMs(resetMs, window);
	if (startMs === null || !Number.isFinite(startMs)) return null;
	const durationMs = resetMs - startMs;
	return durationMs > 0 ? durationMs : null;
}

function computeWindowThrottleUntil(
	resetTime: string | null,
	window: string | null,
	percentage: number | null,
	now: number,
): number | null {
	if (!resetTime || !window || percentage === null) return null;

	const resetMs = new Date(resetTime).getTime();
	if (!Number.isFinite(resetMs) || resetMs <= now) return null;

	const startMs = computeWindowStartMs(resetMs, window);
	if (startMs === null || startMs >= resetMs) return null;

	const durationMs = resetMs - startMs;
	const elapsedMs = now - startMs;
	if (elapsedMs <= 0) return null;

	const expectedPct = Math.min(
		100,
		Math.max(0, (elapsedMs / durationMs) * 100),
	);
	if (percentage <= expectedPct) return null;

	const resumeAt = Math.min(startMs + (percentage / 100) * durationMs, resetMs);
	return resumeAt > now ? resumeAt : null;
}

function formatThrottledUntil(throttledUntilMs: number, now: number): string {
	const remainingMs = throttledUntilMs - now;
	if (remainingMs < 60 * 1000) {
		return "Less than 1 minute";
	}

	const roundedUpToMinuteMs = Math.ceil(throttledUntilMs / 60000) * 60000;
	return new Date(roundedUpToMinuteMs).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function computeProjectedMessage(
	resetTime: string | null,
	window: string | null,
	percentage: number | null,
	now: number,
): ProjectedUsage | null {
	if (!resetTime || !window || percentage === null) return null;
	const resetMs = new Date(resetTime).getTime();
	const startMs = computeWindowStartMs(resetMs, window);
	if (startMs === null) return null;
	const elapsed = now - startMs;
	const remaining = resetMs - now;
	if (elapsed <= 0 || remaining <= 0) return null;
	const f = percentage / 100;
	if (f <= 0)
		return { message: "No usage recorded yet in this window", tone: "neutral" };
	const timeToExhaustMs = ((1 - f) / f) * elapsed;
	if (timeToExhaustMs < remaining) {
		return {
			message: `Runs out ${formatDuration(remaining - timeToExhaustMs)} before reset`,
			// Amber, never red, no matter how large the projected shortfall. This
			// path is a single-snapshot average over the whole elapsed window rather
			// than a recent slope: a burst in the first ten minutes of a five-hour
			// window projects confident exhaustion for an account that has since
			// gone idle, and it stays projecting it until the window resets. It is
			// what every non-Anthropic and every scoped-weekly window falls back to,
			// so red here would be red almost everywhere. The regression path in
			// `formatPredictionMessage` is the only source trusted with red.
			tone: "warning",
		};
	}
	return {
		message: RESETS_BEFORE_EXHAUSTION_MESSAGE,
		tone: "safe",
	};
}

// Maps a projection tone to a semantic colour class.
//
// This used to branch on render surface, on the premise that the hover tooltip
// sat on a dark popover and therefore needed a fixed red-400/green-400 pair.
// The tooltip is `bg-popover`, which is white in every light mode — so the
// fixed pair was washed out there rather than tuned for it. Both surfaces are
// token-driven, so both take the semantic tokens.
function projectionToneClass(tone: ProjectionTone): string {
	switch (tone) {
		case "neutral":
			return "text-muted-foreground";
		case "danger":
			return "text-destructive-strong";
		case "warning":
			return "text-warning-strong";
		default:
			return "text-success-strong";
	}
}

// Fill colour for the progress bar itself, so the run-out signal is legible from
// the bar alone rather than only from the projection line (which is a hover
// tooltip on the Accounts page). The bar's FILL carries it, not the pace tick:
// the tick's position encodes clock time and nothing else, so colouring it would
// put two unrelated variables on one mark, and a 2px tick tinted amber would
// vanish into an amber throttled fill. The tick stays white.
//
// Ordering is the precedence rule. A "danger" projection outranks the throttled
// tint because it is the worse news and needs its own hue; below that, throttling
// outranks a "warning" projection. Those two share `bg-warning` — they are the
// same amber and near-always co-occur, since proactive throttling exists exactly
// because an account is burning ahead of pace.
function projectionFillClass(
	tone: ProjectionTone | null,
	isThrottled: boolean,
): string | undefined {
	if (tone === "danger") return "bg-destructive";
	if (isThrottled) return "bg-warning";
	if (tone === "warning") return "bg-warning";
	return undefined;
}

// Compact "time left until reset" for the caption bracket, showing the two
// largest meaningful units: days+hours when a day or more remains, else
// hours+minutes, else minutes.
function formatRemaining(ms: number): string {
	const totalMinutes = Math.max(0, Math.floor(ms / 60000));
	if (totalMinutes < 1) return "<1m";
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

// The model-family weekly windows (e.g. "Fable"/Opus/Sonnet) are secondary to
// the primary 5-hour and unscoped weekly windows and get the subtler card tint.
function isSecondaryWindow(window: string | null, label?: string): boolean {
	if (label != null) return true;
	return (
		window === "seven_day_scoped" ||
		window === "seven_day_opus" ||
		window === "seven_day_sonnet"
	);
}

function shouldShowResetDate(window: string | null): boolean {
	return (
		window === "seven_day" ||
		window === "seven_day_opus" ||
		window === "seven_day_sonnet" ||
		window === "seven_day_scoped" ||
		window === "weekly" ||
		window === "monthly" ||
		window === "time_limit" ||
		window === "tokens_limit"
	);
}

function isSameLocalDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

/**
 * The reset moment alone — "Aug 27, 08:59" or "08:59" — with no leading verb,
 * so callers can either prefix "Resets " or place the stamp somewhere a verb
 * would not fit (the compact caption puts the countdown first).
 */
function formatResetStamp(
	resetTime: string,
	window: string | null,
	now: number,
): string {
	const resetDate = new Date(resetTime);
	// A bare time-of-day is misleading for any reset that isn't today (e.g. the
	// fallback "Rate limit window" can carry a weekly reset days away), so the
	// date is included whenever the reset falls on a different local day.
	if (
		shouldShowResetDate(window) ||
		!isSameLocalDay(resetDate, new Date(now))
	) {
		return resetDate.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	}
	return resetDate.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function formatResetText(
	resetTime: string,
	window: string | null,
	now: number,
): string {
	return `Resets ${formatResetStamp(resetTime, window, now)}`;
}

function formatAsOfText(asOfIso: string, now: number): string {
	const asOfDate = new Date(asOfIso);
	if (isSameLocalDay(asOfDate, new Date(now))) {
		return asOfDate.toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	}
	return asOfDate.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

/**
 * Caption for a LIVE reading that has aged past {@link LIVE_USAGE_FRESH_MS},
 * else null (still current, absent, or an unparseable timestamp). Reuses
 * `formatAsOfText` so the aged-live and last-known-snapshot captions read
 * identically.
 */
function agedLiveUsageAsOf(
	usageAsOfIso: string | null | undefined,
	now: number,
): string | null {
	if (!usageAsOfIso) return null;
	const asOfMs = new Date(usageAsOfIso).getTime();
	if (!Number.isFinite(asOfMs) || now - asOfMs <= LIVE_USAGE_FRESH_MS)
		return null;
	return formatAsOfText(usageAsOfIso, now);
}

export function RateLimitProgress({
	resetIso,
	usageUtilization,
	usageWindow,
	usageData,
	staleUsage,
	usageAsOfIso,
	usageRateLimitedUntil,
	usageThrottledUntil,
	usageThrottledWindows = [],
	provider,
	className,
	showWeekly = false,
	inlineProjection = false,
	prediction = null,
	compact = false,
	earliestResets,
	latestResets,
}: RateLimitProgressProps) {
	const [now, setNow] = useState(Date.now());

	// Each mounted card needs its OWN ticker. The shared IntervalManager keys
	// intervals by id and replaces any colliding one, so a hard-coded id would
	// make every newly-mounted card cancel the previous card's ticker — leaving
	// only the last card's countdown live and freezing all the others until a
	// full page reload. useId() gives every instance a stable, unique id.
	const instanceId = useId();
	useEffect(() => {
		const unregisterInterval = registerUIRefresh({
			id: `rate-limit-progress-update-${instanceId}`,
			callback: () => setNow(Date.now()),
			seconds: 30,
			description: "Rate limit progress UI update",
		});
		return unregisterInterval;
	}, [instanceId]);

	// The live reading is real but no longer current (polling is healthy — the
	// next refresh simply hasn't landed). Show the value as usual and state its
	// age; the amber "unavailable" wording stays reserved for missing data.
	// Computed BEFORE the card branches so every card that renders a live
	// reading — including Kilo's credit balance — discloses the same age. The
	// server serves any provider's cached entry up to the UI horizon, so any of
	// them can be aged.
	const agedAsOfText = agedLiveUsageAsOf(usageAsOfIso, now);

	// Which of the five card shapes this account gets. The branch conditions live
	// in `classifyUsageCard` alone so the cross-account "resets next" comparison
	// in `computeSoonestWindowResets` sees exactly the windows rendered here.
	const card = classifyUsageCard(
		{
			resetIso,
			usageUtilization,
			usageWindow,
			usageData,
			staleUsage,
			usageRateLimitedUntil,
			provider,
			showWeekly,
		},
		now,
	);

	if (card.kind === "none") return null;

	// The Anthropic usage API returned 429 and there is nothing else to show.
	if (card.kind === "rate-limited") {
		const retryTimeText = new Date(card.retryAfterMs).toLocaleTimeString(
			undefined,
			{
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			},
		);
		return (
			<div className={cn(primaryCardClass(compact), className)}>
				<div className="flex items-center justify-between">
					<span className="text-xs text-warning-strong">
						Rate limited — usage data unavailable
					</span>
					<span className="text-xs text-muted-foreground">
						Retry after {retryTimeText}
					</span>
				</div>
			</div>
		);
	}

	// Live usage is gone but a persisted snapshot knows the last-sampled state.
	// Show whichever windows the server carried: the 5-hour window only when the
	// snapshot was fresh (server-gated), the weekly window whenever its reset is
	// still future. Wording never implies the value is live — "last known as of
	// HH:MM".
	if (card.kind === "stale") {
		const stale = card.staleUsage;
		return (
			<div className={cn(primaryCardClass(compact), className)}>
				<div className="space-y-item">
					{stale.fiveHour && (
						<>
							<Progress value={stale.fiveHour.utilization} className="h-2" />
							<div className="flex items-center justify-between gap-item text-xs">
								<span className="min-w-0 flex-1 truncate text-muted-foreground">
									5h: last known as of {formatAsOfText(stale.asOfIso, now)}
								</span>
								<span className="shrink-0 text-muted-foreground">
									{formatResetText(stale.fiveHour.resetIso, "five_hour", now)}
								</span>
								<span className="shrink-0 font-medium text-muted-foreground">
									{stale.fiveHour.utilization.toFixed(0)}%
								</span>
							</div>
						</>
					)}
					{stale.sevenDay && (
						<>
							<Progress value={stale.sevenDay.utilization} className="h-2" />
							<div className="flex items-center justify-between gap-item text-xs">
								<span className="min-w-0 flex-1 truncate text-muted-foreground">
									Weekly: last known as of {formatAsOfText(stale.asOfIso, now)}
								</span>
								<span className="shrink-0 text-muted-foreground">
									{formatResetText(stale.sevenDay.resetIso, "seven_day", now)}
								</span>
								<span className="shrink-0 font-medium text-muted-foreground">
									{stale.sevenDay.utilization.toFixed(0)}%
								</span>
							</div>
						</>
					)}
					<p className="text-xs text-warning-strong">
						{usageRateLimitedUntil != null
							? "Usage API rate limited — showing last known data"
							: "Live usage unavailable — showing last known data"}
					</p>
				</div>
			</div>
		);
	}

	// Kilo Gateway: credit balance in USD instead of a utilization window.
	if (card.kind === "credits") {
		return (
			<div className={cn(primaryCardClass(compact), className)}>
				<div className="flex items-center justify-between">
					<span className="text-xs text-muted-foreground">
						Kilo Gateway credits
					</span>
					<span className="text-xs font-medium text-muted-foreground">
						{card.hasCredits
							? `$${card.remainingUsd.toFixed(2)} remaining`
							: "No credits"}
					</span>
				</div>
				{agedAsOfText && (
					<p className="text-xs text-muted-foreground">
						Live usage as of {agedAsOfText}
					</p>
				)}
			</div>
		);
	}

	const usages = card.usages;

	const throttledWindowSet = new Set(usageThrottledWindows);

	const cardClass = compact ? COMPACT_WINDOW_CARD_CLASS : WINDOW_CARD_CLASS;
	const cardSpacing = compact ? "space-y-tight" : "space-y-item";
	// Compact mode collapses the wrapping 2-up grid into a single equal-width
	// strip once there is room for it. `grid-cols-none` is required alongside
	// `grid-flow-col`: without clearing the template the sm:2-column track list
	// still applies and the flow only fills those two tracks. `auto-cols-fr`
	// then divides the row evenly however many windows an account reports, so
	// no per-count class map is needed.
	const gridClass = compact
		? "grid grid-cols-1 gap-item sm:grid-cols-2 xl:grid-cols-none xl:auto-cols-fr xl:grid-flow-col"
		: "grid grid-cols-1 gap-row sm:grid-cols-2";

	const windowGrid = (
		<div className={cn(gridClass, !agedAsOfText && className)}>
			{usages.map((usage, _index) => {
				const percentage = usage.utilization;
				const isAvailable = percentage !== null;

				// Special rendering for PayG mode - just show message without progress bar
				if (
					(usage.window === "daily" || usage.window === "monthly") &&
					!usage.resetTime
				) {
					return (
						<div
							key={
								usage.label
									? `${usage.window}-${usage.label}`
									: usage.window || "default"
							}
							className={cn(cardClass, PRIMARY_WINDOW_TINT, cardSpacing)}
						>
							<div className="flex items-center justify-between">
								<span className="text-xs text-muted-foreground">
									No subscription (PayG mode)
								</span>
							</div>
						</div>
					);
				}

				// expectedPct positions the time-linear "pace" tick mark on the bar;
				// it is intentionally NOT used to color the projection line — that is
				// driven by the projection's own tone (safe/danger) so a reassuring
				// "Resets … before exhaustion" never shows up red just for being ahead
				// of a flat pace.
				const expectedPct = computeExpectedPct(
					usage.resetTime,
					usage.window,
					now,
				);
				const isWindowThrottled = usage.window
					? throttledWindowSet.has(usage.window)
					: false;
				const windowThrottleUntil = isWindowThrottled
					? computeWindowThrottleUntil(
							usage.resetTime,
							usage.window,
							percentage ?? null,
							now,
						)
					: null;
				const throttleDisplayUntil = windowThrottleUntil ?? usageThrottledUntil;
				const windowLabel = usageWindowLabel(usage);
				const isSecondary = isSecondaryWindow(usage.window, usage.label);
				// Prefer the server-computed regression prediction when it's
				// trustworthy (recent slope, not lifetime average) AND we have a live
				// reading to anchor it. When usable, its message is authoritative —
				// including a `null` message for a "stable" recent trend, which
				// deliberately SUPPRESSES the alarming projection rather than reverting
				// to the lifetime-average burn-rate copy. Only when the prediction is
				// not usable do we fall back to the legacy single-snapshot message.
				const windowPrediction = predictionForWindow(prediction, usage.window);
				const liveResetMs = usage.resetTime
					? new Date(usage.resetTime).getTime()
					: null;
				// The window's full length, which the prediction needs to judge whether
				// its projected shortfall is wide enough to be certain. Derived the same
				// way the pace tick derives its start: backwards from the reset.
				const windowDurationMs = computeWindowDurationMs(
					liveResetMs,
					usage.window,
				);
				const projection =
					percentage !== null &&
					isUsablePrediction(windowPrediction, liveResetMs)
						? formatPredictionMessage(
								windowPrediction,
								liveResetMs,
								now,
								windowDurationMs,
							)
						: computeProjectedMessage(
								usage.resetTime,
								usage.window,
								percentage ?? null,
								now,
							);
				// The one tone every surface reads: the bar's fill, the click popover
				// and the inline line all derive from this, so none of them can
				// disagree about how bad a window is. Null both when there is nothing
				// to project and when the window sits at 0%, where even a stale
				// prediction has nothing to warn about.
				const displayTone =
					projection && (percentage ?? 0) > 0 ? projection.tone : null;
				const projectionTextClass = displayTone
					? projectionToneClass(displayTone)
					: "text-muted-foreground";

				// Compact caption on a single row: window label (start), the reset
				// status (center), utilization % (end). The reset status pairs the
				// absolute 24-hour reset time with the time remaining in brackets,
				// e.g. "Resets Jul 26, 08:59 (2d 13h)".
				//
				// `resetStatusNode` is what renders (it can carry an emphasized countdown,
				// see below); `resetStatus` is its plain-text twin and
				// `resetStatusFull` is what the tooltip carries. The latter two differ
				// only in compact mode, where a card
				// can be a fifth of the row wide and the caption truncates: there
				// the countdown leads and the absolute stamp trails, so what gets
				// cut is the date rather than the time-remaining most people are
				// actually reading. The unabbreviated sentence stays on hover.
				let resetStatus = "";
				let resetStatusFull = "";
				let resetStatusNode: ReactNode = null;
				if (usage.resetTime) {
					const resetMs = new Date(usage.resetTime).getTime();
					if (resetMs <= now) {
						resetStatus = "Ready to refresh";
					} else {
						const stamp = formatResetStamp(usage.resetTime, usage.window, now);
						const remaining = formatRemaining(resetMs - now);
						resetStatusFull = `Resets ${stamp} (${remaining})`;
						resetStatus = compact ? `${remaining} · ${stamp}` : resetStatusFull;
						// Of every account on this page reporting this same kind of
						// window, call out both endpoints. Only the countdown carries
						// the comparison treatment — the absolute stamp remains quiet.
						const categoryKey = usageWindowCategoryKey(usage);
						const earliestReset = earliestResets?.get(categoryKey);
						const latestReset = latestResets?.get(categoryKey);
						// When every compared account resets at the exact same moment there
						// is no meaningful first/last distinction, so leave the tie neutral.
						const isTiedEndpoint =
							earliestReset !== undefined && earliestReset === latestReset;
						const resetRank = isTiedEndpoint
							? null
							: earliestReset === resetMs
								? "earliest"
								: latestReset === resetMs
									? "latest"
									: null;
						const countdown = resetRank ? (
							<span
								className={cn(
									"font-bold",
									resetRank === "earliest"
										? "text-success-strong"
										: "text-destructive-strong",
								)}
							>
								{remaining}
								<span className="sr-only">
									{resetRank === "earliest"
										? " — first reset among accounts"
										: " — last reset among accounts"}
								</span>
							</span>
						) : (
							remaining
						);
						resetStatusNode = compact ? (
							<>
								{countdown} · {stamp}
							</>
						) : (
							<>
								Resets {stamp} ({countdown})
							</>
						);
					}
				} else if (
					usage.window === "seven_day" ||
					usage.window === "seven_day_scoped"
				) {
					// Weekly window with no reset timestamp — keyed on utilization so the
					// copy is precise and non-alarming (0 = window hasn't started yet).
					resetStatus =
						usage.utilization === 0
							? "Not started yet"
							: usage.utilization === null
								? "Usage data unavailable"
								: "No reset data available";
				}
				resetStatusNode ??= resetStatus;

				return (
					<div
						key={
							usage.label
								? `${usage.window}-${usage.label}`
								: usage.window || "default"
						}
						className={cn(
							cardClass,
							isSecondary ? SECONDARY_WINDOW_TINT : PRIMARY_WINDOW_TINT,
							cardSpacing,
						)}
					>
						<div className="relative">
							<Progress
								value={isAvailable ? percentage : 0}
								className="h-2"
								indicatorClassName={projectionFillClass(
									displayTone,
									isWindowThrottled,
								)}
							/>
							{expectedPct !== null && (
								<div
									className="absolute w-0.5 pointer-events-none"
									style={{
										left: `${expectedPct}%`,
										top: "-3px",
										height: "14px",
										zIndex: 10,
										backgroundColor: "rgba(255,255,255,0.95)",
										boxShadow:
											"1px 0 2px rgba(0,0,0,0.5), -1px 0 2px rgba(0,0,0,0.5)",
									}}
								/>
							)}
						</div>
						<div className="flex items-center justify-between gap-item text-xs">
							{/* `shrink-0` is safe in a half-width card but not in a
							    fifth-width one: a long provider-supplied label (Codex's
							    synthetic per-model windows carry the full model name)
							    would push the row past the card instead of yielding,
							    because only the centre caption can absorb the squeeze.
							    In compact mode the label truncates too, keeping its full
							    text on hover. */}
							{!inlineProjection && projection ? (
								<Popover>
									<PopoverTrigger asChild>
										<button
											type="button"
											className={cn(
												"cursor-pointer text-left text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
												compact ? "min-w-0 shrink truncate" : "shrink-0",
											)}
											aria-label={`Show ${windowLabel} usage details`}
										>
											{windowLabel}
										</button>
									</PopoverTrigger>
									<PopoverContent
										align="start"
										className="w-auto max-w-xs p-3 text-xs"
									>
										<p className="mb-1 font-medium">{windowLabel} usage</p>
										<p className={projectionTextClass}>{projection.message}</p>
									</PopoverContent>
								</Popover>
							) : (
								<span
									className={cn(
										"text-muted-foreground",
										compact ? "min-w-0 shrink truncate" : "shrink-0",
									)}
									title={compact ? windowLabel : undefined}
								>
									{windowLabel}
								</span>
							)}
							{resetStatus && (
								<span
									className="min-w-0 flex-1 truncate text-center text-muted-foreground"
									title={resetStatusFull || resetStatus}
								>
									{resetStatusNode}
								</span>
							)}
							<span
								className={cn(
									"shrink-0 font-medium text-muted-foreground",
									isWindowThrottled && "text-warning-strong",
								)}
							>
								{isAvailable ? `${percentage?.toFixed(0)}%` : "N/A"}
							</span>
						</div>
						{inlineProjection && projection && (
							<p className={cn("text-xs", projectionTextClass)}>
								{projection.message}
							</p>
						)}
						{isWindowThrottled && throttleDisplayUntil && (
							<div className="flex items-center justify-between gap-item text-xs">
								<span className="text-warning-strong">
									Usage throttling enabled; requests are being delayed
								</span>
								<span className="text-warning-strong">
									{(() => {
										const throttledLabel = formatThrottledUntil(
											throttleDisplayUntil,
											now,
										);
										return throttledLabel.startsWith("Less than")
											? throttledLabel
											: `Until ${throttledLabel}`;
									})()}
								</span>
							</div>
						)}
					</div>
				);
			})}
		</div>
	);

	if (!agedAsOfText) return windowGrid;

	return (
		<div className={cn("space-y-item", className)}>
			{windowGrid}
			<p className="text-xs text-muted-foreground">
				Live usage as of {agedAsOfText}
			</p>
		</div>
	);
}
