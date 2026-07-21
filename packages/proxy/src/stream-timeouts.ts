import { TIME_CONSTANTS } from "@clankermux/core";

/**
 * Env-aware stream-forward timeouts, shared by forwardToClient's streaming
 * passthrough (response-handler.ts) and the overload probe-lease safety TTL
 * (provider-overload-cooldown.ts) so the two can never drift: the TTL must
 * cover the longest a legitimate probe stream can still be in flight, which
 * is governed by these same values.
 *
 * `CF_STREAM_TOTAL_TIMEOUT_MS` / `CF_STREAM_CHUNK_TIMEOUT_MS` support long
 * agentic workloads where nested sub-calls leave the outer stream silent for
 * extended periods (issue #84). Read per call (not at module load) so a
 * runtime change to the env var is honored without a server restart —
 * matching the historical read-per-forward behavior in response-handler.ts
 * (`Number(env ?? default)`, preserved verbatim so the parsing cannot drift).
 */
export function getStreamForwardTotalTimeoutMs(): number {
	return Number(
		process.env.CF_STREAM_TOTAL_TIMEOUT_MS ??
			TIME_CONSTANTS.STREAM_FORWARD_TOTAL_TIMEOUT_MS,
	);
}

export function getStreamForwardChunkTimeoutMs(): number {
	return Number(
		process.env.CF_STREAM_CHUNK_TIMEOUT_MS ??
			TIME_CONSTANTS.STREAM_FORWARD_CHUNK_TIMEOUT_MS,
	);
}
