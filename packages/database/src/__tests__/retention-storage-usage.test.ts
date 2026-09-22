/**
 * Tests for DatabaseOperations.getRetentionStorageUsage — the per-data-type
 * storage breakdown (payloads / requests / usage snapshots) shown beside the
 * retention controls in the Settings card.
 *
 * Covers shape + ordering, empty-DB zeros, row/byte counting, the server-side
 * TTL cache (and forced recompute), and cache invalidation after cleanup.
 *
 * The second describe covers what happens when a cleanup lands on top of a
 * running scan. Those tests fake the scan worker so it can be held mid-scan;
 * `cleanupOldRequests` keeps using its real incremental-vacuum worker, so the
 * invalidation under test is the production one.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { tempDbTracker } from "@clankermux/test-support";
import {
	DatabaseOperations,
	type RetentionStorageUsage,
} from "../database-operations";
import {
	resetStorageUsageAdmissionStateForTests,
	setStorageUsageWorkerFactoryForTests,
} from "../storage-usage-runner";
import {
	type FakeWorkerLog,
	installFakeWorkers,
	measuredAs,
} from "./fake-storage-usage-worker.fixture";

const tmpDb = tempDbTracker("test-storage-usage");

async function seedRequest(
	dbOps: DatabaseOperations,
	id: string,
	timestamp: number,
	withPayload: boolean,
	payloadJson = "{}",
): Promise<void> {
	const adapter = dbOps.getAdapter();
	await adapter.run(
		`INSERT INTO requests
			(id, timestamp, method, path, account_used, status_code, success,
			 error_message, response_time_ms, failover_attempts)
		 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
		[id, timestamp],
	);
	if (withPayload) {
		await adapter.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)`,
			[id, payloadJson, timestamp],
		);
	}
}

describe("DatabaseOperations.getRetentionStorageUsage", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tmpDb.next());
	});

	afterEach(async () => {
		try {
			await dbOps?.dispose();
		} finally {
			tmpDb.cleanup();
		}
	});

	it("returns the expected shape with the retention types in order", async () => {
		const u = await dbOps.getRetentionStorageUsage();
		expect(u.available).toBe(true);
		expect(typeof u.measuredAt).toBe("number");
		expect(typeof u.dbBytes).toBe("number");
		expect(u.dbBytes).toBeGreaterThan(0);
		expect(typeof u.walBytes).toBe("number");
		expect(u.walBytes).toBeGreaterThanOrEqual(0);
		expect(u.types.map((t) => t.key)).toEqual([
			"payloads",
			"requests",
			"headers",
			"usage_snapshots",
			"usage_scoped_snapshots",
			"unified_claim_observations",
			"unified_summary_observations",
			"internal_dispatch_spend",
			"codex_window_observations",
			"openai_bucket_observations",
			"quota_drift_results",
			"memory_snapshots",
			"tool_calls",
			"tool_errors",
		]);
		expect(u.types.map((t) => t.table)).toEqual([
			"request_payloads",
			"requests",
			"request_headers",
			"usage_snapshots",
			"usage_scoped_snapshots",
			"unified_claim_observations",
			"unified_summary_observations",
			"internal_dispatch_spend",
			"codex_window_observations",
			"openai_bucket_observations",
			"quota_drift_results",
			"memory_snapshots",
			"request_tool_calls",
			"request_tool_errors",
		]);
	});

	it("reports zero rows and bytes per type on an empty database", async () => {
		const u = await dbOps.getRetentionStorageUsage();
		for (const t of u.types) {
			expect(t.rowCount).toBe(0);
			expect(t.approxBytes).toBe(0);
		}
	});

	it("counts rows and approximate content bytes for payloads and requests", async () => {
		const now = Date.now();
		const bigJson = JSON.stringify({ body: "x".repeat(500) });
		await seedRequest(dbOps, "r1", now, true, bigJson);
		await seedRequest(dbOps, "r2", now, false);

		const u = await dbOps.getRetentionStorageUsage({ maxAgeMs: 0 });
		const byKey = Object.fromEntries(u.types.map((t) => [t.key, t]));

		expect(byKey.requests.rowCount).toBe(2);
		expect(byKey.payloads.rowCount).toBe(1);
		// The payload's logical size includes at least the stored JSON length.
		expect(byKey.payloads.approxBytes).toBeGreaterThanOrEqual(bigJson.length);
		expect(byKey.requests.approxBytes).toBeGreaterThan(0);
	});

	it("caches within the TTL and recomputes when maxAgeMs is 0", async () => {
		const first = await dbOps.getRetentionStorageUsage();

		// Mutate the underlying data after the first (now-cached) read.
		await seedRequest(dbOps, "r-cache", Date.now(), false);

		const cached = await dbOps.getRetentionStorageUsage();
		expect(cached.measuredAt).toBe(first.measuredAt);
		expect(cached.types.find((t) => t.key === "requests")?.rowCount).toBe(0);

		const fresh = await dbOps.getRetentionStorageUsage({ maxAgeMs: 0 });
		expect(fresh.types.find((t) => t.key === "requests")?.rowCount).toBe(1);
	});

	it("invalidates the cache after cleanupOldRequests", async () => {
		await seedRequest(dbOps, "r-old", 1000, true); // ancient → eligible for cleanup

		const before = await dbOps.getRetentionStorageUsage();
		expect(before.types.find((t) => t.key === "requests")?.rowCount).toBe(1);

		// Tiny retention removes the ancient row and clears the usage cache.
		await dbOps.cleanupOldRequests(0, 0, 0);

		const after = await dbOps.getRetentionStorageUsage();
		expect(after.measuredAt).toBeGreaterThanOrEqual(before.measuredAt);
		expect(after.types.find((t) => t.key === "requests")?.rowCount).toBe(0);
	});
});

/**
 * The marker `measuredAs` stamped on every table of one scan's result, which
 * is how a caller's numbers are traced back to the scan that produced them.
 */
function markerOf(usage: RetentionStorageUsage): number {
	expect(new Set(usage.types.map((t) => t.rowCount)).size).toBe(1);
	return usage.types[0].rowCount;
}

describe("getRetentionStorageUsage across cleanupOldRequests", () => {
	let dbOps: DatabaseOperations;
	let log: FakeWorkerLog;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tmpDb.next());
		log = installFakeWorkers();
	});

	afterEach(async () => {
		setStorageUsageWorkerFactoryForTests(null);
		resetStorageUsageAdmissionStateForTests();
		try {
			await dbOps?.dispose();
		} finally {
			tmpDb.cleanup();
		}
	});

	/**
	 * Give a caller that has just asked for usage a real chance to reach the
	 * runner — it has file I/O ahead of it, so a handful of loop turns would
	 * prove nothing — and return as soon as it builds the nth worker.
	 */
	function raceToWorker(index: number): Promise<unknown> {
		return Promise.race([log.nth(index), Bun.sleep(50)]);
	}

	it("starts no second scan while the pre-cleanup one is still running", async () => {
		// The reported sequence: a scan is in flight, a cleanup drops the cache
		// and detaches the in-flight promise, and the dashboard refetches at
		// once. Nothing on this side of the runner still points at the first
		// scan by then, so only the runner's own admission state keeps the
		// second worker off a multi-GB file the first one is still reading.
		const first = dbOps.getRetentionStorageUsage();
		const worker1 = await log.nth(1);

		await dbOps.cleanupOldRequests(0, 0, 0);
		const second = dbOps.getRetentionStorageUsage();
		await raceToWorker(2);
		expect(log.count).toBe(1);

		worker1.respond(measuredAs(worker1, 1));
		expect(markerOf(await first)).toBe(1);
		const worker2 = await log.nth(2);
		worker2.respond(measuredAs(worker2, 2));
		// Its own scan, not the pre-cleanup snapshot it asked to replace.
		expect(markerOf(await second)).toBe(2);

		expect(log.events).toEqual([
			"construct:1",
			"terminate:1",
			"construct:2",
			"terminate:2",
		]);
	});

	it("holds the post-cleanup scan until the first worker acknowledges its close", async () => {
		const first = dbOps.getRetentionStorageUsage();
		const worker1 = await log.nth(1);

		await dbOps.cleanupOldRequests(0, 0, 0);
		const second = dbOps.getRetentionStorageUsage();

		// The measurement is in, and the first worker has said nothing yet about
		// what it did with its file handle. Handing the path on here would put a
		// second reader on the file while the first may still be on it, so the
		// result landing is not what releases the successor.
		worker1.respondWithoutAck(measuredAs(worker1, 1));
		await raceToWorker(2);
		expect(log.count).toBe(1);

		worker1.acknowledge();
		expect(markerOf(await first)).toBe(1);

		const worker2 = await log.nth(2);
		worker2.respond(measuredAs(worker2, 2));
		const usage = await second;
		// Reaching a second worker at all is the other half of the claim: an
		// acknowledgement that missed the grace quarantines the path and this
		// caller would have been refused instead of scanned for.
		expect(usage.available).toBe(true);
		expect(markerOf(usage)).toBe(2);
	});

	it("does not serve a later caller a scan that started before the newest cleanup", async () => {
		const a = dbOps.getRetentionStorageUsage();
		const workerA = await log.nth(1);

		await dbOps.cleanupOldRequests(0, 0, 0);
		const b = dbOps.getRetentionStorageUsage();
		await raceToWorker(2);
		expect(log.count).toBe(1);

		workerA.respond(measuredAs(workerA, 1));
		expect(markerOf(await a)).toBe(1);
		const workerB = await log.nth(2);

		// B is running now. This cleanup makes its numbers stale before it has
		// reported them, and C arrives afterwards — so C's computation starts
		// after the invalidation, which is past the reach of the generation
		// counter guarding scans that started before one.
		await dbOps.cleanupOldRequests(0, 0, 0);
		const c = dbOps.getRetentionStorageUsage();
		await raceToWorker(3);
		expect(log.count).toBe(2);

		workerB.respond(measuredAs(workerB, 2));
		expect(markerOf(await b)).toBe(2);

		// Arrives with B finished and C still queued: B's snapshot predates the
		// second cleanup, so there must be nothing cached for this one to be
		// served out of.
		const joiner = dbOps.getRetentionStorageUsage();

		const workerC = await log.nth(3);
		workerC.respond(measuredAs(workerC, 3));
		expect(markerOf(await c)).toBe(3);
		expect(markerOf(await joiner)).toBe(3);

		// Only C's scan is eligible for the newest generation, so C's numbers
		// are what the cache holds and this read builds nothing.
		expect(markerOf(await dbOps.getRetentionStorageUsage())).toBe(3);
		expect(log.events).toEqual([
			"construct:1",
			"terminate:1",
			"construct:2",
			"terminate:2",
			"construct:3",
			"terminate:3",
		]);
	});

	it("keeps refusing a failed path even though a cleanup cleared the cache", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const first = dbOps.getRetentionStorageUsage();
			const worker1 = await log.nth(1);
			worker1.respond({ ok: false, error: "disk went away" });
			expect((await first).available).toBe(false);

			// Dropping the cache is not a way to retry a failing disk sooner: the
			// backoff is held on the path, where a cleanup cannot reach it.
			await dbOps.cleanupOldRequests(0, 0, 0);
			const second = await dbOps.getRetentionStorageUsage();

			expect(second.available).toBe(false);
			expect(log.count).toBe(1);
			expect(warn.mock.calls.flat().join("\n")).toContain("cooldown");
		} finally {
			warn.mockRestore();
		}
	});
});
