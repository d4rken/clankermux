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

/**
 * Framework-free store behind the Live Activity lanes.
 *
 * Deliberately not a React hook: the subscription semantics (coalesced
 * publishes, outage bookkeeping, ordering between the live stream and the
 * history backfill) are the hard part, and they are far easier to pin down in a
 * plain unit test than through a renderer. `RequestEventProvider` is the thin
 * React binding on top, via `useSyncExternalStore`.
 */

/** Immutable view handed to React. Identity changes only when data changes. */
export interface LiveActivitySnapshot {
	/** All retained events, ascending by arrival time. */
	events: LiveEvent[];
	/** Whether the SSE connection is currently up. */
	connected: boolean;
	/**
	 * When the connection dropped, if it is currently down or was down and the
	 * gap has not yet aged out of the window. Drives the "history unavailable"
	 * hatching — an outage must not be silently rendered as a quiet period.
	 */
	disconnectedSince: number | null;
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
	disconnectedSince: null,
	primed: false,
	historyEdge: null,
};

/** Publishes are coalesced to this interval so a burst cannot thrash React. */
export const PUBLISH_INTERVAL_MS = 250;

export class LiveActivityStore {
	private readonly store: LiveStore = new Map();
	private readonly listeners = new Set<() => void>();
	private snapshot: LiveActivitySnapshot = EMPTY_SNAPSHOT;

	private connected = false;
	private disconnectedSince: number | null = null;
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
		// Record when the gap STARTED and keep it across the reconnect: the
		// reader still needs to see which stretch of the timeline is unknown
		// after the connection comes back.
		this.disconnectedSince = connected ? this.disconnectedSince : this.now();
		this.markDirty();
	}

	/** Periodic housekeeping: age out completed work and settle stale actives. */
	tick(): void {
		const now = this.now();
		let changed = pruneLiveStore(this.store, now, this.windowMs);
		changed = sweepLostEvents(this.store, now) || changed;

		// Once the gap has scrolled off the left edge there is nothing left to
		// disclose, so stop reserving it.
		if (
			this.connected &&
			this.disconnectedSince !== null &&
			this.disconnectedSince < now - this.windowMs
		) {
			this.disconnectedSince = null;
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
		this.snapshot = {
			events: Array.from(this.store.values()).sort((a, b) => a.ts - b.ts),
			connected: this.connected,
			disconnectedSince: this.disconnectedSince,
			primed: this.primed,
			historyEdge: this.historyEdge,
		};
		for (const listener of this.listeners) listener();
	}
}
