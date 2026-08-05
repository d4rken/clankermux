import type { RequestStreamEvt } from "@clankermux/core";
import type { RequestResponse } from "@clankermux/types";
import {
	applyHistoryRows,
	applyStreamEvent,
	type LiveEvent,
	type LiveStore,
	MAX_LIVE_EVENTS,
	type NormalizeContext,
	pruneLiveStore,
	sweepLostEvents,
} from "./live-activity";

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
	 * Oldest arrival time the history backfill could see, but ONLY when it came
	 * back saturated (as many rows as were asked for). A short result means the
	 * history really is complete and there is nothing to disclose.
	 */
	historyEdge: number | null;
}

const EMPTY_SNAPSHOT: LiveActivitySnapshot = {
	events: [],
	connected: false,
	outages: [],
	primed: false,
	historyEdge: null,
};

/** Publishes are coalesced to this interval so a burst cannot thrash React. */
export const PUBLISH_INTERVAL_MS = 250;

/** More outages than this in one window is noise, not information. */
const MAX_TRACKED_OUTAGES = 8;

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
	private historyEdge: number | null = null;

	private dirty = false;
	private publishTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly windowMs: number,
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
	 * `saturated` means the server returned as many rows as were requested, so
	 * older in-window history may exist that we cannot see. Only then is a
	 * history edge recorded — otherwise an empty left half is genuinely empty.
	 */
	applyHistory(rows: readonly RequestResponse[], saturated: boolean): void {
		if (applyHistoryRows(this.store, rows, this.normalize)) this.markDirty();

		const edge = saturated
			? rows.reduce<number | null>((oldest, row) => {
					const ts = Date.parse(row.timestamp);
					if (!Number.isFinite(ts)) return oldest;
					return oldest === null || ts < oldest ? ts : oldest;
				}, null)
			: null;

		if (edge !== this.historyEdge) {
			this.historyEdge = edge;
			this.markDirty();
		}
		if (!this.primed) {
			this.primed = true;
			this.markDirty();
		}
	}

	setConnected(connected: boolean): void {
		if (this.connected === connected) return;
		this.connected = connected;
		const now = this.now();

		if (connected) {
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
		let changed = pruneLiveStore(this.store, now, this.windowMs);
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
		if (this.store.size > MAX_LIVE_EVENTS) {
			pruneLiveStore(this.store, this.now(), this.windowMs);
		}

		this.snapshot = {
			events: Array.from(this.store.values()).sort((a, b) => a.ts - b.ts),
			connected: this.connected,
			outages: this.outages.map((outage) => ({ ...outage })),
			primed: this.primed,
			historyEdge: this.historyEdge,
		};
		for (const listener of this.listeners) listener();
	}
}
