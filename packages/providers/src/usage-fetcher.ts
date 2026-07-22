import {
	CLAUDE_CLI_VERSION,
	getNormalizedRepresentativeUtilization,
	normalizeAnthropicUsage,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	type AnthropicLimitEntry,
	type AnthropicUsageData,
	type CapacitySignal,
	supportsUsageTracking,
} from "@clankermux/types";
import {
	type AlibabaCodingPlanUsageData,
	fetchAlibabaCodingPlanUsageData,
	getRepresentativeAlibabaCodingPlanUtilization,
	getRepresentativeAlibabaCodingPlanWindow,
} from "./alibaba-coding-plan-usage-fetcher";
import {
	fetchKiloUsageData,
	getRepresentativeKiloUtilization,
	getRepresentativeKiloWindow,
	type KiloUsageData,
} from "./kilo-usage-fetcher";
import type { CodexCreditsInfo } from "./providers/codex/usage";
import { isGenuineWindowRoll } from "./window-reset";
import { fetchZaiUsageData, type ZaiUsageData } from "./zai-usage-fetcher";

const log = new Logger("UsageFetcher");

/**
 * Max age of a cached usage entry before it is considered stale. Reads past this
 * age return null; evicting reads (get/getAge) also delete the entry, while the
 * non-evicting peek/peekAge reads leave it in place.
 */
const USAGE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Demand-aware polling cadence (Anthropic only — see {@link PollingPolicy}).
 *
 * IDLE_POLL_INTERVAL_MS: the base cadence a *cold* account (no recent traffic)
 * polls at. 10 minutes — deliberately NOT 9 (the cache TTL). Routing already
 * treats usage data older than ~2*pollInterval as unknown (independent of the
 * TTL), stale reads fail open, and the account-selector fires a free
 * `refreshNow` on demand when it actually needs a fresh reading — so letting an
 * idle entry lapse past the TTL between polls is safe and saves the shared,
 * aggressively-rate-limited /oauth/usage + /oauth/profile bucket.
 *
 * ACTIVITY_RECENCY_MS: how recently an account must have served a request to be
 * treated as "active" (poll at the configured active cadence). 15 minutes.
 *
 * MAX_BACKOFF_MS: ceiling for the exponential failure backoff (unchanged).
 */
const IDLE_POLL_INTERVAL_MS = 10 * 60_000;
const ACTIVITY_RECENCY_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

/**
 * Optional per-account polling policy passed as the final argument to
 * {@link UsageCache.startPolling}. Only the Anthropic setup opts in
 * (`demandAware: true`); Zai/Kilo/Alibaba pass nothing and keep the fixed
 * cadence they always had.
 *
 * Activity source (why an in-memory map + optional resolver, not a captured
 * `Account`): a startup-captured `account.last_used` goes stale immediately, so
 * it must never drive cadence. Instead the request/proxy path calls
 * {@link UsageCache.noteActivity} to record real-time activity in an in-memory
 * map on the cache — this doubles as the idle→active re-arm signal (see
 * `noteActivity`). `getLastActivityMs` is an OPTIONAL live resolver consulted
 * ONLY on cold start (before the account has served any request this process,
 * e.g. just after a restart): it reads the *current* DB `last_used` so an
 * account that was busy right before a restart still polls at the active cadence
 * without waiting for its next request. Once any activity is observed in-memory,
 * the map wins and the resolver is not consulted.
 */
export interface PollingPolicy {
	/** Opt in to recency-based active/idle cadence. Anthropic-only. */
	demandAware?: boolean;
	/**
	 * Cold-start fallback activity source: the account's CURRENT `last_used`
	 * (ms since epoch) read live, or null/undefined when unknown. May be async.
	 * Consulted only when no in-memory activity has been observed yet.
	 */
	getLastActivityMs?: (
		accountId: string,
	) => number | null | Promise<number | null>;
	/** Override the idle base cadence (defaults to IDLE_POLL_INTERVAL_MS). */
	idleIntervalMs?: number;
	/** Override the activity-recency threshold (defaults to ACTIVITY_RECENCY_MS). */
	activityRecencyMs?: number;
}

/**
 * Pure recency decision: given the account's last-activity timestamp, pick the
 * base cadence and whether it is the idle cadence. Non-demand-aware accounts
 * always get the fixed active interval (their existing behavior). The idle
 * cadence is `max(activeInterval, idleInterval)` so a config where the active
 * interval already exceeds the idle floor never *speeds up* an idle account.
 */
export function computeDemandAwareInterval(
	opts: Pick<
		PollingPolicy,
		"demandAware" | "idleIntervalMs" | "activityRecencyMs"
	>,
	lastActivityMs: number | null,
	activeIntervalMs: number,
	now: number,
): { intervalMs: number; isIdle: boolean } {
	if (!opts.demandAware) return { intervalMs: activeIntervalMs, isIdle: false };
	const idleIntervalMs = Math.max(
		activeIntervalMs,
		opts.idleIntervalMs ?? IDLE_POLL_INTERVAL_MS,
	);
	const recencyMs = opts.activityRecencyMs ?? ACTIVITY_RECENCY_MS;
	if (lastActivityMs != null && now - lastActivityMs < recencyMs) {
		return { intervalMs: activeIntervalMs, isIdle: false };
	}
	return { intervalMs: idleIntervalMs, isIdle: true };
}

/**
 * Pure poll-delay decision combining, in priority order: (1) a server
 * retry-after (wins outright), (2) exponential failure backoff (wins over the
 * base cadence — a failing account keeps backing off regardless of active/idle),
 * then (3) the demand-aware active/idle base cadence with ±jitter. `jitterFraction`
 * is the caller's random value in [-0.2, 0.2] (0 in tests for determinism).
 */
export function computePollDelay(params: {
	demandAware?: boolean;
	idleIntervalMs?: number;
	activityRecencyMs?: number;
	activeIntervalMs: number;
	lastActivityMs: number | null;
	failures: number;
	retryAfterMs: number | null;
	now: number;
	jitterFraction: number;
}): { delayMs: number; isIdle: boolean } {
	if (params.retryAfterMs != null)
		return { delayMs: params.retryAfterMs, isIdle: false };
	if (params.failures > 0) {
		return {
			delayMs: Math.min(
				params.activeIntervalMs * 2 ** params.failures,
				MAX_BACKOFF_MS,
			),
			isIdle: false,
		};
	}
	const { intervalMs, isIdle } = computeDemandAwareInterval(
		params,
		params.lastActivityMs,
		params.activeIntervalMs,
		params.now,
	);
	return { delayMs: intervalMs + intervalMs * params.jitterFraction, isIdle };
}

export interface UsageWindow {
	utilization: number;
	resets_at: string | null;
}

export interface ExtraUsage {
	is_enabled: boolean;
	monthly_limit: number | null;
	used_credits: number | null;
	utilization: number | null;
}

export interface UsageData {
	// Core windows (always present in older API versions)
	five_hour: UsageWindow;
	seven_day: UsageWindow;
	seven_day_oauth_apps?: UsageWindow;
	seven_day_opus?: UsageWindow | null;
	// New fields from 2025-11 API update (all optional for backward compatibility)
	seven_day_sonnet?: UsageWindow | null;
	iguana_necktie?: unknown; // Unknown purpose, keep as flexible type
	extra_usage?: ExtraUsage;
	/**
	 * Anthropic's generic per-window array (`kind`/`group`/`percent`/…). Present
	 * alongside the flat windows today and expected to become the ONLY source as
	 * upstream drops the flat keys. Typed here so the routing-critical reads can
	 * see it; normalized via `normalizeAnthropicUsage`.
	 */
	limits?: AnthropicLimitEntry[];
	/** Codex-only: in-response credits state. Absent for other providers. */
	codexCredits?: CodexCreditsInfo | null;
	// Allow any additional fields Anthropic might add in the future
	[key: string]: UsageWindow | ExtraUsage | unknown;
}

// Union type for all provider usage data
export type AnyUsageData =
	| UsageData
	| ZaiUsageData
	| KiloUsageData
	| AlibabaCodingPlanUsageData;

/**
 * Extract the primary window reset timestamp (ms) from usage data.
 * Returns null if the provider doesn't expose a reset time or it isn't available.
 */
export function extractWindowResetTime(
	data: AnyUsageData,
	provider: string,
): number | null {
	if (provider === "zai") {
		const zai = data as ZaiUsageData;
		return zai.tokens_limit?.resetAt ?? null;
	}
	if (provider === "anthropic" || provider === "codex") {
		const d = data as UsageData;
		// The primary (5h session) window reset. Prefer the flat `five_hour` window
		// ONLY when it's a real (finite-utilization) window; a present-but-empty flat
		// window must NOT shadow a valid `limits[]` `session` entry (upstream is
		// dropping the flat keys). Fully-flat payloads are byte-identical (no
		// limits[] → the flat reset is always used regardless of utilization).
		const flat = d.five_hour;
		let resetsAt: string | null = null;
		if (
			flat &&
			typeof flat.utilization === "number" &&
			Number.isFinite(flat.utilization)
		) {
			resetsAt = flat.resets_at ?? null;
		} else {
			const limits = (d as { limits?: AnthropicLimitEntry[] }).limits;
			if (Array.isArray(limits)) {
				// Require a finite numeric percent (matching the normalizer) before
				// trusting the limits[] session — a null/NaN-percent entry carries no
				// window evidence.
				resetsAt =
					limits.find(
						(e) =>
							e.kind === "session" &&
							typeof e.percent === "number" &&
							Number.isFinite(e.percent),
					)?.resets_at ?? null;
			}
			// No usable limits session — fall back to the (possibly empty) flat reset.
			if (!resetsAt && flat) resetsAt = flat.resets_at ?? null;
		}
		if (!resetsAt) return null;
		const ms = new Date(resetsAt).getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	return null;
}

/**
 * Fetch usage data from Anthropic's OAuth usage endpoint
 */
export interface UsageFetchResult {
	data: UsageData | null;
	retryAfterMs: number | null; // Set when server returns retry-after on 429
	/**
	 * Distinguishes failures that mean "this account's subscription/seat is
	 * gone" from transient ones. Anthropic answers the usage endpoint with
	 * 403 permission_error ("OAuth authentication is currently not allowed
	 * for this organization.") once a subscription lapses.
	 */
	failureKind: "subscription_expired" | null;
}

/**
 * Classify a non-OK usage-endpoint response. A 403 with an Anthropic
 * permission_error body is the expired-subscription signature.
 */
export function classifyUsageFetchFailure(
	status: number,
	errorBody: string | null,
): "subscription_expired" | null {
	if (status !== 403 || !errorBody) return null;
	try {
		const parsed = JSON.parse(errorBody) as { error?: { type?: string } };
		return parsed.error?.type === "permission_error"
			? "subscription_expired"
			: null;
	} catch {
		return null;
	}
}

export async function fetchUsageData(
	accessToken: string,
): Promise<UsageFetchResult> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);
	try {
		const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": `claude-code/${CLAUDE_CLI_VERSION}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			const errorMessage = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());

			// Extract retry-after on 429 so callers can schedule smarter backoff
			let retryAfterMs: number | null = null;
			if (response.status === 429) {
				const retryAfter = response.headers.get("retry-after");
				if (retryAfter) {
					const seconds = Number(retryAfter);
					if (Number.isFinite(seconds) && seconds > 0) {
						retryAfterMs = Math.round(seconds * 1000);
						log.warn(`Usage endpoint rate-limited, retry-after: ${seconds}s`);
					} else {
						const retryDateMs = new Date(retryAfter).getTime();
						if (Number.isFinite(retryDateMs)) {
							const deltaMs = retryDateMs - Date.now();
							if (deltaMs > 0) {
								retryAfterMs = deltaMs;
								log.warn(
									`Usage endpoint rate-limited, retry-after date: ${retryAfter}`,
								);
							}
						}
					}
				}
			}

			let errorBody: string | null = null;
			try {
				errorBody = await response.text();
				log.error(
					`Failed to fetch usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.anthropic.com/api/oauth/usage",
						headers: responseHeaders,
						errorBody: errorBody,
						timestamp: new Date().toISOString(),
					},
				);
			} catch {
				log.error(
					`Failed to fetch usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.anthropic.com/api/oauth/usage",
						headers: responseHeaders,
						timestamp: new Date().toISOString(),
					},
				);
			}
			return {
				data: null,
				retryAfterMs,
				failureKind: classifyUsageFetchFailure(response.status, errorBody),
			};
		}

		const data = (await response.json()) as UsageData;
		return { data, retryAfterMs: null, failureKind: null };
	} catch (error) {
		// Ensure we have a proper error object for logging
		const errorMessage =
			error instanceof Error
				? error.message
				: typeof error === "object" && error !== null
					? JSON.stringify(error)
					: String(error);

		log.error("Error fetching usage data:", errorMessage || "Unknown error");
		return { data: null, retryAfterMs: null, failureKind: null };
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Representative account-wide utilization for an Anthropic/Codex windowed
 * payload: the max of the account-session (5h), account-wide weekly, and the
 * OAuth-apps weekly (`seven_day_oauth_apps`) windows. The session + weekly are
 * sourced through {@link normalizeAnthropicUsage} so it reads flat AND
 * `limits[]`-only payloads identically; the OAuth-apps window (the Claude Code
 * weekly quota — the binding constraint for OAuth accounts) is folded in from
 * the flat field, since the normalizer's account-wide windows don't capture it.
 * `weekly_scoped` (per-family) and `extra_usage` are deliberately excluded.
 *
 * Why exclude `extra_usage`: overage-credit exhaustion is handled by the
 * dedicated `out_of_credits` floor-until cooldown path, NOT this generic
 * usage-based clear guard; and `getAccountCapacitySignal` still folds
 * `extra_usage` into `bindingUtilization` for load-balancer deprioritization —
 * so excluding it here only affects the cooldown-clear guard, intentionally.
 *
 * **Returns `null` when there is no account-level evidence — NEVER 0.** The old
 * reader collapsed "no windows" into `0`, which read as "plenty of headroom"
 * and (at the capacity-restored path) FALSELY CLEARED an account's
 * `rate_limited_until` cooldown for a `limits[]`-only payload. `null` keeps the
 * cooldown; a real 100% weekly (incl. OAuth-apps) stays 100 (never clears).
 */
export function getRepresentativeUtilization(
	usage: UsageData | null,
	now: number = Date.now(),
): number | null {
	const base = getNormalizedRepresentativeUtilization(
		normalizeAnthropicUsage(usage as AnthropicUsageData | null, now),
	);
	// Fold in the flat OAuth-apps weekly window if present. (If Anthropic ever
	// carries an OAuth-apps-equivalent in `limits[]`, add it to the normalizer;
	// flat is the known shape today.)
	const oauth = usage?.seven_day_oauth_apps;
	const oauthUtil =
		oauth &&
		typeof oauth.utilization === "number" &&
		Number.isFinite(oauth.utilization)
			? oauth.utilization
			: null;
	if (oauthUtil === null) return base;
	return base === null ? oauthUtil : Math.max(base, oauthUtil);
}

/**
 * Whether a successful usage poll should fire the capacity-restored callback
 * (which clears a stale `rate_limited_until`). True only when ALL hold:
 *  - the account was previously usage-rate-limited (`wasRateLimited`),
 *  - the account-wide representative utilization is a number below 100 (genuine
 *    headroom — `null`/no-evidence never clears), AND
 *  - the overage `extra_usage` window is below 100.
 *
 * The account-wide representative deliberately EXCLUDES `extra_usage`, so an
 * account whose overage credits are spent can read <100% here; vetoing on a
 * spent `extra_usage` prevents polling from wiping an overage / `out_of_credits`
 * floor. Belt-and-suspenders with the reason-aware guard at the callback site.
 */
export function shouldClearRateLimitOnCapacity(
	representativeUtilization: number | null,
	extraUsageUtilization: number | null | undefined,
	wasRateLimited: boolean,
): boolean {
	if (!wasRateLimited) return false;
	if (representativeUtilization === null || representativeUtilization >= 100)
		return false;
	if ((extraUsageUtilization ?? 0) >= 100) return false;
	return true;
}

/**
 * Determine which window is the most restrictive (highest utilization)
 * Dynamically handles any usage window fields in the response
 */
export function getRepresentativeWindow(
	usage: UsageData | null,
	now: number = Date.now(),
): string | null {
	if (!usage) return null;

	const windows: Array<{ name: string; util: number }> = [];

	// Iterate through all properties to find UsageWindow objects
	for (const [key, value] of Object.entries(usage)) {
		// Check if this is a UsageWindow object
		if (
			value &&
			typeof value === "object" &&
			"utilization" in value &&
			typeof value.utilization === "number"
		) {
			windows.push({ name: key, util: value.utilization });
		}
		// Also check extra_usage if present
		if (
			key === "extra_usage" &&
			value &&
			typeof value === "object" &&
			"utilization" in value &&
			typeof value.utilization === "number"
		) {
			windows.push({ name: key, util: value.utilization });
		}
	}

	// `limits[]`-only payload: no flat UsageWindow fields were found, so name the
	// binding window from the normalizer's account-wide windows.
	if (windows.length === 0) {
		const normalized = normalizeAnthropicUsage(
			usage as AnthropicUsageData | null,
			now,
		);
		if (normalized.session) {
			windows.push({ name: "five_hour", util: normalized.session.utilization });
		}
		if (normalized.weeklyAll) {
			windows.push({
				name: "seven_day",
				util: normalized.weeklyAll.utilization,
			});
		}
	}

	if (windows.length === 0) return null;

	const max = windows.reduce((prev, current) =>
		current.util > prev.util ? current : prev,
	);

	return max.name;
}

/**
 * Get the representative utilization for any supported provider type.
 * Returns null if the provider is not supported or data is unavailable.
 */
export function getRepresentativeUtilizationForProvider(
	data: AnyUsageData,
	provider: string,
): number | null {
	switch (provider) {
		case "anthropic":
		case "codex": {
			const d = data as UsageData;
			// Source the account-session (5h) and account-wide weekly windows through
			// the normalizer PER-WINDOW so flat AND `limits[]`-only AND mixed payloads
			// all resolve (the normalizer reads flat five_hour/seven_day first, else
			// the limits[] session/weekly_all entries). Then fold in the flat
			// OAuth-apps weekly window (Claude Code quota — not captured by the
			// normalizer) and `extra_usage` (kept for this ranking function's purpose).
			// Only account-level windows count; model-scoped seven_day_opus/sonnet are
			// excluded (mutual fallbacks, never both present).
			const normalized = normalizeAnthropicUsage(
				d as unknown as AnthropicUsageData,
				Date.now(),
			);
			const utils: number[] = [];
			if (normalized.session) utils.push(normalized.session.utilization);
			if (normalized.weeklyAll) utils.push(normalized.weeklyAll.utilization);
			if (d.seven_day_oauth_apps?.utilization != null)
				utils.push(d.seven_day_oauth_apps.utilization);
			if (d.extra_usage?.utilization != null)
				utils.push(d.extra_usage.utilization);
			return utils.length > 0 ? Math.max(...utils) : null;
		}
		case "zai": {
			const zai = data as ZaiUsageData;
			const candidates = [
				zai.time_limit?.percentage ?? null,
				zai.tokens_limit?.percentage ?? null,
			].filter((v): v is number => v !== null);
			return candidates.length > 0 ? Math.max(...candidates) : null;
		}
		case "kilo": {
			return getRepresentativeKiloUtilization(data as KiloUsageData);
		}
		case "alibaba-coding-plan": {
			return getRepresentativeAlibabaCodingPlanUtilization(
				data as AlibabaCodingPlanUsageData,
			);
		}
		default:
			return null;
	}
}

/**
 * Reduce a flat `UsageWindow` to {util, resetMs}, or null when absent / its
 * utilization is non-numeric. Used for the flat OAuth-apps weekly window, which
 * the normalizer's account-wide windows do not capture.
 */
function flatWindowToHard(
	w: UsageWindow | undefined,
): { util: number; resetMs: number | null } | null {
	if (!w || typeof w.utilization !== "number") return null;
	const ms = w.resets_at ? new Date(w.resets_at).getTime() : null;
	return {
		util: w.utilization,
		resetMs: ms !== null && Number.isFinite(ms) ? ms : null,
	};
}

export function getAccountCapacitySignal(
	data: AnyUsageData | null,
	provider: string,
	now: number,
): CapacitySignal | null {
	if (!data) return null;
	// Only Anthropic and Codex share the windowed UsageData shape. Others map later.
	if (provider !== "anthropic" && provider !== "codex") return null;
	const d = data as UsageData;
	// Source the hard windows PER-WINDOW: the normalizer resolves the session (5h)
	// and account-wide weekly from flat five_hour/seven_day first, else the
	// limits[] session/weekly_all entries — so flat, limits[]-only, AND mixed
	// (flat + limits[]) payloads all rank correctly. The flat OAuth-apps weekly
	// window (Claude Code quota) is added on top since the normalizer doesn't
	// capture it. Fully-flat payloads are byte-identical to the prior behavior.
	const normalized = normalizeAnthropicUsage(
		d as unknown as AnthropicUsageData,
		now,
	);
	const hard: Array<{ util: number; resetMs: number | null }> = [];
	if (normalized.session) {
		hard.push({
			util: normalized.session.utilization,
			resetMs: normalized.session.resetMs,
		});
	}
	if (normalized.weeklyAll) {
		hard.push({
			util: normalized.weeklyAll.utilization,
			resetMs: normalized.weeklyAll.resetMs,
		});
	}
	const oauthWindow = flatWindowToHard(d.seven_day_oauth_apps);
	if (oauthWindow) hard.push(oauthWindow);

	if (hard.length === 0) return null;
	// Content-staleness: if any present hard window is already past its reset, the
	// cached datum predates a window roll — treat as unknown so callers refresh.
	for (const w of hard) {
		if (w.resetMs !== null && w.resetMs <= now) return null;
	}
	let minHeadroom = 100;
	let binding = 0;
	let soonest: number | null = null;
	for (const w of hard) {
		minHeadroom = Math.min(minHeadroom, 100 - w.util);
		binding = Math.max(binding, w.util);
		if (w.resetMs !== null) {
			soonest = soonest === null ? w.resetMs : Math.min(soonest, w.resetMs);
		}
	}
	// extra_usage has no reset window: it bounds bindingUtilization only.
	if (d.extra_usage?.utilization != null) {
		binding = Math.max(binding, d.extra_usage.utilization);
	}
	// Second pass over WEEKLY windows only — these drive the HARVEST deadline.
	// The 5-hour window always resets sooner than the 7-day, so ranking by the
	// overall soonest reset never prioritizes the weekly quota (where unused
	// budget is genuinely lost at the reset). Rank HARVEST by the weekly reset
	// instead; the 5-hour stays as the NEAR_LIMIT safety gate (via minHeadroom).
	// The account-wide weekly comes from the normalizer (flat seven_day OR limits
	// weekly_all); the flat OAuth-apps weekly is folded in on top.
	const weeklyWindows: Array<{ util: number; resetMs: number | null }> = [];
	if (normalized.weeklyAll) {
		weeklyWindows.push({
			util: normalized.weeklyAll.utilization,
			resetMs: normalized.weeklyAll.resetMs,
		});
	}
	if (oauthWindow) weeklyWindows.push(oauthWindow);
	let weeklyHeadroom = 100;
	let weeklyReset: number | null = null;
	for (const w of weeklyWindows) {
		weeklyHeadroom = Math.min(weeklyHeadroom, 100 - w.util);
		if (w.resetMs !== null)
			weeklyReset =
				weeklyReset === null ? w.resetMs : Math.min(weeklyReset, w.resetMs);
	}
	// Binding weekly window = the MOST-constrained (max utilization). Among all
	// windows tied at that max, the constraint persists until the LATEST reset, so
	// take the max; but if ANY tied window has an unknown reset, the binding reset
	// is ambiguous → null (the reservation gate then fails open on it).
	let bindingWeeklyResetMs: number | null = null;
	if (weeklyWindows.length > 0) {
		let maxWeeklyUtil = Number.NEGATIVE_INFINITY;
		for (const w of weeklyWindows)
			maxWeeklyUtil = Math.max(maxWeeklyUtil, w.util);
		const binding = weeklyWindows.filter((w) => w.util === maxWeeklyUtil);
		if (binding.some((w) => w.resetMs === null)) {
			bindingWeeklyResetMs = null;
		} else {
			bindingWeeklyResetMs = binding.reduce(
				(mx, w) => Math.max(mx, w.resetMs as number),
				Number.NEGATIVE_INFINITY,
			);
			if (!Number.isFinite(bindingWeeklyResetMs)) bindingWeeklyResetMs = null;
		}
	}
	// The 5h session window's own headroom — NOT recoverable from minHeadroom
	// (min() over all windows loses which window binds). 100 when absent.
	const sessionHeadroom = normalized.session
		? 100 - normalized.session.utilization
		: 100;
	return {
		minHeadroom,
		sessionHeadroom,
		soonestResetMs: soonest,
		bindingUtilization: binding,
		weeklyResetMs: weeklyReset,
		bindingWeeklyResetMs,
		weeklyHeadroom,
	};
}

export function getFreshCapacity(
	cache: Pick<UsageCache, "get" | "getAge">,
	accountId: string,
	provider: string,
	now: number,
	maxAgeMs: number,
): CapacitySignal | null {
	const age = cache.getAge(accountId);
	if (age === null || age > maxAgeMs) return null; // age-stale → unknown
	return getAccountCapacitySignal(cache.get(accountId), provider, now);
}

/**
 * Type for a function that retrieves a fresh access token or API key
 */
export type AccessTokenProvider = () => Promise<string>;

/**
 * In-memory cache for usage data per account
 */
class UsageCache {
	private cache = new Map<string, { data: AnyUsageData; timestamp: number }>();
	private pollTimeouts = new Map<string, NodeJS.Timeout>();
	private failureCounts = new Map<string, number>();
	private tokenProviders = new Map<string, AccessTokenProvider>();
	private providerTypes = new Map<string, string>(); // Track provider type for each account
	private customEndpoints = new Map<string, string | null>(); // Track custom endpoints
	private windowResetCallbacks = new Map<string, (accountId: string) => void>();
	private usageRateLimitedUntil = new Map<string, number>(); // Tracks when usage API 429 clears
	private capacityRestoredCallbacks = new Map<
		string,
		(accountId: string) => void
	>();
	// Accounts whose last usage fetch failed with the expired-subscription
	// signature. Drives the once-per-transition subscriptionExpired /
	// usageRecovered callbacks.
	private subscriptionExpiredAccounts = new Set<string>();
	private subscriptionExpiredCallbacks = new Map<
		string,
		(accountId: string) => void
	>();
	private usageRecoveredCallbacks = new Map<
		string,
		(accountId: string) => void
	>();
	// Optional per-account hook invoked when the token provider throws during a
	// poll tick. Returning true tells the loop to STOP polling this account
	// (e.g. the refresh token is dead AND the account is paused → unrecoverable
	// without a manual reauth). Absent/false → normal retry-with-backoff.
	private tokenRefreshFailureHandlers = new Map<
		string,
		(accountId: string, error: unknown) => boolean | Promise<boolean>
	>();
	// Accounts that have had at least one successful fetch this process. The
	// first success also fires usageRecovered so a subscription_expired pause
	// persisted before a restart can still be lifted once the seat is back.
	private hasSucceededOnce = new Set<string>();
	private inFlightFetches = new Map<
		string,
		Promise<{ success: boolean; retryAfterMs: number | null }>
	>();
	// Demand-aware polling state (Anthropic only — set when startPolling receives
	// a PollingPolicy with demandAware:true). See PollingPolicy / noteActivity.
	private pollingPolicies = new Map<string, PollingPolicy>();
	// Real-time activity signal: the last time (ms since epoch) an account served
	// a request, recorded by noteActivity from the proxy path. Primary cadence
	// source and the idle→active re-arm trigger. Never a captured Account value.
	private lastActivityAt = new Map<string, number>();
	// Bookkeeping for the currently-armed poll timer so noteActivity can decide
	// whether an idle-sleeping account should be re-armed to the active cadence.
	private pollSchedule = new Map<
		string,
		{ wakeAt: number; isIdle: boolean; activeBaseMs: number }
	>();

	/**
	 * Schedule the next poll with exponential backoff on failures.
	 * If retryAfterMs is provided (from a 429 retry-after header), it takes
	 * precedence over the calculated backoff delay.
	 */
	private scheduleNextPoll(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		baseIntervalMs: number,
		provider?: string,
		customEndpoint?: string | null,
		retryAfterMs?: number | null,
	) {
		const failures = this.failureCounts.get(accountId) ?? 0;
		const policy = this.pollingPolicies.get(accountId);
		// The demand-aware active/idle decision only matters for a HEALTHY tick:
		// on a server retry-after or during failure backoff the backoff delay wins
		// regardless, and activity is irrelevant. Non-demand-aware providers always
		// take the fixed active cadence (their prior behavior, byte-identical).
		const healthyDemandAware =
			!!policy?.demandAware && failures === 0 && retryAfterMs == null;
		if (!healthyDemandAware) {
			this.armNextPoll(
				accountId,
				tokenProvider,
				baseIntervalMs,
				provider,
				customEndpoint,
				retryAfterMs ?? null,
				null,
			);
			return;
		}

		// Prefer the in-memory real-time activity map. Only when NOTHING has been
		// observed yet (cold start, e.g. just after a restart) do we consult the
		// injected live resolver — async, so guarded before arming.
		const mapActivity = this.lastActivityAt.get(accountId);
		if (mapActivity !== undefined || !policy?.getLastActivityMs) {
			this.armNextPoll(
				accountId,
				tokenProvider,
				baseIntervalMs,
				provider,
				customEndpoint,
				null,
				mapActivity ?? null,
			);
			return;
		}
		Promise.resolve(policy.getLastActivityMs(accountId))
			.then((resolved) =>
				this.armAfterResolve(
					accountId,
					tokenProvider,
					baseIntervalMs,
					provider,
					customEndpoint,
					resolved ?? null,
				),
			)
			.catch(() =>
				// Resolver failure → treat as unknown activity → idle cadence (safe:
				// reduces pressure on the shared bucket).
				this.armAfterResolve(
					accountId,
					tokenProvider,
					baseIntervalMs,
					provider,
					customEndpoint,
					null,
				),
			);
	}

	/**
	 * Arm the next poll after the (possibly async) cold-start activity resolver
	 * settled. Identity-guarded: a stopPolling()/restart during the await must not
	 * resurrect this generation, and if noteActivity already armed a timer in the
	 * meantime we leave it alone.
	 */
	private armAfterResolve(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		baseIntervalMs: number,
		provider: string | undefined,
		customEndpoint: string | null | undefined,
		resolved: number | null,
	) {
		if (this.tokenProviders.get(accountId) !== tokenProvider) return;
		if (this.pollTimeouts.has(accountId)) return;
		// Any real-time activity observed during the await wins over the DB value.
		const observed = this.lastActivityAt.get(accountId);
		this.armNextPoll(
			accountId,
			tokenProvider,
			baseIntervalMs,
			provider,
			customEndpoint,
			null,
			observed ?? resolved,
		);
	}

	/**
	 * Compute the poll delay (retry-after / backoff / demand-aware base + jitter)
	 * and arm the timer. `activeBaseMs` is the configured active cadence, threaded
	 * unchanged across ticks; `lastActivityMs` only influences the healthy base
	 * cadence decision.
	 */
	private armNextPoll(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		activeBaseMs: number,
		provider: string | undefined,
		customEndpoint: string | null | undefined,
		retryAfterMs: number | null,
		lastActivityMs: number | null,
	) {
		const failures = this.failureCounts.get(accountId) ?? 0;
		const policy = this.pollingPolicies.get(accountId);
		// ±20% random jitter so accounts spread out and don't lock into sync.
		const jitterFraction = (Math.random() - 0.5) * 0.4;
		const { delayMs, isIdle } = computePollDelay({
			demandAware: policy?.demandAware,
			idleIntervalMs: policy?.idleIntervalMs,
			activityRecencyMs: policy?.activityRecencyMs,
			activeIntervalMs: activeBaseMs,
			lastActivityMs,
			failures,
			retryAfterMs,
			now: Date.now(),
			jitterFraction,
		});

		if (failures > 0) {
			log.info(
				`Usage poll backoff for account ${accountId}: retry in ${Math.round(delayMs / 1000)}s (${failures} consecutive failure(s))${retryAfterMs != null ? " [server retry-after]" : ""}`,
			);
		}

		const timeoutId = setTimeout(async () => {
			this.pollTimeouts.delete(accountId);
			this.pollSchedule.delete(accountId);
			// Bail if polling was stopped OR restarted with a new provider since this
			// tick was scheduled. Identity (not mere presence) guards against a
			// zombie loop: stopPolling()+startPolling() (e.g. reauth) installs a new
			// provider, and the old in-flight loop must not keep polling with its
			// stale closure alongside the new one.
			if (this.tokenProviders.get(accountId) !== tokenProvider) return;

			const { success, retryAfterMs: nextRetryAfterMs } =
				await this.fetchAndCache(
					accountId,
					tokenProvider,
					provider,
					customEndpoint,
				);
			if (success) {
				this.failureCounts.delete(accountId); // reset streak on success
			} else {
				const count = (this.failureCounts.get(accountId) ?? 0) + 1;
				this.failureCounts.set(accountId, count);
			}
			// Schedule the next poll only if this provider is still the active one
			// (identity guard — see the bail check above).
			if (this.tokenProviders.get(accountId) === tokenProvider) {
				this.scheduleNextPoll(
					accountId,
					tokenProvider,
					activeBaseMs,
					provider,
					customEndpoint,
					nextRetryAfterMs,
				);
			}
		}, delayMs);

		this.pollTimeouts.set(accountId, timeoutId);
		this.pollSchedule.set(accountId, {
			wakeAt: Date.now() + delayMs,
			isIdle,
			activeBaseMs,
		});
	}

	/**
	 * Record that an account just served a request (the demand-aware activity
	 * signal) and, if it is currently sleeping on an idle-cadence timer, re-arm it
	 * to the active cadence promptly. Without this an account that goes from idle
	 * to busy could wait out most of a ~10-minute idle sleep before the scheduler
	 * notices. Cheap and identity-guarded: a no-op for providers without
	 * demand-aware polling and for stopped pollers (never resurrects one).
	 */
	noteActivity(accountId: string, now: number = Date.now()): void {
		this.lastActivityAt.set(accountId, now);
		const policy = this.pollingPolicies.get(accountId);
		if (!policy?.demandAware) return;
		// Don't resurrect a stopped poller.
		const tokenProvider = this.tokenProviders.get(accountId);
		if (!tokenProvider) return;
		const sched = this.pollSchedule.get(accountId);
		// Only re-arm when currently sleeping on an IDLE timer. An active or
		// backoff timer is left untouched (backoff must keep winning).
		if (!sched?.isIdle) return;
		// Skip if the pending idle wake is already within ~one active interval
		// (incl. max +20% jitter) — re-arming could only push it further out.
		if (sched.wakeAt - now <= sched.activeBaseMs * 1.2) return;
		const existing = this.pollTimeouts.get(accountId);
		if (existing) clearTimeout(existing);
		this.pollTimeouts.delete(accountId);
		this.pollSchedule.delete(accountId);
		// scheduleNextPoll re-reads lastActivityAt (now fresh) → active cadence.
		this.scheduleNextPoll(
			accountId,
			tokenProvider,
			sched.activeBaseMs,
			this.providerTypes.get(accountId),
			this.customEndpoints.get(accountId),
			null,
		);
	}

	/**
	 * Start polling for an account's usage data
	 */
	startPolling(
		accountId: string,
		accessTokenOrProvider: string | AccessTokenProvider,
		provider?: string,
		intervalMs?: number,
		customEndpoint?: string | null,
		onWindowReset?: (accountId: string) => void,
		onCapacityRestored?: (accountId: string) => void,
		onSubscriptionExpired?: (accountId: string) => void,
		onUsageRecovered?: (accountId: string) => void,
		onTokenRefreshFailure?: (
			accountId: string,
			error: unknown,
		) => boolean | Promise<boolean>,
		policy?: PollingPolicy,
	) {
		// Check if provider supports usage tracking
		if (provider && !supportsUsageTracking(provider)) {
			log.info(
				`Skipping usage polling for account ${accountId} - provider ${provider} does not support usage tracking`,
			);
			return;
		}

		// Stop existing polling if any to prevent leaks
		const existing = this.pollTimeouts.get(accountId);
		if (existing) {
			clearTimeout(existing);
			log.warn(
				`Clearing existing polling timeout for account ${accountId} before starting new one`,
			);
		}

		// Reset failure count for fresh start
		this.failureCounts.delete(accountId);

		// Store the token provider (either a static token or a function)
		const tokenProvider: AccessTokenProvider =
			typeof accessTokenOrProvider === "string"
				? async () => accessTokenOrProvider
				: accessTokenOrProvider;
		this.tokenProviders.set(accountId, tokenProvider);

		// Store provider type, custom endpoint, and window-reset callback for this account
		if (provider) {
			this.providerTypes.set(accountId, provider);
		}
		if (customEndpoint !== undefined) {
			this.customEndpoints.set(accountId, customEndpoint);
		}
		if (onWindowReset) {
			this.windowResetCallbacks.set(accountId, onWindowReset);
		} else {
			this.windowResetCallbacks.delete(accountId);
		}
		if (onCapacityRestored) {
			this.capacityRestoredCallbacks.set(accountId, onCapacityRestored);
		} else {
			this.capacityRestoredCallbacks.delete(accountId);
		}
		if (onSubscriptionExpired) {
			this.subscriptionExpiredCallbacks.set(accountId, onSubscriptionExpired);
		} else {
			this.subscriptionExpiredCallbacks.delete(accountId);
		}
		if (onUsageRecovered) {
			this.usageRecoveredCallbacks.set(accountId, onUsageRecovered);
		} else {
			this.usageRecoveredCallbacks.delete(accountId);
		}
		if (onTokenRefreshFailure) {
			this.tokenRefreshFailureHandlers.set(accountId, onTokenRefreshFailure);
		} else {
			this.tokenRefreshFailureHandlers.delete(accountId);
		}
		// Demand-aware polling policy (Anthropic only). Absent → fixed cadence.
		if (policy) {
			this.pollingPolicies.set(accountId, policy);
		} else {
			this.pollingPolicies.delete(accountId);
		}
		// Fresh start: drop any stale activity/schedule bookkeeping from a prior
		// generation so cadence decisions start from a clean slate.
		this.lastActivityAt.delete(accountId);
		this.pollSchedule.delete(accountId);

		// Default to 90s if not provided
		const baseIntervalMs = intervalMs ?? 90000;

		// Immediate fetch
		this.fetchAndCache(accountId, tokenProvider, provider, customEndpoint).then(
			({ success, retryAfterMs }) => {
				if (!success) {
					this.failureCounts.set(accountId, 1);
				}
				// Identity guard: only start the loop if this provider is still the
				// active one (a concurrent restart may have swapped it).
				if (this.tokenProviders.get(accountId) === tokenProvider) {
					this.scheduleNextPoll(
						accountId,
						tokenProvider,
						baseIntervalMs,
						provider,
						customEndpoint,
						retryAfterMs,
					);
				}
			},
		);

		log.debug(
			`Started usage polling for account ${accountId} (provider: ${provider}) with base interval ${Math.round(baseIntervalMs / 1000)}s`,
		);
	}

	/**
	 * Trigger an immediate usage fetch for an account that already has polling configured.
	 * Returns false when no polling/token provider is configured or when the fetch fails.
	 */
	async refreshNow(accountId: string): Promise<boolean> {
		const tokenProvider = this.tokenProviders.get(accountId);
		if (!tokenProvider) {
			return false;
		}

		const provider = this.providerTypes.get(accountId);
		const customEndpoint = this.customEndpoints.get(accountId);
		const { success } = await this.fetchAndCache(
			accountId,
			tokenProvider,
			provider,
			customEndpoint,
		);
		return success;
	}

	/**
	 * Stop polling for an account
	 */
	stopPolling(accountId: string) {
		const timeout = this.pollTimeouts.get(accountId);
		if (timeout) {
			clearTimeout(timeout);
			this.pollTimeouts.delete(accountId);
		}
		if (this.tokenProviders.has(accountId)) {
			this.tokenProviders.delete(accountId);
			this.failureCounts.delete(accountId);
			this.windowResetCallbacks.delete(accountId);
			this.capacityRestoredCallbacks.delete(accountId);
			this.subscriptionExpiredCallbacks.delete(accountId);
			this.usageRecoveredCallbacks.delete(accountId);
			this.tokenRefreshFailureHandlers.delete(accountId);
			this.subscriptionExpiredAccounts.delete(accountId);
			this.hasSucceededOnce.delete(accountId);
			// Clean up cache entry when polling stops to prevent memory leaks
			this.cache.delete(accountId);
			this.usageRateLimitedUntil.delete(accountId);
			// Clear any in-flight fetch so it doesn't linger after polling stops.
			this.inFlightFetches.delete(accountId);
			// Demand-aware polling bookkeeping.
			this.pollingPolicies.delete(accountId);
			this.lastActivityAt.delete(accountId);
			this.pollSchedule.delete(accountId);
			log.info(
				`Stopped usage polling and cleared cache for account ${accountId}`,
			);
		}
	}

	/**
	 * Fetch and cache usage data.
	 * Returns { success, retryAfterMs } where retryAfterMs is set when the
	 * server returns a retry-after header on a 429 response.
	 */
	private async fetchAndCache(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		provider?: string,
		customEndpoint?: string | null,
	): Promise<{ success: boolean; retryAfterMs: number | null }> {
		// Deduplicate concurrent fetches for the same account — return the
		// existing in-flight promise rather than starting a second HTTP request.
		const inflight = this.inFlightFetches.get(accountId);
		if (inflight) {
			log.debug(
				`Reusing in-flight fetch for account ${accountId} — skipping duplicate request`,
			);
			return inflight;
		}

		const promise = this._doFetchAndCache(
			accountId,
			tokenProvider,
			provider,
			customEndpoint,
		);
		this.inFlightFetches.set(accountId, promise);
		promise.finally(() => {
			// Identity-guarded: a restart (stopPolling + startPolling) during this
			// fetch may have installed a newer in-flight entry for the same account;
			// only clear our own so we don't wipe the current generation's dedup.
			if (this.inFlightFetches.get(accountId) === promise) {
				this.inFlightFetches.delete(accountId);
			}
		});
		return promise;
	}

	private async _doFetchAndCache(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		provider?: string,
		_customEndpoint?: string | null,
	): Promise<{ success: boolean; retryAfterMs: number | null }> {
		try {
			// Get a fresh access token or API key on each fetch
			let token: string;
			try {
				token = await tokenProvider();
			} catch (tokenError) {
				// Handle token provider errors that might result in empty objects
				const tokenErrorMessage =
					tokenError instanceof Error
						? tokenError.message
						: typeof tokenError === "object" && tokenError !== null
							? JSON.stringify(tokenError)
							: String(tokenError);

				// Give the owner a chance to halt polling on an unrecoverable
				// failure (dead refresh token on a paused account → manual reauth
				// required). stopPolling() removes the token provider so neither the
				// immediate-fetch nor scheduleNextPoll will reschedule this account.
				const halt = this.tokenRefreshFailureHandlers.get(accountId);
				if (halt) {
					let shouldStop = false;
					try {
						shouldStop = await halt(accountId, tokenError);
					} catch (handlerError) {
						log.warn(
							`onTokenRefreshFailure handler threw for account ${accountId}: ${
								handlerError instanceof Error
									? handlerError.message
									: String(handlerError)
							}`,
						);
					}
					if (shouldStop) {
						log.info(
							`Halting usage polling for account ${accountId}: refresh token unrecoverable and account paused — reauth to resume`,
						);
						this.stopPolling(accountId);
						return { success: false, retryAfterMs: null };
					}
				}

				log.warn(
					`Token provider failed for account ${accountId}: ${tokenErrorMessage || "Unknown error"}`,
				);
				return { success: false, retryAfterMs: null };
			}

			// Validate token before proceeding
			if (!token || (typeof token === "string" && token.trim() === "")) {
				log.warn(
					`No valid token available for account ${accountId}, skipping usage fetch`,
				);
				return { success: false, retryAfterMs: null };
			}

			// Fetch data based on provider type
			let data: AnyUsageData | null = null;

			if (provider === "zai") {
				// Fetch Zai usage data
				data = await fetchZaiUsageData(token);
				if (data) {
					// Import Zai helper functions
					const {
						getRepresentativeZaiUtilization,
						getRepresentativeZaiWindow,
					} = await import("./zai-usage-fetcher");

					const callback = this.windowResetCallbacks.get(accountId);
					if (callback)
						this.notifyWindowReset(accountId, data, "zai", callback);
					this.cache.set(accountId, { data, timestamp: Date.now() });
					const utilization = getRepresentativeZaiUtilization(
						data as ZaiUsageData,
					);
					const window = getRepresentativeZaiWindow(data as ZaiUsageData);
					log.debug(
						`Successfully fetched Zai usage data for account ${accountId}: ${utilization}% (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "kilo") {
				// Fetch Kilo usage data
				data = await fetchKiloUsageData(token);
				if (data) {
					this.cache.set(accountId, { data, timestamp: Date.now() });
					const utilization = getRepresentativeKiloUtilization(
						data as KiloUsageData,
					);
					const window = getRepresentativeKiloWindow(data as KiloUsageData);
					log.debug(
						`Successfully fetched Kilo usage data for account ${accountId}: $${(data as KiloUsageData).remainingUsd.toFixed(2)} remaining (${utilization?.toFixed(1)}% used, ${window})`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "alibaba-coding-plan") {
				// Fetch Alibaba Coding Plan usage data
				data = await fetchAlibabaCodingPlanUsageData(token);
				if (data) {
					this.cache.set(accountId, { data, timestamp: Date.now() });
					const utilization = getRepresentativeAlibabaCodingPlanUtilization(
						data as AlibabaCodingPlanUsageData,
					);
					const window = getRepresentativeAlibabaCodingPlanWindow(
						data as AlibabaCodingPlanUsageData,
					);
					log.debug(
						`Successfully fetched Alibaba Coding Plan usage data for account ${accountId}: ${utilization?.toFixed(1)}% used (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else {
				// Default to Anthropic usage data
				const result = await fetchUsageData(token);
				if (result.data) {
					// Subscription-expired recovery: fire usageRecovered on the
					// failure→success transition, and also on the FIRST success of this
					// process so a 'subscription_expired' pause persisted before a
					// restart is lifted once the seat works again. The callback is
					// expected to check the account's pause_reason and no-op otherwise.
					const wasExpired = this.subscriptionExpiredAccounts.delete(accountId);
					const firstSuccess = !this.hasSucceededOnce.has(accountId);
					this.hasSucceededOnce.add(accountId);
					if (wasExpired || firstSuccess) {
						const recoveredCallback =
							this.usageRecoveredCallbacks.get(accountId);
						if (recoveredCallback) recoveredCallback(accountId);
					}
					// Snapshot before clearing — needed for the capacity-restored guard below.
					const wasRateLimited = this.usageRateLimitedUntil.has(accountId);
					this.usageRateLimitedUntil.delete(accountId);
					const callback = this.windowResetCallbacks.get(accountId);
					if (callback)
						this.notifyWindowReset(
							accountId,
							result.data,
							"anthropic",
							callback,
						);
					this.cache.set(accountId, {
						data: result.data,
						timestamp: Date.now(),
					});
					const utilization = getRepresentativeUtilization(
						result.data as UsageData,
					);
					// Notify capacity-restored listener only when the account was previously
					// rate-limited (usageRateLimitedUntil set) and usage now shows genuine
					// account-wide headroom. This handles seat-reassignment: org admin
					// reassigns a seat mid-window, Anthropic resets usage, polling detects
					// available capacity and lets the caller clear stale rate_limited_until.
					if (
						shouldClearRateLimitOnCapacity(
							utilization,
							(result.data as UsageData).extra_usage?.utilization,
							wasRateLimited,
						)
					) {
						const capacityCallback =
							this.capacityRestoredCallbacks.get(accountId);
						if (capacityCallback) capacityCallback(accountId);
					}
					const window = getRepresentativeWindow(result.data as UsageData);
					log.debug(
						`Successfully fetched usage data for account ${accountId}: ${utilization}% (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
				if (result.retryAfterMs != null && result.retryAfterMs > 0) {
					this.usageRateLimitedUntil.set(
						accountId,
						Date.now() + result.retryAfterMs,
					);
				} else if (result.retryAfterMs == null) {
					// Non-429 failure: clear any stale rate-limit marker
					this.usageRateLimitedUntil.delete(accountId);
				}
				// Subscription-expired detection: fire the callback once per
				// transition into the expired state (not on every failing poll).
				if (
					result.failureKind === "subscription_expired" &&
					!this.subscriptionExpiredAccounts.has(accountId)
				) {
					this.subscriptionExpiredAccounts.add(accountId);
					log.warn(
						`Usage endpoint reports expired subscription for account ${accountId}`,
					);
					const expiredCallback =
						this.subscriptionExpiredCallbacks.get(accountId);
					if (expiredCallback) expiredCallback(accountId);
				}
				return { success: false, retryAfterMs: result.retryAfterMs };
			}

			return { success: false, retryAfterMs: null };
		} catch (error) {
			// Ensure we have a proper error object for logging
			const errorMessage =
				error instanceof Error
					? error.message
					: typeof error === "object" && error !== null
						? JSON.stringify(error)
						: String(error);

			log.error(
				`Error fetching usage data for account ${accountId}:`,
				errorMessage || "Unknown error",
			);
			return { success: false, retryAfterMs: null };
		}
	}

	/**
	 * Clean up stale cache entries older than maxAgeMs
	 */
	cleanupStaleEntries(maxAgeMs: number = USAGE_CACHE_TTL_MS): void {
		const now = Date.now();
		let cleanedCount = 0;

		for (const [accountId, cached] of this.cache.entries()) {
			if (now - cached.timestamp > maxAgeMs) {
				this.cache.delete(accountId);
				cleanedCount++;
			}
		}

		if (cleanedCount > 0) {
			log.debug(`Cleaned up ${cleanedCount} stale usage cache entries`);
		}
	}

	/**
	 * Get cached usage data for an account
	 */
	get(accountId: string): AnyUsageData | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;

		// Clean up stale entries while accessing
		const age = Date.now() - cached.timestamp;
		if (age > USAGE_CACHE_TTL_MS) {
			// 10 minutes max age
			this.cache.delete(accountId);
			log.debug(
				`Removed stale cache entry for account ${accountId} (age: ${Math.round(age / 1000)}s)`,
			);
			return null;
		}

		return cached.data;
	}

	/**
	 * Non-evicting read of cached usage data. Returns the cached data, or null if
	 * the entry is missing OR stale (age > USAGE_CACHE_TTL_MS). Unlike get(), this
	 * NEVER deletes the entry — a stale entry stays in the map so that later
	 * eviction (via get()/getAge()/cleanupStaleEntries) and window-reset
	 * comparisons (notifyWindowReset reads the raw map) behave as if no read
	 * happened. Use for pure observers/inspection that must not mutate cache state.
	 */
	peek(accountId: string): AnyUsageData | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;

		const age = Date.now() - cached.timestamp;
		if (age > USAGE_CACHE_TTL_MS) return null; // stale — but do NOT evict

		return cached.data;
	}

	/**
	 * Set cached usage data for an account
	 */
	set(accountId: string, data: AnyUsageData): void {
		this.cache.set(accountId, { data, timestamp: Date.now() });

		// Periodic cleanup of stale entries to prevent memory bloat
		// Run cleanup every 100 sets to balance performance and memory
		if (this.cache.size % 100 === 0) {
			this.cleanupStaleEntries();
		}
	}

	/**
	 * Check if the usage window has reset by comparing the new data's reset time
	 * against the previously cached data, and fire the callback if it has advanced.
	 * Should be called after successfully fetching new data, before updating the cache.
	 * No-ops on the first poll (no previous data) to avoid spurious resets.
	 *
	 * A genuine window roll is detected only when the previously-tracked reset
	 * time has actually ARRIVED (`prevResetAt <= now`) and a new, later reset is
	 * reported. The provider returns a `resets_at` that drifts forward by a few
	 * hundred ms on every poll while the SAME window is still in the future
	 * (e.g. 10:40:00.641Z → 10:40:00.856Z); without the `prevResetAt <= now`
	 * guard that sub-second drift was mis-detected as a reset on every poll,
	 * firing the callback (which bumps `session_start` / resets session tracking)
	 * ~once per poll and churning state continuously.
	 */
	notifyWindowReset(
		accountId: string,
		newData: AnyUsageData,
		provider: string,
		callback: (accountId: string) => void,
		now: number = Date.now(),
	): void {
		const previous = this.cache.get(accountId);
		if (!previous) return; // first poll — no baseline to compare against

		const prevResetAt = extractWindowResetTime(previous.data, provider);
		const newResetAt = extractWindowResetTime(newData, provider);

		if (isGenuineWindowRoll(prevResetAt, newResetAt, now)) {
			// isGenuineWindowRoll guarantees both are non-null here; the assertions
			// keep the log line's ISO formatting identical to the prior inline guard.
			log.info(
				`Usage window reset detected for account ${accountId} (${provider}): ` +
					// biome-ignore lint/style/noNonNullAssertion: non-null guaranteed by isGenuineWindowRoll
					`${new Date(prevResetAt!).toISOString()} → ${new Date(newResetAt!).toISOString()}`,
			);
			callback(accountId);
		}
	}

	/**
	 * Returns the timestamp (ms since epoch) until which the usage API is rate-limited
	 * for this account, or null if not currently rate-limited.
	 */
	getRateLimitedUntil(accountId: string): number | null {
		const until = this.usageRateLimitedUntil.get(accountId);
		if (until === undefined) return null;
		if (Date.now() >= until) {
			this.usageRateLimitedUntil.delete(accountId);
			return null;
		}
		return until;
	}

	/**
	 * Get cached data age in milliseconds
	 */
	getAge(accountId: string): number | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;

		const age = Date.now() - cached.timestamp;
		// Clean up if too old
		if (age > USAGE_CACHE_TTL_MS) {
			// 10 minutes max age
			this.cache.delete(accountId);
			return null;
		}

		return age;
	}

	/**
	 * Non-evicting read of cached data age in milliseconds. Returns the age of the
	 * entry if one exists (EVEN IF stale, i.e. age > USAGE_CACHE_TTL_MS), or null
	 * only when there is no entry at all. This deliberately differs from getAge(),
	 * which treats a stale entry as absent (returns null) and evicts it. peekAge()
	 * NEVER deletes, so callers can inspect true age — including staleness — for
	 * pure observation without mutating cache state. Pair with peek() (which
	 * returns null once stale) when staleness should gate the data itself.
	 */
	peekAge(accountId: string): number | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;
		return Date.now() - cached.timestamp;
	}

	/**
	 * Clear cached data for a specific account
	 */
	delete(accountId: string): void {
		this.cache.delete(accountId);
		log.debug(`Cleared usage cache for account ${accountId}`);
	}

	/**
	 * Clear all cached data and stop all polling
	 */
	clear() {
		for (const accountId of this.tokenProviders.keys()) {
			this.stopPolling(accountId);
		}
		this.cache.clear();
		this.usageRateLimitedUntil.clear();
		log.info("Cleared all usage cache and stopped polling");
	}
}

// Export singleton instance
export const usageCache = new UsageCache();
