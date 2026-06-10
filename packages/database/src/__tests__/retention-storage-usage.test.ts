/**
 * Tests for DatabaseOperations.getRetentionStorageUsage — the per-data-type
 * storage breakdown (payloads / requests / usage snapshots) shown beside the
 * retention controls in the Settings card.
 *
 * Covers shape + ordering, empty-DB zeros, row/byte counting, the server-side
 * TTL cache (and forced recompute), and cache invalidation after cleanup.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "../database-operations";

function tempDbPath(): string {
	return join(
		tmpdir(),
		`test-storage-usage-${randomBytes(6).toString("hex")}.db`,
	);
}

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
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(() => {
		dbOps.dispose?.();
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
			"usage_snapshots",
			"memory_snapshots",
			"tool_calls",
			"tool_errors",
		]);
		expect(u.types.map((t) => t.table)).toEqual([
			"request_payloads",
			"requests",
			"usage_snapshots",
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
