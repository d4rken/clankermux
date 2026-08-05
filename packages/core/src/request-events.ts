import { EventEmitter } from "node:events";

/**
 * Emitted when a request finishes ingestion — body parsed, project resolved,
 * model known — and BEFORE an upstream account has been selected or called.
 *
 * This is what makes "in flight" mean something on the dashboard. `start` fires
 * only once the upstream has produced response headers, so between arrival and
 * first byte a request would otherwise be invisible.
 */
export type RequestIngressEvt = {
	type: "ingress";
	id: string;
	timestamp: number;
	method: string;
	path: string;
	project: string | null;
	/** Model resolved at ingress (the REQUESTED model — no upstream reply yet). */
	model: string | null;
};

/**
 * Terminal for a request that never reached `forwardToClient` and so will never
 * produce a `summary`: an admission rejection, a forced-account failure, a
 * pinned-target refusal, or a probe the recorder filters out.
 *
 * A consumer that sees this for a request still in its `pending` phase should
 * DISCARD it rather than render it as an error — these requests are not
 * recorded in Request History either, and the dashboard must not show marks for
 * traffic the rest of the app has no row for.
 */
export type RequestIngressEndEvt = {
	type: "ingress-end";
	id: string;
	/** `null` when the request threw and no response was ever produced — the
	 *  bus is untyped, so this has to be honest rather than invent a status. */
	statusCode: number | null;
};

export type RequestStartEvt = {
	type: "start";
	id: string;
	timestamp: number;
	method: string;
	path: string;
	accountId: string | null;
	statusCode: number;
	/** Mirrors {@link RequestIngressEvt.project}; present so a consumer that
	 *  missed the ingress event can still attribute the request. */
	project: string | null;
	/** The requested model, for the same reason as `project`. */
	model: string | null;
};

export type RequestSummaryEvt = {
	type: "summary";
	payload: import("@clankermux/types").RequestResponse;
};

export type RequestEvt =
	| RequestIngressEvt
	| RequestIngressEndEvt
	| RequestStartEvt
	| RequestSummaryEvt;

/** Phase of a request that has not yet produced a terminal event. */
export type ActiveRequestPhase = "pending" | "streaming";

/** One in-flight request, as replayed to a newly-connected dashboard. */
export interface ActiveRequestEntry {
	id: string;
	/** Ingress timestamp — when the client's request arrived, not when the
	 *  upstream replied. This is where the mark belongs on a time axis. */
	timestamp: number;
	method: string;
	path: string;
	project: string | null;
	model: string | null;
	phase: ActiveRequestPhase;
	/** Known only once `start` has fired. */
	accountId: string | null;
	/** Upstream status, known only once `start` has fired. */
	statusCode: number | null;
}

/**
 * Snapshot of everything in flight, sent to a client the moment it connects.
 * Never emitted on the bus — the SSE handler synthesises it per connection.
 */
export type RequestSnapshotEvt = {
	type: "snapshot";
	active: ActiveRequestEntry[];
};

/** What actually goes over the wire to a dashboard client. */
export type RequestStreamEvt = RequestEvt | RequestSnapshotEvt;

/** Hard ceiling on tracked in-flight requests. */
export const ACTIVE_REQUEST_MAX_ENTRIES = 500;
/** Age past which an unsettled request is presumed dead and dropped. */
export const ACTIVE_REQUEST_TTL_MS = 15 * 60 * 1000;
/**
 * Memory backstop on start markers. Far above any real concurrency: markers are
 * consumed by the one caller that asks, so the live size tracks the number of
 * requests currently inside `handleProxy`, not the request RATE.
 */
const STARTED_ID_MAX_ENTRIES = 10_000;

class RequestEventBus extends EventEmitter {}
export const requestEvents = new RequestEventBus();

// Set a more generous max listeners limit for SSE connections
// This allows for more concurrent SSE connections while still providing protection
requestEvents.setMaxListeners(200); // Increased from 50 to allow more concurrent SSE connections

/**
 * Internal shape: the public entry plus when it entered the registry.
 *
 * Eviction ages entries by `insertedAt` rather than `timestamp` on purpose.
 * `timestamp` is a DISPLAY value taken from the request — a failover attempt
 * carries its own, and a caller could hand over anything — so ageing on it
 * makes the sweep's ordering assumption unsound. `insertedAt` comes from the
 * registry's own clock, so insertion order and age order are the same order,
 * which is what lets the sweep below stop at the first young entry.
 */
interface TrackedRequest extends ActiveRequestEntry {
	insertedAt: number;
}

/**
 * Unsettled requests, insertion-ordered (Map preserves it), so eviction past
 * the cap drops the oldest.
 */
const active = new Map<string, TrackedRequest>();

/**
 * Ids that reached `forwardToClient`, kept SEPARATELY from `active` and
 * deliberately NOT cleared when a request settles.
 *
 * `handleProxy` asks "did this ever start?" to decide whether to emit a
 * synthetic terminal. For a non-streaming response the summary can land before
 * it gets to ask, so reading the answer out of `active` would say "never
 * started" for a request that completed normally and retract it.
 *
 * Aged out by TTL rather than by count. A FIFO cap would make the answer for
 * ONE request depend on how many UNRELATED requests started in between: under a
 * burst larger than the cap, a long-running stream's marker could be evicted
 * before its own invocation asked, and the retraction would erase a live
 * request from the dashboard. Time cannot be raced that way.
 */
const startedIds = new Map<string, number>();

let clock: () => number = Date.now;

/** Drop entries past the TTL, then past the size cap (oldest first). */
function evict(): void {
	const cutoff = clock() - ACTIVE_REQUEST_TTL_MS;
	for (const [id, entry] of active) {
		// Insertion order IS age order (see TrackedRequest), so the first entry
		// that is young enough ends the sweep.
		if (entry.insertedAt > cutoff) break;
		active.delete(id);
	}
	while (active.size > ACTIVE_REQUEST_MAX_ENTRIES) {
		const oldest = active.keys().next();
		if (oldest.done) break;
		active.delete(oldest.value);
	}
}

function markStarted(id: string): void {
	const now = clock();
	startedIds.set(id, now);

	// TTL sweep; insertion order is age order, so stop at the first young one.
	const cutoff = now - ACTIVE_REQUEST_TTL_MS;
	for (const [markedId, at] of startedIds) {
		if (at > cutoff) break;
		startedIds.delete(markedId);
	}

	// Pure memory backstop, only reachable if something is leaking markers.
	while (startedIds.size > STARTED_ID_MAX_ENTRIES) {
		const oldest = startedIds.keys().next();
		if (oldest.done) break;
		startedIds.delete(oldest.value);
	}
}

/**
 * Registry listener. Registered once at module load, before any SSE client
 * subscribes. EventEmitter dispatch is synchronous, so by the time an emitter
 * returns, the registry already reflects the event.
 */
requestEvents.on("event", (evt: RequestEvt) => {
	switch (evt.type) {
		case "ingress": {
			// A late ingress must never revert a request that is already
			// streaming — the phases only ever move forward.
			if (active.has(evt.id)) return;
			active.set(evt.id, {
				id: evt.id,
				timestamp: evt.timestamp,
				method: evt.method,
				path: evt.path,
				project: evt.project,
				model: evt.model,
				phase: "pending",
				accountId: null,
				statusCode: null,
				insertedAt: clock(),
			});
			evict();
			return;
		}
		case "start": {
			markStarted(evt.id);
			const existing = active.get(evt.id);
			active.set(evt.id, {
				id: evt.id,
				// Keep the ingress timestamp when we have one: it is when the
				// request arrived. On failover the later attempts carry their
				// own timestamp and the mark must not jump forward.
				timestamp: existing?.timestamp ?? evt.timestamp,
				method: evt.method,
				path: evt.path,
				project: evt.project ?? existing?.project ?? null,
				model: evt.model ?? existing?.model ?? null,
				phase: "streaming",
				accountId: evt.accountId,
				statusCode: evt.statusCode,
				// Re-setting an existing key keeps its position in the Map, so
				// its original insertion age must be kept too or age order and
				// insertion order would diverge.
				insertedAt: existing?.insertedAt ?? clock(),
			});
			evict();
			return;
		}
		case "summary":
			active.delete(evt.payload.id);
			return;
		case "ingress-end":
			active.delete(evt.id);
			return;
	}
});

/** Everything in flight right now, oldest first. */
export function getActiveRequests(): ActiveRequestEntry[] {
	evict();
	// `insertedAt` is registry bookkeeping, not part of the wire contract.
	return Array.from(active.values(), ({ insertedAt: _, ...entry }) => entry);
}

/** Whether `id` ever reached `forwardToClient` (and so will be summarized). */
export function hasRequestStarted(id: string): boolean {
	return startedIds.has(id);
}

/**
 * Read the start marker for `id` and drop it.
 *
 * The question is asked exactly once per request, at the end of `handleProxy`,
 * so consuming keeps the marker table sized by in-flight concurrency rather
 * than by cumulative request count.
 */
export function consumeRequestStarted(id: string): boolean {
	const started = startedIds.has(id);
	startedIds.delete(id);
	return started;
}

/**
 * Test seam: clear the registry and optionally install a deterministic clock
 * for TTL eviction. Not used in production.
 */
export function resetRequestEventRegistry(now?: () => number): void {
	active.clear();
	startedIds.clear();
	clock = now ?? Date.now;
}
