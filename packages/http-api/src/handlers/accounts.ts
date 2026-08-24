import crypto from "node:crypto";
import type { Config } from "@clankermux/config";
import {
	ACCOUNT_WIDE_HARD_STATUSES,
	accountWideExhaustion,
	isAnthropicUsageShape,
	isIndependentBlock,
	patterns,
	providerStatusToCause,
	type RateLimitCause,
	sanitizers,
	TIME_CONSTANTS,
	validateNumber,
	validatePriority,
	validateString,
} from "@clankermux/core";
import {
	type CodexResetCreditEventRow,
	type DatabaseOperations,
	DuplicateAccountNameError,
	insertAccountUnique,
} from "@clankermux/database";
import { ValidationError } from "@clankermux/errors";
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import {
	type AnyUsageData,
	type CodexCreditsInfo,
	codexRateLimitResetCreditsCache,
	fetchUsageData,
	getRepresentativeMinimaxUtilization,
	getRepresentativeMinimaxWindow,
	getRepresentativeUtilization,
	getRepresentativeWindow,
	type MinimaxUsageData,
	USAGE_CACHE_TTL_MS,
	type UsageData,
	usageCache,
} from "@clankermux/providers";
import {
	clearAccountAffinity,
	clearAccountRefreshCache,
	clearCapacityRestoredProbePending,
	clearProviderOverloadCooldown,
	consumeCodexResetCreditForAccount,
	getForcedAccount,
	getProviderOverloadKey,
	getProviderOverloadSnapshot,
	getProviderOverloadUntil,
	getUsageThrottleStatus,
	peekPrimaryAccountId,
	refreshCodexResetCreditsForAccount,
	refreshCodexUsageForAccount,
	restartUsagePollingForAccount,
	sessionCacheStore,
	setForcedAccount,
} from "@clankermux/proxy";
import type {
	Account,
	AnthropicUsageData,
	CodexRateLimitResetCreditConsumeRequest,
	CodexRateLimitResetCreditConsumeResponse,
	CodexResetCreditEventResponse,
	CodexResetCreditEventStatus,
	FullUsageData,
	LoadBalancingStrategy,
	RateLimitReason,
	StaleUsageInfo,
	UsageExhaustionBinding,
} from "@clankermux/types";
import {
	computeDuplicateAccountFlags,
	isRateLimitReason,
	microsToUsd,
	requiresSessionDurationTracking,
	usdToMicros,
} from "@clankermux/types";
import {
	pauseAccount,
	removeAccountById,
	resumeAccount,
} from "../services/admin/accounts";
import { buildPredictionsForAccounts } from "../services/build-account-predictions-for";
import { getCachedOrPersistedCodexUsage } from "../services/resolve-codex-usage";
import type { AccountResponse } from "../types";
import { primeUsagePollingForNewAccount } from "./account-usage-priming";
import { invalidateDashboardCache } from "./analytics-runner";
import {
	API_KEY_PROVIDERS,
	createApiKeyAccountAddHandler,
} from "./api-key-account-add";

const log = new Logger("AccountsHandler");

/**
 * Validate a stored `rate_limited_reason` for the API response. Backed by
 * `RATE_LIMIT_REASONS` in `@clankermux/types`, the same runtime tuple the
 * `RateLimitReason` union is derived from — a hand-maintained allowlist used to
 * live here and silently nulled `family_weekly_exhausted_429`, hiding its
 * dashboard error card. Unknown (e.g. far-future) values still degrade to null.
 */
function toRateLimitReason(v: string | null): RateLimitReason | null {
	if (v === null) return null;
	return isRateLimitReason(v) ? v : null;
}

/**
 * Providers that support the auto-pause-on-overage/credits toggle. Anthropic
 * has subscription-overage detection; Codex has credits/overage detection.
 * Module-level to avoid per-request allocation.
 */
const OVERAGE_PAUSE_PROVIDERS = new Set(["anthropic", "codex"]);

/**
 * Mirror of the usage-snapshot sampler cadence
 * (`SAMPLE_INTERVAL_MS = 120_000` in
 * `apps/server/src/usage-snapshot-sampler.ts`). http-api is a package and must
 * not import from apps/server, so the value is duplicated here and kept in sync
 * by hand. Inline named constant (no env knobs, per project rule).
 */
const SNAPSHOT_SAMPLE_INTERVAL_MS = 120_000;

/**
 * A persisted snapshot only surfaces its fast-moving 5-hour reading as a stale
 * fallback if it was sampled within two sample intervals (~4 min) of now. The
 * 5h window moves fast, so an older snapshot would be actively misleading; the
 * common fresh case is right after a restart, before the poller warms the live
 * cache. The weekly window is NOT age-gated (it stays relevant for days).
 */
const STALE_USAGE_MAX_AGE_MS = 2 * SNAPSHOT_SAMPLE_INTERVAL_MS;

/**
 * Status prefixes that mean the account is actually blocked (vs soft warnings
 * like "allowed_warning" / "queueing_soft" which mean it is still usable).
 * The shared vocabulary lives in `@clankermux/core`; the stored column can carry
 * a trailing suffix, so membership is tested as a prefix match.
 */
const HARD_LIMIT_PREFIXES = [...ACCOUNT_WIDE_HARD_STATUSES];

/** The stored account fields the rate-limit presentation is derived from. */
interface RateLimitFields {
	rate_limit_status: string | null;
	rate_limit_reset: number | string | null;
	rate_limited: boolean | 0 | 1 | null;
	rate_limited_until: number | string | null;
	/** Why the proxy last cooled the account down; drives the billing carve-out. */
	rate_limited_reason?: string | null;
}

/** The resolved, display-ready rate-limit state of an account. */
export interface RateLimitPresentation {
	/** Normalized, machine-readable cause. */
	cause: RateLimitCause;
	/** Epoch ms when the cause is expected to clear; null when unknown. */
	resetMs: number | null;
	/**
	 * Which account-wide window drove a `usage_exhausted` cause (a `weekly`
	 * window or the rolling 5-hour `session`); null for every other cause.
	 */
	binding: UsageExhaustionBinding | null;
	/** Raw stored provider status, for diagnostics (may be an unrecognized value). */
	providerStatus: string | null;
	/** Back-compat `<base> (Nm)` projection — derived here so it cannot drift. */
	status: string;
}

/** `<base>` or `<base> (Nm)` when the reset is a known future time. */
function withCountdown(base: string, resetMs: number | null, now: number) {
	if (resetMs === null || resetMs <= now) return base;
	return `${base} (${Math.ceil((resetMs - now) / 60000)}m)`;
}

/**
 * Resolve an account's rate-limit state into ONE decision that drives both the
 * structured API fields and the back-compat `rateLimitStatus` string.
 *
 * The stored `rate_limit_status` comes from upstream response headers and can go
 * stale: once the proxy locks an account (`rate_limited_until` in the future,
 * e.g. via the model_fallback_429 cooldown), no responses arrive to refresh it,
 * so a soft "allowed_warning" can linger while the account is in fact blocked.
 *
 * Precedence is CAUSE-WINS:
 *
 *  1. Independent blocks keep their own label — a stored `payment_required` /
 *     `blocked`, or an `out_of_credits` cooldown reason. These are
 *     administrative/billing states that a spent quota does not explain.
 *  2. ACCOUNT-WIDE exhaustion (a spent weekly window OR the spent 5-hour
 *     session) with a known future reset wins over every generic throttle
 *     signal. A cooldown lock, `rate_limited`, `queueing_hard` and `rejected`
 *     are all throttle MECHANISMS; the spent window is the CAUSE, and reporting
 *     the mechanism is what made identically-exhausted accounts read differently
 *     depending on whether a lock happened to still be ticking. The countdown is
 *     the LATER of the window reset and the lock, so it stays honest if a lock
 *     outlives the quota window.
 *  3. Otherwise: an active lock over a non-hard stored status surfaces the lock;
 *     a hard stored status passes through; then the legacy `rate_limited` flag;
 *     then account-wide exhaustion with an unknown reset; else OK.
 *
 * Pure (caller injects `now`) so it can be unit tested directly.
 */
export function resolveRateLimitPresentation(
	fields: RateLimitFields,
	now: number,
	/**
	 * Account-wide exhaustion (a weekly window or the 5h session at >= 100% with
	 * a future reset), when known, together with WHICH class bound. Display-only
	 * — does not affect routing.
	 */
	accountWideExhausted?: {
		resetMs: number | null;
		binding: UsageExhaustionBinding;
	} | null,
): RateLimitPresentation {
	const providerStatus = fields.rate_limit_status || null;
	const lockMs = fields.rate_limited_until
		? Number(fields.rate_limited_until)
		: 0;
	const hasActiveLock = lockMs > now;
	const storedIsHard =
		providerStatus !== null &&
		HARD_LIMIT_PREFIXES.some((prefix) =>
			providerStatus.toLowerCase().startsWith(prefix),
		);
	// A provider status the vocabulary has not been taught becomes `unknown`,
	// which is in NEITHER cause set: the account reads as limited (we cannot tell
	// that it is fine — that is exactly how `rejected` went unnoticed) but not as
	// an account-wide hard block (so Force Reset stays governed by the lock alone).
	// The raw value is carried in `providerStatus`, and the back-compat `status`
	// string still passes it through verbatim, so the chip humanizes it as before.
	const storedCause: RateLimitCause | null = providerStatus
		? (providerStatusToCause(providerStatus) ?? "unknown")
		: null;

	// 1. Administrative / billing blocks are not explained by a spent quota.
	//    Shared with `/health?detail=1` so the two surfaces cannot drift.
	const independentBlock = isIndependentBlock(
		providerStatus,
		fields.rate_limited_reason,
	);

	// 2. Account-wide exhaustion outranks every generic throttle mechanism.
	const exhaustedResetMs = accountWideExhausted?.resetMs ?? null;
	if (
		accountWideExhausted &&
		!independentBlock &&
		exhaustedResetMs !== null &&
		exhaustedResetMs > now
	) {
		const resetMs = Math.max(exhaustedResetMs, lockMs);
		return {
			cause: "usage_exhausted",
			resetMs,
			binding: accountWideExhausted.binding,
			providerStatus,
			status: withCountdown("usage_exhausted", resetMs, now),
		};
	}

	// 3. Today's logic, unchanged.
	if (providerStatus !== null && storedCause !== null) {
		if (hasActiveLock && !storedIsHard) {
			// Stale soft status while the proxy lock is active — surface the lock.
			return {
				cause: "rate_limited",
				resetMs: lockMs,
				binding: null,
				providerStatus,
				status: withCountdown("rate_limited", lockMs, now),
			};
		}
		// A SOFT stored status (allowed/allowed_warning/…) does NOT block the
		// account, but account-wide exhaustion does. With no active lock and a spent
		// account-wide window (reset unknown), surface `usage_exhausted` instead of
		// the reassuring soft status.
		if (!hasActiveLock && !storedIsHard && accountWideExhausted) {
			return {
				cause: "usage_exhausted",
				resetMs: null,
				binding: accountWideExhausted.binding,
				providerStatus,
				status: "usage_exhausted",
			};
		}
		const providerResetMs = Number(fields.rate_limit_reset);
		if (providerResetMs && providerResetMs > now) {
			return {
				cause: storedCause,
				resetMs: providerResetMs,
				binding: null,
				providerStatus,
				status: withCountdown(providerStatus, providerResetMs, now),
			};
		}
		if (hasActiveLock) {
			// Hard stored status with an active proxy lock but no usable provider
			// reset (null or already past) — fall back to the lock-based countdown so
			// the chip still shows when the block lifts. A provider rate_limit_reset
			// that is set and in the future wins (above).
			return {
				cause: storedCause,
				resetMs: lockMs,
				binding: null,
				providerStatus,
				status: withCountdown(providerStatus, lockMs, now),
			};
		}
		return {
			cause: storedCause,
			resetMs: null,
			binding: null,
			providerStatus,
			status: providerStatus,
		};
	}

	if (fields.rate_limited && hasActiveLock) {
		// Fall back to legacy rate limit check
		return {
			cause: "rate_limited",
			resetMs: lockMs,
			binding: null,
			providerStatus,
			status: withCountdown("Rate limited", lockMs, now),
		};
	}

	// No live lock/status: an account whose weekly or 5h session window is spent
	// is genuinely blocked for account-wide requests even though nothing has
	// cooled it yet — surface it rather than a misleading "OK".
	if (accountWideExhausted) {
		return {
			cause: "usage_exhausted",
			resetMs: null,
			binding: accountWideExhausted.binding,
			providerStatus,
			status: "usage_exhausted",
		};
	}

	return {
		cause: "ok",
		resetMs: null,
		binding: null,
		providerStatus,
		status: "OK",
	};
}

/**
 * The display-ready `rateLimitStatus` string for an account — a thin projection
 * of {@link resolveRateLimitPresentation} so the string and the structured
 * fields can never disagree.
 */
export function presentRateLimitStatus(
	fields: RateLimitFields,
	now: number,
	accountWideExhausted?: {
		resetMs: number | null;
		binding: UsageExhaustionBinding;
	} | null,
): string {
	return resolveRateLimitPresentation(fields, now, accountWideExhausted).status;
}

/**
 * Create an accounts list handler
 */
export function createAccountsListHandler(
	dbOps: DatabaseOperations,
	config: Config,
	getStrategy?: () => LoadBalancingStrategy | null,
) {
	return async (): Promise<Response> => {
		const db = dbOps.getAdapter();
		const now = Date.now();
		const sessionDuration = 5 * 60 * 60 * 1000; // 5 hours

		const strategy = getStrategy?.() ?? null;

		const accounts = await db.query<{
			id: string;
			name: string;
			provider: string | null;
			request_count: number;
			total_requests: number;
			last_used: number | null;
			created_at: number;
			expires_at: number | null;
			rate_limited_until: number | null;
			rate_limited_reason: string | null;
			rate_limited_at: number | null;
			rate_limit_reset: number | null;
			rate_limit_status: string | null;
			rate_limit_remaining: number | null;
			session_start: number | null;
			session_request_count: number;
			refresh_token: string;
			access_token: string | null;
			paused: 0 | 1;
			priority: number;
			token_valid: 0 | 1;
			rate_limited: 0 | 1;
			session_info: string | null;
			auto_fallback_enabled: 0 | 1;
			auto_refresh_enabled: 0 | 1;
			auto_pause_on_overage_enabled: 0 | 1;
			peak_hours_pause_enabled: 0 | 1;
			codex_auto_apply_reset_credits_enabled: 0 | 1;
			codex_auto_apply_reset_on_weekly_limit_enabled: 0 | 1;
			custom_endpoint: string | null;
			model_mappings: string | null;
			model_fallbacks: string | null;
			billing_type: string | null;
			pause_reason: string | null;
			notes: string | null;
			renewal_anchor: string | null;
			renewal_cadence: string | null;
			renewal_price_usd_micros: number | null;
			identity_external_id: string | null;
			identity_email: string | null;
			identity_organization_name: string | null;
			identity_plan_tier: string | null;
			identity_rate_limit_tier: string | null;
			identity_captured_at: number | null;
			identity_profile_fetched_at: number | null;
			codex_usage_json: string | null;
			codex_usage_observed_at: number | null;
			refresh_token_expires_at: number | null;
		}>(
			`
				SELECT
					id,
					name,
					provider,
					request_count,
					total_requests,
					last_used,
					created_at,
					expires_at,
					rate_limited_until,
						rate_limited_reason,
						rate_limited_at,
					rate_limit_reset,
					rate_limit_status,
					rate_limit_remaining,
					session_start,
					session_request_count,
					refresh_token,
					access_token,
					COALESCE(paused, 0) as paused,
					COALESCE(priority, 0) as priority,
					COALESCE(auto_fallback_enabled, 0) as auto_fallback_enabled,
					COALESCE(auto_refresh_enabled, 0) as auto_refresh_enabled,
					custom_endpoint,
					COALESCE(auto_pause_on_overage_enabled, 0) as auto_pause_on_overage_enabled,
					COALESCE(peak_hours_pause_enabled, 0) as peak_hours_pause_enabled,
					COALESCE(codex_auto_apply_reset_credits_enabled, 0) as codex_auto_apply_reset_credits_enabled,
					COALESCE(codex_auto_apply_reset_on_weekly_limit_enabled, 0) as codex_auto_apply_reset_on_weekly_limit_enabled,

					model_mappings,
					model_fallbacks,
					billing_type,
					pause_reason,
					notes,
					renewal_anchor,
					renewal_cadence,
					renewal_price_usd_micros,
					identity_external_id,
					identity_email,
					identity_organization_name,
					identity_plan_tier,
					identity_rate_limit_tier,
					identity_captured_at,
					identity_profile_fetched_at,
					codex_usage_json,
					codex_usage_observed_at,
					refresh_token_expires_at,
					CASE
						WHEN expires_at > ? THEN 1
						ELSE 0
					END as token_valid,
					CASE
						WHEN rate_limited_until > ? THEN 1
						ELSE 0
					END as rate_limited,
					CASE
						WHEN session_start IS NOT NULL AND ? - session_start < ? THEN
							'Active: ' || session_request_count || ' reqs'
						ELSE '-'
					END as session_info
				FROM accounts
				ORDER BY priority DESC, request_count DESC
			`,
			[now, now, now, sessionDuration],
		);

		// Predict where a fresh, nominal-size request would route RIGHT NOW from
		// the same in-memory snapshot we use to build the response — querying
		// again would open a race window where isPrimary could land on a row
		// whose paused/rate-limited fields the same response shows as blocked.
		// peekPrimaryAccountId() applies the proxy's provider-overload +
		// usage-throttle gates over the strategy ranking (so the badge follows
		// real routing, incl. cross-provider Codex fallback), returning null
		// when everything is gated. Only the fields peekRanked + both gates read
		// are mapped here; the rest of the Account interface is unused.
		const primaryCandidates = accounts.map(
			(a) =>
				({
					id: a.id,
					provider: a.provider ?? "",
					paused: !!a.paused,
					// pause_reason and rate_limit_reset feed wouldAutoUnpause —
					// without them peekRanked() can't simulate the auto-unpause that
					// select() performs on safe-reason paused accounts whose
					// upstream window has reset.
					pause_reason: a.pause_reason ?? null,
					rate_limited_until: a.rate_limited_until
						? Number(a.rate_limited_until)
						: null,
					rate_limit_reset: a.rate_limit_reset
						? Number(a.rate_limit_reset)
						: null,
					session_start: a.session_start ? Number(a.session_start) : null,
					priority: a.priority,
					auto_fallback_enabled: !!a.auto_fallback_enabled,
				}) as Account,
		);
		const primaryId = peekPrimaryAccountId(
			primaryCandidates,
			strategy,
			config,
			now,
		);

		// Fetch session-window token stats only for providers with session-based
		// limits, and only while that window is still open. `session_start` is
		// never cleared when a window elapses, so this repeats the freshness bound
		// the `session_info` column above already applies; without it an account
		// idle for days keeps reporting the spend of a window that closed, next to
		// a `session_info` that reads "-".
		const sessionStatsMap = await dbOps
			.getStatsRepository()
			.getSessionStats(
				accounts
					.filter((a) => requiresSessionDurationTracking(a.provider ?? ""))
					.map((a) => {
						const startedAt = a.session_start ? Number(a.session_start) : null;
						return {
							id: a.id,
							session_start:
								startedAt !== null && now - startedAt < sessionDuration
									? startedAt
									: null,
						};
					}),
			)
			.catch(() => new Map());

		// Distinct active-client sessions per account in the trailing 15m window,
		// for the Accounts "N clients (15m)" badge. Best-effort: on repo failure
		// each account falls back to 0.
		const activeSessionCountsByAccount = await dbOps
			.getStatsRepository()
			.getActiveSessionCountsByAccount(
				now - TIME_CONSTANTS.ACTIVE_SESSION_WINDOW_MS,
			)
			.catch(() => new Map<string, number>());

		// Live usage read ONCE per account via peekWithAge(): non-evicting, and it
		// keeps serving a reading that is past the ROUTING TTL, reporting its true
		// age (up to UI_STALE_HORIZON_MS). The old get() was evicting AND
		// TTL-gated, which had two costs: (a) an idle account whose next poll had
		// not landed yet showed the amber "Live usage unavailable" banner despite
		// healthy polling, and (b) every read mutated cache state, so the read had
		// to be hoisted here and threaded to avoid a second read evicting an entry
		// the stale-candidate filter still needed. (a) is what this endpoint now
		// fixes by carrying the age to the UI; the hoisting is kept anyway so the
		// whole response is built from ONE consistent snapshot per account.
		//
		// TWO VIEWS, deliberately different — classify every new consumer:
		//  - `liveUsageByAccount` (UI horizon, up to 30 min): DISPLAY only. What the
		//    dashboard renders, annotated with `usageAsOfIso`. Used by the
		//    stale-snapshot fallback filter, the rendered `usageData`/utilization/
		//    window, the weekly-exhaustion label, the throttle annotation and the
		//    Codex credits chip — all of which describe a reading AS OF a stated
		//    time and stay honest when that time is minutes ago.
		//  - `routingFreshUsageByAccount` (ROUTING TTL, 10 min): anything that
		//    DERIVES a value modelling "now". That is the exhaustion prediction,
		//    which appends the live reading as a data point stamped `t: now` (see
		//    build-account-predictions.ts) — an aged reading injected there would
		//    read as a fresh sample and skew the regression — and the SESSION half
		//    of the account-wide exhaustion verdict (below).
		// The account-wide exhaustion verdict is the one consumer that reads BOTH,
		// deliberately: the weekly windows move over days, so asserting them from a
		// reading up to 30 min old is honest, while the 5h session window moves fast
		// enough that a half-hour-old 100% is no longer evidence of anything. It
		// therefore passes the display view for the weekly class and the
		// routing-fresh view for the session class (see `accountWideExhaustion`'s
		// third parameter).
		// (The `isPrimary` routing simulation reads the cache itself via
		// usageCache.peek(), which is TTL-gated independently of both maps.)
		const liveUsageEntryByAccount = new Map(
			accounts.map((a) => [a.id, usageCache.peekWithAge(a.id)] as const),
		);
		const liveUsageByAccount = new Map(
			accounts.map(
				(a) => [a.id, liveUsageEntryByAccount.get(a.id)?.data ?? null] as const,
			),
		);
		const routingFreshUsageByAccount = new Map(
			accounts.map((a) => {
				const entry = liveUsageEntryByAccount.get(a.id);
				return [
					a.id,
					entry && entry.ageMs <= USAGE_CACHE_TTL_MS ? entry.data : null,
				] as const;
			}),
		);

		// Earned Codex resets come from a separate read-only account endpoint, not
		// the /responses headers. Snapshot the cache for this response, then kick a
		// best-effort background refresh for missing/stale entries. The dashboard's
		// normal account polling picks up the result without delaying this request.
		const codexResetCreditsByAccount = new Map(
			accounts
				.filter((a) => a.provider === "codex")
				.map((a) => [a.id, codexRateLimitResetCreditsCache.get(a.id)]),
		);
		for (const account of accounts) {
			if (
				account.provider === "codex" &&
				codexRateLimitResetCreditsCache.needsRefresh(account.id, now)
			) {
				void refreshCodexResetCreditsForAccount(account.id);
			}
		}

		// Last-known usage fallback: for Anthropic accounts whose live usage
		// cache is empty (e.g. polling fails after the subscription lapsed),
		// serve the most recent persisted usage snapshot so the dashboard can
		// still show the weekly utilization and its reset date.
		const staleCandidateIds = accounts
			.filter(
				(a) =>
					(a.provider || "anthropic") === "anthropic" &&
					!liveUsageByAccount.get(a.id),
			)
			.map((a) => a.id);
		const latestSnapshotByAccount = new Map(
			(staleCandidateIds.length
				? await dbOps.getLatestUsageSnapshots(staleCandidateIds).catch(() => [])
				: []
			).map((snapshot) => [snapshot.accountId, snapshot]),
		);

		// Best-effort per-account exhaustion prediction: least-squares regression
		// over recent stored snapshots + the live reading, attached below. The
		// whole operation — eligibility, lookback, snapshot query and the
		// empty-map-on-failure policy — lives in the shared service so this
		// endpoint and `/api/runway` cannot drift. A DB or compute failure must
		// NEVER break the accounts response; on error every account simply gets
		// `prediction: null`.
		//
		// Sourced from `routingFreshUsageByAccount`, NOT the display view: the
		// service appends this reading with `t: now`, so a reading that is minutes
		// old would enter the regression claiming to be current.
		const predictionByAccount = await buildPredictionsForAccounts(
			dbOps,
			accounts.map((a) => ({ id: a.id, provider: a.provider ?? null })),
			routingFreshUsageByAccount,
			now,
		);

		const response: AccountResponse[] = await Promise.all(
			accounts.map(async (account) => {
				const provider = account.provider || "anthropic";
				const providerOverloadedUntil = getProviderOverloadUntil(provider, now);
				const providerOverloadKey = providerOverloadedUntil
					? getProviderOverloadKey(provider)
					: null;
				// Family-scoped breaker buckets (open/half-open only — closed buckets
				// never appear in the snapshot). Null when the breaker is fully closed.
				const overloadBuckets = getProviderOverloadSnapshot(provider, now);
				const providerOverload =
					overloadBuckets.length > 0
						? overloadBuckets.map((bucket) => ({
								family: bucket.family,
								// The snapshot only ever emits live buckets; narrow the type.
								state: bucket.state as "open" | "half-open",
								until: bucket.until,
								probeActive: bucket.probeActive,
							}))
						: null;

				// Get usage data from cache for providers that expose account-page quota or credit data
				const liveUsageEntry = liveUsageEntryByAccount.get(account.id) ?? null;
				const cachedUsageData = liveUsageByAccount.get(account.id) ?? null;
				let usageData: FullUsageData | null =
					cachedUsageData as FullUsageData | null;
				// Whether the usage we are about to serve really IS the live cache
				// entry — the only case where labelling it with that entry's sample
				// time is truthful. Codex may substitute DB-restored data below.
				let usageIsLiveCacheEntry = liveUsageEntry != null;
				// Observation time of a Codex reading restored from the persisted
				// account column — the one non-cache source that knows honestly WHEN it
				// was sampled. Null for every other source.
				let usageObservedAtMs: number | null = null;
				// True only for a Codex reading served from `accounts.codex_usage_json`.
				// That path deliberately does NOT re-seed the usage cache, so the proxy
				// cannot see this reading — anything that describes proxy BEHAVIOUR
				// (the throttle status below) must sit this one out.
				let usageServedFromCodexColumn = false;
				// Credits state stored on the account column, used as the last fallback
				// for the credits chip. Kept even when the column's windows have all
				// lapsed (see readPersistedCodexUsageColumn).
				let persistedCodexCredits: CodexCreditsInfo | null = null;
				if (account.provider === "codex") {
					const resolved = await getCachedOrPersistedCodexUsage(
						db,
						account.id,
						account.name,
						usageData,
						account.codex_usage_json,
						account.codex_usage_observed_at != null
							? Number(account.codex_usage_observed_at)
							: null,
						account.last_used != null ? Number(account.last_used) : null,
						// The management accounts page is the surface that has always
						// owned this recovery, and it is the one entitled to refresh what
						// the proxy can see.
						{ seedCache: true },
					);
					usageData = resolved.data;
					usageIsLiveCacheEntry = resolved.source === "cache";
					usageServedFromCodexColumn = resolved.source === "column";
					// Only the column source carries an honest observation time.
					usageObservedAtMs =
						resolved.source === "column" ? resolved.observedAtMs : null;
					persistedCodexCredits = resolved.persistedCredits;
				}

				// Account-wide exhaustion (anthropic/codex only): the weeklyAll window,
				// the flat seven_day_oauth_apps (Claude Code weekly quota) OR the
				// rolling 5-hour session at/above 100% with a future reset, reported
				// with WHICH class bound. Shared with /health via
				// `accountWideExhaustion`, keeping the display consistent with the
				// account-wide representative used for the cooldown-clear guard.
				// Surfaced in rateLimitStatus so an exhausted-but-not-yet-cooled
				// account stops reading "OK", and so a session-exhausted account
				// reports the CAUSE rather than the cooldown MECHANISM.
				// Family-scoped windows are per-model and NOT reflected here.
				//
				// TWO VIEWS (see the note above `liveUsageByAccount`): the weekly class
				// is read from the 30-minute display horizon, the fast-moving session
				// class from the 10-minute routing-fresh view.
				let accountWideExhausted: {
					resetMs: number | null;
					binding: UsageExhaustionBinding;
				} | null = null;
				if (account.provider === "anthropic" || account.provider === "codex") {
					const { exhausted, resetMs, binding } = accountWideExhaustion(
						usageData as AnthropicUsageData | null,
						now,
						(routingFreshUsageByAccount.get(account.id) ??
							null) as AnthropicUsageData | null,
					);
					if (exhausted && binding !== null) {
						accountWideExhausted = { resetMs, binding };
					}
				}

				const rateLimitPresentation = resolveRateLimitPresentation(
					{
						rate_limit_status: account.rate_limit_status,
						rate_limit_reset: account.rate_limit_reset,
						rate_limited: account.rate_limited,
						rate_limited_until: account.rate_limited_until,
						rate_limited_reason: account.rate_limited_reason,
					},
					now,
					accountWideExhausted,
				);
				const rateLimitStatus = rateLimitPresentation.status;
				// Codex-only credits state for the response chip; null for other
				// providers or when unknown. Prefer the resolved usage object, but
				// fall back to the RAW cached usage: normalizeCodexUsageData returns
				// null when both windows have no reset time (fresh account / just
				// after a window roll), which would otherwise drop the credits chip
				// even though the cache knows the account is on credits. Reuse the
				// already-read `cachedUsageData` (the single per-account cache read
				// from `liveUsageByAccount`) rather than reading the cache again, so
				// the whole response describes one consistent snapshot per account.
				// Last resort is the persisted column's credits: after a restart the
				// cache is cold, and an idle account's snapshot may hold nothing but
				// spent windows — the credits state is still true.
				const codexCredits =
					account.provider === "codex"
						? ((usageData as UsageData | null)?.codexCredits ??
							(cachedUsageData as UsageData | null)?.codexCredits ??
							persistedCodexCredits ??
							null)
						: null;
				const resetCreditsEntry =
					account.provider === "codex"
						? (codexResetCreditsByAccount.get(account.id) ?? null)
						: null;
				const codexRateLimitResetCredits = resetCreditsEntry
					? {
							availableCount: resetCreditsEntry.summary.availableCount,
							credits:
								resetCreditsEntry.summary.credits?.map((credit) => ({
									status: credit.status,
									expiresAt:
										credit.expiresAt == null
											? null
											: new Date(credit.expiresAt * 1_000).toISOString(),
									title: credit.title,
									description: credit.description,
								})) ?? null,
							fetchedAt: new Date(resetCreditsEntry.fetchedAt).toISOString(),
						}
					: null;
				let usageUtilization: number | null = null;
				let usageWindow: string | null = null;
				let fullUsageData: FullUsageData | null = null;
				let usageThrottledUntil: number | null = null;
				let usageThrottledWindows: string[] = [];

				if (
					(account.provider === "anthropic" || account.provider === "codex") &&
					usageData
				) {
					// Accept `limits[]`-only payloads (upstream is dropping the flat
					// five_hour/seven_day keys), not just the both-flat-keys shape, so a
					// limits-only account still populates its usage bars/utilization.
					const isAnthropicStyleData = isAnthropicUsageShape(
						usageData as AnthropicUsageData | null,
					);
					if (isAnthropicStyleData) {
						try {
							usageUtilization = getRepresentativeUtilization(
								usageData as UsageData,
							);
							usageWindow = getRepresentativeWindow(usageData as UsageData);
							fullUsageData = usageData as FullUsageData;
						} catch (error) {
							log.warn(
								`Failed to process ${account.provider} usage data for account ${account.id}:`,
								error instanceof Error ? error.message : String(error),
							);
						}
					}
				} else if (account.provider === "zai" && usageData) {
					// Zai usage data - type guard to check it's ZaiUsageData
					const isZaiData =
						"time_limit" in usageData || "tokens_limit" in usageData;
					if (isZaiData) {
						try {
							const {
								getRepresentativeZaiUtilization,
								getRepresentativeZaiWindow,
							} = require("@clankermux/providers");
							usageUtilization = getRepresentativeZaiUtilization(usageData);
							usageWindow = getRepresentativeZaiWindow(usageData);
							fullUsageData = usageData as FullUsageData;
						} catch (error) {
							log.warn(
								`Failed to process Zai usage data for account ${account.name}:`,
								error,
							);
						}
					}
				} else if (account.provider === "kilo" && usageData) {
					// Kilo usage data - type guard to check it's KiloUsageData
					const isKiloData = "remainingUsd" in usageData;
					if (isKiloData) {
						try {
							const {
								getRepresentativeKiloUtilization,
								getRepresentativeKiloWindow,
							} = require("@clankermux/providers");
							usageUtilization = getRepresentativeKiloUtilization(usageData);
							usageWindow = getRepresentativeKiloWindow(usageData);
							fullUsageData = usageData as FullUsageData;
						} catch (error) {
							log.warn(
								`Failed to process Kilo usage data for account ${account.name}:`,
								error,
							);
						}
					}
				} else if (account.provider === "alibaba-coding-plan" && usageData) {
					// Alibaba Coding Plan usage data - type guard to check it's AlibabaCodingPlanUsageData
					const isAlibabaData =
						"five_hour" in usageData && "weekly" in usageData;
					if (isAlibabaData) {
						try {
							const {
								getRepresentativeAlibabaCodingPlanUtilization,
								getRepresentativeAlibabaCodingPlanWindow,
							} = require("@clankermux/providers");
							usageUtilization =
								getRepresentativeAlibabaCodingPlanUtilization(usageData);
							usageWindow = getRepresentativeAlibabaCodingPlanWindow(usageData);
							fullUsageData = usageData as FullUsageData;
						} catch (error) {
							log.warn(
								`Failed to process Alibaba Coding Plan usage data for account ${account.name}:`,
								error,
							);
						}
					}
				} else if (account.provider === "minimax" && usageData) {
					// MiniMax Token Plan usage — 5h/7d windows from
					// /v1/token_plan/remains. Statically imported (the neighbouring
					// branches' `require()` inside a try/catch does not belong in an ESM
					// handler), so a missing export is a build error rather than a
					// silently swallowed runtime one.
					const isMinimaxData =
						"five_hour" in usageData || "seven_day" in usageData;
					if (isMinimaxData) {
						const minimax = usageData as unknown as MinimaxUsageData;
						// Both helpers return null — never 0 — when there is no `general`
						// row, so "unknown" stays distinct from "0% used".
						usageUtilization = getRepresentativeMinimaxUtilization(minimax);
						usageWindow = getRepresentativeMinimaxWindow(minimax);
						fullUsageData = usageData as FullUsageData;
					}
				}

				// Last-known usage recovered from a persisted snapshot when the live
				// cache is cold. DISPLAY-ONLY — never read by routing/throttle/health/
				// prediction/capacity. Each window is carried independently:
				//  - Weekly: NOT age-gated. It stays relevant for days (e.g. a lapsed
				//    subscription whose polling stopped long ago), so any snapshot with
				//    a still-future weekly reset qualifies.
				//  - 5-hour: age-gated to within STALE_USAGE_MAX_AGE_MS (~4 min). The 5h
				//    window moves fast, so an older reading would mislead; the fresh
				//    case is right after a restart, before the poller warms the cache.
				// A snapshot timestamped in the future is a clock anomaly — drop both.
				let staleUsage: StaleUsageInfo | null = null;
				if (!fullUsageData) {
					const snapshot = latestSnapshotByAccount.get(account.id);
					if (snapshot && snapshot.ts <= now) {
						const ageMs = now - snapshot.ts;
						const fiveHour =
							snapshot.fiveHourPct != null &&
							snapshot.fiveHourReset != null &&
							snapshot.fiveHourReset > now &&
							ageMs <= STALE_USAGE_MAX_AGE_MS
								? {
										utilization: snapshot.fiveHourPct,
										resetIso: new Date(snapshot.fiveHourReset).toISOString(),
									}
								: undefined;
						const sevenDay =
							snapshot.sevenDayPct != null &&
							snapshot.sevenDayReset != null &&
							snapshot.sevenDayReset > now
								? {
										utilization: snapshot.sevenDayPct,
										resetIso: new Date(snapshot.sevenDayReset).toISOString(),
									}
								: undefined;
						if (fiveHour || sevenDay) {
							staleUsage = {
								...(fiveHour ? { fiveHour } : {}),
								...(sevenDay ? { sevenDay } : {}),
								asOfIso: new Date(snapshot.ts).toISOString(),
							};
						}
					}
				}

				const usageThrottleSettings = {
					fiveHourEnabled: config.getUsageThrottlingFiveHourEnabled(),
					weeklyEnabled: config.getUsageThrottlingWeeklyEnabled(),
				};
				// Unlike the bars, "requests are being delayed" is a claim about what
				// the PROXY is doing right now, and the proxy gates throttling on a
				// routing-fresh reading (`usageCache.peek()`, TTL-gated). Mirror that
				// gate so an aged display reading can't announce a delay that isn't
				// happening. Age of the reading behind `fullUsageData`: the live cache
				// entry's, or 0 for a Codex payload just re-derived from stored headers
				// (that path re-warms the cache, so the proxy sees it as fresh too).
				const usageDataAgeMs = usageIsLiveCacheEntry
					? (liveUsageEntry?.ageMs ?? 0)
					: 0;
				// The one reading with no cache counterpart at all: a Codex snapshot
				// restored from `accounts.codex_usage_json`, which is deliberately NOT
				// written back into the usage cache. Its age is unknown to the age
				// heuristic above (it would read as 0), and the proxy's throttle gate
				// sees an EMPTY cache for this account — so it is throttling nothing.
				if (
					(usageThrottleSettings.fiveHourEnabled ||
						usageThrottleSettings.weeklyEnabled) &&
					fullUsageData &&
					!usageServedFromCodexColumn &&
					usageDataAgeMs <= USAGE_CACHE_TTL_MS
				) {
					const usageThrottleStatus = getUsageThrottleStatus(
						fullUsageData as AnyUsageData,
						usageThrottleSettings,
						now,
					);
					usageThrottledUntil = usageThrottleStatus.throttleUntil;
					usageThrottledWindows = usageThrottleStatus.throttledWindows;
				}

				// Parse model mappings for OpenAI-compatible, Anthropic-compatible, and OpenRouter providers
				let modelMappings: { [key: string]: string } | null = null;
				if (account.model_mappings) {
					try {
						const parsed = JSON.parse(account.model_mappings);
						// Handle both formats: direct mappings or wrapped in modelMappings
						modelMappings = parsed.modelMappings || parsed || null;
					} catch {
						// If parsing fails, ignore model mappings
						modelMappings = null;
					}
				} else if (
					account.provider === "openai-compatible" &&
					account.custom_endpoint
				) {
					// Also try parsing from custom_endpoint for backwards compatibility
					try {
						const parsed = JSON.parse(account.custom_endpoint);
						if (parsed.modelMappings) {
							modelMappings = parsed.modelMappings;
						}
					} catch {
						// If parsing fails, ignore model mappings
						modelMappings = null;
					}
				}

				// Parse model fallbacks for all providers
				let modelFallbacks: { [key: string]: string } | null = null;
				if (account.model_fallbacks) {
					try {
						const parsed = JSON.parse(account.model_fallbacks);
						modelFallbacks = parsed.modelFallbacks || parsed || null;
					} catch {
						modelFallbacks = null;
					}
				}

				return {
					id: account.id,
					name: account.name,
					provider,
					requestCount: Number(account.request_count) || 0,
					totalRequests: Number(account.total_requests) || 0,
					lastUsed: account.last_used
						? new Date(Number(account.last_used)).toISOString()
						: null,
					created: new Date(Number(account.created_at)).toISOString(),
					paused: account.paused === 1,
					pauseReason: account.pause_reason ?? null,
					priority: Number(account.priority) || 0,
					tokenStatus: account.token_valid ? "valid" : "expired",
					tokenExpiresAt: account.expires_at
						? new Date(Number(account.expires_at)).toISOString()
						: null,
					// When the REFRESH token dies and the account needs a human
					// re-auth. null = the provider never reports one (only Anthropic
					// does), which the UI must render as unknown rather than distant.
					refreshTokenExpiresAt: account.refresh_token_expires_at
						? new Date(Number(account.refresh_token_expires_at)).toISOString()
						: null,
					rateLimitStatus,
					rateLimitCause: rateLimitPresentation.cause,
					rateLimitCauseResetMs: rateLimitPresentation.resetMs,
					rateLimitCauseBinding: rateLimitPresentation.binding,
					rateLimitProviderStatus: rateLimitPresentation.providerStatus,
					rateLimitReset: account.rate_limit_reset
						? new Date(Number(account.rate_limit_reset)).toISOString()
						: null,
					rateLimitRemaining:
						account.rate_limit_remaining != null
							? Number(account.rate_limit_remaining)
							: null,
					rateLimitedUntil: account.rate_limited_until
						? Number(account.rate_limited_until)
						: null,
					rateLimitedReason: toRateLimitReason(account.rate_limited_reason),
					rateLimitedAt:
						account.rate_limited_at != null
							? Number(account.rate_limited_at)
							: null,
					sessionInfo: account.session_info || "",
					autoFallbackEnabled: account.auto_fallback_enabled === 1,
					autoRefreshEnabled: account.auto_refresh_enabled === 1,
					autoPauseOnOverageEnabled:
						account.auto_pause_on_overage_enabled === 1,
					peakHoursPauseEnabled: account.peak_hours_pause_enabled === 1,
					autoApplyResetCreditsEnabled:
						account.codex_auto_apply_reset_credits_enabled === 1,
					autoApplyResetOnWeeklyLimitEnabled:
						account.codex_auto_apply_reset_on_weekly_limit_enabled === 1,
					customEndpoint: account.custom_endpoint,
					modelMappings,
					usageUtilization,
					usageWindow,
					usageData: fullUsageData, // Full usage data for UI
					codexCredits, // Codex-only credits state (null otherwise)
					codexRateLimitResetCredits,
					staleUsage,
					// When the reading in `usageData` was OBSERVED. Two honest sources:
					// the live cache entry's own observation time, and — for a Codex
					// reading restored from `accounts.codex_usage_observed_at` — the time
					// that observation was actually made. A reading reconstructed from an
					// old stored request payload still gets null rather than a borrowed
					// timestamp, INCLUDING on every refresh after the one that recovered
					// it: that recovery re-seeds the usage cache, so the reconstruction
					// comes back as a cache entry, and reading the entry's write time
					// here would quietly stamp it with the recovery instant. Uses
					// ABSOLUTE times, never `now - ageMs`: `now` predates this response's
					// DB round-trips, so the subtraction would report the reading as
					// older than it is. The dashboard annotates the bars with this once
					// the reading is older than the routing TTL — an honest age beats
					// claiming the data is unavailable.
					usageAsOfIso:
						usageIsLiveCacheEntry && liveUsageEntry?.observedAtMs != null
							? new Date(liveUsageEntry.observedAtMs).toISOString()
							: usageObservedAtMs != null
								? new Date(usageObservedAtMs).toISOString()
								: null,
					prediction: predictionByAccount.get(account.id) ?? null,
					usageRateLimitedUntil: usageCache.getRateLimitedUntil(account.id),
					usageThrottledUntil,
					usageThrottledWindows,
					providerOverloadKey,
					providerOverloadedUntil,
					providerOverload,
					hasRefreshToken:
						!!account.refresh_token &&
						account.refresh_token !== account.access_token, // API-key providers store key in both fields
					modelFallbacks,
					billingType: account.billing_type,
					notes: account.notes,
					renewalAnchor: account.renewal_anchor ?? null,
					renewalCadence:
						(account.renewal_cadence as "monthly" | "yearly" | "none" | null) ??
						null,
					renewalPriceUsd:
						account.renewal_price_usd_micros != null
							? microsToUsd(account.renewal_price_usd_micros)
							: null,
					sessionStats: sessionStatsMap.get(account.id) ?? null,
					activeSessionCount: activeSessionCountsByAccount.get(account.id) ?? 0,
					isPrimary: account.id === primaryId,
					identityExternalId: account.identity_external_id ?? null,
					identityEmail: account.identity_email ?? null,
					identityOrganizationName: account.identity_organization_name ?? null,
					identityPlanTier: account.identity_plan_tier ?? null,
					identityRateLimitTier: account.identity_rate_limit_tier ?? null,
					identityCapturedAt:
						account.identity_captured_at != null
							? Number(account.identity_captured_at)
							: null,
					identityProfileFetchedAt:
						account.identity_profile_fetched_at != null
							? Number(account.identity_profile_fetched_at)
							: null,
					// Overwritten below by computeDuplicateAccountFlags once the full
					// AccountResponse[] is assembled (needs sibling context).
					isDuplicateAccount: false,
					duplicateAccountIds: [],
				};
			}),
		);

		// Duplicate-login detection needs the whole account set, so it runs once
		// after the array is fully built — mirroring how isPrimary is stamped per
		// row above. computeDuplicateAccountFlags groups by provider-scoped identity
		// (external id / email) and returns each account's sibling ids.
		const duplicateFlags = computeDuplicateAccountFlags(response);
		for (const account of response) {
			const dupIds = duplicateFlags.get(account.id) ?? [];
			account.isDuplicateAccount = dupIds.length > 0;
			account.duplicateAccountIds = dupIds;
		}

		return jsonResponse(response);
	};
}

/**
 * Create an account priority update handler
 */
export function createAccountPriorityUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate priority input using the centralized validation function
			// Check if priority is provided (required)
			if (body.priority === undefined || body.priority === null) {
				return errorResponse(BadRequest("Priority is required"));
			}
			const priority = validatePriority(body.priority, "priority");

			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ id: string }>(
				"SELECT id FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			dbOps.updateAccountPriority(accountId, priority);

			return jsonResponse({ success: true, priority });
		} catch (_error) {
			return errorResponse(
				InternalServerError("Failed to update account priority"),
			);
		}
	};
}

/**
 * Create an account notes update handler.
 * Notes are optional/clearable free-text: null/undefined/empty-after-trim
 * stores null. Over-length input (>2000 chars) is rejected with HTTP 400.
 */
export function createAccountNotesUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// notes is optional/clearable: null/undefined/empty-after-trim => store null
			let notes: string | null = null;
			if (body.notes !== null && body.notes !== undefined) {
				const validated = validateString(body.notes, "notes", {
					required: false,
					maxLength: 2000,
					transform: sanitizers.trim,
				});
				notes = validated && validated.length > 0 ? validated : null;
			}

			const db = dbOps.getAdapter();
			const account = await db.get<{ id: string }>(
				"SELECT id FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			await dbOps.setAccountNotes(accountId, notes);

			return jsonResponse({ success: true, notes });
		} catch (error) {
			if (error instanceof ValidationError) {
				return errorResponse(BadRequest(error.message));
			}
			return errorResponse(
				InternalServerError("Failed to update account notes"),
			);
		}
	};
}

/**
 * Create an account add handler (manual token addition)
 * This is primarily used for adding accounts with existing tokens
 * For OAuth flow, use the OAuth handlers
 */
export function createAccountAddHandler(
	dbOps: DatabaseOperations,
	_config: Config,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			// Validate tokens
			const accessToken = validateString(body.accessToken, "accessToken", {
				required: true,
				minLength: 1,
			});

			const refreshToken = validateString(body.refreshToken, "refreshToken", {
				required: true,
				minLength: 1,
			});

			if (!accessToken || !refreshToken) {
				return errorResponse(
					BadRequest("Access token and refresh token are required"),
				);
			}

			// Validate provider
			const provider =
				validateString(body.provider, "provider", {
					allowedValues: ["anthropic"] as const,
				}) || "anthropic";

			// Validate priority
			const priority =
				validateNumber(body.priority, "priority", {
					min: 0,
					max: 100,
					integer: true,
				}) || 0;

			// Validate custom endpoint
			// TODO: Support custom endpoints for Claude API (console) accounts for enterprise users
			// This is needed for enterprises that have their own Anthropic API deployments
			const customEndpoint = validateString(
				body.customEndpoint || null,
				"customEndpoint",
				{
					required: false,
					transform: (value: string) => {
						if (!value) return "";
						const trimmed = value.trim();
						if (!trimmed) return "";
						// Validate URL format
						try {
							new URL(trimmed);
							return trimmed;
						} catch {
							throw new Error("Invalid URL format");
						}
					},
				},
			);

			try {
				// Add account directly to database
				const accountId = crypto.randomUUID();
				const now = Date.now();

				await insertAccountUnique(
					dbOps.getAdapter(),
					`INSERT INTO accounts (
						id, name, provider, refresh_token, access_token,
						created_at, request_count, total_requests, priority, custom_endpoint,
						auto_pause_on_overage_enabled
					) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1)`,
					[
						accountId,
						name,
						provider,
						refreshToken,
						accessToken,
						now,
						priority,
						customEndpoint || null,
					],
					name,
				);

				// Start usage polling immediately so the account's 5h/weekly bars
				// populate right away instead of a blank placeholder until restart.
				await primeUsagePollingForNewAccount({
					id: accountId,
					provider,
					name,
				});

				return jsonResponse({
					success: true,
					message: `Account ${name} added successfully`,
					priority,
					accountId,
				});
			} catch (error) {
				// The guarded insert refused a duplicate name. Matched by TYPE — the
				// previous `message.includes("already exists")` string test was
				// vestigial here (nothing on this path threw it) and would silently
				// mis-handle any unrelated message that happened to contain the phrase.
				if (error instanceof DuplicateAccountNameError) {
					return errorResponse(BadRequest(error.message));
				}
				return errorResponse(InternalServerError((error as Error).message));
			}
		} catch (error) {
			log.error("Account add error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to add account"),
			);
		}
	};
}

/**
 * Create an account remove handler
 */
export function createAccountRemoveHandler(dbOps: DatabaseOperations) {
	/**
	 * `accountId` is the `:id` path segment, exactly as the documented
	 * `DELETE /api/accounts/:id` contract says. It used to be treated as a NAME
	 * all the way down to `DELETE FROM accounts WHERE name = ?`, so any consumer
	 * following the documented contract got a silent 404 — and two accounts
	 * sharing a name would both have been deleted.
	 */
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			// Parse and validate confirmation
			const body = await req.json();

			// Validate confirmation string
			const confirm = validateString(body.confirm, "confirm", {
				required: true,
			});

			// Resolve the row FIRST: the confirm string is still typed as the account
			// NAME (the deliberate "type the name to delete" UX), and the in-memory
			// cleanup below needs the id while the row still exists.
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string }>(
				"SELECT name FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound(`Account '${accountId}' not found`));
			}

			if (confirm !== account.name) {
				return errorResponse(
					BadRequest("Confirmation string does not match account name", {
						confirmationRequired: true,
					}),
				);
			}

			const result = await removeAccountById(dbOps, accountId, account.name);

			if (!result.success) {
				return errorResponse(NotFound(result.message));
			}

			// In-memory cleanup, keyed by the SAME id that was deleted — so a name
			// collision can never evict a surviving account's state.
			// Clear usage cache for removed account to prevent memory leaks
			usageCache.delete(accountId);
			codexRateLimitResetCreditsCache.delete(accountId);
			// Evict any warm session-cache slots owned by the removed account so
			// the keepalive scheduler never tries to replay against a deleted id.
			sessionCacheStore.evictAccount(accountId);
			// Drop the account's recovery-probe state: any owed capacity-restored
			// probe plus its spent backup-probe permit record. Neither is ever
			// time-expired (both are deliberately retained until a successful probe
			// or a superseding lease), so removal is the only way a deleted id
			// stops occupying them.
			clearCapacityRestoredProbePending(accountId);

			return jsonResponse({
				success: true,
				message: result.message,
			});
		} catch (error) {
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to remove account"),
			);
		}
	};
}

/**
 * Create an account pause handler
 */
export function createAccountPauseHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			// Get account name by ID
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string }>(
				"SELECT name FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const result = await pauseAccount(dbOps, account.name);

			if (!result.success) {
				return errorResponse(BadRequest(result.message));
			}

			return jsonResponse({
				success: true,
				message: result.message,
			});
		} catch (error) {
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to pause account"),
			);
		}
	};
}

/**
 * Create an account resume handler
 */
export function createAccountResumeHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			// Get account name by ID
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string }>(
				"SELECT name FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const result = await resumeAccount(dbOps, account.name);

			if (!result.success) {
				return errorResponse(BadRequest(result.message));
			}

			return jsonResponse({
				success: true,
				message: result.message,
			});
		} catch (error) {
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to resume account"),
			);
		}
	};
}

/**
 * Create an account reset-session-stickiness handler.
 *
 * Clears BOTH layers of stickiness pointing at the account:
 *  1. the in-memory affinity pins held by the load-balancing strategy
 *     (via the registered affinity clearer), and
 *  2. the account's persisted active-session anchor (`session_start`),
 *     because the no-affinity `global_session` routing path re-sticks from
 *     `session_start` alone.
 *
 * After this, the account's sessions re-pick on their next request — the
 * manual lever for migrating sessions off an account after a priority change.
 */
export function createAccountResetStickinessHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			// Get account name by ID
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string }>(
				"SELECT name FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Clear in-memory affinity pins (across registered servers) and expire
			// the persisted session anchor.
			const cleared = clearAccountAffinity(accountId);
			await dbOps.clearAccountSessionAnchor(accountId);

			return jsonResponse({
				success: true,
				message: `Session stickiness reset for '${account.name}'`,
				cleared,
			});
		} catch (error) {
			log.error("Account reset-stickiness error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to reset session stickiness"),
			);
		}
	};
}

/**
 * Create a force-account handler.
 *
 * Sets the GLOBAL force-account override (Feature 3): while set, every
 * non-internal client request is routed straight to this account, bypassing
 * selection, all gates, and all failover/retry. One account at a time (setting
 * a new id replaces the old). Ephemeral — clears on server restart.
 */
export function createAccountForceHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string }>(
				"SELECT name FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			setForcedAccount(accountId);
			log.warn(
				`Force-account ENABLED: all traffic now routed to '${account.name}' (${accountId})`,
			);

			return jsonResponse({
				success: true,
				message: `All traffic now forced to '${account.name}'`,
				accountId,
			});
		} catch (error) {
			log.error("Account force error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to force account"),
			);
		}
	};
}

/**
 * Create a clear-force-account handler. Clears the global force-account
 * override; subsequent requests route normally.
 */
export function createAccountForceClearHandler() {
	return async (): Promise<Response> => {
		const previous = getForcedAccount();
		setForcedAccount(null);
		if (previous) {
			log.warn(`Force-account CLEARED (was '${previous}')`);
		}
		return jsonResponse({ success: true });
	};
}

/**
 * Create a get-force-account handler. Returns the currently forced account id
 * (or null). Used by the dashboard to reflect/sync the current force state.
 */
export function createAccountForceGetHandler() {
	return async (): Promise<Response> => {
		return jsonResponse({ accountId: getForcedAccount() });
	};
}

/**
 * Create an account rename handler
 */
export function createAccountRenameHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate new name
			const newName = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
				transform: sanitizers.trim,
			});

			if (!newName) {
				return errorResponse(BadRequest("New account name is required"));
			}

			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string }>(
				"SELECT name FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if new name is already taken
			const existingAccount = await db.get<{ id: string }>(
				"SELECT id FROM accounts WHERE name = ? AND id != ?",
				[newName, accountId],
			);

			if (existingAccount) {
				return errorResponse(
					BadRequest(`Account name '${newName}' is already taken`),
				);
			}

			// Rename the account
			dbOps.renameAccount(accountId, newName);

			return jsonResponse({
				success: true,
				message: `Account renamed from '${account.name}' to '${newName}'`,
				newName,
			});
		} catch (error) {
			log.error("Account rename error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to rename account"),
			);
		}
	};
}

/**
 * Create a z.ai account add handler
 */
// ---------------------------------------------------------------------------
// API-key provider account creation
//
// These nine providers share one request shape, one INSERT and one response
// body; only the values in API_KEY_PROVIDERS differ between them. Each factory
// below is kept as a named export because the router imports them by name.
// See ./api-key-account-add.ts.
// ---------------------------------------------------------------------------

export function createZaiAccountAddHandler(dbOps: DatabaseOperations) {
	return createApiKeyAccountAddHandler(dbOps, API_KEY_PROVIDERS.zai);
}

export function createOpenAIAccountAddHandler(dbOps: DatabaseOperations) {
	return createApiKeyAccountAddHandler(dbOps, API_KEY_PROVIDERS.openai);
}

export function createMinimaxAccountAddHandler(dbOps: DatabaseOperations) {
	return createApiKeyAccountAddHandler(dbOps, API_KEY_PROVIDERS.minimax);
}

export function createAnthropicCompatibleAccountAddHandler(
	dbOps: DatabaseOperations,
) {
	return createApiKeyAccountAddHandler(
		dbOps,
		API_KEY_PROVIDERS.anthropicCompatible,
	);
}

export function createOllamaAccountAddHandler(dbOps: DatabaseOperations) {
	return createApiKeyAccountAddHandler(dbOps, API_KEY_PROVIDERS.ollama);
}

export function createOllamaCloudAccountAddHandler(dbOps: DatabaseOperations) {
	return createApiKeyAccountAddHandler(dbOps, API_KEY_PROVIDERS.ollamaCloud);
}

export function createKiloAccountAddHandler(dbOps: DatabaseOperations) {
	return createApiKeyAccountAddHandler(dbOps, API_KEY_PROVIDERS.kilo);
}

export function createAlibabaCodingPlanAccountAddHandler(
	dbOps: DatabaseOperations,
) {
	return createApiKeyAccountAddHandler(
		dbOps,
		API_KEY_PROVIDERS.alibabaCodingPlan,
	);
}

export function createOpenRouterAccountAddHandler(dbOps: DatabaseOperations) {
	return createApiKeyAccountAddHandler(dbOps, API_KEY_PROVIDERS.openrouter);
}

export function createAccountAutoFallbackHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate enabled parameter
			const enabled = validateNumber(body.enabled, "enabled", {
				required: true,
				allowedValues: [0, 1] as const,
			});

			if (enabled === undefined) {
				return errorResponse(BadRequest("Enabled field is required (0 or 1)"));
			}

			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if account supports session-based auto-fallback
			if (!["anthropic", "codex", "zai"].includes(account.provider)) {
				return errorResponse(
					BadRequest("Auto-fallback is only available for supported accounts"),
				);
			}

			// Update auto-fallback setting
			dbOps.setAutoFallbackEnabled(accountId, enabled === 1);

			const action = enabled === 1 ? "enabled" : "disabled";

			return jsonResponse({
				success: true,
				message: `Auto-fallback ${action} for account '${account.name}'`,
				autoFallbackEnabled: enabled === 1,
			});
		} catch (error) {
			log.error("Account auto-fallback toggle error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to toggle auto-fallback"),
			);
		}
	};
}

/**
 * Create an account auto-pause-on-overage toggle handler
 */
export function createAccountAutoPauseOnOverageHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate enabled parameter
			const enabled = validateNumber(body.enabled, "enabled", {
				required: true,
				allowedValues: [0, 1] as const,
			});

			if (enabled === undefined) {
				return errorResponse(BadRequest("Enabled field is required (0 or 1)"));
			}

			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Only providers with credit/overage detection support this toggle.
			if (!OVERAGE_PAUSE_PROVIDERS.has(account.provider)) {
				return errorResponse(
					BadRequest(
						"Auto-pause on overage/credits is only available for Anthropic and Codex accounts",
					),
				);
			}

			// Update auto-pause-on-overage setting
			dbOps.setAutoPauseOnOverageEnabled(accountId, enabled === 1);

			const action = enabled === 1 ? "enabled" : "disabled";

			return jsonResponse({
				success: true,
				message: `Auto-pause on overage ${action} for account '${account.name}'`,
				autoPauseOnOverageEnabled: enabled === 1,
			});
		} catch (error) {
			log.error("Account auto-pause-on-overage toggle error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to toggle auto-pause-on-overage"),
			);
		}
	};
}

/**
 * Create an account peak-hours-pause toggle handler (Zai accounts only)
 */
export function createAccountPeakHoursPauseHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate enabled parameter
			const enabled = validateNumber(body.enabled, "enabled", {
				required: true,
				allowedValues: [0, 1] as const,
			});

			if (enabled === undefined) {
				return errorResponse(BadRequest("Enabled field is required (0 or 1)"));
			}

			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Only zai accounts support peak hours pause
			if (account.provider !== "zai") {
				return errorResponse(
					BadRequest("Peak hours pause is only available for Zai accounts"),
				);
			}

			// Update peak-hours-pause setting
			await dbOps.setPeakHoursPauseEnabled(accountId, enabled === 1);

			// Immediate resume when disabling — don't make users wait for scheduler
			if (enabled === 0) {
				await db.run(
					"UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ? AND COALESCE(paused, 0) = 1 AND pause_reason = 'peak_hours'",
					[accountId],
				);
			}

			const action = enabled === 1 ? "enabled" : "disabled";

			return jsonResponse({
				success: true,
				message: `Peak hours pause ${action} for account '${account.name}'`,
				peakHoursPauseEnabled: enabled === 1,
			});
		} catch (error) {
			log.error("Account peak-hours-pause toggle error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to toggle peak-hours-pause"),
			);
		}
	};
}

/**
 * Create an account billing type handler
 */
export function createAccountBillingTypeHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			const billingType = validateString(body.billingType, "billingType", {
				required: true,
				allowedValues: ["plan", "api", "auto"],
			});

			if (billingType === undefined) {
				return errorResponse(
					BadRequest("billingType must be 'plan', 'api', or 'auto'"),
				);
			}

			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Only allow custom billing type for compatible providers
			if (
				!["anthropic-compatible", "openai-compatible"].includes(
					account.provider,
				)
			) {
				return errorResponse(
					BadRequest(
						"Custom billing type is only available for anthropic-compatible and openai-compatible providers",
					),
				);
			}

			await dbOps.setAccountBillingType(
				accountId,
				billingType === "auto" ? null : billingType,
			);

			return jsonResponse({
				success: true,
				message: `Billing type set to '${billingType}' for account '${account.name}'`,
				billingType,
			});
		} catch (error) {
			log.error("Account billing type update error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to update billing type"),
			);
		}
	};
}

/** Local "YYYY-MM-DD" of today (zero-padded; renewal dates are local-calendar). */
function localTodayDate(): string {
	const d = new Date();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Create an account renewal date update handler.
 * Stores a manually-entered subscription renewal anchor date, cadence, and
 * optional price (`renewalPriceUsd`, USD float → stored as integer micros).
 * Sending renewalAnchor: null (or empty) clears everything (cadence, price,
 * auto-start all NULL).
 *
 * `renewal_auto_start_date` transitions (the auto-recorder's lower bound, so
 * it never invents history):
 *  - price unset → set: stamp today (auto-recording starts now)
 *  - price set → set (changed or not): keep the existing auto-start
 *  - price → null: clear the auto-start
 */
export function createAccountRenewalUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			const cadence = validateString(body.renewalCadence, "renewalCadence", {
				required: true,
				allowedValues: ["monthly", "yearly", "none"],
			});

			if (cadence === undefined) {
				return errorResponse(
					BadRequest("renewalCadence must be 'monthly', 'yearly', or 'none'"),
				);
			}

			// Validate renewalAnchor: may be null/empty (clears) or a real YYYY-MM-DD date.
			let anchor: string | null;
			if (body.renewalAnchor == null || body.renewalAnchor === "") {
				anchor = null;
			} else {
				const raw =
					typeof body.renewalAnchor === "string"
						? body.renewalAnchor.trim()
						: "";
				const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
				if (!match) {
					return errorResponse(
						BadRequest("renewalAnchor must be a YYYY-MM-DD date or null"),
					);
				}
				const y = Number(match[1]);
				const m = Number(match[2]);
				const d = Number(match[3]);
				const parsed = new Date(Date.UTC(y, m - 1, d));
				const isRealDate =
					parsed.getUTCFullYear() === y &&
					parsed.getUTCMonth() === m - 1 &&
					parsed.getUTCDate() === d;
				if (!isRealDate) {
					return errorResponse(
						BadRequest("renewalAnchor must be a YYYY-MM-DD date or null"),
					);
				}
				anchor = raw;
			}

			// No anchor means no cadence — don't store a dangling cadence.
			const storedCadence = anchor === null ? null : cadence;

			// Validate renewalPriceUsd: optional; null/""/undefined means "no
			// price"; otherwise must be a finite number > 0.
			let priceUsd: number | null;
			if (body.renewalPriceUsd == null || body.renewalPriceUsd === "") {
				priceUsd = null;
			} else if (
				typeof body.renewalPriceUsd !== "number" ||
				!Number.isFinite(body.renewalPriceUsd) ||
				body.renewalPriceUsd <= 0
			) {
				return errorResponse(
					BadRequest("renewalPriceUsd must be a positive number or null"),
				);
			} else {
				priceUsd = body.renewalPriceUsd;
			}

			// Check if account exists (and fetch the current price/auto-start to
			// drive the auto-start transition rules).
			const db = dbOps.getAdapter();
			const account = await db.get<{
				name: string;
				renewal_price_usd_micros: number | null;
				renewal_auto_start_date: string | null;
			}>(
				`SELECT name, renewal_price_usd_micros, renewal_auto_start_date
				 FROM accounts WHERE id = ?`,
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// anchor null clears everything; price null clears the auto-start; a
			// newly-set price stamps today; a kept/changed price keeps the
			// existing auto-start (defensively falling back to today if it was
			// somehow never stamped — mirrors the auto-recorder's fallback).
			let storedPriceMicros: number | null = null;
			let storedAutoStart: string | null = null;
			if (anchor !== null && priceUsd !== null) {
				storedPriceMicros = usdToMicros(priceUsd);
				storedAutoStart =
					account.renewal_price_usd_micros != null
						? (account.renewal_auto_start_date ?? localTodayDate())
						: localTodayDate();
			}

			await dbOps.setAccountRenewal(
				accountId,
				anchor,
				storedCadence,
				storedPriceMicros,
				storedAutoStart,
			);

			// Renewal price/cadence feed the payments-summary amortization math;
			// drop the cached summary so the UI's refetch reflects this change.
			invalidateDashboardCache("payments-summary");

			return jsonResponse({
				success: true,
				message:
					anchor === null
						? `Renewal date cleared for account '${account.name}'`
						: `Renewal date set to '${anchor}' (${storedCadence}) for account '${account.name}'`,
				renewalAnchor: anchor,
				renewalCadence: storedCadence,
				renewalPriceUsd:
					storedPriceMicros != null ? microsToUsd(storedPriceMicros) : null,
			});
		} catch (error) {
			log.error("Account renewal update error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to update renewal date"),
			);
		}
	};
}

/**
 * Create an account auto-refresh toggle handler
 */
export function createAccountAutoRefreshHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate enabled parameter
			const enabled = validateNumber(body.enabled, "enabled", {
				required: true,
				allowedValues: [0, 1] as const,
			});

			if (enabled === undefined) {
				return errorResponse(BadRequest("Enabled field is required (0 or 1)"));
			}

			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if account provider supports auto-refresh (session-window based providers)
			if (
				account.provider !== "anthropic" &&
				account.provider !== "codex" &&
				account.provider !== "zai"
			) {
				return errorResponse(
					BadRequest(
						"Auto-refresh is only available for Anthropic, Codex, and Zai accounts",
					),
				);
			}

			// Update auto-refresh setting
			await db.run(
				"UPDATE accounts SET auto_refresh_enabled = ? WHERE id = ?",
				[enabled, accountId],
			);

			const action = enabled === 1 ? "enabled" : "disabled";

			return jsonResponse({
				success: true,
				message: `Auto-refresh ${action} for account '${account.name}'`,
				autoRefreshEnabled: enabled === 1,
			});
		} catch (error) {
			log.error("Account auto-refresh toggle error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to toggle auto-refresh"),
			);
		}
	};
}

/**
 * Create an account custom endpoint update handler
 */
export function createAccountCustomEndpointUpdateHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate custom endpoint
			const customEndpoint = validateString(
				body.customEndpoint,
				"customEndpoint",
				{
					required: false,
					transform: (value: string) => {
						if (!value) return "";
						const trimmed = value.trim();
						if (!trimmed) return "";
						// Validate URL format
						try {
							new URL(trimmed);
							return trimmed;
						} catch {
							throw new Error("Invalid URL format");
						}
					},
				},
			);

			// Update account custom endpoint
			await dbOps
				.getAdapter()
				.run("UPDATE accounts SET custom_endpoint = ? WHERE id = ?", [
					customEndpoint || null,
					accountId,
				]);

			log.info(`Updated custom endpoint for account ${accountId}`);

			return jsonResponse({
				success: true,
				message: "Custom endpoint updated successfully",
			});
		} catch (error) {
			log.error("Account custom endpoint update error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to update custom endpoint"),
			);
		}
	};
}

/**
 * Create an account model mappings update handler
 */
export function createAccountModelMappingsUpdateHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Get account to verify it supports model mappings
			const db = dbOps.getAdapter();
			const account = await db.get<{
				provider: string;
				custom_endpoint: string | null;
			}>("SELECT provider, custom_endpoint FROM accounts WHERE id = ?", [
				accountId,
			]);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Handle model mappings update
			const modelMappings = body.modelMappings || {};

			// Validate model mappings - values can be string or string[]
			if (typeof modelMappings !== "object" || Array.isArray(modelMappings)) {
				return errorResponse(BadRequest("Model mappings must be an object"));
			}

			for (const [_key, value] of Object.entries(modelMappings)) {
				if (typeof value === "string") {
					if (!value.trim()) {
						return errorResponse(
							BadRequest(
								`Model mapping value for key '${_key}' must not be empty`,
							),
						);
					}
				} else if (Array.isArray(value)) {
					if (value.length === 0) {
						return errorResponse(
							BadRequest(
								`Model mapping array for key '${_key}' must not be empty`,
							),
						);
					}
					for (const item of value) {
						if (typeof item !== "string" || !item.trim()) {
							return errorResponse(
								BadRequest(
									`All model mapping array values for key '${_key}' must be non-empty strings`,
								),
							);
						}
					}
				} else {
					return errorResponse(
						BadRequest(
							"Model mapping values must be strings or arrays of strings",
						),
					);
				}
			}

			// Build the new model mappings as a full replacement (not a merge).
			// This ensures that sending an empty {} correctly clears all mappings.
			const mergedModelMappings: Record<string, string | string[]> = {};

			for (const [modelType, modelValue] of Object.entries(modelMappings)) {
				if (typeof modelValue === "string") {
					if (modelValue.trim()) {
						mergedModelMappings[modelType] = modelValue.trim();
					}
				} else if (Array.isArray(modelValue)) {
					const trimmed = modelValue
						.map((v) => (typeof v === "string" ? v.trim() : ""))
						.filter(Boolean);
					if (trimmed.length > 0) {
						mergedModelMappings[modelType] =
							trimmed.length === 1 ? trimmed[0] : trimmed;
					}
				}
			}

			// Update the model_mappings field
			const finalModelMappings =
				Object.keys(mergedModelMappings).length > 0
					? JSON.stringify(mergedModelMappings)
					: null;

			await db.run("UPDATE accounts SET model_mappings = ? WHERE id = ?", [
				finalModelMappings,
				accountId,
			]);

			log.info(`Updated model mappings for account ${accountId}`);

			return jsonResponse({
				success: true,
				message: "Model mappings updated successfully",
				modelMappings: mergedModelMappings,
			});
		} catch (error) {
			log.error("Account model mappings update error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to update model mappings"),
			);
		}
	};
}

/**
 * Create an account model fallbacks update handler.
 * @deprecated Fallbacks are now merged into model_mappings as arrays.
 * This handler appends fallback models to existing model_mappings arrays.
 */
export function createAccountModelFallbacksUpdateHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			const db = dbOps.getAdapter();
			const account = await db.get<{ id: string }>(
				"SELECT id FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Validate fallbacks input
			const modelFallbacks = body.modelFallbacks || {};
			if (typeof modelFallbacks !== "object" || Array.isArray(modelFallbacks)) {
				return errorResponse(BadRequest("Model fallbacks must be an object"));
			}
			for (const [_key, value] of Object.entries(modelFallbacks)) {
				if (typeof value !== "string" || !value.trim()) {
					return errorResponse(
						BadRequest("All model fallback values must be non-empty strings"),
					);
				}
			}

			// Get existing model_mappings and merge fallbacks into them
			let existingMappings: Record<string, string | string[]> = {};
			const result = await db.get<{ model_mappings: string | null }>(
				"SELECT model_mappings FROM accounts WHERE id = ?",
				[accountId],
			);

			if (result?.model_mappings) {
				try {
					const parsed = JSON.parse(result.model_mappings);
					existingMappings = parsed.modelMappings || parsed || {};
				} catch {
					existingMappings = {};
				}
			}

			// Merge: for each fallback, append to existing mapping array
			for (const [modelType, fallbackValue] of Object.entries(modelFallbacks)) {
				const existing = existingMappings[modelType];
				const fallback = (fallbackValue as string).trim();

				if (typeof existing === "string") {
					// Promote single string to array with fallback appended
					existingMappings[modelType] = [existing, fallback];
				} else if (Array.isArray(existing)) {
					if (!existing.includes(fallback)) {
						existingMappings[modelType] = [...existing, fallback];
					}
				} else {
					existingMappings[modelType] = fallback;
				}
			}

			const finalMappings =
				Object.keys(existingMappings).length > 0
					? JSON.stringify(existingMappings)
					: null;

			await db.run(
				"UPDATE accounts SET model_mappings = ?, model_fallbacks = NULL WHERE id = ?",
				[finalMappings, accountId],
			);

			log.info(
				`Merged model fallbacks into model_mappings for account ${accountId}`,
			);

			return jsonResponse({
				success: true,
				message: "Model fallbacks merged into model mappings",
				modelMappings: existingMappings,
			});
		} catch (error) {
			log.error("Account model fallbacks update error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to update model fallbacks"),
			);
		}
	};
}

/**
 * Create an account force-reset rate limit handler
 * Clears account lock fields, provider overload cooldown, and triggers
 * immediate usage refresh when possible.
 */
export function createAccountForceResetRateLimitHandler(
	dbOps: DatabaseOperations,
) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const db = dbOps.getAdapter();
			const account = await db.get<{
				id: string;
				name: string;
				provider: string | null;
				access_token: string | null;
			}>("SELECT id, name, provider, access_token FROM accounts WHERE id = ?", [
				accountId,
			]);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const resetSuccess = await dbOps.forceResetAccountRateLimit(accountId);
			if (!resetSuccess) {
				return errorResponse(
					new Error(
						`Failed to reset rate limit state for account '${account.name}'`,
					),
				);
			}
			const provider = account.provider || "anthropic";
			clearProviderOverloadCooldown(provider);
			clearAccountRefreshCache(accountId);

			// Trigger immediate poll if this server has a polling token provider for the account.
			let usagePollTriggered = await usageCache.refreshNow(accountId);

			// Best-effort fallback: use raw DB token for Anthropic OAuth accounts.
			// Only Anthropic accounts support direct usage fetch via fetchUsageData();
			// other providers (e.g. Zai) use different endpoints handled by their own fetchers.
			// This bypasses token refresh, but is acceptable since this path only runs when
			// no active polling exists and the token is likely fresh from recent proxy requests.
			if (
				!usagePollTriggered &&
				provider === "anthropic" &&
				account.access_token
			) {
				const { data: usageData } = await fetchUsageData(account.access_token);
				if (usageData) {
					usageCache.set(account.id, usageData);
					usagePollTriggered = true;
				}
			}

			log.info(
				`Force-reset rate limit for account '${account.name}' (usage poll triggered: ${usagePollTriggered})`,
			);

			return jsonResponse({
				success: true,
				message: `Rate limit state cleared for account '${account.name}'`,
				usagePollTriggered,
			});
		} catch (error) {
			log.error("Account force-reset rate limit error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to force reset account rate limit"),
			);
		}
	};
}

/**
 * Create an account reload handler
 * Clears refresh cache for an account after re-authentication
 */
export function createAccountReloadHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if account is Anthropic provider (only OAuth accounts need token reload)
			if (account.provider !== "anthropic") {
				return errorResponse(
					BadRequest("Token reload is only available for Anthropic accounts"),
				);
			}

			// Clear refresh cache for this account
			clearAccountRefreshCache(accountId);

			// Clear usage cache for this account to prevent memory leaks
			usageCache.delete(accountId);

			log.info(`Token reload triggered for account '${account.name}'`);

			return jsonResponse({
				success: true,
				message: `Token reload triggered for account '${account.name}'. The next request will use the updated tokens from the database.`,
			});
		} catch (error) {
			log.error("Account reload error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to reload account tokens"),
			);
		}
	};
}

/**
 * Create a Kilo Gateway account add handler
 */
export function createAccountRefreshUsageHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = await dbOps.getAccount(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (account.provider !== "anthropic" && account.provider !== "codex") {
				return errorResponse(
					BadRequest(
						"Usage refresh is only available for Anthropic OAuth and Codex accounts",
					),
				);
			}

			if (!account.access_token && !account.refresh_token) {
				return errorResponse(
					BadRequest(
						`Account '${account.name}' has no tokens - please re-authenticate`,
					),
				);
			}

			if (account.provider === "codex") {
				const outcome = await refreshCodexUsageForAccount(accountId);
				log.info(
					`Codex usage refresh requested for account '${account.name}' (success: ${outcome.success})`,
				);
				return jsonResponse({
					success: outcome.success,
					message: outcome.message,
					pollingRestarted: false,
				});
			}

			clearAccountRefreshCache(accountId);
			const pollingRestarted = await restartUsagePollingForAccount(accountId);
			const cacheRefreshed = await usageCache.refreshNow(accountId);

			log.info(
				`Usage refresh requested for account '${account.name}' (polling restarted: ${pollingRestarted}, cache refreshed: ${cacheRefreshed})`,
			);

			return jsonResponse({
				success: true,
				message: pollingRestarted
					? `Usage polling restarted for account '${account.name}'. Fresh usage data is now available.`
					: cacheRefreshed
						? `Usage cache refreshed for account '${account.name}'.`
						: `Polling could not be restarted for account '${account.name}' — usage data may not update.`,
				pollingRestarted,
				cacheRefreshed,
			});
		} catch (error) {
			log.error("Account refresh usage error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to refresh usage data"),
			);
		}
	};
}

/**
 * Consume one earned Codex rate-limit reset credit.
 *
 * Both consume paths go through this endpoint's dispatch: the dashboard's
 * "Apply now" button (in the reset-credit chip popover) calls it directly, and
 * the auto-apply scheduler (`CodexResetCreditApplyScheduler`) uses the same
 * underlying `consumeCodexResetCreditForAccount` registry dispatch.
 * The caller owns the idempotency key and must reuse it when retrying.
 */
export function createAccountConsumeRateLimitResetCreditHandler(
	dbOps: DatabaseOperations,
	consume: typeof consumeCodexResetCreditForAccount = consumeCodexResetCreditForAccount,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body: unknown = await req.json();
			if (!body || typeof body !== "object" || Array.isArray(body)) {
				return errorResponse(BadRequest("Request body must be a JSON object"));
			}
			const input = body as Record<string, unknown>;
			const idempotencyKey =
				typeof input.idempotencyKey === "string"
					? input.idempotencyKey.trim()
					: "";
			if (!idempotencyKey) {
				return errorResponse(
					BadRequest("idempotencyKey must be a non-empty string"),
				);
			}
			if (idempotencyKey.length > 256) {
				return errorResponse(
					BadRequest("idempotencyKey must be at most 256 characters"),
				);
			}

			let creditId: string | null = null;
			if (input.creditId !== undefined && input.creditId !== null) {
				creditId =
					typeof input.creditId === "string" ? input.creditId.trim() : "";
				if (!creditId) {
					return errorResponse(
						BadRequest("creditId must be a non-empty string when provided"),
					);
				}
				if (creditId.length > 512) {
					return errorResponse(
						BadRequest("creditId must be at most 512 characters"),
					);
				}
			}

			const account = await dbOps.getAccount(accountId);
			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}
			if (account.provider !== "codex") {
				return errorResponse(
					BadRequest(
						"Rate-limit reset credits are only available for Codex accounts",
					),
				);
			}
			if (!account.access_token && !account.refresh_token) {
				return errorResponse(
					BadRequest(
						`Account '${account.name}' has no tokens - please re-authenticate`,
					),
				);
			}

			const consumeRequest: CodexRateLimitResetCreditConsumeRequest = {
				idempotencyKey,
				...(creditId ? { creditId } : {}),
			};
			const dispatched = await consume(accountId, consumeRequest);
			if (dispatched.status === "failed") {
				return errorResponse(InternalServerError(dispatched.message));
			}

			const { result } = dispatched;
			const success =
				result.outcome === "reset" || result.outcome === "alreadyRedeemed";
			const message = (() => {
				switch (result.outcome) {
					case "reset":
						return `Usage limits reset for account '${dispatched.accountName}'.`;
					case "alreadyRedeemed":
						return `This reset attempt already completed for account '${dispatched.accountName}'.`;
					case "nothingToReset":
						return `Account '${dispatched.accountName}' has no eligible usage window to reset.`;
					case "noCredit":
						return `Account '${dispatched.accountName}' has no usage reset credits available.`;
				}
			})();
			const response: CodexRateLimitResetCreditConsumeResponse = {
				success,
				message,
				...result,
				resetMetadataRefreshed: dispatched.resetMetadataRefreshed,
				availableResetCount: dispatched.availableResetCount,
				localRateLimitStateCleared: dispatched.localRateLimitStateCleared,
			};

			log.info(
				`Codex reset-credit consume requested for account '${account.name}' (outcome: ${result.outcome})`,
			);
			return jsonResponse(response);
		} catch (error) {
			log.error("Account consume rate-limit reset credit error:", error);
			if (error instanceof SyntaxError) {
				return errorResponse(BadRequest("Request body must be valid JSON"));
			}
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to consume rate-limit reset credit"),
			);
		}
	};
}

/**
 * Create an account auto-apply reset-credits toggle handler (Codex accounts
 * only). Opt-in: when enabled, expiring Codex usage reset credits are consumed
 * automatically instead of silently lapsing.
 */
export function createAccountAutoApplyResetCreditsHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate enabled parameter
			const enabled = validateNumber(body.enabled, "enabled", {
				required: true,
				allowedValues: [0, 1] as const,
			});

			if (enabled === undefined) {
				return errorResponse(BadRequest("Enabled field is required (0 or 1)"));
			}

			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Only codex accounts earn usage reset credits
			if (account.provider !== "codex") {
				return errorResponse(
					BadRequest(
						"Auto-apply of reset credits is only available for Codex accounts",
					),
				);
			}

			// Update auto-apply setting
			await dbOps.setCodexAutoApplyResetCreditsEnabled(
				accountId,
				enabled === 1,
			);

			const action = enabled === 1 ? "enabled" : "disabled";

			return jsonResponse({
				success: true,
				message: `Auto-apply of reset credits ${action} for account '${account.name}'`,
				autoApplyResetCreditsEnabled: enabled === 1,
			});
		} catch (error) {
			log.error("Account auto-apply-reset-credits toggle error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to toggle auto-apply-reset-credits"),
			);
		}
	};
}

/**
 * Create an account auto-apply-on-weekly-limit toggle handler (Codex accounts
 * only). Opt-in: when enabled, a usage-limit reset credit is consumed
 * automatically as soon as the account hits its weekly limit, instead of only
 * when a credit is about to expire.
 */
export function createAccountAutoApplyResetOnWeeklyLimitHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate enabled parameter
			const enabled = validateNumber(body.enabled, "enabled", {
				required: true,
				allowedValues: [0, 1] as const,
			});

			if (enabled === undefined) {
				return errorResponse(BadRequest("Enabled field is required (0 or 1)"));
			}

			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Only codex accounts earn usage reset credits
			if (account.provider !== "codex") {
				return errorResponse(
					BadRequest(
						"Auto-apply of reset credits is only available for Codex accounts",
					),
				);
			}

			// Update auto-apply-on-weekly-limit setting
			await dbOps.setCodexAutoApplyResetOnWeeklyLimitEnabled(
				accountId,
				enabled === 1,
			);

			const action = enabled === 1 ? "enabled" : "disabled";

			return jsonResponse({
				success: true,
				message: `Auto-apply of reset credits at the weekly limit ${action} for account '${account.name}'`,
				autoApplyResetOnWeeklyLimitEnabled: enabled === 1,
			});
		} catch (error) {
			log.error(
				"Account auto-apply-reset-on-weekly-limit toggle error:",
				error,
			);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to toggle auto-apply-reset-on-weekly-limit"),
			);
		}
	};
}

const RESET_CREDIT_EVENTS_DEFAULT_LIMIT = 20;
const RESET_CREDIT_EVENTS_MAX_LIMIT = 100;

/**
 * List recent reset-credit ledger events for a Codex account, newest first.
 * The repository already orders by recency; this handler only maps rows to the
 * API boundary shape (ISO timestamps, camelCase, no idempotency key).
 */
export function createAccountResetCreditEventsHandler(
	dbOps: DatabaseOperations,
) {
	return async (url: URL, accountId: string): Promise<Response> => {
		try {
			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (account.provider !== "codex") {
				return errorResponse(
					BadRequest(
						"Rate-limit reset credits are only available for Codex accounts",
					),
				);
			}

			// Clamp like the other list endpoints (see createRequestsDetailHandler):
			// non-numeric falls back to the default, numeric is clamped to [1, 100].
			const limitParam = url.searchParams.get("limit");
			const parsedLimit = limitParam !== null ? Number(limitParam) : Number.NaN;
			const limit = Number.isFinite(parsedLimit)
				? Math.min(
						Math.max(Math.trunc(parsedLimit), 1),
						RESET_CREDIT_EVENTS_MAX_LIMIT,
					)
				: RESET_CREDIT_EVENTS_DEFAULT_LIMIT;

			const rows = await dbOps.getRecentCodexResetCreditEvents(
				accountId,
				limit,
			);
			const events: CodexResetCreditEventResponse[] = rows.map(
				(row: CodexResetCreditEventRow) => ({
					id: row.id,
					creditId: row.credit_id,
					trigger: row.trigger === "auto" ? "auto" : "manual",
					cause:
						row.cause === "expiry" || row.cause === "weekly-limit"
							? row.cause
							: null,
					attemptSeq: row.attempt_seq,
					status: row.status as CodexResetCreditEventStatus,
					windowsReset: row.windows_reset,
					errorMessage: row.error_message,
					// The ledger snapshots expiry in unix SECONDS (null = never expires)
					creditExpiresAt:
						row.credit_expires_at == null
							? null
							: new Date(row.credit_expires_at * 1_000).toISOString(),
					createdAt: new Date(row.created_at).toISOString(),
					resolvedAt:
						row.resolved_at == null
							? null
							: new Date(row.resolved_at).toISOString(),
				}),
			);

			return jsonResponse({ events });
		} catch (error) {
			log.error("Account reset-credit events error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to list reset-credit events"),
			);
		}
	};
}
