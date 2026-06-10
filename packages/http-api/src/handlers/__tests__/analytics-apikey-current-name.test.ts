/**
 * Real-SQLite integration tests: the analytics endpoint must report each API
 * key under its CURRENT name (api_keys.name) rather than the snapshot stamped
 * on request rows at record time (requests.api_key_name), falling back to the
 * snapshot only for keys that have since been hard-deleted.
 *
 * Covers:
 *  - api_key_performance returns the NEW name and exactly one row per key id
 *    after a rename (historical rows carry mixed snapshots).
 *  - Deleted keys fall back to the snapshot name, still one row per key id.
 *  - The apiKeys filter matches by CURRENT name, so filtering on the new name
 *    includes requests recorded under the old name (and the old name no longer
 *    matches anything for a live key).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter, ensureSchema } from "@clankermux/database";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics-direct";

function makeContext(db: Database): APIContext {
	const adapter = new BunSqlAdapter(db);
	return {
		db: adapter,
		config: {},
		dbOps: {
			getAdapter: () => adapter,
		},
	} as unknown as APIContext;
}

function insertApiKey(db: Database, id: string, name: string): void {
	db.run(
		`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, last_used, usage_count, is_active)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
		[id, name, `hash-${id}`, "abcdefgh", 1000, 2000, 0],
	);
}

let requestSeq = 0;
function insertRequest(
	db: Database,
	apiKeyId: string | null,
	apiKeyName: string | null,
): void {
	requestSeq++;
	db.run(
		`INSERT INTO requests (id, timestamp, method, path, api_key_id, api_key_name, success, status_code)
		 VALUES (?, ?, 'POST', '/v1/messages', ?, ?, 1, 200)`,
		[`req-${requestSeq}`, Date.now(), apiKeyId, apiKeyName],
	);
}

type AnalyticsBody = {
	totals: { requests: number };
	apiKeyPerformance: Array<{ name: string; requests: number }>;
};

async function fetchAnalytics(
	context: APIContext,
	params = "",
): Promise<AnalyticsBody> {
	const response = await createAnalyticsHandler(context)(
		new URLSearchParams(params),
	);
	expect(response.status).toBe(200);
	return (await response.json()) as AnalyticsBody;
}

describe("analytics api_key_performance — current name with snapshot fallback", () => {
	let db: Database;
	let context: APIContext;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		context = makeContext(db);
	});

	afterEach(() => {
		db.close();
	});

	it("reports the renamed key under its NEW name, exactly one row per key", async () => {
		insertApiKey(db, "k1", "old-name");
		insertRequest(db, "k1", "old-name");
		insertRequest(db, "k1", "old-name");
		db.run(`UPDATE api_keys SET name = 'new-name' WHERE id = 'k1'`);
		insertRequest(db, "k1", "new-name");

		const body = await fetchAnalytics(context);
		expect(body.apiKeyPerformance).toHaveLength(1);
		expect(body.apiKeyPerformance[0].name).toBe("new-name");
		expect(body.apiKeyPerformance[0].requests).toBe(3);
	});

	it("falls back to the snapshot name for deleted keys, one row per key", async () => {
		// Mixed snapshots from past renames; the api_keys row is gone.
		insertRequest(db, "gone", "legacy-a");
		insertRequest(db, "gone", "legacy-b");

		const body = await fetchAnalytics(context);
		expect(body.apiKeyPerformance).toHaveLength(1);
		// MAX() over the snapshots picks one deterministic name.
		expect(body.apiKeyPerformance[0].name).toBe("legacy-b");
		expect(body.apiKeyPerformance[0].requests).toBe(2);
	});

	it("apiKeys filter matches the CURRENT name, including pre-rename requests", async () => {
		insertApiKey(db, "k1", "old-name");
		insertRequest(db, "k1", "old-name");
		insertRequest(db, "k1", "old-name");
		db.run(`UPDATE api_keys SET name = 'new-name' WHERE id = 'k1'`);
		insertRequest(db, "k1", "new-name");
		// Unrelated keyless request must not be matched by the filter.
		insertRequest(db, null, null);

		const filteredNew = await fetchAnalytics(context, "apiKeys=new-name");
		expect(filteredNew.totals.requests).toBe(3);

		// The old name no longer identifies the live key.
		const filteredOld = await fetchAnalytics(context, "apiKeys=old-name");
		expect(filteredOld.totals.requests).toBe(0);
	});

	it("apiKeys filter falls back to the snapshot name for deleted keys", async () => {
		insertRequest(db, "gone", "legacy-a");
		insertRequest(db, "gone", "legacy-b");
		insertRequest(db, null, null);

		const filtered = await fetchAnalytics(context, "apiKeys=legacy-a");
		expect(filtered.totals.requests).toBe(1);
	});
});
