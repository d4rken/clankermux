import type { RequestStreamEvt } from "@clankermux/core";
import type { RequestResponse } from "@clankermux/types";
import { NO_PROJECT_LABEL } from "./project-donut";

/**
 * Pure model behind the Overview's Live Activity lanes.
 *
 * Kept out of the component (mirroring `lib/active-sessions.ts` and
 * `lib/pool-usage.ts`) because most of the difficulty here is reconciliation,
 * not rendering: the same request arrives from three sources — the live SSE
 * stream, the connect-time in-flight snapshot, and the database backfill — and
 * those sources disagree about field shapes and can deliver out of order.
 */

export type LiveStatus =
	| "pending"
	| "streaming"
	| "ok"
	| "rate_limited"
	| "error"
	/** Was in flight; ended without us seeing how. Not a failure. */
	| "lost";

export interface LiveEvent {
	id: string;
	/** When the request ARRIVED — where the mark belongs on the time axis. */
	ts: number;
	project: string | null;
	model: string | null;
	tokens: number | null;
	status: LiveStatus;
	durationMs: number | null;
	tokensPerSecond: number | null;
	/** Account display name where resolvable, else whatever the source gave. */
	account: string | null;
}

/** Id-keyed store. Mutated in place by the `apply*` reducers below. */
export type LiveStore = Map<string, LiveEvent>;

export interface NormalizeContext {
	/** Resolve an account id to its display name; null when unknown. */
	accountName?: (id: string) => string | null;
}

/** Age at which an in-flight request with no terminal is presumed ended. */
export const LOST_AFTER_MS = 15 * 60 * 1000;

/** Default ceiling on retained events. */
export const MAX_LIVE_EVENTS = 1500;

const ACTIVE_STATUSES: ReadonlySet<LiveStatus> = new Set([
	"pending",
	"streaming",
]);

export function isActiveStatus(status: LiveStatus): boolean {
	return ACTIVE_STATUSES.has(status);
}

/**
 * Status precedence. An update is applied only when it does not move an event
 * backwards, so out-of-order delivery cannot resurrect a finished request.
 * Real terminals sit at the top and always win — including over `lost`, since
 * a known outcome must beat "we didn't see".
 */
const STATUS_RANK: Record<LiveStatus, number> = {
	pending: 0,
	streaming: 1,
	lost: 2,
	ok: 3,
	rate_limited: 3,
	error: 3,
};

/** A finite, non-negative number, or null. Guards charting NaN/-1/Infinity. */
function finiteNonNegative(value: number | null | undefined): number | null {
	if (value == null) return null;
	if (!Number.isFinite(value) || value < 0) return null;
	return value;
}

function resolveAccount(
	accountUsed: string | null | undefined,
	ctx: NormalizeContext | undefined,
): string | null {
	if (!accountUsed) return null;
	// Live events carry the account ID, the backfill endpoint carries the NAME.
	// A lookup miss means it was already a name (or an account since deleted),
	// so the raw value is the best available label either way.
	return ctx?.accountName?.(accountUsed) ?? accountUsed;
}

/**
 * Write `next` over the stored event for `id`, honouring status precedence and
 * preserving fields the update omits.
 *
 * The preserve rule is not cosmetic: `request-recorder`'s `patchUsage` re-emits
 * a SECOND summary for the same request once late usage resolves, and the two
 * summaries carry different subsets of the fields. A replace would blank
 * whatever the newer one happens not to know.
 *
 * @returns whether the store changed.
 */
function upsert(
	store: LiveStore,
	id: string,
	next: Partial<LiveEvent> & { status: LiveStatus; ts: number },
): boolean {
	const prior = store.get(id);
	if (prior && STATUS_RANK[next.status] < STATUS_RANK[prior.status]) {
		return false;
	}

	store.set(id, {
		id,
		// The arrival time never moves. A failover attempt emits its own start
		// with its own timestamp, and the mark must not creep rightwards as a
		// request is retried.
		ts: prior?.ts ?? next.ts,
		project: next.project ?? prior?.project ?? null,
		model: next.model ?? prior?.model ?? null,
		tokens: next.tokens ?? prior?.tokens ?? null,
		status: next.status,
		durationMs: next.durationMs ?? prior?.durationMs ?? null,
		tokensPerSecond: next.tokensPerSecond ?? prior?.tokensPerSecond ?? null,
		account: next.account ?? prior?.account ?? null,
	});
	return true;
}

/**
 * Normalize one `RequestResponse` — which is what BOTH the live summary event
 * and the history endpoint return, despite disagreeing on how they fill it in.
 *
 * Returns null when the row cannot be placed on a time axis at all.
 */
function fromRequestResponse(
	payload: RequestResponse,
	ctx: NormalizeContext | undefined,
): (Partial<LiveEvent> & { status: LiveStatus; ts: number }) | null {
	const ts = Date.parse(payload.timestamp);
	if (!Number.isFinite(ts)) return null;

	return {
		ts,
		project: payload.project ?? null,
		// `model` is the upstream-reported model and is absent until usage
		// resolves; `requestedModel` is known from ingestion onwards.
		model: payload.model ?? payload.requestedModel ?? null,
		tokens: finiteNonNegative(payload.totalTokens),
		durationMs: finiteNonNegative(payload.responseTimeMs),
		tokensPerSecond: finiteNonNegative(payload.tokensPerSecond),
		account: resolveAccount(payload.accountUsed, ctx),
		status: classifyOutcome(payload),
	};
}

/**
 * Terminal status for a completed request.
 *
 * Keyed on the STATUS CODE rather than `payload.rateLimited`: live recorder
 * summaries omit that field entirely while the history endpoint derives it, so
 * it is not a usable discriminator across both sources.
 */
function classifyOutcome(payload: RequestResponse): LiveStatus {
	if (payload.statusCode === 429) return "rate_limited";
	return payload.success ? "ok" : "error";
}

/**
 * Fold one event from the SSE stream into the store.
 *
 * @returns whether the store changed.
 */
export function applyStreamEvent(
	store: LiveStore,
	evt: RequestStreamEvt,
	ctx?: NormalizeContext,
): boolean {
	switch (evt.type) {
		case "ingress":
			return upsert(store, evt.id, {
				ts: evt.timestamp,
				project: evt.project,
				model: evt.model,
				status: "pending",
			});

		case "start":
			return upsert(store, evt.id, {
				ts: evt.timestamp,
				project: evt.project,
				model: evt.model,
				account: resolveAccount(evt.accountId, ctx),
				status: "streaming",
			});

		case "summary": {
			const next = fromRequestResponse(evt.payload, ctx);
			if (!next) return false;
			return upsert(store, evt.payload.id, next);
		}

		case "ingress-end": {
			// The request never reached the recorder, so it will never appear in
			// Request History. Retract the mark rather than drawing a failure —
			// the live view must show exactly what the Requests tab shows.
			const prior = store.get(evt.id);
			if (!prior || !isActiveStatus(prior.status)) return false;
			store.delete(evt.id);
			return true;
		}

		case "snapshot":
			return applySnapshot(store, evt.active, ctx);
	}
}

/**
 * Reconcile against the server's list of what is in flight right now.
 *
 * Sent on every connect, so it also runs after a reconnect — which is the
 * interesting case. Anything the client still holds as active but the server no
 * longer tracks ended during the outage, and we never saw how: that is `lost`,
 * not success and not failure. The backfill that follows a reconnect can still
 * overwrite it with the real outcome, because a terminal outranks `lost`.
 */
function applySnapshot(
	store: LiveStore,
	active: Extract<RequestStreamEvt, { type: "snapshot" }>["active"],
	ctx: NormalizeContext | undefined,
): boolean {
	let changed = false;
	const stillActive = new Set<string>();

	for (const entry of active) {
		stillActive.add(entry.id);
		changed =
			upsert(store, entry.id, {
				ts: entry.timestamp,
				project: entry.project,
				model: entry.model,
				account: resolveAccount(entry.accountId, ctx),
				status: entry.phase === "streaming" ? "streaming" : "pending",
			}) || changed;
	}

	for (const [id, event] of store) {
		if (!isActiveStatus(event.status) || stillActive.has(id)) continue;
		store.set(id, { ...event, status: "lost" });
		changed = true;
	}

	return changed;
}

/**
 * Fold rows from the history endpoint into the store.
 *
 * Used to backfill on mount and after every reconnect, so the lanes are not
 * empty on arrival and an outage does not read as a period of inactivity.
 *
 * @returns whether the store changed.
 */
export function applyHistoryRows(
	store: LiveStore,
	rows: readonly RequestResponse[],
	ctx?: NormalizeContext,
): boolean {
	let changed = false;
	for (const row of rows) {
		const next = fromRequestResponse(row, ctx);
		if (!next) continue;
		changed = upsert(store, row.id, next) || changed;
	}
	return changed;
}

/**
 * Drop what no longer needs to be drawn.
 *
 * Completed events age out with the window. **Active ones never do** — a
 * four-minute stream is exactly the work this view exists to show, and
 * window-pruning it would delete the request while it is still running. Long
 * runners are pinned at the left edge by the renderer instead, and eventually
 * settled by {@link sweepLostEvents}.
 *
 * @returns whether the store changed.
 */
export function pruneLiveStore(
	store: LiveStore,
	now: number,
	windowMs: number,
	maxEntries = MAX_LIVE_EVENTS,
): boolean {
	let changed = false;
	const cutoff = now - windowMs;

	for (const [id, event] of store) {
		if (isActiveStatus(event.status)) continue;
		if (event.ts >= cutoff) continue;
		store.delete(id);
		changed = true;
	}

	if (store.size <= maxEntries) return changed;

	// Over the cap: shed the oldest COMPLETED events first, so a burst of
	// history can never evict a request that is still running.
	const completed = Array.from(store.values())
		.filter((event) => !isActiveStatus(event.status))
		.sort((a, b) => a.ts - b.ts);

	for (const event of completed) {
		if (store.size <= maxEntries) break;
		store.delete(event.id);
		changed = true;
	}

	// Still over only if the actives alone exceed the cap; shed the oldest.
	if (store.size > maxEntries) {
		const actives = Array.from(store.values())
			.filter((event) => isActiveStatus(event.status))
			.sort((a, b) => a.ts - b.ts);
		for (const event of actives) {
			if (store.size <= maxEntries) break;
			store.delete(event.id);
			changed = true;
		}
	}

	return changed;
}

/**
 * Settle in-flight events that have gone quiet for too long.
 *
 * A dropped connection, a proxy restart, or a client abort mid-dispatch can
 * leave an entry with no terminal. Calling that an error would invent a failure
 * that may never have happened, so it becomes `lost` — and a real outcome
 * arriving later still wins.
 *
 * @returns whether the store changed.
 */
export function sweepLostEvents(
	store: LiveStore,
	now: number,
	ttlMs = LOST_AFTER_MS,
): boolean {
	let changed = false;
	for (const [id, event] of store) {
		if (!isActiveStatus(event.status)) continue;
		if (now - event.ts < ttlMs) continue;
		store.set(id, { ...event, status: "lost" });
		changed = true;
	}
	return changed;
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/** Synthetic key for the overflow lane. */
export const OTHER_LANE_KEY = "other";
/** Synthetic key for requests with no recorded project. */
export const NO_PROJECT_LANE_KEY = "none";

/**
 * Stable lane key for a project.
 *
 * Real project names are namespaced under a `project:` prefix so neither a
 * project literally called `(no project)` nor one called `Other (3 projects)`
 * can be merged into a synthetic bucket by sharing its label.
 */
export function laneKeyOf(project: string | null): string {
	return project === null ? NO_PROJECT_LANE_KEY : `project:${project}`;
}

export interface Lane {
	key: string;
	label: string;
	/** Events in this lane, ascending by time. Includes long-running requests
	 *  that started before the window and are pinned at its left edge. */
	events: LiveEvent[];
	/**
	 * Requests that ARRIVED inside the window.
	 *
	 * Deliberately excludes the pinned long-runners: they are drawn because
	 * they are still happening, but counting them as arrivals would report a
	 * positive request rate for a window in which nothing actually arrived.
	 */
	requests: number;
	/** Tokens from the in-window requests, on the same basis as `requests`. */
	tokens: number;
	rateLimited: number;
	errors: number;
	/** How many of this lane's requests are still running, pinned included. */
	active: number;
}

export interface BuildLanesResult {
	lanes: Lane[];
	/**
	 * Lane keys in render order. Feed back into the next call to hold the
	 * order steady.
	 */
	order: string[];
}

/**
 * Group events into per-project lanes.
 *
 * `maxLanes` bounds the NAMED project lanes only. The `(no project)` bucket is
 * not a project — spending a named slot on it pushed a real project into the
 * overflow lane and made that lane's "Other (N projects)" label count a bucket
 * that is not a project at all. It therefore gets its own row, held at its
 * sticky position like any other lane and simply not counted against the quota;
 * it never folds into the overflow lane, which appears only when named projects
 * genuinely overflow and counts named projects only. The card is thus at most
 * `maxLanes + 2` rows.
 *
 * Ordering is STICKY. A lane keeps its row for as long as it has events in the
 * window, and new lanes are appended below the existing ones (busiest first
 * among simultaneous arrivals). Re-sorting by rolling volume every tick would
 * move rows under the pointer, drag keyboard focus with them, and shuffle
 * projects in and out of the overflow lane while they are being inspected —
 * which is also why lane membership, not just row position, follows the sticky
 * order.
 *
 * Idempotent in `previousOrder`: feeding the returned `order` back with the
 * same events reproduces that order exactly (everything is "surviving", nothing
 * is an entrant), which is what lets the renderer write its order ref during
 * render.
 *
 * Active requests are always included regardless of age: their start can be
 * older than the window while the work is still running.
 */
export function buildLanes(
	events: readonly LiveEvent[],
	now: number,
	windowMs: number,
	maxLanes: number,
	previousOrder: readonly string[] = [],
): BuildLanesResult {
	const cutoff = now - windowMs;
	const byKey = new Map<
		string,
		{ project: string | null; events: LiveEvent[] }
	>();

	for (const event of events) {
		if (event.ts < cutoff && !isActiveStatus(event.status)) continue;
		const key = laneKeyOf(event.project);
		let bucket = byKey.get(key);
		if (!bucket) {
			bucket = { project: event.project, events: [] };
			byKey.set(key, bucket);
		}
		bucket.events.push(event);
	}

	// Sticky order: keys we already had, in their existing order, then the new
	// arrivals ranked by volume so a burst does not land in an arbitrary slot.
	const surviving = previousOrder.filter((key) => byKey.has(key));
	const seen = new Set(surviving);
	const entrants = Array.from(byKey.keys())
		.filter((key) => !seen.has(key))
		.sort(
			(a, b) =>
				(byKey.get(b)?.events.length ?? 0) - (byKey.get(a)?.events.length ?? 0),
		);
	const order = [...surviving, ...entrants];

	// The quota is spent on named projects only. The no-project bucket keeps its
	// sticky position in `order` — pulling it out and re-appending it would move
	// its row every time a new named project sent its first request — it is
	// simply not counted against `maxLanes`, and never folds into (or is counted
	// by) the overflow lane.
	const direct: string[] = [];
	const overflow: string[] = [];
	let namedTaken = 0;
	for (const key of order) {
		if (key === NO_PROJECT_LANE_KEY) {
			direct.push(key);
			continue;
		}
		if (namedTaken < maxLanes) {
			direct.push(key);
			namedTaken++;
		} else {
			overflow.push(key);
		}
	}

	const toLaneFor = (key: string): Lane => {
		const bucket = byKey.get(key) as {
			project: string | null;
			events: LiveEvent[];
		};
		return toLane(
			key,
			bucket.project ?? NO_PROJECT_LABEL,
			sortByTime(bucket.events),
			cutoff,
		);
	};

	const lanes: Lane[] = direct.map(toLaneFor);

	if (overflow.length > 0) {
		const merged = overflow.flatMap((key) => byKey.get(key)?.events ?? []);
		lanes.push(
			toLane(
				OTHER_LANE_KEY,
				`Other (${overflow.length} project${overflow.length === 1 ? "" : "s"})`,
				sortByTime(merged),
				cutoff,
			),
		);
	}

	return { lanes, order };
}

function sortByTime(events: LiveEvent[]): LiveEvent[] {
	return [...events].sort((a, b) => a.ts - b.ts);
}

function toLane(
	key: string,
	label: string,
	events: LiveEvent[],
	cutoff: number,
): Lane {
	let requests = 0;
	let tokens = 0;
	let rateLimited = 0;
	let errors = 0;
	let active = 0;

	for (const event of events) {
		// Pinned long-runners are drawn but not counted as arrivals — see the
		// `requests` field doc.
		if (event.ts >= cutoff) {
			requests++;
			tokens += event.tokens ?? 0;
			if (event.status === "rate_limited") rateLimited++;
			else if (event.status === "error") errors++;
		}
		if (isActiveStatus(event.status)) active++;
	}

	return { key, label, events, requests, tokens, rateLimited, errors, active };
}

// ---------------------------------------------------------------------------
// Mark geometry
// ---------------------------------------------------------------------------

const MIN_RADIUS = 2.5;
const MAX_RADIUS = 7;
/** Token count that saturates the mark size. */
const RADIUS_REFERENCE_TOKENS = 200_000;
/** Size used when the token count is unknown (in flight, or never reported). */
const UNKNOWN_RADIUS = 3;

/**
 * Mark radius for a request, on a square-root scale.
 *
 * Square-root rather than linear because area, not radius, is what the eye
 * reads as magnitude — and because a single 200k-token request on a linear
 * scale would swallow its whole lane.
 */
export function markRadius(tokens: number | null): number {
	if (tokens == null || !Number.isFinite(tokens) || tokens <= 0) {
		return UNKNOWN_RADIUS;
	}
	const scaled = Math.sqrt(
		Math.min(tokens, RADIUS_REFERENCE_TOKENS) / RADIUS_REFERENCE_TOKENS,
	);
	return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * scaled;
}

/** Opacity floor for the oldest mark still on screen. */
const MIN_OPACITY = 0.35;

/**
 * Fade a mark with its age across the window — a single-hue lightness ramp, so
 * age never competes with the status hues for meaning.
 */
export function ageOpacity(ts: number, now: number, windowMs: number): number {
	if (windowMs <= 0) return 1;
	const age = (now - ts) / windowMs;
	const clamped = Math.min(Math.max(age, 0), 1);
	return 1 - (1 - MIN_OPACITY) * clamped;
}
