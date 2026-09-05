/**
 * The `/public/v1/*` wire contract, and the ONLY place it is constructed.
 *
 * Every DTO here is built from a NAMED FIELD LIST. Nothing serializes an
 * internal object and deletes what it does not want: that pattern leaks a field
 * the moment someone adds one upstream, and this surface is unauthenticated.
 * `AccountResponse` in particular carries identity, tokens and endpoint
 * configuration, none of which may cross this boundary.
 *
 * The consumers are a Cinnamon panel applet and an ESP32-C6 running a streaming
 * JSON scanner, so the shape constraints below are structural limits of the
 * reader, not preferences:
 *
 *  - ONE record array, and at most ONE array nested inside it. There is no third
 *    array level anywhere on this surface and none may be added.
 *  - Object nesting stays far below 16 deep.
 *  - Strings are truncated to 96 bytes, UTF-8 safe — DISPLAY TEXT ONLY. An
 *    IDENTIFIER is never truncated: a cut join key still looks like a key and
 *    silently binds an event to the wrong record.
 *  - Every DESCRIPTIVE closed enum has an explicit `other` member and maps
 *    anything unrecognized to it. The firmware treats these as closed sets and
 *    lights a warning on an unknown value, so without `other` any future enum
 *    addition would be a breaking change for it. The one enum that is NOT
 *    descriptive is the stream's event-type discriminator — see there.
 *  - NO field name begins with `identity`. The device asserts their absence,
 *    but the named-field allowlist is the actual privacy boundary; the prefix
 *    check is a smoke alarm, not the wall.
 *
 * TIME. Two kinds of quantity, two representations, and the names say which:
 *
 *  - An INSTANT is an RFC3339 / ISO-8601 string, and its field name never
 *    carries a unit suffix (`generatedAt`, `resetsAt`, `exhaustsAt`).
 *  - A DURATION is a number with its unit in the name (`horizonMs`, `uptimeS`,
 *    `responseTimeMs`).
 *
 * The trap this rule exists for is real and in this codebase: the internal
 * `UsagePrediction.etaExhaustMs` is `last.t + offset`, an absolute epoch
 * instant wearing a duration's name. It is published here as `exhaustsAt`, an
 * ISO string. Do not propagate the misnomer.
 *
 * ONE CANONICAL HOME per raw fact. Derived rollups are legitimate and are
 * labelled as such (`accounts[].utilizationPct`); re-expressing the same
 * measurement in a second place is not, which is why the account-wide windows
 * exist once, in `windows[]`, and provider-level overload lives on the provider
 * rather than being copied onto each of its accounts.
 *
 * VERSIONING. Adding a field changes neither the path nor the schema id. A
 * removal, a rename, a unit change or a semantic change would require
 * `/public/v2` — the consumers pin the schema id and cannot be redeployed on
 * our schedule.
 */

import type { PacingSnapshot, WorkloadHeadroomRow } from "@clankermux/core";
import { classIsUnread } from "@clankermux/core";
import type {
	RequestResponse,
	StopsHistoryResponse,
	UsagePrediction,
} from "@clankermux/types";
import type { PublicRunwaySnapshot } from "../../services/public-runway";
import type {
	PublicAccountSnapshot,
	PublicSnapshot,
	PublicWindowSnapshot,
} from "../../services/public-snapshot";

/**
 * Wire schema identifiers, one PER RESOURCE.
 *
 * Per resource rather than one for the whole surface: a device pins the schema
 * of the payload it parses and refuses one it does not know, and a single
 * shared id would force every consumer of every resource to be updated whenever
 * any one of them changed shape.
 */
export const PUBLIC_STATUS_SCHEMA = "clankermux.public.status.v1";
export const PUBLIC_ACCOUNTS_SCHEMA = "clankermux.public.accounts.v1";
export const PUBLIC_RUNWAY_SCHEMA = "clankermux.public.runway.v1";
export const PUBLIC_STREAM_SCHEMA = "clankermux.public.stream.v1";
export const PUBLIC_STOPS_SCHEMA = "clankermux.public.stops.v1";
export const PUBLIC_PACING_SCHEMA = "clankermux.public.pacing.v1";
export const PUBLIC_WORKLOAD_HEADROOM_SCHEMA =
	"clankermux.public.workload-headroom.v1";

/** Byte ceiling on every DISPLAY string this surface emits. */
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

/**
 * What the usage estimator found for a window.
 *
 * `insufficient_data` is absent by construction: a prediction with no
 * established trend is not served at all (the record is null), because its
 * `slopePerHour` is a placeholder 0 that would read as a measured flat trend.
 */
export type PublicPredictionState = "rising" | "stable" | "exhausted" | "other";

const KNOWN_PREDICTION_STATES = new Set(["rising", "stable", "exhausted"]);

export function toPublicPredictionState(state: string): PublicPredictionState {
	return KNOWN_PREDICTION_STATES.has(state)
		? (state as PublicPredictionState)
		: "other";
}

/**
 * The provider-overload breaker, as a CLOSED set.
 *
 * `half_open` is why this is a state rather than a deadline: a half-open
 * breaker has no `until` at all and is emphatically not closed, so a flat
 * timestamp reports the one case worth showing as "fine".
 */
export type PublicOverloadStateDto = "closed" | "open" | "half_open" | "other";

export function toPublicOverloadState(state: string): PublicOverloadStateDto {
	switch (state) {
		case "closed":
			return "closed";
		case "open":
			return "open";
		case "half-open":
			return "half_open";
		default:
			return "other";
	}
}

/**
 * Quota-runway outcome, as a CLOSED set.
 *
 * Mirrors `RunwayOutcome["kind"]` value for value, in this surface's snake_case
 * rather than core's kebab-case, with `other` for a kind added later. Mapping a
 * future kind onto `beyond_horizon` would be the worst possible default — it
 * reads as "nothing runs out" — so the escape hatch is what keeps a new outcome
 * from being silently reassuring.
 *
 * QUOTA, not availability: an account that is paused or cooling off still counts
 * as capacity here, exactly as it does for `/api/runway`. Copy built on this
 * must say "quota", never "available".
 */
export type PublicRunwayKind =
	/** Projected to run out within the horizon; an instant is reported. */
	| "runway"
	/** Out of quota right now. No future instant, so the instant is null. */
	| "out_now"
	/** No run-out modelled inside the horizon the scan checked. */
	| "beyond_horizon"
	/** No readable window anywhere; cannot be determined. */
	| "unknown"
	/** Nothing to route to at all. */
	| "no_accounts"
	| "other";

/** Total over today's `RunwayOutcome["kind"]`; anything later becomes `other`. */
export function toPublicRunwayKind(kind: string): PublicRunwayKind {
	switch (kind) {
		case "runway":
			return "runway";
		case "out-now":
			return "out_now";
		case "beyond-horizon":
			return "beyond_horizon";
		case "unknown":
			return "unknown";
		case "no-accounts":
			return "no_accounts";
		default:
			return "other";
	}
}

// ---------------------------------------------------------------------------
// GET /public/v1/accounts
// ---------------------------------------------------------------------------

/**
 * The estimator's projection for ONE window, or null when there is none.
 *
 * Lives INSIDE the window rather than on a resource of its own: a measurement
 * and the projection built from it describe the same thing and change together,
 * and splitting them lets a client pair a fresh percentage with a projection
 * computed from an older reading without any way to notice.
 */
export interface PublicPredictionDto {
	/** Where the window is projected to land at its reset, 0..100. */
	predictedUtilizationAtResetPct: number | null;
	/** INSTANT the window is projected to hit 100%. */
	exhaustsAt: string | null;
	willExhaustBeforeReset: boolean;
	/**
	 * The estimator's own confidence flag. A low-confidence projection is real
	 * evidence but must never be rendered at full severity.
	 */
	lowConfidence: boolean;
	state: PublicPredictionState;
}

function toPublicPredictionDto(
	prediction: UsagePrediction | null,
): PublicPredictionDto | null {
	if (!prediction) return null;
	return {
		predictedUtilizationAtResetPct: prediction.predictedAtReset,
		// `etaExhaustMs` is an absolute epoch INSTANT despite its name (it is
		// `last.t + offset`). Published under a name that says so.
		exhaustsAt: instant(prediction.etaExhaustMs),
		willExhaustBeforeReset: prediction.willExhaustBeforeReset === true,
		lowConfidence: prediction.lowConfidence === true,
		state: toPublicPredictionState(prediction.state),
	};
}

/**
 * One quota window on the wire.
 *
 * REPLACES the deployed `limits[]`, `fiveHourPct`, `fiveHourResetsAt`,
 * `sevenDayPct` and `sevenDayResetsAt` together: those represented one
 * observation three times in two vocabularies, and a client had no way to know
 * which copy to believe when they disagreed.
 */
export interface PublicWindowDto {
	kind: PublicWindowKind;
	/** Stable scope key for a scoped window; null for the account-wide ones. */
	scopeId: string | null;
	/** Display text only. Join on `scopeId`, never on this. */
	label: string | null;
	utilizationPct: number | null;
	/** INSTANT the reading was observed. */
	observedAt: string | null;
	/** INSTANT the window rolls over. */
	resetsAt: string | null;
	prediction: PublicPredictionDto | null;
}

function toPublicWindowDto(window: PublicWindowSnapshot): PublicWindowDto {
	return {
		kind: toPublicWindowKind(window.kind),
		// A scope id is a JOIN KEY against `providers[].scopedLimits[].scopeId`,
		// so it is never truncated.
		scopeId: optionalIdentifier(window.scopeId),
		label: text(window.label),
		utilizationPct: window.utilizationPct,
		observedAt: instant(window.observedAtMs),
		resetsAt: instant(window.resetsAtMs),
		prediction: toPublicPredictionDto(window.prediction),
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
	/**
	 * The ONE account a fresh, unpinned, nominal-size request would be routed to
	 * right now — not "the account the load balancer is using", which is not a
	 * thing that exists. `routing.context` on `/public/v1/status` names the
	 * question this answers, and the gates it deliberately omits.
	 */
	isDefaultCandidate: boolean;
	availability: PublicAvailabilityDto;
	credential: PublicCredentialDto;
	measurementState: PublicMeasurementStateDto;
	/** INSTANT the reading behind every window below was observed. */
	usageObservedAt: string | null;
	/**
	 * DERIVED: the max `utilizationPct` across the account-wide windows below.
	 * Served because both clients render an overall gauge; it is a rollup of
	 * `windows[]` and never a separate measurement.
	 */
	utilizationPct: number | null;
	windows: PublicWindowDto[];
}

export function toPublicAccountDto(
	account: PublicAccountSnapshot,
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
		isDefaultCandidate: account.isDefaultCandidate,
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
		utilizationPct: account.utilizationPct,
		windows: account.windows.map(toPublicWindowDto),
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
		accounts: snapshot.accounts.map(toPublicAccountDto),
	};
}

// ---------------------------------------------------------------------------
// GET /public/v1/status
// ---------------------------------------------------------------------------

/** A pooled aggregate over one window class. */
export interface PublicWindowAggregateDto {
	/**
	 * UNWEIGHTED ARITHMETIC MEAN over the accounts that reported the window,
	 * paused and stale ones included. Named for what it is: the deployed
	 * `fiveHourPct` was this number under a name that implied a pool utilization.
	 *
	 * The percentages behind it may derive from DIFFERENT PLAN CAPACITIES — a
	 * Max-20 account and a Pro account both report "62%" of quotas that are not
	 * the same size — so it is a mean of percentages and never a statement about
	 * how much work the pool can still do.
	 */
	meanUtilizationPct: number | null;
	contributingAccountCount: number;
	/** Every account in scope that did not contribute. The two counts sum. */
	unknownAccountCount: number;
	/**
	 * EARLIEST reset among the contributors, as an INSTANT. Never a mean of reset
	 * instants — the mean of two reset times is a moment at which nothing
	 * happens.
	 */
	earliestResetsAt: string | null;
	/**
	 * The LOWEST utilization among the contributors — the account with the most
	 * room left.
	 *
	 * Published beside the mean because it is the one that answers a widget's
	 * actual question. Routing picks ONE account, so what decides whether the
	 * next request goes through is whether ANY account still has room; a mean of
	 * a spent account and a fresh one describes neither of them. Null when
	 * nothing contributed.
	 */
	leastUsedUtilizationPct: number | null;
	/**
	 * Whose that reading is: a join key against `accounts[].id`, so NEVER
	 * truncated. Without it the percentage names no account and cannot be acted
	 * on.
	 */
	leastUsedAccountId: string | null;
}

/** One provider-scoped limit, pooled. */
export interface PublicScopedLimitDto extends PublicWindowAggregateDto {
	/** Stable key, joinable against `accounts[].windows[].scopeId`. */
	scopeId: string;
	/** Display text only. */
	label: string | null;
}

/** The overload breaker for one provider. */
export interface PublicOverloadDto {
	state: PublicOverloadStateDto;
	/** INSTANT the block lifts. Null while closed AND while half-open. */
	until: string | null;
	probeActive: boolean;
}

/**
 * One provider on the wire.
 *
 * Provider-level facts belong HERE, not copied onto every account of the
 * provider: the deployed shape published one overload deadline N times and left
 * a client to notice they were the same fact.
 */
export interface PublicProviderDto {
	/** A join key against `accounts[].provider`, so NEVER truncated. */
	provider: string;
	/** Worst state across ALL this provider's buckets, family ones included. */
	anyOverload: PublicOverloadDto;
	/** The provider-WIDE bucket alone, which gates every model family at once. */
	providerWideOverload: PublicOverloadDto;
	scopedLimits: PublicScopedLimitDto[];
}

/** `GET /public/v1/status`. One record array (`providers`), one nested. */
export interface PublicStatusDto {
	schema: string;
	/** INSTANT this payload describes. Also the device's only wall clock. */
	generatedAt: string;
	status: "ok" | "degraded" | "unhealthy";
	/** DURATION, seconds. */
	uptimeS: number;
	version: string;
	pool: {
		configured: number;
		/** Routable in `routing.context` — the same question, so the same answer. */
		defaultRoutable: number;
		paused: number;
		rateLimited: number;
		usageExhausted: number;
		/** INSTANT. */
		nextAvailableAt: string | null;
	};
	routing: {
		context: string;
		defaultCandidateAccountId: string | null;
	};
	usage: {
		fiveHour: PublicWindowAggregateDto;
		sevenDay: PublicWindowAggregateDto;
		worstAccountUtilizationPct: number | null;
	};
	providers: PublicProviderDto[];
}

/**
 * The pool headline, computed from the same three facts `/health` uses so a
 * desk panel and a container health check cannot disagree.
 */
export function toPublicStatusLevel(
	pool: PublicSnapshot["pool"],
): PublicStatusDto["status"] {
	if (pool.configured === 0) return "unhealthy";
	if (pool.defaultRoutable > 0) return "ok";
	return pool.nextAvailableAtMs !== null ? "degraded" : "unhealthy";
}

function toPublicWindowAggregateDto(
	aggregate: PublicSnapshot["usage"]["fiveHour"],
): PublicWindowAggregateDto {
	return {
		meanUtilizationPct: aggregate.meanUtilizationPct,
		contributingAccountCount: aggregate.contributingAccountCount,
		unknownAccountCount: aggregate.unknownAccountCount,
		earliestResetsAt: instant(aggregate.earliestResetsAtMs),
		leastUsedUtilizationPct: aggregate.leastUsedUtilizationPct,
		leastUsedAccountId: optionalIdentifier(aggregate.leastUsedAccountId),
	};
}

function toPublicOverloadDto(
	overload: PublicSnapshot["providers"][number]["anyOverload"],
): PublicOverloadDto {
	return {
		state: toPublicOverloadState(overload.state),
		until: instant(overload.untilMs),
		probeActive: overload.probeActive,
	};
}

export function toPublicStatusDto(
	snapshot: PublicSnapshot,
	runtime: { uptimeS: number; version: string },
): PublicStatusDto {
	return {
		schema: PUBLIC_STATUS_SCHEMA,
		generatedAt: new Date(snapshot.nowMs).toISOString(),
		status: toPublicStatusLevel(snapshot.pool),
		uptimeS: runtime.uptimeS,
		version: truncateUtf8(runtime.version),
		pool: {
			configured: snapshot.pool.configured,
			defaultRoutable: snapshot.pool.defaultRoutable,
			paused: snapshot.pool.paused,
			rateLimited: snapshot.pool.rateLimited,
			usageExhausted: snapshot.pool.usageExhausted,
			nextAvailableAt: instant(snapshot.pool.nextAvailableAtMs),
		},
		routing: {
			context: snapshot.routing.context,
			// A join key against `accounts[].id`, so never truncated.
			defaultCandidateAccountId: optionalIdentifier(
				snapshot.routing.defaultCandidateAccountId,
			),
		},
		usage: {
			fiveHour: toPublicWindowAggregateDto(snapshot.usage.fiveHour),
			sevenDay: toPublicWindowAggregateDto(snapshot.usage.sevenDay),
			worstAccountUtilizationPct: snapshot.usage.worstAccountUtilizationPct,
		},
		providers: snapshot.providers.map((provider) => ({
			// The join key for `accounts[].provider`, so never truncated.
			provider: identifier(provider.provider),
			anyOverload: toPublicOverloadDto(provider.anyOverload),
			providerWideOverload: toPublicOverloadDto(provider.providerWideOverload),
			scopedLimits: provider.scopedLimits.map((limit) => ({
				scopeId: identifier(limit.scopeId),
				label: text(limit.label),
				...toPublicWindowAggregateDto(limit),
			})),
		})),
	};
}

// ---------------------------------------------------------------------------
// GET /public/v1/runway
// ---------------------------------------------------------------------------

/** The account + window that runs out at the reported instant. */
export interface PublicRunwayCauseDto {
	/** A join key against `accounts[].id`, so never truncated. */
	accountId: string;
	windowKind: PublicWindowKind;
}

/**
 * The pool's worst STATEABLE quota outcome.
 *
 * "Stated", not "active", and the distinction is the whole point: an UNOBSERVED
 * key could be worse than every stated one, so a name implying this covers
 * everything would be a claim the data does not support. `coverage` is what
 * says how much of the pool the figure speaks for, and a client rendering this
 * without it is claiming more than it knows.
 */
export interface PublicWorstOutcomeDto {
	kind: PublicRunwayKind;
	/** INSTANT the pool is projected to be out; null on every other kind. */
	exhaustsAt: string | null;
	causes: PublicRunwayCauseDto[];
	/**
	 * The quantisation band around {@link exhaustsAt}: the earliest and latest
	 * run-out the same scan reports when each whole-percent reading is nudged by
	 * half a percent either way.
	 *
	 * Providers report utilization as a whole percent, and the projection divides
	 * by that number, so the error is proportional to the runway itself — at 20%
	 * one day into a weekly window, half a percent is about six hours. A single
	 * instant states a precision the input never had.
	 *
	 * Either end is null when the scan at that perturbation found no run-out
	 * inside the horizon: the band is OPEN on that side, not zero-width. Both are
	 * null when no band is stated at all (modelled reset credits make the burn
	 * non-monotonic, or every reading was already fractional).
	 */
	earliestExhaustsAt: string | null;
	latestExhaustsAt: string | null;
	/**
	 * Signed pace headroom: how much more load the pool can take, or how much it
	 * has to shed, as a whole percentage of the currently measured pace.
	 *
	 * THE figure a "more agents or fewer agents" reading is built from, and the
	 * only one on this surface that is pool-level rather than per-account. The
	 * per-class burn ratios on `/public/v1/pacing` answer a different question
	 * and routinely disagree with this one: several accounts can each be over
	 * pace on their own window while the pool, with staggered resets and
	 * failover, still has room.
	 *
	 * Positive with `direction: "margin"`, negative-sense with `"deficit"`. The
	 * sign is carried in `headroomDirection` rather than in the number so a
	 * client that ignores the enum cannot silently read a required cut as spare
	 * capacity.
	 *
	 * BOTH null is not "zero headroom" — it is "no figure", and which end of the
	 * scale that means depends on `kind`. On a `beyond_horizon` it is the good
	 * end (no probed increase up to the cap flips the verdict, so headroom is at
	 * least the cap); on a `runway` it is the bad end (no probed slowdown down to
	 * the floor clears the horizon). A renderer must read `kind` alongside it and
	 * must never draw either case as a zero.
	 */
	headroomPct: number | null;
	headroomDirection: PublicHeadroomDirection | null;
}

/**
 * Which way the pool's pace headroom points, as a CLOSED set.
 *
 * Two members and an escape hatch rather than a signed number alone, because
 * the two mean opposite things and a client dropping the sign would invert the
 * advice completely.
 */
export type PublicHeadroomDirection = "margin" | "deficit" | "other";

const KNOWN_HEADROOM_DIRECTIONS = new Set(["margin", "deficit"]);

/** Total over today's headroom directions; anything later becomes `other`. */
export function toPublicHeadroomDirection(
	direction: string,
): PublicHeadroomDirection {
	return KNOWN_HEADROOM_DIRECTIONS.has(direction)
		? (direction as PublicHeadroomDirection)
		: "other";
}

/**
 * `GET /public/v1/runway` — the POOL-LEVEL quota projection and nothing else.
 *
 * Deliberately absent, and none of it may be added back:
 *
 *  - API key ids, key NAMES (they look like `"impatience (claude)"`), routing
 *    pins and per-key eligible-account mappings. All of it is management data
 *    on an unauthenticated surface, and the per-key breakdown is three array
 *    levels past what the device's scanner can descend into.
 *  - Per-account utilization, resets and observation times. That is the
 *    accounts resource's job; re-serving it here would be the same measurement
 *    in two places, and the two would drift. A cause REFERENCING an account id
 *    is a resource reference, which is a different thing.
 */
export interface PublicRunwayDto {
	schema: string;
	/** INSTANT this payload describes. */
	generatedAt: string;
	/** DURATION, ms — the horizon the scan modelled, so no client hardcodes it. */
	horizonMs: number;
	coverage: {
		activeKeyCount: number;
		statedKeyCount: number;
		unobservedKeyCount: number;
	};
	worstStatedOutcome: PublicWorstOutcomeDto | null;
}

export function toPublicRunwayDto(
	snapshot: PublicRunwaySnapshot,
): PublicRunwayDto {
	return {
		schema: PUBLIC_RUNWAY_SCHEMA,
		generatedAt: new Date(snapshot.generatedAtMs).toISOString(),
		horizonMs: snapshot.horizonMs,
		coverage: {
			activeKeyCount: snapshot.coverage.activeKeyCount,
			statedKeyCount: snapshot.coverage.statedKeyCount,
			unobservedKeyCount: snapshot.coverage.unobservedKeyCount,
		},
		worstStatedOutcome: snapshot.worstStatedOutcome
			? {
					kind: toPublicRunwayKind(snapshot.worstStatedOutcome.kind),
					exhaustsAt: instant(snapshot.worstStatedOutcome.exhaustsAtMs),
					causes: snapshot.worstStatedOutcome.causes.map((cause) => ({
						accountId: identifier(cause.accountId),
						windowKind: toPublicWindowKind(cause.windowKind),
					})),
					earliestExhaustsAt: instant(
						snapshot.worstStatedOutcome.band?.earliestExhaustsAtMs,
					),
					latestExhaustsAt: instant(
						snapshot.worstStatedOutcome.band?.latestExhaustsAtMs,
					),
					headroomPct: snapshot.worstStatedOutcome.headroom?.pct ?? null,
					headroomDirection:
						snapshot.worstStatedOutcome.headroom == null
							? null
							: toPublicHeadroomDirection(
									snapshot.worstStatedOutcome.headroom.direction,
								),
				}
			: null,
	};
}

// ---------------------------------------------------------------------------
// GET /public/v1/stops
// ---------------------------------------------------------------------------

/**
 * Why a request was refused, as a CLOSED set.
 *
 * Mirrors the internal `StopCause` value for value — it is already snake_case
 * and already carries `other`, so no renaming happens here. The mapper is still
 * explicit rather than a cast: a cause added to the proxy later must arrive on
 * this wire as `other`, which the firmware knows how to render, instead of as a
 * string its closed-set check would reject.
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
 * file records, and until it is made the new cause arrives as `other`, which
 * every consumer already renders.
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
 * `GET /public/v1/stops` — how often the pool actually refused a request, and
 * why.
 *
 * The counterpart to `/public/v1/runway`: that one is a PROJECTION, this one is
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
	/** The denominator. A blocked count without it is not a rate. */
	totalRequests: number;
	blockedRequests: number;
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
		causes: summary.causes.map((row) => ({
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
	costUsd: number | null;
	errorMessage: string | null;
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
		costUsd: payload.costUsd ?? null,
		errorMessage: text(payload.errorMessage),
	};
}

// ---------------------------------------------------------------------------
// GET /public/v1/pacing
// ---------------------------------------------------------------------------

/**
 * How a figure should be read, as a CLOSED set.
 *
 * Mirrors the internal `OutlookTone` value for value. Published rather than
 * left to the client because the thresholds behind it (60% "watch", 80% "high",
 * 1.05x and 1.5x on the burn ratio) are policy, and a widget re-deriving them
 * would drift from the dashboard the first time one moved.
 */
export type PublicToneDto =
	| "neutral"
	| "success"
	| "warning"
	| "destructive"
	| "other";

const KNOWN_TONES = new Set(["neutral", "success", "warning", "destructive"]);

/** Total over today's `OutlookTone`; anything later becomes `other`. */
export function toPublicTone(tone: string): PublicToneDto {
	return KNOWN_TONES.has(tone) ? (tone as PublicToneDto) : "other";
}

/**
 * One servable class's weekly budget and 5-hour governor state.
 *
 * Account references are IDs only. Names live once, on `/public/v1/accounts`,
 * and a consumer joins on these — re-serving them here would be the same fact
 * in two places, free to drift.
 */
export interface PublicPacingClassDto {
	/** Join key for the class itself; stable across polls. */
	classId: string;
	/** Display label, e.g. "Claude". Truncated like any display string. */
	label: string | null;

	// --- Weekly budget ---
	/**
	 * The LEAST-USED account's weekly utilization, which is this class's real
	 * headroom: routing picks one account, so what matters is whether any account
	 * still has room, not the mean of a spent one and a fresh one.
	 */
	utilizationPct: number | null;
	/** The account the two figures above and below describe. */
	leastUsedAccountId: string | null;
	/**
	 * Actual burn over the burn an even spend of the window would have reached.
	 * 1.0 is exactly on pace. Null when no honest comparison exists — no reset to
	 * measure against, or a window too young to divide by.
	 *
	 * NOT the answer to "should I run more work": it describes one account, and a
	 * pool with staggered resets and failover routinely shows several accounts
	 * over pace while the pool as a whole has room. The pool-level signed figure
	 * is on `/public/v1/runway`.
	 */
	burnRatio: number | null;
	burnTone: PublicToneDto | null;
	outlookTone: PublicToneDto;
	/** Accounts reporting a weekly reading, out of those that could. */
	reportingCount: number;
	eligibleTotal: number;
	/** How many reach 100% before their own reset, and how many already have. */
	willRunOut: number;
	alreadySpent: number;
	/** Earliest weekly reset in the class, and whose. */
	resetsAt: string | null;
	resetsAtAccountId: string | null;
	/** One account or fewer can serve this class; a single failure stops it. */
	singlePointOfFailure: boolean;

	// --- 5-hour governor ---
	/** Accounts that can serve right now. */
	fiveHourRoom: number;
	/** Reporting accounts projected to hit the 5-hour limit before it resets. */
	fiveHourRunningHot: number;
	/**
	 * Held by the 5-hour limit ALONE — capacity a lift restores. An account also
	 * out of its weekly quota is excluded: the lift gives it nothing, and
	 * counting it here would promise a recovery that never arrives.
	 */
	fiveHourWaiting: number;
	/** Paused, cooling down, token-expired, usage-429 or weekly-spent. */
	fiveHourUnavailable: number;
	/** No 5-hour reading at all. Never counted as zero. */
	fiveHourUnknown: number;
	/**
	 * True when nothing is known about this class's 5-hour state. Codex accounts
	 * report no 5-hour window at all, so this is a standing condition for a pool
	 * holding one, not a transient error.
	 */
	fiveHourUnread: boolean;
	/** Earliest future lift among this class's waiting accounts. */
	nextLiftAt: string | null;
	nextLiftAccountId: string | null;
}

/**
 * `GET /public/v1/pacing` — how fast the pool is spending, per servable class.
 *
 * Deliberately absent, and none of it may be added back:
 *
 *  - Account NAMES. They are display text belonging to the accounts resource;
 *    every reference here is a join key.
 *  - The pool's signed pace headroom. It is computed by the runway scan and
 *    published on `/public/v1/runway`; a copy here would be one measurement in
 *    two places.
 *  - Per-account bars. That is the accounts resource's job, and nesting them
 *    under `classes[]` would put a second array inside a record array, which the
 *    device's scanner cannot descend into.
 */
export interface PublicPacingDto {
	schema: string;
	/** INSTANT this payload describes. */
	generatedAt: string;
	/** The tightest class's id, or null when none reports. */
	bindingClassId: string | null;
	/**
	 * The pool-wide 5-hour verdict. `paced` is the one state where waiting is the
	 * only option: some class has nothing that can serve it and the cause is the
	 * 5-hour limit.
	 */
	fiveHourOutlookTone: PublicToneDto;
	classes: PublicPacingClassDto[];
}

export function toPublicPacingDto(snapshot: PacingSnapshot): PublicPacingDto {
	const pacingByClass = new Map(
		snapshot.fiveHour.classes.map((pacing) => [pacing.classId, pacing]),
	);
	const budgetByClass = new Map(
		snapshot.classes.map((budget) => [budget.classId, budget]),
	);

	// The UNION of both window's classes, not just the weekly ones. Provider
	// eligibility differs per window — z.ai reports a 5-hour quota and no weekly
	// one — so a weekly-only walk drops such a class entirely. That produced the
	// worst possible payload: a pool-wide `destructive` verdict caused by a
	// z.ai class that is being held by its 5-hour limit, beside an empty
	// `classes` array with nothing to explain it or say when it lifts.
	//
	// Weekly-only order first, then any 5-hour-only class, so the common case
	// keeps the ordering the pool already sorted.
	const classIds = [
		...snapshot.classes.map((budget) => budget.classId),
		...snapshot.fiveHour.classes
			.map((pacing) => pacing.classId)
			.filter((classId) => !budgetByClass.has(classId)),
	];

	return {
		schema: PUBLIC_PACING_SCHEMA,
		generatedAt: new Date(snapshot.generatedAtMs).toISOString(),
		bindingClassId: optionalIdentifier(snapshot.bindingClassId),
		fiveHourOutlookTone: toPublicTone(snapshot.fiveHour.outlook.tone),
		classes: classIds.map((classId) => {
			const pacing = pacingByClass.get(classId);
			const budget = budgetByClass.get(classId);
			// A class with no weekly budget reports zero accounts ELIGIBLE for the
			// weekly window, which is a measured fact about provider eligibility
			// rather than a fabricated empty: no z.ai account has a weekly quota to
			// report. `utilizationPct` and the burn stay null, as they must.
			if (budget == null) {
				return {
					classId: identifier(classId),
					label: text(pacing?.label ?? null),
					utilizationPct: null,
					leastUsedAccountId: null,
					burnRatio: null,
					burnTone: null,
					outlookTone: toPublicTone("neutral"),
					reportingCount: 0,
					eligibleTotal: 0,
					willRunOut: 0,
					alreadySpent: 0,
					resetsAt: null,
					resetsAtAccountId: null,
					singlePointOfFailure: false,
					fiveHourRoom: pacing?.room ?? 0,
					fiveHourRunningHot: pacing?.runningHot ?? 0,
					fiveHourWaiting: pacing?.waiting ?? 0,
					fiveHourUnavailable: pacing?.unavailable ?? 0,
					fiveHourUnknown: pacing?.unknown ?? 0,
					fiveHourUnread: pacing == null ? true : classIsUnread(pacing),
					nextLiftAt: instant(pacing?.nextLiftMs),
					nextLiftAccountId: optionalIdentifier(pacing?.nextLiftAccountId),
				};
			}
			return {
				classId: identifier(budget.classId),
				label: text(budget.label),
				utilizationPct: budget.utilizationPct,
				leastUsedAccountId: optionalIdentifier(budget.leastUsedAccountId),
				// Rounded to two decimals: the input is a whole-percent utilization
				// over a continuously advancing clock, so further digits are noise
				// that would make the figure look like it moved between polls.
				burnRatio:
					budget.burn == null
						? null
						: Math.round(budget.burn.ratio * 100) / 100,
				burnTone:
					budget.burnTone == null ? null : toPublicTone(budget.burnTone),
				outlookTone: toPublicTone(budget.outlookTone),
				reportingCount: budget.reportingCount,
				eligibleTotal: budget.eligibleTotal,
				willRunOut: budget.willRunOut,
				alreadySpent: budget.alreadySpent,
				resetsAt: instant(budget.earliestResetMs),
				resetsAtAccountId: optionalIdentifier(budget.earliestResetAccountId),
				singlePointOfFailure: budget.singlePointOfFailure,
				fiveHourRoom: pacing?.room ?? 0,
				fiveHourRunningHot: pacing?.runningHot ?? 0,
				fiveHourWaiting: pacing?.waiting ?? 0,
				fiveHourUnavailable: pacing?.unavailable ?? 0,
				fiveHourUnknown: pacing?.unknown ?? 0,
				fiveHourUnread: pacing == null ? true : classIsUnread(pacing),
				nextLiftAt: instant(pacing?.nextLiftMs),
				nextLiftAccountId: optionalIdentifier(pacing?.nextLiftAccountId),
			};
		}),
	};
}

/** Shared by the stream handler for the non-summary events. */
export const streamHelpers = {
	instant,
	identifier,
	optionalIdentifier,
	text,
	toPublicRequestPhase,
};

/**
 * One workload's headroom row.
 *
 * FLAT, deliberately: no array nested inside this record at all, so the whole
 * resource is one record array and a streaming scanner never descends past the
 * depth the wire guard enforces. Account references would be join keys against
 * `/public/v1/accounts`; this resource publishes COUNTS instead, because the
 * question it answers ("can I add another agent of this kind") is about how
 * many accounts stand behind a workload, not which ones.
 */
export interface PublicWorkloadHeadroomRowDto {
	/** Primary planning interval. Existing top-level fields retain the long horizon. */
	nextReset: {
		resetsAt: string | null;
		outcomeKind: PublicRunwayKind;
		exhaustsAt: string | null;
		headroomPct: number | null;
		headroomDirection: PublicHeadroomDirection | null;
		projectionBasis: PublicProjectionBasisDto | null;
	} | null;
	/** `"class"` (Claude, GPT) or `"family"` (a scoped model family). */
	dimensionKind: PublicWorkloadDimensionDto;
	/** Servable class id or model family id. Join key, never truncated. */
	dimensionId: string;
	label: string | null;
	/** `RunwayOutcome["kind"]`, mapped exactly as the runway resource maps it. */
	outcomeKind: PublicRunwayKind;
	/** Projected all-out instant for this workload, or null on every other kind. */
	exhaustsAt: string | null;
	/**
	 * Magnitude only — ALWAYS POSITIVE. The sign lives in `headroomDirection`,
	 * and a client that renders this number without reading that field shows a
	 * required 40% cut as 40% of spare capacity.
	 */
	headroomPct: number | null;
	headroomDirection: PublicHeadroomDirection | null;
	/**
	 * Whether `headroomPct` is the threshold or a BOUND on it.
	 *
	 * `exact` on a class row: the accounts in a class can cover for each other,
	 * every window is varied together, and the figure means what the pool-level
	 * one on `/public/v1/runway` means. `conservative_bound` on a family row:
	 * isolating one family's load needs that family's share of account-wide
	 * burn, which is not derivable from what this proxy records, so each side of
	 * the scale is computed at the pessimistic end of that unknown. A bound errs
	 * toward advising restraint and must not be presented as an exact answer.
	 */
	headroomBasis: PublicHeadroomBasisDto;
	/** Why no headroom is stated. Never a stand-in for zero. */
	headroomAbsence: PublicHeadroomAbsenceDto | null;
	/**
	 * How well-evidenced `outcomeKind` / `exhaustsAt` are — a DIFFERENT claim
	 * from `headroomBasis`, which is about the headroom.
	 *
	 * `structural` means some window the outcome rests on has no full-confidence
	 * estimate behind it: usually a scoped family window, which carries no
	 * prediction and no burn anchor and so drifts LATER while a reading is stale
	 * (optimistic drift), but a class row earns it too when its weekly window has
	 * no honest observation time.
	 *
	 * Which windows "the outcome rests on" depends on what the row claims. A
	 * stated instant rests on the windows that CAUSE it; a `beyond_horizon` rests
	 * on every window that could have run out and did not. Null on `unknown` and
	 * `no_accounts`, which assert nothing.
	 */
	projectionBasis: PublicProjectionBasisDto | null;
	/**
	 * Accounts considered for this workload.
	 *
	 * Not the same as the number PROJECTED from: subtract `unreadableAccounts`
	 * for that. Rendering only this one lets a bar claim five accounts of depth
	 * behind a projection built on three.
	 */
	eligibleAccounts: number;
	/**
	 * Of those, the ones with no readable window for this workload.
	 *
	 * Their exclusion can only shorten a runway, so `exhaustsAt` is a lower bound
	 * whenever this is above zero — never a fabricated number, but not the whole
	 * picture either.
	 */
	unreadableAccounts: number;
	/** Of the eligible ones, those already at or past 100% on any pooled window. */
	spentAccounts: number;
}

export type PublicWorkloadDimensionDto = "class" | "family" | "other";
export type PublicHeadroomBasisDto = "exact" | "conservative_bound" | "other";
export type PublicHeadroomAbsenceDto =
	| "beyond_probe_range"
	| "not_projected"
	| "bound_broken_by_credits"
	| "other";
export type PublicProjectionBasisDto = "measured" | "structural" | "other";

function toPublicWorkloadDimension(kind: string): PublicWorkloadDimensionDto {
	switch (kind) {
		case "class":
			return "class";
		case "family":
			return "family";
		default:
			return "other";
	}
}

function toPublicHeadroomBasis(basis: string): PublicHeadroomBasisDto {
	switch (basis) {
		case "exact":
			return "exact";
		case "conservative-bound":
			return "conservative_bound";
		default:
			return "other";
	}
}

function toPublicHeadroomAbsence(
	absence: string | null,
): PublicHeadroomAbsenceDto | null {
	if (absence == null) return null;
	switch (absence) {
		case "beyond-probe-range":
			return "beyond_probe_range";
		case "not-projected":
			return "not_projected";
		case "bound-broken-by-credits":
			return "bound_broken_by_credits";
		default:
			return "other";
	}
}

function toPublicProjectionBasis(
	basis: string | null,
): PublicProjectionBasisDto | null {
	// Null stays null: an outcome that asserts nothing has no projection whose
	// evidence could be characterised, and mapping it to `measured` would be the
	// most reassuring possible answer to the least informative scan.
	if (basis == null) return null;
	switch (basis) {
		case "measured":
			return "measured";
		case "structural":
			return "structural";
		default:
			return "other";
	}
}

export interface PublicWorkloadHeadroomDto {
	schema: typeof PUBLIC_WORKLOAD_HEADROOM_SCHEMA;
	generatedAt: string;
	horizonMs: number;
	rows: PublicWorkloadHeadroomRowDto[];
}

/**
 * Project the workload scan onto the wire.
 *
 * The POOL-LEVEL headroom is deliberately absent here: it is published on
 * `/public/v1/runway`, where the scan that computes it lives, and restating it
 * would put one measurement in two places for the two to drift apart. The rows
 * here are per class and per family — different measurements of a different
 * thing, not a second copy of that one.
 */
export function toPublicWorkloadHeadroomDto(snapshot: {
	generatedAtMs: number;
	horizonMs: number;
	rows: readonly WorkloadHeadroomRow[];
}): PublicWorkloadHeadroomDto {
	return {
		schema: PUBLIC_WORKLOAD_HEADROOM_SCHEMA,
		generatedAt: new Date(snapshot.generatedAtMs).toISOString(),
		horizonMs: snapshot.horizonMs,
		rows: snapshot.rows.map((row) => ({
			nextReset: row.nextReset
				? {
						resetsAt: instant(row.nextReset.resetsAtMs),
						outcomeKind: toPublicRunwayKind(row.nextReset.outcome.kind),
						exhaustsAt:
							row.nextReset.outcome.kind === "runway"
								? instant(row.nextReset.outcome.exhaustsAtMs)
								: null,
						headroomPct: row.nextReset.headroom?.pct ?? null,
						headroomDirection: row.nextReset.headroom
							? toPublicHeadroomDirection(row.nextReset.headroom.direction)
							: null,
						projectionBasis: toPublicProjectionBasis(
							row.nextReset.projectionBasis,
						),
					}
				: null,
			dimensionKind: toPublicWorkloadDimension(row.dimensionKind),
			dimensionId: identifier(row.dimensionId),
			label: text(row.label),
			outcomeKind: toPublicRunwayKind(row.outcome.kind),
			exhaustsAt:
				row.outcome.kind === "runway"
					? instant(row.outcome.exhaustsAtMs)
					: null,
			headroomPct: row.headroom?.pct ?? null,
			headroomDirection:
				row.headroom === null
					? null
					: toPublicHeadroomDirection(row.headroom.direction),
			headroomBasis: toPublicHeadroomBasis(row.basis),
			headroomAbsence: toPublicHeadroomAbsence(row.headroomAbsence),
			projectionBasis: toPublicProjectionBasis(row.projectionBasis),
			eligibleAccounts: row.eligibleAccountIds.length,
			unreadableAccounts: row.unreadableAccountIds.length,
			spentAccounts: row.spentAccountIds.length,
		})),
	};
}
