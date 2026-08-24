/**
 * Quota-drift scheduler — the periodic precompute pass behind the Analytics
 * "Quota" tab.
 *
 * Split of responsibilities, and the reason there is a scheduler at all:
 *
 *  - the PASS runs on a dedicated read-only worker (`runQuotaDriftPass`),
 *    because it scans the whole snapshot and request history and must never sit
 *    in a lane that serves interactive dashboard reads;
 *  - the WRITE happens here, on the main thread, because the worker's
 *    connection is `readonly: true` + `PRAGMA query_only = ON` and cannot write
 *    its own result;
 *  - the ENDPOINT reads the stored row, so a dashboard request never triggers
 *    or waits on a fit.
 *
 * The interval is registered at t=0 and the FIRST run is deferred by a short
 * post-boot delay. Deferring registration instead has already bitten this repo
 * once — a boot stagger that deferred registration turned a refresh into a
 * permanent no-op — so registration and first-run delay are kept separate
 * concerns here.
 *
 * Every failure mode leaves the previously stored row in place. A stale
 * analysis is strictly better than a blank panel, and the payload is derived
 * data: the next tick recomputes it from scratch.
 */

import { intervalManager } from "@clankermux/core";
import { runQuotaDriftPass } from "@clankermux/http-api";
import { Logger } from "@clankermux/logger";

const log = new Logger("QuotaDriftScheduler");

/**
 * Recompute cadence. The inputs move at the sampler's 2-minute cadence, but the
 * fit is a 14-day rolling window over ~80 days of history: nothing it can say
 * changes meaningfully inside half an hour, and the pass is heavy enough that a
 * tighter cadence would spend real CPU to redraw the same lines.
 */
export const QUOTA_DRIFT_INTERVAL_MS = 30 * 60_000;

/**
 * Delay before the FIRST pass. Long enough to stay clear of the startup burst
 * (schema migration, poll stagger, dashboard build), short enough that a
 * restart does not leave the panel saying "computing" for half an hour.
 */
export const QUOTA_DRIFT_FIRST_RUN_DELAY_MS = 90_000;

export interface QuotaDriftSchedulerDeps {
	/** Absolute path to the live SQLite file (the worker opens its own handle). */
	getDbPath: () => string;
	/** Persist one completed pass. Main thread — the worker cannot write. */
	storeResult: (row: { computedAt: number; payload: string }) => Promise<void>;
	/** Run one pass. Injectable so tests need no worker. */
	runPass?: typeof runQuotaDriftPass;
	/** Override the cadence (tests). */
	intervalMs?: number;
	/** Override the first-run delay (tests). */
	firstRunDelayMs?: number;
}

export class QuotaDriftScheduler {
	private readonly deps: QuotaDriftSchedulerDeps;
	private stopInterval: (() => void) | null = null;
	private firstRunTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly intervalId = "quota-drift-scheduler";
	/**
	 * Guards the deferred first run against the recurring tick. `maxConcurrent`
	 * only covers callbacks the interval manager owns, and the first run is a
	 * one-shot timer outside it.
	 */
	private running = false;

	constructor(deps: QuotaDriftSchedulerDeps) {
		this.deps = { ...deps };
	}

	/**
	 * Register the recurring pass immediately and arm the deferred first run.
	 *
	 * Synchronous and non-throwing: nothing about startup should be able to fail
	 * because a derived analytics cache could not be scheduled.
	 */
	start(): void {
		const intervalMs = this.deps.intervalMs ?? QUOTA_DRIFT_INTERVAL_MS;
		const firstRunDelayMs =
			this.deps.firstRunDelayMs ?? QUOTA_DRIFT_FIRST_RUN_DELAY_MS;

		this.stopInterval = intervalManager.register({
			id: this.intervalId,
			callback: () => this.tick(),
			intervalMs,
			// The deferred one-shot below owns the first run; running one here
			// would land the pass in the middle of the startup burst.
			immediate: false,
			maxConcurrent: 1,
			description: "Quota-drift precompute (Analytics Quota tab)",
		});

		this.firstRunTimer = setTimeout(() => {
			this.firstRunTimer = null;
			void this.tick();
		}, firstRunDelayMs);
		this.firstRunTimer.unref?.();

		log.info(
			`Quota-drift scheduler started: interval=${Math.round(intervalMs / 60_000)}min, first pass in ~${Math.round(firstRunDelayMs / 1000)}s`,
		);
	}

	/** Cancel the deferred first run and unregister the recurring pass. */
	stop(): void {
		if (this.firstRunTimer) {
			clearTimeout(this.firstRunTimer);
			this.firstRunTimer = null;
		}
		if (this.stopInterval) {
			this.stopInterval();
			this.stopInterval = null;
		}
	}

	/**
	 * One pass: compute on the worker, store on this thread.
	 *
	 * Never throws. A failed pass logs and returns, leaving the previous row as
	 * the panel's answer.
	 */
	async tick(): Promise<void> {
		if (this.running) {
			log.debug("Quota-drift pass already running, skipping this tick");
			return;
		}
		this.running = true;
		try {
			const runPass = this.deps.runPass ?? runQuotaDriftPass;
			const now = Date.now();
			const { payload, workerMs } = await runPass({
				dbPath: this.deps.getDbPath(),
				now,
			});
			await this.deps.storeResult({
				computedAt: payload.computedAt ?? now,
				payload: JSON.stringify(payload),
			});
			log.info(
				`Quota-drift pass completed in ${Math.round(workerMs)}ms: ${payload.cohorts.length} cohort(s)`,
			);
		} catch (err) {
			log.error(`Quota-drift pass failed (previous result kept): ${err}`);
		} finally {
			this.running = false;
		}
	}
}
