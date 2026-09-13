import type { RequestMeta } from "@clankermux/types";

/**
 * (account, resolved model) pairs a definitive upstream rejection has taken out
 * of play for the REMAINDER of one request.
 *
 * This does not replace the persisted suppression row, and is not a cache of
 * it. The persisted row is written from the response observer once the rejected
 * body has been read, so the next attempt of the SAME request can be chosen
 * before it lands; this set is written synchronously at the moment the
 * rejection is classified and is therefore the only thing that can be
 * authoritative within the request. The persisted row still owns every LATER
 * request.
 *
 * Keyed on the RequestMeta identity, so it dies with the request and is shared
 * by every path that re-derives candidates for it (attempt-preparation retries,
 * recovery holds, reselection).
 */
const excluded = new WeakMap<RequestMeta, Set<string>>();

/** Same shape as `BuildRouteInput.suppressedPairs`, so the two never diverge. */
function pairKey(accountId: string, upstreamModel: string): string {
	return JSON.stringify([accountId, upstreamModel]);
}

export function excludeModelForRequest(
	meta: RequestMeta,
	accountId: string,
	upstreamModel: string,
): void {
	let pairs = excluded.get(meta);
	if (!pairs) {
		pairs = new Set<string>();
		excluded.set(meta, pairs);
	}
	pairs.add(pairKey(accountId, upstreamModel));
}

export function isModelExcludedForRequest(
	meta: RequestMeta,
	accountId: string,
	upstreamModel: string,
): boolean {
	return excluded.get(meta)?.has(pairKey(accountId, upstreamModel)) ?? false;
}
