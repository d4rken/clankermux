import type { RequestStreamEvt } from "@clankermux/core";
import type { RequestResponse } from "@clankermux/types";
import {
	applyHistoryRows,
	applyStreamEvent,
	type LiveEvent,
	type LiveStore,
	type NormalizeContext,
	pruneLiveStore,
	sweepLostEvents,
} from "./live-activity";
import { eventCapFor } from "./live-activity-window";

/**
 * Framework-free store behind the Live Activity lanes.
 *
 * Deliberately not a React hook: the subscription semantics (coalesced
 * publishes, outage bookkeeping, ordering between the live stream and the
 * history backfill) are the hard part, and they are far easier to pin down in a
 * plain unit test than through a renderer. `RequestEventProvider` is the thin
 * React binding on top, via `useSyncExternalStore`.
 */

/** One period during which the stream was down. `to: null` means still down. */
export interface Outage {
	from: number;
	to: number | null;
}

/** Immutable view handed to React. Identity changes only when data changes. */
export interface LiveActivitySnapshot {
	/** All retained events, ascending by arrival time. */
	events: LiveEvent[];
	/** Whether the SSE connection is currently up. */
	connected: boolean;
	/**
	 * Periods during which the stream was down, oldest first, clipped to the
	 * window. `to: null` means still down.
	 *
	 * Bounded intervals rather than a single "disconnected since" marker: a
	 * one-minute outage must hatch one minute, not everything from the drop to
	 * the present. Extending an outage to `now` after reconnecting would paint
	 * healthy traffic as unknown, which is the same lie in the other direction.
	 */
	outages: Outage[];
	/** True once the first connect-time snapshot or backfill has landed. */
	primed: boolean;
	/**
	 * Earliest moment from which this view can honestly claim to hold every
	 * request. `null` means it can claim none — nothing has been fetched and the
	 * stream has never connected.
	 *
	 * Deliberately a COVERAGE FLOOR rather than "where the last fetch stopped".
	 * Fetches are scoped differently — a full window on first connect, only the
	 * gap on reconnect — so the reach of the most recent one says nothing about
	 * what is held overall. Deriving the hatch from the last fetch let a short
	 * gap page erase a genuine full-window shortfall, and a truncated gap page
	 * hatch healthy history either side of it.
	 */
	coverageFrom: number | null;
}

const EMPTY_SNAPSHOT: LiveActivitySnapshot = {
	events: [],
	connected: false,
	outages: [],
	primed: false,
	coverageFrom: null,
};

/** Publishes are coalesced to this interval so a burst cannot thrash React. */
export const PUBLISH_INTERVAL_MS = 250;

/**
 * Retained outage intervals.
 *
 * Sized for the longest offered window rather than a handful: dropping an
 * outage that is still visible on the axis removes its hatch and makes that
 * stretch look observed. Old ones age out by window anyway; this is only the
 * backstop against a pathological flap.
 */
const MAX_TRACKED_OUTAGES = 50;

export class LiveActivityStore {
	private readonly store: LiveStore = new Map();
	private readonly listeners = new Set<() => void>();
	private snapshot: LiveActivitySnapshot = EMPTY_SNAPSHOT;

	private connected = false;
	private outages: Outage[] = [];
	/**
	 * Whether the stream has ever been up. Before the first successful connect
	 * there is no outage to report: that period is covered by the history
	 * backfill, not by the live stream, and hatching it would double-count the
	 * one gap the history edge already discloses.
	 */
	private everConnected = false;
	private primed = false;
	/** Earliest point history fetches have reached. */
	private coveredSince: number | null = null;
	/** When the live stream first came up; everything after it arrived live. */
	private streamSince: number | null = null;

	private dirty = false;
	private publishTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private windowMs: number,
		private readonly normalize: NormalizeContext = {},
		private readonly now: () => number = Date.now,
	) {}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = (): LiveActivitySnapshot => this.snapshot;

	/** Fold one SSE event in. */
	applyEvent(evt: RequestStreamEvt): void {
		if (applyStreamEvent(this.store, evt, this.normalize)) this.markDirty();
		if (evt.type === "snapshot") {
			this.primed = true;
			this.markDirty();
		}
	}

	/**
	 * Fold in rows from the history endpoint.
	 *
	 * `requestedFrom` is the lower bound the fetch asked for; `saturated` means
	 * the server returned as many rows as were allowed, so it did NOT reach that
	 * bound. Coverage therefore extends to `requestedFrom` on a complete answer,
	 * and only to the oldest row actually returned on a truncated one.
	 *
	 * Coverage only ever improves here. A gap-scoped reconnect fetch reaching
	 * back a few seconds must not retract a full-window fetch that reached back
	 * minutes.
	 */
	applyHistory(
		rows: readonly RequestResponse[],
		{ requestedFrom, saturated }: { requestedFrom: number; saturated: boolean },
	): void {
		if (applyHistoryRows(this.store, rows, this.normalize)) this.markDirty();

		const oldestRow = rows.reduce<number | null>((oldest, row) => {
			const ts = Date.parse(row.timestamp);
			if (!Number.isFinite(ts)) return oldest;
			return oldest === null || ts < oldest ? ts : oldest;
		}, null);

		const reached = saturated ? (oldestRow ?? requestedFrom) : requestedFrom;
		this.extendCoverage(reached);

		if (!this.primed) {
			this.primed = true;
			this.markDirty();
		}
	}

	/** Claim coverage back to `from`, if that is further back than the current claim. */
	private extendCoverage(from: number): void {
		if (this.coveredSince !== null && this.coveredSince <= from) return;
		this.coveredSince = from;
		this.markDirty();
	}

	/**
	 * The honest coverage floor: the earlier of what history has reached and
	 * when the live stream came up. Absent both, nothing can be claimed.
	 */
	private computeCoverageFrom(): number | null {
		const { coveredSince, streamSince } = this;
		if (coveredSince === null) return streamSince;
		if (streamSince === null) return coveredSince;
		return Math.min(coveredSince, streamSince);
	}

	/**
	 * Change the rolling window.
	 *
	 * Widening keeps everything already held and simply shows more of it — the
	 * caller is expected to follow up with a backfill for the newly-exposed
	 * stretch. Narrowing prunes immediately so the card cannot briefly render
	 * marks outside its own axis.
	 *
	 * Coverage is NOT reset. It is an absolute timestamp, not a fact about the
	 * old window, and the renderer clips it to whatever window is current.
	 * Clearing it here made narrowing — which deliberately does not refetch —
	 * silently drop a shortfall that was still inside the smaller window.
	 */
	setWindow(windowMs: number): void {
		if (this.windowMs === windowMs) return;
		this.windowMs = windowMs;
		pruneLiveStore(this.store, this.now(), windowMs, eventCapFor(windowMs));
		this.markDirty();
	}

	setConnected(connected: boolean): void {
		if (this.connected === connected) return;
		this.connected = connected;
		const now = this.now();

		if (connected) {
			// Everything from the first successful connect onwards arrived live,
			// so the stream itself is a coverage source — and the only one left
			// standing when a backfill fails outright.
			if (!this.everConnected) this.streamSince = now;
			this.everConnected = true;
			// Close the open outage at the moment service resumed. Leaving it
			// open would keep hatching healthy traffic for as long as the drop
			// stayed in the window.
			const open = this.outages.at(-1);
			if (open && open.to === null) open.to = now;
		} else if (this.everConnected) {
			this.outages.push({ from: now, to: null });
			// The window can only show so many; keep the most recent.
			if (this.outages.length > MAX_TRACKED_OUTAGES) this.outages.shift();
		}

		this.markDirty();
	}

	/** Periodic housekeeping: age out completed work and settle stale actives. */
	tick(): void {
		const now = this.now();
		let changed = pruneLiveStore(
			this.store,
			now,
			this.windowMs,
			eventCapFor(this.windowMs),
		);
		changed = sweepLostEvents(this.store, now) || changed;

		// Drop outages that have scrolled entirely off the left edge — an open
		// one never has, since it still reaches the present.
		const cutoff = now - this.windowMs;
		const kept = this.outages.filter(
			(outage) => outage.to === null || outage.to >= cutoff,
		);
		if (kept.length !== this.outages.length) {
			this.outages = kept;
			changed = true;
		}

		if (changed) this.markDirty();
		this.flush();
	}

	/** Cancel any pending publish. Call on unmount. */
	dispose(): void {
		if (this.publishTimer !== null) {
			clearTimeout(this.publishTimer);
			this.publishTimer = null;
		}
		this.listeners.clear();
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.publishTimer !== null) return;
		this.publishTimer = setTimeout(() => {
			this.publishTimer = null;
			this.flush();
		}, PUBLISH_INTERVAL_MS);
	}

	private flush(): void {
		if (!this.dirty) return;
		this.dirty = false;
		// Enforce the retained-event ceiling HERE rather than leaving it to the
		// 1 Hz tick: a burst larger than the cap arriving inside one second
		// would otherwise publish snapshots of many thousands of marks, at
		// exactly the moment the dashboard is already under load.
		const cap = eventCapFor(this.windowMs);
		if (this.store.size > cap) {
			pruneLiveStore(this.store, this.now(), this.windowMs, cap);
		}

		const events = Array.from(this.store.values()).sort((a, b) => a.ts - b.ts);

		// At the ceiling, the cap — not the window — decides how far back the
		// card actually reaches: completed events still inside the window get
		// evicted. Coverage has to retreat with them, or the stretch they used
		// to occupy renders as a quiet period.
		let coverageFrom = this.computeCoverageFrom();
		if (this.store.size >= cap && events.length > 0) {
			const oldestRetained = events[0].ts;
			coverageFrom =
				coverageFrom === null
					? oldestRetained
					: Math.max(coverageFrom, oldestRetained);
		}

		this.snapshot = {
			events,
			connected: this.connected,
			outages: this.outages.map((outage) => ({ ...outage })),
			primed: this.primed,
			coverageFrom,
		};
		for (const listener of this.listeners) listener();
	}
}
