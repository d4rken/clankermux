import { computeWindowStartMs, registerUIRefresh } from "@clankermux/core";
import type {
	AccountUsagePrediction,
	FullUsageData,
	StaleUsageInfo,
	UsagePrediction,
} from "@clankermux/types";
import { isUsablePrediction } from "@clankermux/types";
import { useEffect, useId, useState } from "react";
import {
	formatDuration,
	formatPredictionMessage,
	type ProjectedUsage,
	type ProjectionTone,
	RESETS_BEFORE_EXHAUSTION_MESSAGE,
} from "../../lib/format-prediction";
import { getScopedWeeklyLimits } from "../../lib/secondary-limits";
import { cn } from "../../lib/utils";
import {
	providerShowsCreditsBalance,
	providerShowsWeeklyUsage,
} from "../../utils/provider-utils";
import { Progress } from "../ui/progress";

interface RateLimitProgressProps {
	resetIso: string | null;
	usageUtilization?: number | null; // Actual utilization from API (0-100)
	usageWindow?: string | null; // Window name (e.g., "five_hour")
	usageData?: FullUsageData | null; // Full usage data from API
	staleUsage?: StaleUsageInfo | null; // Last-known weekly usage when live data is unavailable
	usageRateLimitedUntil?: number | null; // Timestamp (ms) until usage API 429 clears
	usageThrottledUntil?: number | null; // Timestamp (ms) until proactive usage throttling clears
	usageThrottledWindows?: string[]; // Exact usage windows currently being throttled
	provider: string;
	className?: string;
	showWeekly?: boolean; // Whether to show weekly usage as well
	inlineProjection?: boolean; // Render projection message as visible text instead of hover tooltip
	prediction?: AccountUsagePrediction | null; // Server-computed regression prediction (Anthropic 5h/7d only)
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

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours in milliseconds

// Each usage window renders as its own card. Primary windows (the 5-hour and
// unscoped weekly quota) get a filled muted card; the secondary,
// model-family-specific weekly cards are left unfilled (outline only). A
// filled-vs-outline distinction reads clearly in BOTH light and dark themes,
// whereas a mere opacity difference on `bg-muted` is near-invisible in light
// mode (muted is ~96% lightness, so it barely differs from a white surface).
const WINDOW_CARD_CLASS = "rounded-lg border p-3";
const PRIMARY_WINDOW_TINT = "border-border/60 bg-muted/50";
const SECONDARY_WINDOW_TINT = "border-border/50 bg-transparent";

// The three standalone message blocks (rate-limited, stale, Kilo credits) all
// render as a single primary card.
const PRIMARY_CARD_CLASS = cn(
	WINDOW_CARD_CLASS,
	PRIMARY_WINDOW_TINT,
	"space-y-2",
);

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
			tone: "danger",
		};
	}
	return {
		message: RESETS_BEFORE_EXHAUSTION_MESSAGE,
		tone: "safe",
	};
}

// Maps a projection tone to the correct color class for each render surface.
// The two surfaces use different palettes: the inline line uses the semantic
// destructive/success tokens, the hover tooltip (on a dark popover) uses the
// fixed red-400/green-400 pair.
function projectionToneClass(
	tone: ProjectionTone,
	surface: "inline" | "tooltip",
): string {
	if (tone === "neutral") return "text-muted-foreground";
	if (surface === "inline") {
		return tone === "danger" ? "text-destructive" : "text-success";
	}
	return tone === "danger" ? "text-red-400" : "text-green-400";
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

// Format window name for display
function formatWindowName(window: string | null): string {
	if (!window) return "window";
	switch (window) {
		case "five_hour":
			return "5-hour";
		case "seven_day":
			return "Weekly";
		case "seven_day_opus":
			return "Opus (Weekly)";
		case "seven_day_sonnet":
			return "Sonnet (Weekly)";
		case "seven_day_scoped":
			return "Weekly";
		case "daily":
			return "Daily";
		case "weekly":
			return "Weekly";
		case "monthly":
			return "Monthly";
		case "time_limit":
			return "Time Quota";
		case "tokens_limit":
			return "5-hour";
		default:
			return window.replace("_", " ");
	}
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

function formatResetText(
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
		return `Resets ${resetDate.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		})}`;
	}
	return `Resets ${resetDate.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})}`;
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

interface UsageDisplay {
	utilization: number | null;
	window: string | null;
	resetTime: string | null;
	label?: string;
}

export function RateLimitProgress({
	resetIso,
	usageUtilization,
	usageWindow,
	usageData,
	staleUsage,
	usageRateLimitedUntil,
	usageThrottledUntil,
	usageThrottledWindows = [],
	provider,
	className,
	showWeekly = false,
	inlineProjection = false,
	prediction = null,
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

	// Allow null resetIso for providers that show usage data (e.g. PayG mode)
	// but still render null if there's no resetIso and no usage data to show
	if (!resetIso && !usageData && !staleUsage && !usageRateLimitedUntil)
		return null;

	// Show explicit rate-limited state when the Anthropic usage API returned 429
	// and we have no cached data to show.
	if (
		usageRateLimitedUntil != null &&
		!usageData &&
		(provider === "anthropic" || provider === "codex")
	) {
		const retryAfterDate = new Date(usageRateLimitedUntil);
		const retryTimeText = retryAfterDate.toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
		return (
			<div className={cn(PRIMARY_CARD_CLASS, className)}>
				<div className="flex items-center justify-between">
					<span className="text-xs text-amber-600 dark:text-amber-400">
						Rate limited — usage data unavailable
					</span>
					<span className="text-xs text-muted-foreground">
						Retry after {retryTimeText}
					</span>
				</div>
			</div>
		);
	}

	// Live usage data is gone (e.g. usage polling fails because the
	// subscription lapsed, so the cache evicted) but a persisted snapshot still
	// knows the weekly state. Show only the weekly window: a stale 5-hour
	// reading is meaningless minutes after polling stops, while the weekly
	// utilization and its reset date stay relevant for days.
	if (!usageData && staleUsage) {
		return (
			<div className={cn(PRIMARY_CARD_CLASS, className)}>
				<div className="space-y-1.5">
					<Progress value={staleUsage.sevenDayUtilization} className="h-2" />
					<div className="flex items-center justify-between gap-2 text-xs">
						<span className="min-w-0 flex-1 truncate text-muted-foreground">
							Weekly: last known as of {formatAsOfText(staleUsage.asOfIso, now)}
						</span>
						<span className="shrink-0 text-muted-foreground">
							{formatResetText(staleUsage.sevenDayResetIso, "seven_day", now)}
						</span>
						<span className="shrink-0 font-medium text-muted-foreground">
							{staleUsage.sevenDayUtilization.toFixed(0)}%
						</span>
					</div>
					<p className="text-xs text-amber-600 dark:text-amber-400">
						Live usage unavailable — showing last known data
					</p>
				</div>
			</div>
		);
	}

	// Kilo Gateway: show credit balance in USD instead of a utilization window
	if (providerShowsCreditsBalance(provider) && usageData) {
		const kiloData = usageData as {
			remainingUsd?: number;
			totalMicrodollarsAcquired?: number;
		};
		if (typeof kiloData.remainingUsd === "number") {
			const hasCredits = (kiloData.totalMicrodollarsAcquired ?? 0) > 0;
			return (
				<div
					className={cn(
						WINDOW_CARD_CLASS,
						PRIMARY_WINDOW_TINT,
						"space-y-2",
						className,
					)}
				>
					<div className="flex items-center justify-between">
						<span className="text-xs text-muted-foreground">
							Kilo Gateway credits
						</span>
						<span className="text-xs font-medium text-muted-foreground">
							{hasCredits
								? `$${kiloData.remainingUsd.toFixed(2)} remaining`
								: "No credits"}
						</span>
					</div>
				</div>
			);
		}
	}

	const resetTime = resetIso ? new Date(resetIso).getTime() : Date.now();

	// Determine which usage windows to display
	const usages: UsageDisplay[] = [];

	// Check if this is Zai usage data (has 'time_limit' and 'tokens_limit' properties)
	const isZaiData =
		usageData && ("time_limit" in usageData || "tokens_limit" in usageData);

	// Check if this is Alibaba Coding Plan usage data
	const isAlibabaData =
		usageData && "five_hour" in usageData && "weekly" in usageData;

	// Anthropic-style quota data is shared by Anthropic and Codex; detect by shape, not provider name.
	const hasAnthropicStyleData =
		usageData &&
		"five_hour" in usageData &&
		"seven_day" in usageData &&
		!isAlibabaData &&
		!isZaiData;

	if (isAlibabaData && showWeekly) {
		const alibabaData = usageData as {
			five_hour: { percentUsed: number; resetAt: number | null };
			weekly: { percentUsed: number; resetAt: number | null };
			monthly: { percentUsed: number; resetAt: number | null };
		};
		usages.push({
			utilization: alibabaData.five_hour.percentUsed,
			window: "five_hour",
			resetTime: alibabaData.five_hour.resetAt
				? new Date(alibabaData.five_hour.resetAt).toISOString()
				: null,
		});
		usages.push({
			utilization: alibabaData.weekly.percentUsed,
			window: "weekly",
			resetTime: alibabaData.weekly.resetAt
				? new Date(alibabaData.weekly.resetAt).toISOString()
				: null,
		});
		usages.push({
			utilization: alibabaData.monthly.percentUsed,
			window: "monthly",
			resetTime: alibabaData.monthly.resetAt
				? new Date(alibabaData.monthly.resetAt).toISOString()
				: null,
		});
	} else if (isZaiData && showWeekly) {
		// Zai usage data - show tokens_limit (5-hour token quota) and time_limit (peak-hour limit)
		const zaiData = usageData as {
			time_limit?: { percentage: number; resetAt: number } | null;
			tokens_limit?: { percentage: number; resetAt: number } | null;
		};

		// Tokens limit usage (5-hour token quota)
		if (zaiData.tokens_limit) {
			usages.push({
				utilization: zaiData.tokens_limit.percentage,
				window: "tokens_limit",
				resetTime: zaiData.tokens_limit.resetAt
					? new Date(zaiData.tokens_limit.resetAt).toISOString()
					: null,
			});
		}

		// Time limit usage (peak-hour quota)
		if (zaiData.time_limit) {
			usages.push({
				utilization: zaiData.time_limit.percentage,
				window: "time_limit",
				resetTime: zaiData.time_limit.resetAt
					? new Date(zaiData.time_limit.resetAt).toISOString()
					: null,
			});
		}
	} else if (hasAnthropicStyleData && showWeekly) {
		// Anthropic usage data - show 5-hour and weekly usage
		const anthropicData = usageData as {
			five_hour?: { utilization: number | null; resets_at: string | null };
			seven_day?: { utilization: number | null; resets_at: string | null };
			seven_day_opus?: { utilization: number | null; resets_at: string | null };
			seven_day_sonnet?: {
				utilization: number | null;
				resets_at: string | null;
			};
		};
		if (anthropicData?.five_hour) {
			usages.push({
				utilization: anthropicData.five_hour.utilization,
				window: "five_hour",
				resetTime: anthropicData.five_hour.resets_at,
			});
		} else {
			// Fallback: use the most restrictive window data for 5-hour display
			usages.push({
				utilization: usageUtilization ?? null,
				window: "five_hour",
				resetTime: resetIso,
			});
		}

		// Check if seven_day data exists and has valid utilization
		if (
			anthropicData &&
			anthropicData.seven_day &&
			anthropicData.seven_day.utilization !== null &&
			anthropicData.seven_day.utilization !== undefined
		) {
			usages.push({
				utilization: anthropicData.seven_day.utilization,
				window: "seven_day",
				resetTime: anthropicData.seven_day.resets_at,
			});
		} else {
			// Add weekly usage as placeholder if data is not available
			usages.push({
				utilization: null,
				window: "seven_day",
				resetTime: null,
			});
		}

		// Model-specific weekly windows (e.g. "Fable") always render as their own
		// secondary cards when the payload carries them.
		for (const limit of getScopedWeeklyLimits(usageData)) {
			usages.push({
				utilization: limit.utilization,
				window: "seven_day_scoped",
				resetTime: limit.resetsAt,
				label: limit.label,
			});
		}
	} else if (
		providerShowsWeeklyUsage(provider) &&
		usageUtilization !== null &&
		usageUtilization !== undefined &&
		usageWindow
	) {
		// Fallback: show only the most restrictive window
		usages.push({
			utilization: usageUtilization,
			window: usageWindow,
			resetTime: resetIso,
		});
	} else {
		// Use time-based percentage for non-Anthropic or when no usage data is available
		const percentage = Math.min(
			100,
			Math.max(0, ((now - (resetTime - WINDOW_MS)) / WINDOW_MS) * 100),
		);
		usages.push({
			utilization: percentage as number | null,
			window: null,
			resetTime: resetIso,
		});
	}

	const throttledWindowSet = new Set(usageThrottledWindows);

	return (
		<div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", className)}>
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
							className={cn(
								WINDOW_CARD_CLASS,
								PRIMARY_WINDOW_TINT,
								"space-y-1.5",
							)}
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
				const windowLabel =
					usage.label ??
					(usage.window ? formatWindowName(usage.window) : "Rate limit");
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
				const projection =
					percentage !== null &&
					isUsablePrediction(windowPrediction, liveResetMs)
						? formatPredictionMessage(windowPrediction, liveResetMs, now)
						: computeProjectedMessage(
								usage.resetTime,
								usage.window,
								percentage ?? null,
								now,
							);

				// Compact caption on a single row: window label (start), the reset
				// status (center), utilization % (end). The reset status pairs the
				// absolute 24-hour reset time with the time remaining in brackets,
				// e.g. "Resets Jul 26, 08:59 (2d 13h)".
				let resetStatus = "";
				if (usage.resetTime) {
					const resetMs = new Date(usage.resetTime).getTime();
					resetStatus =
						resetMs <= now
							? "Ready to refresh"
							: `${formatResetText(usage.resetTime, usage.window, now)} (${formatRemaining(
									resetMs - now,
								)})`;
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

				return (
					<div
						key={
							usage.label
								? `${usage.window}-${usage.label}`
								: usage.window || "default"
						}
						className={cn(
							WINDOW_CARD_CLASS,
							isSecondary ? SECONDARY_WINDOW_TINT : PRIMARY_WINDOW_TINT,
							"space-y-1.5",
						)}
					>
						<div className={cn(!inlineProjection && "group", "relative")}>
							{!inlineProjection && (
								<div
									className="pointer-events-none absolute bottom-full z-10 mb-2 hidden w-max max-w-xs -translate-x-1/2 rounded bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md group-hover:block"
									style={{ left: `clamp(10%, ${expectedPct ?? 50}%, 90%)` }}
								>
									<div className="mb-1 font-medium">{windowLabel} usage</div>
									{projection && (
										<div
											className={
												(percentage ?? 0) <= 0
													? "text-muted-foreground"
													: projectionToneClass(projection.tone, "tooltip")
											}
										>
											{projection.message}
										</div>
									)}
								</div>
							)}
							<Progress
								value={isAvailable ? percentage : 0}
								className="h-2"
								indicatorClassName={
									isWindowThrottled
										? "bg-amber-500 dark:bg-amber-400"
										: undefined
								}
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
						<div className="flex items-center justify-between gap-2 text-xs">
							<span className="shrink-0 text-muted-foreground">
								{windowLabel}
							</span>
							{resetStatus && (
								<span className="min-w-0 flex-1 truncate text-center text-muted-foreground">
									{resetStatus}
								</span>
							)}
							<span
								className={cn(
									"shrink-0 font-medium text-muted-foreground",
									isWindowThrottled && "text-amber-600 dark:text-amber-400",
								)}
							>
								{isAvailable ? `${percentage?.toFixed(0)}%` : "N/A"}
							</span>
						</div>
						{inlineProjection && projection && (
							<p
								className={cn(
									"text-xs",
									(percentage ?? 0) <= 0
										? "text-muted-foreground"
										: projectionToneClass(projection.tone, "inline"),
								)}
							>
								{projection.message}
							</p>
						)}
						{isWindowThrottled && throttleDisplayUntil && (
							<div className="flex items-center justify-between gap-2 text-xs">
								<span className="text-amber-600 dark:text-amber-400">
									Usage throttling enabled; requests are being delayed
								</span>
								<span className="text-amber-600 dark:text-amber-400">
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
}
