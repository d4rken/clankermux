import type { Config } from "@clankermux/config";
import {
	accountWideExhaustion,
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	isAccountAvailable,
	normalizeAnthropicUsage,
	PAUSE_REASON_NEEDS_REAUTH,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
} from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import { USAGE_CACHE_TTL_MS, usageCache } from "@clankermux/providers";
import {
	DEFAULT_ROUTING_CONTEXT,
	earliestExclusionRecoveryMs,
	evaluateDefaultCandidates,
	getProviderOverloadSnapshot,
} from "@clankermux/proxy";
import type {
	Account,
	AnthropicUsageData,
	LoadBalancingStrategy,
	RateLimitCause,
	UsagePrediction,
} from "@clankermux/types";
import { resolveRateLimitPresentation } from "../handlers/accounts";
import { buildPredictionsForAccounts } from "./build-account-predictions-for";

const log = new Logger("PublicSnapshot");

/**
 * Whether a provider reports the account-wide quota windows at all.
 *
 * The sets are core's, shared with the runway scan, so "this provider has no
 * such window" is decided in exactly one place. A provider in NEITHER set
 * (ollama, a pay-as-you-go key) has no measurement to be missing or stale — it
 * is `not_applicable`, which is a different answer from "we could not read it".
 */
function hasFiveHourWindow(provider: string): boolean {
	return FIVE_HOUR_ELIGIBLE_PROVIDERS.has(provider);
}
function hasSevenDayWindow(provider: string): boolean {
	return SEVEN_DAY_ELIGIBLE_PROVIDERS.has(provider);
}
function isMetered(provider: string): boolean {
	return hasFiveHourWindow(provider) || hasSevenDayWindow(provider);
}

/**
 * One quota window on an account, MEASURED and PREDICTED together.
 *
 * They live in one record because they describe the same window and change
 * together: a reading and the projection built from that reading are one
 * observation of one thing, and separating them lets a client pair a fresh
 * percentage with a projection computed from an older one.
 */
export interface PublicWindowSnapshot {
	/**
	 * The window class, in the INTERNAL vocabulary. Mapped to the public enum
	 * (with its `other` escape hatch) by the DTO layer.
	 */
	kind: string;
	/**
	 * Stable key for a SCOPED window — the model family for a per-family weekly
	 * limit. Null for the account-wide windows, which need no discriminator
	 * beyond `kind`.
	 */
	scopeId: string | null;
	/** Display text. Never a key: two accounts may label one scope differently. */
	label: string | null;
	utilizationPct: number | null;
	/** When the reading behind `utilizationPct` was observed. */
	observedAtMs: number | null;
	resetsAtMs: number | null;
	/**
	 * The server regression for this window, or null when there is none. Only
	 * the two account-wide windows have an estimator today.
	 */
	prediction: UsagePrediction | null;
}

/**
 * How well this account's usage is currently MEASURED — the fact the old
 * boolean `stale` conflated three ways.
 *
 *  - `fresh` — a reading inside the routing freshness bar.
 *  - `stale` — a reading we still serve, past that bar. Real data with an age.
 *  - `missing` — a metered account with no reading at all (or one so old the
 *    cache no longer serves it).
 *  - `not_applicable` — the provider reports no account-wide window, so there
 *    is nothing that could be measured.
 */
export type PublicMeasurementState =
	| "fresh"
	| "stale"
	| "missing"
	| "not_applicable";

/**
 * The state of the account's stored credential, on an axis ORTHOGONAL to
 * availability.
 *
 * Kept separate because collapsing the two destroys the distinction the applet
 * renders: an expired access token next to a live refresh token is a
 * self-healing condition the proxy fixes on the next request, an invalid
 * refresh token needs a human at a browser, and neither is meaningful for an
 * API-key provider, which has no token lifecycle at all.
 */
export type PublicCredentialState =
	/** Access token present and not past its expiry. */
	| "valid"
	/** Access token expired (or absent) with a live refresh token behind it. */
	| "refreshable"
	/** Access token expired and nothing can renew it without a human. */
	| "expired"
	/** The refresh token was REJECTED upstream — needs an interactive re-auth. */
	| "invalid"
	/** No credential stored at all. */
	| "missing"
	/** An API-key credential: no expiry, no refresh, nothing to report. */
	| "not_applicable";

/** One account, reduced to what a widget can render. */
export interface PublicAccountSnapshot {
	id: string;
	name: string;
	provider: string;
	/**
	 * True for the ONE account a fresh, unpinned, nominal-size request would be
	 * routed to right now. See {@link PublicRoutingSnapshot} for why that is not
	 * "the account the load balancer is using".
	 */
	isDefaultCandidate: boolean;
	paused: boolean;
	pauseReason: string | null;
	/** The resolved rate-limit cause, before it is mapped to the public enum. */
	cause: RateLimitCause;
	/** When the current block is scheduled to lift; null when nothing does. */
	availableAtMs: number | null;
	credentialState: PublicCredentialState;
	/** The ACCESS token's expiry — the instant `credentialState` turns over. */
	credentialExpiresAtMs: number | null;
	measurementState: PublicMeasurementState;
	/** When the reading every window below came from was observed. */
	usageObservedAtMs: number | null;
	/**
	 * DERIVED rollup: the max utilization across the account-wide windows. Both
	 * clients render an overall gauge, so it is served rather than made every
	 * consumer recompute it — but it is not a separate fact, and a client that
	 * needs to know WHICH window is worst must read `windows`.
	 */
	utilizationPct: number | null;
	windows: PublicWindowSnapshot[];
}

/** Pool rollup. */
export interface PublicPoolSnapshot {
	configured: number;
	/**
	 * Accounts a fresh, unpinned, nominal-size request could be routed to —
	 * the SAME routing context `routing.defaultCandidateAccountId` names. Defined
	 * against that context deliberately: a count derived from some other notion
	 * of "routable" would disagree with the candidate beside it, and a client has
	 * no way to tell which of the two it should believe.
	 */
	defaultRoutable: number;
	paused: number;
	rateLimited: number;
	usageExhausted: number;
	/**
	 * The soonest instant anything currently blocked is scheduled to come back:
	 * a stored cooldown, a spent quota window's reset, or one of the gates the
	 * candidate evaluation applies (the provider-wide overload breaker, the
	 * proactive usage throttle). Null only when nothing blocked is waiting on a
	 * clock.
	 *
	 * It has to cover the SAME gates `defaultRoutable` applies, because the two
	 * are read together: `defaultRoutable: 0` with a null instant is what a
	 * client renders as `unhealthy`, and an overloaded pool that recovers in two
	 * minutes is `degraded`.
	 */
	nextAvailableAtMs: number | null;
}

/** Which routing question the published candidate answers. */
export interface PublicRoutingSnapshot {
	/**
	 * Always {@link DEFAULT_ROUTING_CONTEXT}. Stated on the wire because there is
	 * NO global "current load-balancer account": routing is per request, and the
	 * prediction below deliberately omits every request-dependent gate (API-key
	 * pins, model family, prompt size, conversation affinity, family-scoped
	 * overload). Publishing the candidate without the context invites a client to
	 * render it as a fact about the system rather than an answer to a question.
	 */
	context: typeof DEFAULT_ROUTING_CONTEXT;
	defaultCandidateAccountId: string | null;
}

/**
 * A pooled aggregate over ONE window class.
 *
 * The counts travel with the mean because the mean is not interpretable
 * without them: an average over two of nine accounts is a different claim from
 * the same number over nine of nine, and the deployed shape published only the
 * number.
 */
export interface PublicWindowAggregate {
	/**
	 * UNWEIGHTED ARITHMETIC MEAN over the accounts that reported the window.
	 * Named for what it is: it is not a pool utilization, because accounts do not
	 * have equal capacity and a paused or stale account still contributes.
	 */
	meanUtilizationPct: number | null;
	/** Accounts that supplied a reading for this window. */
	contributingAccountCount: number;
	/**
	 * Every account that did NOT. Deliberately one bucket: from the pool's point
	 * of view "its reading is missing" and "its provider has no such window" are
	 * the same statement — this account tells us nothing about this window — and
	 * the two counts together therefore cover every account in scope.
	 */
	unknownAccountCount: number;
	/**
	 * The EARLIEST reset among the contributing accounts. Never a mean of reset
	 * instants: the mean of two reset times is an instant at which nothing
	 * happens, and the only useful pooled answer is when the first window turns
	 * over.
	 */
	earliestResetsAtMs: number | null;
}

/** Cross-account usage aggregate, per window class. */
export interface PublicUsageAggregate {
	fiveHour: PublicWindowAggregate;
	sevenDay: PublicWindowAggregate;
	/** The worst single account's derived utilization. */
	worstAccountUtilizationPct: number | null;
}

/** A pooled aggregate over one SCOPED window, e.g. one model family's weekly. */
export interface PublicScopedLimitAggregate extends PublicWindowAggregate {
	/** Stable key, joinable against `accounts[].windows[].scopeId`. */
	scopeId: string;
	label: string | null;
}

/**
 * The overload breaker's state for one provider.
 *
 * A STATE plus a deadline, not a bare deadline: a half-open breaker has no
 * `until` at all (its cooldown has elapsed and it is waiting on a probe) yet it
 * is emphatically not closed, so a flat timestamp reports the one interesting
 * case as "fine".
 */
export interface PublicOverloadSnapshot {
	/** The internal breaker state, mapped to the public enum by the DTO layer. */
	state: string;
	untilMs: number | null;
	probeActive: boolean;
}

/**
 * Provider-level facts, homed on the PROVIDER.
 *
 * Overload is a property of the upstream, not of an account: the deployed shape
 * copied the same two deadlines onto every account of a provider, which made
 * one fact look like N facts and left a client averaging or de-duplicating them
 * to recover the original.
 */
export interface PublicProviderSnapshot {
	provider: string;
	/** Worst state across ALL of this provider's buckets, family ones included. */
	anyOverload: PublicOverloadSnapshot;
	/** The provider-WIDE bucket alone, which gates every model family at once. */
	providerWideOverload: PublicOverloadSnapshot;
	/**
	 * Per-scope pooled aggregates, computed HERE rather than by each client.
	 *
	 * The percentages behind these may derive from different plan capacities —
	 * a Max-20 account and a Pro account both report "62%" of quotas that are not
	 * the same size — so the mean is a mean of PERCENTAGES and never a statement
	 * about how much work the pool can still do.
	 */
	scopedLimits: PublicScopedLimitAggregate[];
}

/** Everything the public responses are built from. */
export interface PublicSnapshot {
	nowMs: number;
	pool: PublicPoolSnapshot;
	routing: PublicRoutingSnapshot;
	usage: PublicUsageAggregate;
	providers: PublicProviderSnapshot[];
	/**
	 * Ordered by NAME, ascending, and by nothing else. The order is a stable
	 * display order and carries NO routing meaning — the routing answer is
	 * `isDefaultCandidate` and `routing.defaultCandidateAccountId`, both of which
	 * say so explicitly rather than hiding in an array index.
	 */
	accounts: PublicAccountSnapshot[];
}

/**
 * Clamp a reported utilization into the 0..100 the wire contract promises.
 *
 * Providers do emit values outside it (over-100 during an overage, and a
 * non-finite value when a payload is malformed). A device that treats the
 * number as a bar width has no way to render either, so NaN/Infinity collapse
 * to null ("unknown") and out-of-range values are clamped rather than dropped —
 * 103% used is still "full", and reporting null there would read as "no data".
 */
export function clampPct(value: number | null | undefined): number | null {
	if (value == null || typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	const clamped = Math.min(100, Math.max(0, value));
	// One decimal: enough for a bar, short enough not to inflate the payload.
	return Math.round(clamped * 10) / 10;
}

function parseResetMs(resetsAt: string | null | undefined): number | null {
	if (!resetsAt) return null;
	const ms = Date.parse(resetsAt);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Every quota window this account has, in one vocabulary.
 *
 * Replaces the deployed shape's three representations of one observation (the
 * flat `fiveHourPct`/`sevenDayPct` pair, the parallel `*ResetsAt` pair and a
 * `limits[]` array in a second vocabulary). One entry per window, and the
 * MEASUREMENT and the PREDICTION for that window sit together in it.
 *
 * An account-wide window is emitted whenever the PROVIDER has it, with a null
 * utilization when it could not be read — so an absent `five_hour` entry means
 * "this provider has no 5-hour window", never "we could not read it". The
 * scoped entries are the opposite: they exist only when the provider reported
 * them, because nothing enumerates the families an account is entitled to.
 */
function buildWindows(
	provider: string,
	usage: AnthropicUsageData | null,
	observedAtMs: number | null,
	prediction: { fiveHour?: UsagePrediction; sevenDay?: UsagePrediction } | null,
	now: number,
): PublicWindowSnapshot[] {
	if (!isMetered(provider)) return [];
	const normalized = normalizeAnthropicUsage(usage, now);
	const windows: PublicWindowSnapshot[] = [];

	if (hasFiveHourWindow(provider)) {
		windows.push({
			kind: "five_hour",
			scopeId: null,
			label: "5-hour",
			utilizationPct: clampPct(normalized.session?.utilization ?? null),
			observedAtMs,
			resetsAtMs: normalized.session?.resetMs ?? null,
			prediction: servablePrediction(prediction?.fiveHour),
		});
	}
	if (hasSevenDayWindow(provider)) {
		windows.push({
			kind: "seven_day",
			scopeId: null,
			label: "Weekly",
			utilizationPct: clampPct(normalized.weeklyAll?.utilization ?? null),
			observedAtMs,
			resetsAtMs: normalized.weeklyAll?.resetMs ?? null,
			prediction: servablePrediction(prediction?.sevenDay),
		});
	}
	for (const scoped of normalized.weeklyScoped) {
		windows.push({
			kind: "weekly_scoped",
			// The model FAMILY, not the display name: the family is stable across
			// accounts and model renames, and it is what the pooled aggregate keys
			// on. `displayName` is the label beside it and joins nothing.
			scopeId: scoped.family,
			label: scoped.displayName || scoped.family,
			utilizationPct: clampPct(scoped.percent),
			observedAtMs,
			resetsAtMs: scoped.resetsAtMs,
			// No estimator exists per family; the regression covers the two
			// account-wide windows only.
			prediction: null,
		});
	}

	// Anthropic's separate Claude-Code weekly allowance. A real window with no
	// name in the public vocabulary, so it is carried under the `other` kind
	// with a scope id rather than dropped or smuggled in as a second
	// `seven_day` entry, which would make the account-wide window ambiguous.
	//
	// Emitted whenever the provider REPORTED the window, value or no value:
	// `utilization` is nullable, and an observed window whose reading is unknown
	// is a window with a null `utilizationPct` — the same rule the two
	// account-wide windows above follow. Requiring a number here would delete the
	// record entirely, which is exactly the "absent means the provider has no
	// such window" confusion this vocabulary exists to prevent.
	const oauthApps = usage?.seven_day_oauth_apps;
	if (oauthApps) {
		windows.push({
			kind: "seven_day_oauth_apps",
			scopeId: "seven_day_oauth_apps",
			label: "Weekly (Claude Code)",
			utilizationPct: clampPct(oauthApps.utilization),
			observedAtMs,
			resetsAtMs: parseResetMs(oauthApps.resets_at),
			prediction: null,
		});
	}

	return windows;
}

/**
 * A prediction is only served when the estimator actually established a trend.
 * `computeUsagePrediction` returns `slopePerHour: 0` for `insufficient_data`;
 * serving that verbatim would hand a client a zero slope where no slope was
 * measured, which is exactly the null-vs-zero confusion this surface avoids
 * everywhere else. Same rule `/api/runway` applies.
 */
function servablePrediction(
	prediction: UsagePrediction | undefined,
): UsagePrediction | null {
	if (!prediction) return null;
	return prediction.state === "insufficient_data" ? null : prediction;
}

/**
 * Aggregate one window class across a set of accounts.
 *
 * `inScope` is every account the aggregate speaks for, so `contributing +
 * unknown` covers all of them and a client can always tell how much of the pool
 * the mean actually describes.
 */
function aggregateWindow(
	readings: Array<{ utilizationPct: number | null; resetsAtMs: number | null }>,
	inScopeCount: number,
): PublicWindowAggregate {
	const contributing = readings.filter(
		(r): r is { utilizationPct: number; resetsAtMs: number | null } =>
			r.utilizationPct !== null,
	);
	const resets = contributing
		.map((r) => r.resetsAtMs)
		.filter((r): r is number => r !== null);
	return {
		meanUtilizationPct:
			contributing.length === 0
				? null
				: Math.round(
						(contributing.reduce((sum, r) => sum + r.utilizationPct, 0) /
							contributing.length) *
							10,
					) / 10,
		contributingAccountCount: contributing.length,
		unknownAccountCount: inScopeCount - contributing.length,
		earliestResetsAtMs: resets.length === 0 ? null : Math.min(...resets),
	};
}

function maxOfPresent(values: Array<number | null>): number | null {
	const present = values.filter((v): v is number => v !== null);
	return present.length === 0 ? null : Math.max(...present);
}

/**
 * Combine every overload bucket of a provider into one verdict: open beats
 * half-open beats closed, the deadline is the furthest open one, and a probe
 * anywhere counts as a probe.
 *
 * `getProviderOverloadSnapshot` only returns buckets that EXIST — a recovered
 * breaker is deleted — so an empty list is a CLOSED breaker, not an unknown one.
 */
function combineOverload(
	buckets: Array<{ state: string; until: number | null; probeActive: boolean }>,
): PublicOverloadSnapshot {
	let untilMs: number | null = null;
	let halfOpen = false;
	let probeActive = false;
	for (const bucket of buckets) {
		if (bucket.until !== null) {
			untilMs =
				untilMs === null ? bucket.until : Math.max(untilMs, bucket.until);
		} else {
			halfOpen = true;
		}
		if (bucket.probeActive) probeActive = true;
	}
	if (untilMs !== null) return { state: "open", untilMs, probeActive };
	if (halfOpen) return { state: "half-open", untilMs: null, probeActive };
	return { state: "closed", untilMs: null, probeActive: false };
}

/**
 * Classify the stored credential.
 *
 * The one non-obvious input is how an API-key account is recognised: those
 * providers store the key in BOTH the access and refresh columns, so a refresh
 * token equal to the access token is not a refresh token at all. An OAuth
 * account that genuinely has no refresh token has an EMPTY refresh column, and
 * the two must not be conflated — the first has nothing to renew and needs
 * nothing, the second is one expiry away from needing a human.
 */
export function resolveCredentialState(
	row: {
		access_token: string | null;
		refresh_token: string | null;
		expires_at: number | null;
		paused: 0 | 1;
		pause_reason: string | null;
	},
	now: number,
): { state: PublicCredentialState; expiresAtMs: number | null } {
	const accessToken = row.access_token || null;
	const refreshToken = row.refresh_token || null;
	const expiresAtMs =
		row.expires_at != null && Number.isFinite(Number(row.expires_at))
			? Number(row.expires_at)
			: null;

	// The refresh chokepoint pauses the account with this reason when the
	// provider REJECTS the refresh token, so it is the one positive signal that
	// no automatic recovery is possible. It outranks everything below: the
	// access token's own expiry says nothing once nothing can renew it.
	if (row.paused === 1 && row.pause_reason === PAUSE_REASON_NEEDS_REAUTH) {
		return { state: "invalid", expiresAtMs };
	}

	if (!accessToken && !refreshToken) {
		return { state: "missing", expiresAtMs: null };
	}

	// An API-key credential. No lifecycle, so no expiry is reported either — the
	// column often carries a far-future placeholder that would render as a
	// meaningless deadline.
	if (accessToken && refreshToken === accessToken) {
		return { state: "not_applicable", expiresAtMs: null };
	}

	const hasRenewal = refreshToken !== null && refreshToken !== accessToken;
	// No expiry recorded: nothing says the token has stopped working, and
	// claiming otherwise would pause a perfectly good account on the display.
	if (expiresAtMs === null) {
		return { state: accessToken ? "valid" : "refreshable", expiresAtMs: null };
	}
	if (accessToken && expiresAtMs > now) {
		return { state: "valid", expiresAtMs };
	}
	return { state: hasRenewal ? "refreshable" : "expired", expiresAtMs };
}

/** The columns the public read model needs, and no others. */
interface PublicAccountRow {
	id: string;
	name: string;
	provider: string | null;
	paused: 0 | 1;
	pause_reason: string | null;
	priority: number;
	auto_fallback_enabled: 0 | 1;
	session_start: number | null;
	access_token: string | null;
	refresh_token: string | null;
	expires_at: number | null;
	rate_limited_until: number | null;
	rate_limited_reason: string | null;
	rate_limit_reset: number | null;
	rate_limit_status: string | null;
	rate_limited: 0 | 1;
}

/**
 * The read-only snapshot the `/public/v1/status` and `/public/v1/accounts`
 * responses are built from.
 *
 * Two constraints shape this and neither is negotiable:
 *
 *  - NO PROVIDER I/O. A widget GET must never cause an upstream call. The
 *    management accounts handler kicks off background refreshes (Codex reset
 *    credits) and is therefore unusable here; the usage cache is read through
 *    `peekWithAge`, which neither evicts nor refetches, and the routing
 *    prediction reads it through the equally non-evicting `peek`.
 *  - NO SECOND SET OF RULES. Exhaustion, rate-limit presentation, overload
 *    buckets, the routing prediction and the usage regression all come from the
 *    same pure helpers the management and health views use. Reimplementing any
 *    of them here would give a device an answer that quietly disagrees with the
 *    dashboard.
 */
export function createPublicSnapshotReader(
	dbOps: DatabaseOperations,
	config: Pick<
		Config,
		"getUsageThrottlingFiveHourEnabled" | "getUsageThrottlingWeeklyEnabled"
	>,
	/**
	 * The live load-balancing strategy, for the routing prediction. Absent (or
	 * returning null, which it does until startup finishes wiring it) means the
	 * routing context cannot be evaluated at all, and both `defaultRoutable` and
	 * `defaultCandidateAccountId` report that honestly rather than falling back
	 * to some other notion of routable that would disagree with them.
	 */
	getStrategy?: () => LoadBalancingStrategy | null,
) {
	return async (now: number = Date.now()): Promise<PublicSnapshot> => {
		const rows = await dbOps.getAdapter().query<PublicAccountRow>(
			`
				SELECT
					id,
					name,
					provider,
					COALESCE(paused, 0) as paused,
					pause_reason,
					COALESCE(priority, 0) as priority,
					COALESCE(auto_fallback_enabled, 0) as auto_fallback_enabled,
					session_start,
					access_token,
					refresh_token,
					expires_at,
					rate_limited_until,
					rate_limited_reason,
					rate_limit_reset,
					rate_limit_status,
					CASE WHEN rate_limited_until > ? THEN 1 ELSE 0 END as rate_limited
				FROM accounts
				ORDER BY name ASC
			`,
			[now],
		);

		// ONE non-evicting read per account, reused everywhere below, so the whole
		// response describes one consistent moment. `peekWithAge` keeps serving a
		// reading past the routing TTL and reports its true age, which is what lets
		// `measurementState` distinguish an aged reading from a missing one.
		const readings = new Map(
			rows.map((row) => [row.id, usageCache.peekWithAge(row.id)] as const),
		);
		/** The ROUTING-fresh view: anything modelling "now" must use this one. */
		const routingFresh = new Map(
			rows.map((row) => {
				const entry = readings.get(row.id);
				return [
					row.id,
					entry && entry.ageMs <= USAGE_CACHE_TTL_MS ? entry.data : null,
				] as const;
			}),
		);

		// Best-effort and DB-only: the shared service reads stored usage snapshots
		// and regresses them. On any failure every account simply gets no
		// prediction, exactly as `/api/accounts` and `/api/runway` do.
		const predictions = await buildPredictionsForAccounts(
			dbOps,
			rows.map((row) => ({ id: row.id, provider: row.provider ?? null })),
			routingFresh,
			now,
		).catch((error) => {
			log.debug(
				`Public snapshot prediction failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return new Map();
		});

		// The routing prediction, over the SAME rows this response describes.
		// Querying the accounts a second time would open a window in which the
		// candidate lands on a row whose paused/rate-limited fields this very
		// response reports as blocked. Only the fields `peekRanked` and the two
		// gates read are mapped; the rest of `Account` is unused.
		//
		// ONE evaluation, three published facts: `pool.defaultRoutable` (its
		// count), `routing.defaultCandidateAccountId` (its head) and the gate
		// recoveries feeding `pool.nextAvailableAtMs` (its exclusions). Deriving
		// any of them separately is how a pool reads "nothing routable, nothing
		// scheduled" while an overload breaker is plainly counting down.
		const routingEvaluation = evaluateDefaultCandidates(
			rows.map(
				(row) =>
					({
						id: row.id,
						// A null `provider` column means anthropic, everywhere: the
						// domain conversion says so, and so does the account record this
						// same response serves. Mapping it to `""` here instead would
						// hide a legacy row from provider-wide overload and from
						// provider-sensitive capacity ranking, so `pool.defaultRoutable`
						// and `routing.defaultCandidateAccountId` would disagree with the
						// routing they claim to predict.
						provider: row.provider || "anthropic",
						paused: row.paused === 1,
						pause_reason: row.pause_reason ?? null,
						rate_limited_until:
							row.rate_limited_until != null
								? Number(row.rate_limited_until)
								: null,
						rate_limit_reset:
							row.rate_limit_reset != null
								? Number(row.rate_limit_reset)
								: null,
						session_start:
							row.session_start != null ? Number(row.session_start) : null,
						priority: Number(row.priority) || 0,
						auto_fallback_enabled: row.auto_fallback_enabled === 1,
					}) as Account,
			),
			getStrategy?.() ?? null,
			config,
			now,
		);
		const candidateIds = routingEvaluation.candidateIds;
		const defaultCandidateAccountId = candidateIds[0] ?? null;

		const accounts: PublicAccountSnapshot[] = rows.map((row) => {
			const provider = row.provider || "anthropic";
			const metered = isMetered(provider);
			const entry = readings.get(row.id) ?? null;
			const usage = (entry?.data ?? null) as AnthropicUsageData | null;
			const fresh = (routingFresh.get(row.id) ??
				null) as AnthropicUsageData | null;

			const measurementState: PublicMeasurementState = !metered
				? "not_applicable"
				: entry === null
					? "missing"
					: entry.ageMs > USAGE_CACHE_TTL_MS
						? "stale"
						: "fresh";

			// Same two-view split as `/api/accounts`: the weekly windows move over
			// days so a display-horizon reading is honest evidence for them, while
			// the 5h session moves fast enough that a half-hour-old 100% is not.
			const exhaustion = metered
				? accountWideExhaustion(usage, now, fresh)
				: { exhausted: false, binding: null, resetMs: null };
			const accountWideExhausted =
				exhaustion.exhausted && exhaustion.binding !== null
					? { resetMs: exhaustion.resetMs, binding: exhaustion.binding }
					: null;

			const presentation = resolveRateLimitPresentation(
				{
					rate_limit_status: row.rate_limit_status,
					rate_limit_reset: row.rate_limit_reset,
					rate_limited: row.rate_limited,
					rate_limited_until: row.rate_limited_until,
					rate_limited_reason: row.rate_limited_reason,
				},
				now,
				accountWideExhausted,
			);

			const windows = buildWindows(
				provider,
				metered ? usage : null,
				// One observation instant for every window, because every window on
				// this account comes out of ONE resolved reading. The field is per
				// window so a future source that resolves them separately can say so
				// without a shape change.
				entry?.observedAtMs ?? null,
				predictions.get(row.id) ?? null,
				now,
			);
			const credential = resolveCredentialState(row, now);

			return {
				id: row.id,
				name: row.name,
				provider,
				isDefaultCandidate: row.id === defaultCandidateAccountId,
				paused: row.paused === 1,
				pauseReason: row.pause_reason ?? null,
				cause: presentation.cause,
				// A pause has no scheduled end — it lifts when an operator or an
				// auto-unpause rule says so, not on a clock — so reporting the stored
				// rate-limit reset here would promise a recovery that will not happen.
				availableAtMs: row.paused === 1 ? null : presentation.resetMs,
				credentialState: credential.state,
				credentialExpiresAtMs: credential.expiresAtMs,
				measurementState,
				usageObservedAtMs: entry?.observedAtMs ?? null,
				// The representative account-wide utilization: the worse of the two
				// account-wide windows. Family-scoped windows are deliberately
				// excluded — one spent family is not the account.
				utilizationPct: maxOfPresent(
					windows
						.filter((w) => w.kind === "five_hour" || w.kind === "seven_day")
						.map((w) => w.utilizationPct),
				),
				windows,
			};
		});

		// The pool rollup. Built from the same fields `/health` uses, so a widget
		// and a container health check cannot report different pools. `Account` is
		// only partially populated here — `isAccountAvailable` reads paused and the
		// cooldown lock, and nothing else.
		const availability = rows.map((row) =>
			isAccountAvailable(
				{
					paused: row.paused === 1,
					rate_limited_until: row.rate_limited_until,
				} as Account,
				now,
			),
		);
		let usageExhausted = 0;
		const recoveryTimes: number[] = [];
		accounts.forEach((account, index) => {
			if (!availability[index]) return;
			if (account.cause === "usage_exhausted" && !account.paused) {
				usageExhausted++;
				if (account.availableAtMs !== null) {
					recoveryTimes.push(account.availableAtMs);
				}
			}
		});
		const earliestLock = rows.reduce<number | null>((min, row) => {
			if (row.paused === 1) return min;
			const until = row.rate_limited_until;
			if (!until || until < now) return min;
			return min === null ? Number(until) : Math.min(min, Number(until));
		}, null);
		if (earliestLock !== null) recoveryTimes.push(earliestLock);
		// The gates the candidate evaluation applied, from that SAME evaluation.
		// A pool emptied only by the provider-wide overload breaker or by
		// proactive usage throttling is waiting on a clock exactly as one emptied
		// by cooldowns is, and omitting these instants published it as
		// `unhealthy` when it was recoverable.
		//
		// ONE instant, not one per gate: an account held by both gates recovers
		// when its LATER deadline passes, so pushing each raw entry into a list
		// this line then takes the minimum of would publish the earlier of two
		// holds on the same account as the moment the pool comes back.
		const gateRecoveryMs = earliestExclusionRecoveryMs(
			routingEvaluation.exclusions,
		);
		if (gateRecoveryMs !== null) recoveryTimes.push(gateRecoveryMs);

		const pool: PublicPoolSnapshot = {
			configured: rows.length,
			defaultRoutable: candidateIds.length,
			paused: accounts.filter((a) => a.paused).length,
			rateLimited: rows.filter(
				(row) =>
					row.paused !== 1 &&
					row.rate_limited_until != null &&
					Number(row.rate_limited_until) >= now,
			).length,
			usageExhausted,
			nextAvailableAtMs:
				recoveryTimes.length > 0 ? Math.min(...recoveryTimes) : null,
		};

		/**
		 * One account's reading of a window class, as an aggregate input. An
		 * account that does not have the window at all contributes an explicit
		 * null rather than being dropped, which is what keeps
		 * `contributing + unknown` equal to the account count.
		 */
		const readingOf = (
			account: PublicAccountSnapshot,
			match: (window: PublicWindowSnapshot) => boolean,
		): { utilizationPct: number | null; resetsAtMs: number | null } => {
			const window = account.windows.find(match);
			return {
				utilizationPct: window?.utilizationPct ?? null,
				resetsAtMs: window?.resetsAtMs ?? null,
			};
		};

		// Provider-level facts, one entry per provider PRESENT in the pool. A
		// provider nobody has an account with has no state worth reporting, and
		// enumerating every provider the build knows about would publish the
		// catalogue rather than the deployment.
		const providerNames = [...new Set(accounts.map((a) => a.provider))].sort();
		const providers: PublicProviderSnapshot[] = providerNames.map(
			(provider) => {
				const buckets = getProviderOverloadSnapshot(provider, now);
				const own = accounts.filter((a) => a.provider === provider);
				// Every scope any account of this provider reported, keyed stably.
				const scopeIds = [
					...new Set(
						own.flatMap((a) =>
							a.windows
								.filter((w) => w.kind === "weekly_scoped" && w.scopeId !== null)
								.map((w) => w.scopeId as string),
						),
					),
				].sort();
				return {
					provider,
					anyOverload: combineOverload(buckets),
					providerWideOverload: combineOverload(
						buckets.filter((bucket) => bucket.family === null),
					),
					scopedLimits: scopeIds.map((scopeId) => {
						const matches = (window: PublicWindowSnapshot) =>
							window.kind === "weekly_scoped" && window.scopeId === scopeId;
						return {
							scopeId,
							// The first label any account gave this scope. Display text only:
							// two accounts may name one family differently and the scope id
							// is what joins them.
							label:
								own
									.flatMap((a) => a.windows.filter(matches))
									.find((w) => w.label)?.label ?? scopeId,
							...aggregateWindow(
								own.map((a) => readingOf(a, matches)),
								own.length,
							),
						};
					}),
				};
			},
		);

		return {
			nowMs: now,
			pool,
			routing: {
				context: DEFAULT_ROUTING_CONTEXT,
				defaultCandidateAccountId,
			},
			usage: {
				fiveHour: aggregateWindow(
					accounts.map((a) => readingOf(a, (w) => w.kind === "five_hour")),
					accounts.length,
				),
				sevenDay: aggregateWindow(
					accounts.map((a) => readingOf(a, (w) => w.kind === "seven_day")),
					accounts.length,
				),
				worstAccountUtilizationPct: maxOfPresent(
					accounts.map((a) => a.utilizationPct),
				),
			},
			providers,
			accounts,
		};
	};
}

export type PublicSnapshotReader = ReturnType<
	typeof createPublicSnapshotReader
>;
