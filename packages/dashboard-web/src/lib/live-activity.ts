import { getModelShortName, type RequestStreamEvt } from "@clankermux/core";
import { normalizeAccountId, type RequestResponse } from "@clankermux/types";
import { NO_PROJECT_LABEL } from "./project-donut";

/**
 * Pure model behind the Overview's Live Activity lanes.
 *
 * Kept out of the component (mirroring `lib/active-sessions.ts` and
 * `packages/core/src/pool-usage.ts`) because most of the difficulty here is reconciliation,
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
	/** Stable account identity; null is unknown while active or no-account at terminal. */
	accountId: string | null;
	/** Account display name where resolvable, else whatever the source recorded. */
	account: string | null;
	/** The API key the request presented. `null` is a real state, not a gap:
	 *  unprotected mode admits traffic that carries no key at all. */
	apiKeyId: string | null;
	/**
	 * The key's name AS RECORDED by the source this event came from — the name
	 * held at arrival on the live path, the key's current name on the history
	 * path. One key can therefore be seen under two names, so this is a label
	 * and {@link LiveEvent.apiKeyId} is the identity.
	 */
	apiKeyName: string | null;
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
	accountId: string | null,
	recorded: string | null | undefined,
	ctx: NormalizeContext | undefined,
): string | null {
	if (accountId === null) return recorded ?? null;
	// Live events carry the account ID; history carries both the stable ID and
	// the source-specific label. A lookup miss means the account was deleted or
	// the recorded value is already the best available label.
	return ctx?.accountName?.(accountId) ?? recorded ?? accountId;
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
		accountId:
			next.accountId !== undefined
				? next.accountId
				: (prior?.accountId ?? null),
		account:
			next.account !== undefined ? next.account : (prior?.account ?? null),
		apiKeyId: next.apiKeyId ?? prior?.apiKeyId ?? null,
		apiKeyName: next.apiKeyName ?? prior?.apiKeyName ?? null,
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
		accountId: normalizeAccountId(
			payload.accountId !== undefined ? payload.accountId : payload.accountUsed,
		),
		account: resolveAccount(
			normalizeAccountId(
				payload.accountId !== undefined
					? payload.accountId
					: payload.accountUsed,
			),
			payload.accountUsed,
			ctx,
		),
		apiKeyId: payload.apiKeyId ?? null,
		apiKeyName: payload.apiKeyName ?? null,
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
				accountId: null,
				account: null,
				apiKeyId: evt.apiKeyId,
				apiKeyName: evt.apiKeyName,
				status: "pending",
			});

		case "start":
			return upsert(store, evt.id, {
				ts: evt.timestamp,
				project: evt.project,
				model: evt.model,
				accountId: normalizeAccountId(evt.accountId),
				account: resolveAccount(normalizeAccountId(evt.accountId), null, ctx),
				apiKeyId: evt.apiKeyId,
				apiKeyName: evt.apiKeyName,
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
				accountId: normalizeAccountId(entry.accountId),
				account: resolveAccount(normalizeAccountId(entry.accountId), null, ctx),
				apiKeyId: entry.apiKeyId,
				apiKeyName: entry.apiKeyName,
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
/** Synthetic key for requests that carried no API key. */
export const NO_CLIENT_LANE_KEY = "no-client";
/** Synthetic key for active requests whose account has not been selected yet. */
export const ACCOUNT_PENDING_LANE_KEY = "account-pending";
/** Synthetic key for terminal requests with no account. */
export const NO_ACCOUNT_LANE_KEY = "account-none";

/** Label for the lane holding requests that carried no API key. */
export const NO_CLIENT_LABEL = "(no API key)";
/** Labels distinguish routing from a terminal request that used no account. */
export const ACCOUNT_PENDING_LABEL = "(routing)";
export const NO_ACCOUNT_LABEL = "(no account)";

/** What one row of the card stands for: a project, API key, or account. */
export type LaneDimension = "project" | "client" | "account";

/**
 * Stable lane key for one value in `dimension` — a project name or a key id.
 *
 * Real values are namespaced under a per-dimension prefix, so neither a project
 * literally called `(no project)` nor one called `Other (3 projects)` can be
 * merged into a synthetic bucket by sharing its label, and a project and a key
 * id that happen to be the same string stay separate lanes.
 */
export function laneKeyOf(
	dimension: LaneDimension,
	value: string | null,
): string {
	if (dimension === "client") {
		return value === null ? NO_CLIENT_LANE_KEY : `client:${value}`;
	}
	if (dimension === "account") {
		return value === null ? NO_ACCOUNT_LANE_KEY : `account:${value}`;
	}
	return value === null ? NO_PROJECT_LANE_KEY : `project:${value}`;
}

/**
 * What a lane stands for, as data rather than an encoded key.
 *
 * A discriminated union so no invalid combination is representable — the
 * renderer builds its "show these requests" link from this instead of parsing
 * `key` back apart, and the overflow lane cannot accidentally be treated as a
 * project because it has no project field at all.
 */
export type LaneScope =
	| { kind: "project"; project: string }
	| { kind: "no-project" }
	| { kind: "client"; apiKeyId: string }
	| { kind: "no-client" }
	| { kind: "account"; accountId: string }
	| { kind: "account-pending" }
	| { kind: "no-account" }
	| { kind: "other" };

export interface Lane {
	key: string;
	label: string;
	/** The requests this lane covers, expressed as a filter, not a label. */
	scope: LaneScope;
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

/** Everything the lane machinery below does differently per dimension. */
interface LaneDimensionSpec {
	/** The value a lane groups on. `null` goes to the empty bucket. */
	valueOf: (event: LiveEvent) => string | null;
	/** A name recorded alongside the value, where the value is not itself one. */
	nameOf: (event: LiveEvent) => string | null;
	emptyKey: string;
	emptyLabel: string;
	emptyScope: LaneScope;
	scopeOf: (value: string) => LaneScope;
	/** Singular noun for the overflow lane's count. */
	noun: string;
}

const LANE_DIMENSIONS: Record<LaneDimension, LaneDimensionSpec> = {
	project: {
		valueOf: (event) => event.project,
		nameOf: () => null,
		emptyKey: NO_PROJECT_LANE_KEY,
		emptyLabel: NO_PROJECT_LABEL,
		emptyScope: { kind: "no-project" },
		scopeOf: (project) => ({ kind: "project", project }),
		noun: "project",
	},
	client: {
		valueOf: (event) => event.apiKeyId,
		nameOf: (event) => event.apiKeyName,
		emptyKey: NO_CLIENT_LANE_KEY,
		emptyLabel: NO_CLIENT_LABEL,
		emptyScope: { kind: "no-client" },
		scopeOf: (apiKeyId) => ({ kind: "client", apiKeyId }),
		noun: "client",
	},
	account: {
		valueOf: (event) => event.accountId ?? null,
		nameOf: (event) => event.account ?? null,
		emptyKey: NO_ACCOUNT_LANE_KEY,
		emptyLabel: NO_ACCOUNT_LABEL,
		emptyScope: { kind: "no-account" },
		scopeOf: (accountId) => ({ kind: "account", accountId }),
		noun: "account",
	},
};

function accountLaneKeyOf(event: LiveEvent): string {
	// Presence, not truthiness, is the identity test: the empty string is still
	// a recorded account id and must not be relabelled as routing/no-account.
	if (event.accountId !== null) return laneKeyOf("account", event.accountId);
	return isActiveStatus(event.status)
		? ACCOUNT_PENDING_LANE_KEY
		: NO_ACCOUNT_LANE_KEY;
}

/**
 * Group events into lanes, one per project or per API key.
 *
 * `maxLanes` bounds the NAMED lanes only. The empty bucket — `(no project)`, or
 * the requests that carried no key — is not one of the things being counted:
 * spending a named slot on it pushed a real project into the overflow lane and
 * made that lane's "Other (N projects)" label count a bucket that is not a
 * project at all. It therefore gets its own row, held at its sticky position
 * like any other lane and simply not counted against the quota; it never folds
 * into the overflow lane, which appears only when named lanes genuinely
 * overflow and counts named lanes only. The card is thus at most `maxLanes + 2`
 * rows.
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
	dimension: LaneDimension,
	now: number,
	windowMs: number,
	maxLanes: number,
	previousOrder: readonly string[] = [],
	resolveAccount?: (accountId: string) => string | null,
): BuildLanesResult {
	const spec = LANE_DIMENSIONS[dimension];
	const cutoff = now - windowMs;
	const byKey = new Map<
		string,
		{ value: string | null; events: LiveEvent[] }
	>();

	for (const event of events) {
		if (event.ts < cutoff && !isActiveStatus(event.status)) continue;
		const value = spec.valueOf(event);
		const key =
			dimension === "account"
				? accountLaneKeyOf(event)
				: laneKeyOf(dimension, value);
		let bucket = byKey.get(key);
		if (!bucket) {
			bucket = { value, events: [] };
			byKey.set(key, bucket);
		}
		// Membership follows the value alone. The recorded name only labels the
		// lane, so a key renamed mid-window still draws as one row.
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

	// The quota is spent on named lanes only. The empty bucket keeps its sticky
	// position in `order` — pulling it out and re-appending it would move its row
	// every time a new named lane sent its first request — it is simply not
	// counted against `maxLanes`, and never folds into (or is counted by) the
	// overflow lane.
	const direct: string[] = [];
	const overflow: string[] = [];
	let namedTaken = 0;
	for (const key of order) {
		if (
			key === spec.emptyKey ||
			(dimension === "account" && key === ACCOUNT_PENDING_LANE_KEY)
		) {
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
			value: string | null;
			events: LiveEvent[];
		};
		const events = sortByTime(bucket.events);
		const isPendingAccount =
			dimension === "account" && key === ACCOUNT_PENDING_LANE_KEY;
		const value = bucket.value;
		const isEmpty = value === null;
		const accountLabel =
			dimension === "account" && value !== null
				? (resolveAccount?.(value) ?? latestName(events, spec) ?? value)
				: null;
		const scope = isPendingAccount
			? { kind: "account-pending" as const }
			: key === NO_ACCOUNT_LANE_KEY && dimension === "account"
				? { kind: "no-account" as const }
				: isEmpty
					? spec.emptyScope
					: spec.scopeOf(value as string);
		return toLane(
			key,
			isPendingAccount
				? ACCOUNT_PENDING_LABEL
				: (accountLabel ??
						(isEmpty
							? spec.emptyLabel
							: (latestName(events, spec) ?? (value as string)))),
			scope,
			events,
			cutoff,
		);
	};

	const lanes: Lane[] = direct.map(toLaneFor);

	if (overflow.length > 0) {
		const merged = overflow.flatMap((key) => byKey.get(key)?.events ?? []);
		lanes.push(
			toLane(
				OTHER_LANE_KEY,
				`Other (${overflow.length} ${spec.noun}${overflow.length === 1 ? "" : "s"})`,
				{ kind: "other" },
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

/**
 * The name most recently recorded for a lane's value, from `events` ascending
 * by time.
 *
 * Newest rather than first-seen: a live event carries the name held when the
 * request arrived and a history row carries the name the key has now, so one
 * key is routinely seen under two names and store order decides nothing. The
 * latest reading is the one closest to what the key is called today.
 */
function latestName(
	events: readonly LiveEvent[],
	spec: LaneDimensionSpec,
): string | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const name = spec.nameOf(events[i]);
		if (name !== null) return name;
	}
	return null;
}

function toLane(
	key: string,
	label: string,
	scope: LaneScope,
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

	return {
		key,
		label,
		scope,
		events,
		requests,
		tokens,
		rateLimited,
		errors,
		active,
	};
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

/**
 * Marks are drawn fully opaque. There is no age ramp, and adding one back would
 * break the card's colour encoding.
 *
 * Age used to fade a mark toward the card ground, down to 0.35 at the window's
 * left edge. That was sound while hue meant STATUS: four values, all far apart,
 * so washing one out could not turn it into another. Hue now identifies the
 * MODEL across 28 palette entries, and compositing those toward the ground
 * collapses them into each other — measured over every pair at every point on
 * the ramp, against the real card grounds:
 *
 *   floor 0.35 -> min dE  4.1 (dark, purple vs fuchsia)   0.6 (light)
 *   floor 0.70 -> min dE  6.5                             5.6
 *   floor 0.90 -> min dE  9.9 (dark, teal vs mint)       13.0
 *   no fade   -> min dE 15.1                             18.5
 *
 * Only "no fade" clears the palette's own 15 dE floor. There is no partial
 * setting that works, because the ramp passes through every intermediate
 * opacity on its way down.
 *
 * Nothing is lost by dropping it: this is a time axis, so a mark's age is
 * already given by its horizontal position, exactly and unambiguously. The fade
 * was a second, redundant encoding of the one variable the plot's geometry
 * already carries. It also actively hurt in one case — an in-flight request
 * pending for the whole window faded to 35%, making the mark most likely to be
 * wedged the faintest thing on the card.
 */
export const MARK_OPACITY = 1;

/**
 * How many models get their own colour on the card before the rest collapse
 * into one "Other" bucket.
 *
 * Five covers 99.0% of a day's requests here, 98.9% of a week and 98.2% of a
 * month — the top five run 6.8% and up while the sixth-busiest real model is
 * 0.01%, so the cap sits in a very wide gap rather than cutting through a
 * cluster. The card's window is minutes, and seven distinct models appear in a
 * whole day; a legend longer than this is legend for traffic that is not there.
 *
 * Analytics deliberately does NOT cap. Its ranges reach back far enough that
 * the tail is real — Opus 4.8 is 19% of lifetime traffic and Opus 4.7 another
 * 9%, both effectively retired now — and greying them would merge a quarter of
 * all history into one band in exactly the charts that exist to separate it.
 */
export const MAX_COLORED_MODELS = 5;

export interface ModelRanking {
	/** Short names that keep their own hue, busiest first. */
	colored: string[];
	/** Short name -> a full model id for it, for palette lookup. */
	idFor: Map<string, string>;
	/** How many distinct models fell outside the cap. */
	otherModels: number;
}

/**
 * Rank the models on the plot by request count and decide which keep a hue.
 *
 * Rank decides only WHETHER a model is coloured, never WHICH colour it gets —
 * that stays keyed to the model id. If rank picked the hue, every mark on the
 * card would change colour whenever two models swapped places as the window
 * rolled, which is the instability the id-keyed palette exists to prevent.
 *
 * Ties break on the short name so the cut is deterministic: two models on equal
 * counts would otherwise trade the last slot on every re-render.
 */
export function rankModels(
	lanes: Array<{ events: LiveEvent[] }>,
	limit: number = MAX_COLORED_MODELS,
): ModelRanking {
	const counts = new Map<string, number>();
	const idFor = new Map<string, string>();
	for (const lane of lanes) {
		for (const event of lane.events) {
			if (!event.model) continue;
			const shortName = getModelShortName(event.model);
			counts.set(shortName, (counts.get(shortName) ?? 0) + 1);
			if (!idFor.has(shortName)) idFor.set(shortName, event.model);
		}
	}

	const ordered = [...counts.entries()].sort(
		([nameA, countA], [nameB, countB]) =>
			countB - countA || nameA.localeCompare(nameB),
	);

	return {
		colored: ordered.slice(0, limit).map(([name]) => name),
		idFor,
		otherModels: Math.max(ordered.length - limit, 0),
	};
}

// ---------------------------------------------------------------------------
// Plot geometry
// ---------------------------------------------------------------------------

/** Height of one lane row, in plot px. Shared by the renderer and `hitTest`. */
export const LANE_HEIGHT = 28;

/** Right-hand inset so a mark at "now" is not clipped by the plot edge. */
export const NOW_INSET = 8;

/** Marks older than the window are pinned at the left edge, never dropped. */
function clampToPlot(x: number): number {
	return Math.max(x, 2);
}

/**
 * X of a mark's centre in plot space, pinning included.
 *
 * The single definition of where a mark actually sits: the renderer places marks
 * with it and `resolveMarkHref` measures click distance against it, so the two
 * cannot drift into disagreeing about what the pointer is over.
 */
export function markCenterX(
	ts: number,
	now: number,
	windowMs: number,
	plotWidth: number,
): number {
	const usable = Math.max(plotWidth - NOW_INSET, 1);
	return clampToPlot(usable - ((now - ts) * usable) / windowMs);
}

/**
 * Nearest-mark hit test.
 *
 * `y` picks the lane (rows are the generous part of the target) and `x` picks
 * the nearest event within it by time. Returns null only when the lane is empty
 * or the pointer is off the lanes entirely.
 */
export function hitTest(
	lanes: Lane[],
	x: number,
	y: number,
	now: number,
	windowMs: number,
	plotWidth: number,
): { event: LiveEvent; laneIndex: number; eventIndex: number } | null {
	const laneIndex = Math.floor(y / LANE_HEIGHT);
	const lane = lanes[laneIndex];
	if (!lane || lane.events.length === 0) return null;

	const usable = Math.max(plotWidth - NOW_INSET, 1);
	const targetTs = now - ((usable - x) * windowMs) / usable;

	let bestIndex = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < lane.events.length; i++) {
		const distance = Math.abs(lane.events[i].ts - targetTs);
		if (distance < bestDistance) {
			bestDistance = distance;
			bestIndex = i;
		}
	}

	return { event: lane.events[bestIndex], laneIndex, eventIndex: bestIndex };
}
