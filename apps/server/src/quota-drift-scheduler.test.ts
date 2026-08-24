/**
 * Quota-drift scheduler.
 *
 * The pass itself is covered by the http-api compute tests; what is asserted
 * here is the scheduling contract:
 *
 *  - the recurring interval is registered at t=0, NOT inside the first-run
 *    deferral. Deferring registration has already turned a refresh into a
 *    permanent no-op in this repo once;
 *  - the first pass is deferred rather than immediate, so it does not land in
 *    the middle of the startup burst;
 *  - a failed pass leaves the previously stored row alone. The payload is
 *    derived data and a stale analysis beats a blank panel;
 *  - `stop()` cancels both the deferral and the interval.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { intervalManager } from "@clankermux/core";
import type { QuotaDriftResponse } from "@clankermux/types";
import {
	QUOTA_DRIFT_INTERVAL_MS,
	QuotaDriftScheduler,
} from "./quota-drift-scheduler";

const INTERVAL_ID = "quota-drift-scheduler";

const EMPTY_PAYLOAD: QuotaDriftResponse = {
	status: "ready",
	computedAt: 1_700_000_000_000,
	computeMs: 12,
	cohorts: [],
};

let scheduler: QuotaDriftScheduler | null = null;

afterEach(() => {
	scheduler?.stop();
	scheduler = null;
	intervalManager.unregister(INTERVAL_ID);
});

describe("QuotaDriftScheduler", () => {
	it("registers the recurring pass immediately and defers the first run", async () => {
		const stored: Array<{ computedAt: number; payload: string }> = [];
		let passes = 0;
		scheduler = new QuotaDriftScheduler({
			getDbPath: () => "/tmp/does-not-matter.db",
			storeResult: async (row) => {
				stored.push(row);
			},
			runPass: async () => {
				passes++;
				return { payload: EMPTY_PAYLOAD, workerMs: 5 };
			},
			// Long enough that the assertion below runs before it fires.
			firstRunDelayMs: 60_000,
		});
		scheduler.start();

		expect(intervalManager.has(INTERVAL_ID)).toBe(true);
		// Deferred, so nothing has run yet.
		expect(passes).toBe(0);
		expect(stored).toHaveLength(0);

		const info = intervalManager
			.getIntervalInfo()
			.find((i) => i.id === INTERVAL_ID);
		expect(info?.intervalMs).toBe(QUOTA_DRIFT_INTERVAL_MS);
	});

	it("stores the payload keyed on the pass's own computedAt", async () => {
		const stored: Array<{ computedAt: number; payload: string }> = [];
		scheduler = new QuotaDriftScheduler({
			getDbPath: () => "/tmp/does-not-matter.db",
			storeResult: async (row) => {
				stored.push(row);
			},
			runPass: async () => ({ payload: EMPTY_PAYLOAD, workerMs: 5 }),
			firstRunDelayMs: 60_000,
		});
		scheduler.start();
		await scheduler.tick();

		expect(stored).toHaveLength(1);
		expect(stored[0].computedAt).toBe(EMPTY_PAYLOAD.computedAt);
		expect(JSON.parse(stored[0].payload)).toEqual(EMPTY_PAYLOAD);
	});

	it("leaves the previous row in place when a pass fails", async () => {
		let writes = 0;
		scheduler = new QuotaDriftScheduler({
			getDbPath: () => "/tmp/does-not-matter.db",
			storeResult: async () => {
				writes++;
			},
			runPass: async () => {
				throw new Error("worker exploded");
			},
			firstRunDelayMs: 60_000,
		});
		scheduler.start();

		// Never throws: a derived analytics cache must not be able to take a
		// scheduled job (or the process) down.
		await scheduler.tick();
		expect(writes).toBe(0);
	});

	it("does not start a second pass while one is still running", async () => {
		let started = 0;
		let release: (() => void) | null = null;
		scheduler = new QuotaDriftScheduler({
			getDbPath: () => "/tmp/does-not-matter.db",
			storeResult: async () => {},
			runPass: async () => {
				started++;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return { payload: EMPTY_PAYLOAD, workerMs: 5 };
			},
			firstRunDelayMs: 60_000,
		});
		scheduler.start();

		const first = scheduler.tick();
		// The deferred first run and the recurring tick are separate timers, so
		// the guard has to be the scheduler's own, not the interval manager's.
		await scheduler.tick();
		expect(started).toBe(1);

		release?.();
		await first;
		expect(started).toBe(1);
	});

	it("unregisters the interval on stop", () => {
		scheduler = new QuotaDriftScheduler({
			getDbPath: () => "/tmp/does-not-matter.db",
			storeResult: async () => {},
			runPass: async () => ({ payload: EMPTY_PAYLOAD, workerMs: 5 }),
			firstRunDelayMs: 60_000,
		});
		scheduler.start();
		expect(intervalManager.has(INTERVAL_ID)).toBe(true);

		scheduler.stop();
		expect(intervalManager.has(INTERVAL_ID)).toBe(false);
	});
});
