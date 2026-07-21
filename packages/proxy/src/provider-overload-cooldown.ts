/**
 * Model-family-scoped circuit breaker for upstream overload (529 / SSE
 * `overloaded_error`).
 *
 * Why family-scoped: Anthropic incidents are frequently confined to one model
 * family (e.g. a Haiku-only 529 storm). A single provider-wide bucket would
 * gate Opus/Sonnet/Fable off a Haiku signal. Buckets are keyed
 * `${providerKey}:${family}` when the tripping request's model resolves to a
 * family, and the bare `${providerKey}` (provider-wide) when it doesn't —
 * the provider-wide bucket conservatively gates every family.
 *
 * State machine per bucket:
 * - **closed**: no entry. Requests flow freely.
 * - **open**: `until > now`. Requests are gated until the deadline.
 * - **half-open**: `until <= now` but the entry persists. Exactly one probe
 *   request may be admitted (single-flight lease); everyone else keeps
 *   waiting so an expiring cooldown doesn't stampede a still-sick upstream.
 *   The entry is deleted only on probe success ("recovered") or explicit
 *   operator clear.
 *
 * Probe tokens carry the bucket generation and lease identity so that late
 * completions (after a re-trip, a clear, or a lease-TTL takeover) are
 * harmless no-ops.
 */

import {
	getModelFamily,
	type ModelFamily,
	TIME_CONSTANTS,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { PROVIDER_NAMES } from "@clankermux/types";
import { getStreamForwardTotalTimeoutMs } from "./stream-timeouts";

const log = new Logger("ProviderOverloadCooldown");

const DEFAULT_PROVIDER_OVERLOAD_COOLDOWN_MS = 60_000;
const MAX_PROVIDER_OVERLOAD_COOLDOWN_MS = 5 * 60_000;
export const ANTHROPIC_UPSTREAM_OVERLOAD_KEY = "anthropic-upstream";

/**
 * Safety margin added on top of the request + stream-forward timeouts when
 * computing a probe lease's TTL: the timeouts bound the upstream fetch and the
 * stream forward themselves, but the verdict callbacks fire a beat after —
 * the margin keeps a legitimately-slow completion from racing a TTL takeover.
 */
const PROBE_LEASE_SAFETY_MARGIN_MS = 60_000;

/**
 * A probe whose owner dies without completing must not wedge the bucket
 * forever. Past this TTL the lease is treated as released and another
 * request may probe; the stale token's later completion no-ops via the
 * lease-identity check. Composed from the request-header timeout plus the
 * total stream-forward timeout — the longest a legitimate probe request
 * can possibly still be in flight — plus a safety margin. Computed per
 * lease acquisition (not at module load) because forwardToClient honors the
 * `CF_STREAM_TOTAL_TIMEOUT_MS` runtime override; the TTL must track the
 * same effective value or a long-configured stream would outlive its lease.
 */
export function getProbeLeaseSafetyTtlMs(): number {
	return (
		TIME_CONSTANTS.PROXY_REQUEST_TIMEOUT_MS +
		getStreamForwardTotalTimeoutMs() +
		PROBE_LEASE_SAFETY_MARGIN_MS
	);
}

export type OverloadBreakerState = "closed" | "open" | "half-open";

export interface OverloadBreakerStatus {
	state: OverloadBreakerState;
	/** Effective block deadline while open; null when closed or half-open. */
	until: number | null;
	/** True while a probe lease is held on any relevant bucket. */
	probeActive: boolean;
}

interface ProbeLease {
	key: string;
	generation: number;
	leaseId: number;
}

/**
 * Opaque handle returned by {@link tryAcquireProviderOverloadProbe}. Covers
 * every half-open bucket the probing request leased (family and/or
 * provider-wide). Pass it back to {@link completeProviderOverloadProbe}.
 */
export interface OverloadProbeToken {
	readonly leases: readonly ProbeLease[];
}

export type ProbeAdmission =
	| { admitted: true; token: OverloadProbeToken | null }
	| { admitted: false; reason: "open" | "probe-active"; until: number | null };

export interface OverloadBucketSnapshot {
	family: ModelFamily | null;
	state: OverloadBreakerState;
	until: number | null;
	probeActive: boolean;
}

interface OverloadBucket {
	until: number;
	/**
	 * Globally-monotonic trip marker. Every trip (including a fresh bucket
	 * after a clear) gets a new value, so any token minted before the trip
	 * fails the generation check and its completion no-ops.
	 */
	generation: number;
	/**
	 * `ttlMs` is captured at acquisition time from the then-effective
	 * env-aware stream timeout (see {@link getProbeLeaseSafetyTtlMs}) so a
	 * runtime override change never shortens an already-issued lease.
	 */
	probe: { leaseId: number; acquiredAt: number; ttlMs: number } | null;
}

const buckets = new Map<string, OverloadBucket>();
let generationCounter = 0;
let leaseIdCounter = 0;

function normalizeUntil(candidate: number | undefined, now: number): number {
	if (candidate && Number.isFinite(candidate) && candidate > now) {
		return Math.min(candidate, now + MAX_PROVIDER_OVERLOAD_COOLDOWN_MS);
	}
	return now + DEFAULT_PROVIDER_OVERLOAD_COOLDOWN_MS;
}

/**
 * Official Anthropic upstream in any of its provider spellings: OAuth
 * ("anthropic"), the legacy OAuth alias ("claude-oauth"), and Console API
 * key accounts ("claude-console-api"). All three hit api.anthropic.com and
 * share overload fate, so they collapse to one breaker key — and the SSE
 * sniffer uses this same predicate for its `overloaded_error` allow-list.
 */
export function isOfficialAnthropicProvider(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === "claude-oauth" ||
		provider === PROVIDER_NAMES.CLAUDE_CONSOLE_API
	);
}

export function getProviderOverloadKey(provider: string): string {
	return isOfficialAnthropicProvider(provider)
		? ANTHROPIC_UPSTREAM_OVERLOAD_KEY
		: provider;
}

/**
 * Single source of truth for the key derivation every keying helper shares:
 * the collapsed provider key, the model's family (null when the model is
 * absent/unresolvable), and the composite family bucket key (null exactly
 * when family is null).
 */
function resolveOverloadKeyParts(
	provider: string,
	model?: string | null,
): {
	providerKey: string;
	family: ModelFamily | null;
	familyKey: string | null;
} {
	const providerKey = getProviderOverloadKey(provider);
	const family = model ? getModelFamily(model) : null;
	return {
		providerKey,
		family,
		familyKey: family ? `${providerKey}:${family}` : null,
	};
}

function bucketKey(provider: string, model?: string | null): string {
	const { providerKey, familyKey } = resolveOverloadKeyParts(provider, model);
	return familyKey ?? providerKey;
}

/**
 * Bucket keys a request with this (provider, model) is gated by. With a
 * resolvable model: the family bucket plus the provider-wide bucket. Without
 * one: every bucket of the provider (conservative aggregate — a caller with
 * no request context must respect all of them).
 */
function relevantKeys(provider: string, model?: string | null): string[] {
	const { providerKey, familyKey } = resolveOverloadKeyParts(provider, model);
	if (familyKey) {
		return [familyKey, providerKey];
	}
	const keys: string[] = [];
	for (const key of buckets.keys()) {
		if (key === providerKey || key.startsWith(`${providerKey}:`)) {
			keys.push(key);
		}
	}
	return keys;
}

function isLeaseActive(bucket: OverloadBucket, now: number): boolean {
	return (
		bucket.probe !== null && now - bucket.probe.acquiredAt < bucket.probe.ttlMs
	);
}

/**
 * Trip (or re-trip) the breaker for this provider/model. Extends but never
 * shortens the bucket's deadline; caps at 5 minutes; defaults to 60s when no
 * usable reset hint is given. A re-trip bumps the bucket generation and
 * clears any active probe lease, invalidating outstanding tokens.
 *
 * When the model is absent/unresolvable this trips the provider-wide bucket.
 * The extend comparison is against the raw provider-wide entry only — never
 * the family aggregate — so an existing longer family deadline is not
 * promoted into the bucket that gates every family.
 */
export function applyProviderOverloadCooldown(
	provider: string,
	resetTime?: number,
	model?: string | null,
): number {
	const now = Date.now();
	const key = bucketKey(provider, model);
	const until = normalizeUntil(resetTime, now);
	const bucket = buckets.get(key);
	// A half-open bucket's stale past deadline loses the max() naturally.
	const effectiveUntil = bucket ? Math.max(bucket.until, until) : until;

	buckets.set(key, {
		until: effectiveUntil,
		generation: ++generationCounter,
		probe: null,
	});
	log.warn(
		`Overload breaker ${key} open until ${new Date(effectiveUntil).toISOString()}`,
	);
	return effectiveUntil;
}

/**
 * Effective block-until for gates/holds, or null if the request is
 * attemptable. Half-open buckets read as null — probe admission is enforced
 * separately via {@link tryAcquireProviderOverloadProbe}. Pure: never mutates
 * bucket or lease state.
 */
export function getProviderOverloadUntil(
	provider: string,
	now = Date.now(),
	model?: string | null,
): number | null {
	let max: number | null = null;
	for (const key of relevantKeys(provider, model)) {
		const bucket = buckets.get(key);
		if (bucket && bucket.until > now && (max === null || bucket.until > max)) {
			max = bucket.until;
		}
	}
	return max;
}

/**
 * Block-until of the PROVIDER-WIDE bucket alone — family buckets are ignored,
 * and a half-open provider-wide bucket reads as null. For consumers that must
 * not react to family-scoped incidents, e.g. the Primary-badge predictor: a
 * Haiku-only open bucket must not move the badge off an account whose
 * Sonnet/Opus traffic still routes normally. Pure: never mutates state.
 */
export function getProviderWideOverloadUntil(
	provider: string,
	now = Date.now(),
): number | null {
	const bucket = buckets.get(getProviderOverloadKey(provider));
	return bucket && bucket.until > now ? bucket.until : null;
}

export function isProviderOverloaded(
	provider: string,
	now = Date.now(),
	model?: string | null,
): boolean {
	return getProviderOverloadUntil(provider, now, model) !== null;
}

/**
 * Combined breaker status across the buckets relevant to (provider, model):
 * open dominates half-open dominates closed. Pure inspection — never mutates
 * lease state.
 */
export function inspectProviderOverload(
	provider: string,
	model?: string | null,
	now = Date.now(),
): OverloadBreakerStatus {
	let until: number | null = null;
	let halfOpen = false;
	let probeActive = false;
	for (const key of relevantKeys(provider, model)) {
		const bucket = buckets.get(key);
		if (!bucket) continue;
		if (bucket.until > now) {
			if (until === null || bucket.until > until) until = bucket.until;
		} else {
			halfOpen = true;
		}
		if (isLeaseActive(bucket, now)) probeActive = true;
	}
	if (until !== null) return { state: "open", until, probeActive };
	if (halfOpen) return { state: "half-open", until: null, probeActive };
	return { state: "closed", until: null, probeActive: false };
}

/**
 * Semaphore key for the transparent overload hold (see proxy.ts /
 * overload-hold.ts): the bucket that actually gates this (provider, model).
 * A LIVE provider-wide bucket wins over the family bucket — during a
 * provider-wide incident every family is gated by that one bucket, so its
 * holders must share ONE cap rather than getting a full cap per family
 * (which would multiply the incident's held connections). With no live
 * provider-wide bucket: the family bucket when one exists, else the key the
 * request WOULD trip (deterministic even when no bucket is live, so a racing
 * clear can't strand holders on mismatched keys).
 */
export function getOverloadHoldSlotKey(
	provider: string,
	model?: string | null,
): string {
	const { providerKey, familyKey } = resolveOverloadKeyParts(provider, model);
	if (!familyKey) return providerKey;
	if (buckets.has(providerKey)) return providerKey;
	if (buckets.has(familyKey)) return familyKey;
	return familyKey;
}

/**
 * Single-flight probe admission. If every relevant bucket is closed, the
 * request needs no probe (`token: null`). If any is still open, admission is
 * refused with the block deadline. Otherwise a lease is acquired on every
 * half-open relevant bucket and a composite token is returned — the caller
 * MUST eventually call {@link completeProviderOverloadProbe} with it.
 */
export function tryAcquireProviderOverloadProbe(
	provider: string,
	model?: string | null,
	now = Date.now(),
): ProbeAdmission {
	const keys = relevantKeys(provider, model);

	const openUntil = getProviderOverloadUntil(provider, now, model);
	if (openUntil !== null) {
		return { admitted: false, reason: "open", until: openUntil };
	}

	const halfOpenKeys: string[] = [];
	for (const key of keys) {
		const bucket = buckets.get(key);
		if (!bucket) continue;
		if (isLeaseActive(bucket, now)) {
			return { admitted: false, reason: "probe-active", until: null };
		}
		halfOpenKeys.push(key);
	}
	if (halfOpenKeys.length === 0) {
		return { admitted: true, token: null };
	}

	const leases: ProbeLease[] = [];
	// TTL snapshot at acquisition: every lease of this admission shares the
	// same env-aware deadline.
	const ttlMs = getProbeLeaseSafetyTtlMs();
	for (const key of halfOpenKeys) {
		const bucket = buckets.get(key);
		if (!bucket) continue;
		const leaseId = ++leaseIdCounter;
		bucket.probe = { leaseId, acquiredAt: now, ttlMs };
		leases.push({ key, generation: bucket.generation, leaseId });
	}
	log.info(
		`Overload probe admitted for ${halfOpenKeys.join(", ")} (single-flight)`,
	);
	return { admitted: true, token: { leases } };
}

/**
 * Report a probe outcome. Idempotent, and a strict no-op for stale tokens:
 * each lease only acts if its bucket still exists, the generation matches
 * (no re-trip since), and the lease identity matches (no TTL takeover).
 *
 * - "recovered": upstream answered healthily — delete the bucket(s).
 * - "reopened": the probe hit overload again — release the lease; the
 *   failure site re-trips via {@link applyProviderOverloadCooldown}.
 * - "abandoned": the probe never got a verdict — release the lease so
 *   another request may probe.
 */
export function completeProviderOverloadProbe(
	token: OverloadProbeToken | null,
	outcome: "recovered" | "reopened" | "abandoned",
): void {
	if (!token) return;
	for (const lease of token.leases) {
		const bucket = buckets.get(lease.key);
		if (!bucket) continue;
		if (bucket.generation !== lease.generation) continue;
		if (!bucket.probe || bucket.probe.leaseId !== lease.leaseId) continue;

		if (outcome === "recovered") {
			buckets.delete(lease.key);
			log.info(`Overload breaker ${lease.key} closed (probe recovered)`);
		} else {
			bucket.probe = null;
		}
	}
}

/**
 * Operator clear (dashboard force-reset). With a provider: removes all of
 * its buckets, family and provider-wide. Without: removes everything.
 * Outstanding probe tokens are implicitly invalidated — their buckets are
 * gone, so late completions no-op.
 */
export function clearProviderOverloadCooldown(provider?: string): void {
	if (provider) {
		const providerKey = getProviderOverloadKey(provider);
		for (const key of [...buckets.keys()]) {
			if (key === providerKey || key.startsWith(`${providerKey}:`)) {
				buckets.delete(key);
			}
		}
		return;
	}
	buckets.clear();
}

/**
 * Dashboard snapshot: every open/half-open bucket of the provider, with the
 * family parsed back out of the key (null = provider-wide bucket).
 */
export function getProviderOverloadSnapshot(
	provider: string,
	now = Date.now(),
): OverloadBucketSnapshot[] {
	const providerKey = getProviderOverloadKey(provider);
	const snapshot: OverloadBucketSnapshot[] = [];
	for (const [key, bucket] of buckets) {
		if (key !== providerKey && !key.startsWith(`${providerKey}:`)) continue;
		const family =
			key === providerKey
				? null
				: (key.slice(providerKey.length + 1) as ModelFamily);
		const open = bucket.until > now;
		snapshot.push({
			family,
			state: open ? "open" : "half-open",
			until: open ? bucket.until : null,
			probeActive: isLeaseActive(bucket, now),
		});
	}
	return snapshot;
}
