import { TIME_CONSTANTS } from "@clankermux/core";

/**
 * Stream-forward timeouts, shared by forwardToClient's streaming passthrough
 * (response-handler.ts) and the overload probe-lease safety TTL
 * (provider-overload-cooldown.ts) so the two can never drift: the TTL must
 * cover the longest a legitimate probe stream can still be in flight, which
 * is governed by these same values.
 *
 * The total (30 min) / chunk (5 min) timeouts are sized to support long
 * agentic workloads where nested sub-calls leave the outer stream silent for
 * extended periods (issue #84). Exposed as accessors (rather than raw
 * constants) so every consumer resolves the same effective value.
 */
export function getStreamForwardTotalTimeoutMs(): number {
	return TIME_CONSTANTS.STREAM_FORWARD_TOTAL_TIMEOUT_MS;
}

export function getStreamForwardChunkTimeoutMs(): number {
	return TIME_CONSTANTS.STREAM_FORWARD_CHUNK_TIMEOUT_MS;
}
