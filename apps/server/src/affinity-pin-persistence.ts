/**
 * Keeps the load-balancing strategy's session affinity pins across restarts.
 *
 * Every database operation runs through one serial queue: a snapshot never
 * overlaps another, a restore finishes before the next snapshot can overwrite
 * the table it reads, and the final flush at shutdown lands after anything
 * already in flight. Each snapshot exports the pins when it runs, not when it
 * was queued, so the last write is always the newest state.
 */

import { Logger } from "@clankermux/logger";
import type { AffinityPin, LoadBalancingStrategy } from "@clankermux/types";

const log = new Logger("AffinityPinPersistence");

export const AFFINITY_SNAPSHOT_INTERVAL_MS = 30_000;
export const AFFINITY_FINAL_FLUSH_TIMEOUT_MS = 5_000;

export interface AffinityPinStore {
	replaceSessionAffinityPins(pins: readonly AffinityPin[]): Promise<void>;
	getSessionAffinityPins(sinceMs: number): Promise<AffinityPin[]>;
}

export interface AffinityPinPersistenceDeps {
	store: AffinityPinStore;
	/** Read on every snapshot: the strategy is replaced when its config changes. */
	getStrategy: () => LoadBalancingStrategy | null;
	/** Pins idle for longer than this are not restored. */
	maxAgeMs: number;
	intervalMs?: number;
	now?: () => number;
}

export class AffinityPinPersistence {
	private readonly deps: AffinityPinPersistenceDeps;
	private queue: Promise<void> = Promise.resolve();
	private timer: ReturnType<typeof setInterval> | null = null;
	private tickQueued = false;
	private stopped = false;
	/** Set once the final flush gave up; queued writes must not reach a closing database. */
	private closed = false;
	/** The strategy state the table was last written from. */
	private written: {
		strategy: LoadBalancingStrategy;
		revision: number | undefined;
	} | null = null;

	constructor(deps: AffinityPinPersistenceDeps) {
		this.deps = deps;
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private serial(task: () => Promise<void>): Promise<void> {
		const run = this.queue.then(task);
		this.queue = run.catch(() => {});
		return run;
	}

	/** Load the stored pins into `strategy`. Never throws. */
	restore(strategy: LoadBalancingStrategy): Promise<void> {
		return this.serial(() => this.restoreNow(strategy));
	}

	private async restoreNow(strategy: LoadBalancingStrategy): Promise<void> {
		if (!strategy.importAffinity) return;
		try {
			const now = this.now();
			const pins = await this.deps.store.getSessionAffinityPins(
				now - this.deps.maxAgeMs,
			);
			strategy.importAffinity(pins, now);
			log.info(`Restored ${pins.length} session affinity pin(s)`);
		} catch (err) {
			log.error(`Failed to restore session affinity pins: ${err}`);
		}
	}

	/**
	 * Seed a strategy that is replacing `previous`. The outgoing strategy's own
	 * pins are the newest state, and the table is read only when it has none to
	 * hand over, so pins cleared since the last snapshot cannot come back.
	 */
	async adopt(
		previous: LoadBalancingStrategy | null,
		next: LoadBalancingStrategy,
	): Promise<void> {
		if (!next.importAffinity) return;
		if (previous?.exportAffinity) {
			next.importAffinity(previous.exportAffinity(), this.now());
			return;
		}
		await this.restore(next);
	}

	start(): void {
		if (this.timer || this.stopped) return;
		this.timer = setInterval(
			() => this.tick(),
			this.deps.intervalMs ?? AFFINITY_SNAPSHOT_INTERVAL_MS,
		);
		this.timer.unref?.();
	}

	private tick(): void {
		if (this.tickQueued || this.stopped) return;
		this.tickQueued = true;
		void this.serial(() => this.writeIfChanged()).finally(() => {
			this.tickQueued = false;
		});
	}

	/** Queue one snapshot of the current strategy. Never throws. */
	snapshot(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		return this.serial(() => this.writeIfChanged());
	}

	/**
	 * Stop snapshotting and write the current pins once, after any snapshot
	 * already queued. Resolves after `timeoutMs` at the latest, so a stuck
	 * database cannot hold up shutdown.
	 */
	async flushFinal(
		timeoutMs: number = AFFINITY_FINAL_FLUSH_TIMEOUT_MS,
	): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.stopped = true;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timeout = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		const outcome = await Promise.race([
			this.serial(() => this.writeIfChanged()).then(() => "done" as const),
			timedOut,
		]);
		clearTimeout(timeout);
		if (outcome === "timeout") {
			this.closed = true;
			log.warn(
				`Session affinity pins not flushed within ${timeoutMs}ms; continuing shutdown`,
			);
		}
	}

	private async writeIfChanged(): Promise<void> {
		if (this.closed) return;
		const strategy = this.deps.getStrategy();
		if (!strategy?.exportAffinity) return;
		const revision = strategy.affinityRevision;
		if (
			revision !== undefined &&
			this.written?.strategy === strategy &&
			this.written.revision === revision
		)
			return;
		const pins = strategy.exportAffinity();
		try {
			await this.deps.store.replaceSessionAffinityPins(pins);
			this.written = { strategy, revision };
			log.debug(`Saved ${pins.length} session affinity pin(s)`);
		} catch (err) {
			log.error(`Failed to save session affinity pins: ${err}`);
		}
	}
}
