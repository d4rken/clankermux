/**
 * The `/public/v1/*` wire contract, and the ONLY place it is constructed.
 *
 * Every DTO here is built from a NAMED FIELD LIST. Nothing serializes an
 * internal object and deletes what it does not want: that pattern leaks a field
 * the moment someone adds one upstream, and this surface is unauthenticated.
 * `AccountResponse` in particular carries identity, tokens and endpoint
 * configuration, none of which may cross this boundary.
 *
 * The consumer is a streaming JSON scanner on an ESP32-C6, so the shape
 * constraints below are structural limits of the reader, not preferences:
 *
 *  - ONE record array, and at most ONE array nested inside it. `accounts[]`
 *    with `limits[]` inside spends the entire budget; there is no third level
 *    anywhere in this surface and none may be added.
 *  - Object nesting stays far below 16 deep.
 *  - Every timestamp is epoch MILLISECONDS as an integer. The single exception
 *    is `nowIso` on `/public/v1/status`, which exists because that field is the
 *    device's only wall clock.
 *  - Strings are truncated to 96 bytes, UTF-8 safe.
 *  - Every closed enum has an explicit `other` member and maps anything
 *    unrecognized to it. The firmware treats these as closed sets and lights a
 *    warning on an unknown value, so without `other` any future enum addition
 *    would be a breaking change for it.
 *  - NO field name begins with `identity`. The device asserts their absence.
 */

import type { RequestResponse } from "@clankermux/types";
import type {
	PublicAccountSnapshot,
	PublicLimitSnapshot,
	PublicSnapshot,
} from "../../services/public-snapshot";

/**
 * Wire schema identifier, carried on every response and on the stream's
 * snapshot. A device pins this and refuses a payload it does not know, so it
 * changes only when the shape changes incompatibly.
 */
export const PUBLIC_SCHEMA = "clankermux.public.v1";

/** Byte ceiling on every string this surface emits. */
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

/** Truncate, preserving null. */
function str(value: string | null | undefined): string | null {
	return value == null ? null : truncateUtf8(value);
}

/**
 * Account health, as a CLOSED set with an explicit escape hatch.
 *
 * `other` is not a bug bucket: it is the honest answer when the provider
 * reported a rate-limit status our vocabulary has not been taught. Reporting
 * `available` there is exactly how `rejected` went unnoticed once already.
 */
export type PublicHealth =
	| "available"
	| "paused"
	| "rate_limited"
	| "usage_exhausted"
	| "blocked"
	| "other";

/**
 * Map the internal rate-limit cause to public health.
 *
 * Paused outranks everything: a paused account is not routable for a reason
 * that has nothing to do with quota, and reporting its stale quota state would
 * tell the operator to wait for a reset that will not change anything.
 *
 * The remaining mapping is total over `RateLimitCause`, and the `default` arm
 * is what makes a FUTURE cause degrade to `other` rather than silently reading
 * as healthy.
 */
export function toPublicHealth(cause: string, paused: boolean): PublicHealth {
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
 * Why an account is paused, as a CLOSED set. Mirrors the values the proxy and
 * the dashboard actually write; anything else becomes `other` rather than
 * leaking a free-form string a device would have to render blind.
 */
export type PublicPauseReason =
	| "manual"
	| "failure_threshold"
	| "overage"
	| "peak_hours"
	| "oauth_invalid_grant"
	| "rate_limit_window"
	| "subscription_expired"
	| "other";

const KNOWN_PAUSE_REASONS = new Set<PublicPauseReason>([
	"manual",
	"failure_threshold",
	"overage",
	"peak_hours",
	"oauth_invalid_grant",
	"rate_limit_window",
	"subscription_expired",
]);

/** Null when the account is not paused; never a free-form string. */
export function toPublicPauseReason(
	reason: string | null,
	paused: boolean,
): PublicPauseReason | null {
	if (!paused) return null;
	if (reason && KNOWN_PAUSE_REASONS.has(reason as PublicPauseReason)) {
		return reason as PublicPauseReason;
	}
	return "other";
}

/** One usage window on the wire. */
export interface PublicLimitDto {
	kind: PublicLimitSnapshot["kind"];
	pct: number | null;
	resetsAt: number | null;
	label: string | null;
}

/** One account on the wire. Field list is exhaustive and hand-maintained. */
export interface PublicAccountDto {
	/** Stable id, so a stream event can be joined to a name. */
	id: string;
	name: string;
	provider: string;
	paused: boolean;
	pauseReason: PublicPauseReason | null;
	health: PublicHealth;
	utilizationPct: number | null;
	fiveHourPct: number | null;
	fiveHourResetsAt: number | null;
	sevenDayPct: number | null;
	sevenDayResetsAt: number | null;
	willExhaustBeforeReset: boolean;
	rateLimitResetAt: number | null;
	providerOverloadedUntil: number | null;
	providerWideOverloadedUntil: number | null;
	stale: boolean;
	limits: PublicLimitDto[];
}

export function toPublicAccountDto(
	account: PublicAccountSnapshot,
): PublicAccountDto {
	return {
		id: truncateUtf8(account.id),
		name: truncateUtf8(account.name),
		provider: truncateUtf8(account.provider),
		paused: account.paused,
		pauseReason: toPublicPauseReason(account.pauseReason, account.paused),
		health: toPublicHealth(account.cause, account.paused),
		utilizationPct: account.utilizationPct,
		fiveHourPct: account.fiveHourPct,
		fiveHourResetsAt: account.fiveHourResetsAt,
		sevenDayPct: account.sevenDayPct,
		sevenDayResetsAt: account.sevenDayResetsAt,
		willExhaustBeforeReset: account.willExhaustBeforeReset,
		rateLimitResetAt: account.rateLimitResetAt,
		providerOverloadedUntil: account.providerOverloadedUntil,
		providerWideOverloadedUntil: account.providerWideOverloadedUntil,
		stale: account.stale,
		limits: account.limits.map((limit) => ({
			kind: limit.kind,
			pct: limit.pct,
			resetsAt: limit.resetsAt,
			label: str(limit.label),
		})),
	};
}

/** `GET /public/v1/status`. No arrays at all. */
export interface PublicStatusDto {
	schema: string;
	status: "ok" | "degraded" | "unhealthy";
	now: number;
	/** The one non-epoch timestamp on this surface: the device's wall clock. */
	nowIso: string;
	uptimeS: number;
	version: string;
	pool: {
		configured: number;
		routable: number;
		paused: number;
		rateLimited: number;
		usageExhausted: number;
		nextAvailableAt: number | null;
	};
	usage: {
		fiveHourPct: number | null;
		sevenDayPct: number | null;
		worstAccountPct: number | null;
	};
	stale: boolean;
}

/**
 * The pool headline, computed from the same three facts `/health` uses so a
 * desk panel and a container health check cannot disagree.
 */
export function toPublicStatusLevel(
	pool: PublicSnapshot["pool"],
): PublicStatusDto["status"] {
	if (pool.configured === 0) return "unhealthy";
	if (pool.routable > 0) return "ok";
	return pool.nextAvailableAt !== null ? "degraded" : "unhealthy";
}

export function toPublicStatusDto(
	snapshot: PublicSnapshot,
	runtime: { uptimeS: number; version: string },
): PublicStatusDto {
	return {
		schema: PUBLIC_SCHEMA,
		status: toPublicStatusLevel(snapshot.pool),
		now: snapshot.now,
		nowIso: new Date(snapshot.now).toISOString(),
		uptimeS: runtime.uptimeS,
		version: truncateUtf8(runtime.version),
		pool: {
			configured: snapshot.pool.configured,
			routable: snapshot.pool.routable,
			paused: snapshot.pool.paused,
			rateLimited: snapshot.pool.rateLimited,
			usageExhausted: snapshot.pool.usageExhausted,
			nextAvailableAt: snapshot.pool.nextAvailableAt,
		},
		usage: {
			fiveHourPct: snapshot.usage.fiveHourPct,
			sevenDayPct: snapshot.usage.sevenDayPct,
			worstAccountPct: snapshot.usage.worstAccountPct,
		},
		stale: snapshot.stale,
	};
}

/** `GET /public/v1/accounts`. One record array, one nested array inside it. */
export interface PublicAccountsDto {
	schema: string;
	now: number;
	pooled: {
		fiveHourPct: number | null;
		sevenDayPct: number | null;
	};
	accounts: PublicAccountDto[];
}

export function toPublicAccountsDto(
	snapshot: PublicSnapshot,
): PublicAccountsDto {
	return {
		schema: PUBLIC_SCHEMA,
		now: snapshot.now,
		pooled: {
			fiveHourPct: snapshot.usage.fiveHourPct,
			sevenDayPct: snapshot.usage.sevenDayPct,
		},
		accounts: snapshot.accounts.map(toPublicAccountDto),
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
	startedAt: number;
	method: string;
	path: string;
	project: string | null;
	model: string | null;
	phase: "pending" | "streaming";
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
	now: number;
	active: PublicActiveRequestDto[];
}

/** A request arrived and was admitted; no upstream has been chosen yet. */
export interface PublicRequestOpenedDto {
	type: "request.opened";
	id: string;
	at: number;
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
	at: number;
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
	at: number;
	method: string;
	path: string;
	accountId: string | null;
	statusCode: number | null;
	success: boolean;
	rateLimited: boolean;
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

function isoToMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Map the internal summary payload.
 *
 * Two normalizations the internal event does not do, both because the internal
 * bus grew them separately and a device should not have to know that:
 *
 *  - `timestamp` is an ISO STRING internally and epoch ms here, like every
 *    other timestamp on this surface.
 *  - `accountUsed` is called `accountId` here, matching the `start`/`ingress`
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
	return {
		type: "request.done",
		id: truncateUtf8(payload.id),
		at: isoToMs(payload.timestamp) ?? now,
		method: truncateUtf8(payload.method),
		path: truncateUtf8(payload.path),
		accountId: str(payload.accountUsed),
		statusCode: payload.statusCode ?? null,
		success: payload.success === true,
		rateLimited: payload.rateLimited === true,
		responseTimeMs: payload.responseTimeMs ?? null,
		failoverAttempts: payload.failoverAttempts ?? 0,
		// The model actually used, falling back to the one the request named —
		// a failed request has the second and not the first.
		model: str(payload.model ?? payload.requestedModel ?? null),
		project: str(payload.project ?? null),
		totalTokens: payload.totalTokens ?? null,
		costUsd: payload.costUsd ?? null,
		errorMessage: str(payload.errorMessage),
	};
}
