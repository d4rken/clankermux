/** Public widget contract. Named-field serializers preserve privacy; shallow arrays support small devices.
 * This contract replaces the previous API in place. There is no compatibility adapter.
 * Instants are ISO strings; durations name their units. Display strings are bounded; IDs are not truncated.
 */
import type { RequestResponse, StopsHistoryResponse } from "@clankermux/types";
import {
	classifyStopCause,
	outcomeForCause,
	resolveCostSource,
} from "@clankermux/types";
import type {
	PublicAccountSnapshot,
	PublicSnapshot,
	PublicWindowSnapshot,
} from "../../services/public-snapshot";
export const PUBLIC_STATUS_SCHEMA = "clankermux.public.status.v1";
export const PUBLIC_ACCOUNTS_SCHEMA = "clankermux.public.accounts.v1";
export const PUBLIC_STREAM_SCHEMA = "clankermux.public.stream.v1";
export const PUBLIC_STOPS_SCHEMA = "clankermux.public.stops.v1";
export const MAX_STRING_BYTES = 96;
/**
 * Truncate to at most `maxBytes` UTF-8 bytes WITHOUT splitting a codepoint.
 *
 * A byte-wise slice can leave a partial multi-byte sequence at the end, which a
 * strict UTF-8 decoder rejects — on the device that fails the whole record, not
 * just the field. `TextEncoder`/`TextDecoder` cannot express "stop at a
 * boundary", so the scan walks codepoints and stops before the one that would
 * overflow. Surrogate pairs are handled by iterating the string (which yields
 * whole codepoints) rather than by index.
 *
 * DISPLAY TEXT ONLY. See {@link identifier} for why an id must never come here.
 */
export function truncateUtf8(
	value: string,
	maxBytes: number = MAX_STRING_BYTES,
): string {
	// Fast path: already within the ceiling in BYTES, so nothing to cut. Cheap
	// for the overwhelmingly common short-ASCII case, and correct for any input.
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

	let bytes = 0;
	let out = "";
	for (const codepoint of value) {
		const size = Buffer.byteLength(codepoint, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		out += codepoint;
	}
	return out;
}

/** Truncate DISPLAY TEXT, preserving null. */
function text(value: string | null | undefined): string | null {
	return value == null ? null : truncateUtf8(value);
}

/**
 * An IDENTIFIER, passed through verbatim.
 *
 * Truncation is forbidden here and the reason is not aesthetic: every id on this
 * surface is a JOIN KEY (a stream event's `accountId` against
 * `accounts[].id`, a runway cause's `accountId` against the same). A truncated
 * key is still a syntactically valid key, so it does not fail — it binds the
 * event to whichever record happens to share the surviving prefix, or to none
 * at all, and does so only for the ids long enough to need cutting. A wrong
 * join is worse than a long field.
 */
function identifier(value: string): string {
	return value;
}

/** As {@link identifier}, preserving null. */
function optionalIdentifier(value: string | null | undefined): string | null {
	return value == null ? null : value;
}

/**
 * An INSTANT on the wire: RFC3339 / ISO-8601, or null.
 *
 * The consumers parse both ISO-8601 and epoch, so this is not a capability
 * question — it is that a bare number cannot say whether it is a moment or a
 * length, and this surface carries both.
 */
function instant(ms: number | null | undefined): string | null {
	if (ms == null || !Number.isFinite(ms)) return null;
	return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Descriptive enums
// ---------------------------------------------------------------------------

/**
 * Whether an account can be routed to, and why not.
 *
 * ORTHOGONAL to {@link PublicCredentialStateDto}: a valid credential on a
 * rate-limited account and an expired credential on an idle one are different
 * situations, and the deployed shape's single `health` axis could express
 * neither. `other` is not a bug bucket — it is the honest answer when the
 * provider reported a rate-limit status our vocabulary has not been taught.
 * Reporting `available` there is exactly how `rejected` went unnoticed once.
 */
export type PublicAvailabilityState =
	| "available"
	| "paused"
	| "rate_limited"
	| "usage_exhausted"
	| "blocked"
	| "other";

/**
 * Map the internal rate-limit cause to an availability state.
 *
 * Paused outranks everything: a paused account is not routable for a reason
 * that has nothing to do with quota, and reporting its stale quota state would
 * tell the operator to wait for a reset that will not change anything.
 *
 * The remaining mapping is total over `RateLimitCause`, and the `default` arm
 * is what makes a FUTURE cause degrade to `other` rather than silently reading
 * as healthy.
 */
export function toPublicAvailabilityState(
	cause: string,
	paused: boolean,
): PublicAvailabilityState {
	if (paused) return "paused";
	switch (cause) {
		case "ok":
		case "allowed":
		case "allowed_warning":
		case "queueing_soft":
			return "available";
		case "rate_limited":
		case "queueing_hard":
			return "rate_limited";
		case "usage_exhausted":
			return "usage_exhausted";
		case "blocked":
		case "payment_required":
			return "blocked";
		default:
			// Includes the internal `unknown` cause and anything added later.
			return "other";
	}
}

/**
 * The finer reason behind an availability state, or null when the state already
 * says everything there is to say.
 *
 * Emitted ONLY where it adds information: a `usage_exhausted` state needs no
 * reason repeating it back, but a `paused` state has seven quite different
 * meanings and a `rate_limited` state does not distinguish the provider
 * throttling us from our own queue holding a request back.
 */
export type PublicAvailabilityReason =
	// Pause reasons.
	| "manual"
	| "failure_threshold"
	| "overage"
	| "peak_hours"
	| "oauth_invalid_grant"
	| "rate_limit_window"
	| "subscription_expired"
	| "usage_permission_denied"
	// Refinements of a non-paused state.
	| "queueing"
	| "payment_required"
	| "other";

const KNOWN_PAUSE_REASONS = new Set([
	"manual",
	"failure_threshold",
	"overage",
	"peak_hours",
	"oauth_invalid_grant",
	"rate_limit_window",
	"subscription_expired",
	"usage_permission_denied",
]);

/**
 * Resolve the availability reason. Null when the state is self-explanatory.
 *
 * A paused account ALWAYS carries one (falling back to `other` rather than
 * leaking a free-form column a device would have to render blind), because
 * "paused" without a reason is the one state an operator cannot act on.
 */
export function toPublicAvailabilityReason(
	cause: string,
	paused: boolean,
	pauseReason: string | null,
): PublicAvailabilityReason | null {
	if (paused) {
		return pauseReason && KNOWN_PAUSE_REASONS.has(pauseReason)
			? (pauseReason as PublicAvailabilityReason)
			: "other";
	}
	switch (cause) {
		case "queueing_hard":
			return "queueing";
		case "payment_required":
			return "payment_required";
		default:
			return null;
	}
}

/**
 * The stored credential's state — an axis of its own, deliberately not folded
 * into availability.
 *
 * A `refreshable` credential blocks nothing (the proxy renews it on the next
 * request), an `invalid` one needs a human at a browser, and `not_applicable`
 * is the honest answer for an API-key provider that has no token lifecycle.
 * Collapsing all three into one `blocked` destroys exactly the distinction the
 * applet renders.
 */
export type PublicCredentialStateDto =
	| "valid"
	| "refreshable"
	| "expired"
	| "invalid"
	| "missing"
	| "not_applicable"
	| "other";

const KNOWN_CREDENTIAL_STATES = new Set([
	"valid",
	"refreshable",
	"expired",
	"invalid",
	"missing",
	"not_applicable",
]);

export function toPublicCredentialState(
	state: string,
): PublicCredentialStateDto {
	return KNOWN_CREDENTIAL_STATES.has(state)
		? (state as PublicCredentialStateDto)
		: "other";
}

/**
 * How well the account's usage is measured. Replaces a boolean `stale` that
 * conflated an old reading, no reading at all, and a provider that has no such
 * window to read.
 */
export type PublicMeasurementStateDto =
	| "fresh"
	| "stale"
	| "missing"
	| "not_applicable"
	| "other";

const KNOWN_MEASUREMENT_STATES = new Set([
	"fresh",
	"stale",
	"missing",
	"not_applicable",
]);

export function toPublicMeasurementState(
	state: string,
): PublicMeasurementStateDto {
	return KNOWN_MEASUREMENT_STATES.has(state)
		? (state as PublicMeasurementStateDto)
		: "other";
}

/**
 * The phase of a request that has not produced a terminal event yet.
 *
 * DESCRIPTIVE, not a discriminator: the value describes a record the client
 * renders either way, so it carries `other` like every other descriptive enum
 * here. Forwarding the internal phase verbatim would hand a device a value its
 * firmware does not know, and the record it sits in — the connect-time replay
 * snapshot — is the one a client cannot afford to reject.
 */
export type PublicRequestPhaseDto = "pending" | "streaming" | "other";

const KNOWN_REQUEST_PHASES = new Set(["pending", "streaming"]);

export function toPublicRequestPhase(phase: string): PublicRequestPhaseDto {
	return KNOWN_REQUEST_PHASES.has(phase)
		? (phase as PublicRequestPhaseDto)
		: "other";
}

/** The quota windows this surface names. */
export type PublicWindowKind =
	| "five_hour"
	| "seven_day"
	| "weekly_scoped"
	| "other";

const KNOWN_WINDOW_KINDS = new Set(["five_hour", "seven_day", "weekly_scoped"]);

/**
 * Total over the window classes the read model produces. Anthropic's separate
 * Claude-Code weekly allowance lands on `other` with a scope id, which is the
 * escape hatch working as intended rather than a gap.
 */
export function toPublicWindowKind(kind: string): PublicWindowKind {
	return KNOWN_WINDOW_KINDS.has(kind) ? (kind as PublicWindowKind) : "other";
}

export interface PublicWindowForecastDto {
	outcome:
		| "exhausted"
		| "exhausts_before_reset"
		| "lasts_until_reset"
		| "unknown"
		| "other";
	quality: "supported" | "limited" | "unavailable" | "other";
	reason:
		| "no_usage"
		| "unstarted"
		| "short_history"
		| "missing_evidence"
		| "stale"
		| "reset_elapsed"
		| "other"
		| null;
	exhaustsAt: string | null;
	reassessAt: string | null;
}
export function toPublicWindowForecastDto(
	window: PublicWindowSnapshot,
	now: number,
): PublicWindowForecastDto {
	const f = window.forecast;
	const empty: PublicWindowForecastDto = {
		outcome: "unknown",
		quality: "unavailable",
		reason: "missing_evidence",
		exhaustsAt: null,
		reassessAt: null,
	};
	if (window.resetsAtMs !== null && window.resetsAtMs <= now)
		return { ...empty, reason: "reset_elapsed" };
	if (!f) return empty;
	if (f.state === "learning")
		return {
			...empty,
			reason:
				f.reason === "no-usage"
					? "no_usage"
					: f.reason === "short-history"
						? "short_history"
						: f.reason === "unstarted"
							? "unstarted"
							: "other",
			reassessAt: f.reason === "short-history" ? instant(f.readyAtMs) : null,
		};
	if (f.state !== "projected") return { ...empty, reason: "other" };
	if (window.resetsAtMs === null) return empty;
	const before = f.exhaustsAtMs !== null && f.exhaustsAtMs < window.resetsAtMs;
	return {
		outcome:
			(window.utilizationPct ?? 0) >= 100
				? "exhausted"
				: before
					? "exhausts_before_reset"
					: "lasts_until_reset",
		quality: f.lowConfidence ? "limited" : "supported",
		reason: null,
		exhaustsAt: before ? instant(f.exhaustsAtMs) : null,
		reassessAt: null,
	};
}
export interface PublicWindowDto {
	kind: PublicWindowKind;
	scopeId: string | null;
	label: string | null;
	utilizationPct: number | null;
	observedAt: string | null;
	resetsAt: string | null;
	forecast: PublicWindowForecastDto;
}
function toPublicWindowDto(
	window: PublicWindowSnapshot,
	now: number,
	stale: boolean,
): PublicWindowDto {
	const forecast = toPublicWindowForecastDto(window, now);
	if (stale) {
		forecast.outcome = "unknown";
		forecast.quality = "unavailable";
		forecast.reason = "stale";
		forecast.exhaustsAt = null;
		forecast.reassessAt = null;
	}
	return {
		kind: toPublicWindowKind(window.kind),
		scopeId: optionalIdentifier(window.scopeId),
		label: text(window.label),
		utilizationPct: window.utilizationPct,
		observedAt: instant(window.observedAtMs),
		resetsAt: instant(window.resetsAtMs),
		forecast,
	};
}
/** Whether the account can be routed to, and until when it cannot. */
export interface PublicAvailabilityDto {
	state: PublicAvailabilityState;
	reason: PublicAvailabilityReason | null;
	/**
	 * INSTANT the block named by `state` lifts, and null whenever `state` is
	 * `available` — an account nothing is holding has no future moment at which
	 * it becomes available, so any instant beside that state is a different fact
	 * wearing this field's name.
	 *
	 * Null on a gated state too whenever nothing schedules the lift: a pause ends
	 * when an operator says so, and a spent window whose reset the provider never
	 * reported has no known turnover.
	 */
	availableAt: string | null;
}

/** The stored credential, on its own axis. */
export interface PublicCredentialDto {
	state: PublicCredentialStateDto;
	/** INSTANT the access token expires; null when there is no such deadline. */
	expiresAt: string | null;
}

/** One account on the wire. Field list is exhaustive and hand-maintained. */
export interface PublicAccountDto {
	/** Stable id, so a stream event can be joined to a name. NEVER truncated. */
	id: string;
	name: string;
	/** A join key against `providers[].provider` on status. NEVER truncated. */
	provider: string;
	availability: PublicAvailabilityDto;
	credential: PublicCredentialDto;
	measurementState: PublicMeasurementStateDto;
	/** INSTANT the reading behind every window below was observed. */
	usageObservedAt: string | null;
	windows: PublicWindowDto[];
}

export function toPublicAccountDto(
	account: PublicAccountSnapshot,
	now: number = Date.now(),
): PublicAccountDto {
	// Computed ONCE and used for both fields below: the state decides whether an
	// instant is emitted at all, so deriving it twice would let the two disagree.
	const state = toPublicAvailabilityState(account.cause, account.paused);
	return {
		id: identifier(account.id),
		name: truncateUtf8(account.name),
		// An IDENTIFIER, not display text: it is what joins this record to
		// `providers[].provider` on the status resource. Two provider names
		// sharing their first 96 bytes would collide under truncation and the
		// correlation would stop being lossless.
		provider: identifier(account.provider),
		availability: {
			state,
			reason: toPublicAvailabilityReason(
				account.cause,
				account.paused,
				account.pauseReason,
			),
			// Only where something is actually holding the account. The snapshot's
			// instant is the resolved rate-limit reset, which a NON-limiting cause
			// still carries — a soft provider status is published beside the stored
			// window reset — and that reset is a quota fact about a window binding
			// nothing. Emitting it beside `available` is what made a healthy account
			// render as "available at 03:00 tomorrow".
			//
			// The test is the STATE, not the cause: this is the one place the public
			// availability vocabulary is decided, and a second cause-to-state rule
			// upstream would be free to disagree with it (it does not, for instance,
			// read `queueing_soft` as available).
			availableAt:
				state === "available" ? null : instant(account.availableAtMs),
		},
		credential: {
			state: toPublicCredentialState(account.credentialState),
			expiresAt: instant(account.credentialExpiresAtMs),
		},
		measurementState: toPublicMeasurementState(account.measurementState),
		usageObservedAt: instant(account.usageObservedAtMs),
		windows: account.windows.map((w) =>
			toPublicWindowDto(w, now, account.measurementState === "stale"),
		),
	};
}

/**
 * `GET /public/v1/accounts`. One record array (`accounts`), one nested array
 * inside it (`windows`), and nothing deeper.
 *
 * Ordered by account NAME, ascending. The order is a stable display order and
 * carries no routing meaning: the routing answer is `isDefaultCandidate`, which
 * says so on the record rather than hiding in an array index.
 */
export interface PublicAccountsDto {
	schema: string;
	/** INSTANT this payload describes. */
	generatedAt: string;
	accounts: PublicAccountDto[];
}

export function toPublicAccountsDto(
	snapshot: PublicSnapshot,
): PublicAccountsDto {
	return {
		schema: PUBLIC_ACCOUNTS_SCHEMA,
		generatedAt: new Date(snapshot.nowMs).toISOString(),
		accounts: snapshot.accounts.map((a) =>
			toPublicAccountDto(a, snapshot.nowMs),
		),
	};
}

// ---------------------------------------------------------------------------
// GET /public/v1/status
// ---------------------------------------------------------------------------

/** Service process state is separate from capacity to route a request. */
export interface PublicStatusDto {
	schema: typeof PUBLIC_STATUS_SCHEMA;
	generatedAt: string;
	serviceState: "ready" | "other";
	version: string;
	uptimeS: number;
	accounts: { configured: number; paused: number };
}
export function toPublicStatusDto(
	snapshot: PublicSnapshot,
	meta: { version: string; uptimeS: number },
): PublicStatusDto {
	return {
		schema: PUBLIC_STATUS_SCHEMA,
		generatedAt: new Date(snapshot.nowMs).toISOString(),
		serviceState: "ready",
		version: meta.version,
		uptimeS: meta.uptimeS,
		accounts: {
			configured: snapshot.pool.configured,
			paused: snapshot.pool.paused,
		},
	};
}
/**
 * Stable published cause vocabulary shared by Stops and the event stream.
 *
 * This is a subset of the internal `StopCause` vocabulary. History-only causes
 * do not extend this closed set. The explicit mapper sends unrecognized causes
 * to `other`; Stops filters to blocked outcomes before mapping, while the event
 * stream retains its legacy classification.
 */
export type PublicStopCauseDto =
	| "pool_quota_exhausted"
	| "family_weekly_exhausted"
	| "model_not_served"
	| "oauth_tokens_expired"
	| "pinned_target_unavailable"
	| "provider_overloaded"
	| "usage_throttled"
	| "context_window_exceeded"
	| "upstream_error"
	| "other";

/**
 * Total over today's `StopCause` values; anything later becomes `other`.
 *
 * Written out rather than derived from the internal `STOP_CAUSES` list, which
 * is what it did before: derived, the published set silently GREW with the
 * internal one, and a cause added to the proxy shipped onto an unauthenticated
 * wire the same commit it was invented — past closed-set readers that cannot be
 * redeployed on our schedule. Spelled out, adding a cause is a decision this
 * file records. Unknown values map to `other`; public Stops filters to explicit
 * blocked causes before this mapping and reports unknown outcomes separately
 * in unclassifiedRequests. The event stream retains this legacy vocabulary.
 */
export function toPublicStopCause(cause: string): PublicStopCauseDto {
	switch (cause) {
		case "pool_quota_exhausted":
			return "pool_quota_exhausted";
		case "family_weekly_exhausted":
			return "family_weekly_exhausted";
		case "model_not_served":
			return "model_not_served";
		case "oauth_tokens_expired":
			return "oauth_tokens_expired";
		case "pinned_target_unavailable":
			return "pinned_target_unavailable";
		case "provider_overloaded":
			return "provider_overloaded";
		case "usage_throttled":
			return "usage_throttled";
		case "context_window_exceeded":
			return "context_window_exceeded";
		case "upstream_error":
			return "upstream_error";
		case "other":
			return "other";
		default:
			return "other";
	}
}

/** One cause and how often it stopped a request in the window. */
export interface PublicStopCauseRowDto {
	cause: PublicStopCauseDto;
	count: number;
	/** INSTANT of the first block under this cause inside the window. */
	firstSeenAt: string | null;
	/** INSTANT of the most recent one. */
	lastSeenAt: string | null;
}

/**
 * `GET /public/v1/stops` — explicit proxy refusals and separate outcome counts.
 * The causes array accounts only for blockedRequests. Unknown outcomes appear
 * in unclassifiedRequests, not as blocked causes. Legacy retry audit rows are
 * excluded from both the denominator and outcomes and counted separately.
 *
 * The history beside `/public/v1/workloads`: that one forecasts budget, this one is
 * what already happened. A panel showing plenty of runway while requests are
 * being refused is showing the two halves of the same question, which is why
 * this is worth publishing at all.
 *
 * FIXED AT SEVEN DAYS, with no query parameter, and the omission is
 * deliberate. The dashboard's `/api/analytics/stops-history` takes a caller's
 * range because a session picked it; this surface is unauthenticated, so a
 * range parameter is an unauthenticated caller choosing how much of the request
 * table the server scans. Seven days is one figure, memoized, the same for
 * everyone.
 *
 * Deliberately absent, and none of it may be added back:
 *
 *  - `series`. A per-bucket time series is a second array level inside the
 *    cause records, past what the device's streaming scanner can descend into.
 *  - `sampleErrorMessage`. A raw upstream `error_message` is unreviewed text
 *    from a third party on an unauthenticated wire; it exists as provenance for
 *    a human reading the dashboard, and the cause label is the machine-readable
 *    fact.
 *  - `topRequestedModel`. Which model a caller asked for is traffic detail, not
 *    a pool fact, and this surface is the pool's.
 */
export interface PublicStopsDto {
	schema: string;
	/** INSTANT this payload describes. */
	generatedAt: string;
	/** Fixed. Stated on the wire so a client never assumes a window length. */
	range: "7d";
	/** INSTANT the counted window opens. */
	windowStartsAt: string;
	/** INSTANT it closes — the read's own clock, not the client's. */
	windowEndsAt: string;
	/** Recorded client requests in range, excluding verified legacy retry audit rows. */
	totalRequests: number;
	/** Explicit proxy refusals only; excludes failures and disconnects. */
	blockedRequests: number;
	failedRequests: number;
	disconnectedRequests: number;
	unclassifiedRequests: number;
	/** Legacy per-attempt rows excluded from both totalRequests and outcomes. */
	excludedAttemptAuditRows: number;
	/** Blocked causes only. Unknown outcomes are stated in unclassifiedRequests. */
	causes: PublicStopCauseRowDto[];
	/**
	 * How much redundancy the pool actually had, per request: how many accounts
	 * were eligible to serve each one. The leading indicator no projection can
	 * see — a pool that never drops below two candidates has margin, and one
	 * sitting at one candidate is a single failure from a stop however much
	 * quota it reports.
	 *
	 * `observedRequests` is the denominator for THIS block alone and is normally
	 * smaller than `totalRequests`: eligibility is only recorded for requests
	 * that reached routing.
	 */
	candidates: {
		observedRequests: number;
		zeroCandidateRequests: number;
		distribution: Array<{ candidatesCount: number; requests: number }>;
	};
}

export function toPublicStopsDto(
	summary: StopsHistoryResponse,
	generatedAtMs: number,
): PublicStopsDto {
	return {
		schema: PUBLIC_STOPS_SCHEMA,
		generatedAt: new Date(generatedAtMs).toISOString(),
		range: "7d",
		windowStartsAt: new Date(summary.windowStartsAt).toISOString(),
		windowEndsAt: new Date(summary.windowEndsAt).toISOString(),
		totalRequests: summary.totalRequests,
		blockedRequests: summary.blockedRequests,
		failedRequests: summary.outcomeTotals.failed,
		disconnectedRequests: summary.outcomeTotals.disconnected,
		unclassifiedRequests: summary.outcomeTotals.unclassified,
		excludedAttemptAuditRows: summary.excludedAttemptAuditRows,
		causes: summary.causes
			.filter((row) => outcomeForCause(row.cause) === "blocked")
			.map((row) => ({
				cause: toPublicStopCause(row.cause),
				count: row.count,
				firstSeenAt: instant(row.firstSeenMs),
				lastSeenAt: instant(row.lastSeenMs),
			})),
		candidates: {
			observedRequests: summary.candidates.observedRequests,
			zeroCandidateRequests: summary.candidates.zeroCandidateRequests,
			distribution: summary.candidates.distribution.map((bucket) => ({
				candidatesCount: bucket.candidatesCount,
				requests: bucket.requests,
			})),
		},
	};
}

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

/**
 * Public event names.
 *
 * Deliberately NOT the internal `RequestStreamEvt.type` values. The internal
 * bus is free to rename, split or add events as the proxy changes; forwarding
 * its discriminator would make every one of those an unannounced breaking
 * change for a device in a wall socket. Same DATA, separate vocabulary.
 *
 * NO `other` MEMBER, and that is not an oversight. The `other` convention is for
 * DESCRIPTIVE enums, where the value describes something and an unknown value
 * still has to be rendered. This is a DISCRIMINATOR: an event type the surface
 * does not carry is simply not emitted, and a client ignores what it does not
 * recognise. An `other` event would be a record with no fields a client could
 * read, forwarded for no purpose.
 */
export type PublicStreamEventType =
	| "active.snapshot"
	| "request.opened"
	| "request.dropped"
	| "request.upstream"
	| "request.done";

/** One in-flight request inside the snapshot. */
export interface PublicActiveRequestDto {
	id: string;
	/** INSTANT. */
	startedAt: string | null;
	method: string;
	path: string;
	project: string | null;
	model: string | null;
	phase: PublicRequestPhaseDto;
	accountId: string | null;
	statusCode: number | null;
}

/**
 * Replay of everything in flight, sent on connect. Its ARRIVAL is what tells
 * the device the replay finished, so it is emitted unconditionally — an empty
 * one is meaningful (it retracts rows the device still held) and suppressing it
 * would leave a reconnecting device showing stale in-flight marks forever.
 */
export interface PublicSnapshotEventDto {
	type: "active.snapshot";
	schema: string;
	/** INSTANT. */
	generatedAt: string;
	active: PublicActiveRequestDto[];
}

/** A request arrived and was admitted; no upstream has been chosen yet. */
export interface PublicRequestOpenedDto {
	type: "request.opened";
	id: string;
	/** INSTANT. */
	at: string | null;
	method: string;
	path: string;
	project: string | null;
	model: string | null;
}

/**
 * A request that will never produce a completion — rejected at admission, a
 * forced-account failure, a pinned-target refusal, or a probe. A device holding
 * it as pending must DISCARD it rather than render it as an error: nothing else
 * in the system has a row for it either.
 */
export interface PublicRequestDroppedDto {
	type: "request.dropped";
	id: string;
	statusCode: number | null;
}

/** An upstream account was selected and answered with headers. */
export interface PublicRequestUpstreamDto {
	type: "request.upstream";
	id: string;
	/** INSTANT. */
	at: string | null;
	method: string;
	path: string;
	accountId: string | null;
	statusCode: number;
	project: string | null;
	model: string | null;
}

/**
 * A request completed.
 *
 * FLATTENED, not nested under `payload` as the internal event is. The nesting
 * exists internally because the summary is a whole `RequestResponse` object;
 * here it is a field list, and a device that has one array budget should not
 * spend reader depth on a wrapper that carries no information.
 */
export interface PublicRequestDoneDto {
	type: "request.done";
	id: string;
	/** INSTANT. */
	at: string;
	method: string;
	path: string;
	accountId: string | null;
	statusCode: number | null;
	success: boolean;
	rateLimited: boolean;
	/** DURATION, ms. */
	responseTimeMs: number | null;
	failoverAttempts: number;
	model: string | null;
	project: string | null;
	totalTokens: number | null;
	/**
	 * Where `totalTokens` came from, or null when nothing states it.
	 *
	 * ADDITIVE, and the total keeps its name, its type and its value: the widgets
	 * use the number, so the fix is to say what it is rather than to withhold it.
	 * `provider` is a count the response reported; `estimated` is the proxy's
	 * `ceil(generatedChars / 4)` fallback, which is what a response with no output
	 * usage or an uncleanly-ended stream gets — a routine case, not an error.
	 *
	 * NULL means the basis is unknown (there is no total, or the record carries no
	 * provenance). Never defaulted to `provider`: claiming a measurement nobody
	 * made is the overstatement this field exists to remove.
	 */
	totalTokensBasis: PublicTokenBasisDto | null;
	/**
	 * Best available request cost in USD: a provider-reported charge or a
	 * catalogue estimate. Subscription usage is API-equivalent plan value,
	 * not a subscription payment. NULL is unpriced; zero is a known zero.
	 */
	costUsd: number | null;
	/** Provenance of costUsd. Missing on older servers; never assume reported. */
	costSource?: "reported" | "estimated" | "unknown";
	/**
	 * WHY the request failed, as an allowlisted CATEGORY — never the upstream's
	 * own text. Null when it did not fail.
	 *
	 * The field keeps its name and its `string | null` wire type; what changed is
	 * the value space, which is now the closed set in
	 * {@link PublicErrorCategoryDto}. The raw message is recorder-built from the
	 * upstream response body and stays on the management surface, behind the
	 * session gate.
	 */
	errorMessage: PublicErrorCategoryDto | null;
}

export type PublicStreamEventDto =
	| PublicSnapshotEventDto
	| PublicRequestOpenedDto
	| PublicRequestDroppedDto
	| PublicRequestUpstreamDto
	| PublicRequestDoneDto;

/**
 * Map the internal summary payload.
 *
 * Two normalizations the internal event does not do, both because the internal
 * bus grew them separately and a device should not have to know that:
 *
 *  - `timestamp` is re-emitted as `at`, normalized through `Date.parse` so a
 *    non-RFC3339 spelling cannot reach the wire.
 *  - `accountUsed` is called `accountId` here, matching the `opened`/`upstream`
 *    events and `PublicAccountDto.id`, so a device can join on one field name.
 *
 * A summary whose timestamp will not parse falls back to `now` rather than
 * emitting null: the device places the record on a time axis, and a null there
 * drops it entirely.
 */
/**
 * How a published token total was arrived at, as a CLOSED set.
 *
 * Mirrors the internal `TokenCountBasis` value for value. No `other` member and
 * no fallback value: an unrecognised or absent basis is published as NULL,
 * which on this surface already means "not stated" — an `other` here would
 * assert that a basis exists and that we know it is neither of these two, which
 * is more than the record supports.
 */
export type PublicTokenBasisDto = "provider" | "estimated";

/**
 * WHY a request failed, as a CLOSED set — never the upstream's own words.
 *
 * `RequestResponse.errorMessage` is built by the recorder from the upstream
 * response body, so it can carry echoed request values and account-specific
 * diagnostics. The deployed shape published its first 96 UTF-8 bytes on an
 * unauthenticated stream, which bounds the LENGTH of that disclosure and nothing
 * about its sensitivity. `/public/v1/stops` already faced this and answered it
 * the same way: classify server-side, publish the label, keep the prose on the
 * management surface behind the session gate.
 *
 * The `/stops` vocabulary is reused verbatim rather than reinvented, so a client
 * needs ONE table for "why did the pool say no" whether it is reading counts or
 * watching the stream. The three additions are transport terminals the proxy
 * writes itself, which are not stops at all — the request reached an account and
 * the connection is what ended.
 *
 * `other` is mandatory and load-bearing, exactly as it is for a stop cause: a
 * terminal invented tomorrow must arrive as something the firmware renders,
 * rather than as a string its closed-set check rejects.
 */
export type PublicErrorCategoryDto =
	| PublicStopCauseDto
	/** The client went away mid-response. */
	| "client_disconnected"
	/** The proxy's own deadline elapsed. */
	| "request_timed_out"
	/** The response stream broke after it had started. */
	| "stream_error";

/**
 * The transport terminals the recorder writes, mapped by exact label.
 *
 * A `Map`, not an object literal, because the key is UNTRUSTED text: an object
 * lookup answers for every inherited property too, so `__proto__` came back as
 * an object (serialising as `errorMessage: {}`) and `constructor` as a function
 * (which JSON drops, taking the field off the wire entirely). A Map has no
 * prototype chain to walk, so the return type is closed by construction rather
 * than by the absence of a caller who can reach those keys.
 */
const TRANSPORT_TERMINALS: ReadonlyMap<string, PublicErrorCategoryDto> =
	new Map<string, PublicErrorCategoryDto>([
		["client disconnected", "client_disconnected"],
		["request timed out", "request_timed_out"],
		["stream error", "stream_error"],
	]);

/**
 * Classify a recorded error into {@link PublicErrorCategoryDto}, or null when
 * nothing failed.
 *
 * Null rather than `other` for the no-error case: `other` means "something
 * happened that this vocabulary cannot name", and a successful request has
 * nothing to name at all. Whitespace counts as nothing, matching
 * `classifyStopCause`, which this delegates to for every label that is not one
 * of the transport terminals above.
 */
export function toPublicErrorCategory(
	errorMessage: string | null | undefined,
	statusCode: number | null | undefined,
): PublicErrorCategoryDto | null {
	const trimmed = errorMessage?.trim() ?? "";
	if (trimmed === "") return null;
	const transport = TRANSPORT_TERMINALS.get(trimmed);
	if (transport) return transport;
	// Preserve event-stream categories. History deliberately uses the more
	// precise outcome classifier (e.g. generic all_accounts_failed is Failed).
	return toPublicStopCause(classifyStopCause(trimmed, statusCode));
}

/** Total over today's `TokenCountBasis`; anything else is not stated at all. */
export function toPublicTokenBasis(
	basis: string | null | undefined,
): PublicTokenBasisDto | null {
	switch (basis) {
		case "provider":
			return "provider";
		case "estimated":
			return "estimated";
		default:
			return null;
	}
}

export function toPublicRequestDoneDto(
	payload: RequestResponse,
	now: number,
): PublicRequestDoneDto {
	const parsed = payload.timestamp ? Date.parse(payload.timestamp) : Number.NaN;
	return {
		type: "request.done",
		// A join key against the `request.opened` / `request.upstream` events for
		// the same request. Truncating it would bind a completion to the wrong row.
		id: identifier(payload.id),
		at: new Date(Number.isFinite(parsed) ? parsed : now).toISOString(),
		method: truncateUtf8(payload.method),
		path: truncateUtf8(payload.path),
		accountId: optionalIdentifier(payload.accountUsed),
		statusCode: payload.statusCode ?? null,
		success: payload.success === true,
		rateLimited: payload.rateLimited === true,
		responseTimeMs: payload.responseTimeMs ?? null,
		failoverAttempts: payload.failoverAttempts ?? 0,
		// The model actually used, falling back to the one the request named —
		// a failed request has the second and not the first.
		model: text(payload.model ?? payload.requestedModel ?? null),
		project: text(payload.project ?? null),
		totalTokens: payload.totalTokens ?? null,
		totalTokensBasis: toPublicTokenBasis(payload.totalTokensBasis),
		costUsd: payload.costUsd ?? null,
		costSource: resolveCostSource(payload.costUsd, payload.costSource),
		// A CATEGORY, not the upstream's prose: this is an unauthenticated wire and
		// the recorder builds that string out of the provider's response body.
		errorMessage: toPublicErrorCategory(
			payload.errorMessage,
			payload.statusCode,
		),
	};
}

// ---------------------------------------------------------------------------
// Stream serialization helpers
// ---------------------------------------------------------------------------

/** Shared by the stream handler for the non-summary events. */
export const streamHelpers = {
	instant,
	identifier,
	optionalIdentifier,
	text,
	toPublicRequestPhase,
};

export type { PublicWorkloadsDto } from "./workloads-dto";
