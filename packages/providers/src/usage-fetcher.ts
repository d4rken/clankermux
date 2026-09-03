import {
	CLAUDE_CLI_VERSION,
	collectObservedWindows,
	normalizeAnthropicUsage,
	type ObservedWindow,
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
import {
	fetchMinimaxUsageData,
	getRepresentativeMinimaxUtilization,
	getRepresentativeMinimaxWindow,
	type MinimaxUsageData,
} from "./minimax-usage-fetcher";
import type { CodexCreditsInfo } from "./providers/codex/usage";
import { isGenuineWindowRoll } from "./window-reset";
import { fetchZaiUsageData, type ZaiUsageData } from "./zai-usage-fetcher";

const log = new Logger("UsageFetcher");

/**
 * Max age of a cached usage entry before it is considered stale for ROUTING.
 *
 * Read contracts differ by method:
 *  - get() / getAge(): evicting. A stale entry is treated as absent — the read
 *    returns null AND deletes the entry.
 *  - peek(): non-evicting DATA read. A stale entry returns null but is left in
 *    place (so later eviction and window-reset comparisons see it).
 *  - peekAge(): non-evicting AGE read, and one of the exceptions to the
 *    "stale → null" rule — it returns the entry's TRUE age even when stale, and
 *    only returns null when NO entry exists. This lets pure observers (e.g. the
 *    usage snapshot sampler) apply their own freshness threshold, independent of
 *    this TTL. Pair it with peek() when staleness should gate the data itself.
 *  - peekWrittenAt(): non-evicting ABSOLUTE WRITE-TIME read, another exception
 *    to "stale → null" — it returns the entry's true timestamp even
 *    when stale, and null only when NO entry exists. For callers comparing an
 *    entry's write time across an await; never reconstruct that instant as
 *    `now - peekAge()` (two clock reads, so it skews by whatever elapsed between
 *    them).
 *  - peekWithAge(): non-evicting DATA+AGE read for the DASHBOARD. Also returns a
 *    stale entry (data plus its true age) so the UI can render an honest "as of"
 *    age instead of claiming the data is unavailable; it returns null only when
 *    no entry exists or the entry is past the much longer
 *    {@link UI_STALE_HORIZON_MS}. Never used by routing. Reports `observedAtMs`
 *    alongside the write time — see the provenance note below.
 *
 * WRITE TIME IS NOT OBSERVATION TIME. Every entry carries both:
 *  - `timestamp`, the moment it was WRITTEN here. It is what all the freshness
 *    and TTL logic above runs on, and nothing else.
 *  - `observedAtMs`, when the reading itself was OBSERVED at the provider, or
 *    null when the writer cannot honestly say.
 * They coincide for a live fetch and diverge for a RECONSTRUCTED reading — the
 * Codex stored-payload recovery re-seeds this cache with headers that may
 * predate the write by hours, and it seeds through {@link UsageCache.setUntimed}
 * so the entry keeps saying "observation time unknown" on every later read.
 * Anything deriving an "as of" stamp or anchoring a projection MUST read
 * `observedAtMs`; taking the write time instead is how a recovered reading
 * silently gains a fresh, confident timestamp on the second refetch.
 */
export const USAGE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * How long a cached reading stays worth SHOWING (as an aged value) after it has
 * stopped being worth ROUTING on. Past this horizon peekWithAge() reports
 * absence and the dashboard falls back to the persisted snapshot. Deliberately
 * generous (3x the routing TTL): the failure it guards against is a poller that
 * died, and a half-hour-old number labelled with its age is still more useful
 * than a blank card.
 */
export const UI_STALE_HORIZON_MS = 30 * 60_000;

/**
 * Demand-aware polling cadence (Anthropic only — see {@link PollingPolicy}).
 *
 * IDLE_POLL_INTERVAL_MS: the base cadence a *cold* account (no recent traffic)
 * polls at.
 *
 * IDLE_REFRESH_LEAD_MS: headroom subtracted from {@link USAGE_CACHE_TTL_MS} when
 * scheduling, to absorb the refresh round-trip.
 *
 * WHAT IS ACTUALLY GUARANTEED: {@link computePollDelay} clamps the scheduled
 * DELAY of every demand-aware HEALTHY poll — active and idle alike — to
 * `USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS`. That bounds the timer, not the
 * age of the entry when its replacement is written: the true end-to-end gap is
 * `resolver latency + delay + timer lateness + token latency + fetch latency`,
 * and only `delay` is under our control. IDLE_REFRESH_LEAD_MS is HEADROOM for
 * that tail (a local DB read, a possible token refresh and a 5s-timeout HTTP
 * call — comfortably inside 60s in practice), NOT a proof. The negative-only
 * idle jitter (see {@link idleJitterFraction}) is belt-and-braces on top: idle
 * jitter can only pull a poll earlier, never later.
 *
 * The guarantee that a user NEVER sees a false "Live usage unavailable" comes
 * from the display side, not from this schedule: the dashboard reads through
 * {@link UsageCache.peekWithAge}, which keeps serving an expired entry (labelled
 * with its true age) up to {@link UI_STALE_HORIZON_MS}. The cadence work here
 * makes the common case fresh; the non-evicting read makes the tail honest.
 *
 * This replaces the original reasoning, which held that "letting an idle entry
 * lapse past the TTL between polls is safe" because routing fails open and the
 * account-selector can `refreshNow` on demand. That was true of ROUTING but
 * ignored the DASHBOARD: the accounts endpoint read the same cache, so every gap
 * between expiry and the replacement fetch painted a healthy account with the
 * amber "Live usage unavailable" banner. With a 10-minute cadence, ±20% jitter
 * and a 10-minute TTL, roughly half of all idle cycles produced such a gap.
 *
 * The clamp applies ONLY to the demand-aware healthy cadence. Non-demand-aware
 * providers (Zai/Kilo/Alibaba) pass no policy and keep their configured cadence
 * verbatim. Retry-after and the exponential failure backoff are likewise
 * unclamped — a failing account should keep backing off, and there is no fresh
 * reading to protect. (A successful on-demand {@link UsageCache.refreshNow}
 * ends such a backoff early; see that method.)
 *
 * ACTIVITY_RECENCY_MS: how recently an account must have served a request to be
 * treated as "active" (poll at the configured active cadence). 15 minutes.
 *
 * MAX_BACKOFF_MS: ceiling for the exponential failure backoff (unchanged).
 */
const IDLE_POLL_INTERVAL_MS = 10 * 60_000;
export const IDLE_REFRESH_LEAD_MS = 60_000;
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
	/**
	 * Defer the FIRST fetch by this many ms (the server's boot stagger, so a
	 * restart doesn't 429 the shared /oauth/usage bucket with one burst per
	 * account). Registration is NOT deferred: the token provider is installed
	 * synchronously, so `refreshNow` works from t=0. The stagger used to defer
	 * the whole `startPolling` call instead, which made `refreshNow` a silent
	 * no-op for the first `index * 5s` after every restart — a 429 in that
	 * window found the cache empty AND unrefreshable, every evidence rung of
	 * the 429 ladder failed open, and a family-scoped 429 locked the account
	 * account-wide (Claude-Backup-2, 2026-08-02, 14.4h).
	 */
	initialDelayMs?: number;
}

/**
 * Pure recency decision: given the account's last-activity timestamp, pick the
 * base cadence and whether it is the idle cadence. Non-demand-aware accounts
 * always get the fixed active interval (their existing behavior).
 *
 * The idle cadence is `max(activeInterval, min(idleInterval, idleCap))` where
 * `idleCap = USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS`:
 *  - the `min` pulls the idle BASE under the refresh cap,
 *  - the outer `max` keeps the long-standing rule that an idle account is never
 *    polled FASTER than the configured active cadence.
 *
 * A configured active cadence above the cap therefore leaves this function
 * returning an over-cap idle interval — that is deliberate and harmless, because
 * {@link computePollDelay} clamps the final DELAY of both branches to the same
 * ceiling. At that ceiling idle simply equals active, so the "idle is never
 * faster than active" rule still holds while the schedule stays inside the TTL.
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
		Math.min(
			opts.idleIntervalMs ?? IDLE_POLL_INTERVAL_MS,
			USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS,
		),
	);
	const recencyMs = opts.activityRecencyMs ?? ACTIVITY_RECENCY_MS;
	if (lastActivityMs != null && now - lastActivityMs < recencyMs) {
		return { intervalMs: activeIntervalMs, isIdle: false };
	}
	return { intervalMs: idleIntervalMs, isIdle: true };
}

/**
 * Fold the caller's symmetric jitter value into the NEGATIVE-only range the idle
 * cadence requires: `[-0.2, 0.2]` → `[-0.1, 0]`, i.e. a delay in
 * `[0.9, 1.0] x interval`. Idle polls may only be pulled EARLIER, never pushed
 * past the cap that guarantees the refresh lands before the cache entry expires;
 * accounts still de-synchronize, just within a one-sided 10% band. Uniform in,
 * uniform out; and 0 in (the tests' deterministic value) is still 0 out.
 */
export function idleJitterFraction(symmetricJitterFraction: number): number {
	return -Math.abs(symmetricJitterFraction) / 2;
}

/**
 * Pure poll-delay decision combining, in priority order: (1) a server
 * retry-after (wins outright), (2) exponential failure backoff (wins over the
 * base cadence — a failing account keeps backing off regardless of active/idle),
 * then (3) the demand-aware active/idle base cadence with jitter. `jitterFraction`
 * is the caller's random value in [-0.2, 0.2] (0 in tests for determinism); the
 * ACTIVE cadence applies it symmetrically, the IDLE cadence folds it to
 * negative-only via {@link idleJitterFraction}.
 *
 * The healthy demand-aware delay (BOTH branches, post-jitter) is then clamped to
 * `USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS` so the schedule stays inside the
 * cache TTL for ANY configured cadence — including a caller-supplied
 * `activeIntervalMs` above the ceiling, and the ACTIVE re-arm that
 * `noteActivity()` performs when a sleeping idle account wakes. Paths (1) and (2)
 * and non-demand-aware providers are deliberately left unclamped.
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
	const fraction = isIdle
		? idleJitterFraction(params.jitterFraction)
		: params.jitterFraction;
	const jittered = intervalMs + intervalMs * fraction;
	// Only the demand-aware healthy cadence is clamped; a provider without a
	// policy keeps its configured cadence verbatim (byte-identical behavior).
	const delayMs = params.demandAware
		? Math.min(jittered, USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS)
		: jittered;
	return { delayMs, isIdle };
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
	// Core windows (always present in older API versions). `five_hour` is
	// nullable: Codex retired its rolling 5h window, so a Codex producer emits
	// `null` to mean "no window" — distinct from a real `{utilization:0,...}`
	// window that Anthropic still reports when its 5h window is idle at 0%.
	five_hour: UsageWindow | null;
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
	| AlibabaCodingPlanUsageData
	| MinimaxUsageData;

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
	if (provider === "minimax") {
		const m = data as MinimaxUsageData;
		// Prefer the BINDING window's reset; with neither bound, the short window's
		// reset is the sooner-actionable one.
		if (getRepresentativeMinimaxWindow(m) === "seven_day") {
			return m.seven_day?.resetAt ?? null;
		}
		return m.five_hour?.resetAt ?? m.seven_day?.resetAt ?? null;
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

/** One account-level window considered for the representative reading. */
interface RepresentativeCandidate {
	/** Flat-payload window name, used verbatim as the reported window. */
	name: string;
	utilization: number;
}

/**
 * Resolve THE representative account-level window for an Anthropic/Codex
 * windowed payload — both its utilization and its name, from one and the same
 * candidate. Utilization and window naming must never be derived independently:
 * that is how a mixed payload came to report a number from one window under the
 * name of another.
 *
 * Candidates, and only these: the account-session (5h), the account-wide weekly,
 * and the OAuth-apps weekly (`seven_day_oauth_apps`). The session + weekly are
 * sourced through {@link normalizeAnthropicUsage} so flat AND `limits[]`-only
 * payloads read identically; the OAuth-apps window (the Claude Code weekly quota
 * — the binding constraint for OAuth accounts) is folded in from the flat field,
 * since the normalizer's account-wide windows don't capture it. `weekly_scoped`
 * and the model-scoped flat windows (`seven_day_opus`/`seven_day_sonnet`) are
 * NOT account-level, and `extra_usage` is deliberately excluded.
 *
 * Why exclude `extra_usage`: overage-credit exhaustion is handled by the
 * dedicated `out_of_credits` floor-until cooldown path, NOT this generic
 * usage-based clear guard; and `getAccountCapacitySignal` still folds
 * `extra_usage` into `bindingUtilization` for load-balancer deprioritization —
 * so excluding it here only affects the cooldown-clear guard, intentionally.
 *
 * Returns `null` when no candidate carries evidence.
 */
function resolveRepresentativeWindow(
	usage: UsageData | null,
	now: number,
): RepresentativeCandidate | null {
	if (!usage) return null;

	const normalized = normalizeAnthropicUsage(
		usage as AnthropicUsageData | null,
		now,
	);
	const candidates: RepresentativeCandidate[] = [];
	if (normalized.session) {
		candidates.push({
			name: "five_hour",
			utilization: normalized.session.utilization,
		});
	}
	if (normalized.weeklyAll) {
		candidates.push({
			name: "seven_day",
			utilization: normalized.weeklyAll.utilization,
		});
	}
	// (If Anthropic ever carries an OAuth-apps-equivalent in `limits[]`, add it to
	// the normalizer; flat is the known shape today.)
	const oauth = usage.seven_day_oauth_apps;
	if (
		oauth &&
		typeof oauth.utilization === "number" &&
		Number.isFinite(oauth.utilization)
	) {
		candidates.push({
			name: "seven_day_oauth_apps",
			utilization: oauth.utilization,
		});
	}

	if (candidates.length === 0) return null;
	return candidates.reduce((prev, current) =>
		current.utilization > prev.utilization ? current : prev,
	);
}

/**
 * Representative account-wide utilization: the utilization of the binding
 * account-level window resolved by {@link resolveRepresentativeWindow} (which
 * documents exactly which windows count and why).
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
	return resolveRepresentativeWindow(usage, now)?.utilization ?? null;
}

/**
 * Result of one usage fetch.
 *
 * `superseded` is a THIRD state, distinct from success and failure: the fetch
 * belonged to a poll generation (or token provider) that was replaced while it
 * was in flight, so it says nothing at all about the live poller. Callers must
 * drop it rather than fold it into `success === false` — counting it as a
 * failure pushes a healthy replacement poller into exponential backoff and lets
 * its usage data go stale.
 */
interface UsageFetchOutcome {
	success: boolean;
	retryAfterMs: number | null;
	superseded?: boolean;
}

/**
 * What a successful usage poll reports to the capacity-restored listener. The
 * poller REPORTS evidence; it does not decide whether a cooldown may be cleared
 * (that is the listener's job, which knows the cooldown's reason and age).
 */
export interface CapacityRestoredEvidence {
	accountId: string;
	/** Account-wide representative utilization observed by this poll (< 100). */
	utilization: number;
	/**
	 * The overage window's utilization, or null when absent. REPORTED, never
	 * enforced here: the account-wide representative excludes `extra_usage`, and
	 * a spent overage bucket is the `out_of_credits` floor's business — vetoing on
	 * it would block a legitimate recovery of a genuinely-restored account.
	 */
	extraUsageUtilization: number | null;
	/**
	 * Wall clock captured immediately BEFORE the usage request went out. This is
	 * the causal boundary the listener compares a cooldown's `rate_limited_at`
	 * against: a cooldown written while this request was in flight is temporally
	 * ambiguous, so it must wait for the next poll rather than be cleared by a
	 * reading that may predate it.
	 */
	fetchStartedAt: number;
	/**
	 * Every window the payload reported with a reset (epoch ms + utilization),
	 * account-wide AND per-family scoped, elapsed or not — see
	 * `collectObservedWindows`. The listener uses it to tell a STALE recorded
	 * `rate_limit_reset` (owned by no window that is still spent: an
	 * out-of-band reset moved the boundary, or a gift reset drained the window
	 * in place) from a CORRECT future one (a spent per-family weekly the
	 * account-wide representative does not see). Reported, never interpreted
	 * here.
	 */
	observedWindows: ObservedWindow[];
}

/**
 * Whether a successful usage poll carries capacity-restored evidence worth
 * reporting: the account-wide representative utilization is a NUMBER below 100,
 * i.e. no account-wide window (5h session, weekly, OAuth-apps weekly) is spent.
 *
 * LEVEL-triggered, not edge-triggered: it is evaluated on every successful poll
 * and does not depend on any prior observation. Edge detection (a `100 → <100`
 * crossing) is lossy — an account locked while its weekly sits at 40% never
 * produces such a transition — and loses events across restarts.
 *
 * `null` NEVER reports: a `limits[]`-only payload once collapsed to 0, read as
 * "plenty of headroom", and falsely cleared a cooldown. No evidence is not
 * evidence of headroom.
 */
export function shouldReportCapacityRestored(
	representativeUtilization: number | null,
): representativeUtilization is number {
	return representativeUtilization !== null && representativeUtilization < 100;
}

/**
 * Name the most restrictive account-level window — the same candidate
 * {@link getRepresentativeUtilization} reports the number for, resolved by
 * {@link resolveRepresentativeWindow}.
 */
export function getRepresentativeWindow(
	usage: UsageData | null,
	now: number = Date.now(),
): string | null {
	return resolveRepresentativeWindow(usage, now)?.name ?? null;
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
		case "minimax": {
			return getRepresentativeMinimaxUtilization(data as MinimaxUsageData);
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
		// The 5h session window's own reset — NOT recoverable from soonestResetMs
		// (a min() across all hard windows loses which window it came from).
		sessionResetMs: normalized.session?.resetMs ?? null,
		// extra_usage is RESETLESS: it bounds bindingUtilization above but has no
		// reset, so an account it constrains never self-recovers. Surfaced
		// explicitly because bindingUtilization cannot say which axis produced it.
		extraUsageUtilization: d.extra_usage?.utilization ?? null,
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
 * One cached reading, with its two independent instants kept apart.
 *
 * `timestamp` is the WRITE time and the sole input to every freshness/TTL
 * decision in this class. `observedAtMs` is the OBSERVATION time — when the
 * provider actually reported this reading — and is null when the writer cannot
 * honestly say. See the provenance note on {@link USAGE_CACHE_TTL_MS} for why
 * collapsing the two is a defect rather than a simplification.
 */
interface UsageCacheEntry {
	data: AnyUsageData;
	timestamp: number;
	observedAtMs: number | null;
}

/**
 * In-memory cache for usage data per account
 */
class UsageCache {
	private cache = new Map<string, UsageCacheEntry>();
	private pollTimeouts = new Map<string, NodeJS.Timeout>();
	// Monotonic per-account poll generation. Bumped on every startPolling and read
	// on every (re)arm: a timer or async cold-start resolver left over from a
	// superseded generation can never arm a new timer. This is the AUTHORITATIVE
	// replacement guard — unlike the tokenProviders identity guard it still holds
	// when a caller reuses the same tokenProvider function reference across a
	// replacement. Deleted on stopPolling (same lifecycle as tokenProviders).
	private pollGenerations = new Map<string, number>();
	private failureCounts = new Map<string, number>();
	private tokenProviders = new Map<string, AccessTokenProvider>();
	private providerTypes = new Map<string, string>(); // Track provider type for each account
	private customEndpoints = new Map<string, string | null>(); // Track custom endpoints
	private windowResetCallbacks = new Map<string, (accountId: string) => void>();
	private usageRateLimitedUntil = new Map<string, number>(); // Tracks when usage API 429 clears
	private capacityRestoredCallbacks = new Map<
		string,
		(evidence: CapacityRestoredEvidence) => void
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
	// In-flight fetch dedup, tagged with the poll generation that issued it. The
	// generation tag matters: a startPolling REPLACEMENT bumps the generation while
	// an old fetch may still be running, and a plain account-keyed map would hand
	// the new generation the old promise — whose result the new generation then
	// (correctly) rejects as stale, leaving it having performed NO fetch at all and
	// silently waiting for its next scheduled poll. Deduplicate only WITHIN a
	// generation.
	private inFlightFetches = new Map<
		string,
		{
			generation: number;
			promise: Promise<UsageFetchOutcome>;
		}
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
	 * Write a reading that was just FETCHED from the provider.
	 *
	 * The single clock read is deliberate: for a live fetch the write time and the
	 * observation time are the same instant, and taking `Date.now()` twice would
	 * record them a millisecond apart for no reason. The only writers that must
	 * NOT come through here are reconstructions with no trustworthy observation
	 * time — see {@link UsageCache.setUntimed}.
	 */
	private writeFetchedEntry(accountId: string, data: AnyUsageData): void {
		const observedAtMs = Date.now();
		this.cache.set(accountId, { data, timestamp: observedAtMs, observedAtMs });
	}

	/**
	 * Schedule the next poll with exponential backoff on failures.
	 * If retryAfterMs is provided (from a 429 retry-after header), it takes
	 * precedence over the calculated backoff delay.
	 */
	private scheduleNextPoll(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		generation: number,
		baseIntervalMs: number,
		provider?: string,
		customEndpoint?: string | null,
		retryAfterMs?: number | null,
	) {
		// Generation guard: a superseded poll loop must never (re)schedule.
		if (this.pollGenerations.get(accountId) !== generation) return;
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
				generation,
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
				generation,
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
					generation,
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
					generation,
					baseIntervalMs,
					provider,
					customEndpoint,
					null,
				),
			);
	}

	/**
	 * Arm the next poll after the (possibly async) cold-start activity resolver
	 * settled. Generation-guarded: a stopPolling()/restart during the await bumps
	 * (or clears) the generation, so a superseded resolver bails even if the caller
	 * reused the same tokenProvider reference (which would defeat the identity
	 * guard). The tokenProvider identity guard and the pollTimeouts presence check
	 * remain as belt-and-suspenders (the latter avoids double-arming if a timer was
	 * armed during the await).
	 */
	private armAfterResolve(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		generation: number,
		baseIntervalMs: number,
		provider: string | undefined,
		customEndpoint: string | null | undefined,
		resolved: number | null,
	) {
		if (this.pollGenerations.get(accountId) !== generation) return;
		if (this.tokenProviders.get(accountId) !== tokenProvider) return;
		if (this.pollTimeouts.has(accountId)) return;
		// Any real-time activity observed during the await wins over the DB value.
		const observed = this.lastActivityAt.get(accountId);
		this.armNextPoll(
			accountId,
			tokenProvider,
			generation,
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
		generation: number,
		activeBaseMs: number,
		provider: string | undefined,
		customEndpoint: string | null | undefined,
		retryAfterMs: number | null,
		lastActivityMs: number | null,
	) {
		// Generation guard: never arm a timer for a superseded poll loop.
		if (this.pollGenerations.get(accountId) !== generation) return;
		const failures = this.failureCounts.get(accountId) ?? 0;
		const policy = this.pollingPolicies.get(accountId);
		// ±20% random jitter so accounts spread out and don't lock into sync.
		// computePollDelay applies it symmetrically to the ACTIVE cadence and folds
		// it to negative-only for the IDLE cadence (which must never overshoot its
		// refresh-before-expiry cap).
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
			// Bail if polling was stopped OR restarted (replaced) since this tick was
			// scheduled. The generation guard is authoritative — it catches a
			// stopPolling()+startPolling() (e.g. reauth) even when the same
			// tokenProvider reference is reused; the identity guard remains as a
			// secondary check so a stale closure never polls alongside the new one.
			if (this.pollGenerations.get(accountId) !== generation) return;
			if (this.tokenProviders.get(accountId) !== tokenProvider) return;

			const {
				success,
				retryAfterMs: nextRetryAfterMs,
				superseded,
			} = await this.fetchAndCache(
				accountId,
				tokenProvider,
				generation,
				provider,
				customEndpoint,
			);
			// A superseded result belongs to a poll generation that no longer
			// exists. It is NOT a failure of the live one — counting it would push
			// a perfectly healthy replacement poller into exponential backoff and
			// let its usage data go stale. Drop it entirely (the reschedule guards
			// below would bail anyway).
			if (superseded) return;
			if (success) {
				this.failureCounts.delete(accountId); // reset streak on success
			} else {
				const count = (this.failureCounts.get(accountId) ?? 0) + 1;
				this.failureCounts.set(accountId, count);
			}
			// Schedule the next poll only if this generation is still current
			// (generation + identity guards — see the bail check above).
			if (
				this.pollGenerations.get(accountId) === generation &&
				this.tokenProviders.get(accountId) === tokenProvider
			) {
				this.scheduleNextPoll(
					accountId,
					tokenProvider,
					generation,
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
	 * notices. Cheap and guarded: a NO-OP for providers without demand-aware
	 * polling and for stopped pollers (never resurrects one).
	 *
	 * The membership guards run BEFORE recording activity so the `lastActivityAt`
	 * map stays bounded to accounts with an ACTIVE demand-aware poller: a late
	 * response after polling stopped, or traffic on a non-demand-aware account,
	 * records nothing (and stopPolling prunes the entry), so the map can't grow
	 * without bound.
	 */
	noteActivity(accountId: string, now: number = Date.now()): void {
		const policy = this.pollingPolicies.get(accountId);
		if (!policy?.demandAware) return;
		// Don't resurrect a stopped poller (and don't record activity for one —
		// stopPolling has removed the token provider and pruned lastActivityAt).
		const tokenProvider = this.tokenProviders.get(accountId);
		if (!tokenProvider) return;
		// Only record activity once we know a demand-aware poller is active for this
		// account — bounds the map to live pollers (pruned on stopPolling).
		this.lastActivityAt.set(accountId, now);
		const sched = this.pollSchedule.get(accountId);
		// Only re-arm when currently sleeping on an IDLE timer. An active or
		// backoff timer is left untouched (backoff must keep winning).
		if (!sched?.isIdle) return;
		// Skip if the pending idle wake is already within ~one active interval
		// (incl. max +20% jitter) — re-arming could only push it further out.
		if (sched.wakeAt - now <= sched.activeBaseMs * 1.2) return;
		// Re-arm within the CURRENT generation (defensive: only if one is live).
		const generation = this.pollGenerations.get(accountId);
		if (generation === undefined) return;
		const existing = this.pollTimeouts.get(accountId);
		if (existing) clearTimeout(existing);
		this.pollTimeouts.delete(accountId);
		this.pollSchedule.delete(accountId);
		// scheduleNextPoll re-reads lastActivityAt (now fresh) → active cadence.
		this.scheduleNextPoll(
			accountId,
			tokenProvider,
			generation,
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
		onCapacityRestored?: (evidence: CapacityRestoredEvidence) => void,
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

		// Stop existing polling if any to prevent leaks. DELETE the map entry (not
		// just clearTimeout): a lingering entry would make armAfterResolve's
		// `pollTimeouts.has` guard refuse to arm this fresh generation's timer,
		// leaving a demand-aware poller replaced via startPolling (without a prior
		// stopPolling) permanently unscheduled.
		const existing = this.pollTimeouts.get(accountId);
		if (existing) {
			clearTimeout(existing);
			this.pollTimeouts.delete(accountId);
			log.warn(
				`Clearing existing polling timeout for account ${accountId} before starting new one`,
			);
		}

		// Bump the per-account poll generation: any timer or async cold-start
		// resolver still pending from a prior startPolling is now superseded and
		// must never (re)arm — even if the caller reuses the same tokenProvider
		// reference (which defeats the identity guard). Every (re)arm is gated on
		// this exact generation value.
		const generation = (this.pollGenerations.get(accountId) ?? 0) + 1;
		this.pollGenerations.set(accountId, generation);

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

		// First fetch — immediate by default, deferred by `policy.initialDelayMs`
		// (see its doc: the boot stagger defers only the fetch; registration
		// above already happened, so refreshNow works during the delay).
		const runFirstFetch = () => {
			this.fetchAndCache(
				accountId,
				tokenProvider,
				generation,
				provider,
				customEndpoint,
			).then(({ success, retryAfterMs, superseded }) => {
				// Stale result from a generation that has since been replaced: it says
				// nothing about THIS poller, so it must not seed a failure streak.
				if (superseded) return;
				if (!success) {
					this.failureCounts.set(accountId, 1);
				}
				// Generation + identity guards: only start the loop if this generation
				// is still current (a concurrent restart/replacement may have
				// superseded it). scheduleNextPoll re-checks the generation too.
				if (
					this.pollGenerations.get(accountId) === generation &&
					this.tokenProviders.get(accountId) === tokenProvider
				) {
					this.scheduleNextPoll(
						accountId,
						tokenProvider,
						generation,
						baseIntervalMs,
						provider,
						customEndpoint,
						retryAfterMs,
					);
				}
			});
		};

		const initialDelayMs = Math.max(0, policy?.initialDelayMs ?? 0);
		if (initialDelayMs > 0) {
			// The deferred first fetch is a first-class scheduled poll: tracked in
			// pollTimeouts/pollSchedule so stopPolling and a replacement
			// startPolling clear it, and generation+identity-guarded at fire time
			// like every armed tick. isIdle:false keeps noteActivity's idle re-arm
			// off it (traffic must not bypass the boot stagger), and a healthy
			// refreshNow during the delay leaves it in place
			// (rearmAfterOnDemandSuccess only replaces backoff timers).
			const timeoutId = setTimeout(() => {
				this.pollTimeouts.delete(accountId);
				this.pollSchedule.delete(accountId);
				if (this.pollGenerations.get(accountId) !== generation) return;
				if (this.tokenProviders.get(accountId) !== tokenProvider) return;
				runFirstFetch();
			}, initialDelayMs);
			this.pollTimeouts.set(accountId, timeoutId);
			this.pollSchedule.set(accountId, {
				wakeAt: Date.now() + initialDelayMs,
				isIdle: false,
				activeBaseMs: baseIntervalMs,
			});
		} else {
			runFirstFetch();
		}

		log.debug(
			`Started usage polling for account ${accountId} (provider: ${provider}) with base interval ${Math.round(baseIntervalMs / 1000)}s${initialDelayMs > 0 ? ` (first fetch in ${Math.round(initialDelayMs / 1000)}s)` : ""}`,
		);
	}

	/**
	 * Trigger an immediate usage fetch for an account that already has polling configured.
	 * Returns false when no polling/token provider is configured or when the fetch fails.
	 *
	 * On success the failure streak is cleared and a backed-off poll loop is
	 * re-armed to the healthy cadence — see {@link rearmAfterOnDemandSuccess}.
	 */
	async refreshNow(accountId: string): Promise<boolean> {
		const tokenProvider = this.tokenProviders.get(accountId);
		if (!tokenProvider) {
			return false;
		}
		// On-demand fetches join the CURRENT generation (same lifecycle as the
		// token provider: both are installed by startPolling and dropped by
		// stopPolling), so they dedup with a concurrent scheduled poll and their
		// result is applied under the same guards.
		const generation = this.pollGenerations.get(accountId);
		if (generation === undefined) {
			return false;
		}

		const provider = this.providerTypes.get(accountId);
		const customEndpoint = this.customEndpoints.get(accountId);
		const { success } = await this.fetchAndCache(
			accountId,
			tokenProvider,
			generation,
			provider,
			customEndpoint,
		);
		if (success) this.rearmAfterOnDemandSuccess(accountId, tokenProvider);
		return success;
	}

	/**
	 * An on-demand fetch just proved the account healthy. Two consequences:
	 *
	 *  1. The consecutive-failure streak is disproven → cleared unconditionally.
	 *  2. If the loop was sitting in exponential backoff, its pending wake can be
	 *     far beyond {@link USAGE_CACHE_TTL_MS} (the ceiling is 30 minutes), so
	 *     the reading we just wrote would expire long before the next poll
	 *     replaced it. Re-arm the timer onto the healthy cadence instead.
	 *
	 * Deliberately a NO-OP when the account was already healthy: `refreshNow` is
	 * called from the dashboard's refresh button and account priming, and pushing
	 * the pending wake out on every call would let a polling dashboard postpone
	 * scheduled polling indefinitely.
	 *
	 * Guards mirror `noteActivity()`: the token-provider identity check refuses to
	 * resurrect a stopped or replaced poller (stopPolling removes it), and the
	 * generation must still be live. A missing schedule entry means a poll tick is
	 * currently executing — it will reschedule itself off the (now cleared) failure
	 * count, so there is nothing to do.
	 */
	private rearmAfterOnDemandSuccess(
		accountId: string,
		tokenProvider: AccessTokenProvider,
	): void {
		if (this.tokenProviders.get(accountId) !== tokenProvider) return;
		const hadFailures = (this.failureCounts.get(accountId) ?? 0) > 0;
		this.failureCounts.delete(accountId);
		if (!hadFailures) return;

		const generation = this.pollGenerations.get(accountId);
		if (generation === undefined) return;
		const sched = this.pollSchedule.get(accountId);
		if (!sched) return; // a tick is in flight; it reschedules itself

		const existing = this.pollTimeouts.get(accountId);
		if (existing) clearTimeout(existing);
		this.pollTimeouts.delete(accountId);
		this.pollSchedule.delete(accountId);
		log.debug(
			`On-demand usage refresh succeeded for account ${accountId} — clearing backoff and re-arming the poll schedule`,
		);
		// failureCounts is now empty → scheduleNextPoll takes the healthy cadence.
		this.scheduleNextPoll(
			accountId,
			tokenProvider,
			generation,
			sched.activeBaseMs,
			this.providerTypes.get(accountId),
			this.customEndpoints.get(accountId),
			null,
		);
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
			// Drop the generation so any pending async resolver from this poller
			// bails on the generation guard (and doesn't leak an entry).
			this.pollGenerations.delete(accountId);
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
		generation: number,
		provider?: string,
		customEndpoint?: string | null,
	): Promise<UsageFetchOutcome> {
		// Deduplicate concurrent fetches for the same account — return the existing
		// in-flight promise rather than starting a second HTTP request — but ONLY
		// within the same poll generation. A newer generation must issue (and apply)
		// its own fetch; reusing a superseded generation's promise would give it a
		// result its own guards reject, i.e. no fetch at all.
		const inflight = this.inFlightFetches.get(accountId);
		if (inflight && inflight.generation === generation) {
			log.debug(
				`Reusing in-flight fetch for account ${accountId} — skipping duplicate request`,
			);
			return inflight.promise;
		}

		const promise = this._doFetchAndCache(
			accountId,
			tokenProvider,
			generation,
			provider,
			customEndpoint,
		);
		this.inFlightFetches.set(accountId, { generation, promise });
		promise.finally(() => {
			// Identity-guarded: a restart (stopPolling + startPolling) during this
			// fetch may have installed a newer in-flight entry for the same account;
			// only clear our own so we don't wipe the current generation's dedup.
			if (this.inFlightFetches.get(accountId)?.promise === promise) {
				this.inFlightFetches.delete(accountId);
			}
		});
		return promise;
	}

	/**
	 * True while `generation` is still this account's live poll generation AND the
	 * token provider is still the one that issued the fetch. Re-checked at every
	 * await boundary inside a fetch: a superseded in-flight fetch must neither
	 * write the cache nor invoke any callback (its reading belongs to a poller that
	 * no longer exists — e.g. a reauth swapped the credentials underneath it).
	 */
	private isLiveFetchGeneration(
		accountId: string,
		generation: number,
		tokenProvider: AccessTokenProvider,
	): boolean {
		return (
			this.pollGenerations.get(accountId) === generation &&
			this.tokenProviders.get(accountId) === tokenProvider
		);
	}

	private async _doFetchAndCache(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		generation: number,
		provider?: string,
		_customEndpoint?: string | null,
	): Promise<UsageFetchOutcome> {
		/** A superseded fetch reports failure without touching any shared state. */
		const superseded = {
			success: false,
			retryAfterMs: null,
			superseded: true,
		} as const;
		try {
			// Get a fresh access token or API key on each fetch
			let token: string;
			try {
				token = await tokenProvider();
			} catch (tokenError) {
				// Generation guard BEFORE the failure handler: a rejection belonging to
				// a superseded generation must not invoke the current poller's
				// onTokenRefreshFailure (which can halt polling for the live account).
				if (!this.isLiveFetchGeneration(accountId, generation, tokenProvider)) {
					return superseded;
				}
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
					// The handler AWAITS (it reads the account from the DB), so the
					// generation must be re-checked after it settles — resolved OR
					// thrown. A reauth can start a new poller during that lookup, and
					// acting on the stale verdict here would call stopPolling() on the
					// LIVE generation, tearing down its token provider, callbacks and
					// cache and leaving the account unpolled until an explicit restart.
					if (
						!this.isLiveFetchGeneration(accountId, generation, tokenProvider)
					) {
						return superseded;
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

			// Generation guard after the (awaited) token resolution.
			if (!this.isLiveFetchGeneration(accountId, generation, tokenProvider)) {
				return superseded;
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
				if (!this.isLiveFetchGeneration(accountId, generation, tokenProvider))
					return superseded;
				if (data) {
					// Import Zai helper functions
					const {
						getRepresentativeZaiUtilization,
						getRepresentativeZaiWindow,
					} = await import("./zai-usage-fetcher");
					// The dynamic import is another await boundary — re-check before any
					// cache write or callback.
					if (!this.isLiveFetchGeneration(accountId, generation, tokenProvider))
						return superseded;

					const callback = this.windowResetCallbacks.get(accountId);
					if (callback)
						this.notifyWindowReset(accountId, data, "zai", callback);
					this.writeFetchedEntry(accountId, data);
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
				if (!this.isLiveFetchGeneration(accountId, generation, tokenProvider))
					return superseded;
				if (data) {
					this.writeFetchedEntry(accountId, data);
					const utilization = getRepresentativeKiloUtilization(
						data as KiloUsageData,
					);
					const window = getRepresentativeKiloWindow(data as KiloUsageData);
					log.debug(
						`Successfully fetched Kilo usage data for account ${accountId}: $${(data as KiloUsageData).remainingUsd.toFixed(2)} remaining (${utilization?.toFixed(1)}% used, ${window})`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "minimax") {
				// MiniMax Token Plan remains — a metadata-only GET that costs zero
				// quota. Request forwarding still goes through the generic
				// anthropic-compatible path; this is polling only.
				data = await fetchMinimaxUsageData(token);
				if (!this.isLiveFetchGeneration(accountId, generation, tokenProvider))
					return superseded;
				if (data) {
					// BEFORE the cache write: the roll is detected by comparing the new
					// reset against the CACHED baseline, so replacing the baseline first
					// would make every rollover invisible (mirrors the zai/anthropic
					// dispatchers).
					const callback = this.windowResetCallbacks.get(accountId);
					if (callback)
						this.notifyWindowReset(accountId, data, "minimax", callback);
					this.writeFetchedEntry(accountId, data);
					const utilization = getRepresentativeMinimaxUtilization(
						data as MinimaxUsageData,
					);
					const window = getRepresentativeMinimaxWindow(
						data as MinimaxUsageData,
					);
					log.debug(
						`Successfully fetched Minimax usage data for account ${accountId}: ${utilization?.toFixed(1)}% used (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "alibaba-coding-plan") {
				// Fetch Alibaba Coding Plan usage data
				data = await fetchAlibabaCodingPlanUsageData(token);
				if (!this.isLiveFetchGeneration(accountId, generation, tokenProvider))
					return superseded;
				if (data) {
					this.writeFetchedEntry(accountId, data);
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
				// Default to Anthropic usage data. `fetchStartedAt` is the causal
				// boundary reported with capacity-restored evidence: FETCH START, not
				// response completion — a cooldown written while this request was in
				// flight is temporally ambiguous and must wait for the next poll.
				const fetchStartedAt = Date.now();
				const result = await fetchUsageData(token);
				if (!this.isLiveFetchGeneration(accountId, generation, tokenProvider))
					return superseded;
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
					// The usage endpoint answered, so its own 429 throttle (a per-IP limit
					// on /oauth/usage, unrelated to the account's quota) is over. Four
					// live consumers read this map; it is NOT the capacity-restored gate.
					this.usageRateLimitedUntil.delete(accountId);
					const callback = this.windowResetCallbacks.get(accountId);
					if (callback)
						this.notifyWindowReset(
							accountId,
							result.data,
							"anthropic",
							callback,
						);
					this.writeFetchedEntry(accountId, result.data);
					const utilization = getRepresentativeUtilization(
						result.data as UsageData,
					);
					// Report capacity-restored evidence on EVERY successful poll that
					// sees account-wide headroom (level-triggered — no crossing to miss,
					// nothing to lose across a restart, and a refused clear simply retries
					// on the next poll). The representative is MAX(session, weeklyAll) plus
					// the OAuth-apps weekly, so "< 100" means NO account-wide window is
					// spent — strictly stronger than "the binding window recovered".
					//
					// The poller does not decide whether the cooldown may be cleared: it
					// does not know the cooldown's reason or age. It reports; the listener
					// (apps/server/src/capacity-restored.ts) decides.
					if (shouldReportCapacityRestored(utilization)) {
						const capacityCallback =
							this.capacityRestoredCallbacks.get(accountId);
						if (capacityCallback)
							capacityCallback({
								accountId,
								utilization,
								extraUsageUtilization:
									(result.data as UsageData).extra_usage?.utilization ?? null,
								fetchStartedAt,
								observedWindows: collectObservedWindows(
									result.data as AnthropicUsageData,
								),
							});
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
	 * Non-evicting DATA + AGE read for the DASHBOARD's freshness display.
	 *
	 * Returns the cached data together with its TRUE age even when the entry is
	 * past {@link USAGE_CACHE_TTL_MS} — a reading that is a few minutes past the
	 * ROUTING freshness bar is not "unavailable", it is live data with an age, and
	 * the UI renders it as such ("as of HH:MM") rather than falling back to the
	 * persisted snapshot and its amber "Live usage unavailable" banner. Returns
	 * null only when there is NO entry, or the entry is older than
	 * {@link UI_STALE_HORIZON_MS} (at which point showing it would be misleading
	 * and the snapshot fallback is the honest answer).
	 *
	 * NEVER evicts — like peek()/peekAge(), a stale entry is left in the map so
	 * eviction and window-reset comparisons behave as if no read happened. Do NOT
	 * use for routing/throttling/capacity decisions; those must keep using
	 * get()/getAge()/getFreshCapacity, which enforce the routing TTL.
	 *
	 * Returns THREE fields on purpose, and the first two are NOT interchangeable:
	 *  - `sampledAtMs` is the entry's ABSOLUTE WRITE time, i.e. the anchor of the
	 *    `ageMs` this read is built around. Callers must never reconstruct it as
	 *    `theirNow - ageMs`: a request handler's `now` is captured before its DB
	 *    round-trips, so that subtraction reports the reading as older than it is
	 *    by the handler's own elapsed time.
	 *  - `observedAtMs` is when the reading was OBSERVED at the provider, or null
	 *    when the writer could not honestly say (a reconstruction — see
	 *    {@link UsageCache.setUntimed}). This is the field to serialize as an "as
	 *    of" stamp and the only one a projection may anchor to. It equals
	 *    `sampledAtMs` for every live fetch, which is exactly why substituting one
	 *    for the other looks correct until a recovered reading is re-read.
	 *  - `ageMs` is the age against the clock AT READ TIME, for freshness gating
	 *    (e.g. "is this still within the routing TTL?") without a second clock
	 *    read that could disagree with the one that admitted the entry.
	 */
	peekWithAge(accountId: string): {
		data: AnyUsageData;
		ageMs: number;
		sampledAtMs: number;
		observedAtMs: number | null;
	} | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;

		const ageMs = Date.now() - cached.timestamp;
		if (ageMs > UI_STALE_HORIZON_MS) return null; // too old to show — do NOT evict

		return {
			data: cached.data,
			ageMs,
			sampledAtMs: cached.timestamp,
			observedAtMs: cached.observedAtMs,
		};
	}

	/**
	 * Cache a reading that was JUST OBSERVED — a live usage fetch, or usage
	 * headers parsed off a response that has only now come back. Both the write
	 * time and the observation time are `now`.
	 *
	 * A writer holding a reading it did not just observe must NOT use this: it
	 * would stamp reconstructed data with the insertion instant and hand every
	 * later reader a confident, wrong observation time. Use
	 * {@link UsageCache.setUntimed}.
	 */
	set(accountId: string, data: AnyUsageData): void {
		this.writeFetchedEntry(accountId, data);

		// Periodic cleanup of stale entries to prevent memory bloat
		// Run cleanup every 100 sets to balance performance and memory
		if (this.cache.size % 100 === 0) {
			this.cleanupStaleEntries();
		}
	}

	/**
	 * Cache a RECONSTRUCTED reading — one recovered from a stored artefact rather
	 * than observed now, with no trustworthy observation time.
	 *
	 * Today's single caller is the Codex stored-payload recovery: it rebuilds
	 * usage from whatever request payload happened to be retained, so the headers
	 * can predate this write by hours. The entry's FRESHNESS is deliberately the
	 * write time (the routing/TTL contract is about how long the proxy may keep
	 * acting on a re-seeded reading, and that is unchanged); its OBSERVATION time
	 * is null, and stays null for every subsequent read, so display stamps and
	 * observation-anchored projections keep degrading exactly as they did on the
	 * request that performed the recovery.
	 */
	setUntimed(accountId: string, data: AnyUsageData): void {
		this.cache.set(accountId, {
			data,
			timestamp: Date.now(),
			observedAtMs: null,
		});

		if (this.cache.size % 100 === 0) {
			this.cleanupStaleEntries();
		}
	}

	/**
	 * Test-only: seed the cache with an explicit age so freshness-bounded readers
	 * (`getFreshCapacity`) can be exercised at a chosen point.
	 *
	 * The 429 ladder in proxy-operations reads the same cache through two
	 * DIFFERENT bounds — 180s for the account-wide/family rungs, 120s for the
	 * burst classifier — so the band between them is a real, reachable state with
	 * its own behaviour, and `set()` (always age 0) cannot construct it. Mirrors
	 * `resetRateLimitProbeGatesForTests`; never called from production paths.
	 */
	setWithAgeForTests(
		accountId: string,
		data: AnyUsageData,
		ageMs: number,
	): void {
		// A live fetch that happened `ageMs` ago: both instants move back together,
		// because that is what the entry this constructs stands in for.
		const writtenAt = Date.now() - ageMs;
		this.cache.set(accountId, {
			data,
			timestamp: writtenAt,
			observedAtMs: writtenAt,
		});
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
	 * Non-evicting read of the entry's ABSOLUTE write time (epoch ms), for
	 * before/after comparisons. Returns the entry's TRUE timestamp even when the
	 * entry is stale (like peekAge()), and null ONLY when there is no entry at
	 * all. Never deletes.
	 *
	 * Use this instead of reconstructing the instant as `theirNow - peekAge()` —
	 * the same rule peekWithAge()'s `sampledAtMs` states. That subtraction takes
	 * TWO clock reads, so it yields `timestamp - δ` for whatever δ elapsed between
	 * them (0 normally, ≥1 across a millisecond boundary or a GC pause). A caller
	 * that compares the write time before and against after an await — the Codex
	 * coordinator's supersession guard — then sees a phantom "advance" whenever δ
	 * differs between its two evaluations, and skips applying a read that nothing
	 * actually superseded.
	 */
	peekWrittenAt(accountId: string): number | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;
		return cached.timestamp;
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
