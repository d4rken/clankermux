/**
 * Tests for StatsRepository.getApiKeyStats — per-key aggregation must report the
 * key's CURRENT name (api_keys.name), not the snapshot stamped on each request
 * row at record time (requests.api_key_name). The snapshot remains the fallback
 * for keys that have since been hard-deleted.
 *
 * Covers:
 *  - After a rename, the aggregation returns the NEW name and exactly one row
 *    per key id (even though historical rows carry different snapshots).
 *  - After a key is deleted, the aggregation falls back to the snapshot name
 *    and still collapses to one row per key id.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as api-key-rename.test.ts.
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { ApiKeyRepository } from "../api-key.repository";
import { StatsRepository } from "../stats.repository";

function makeDb(): {
	db: Database;
	stats: StatsRepository;
	keys: ApiKeyRepository;
} {
	const db = new Database(":memory:");
	ensureSchema(db);
	const adapter = new BunSqlAdapter(db);
	return {
		db,
		stats: new StatsRepository(adapter),
		keys: new ApiKeyRepository(adapter),
	};
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
	success = 1,
): void {
	requestSeq++;
	db.run(
		`INSERT INTO requests (id, timestamp, method, path, api_key_id, api_key_name, success, status_code)
		 VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?)`,
		[
			`req-${requestSeq}`,
			Date.now(),
			apiKeyId,
			apiKeyName,
			success,
			success ? 200 : 500,
		],
	);
}

describe("StatsRepository.getApiKeyStats — current name with snapshot fallback", () => {
	let db: Database;
	let stats: StatsRepository;
	let keys: ApiKeyRepository;

	beforeEach(() => {
		({ db, stats, keys } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("returns the renamed key's NEW name and exactly one row per key id", async () => {
		insertApiKey(db, "k1", "old-name");
		insertRequest(db, "k1", "old-name");
		insertRequest(db, "k1", "old-name");

		await keys.rename("k1", "new-name");
		// A request recorded after the rename stamps the new snapshot, so the
		// historical rows now carry two different snapshots for the same key.
		insertRequest(db, "k1", "new-name");

		const result = await stats.getApiKeyStats();
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("k1");
		expect(result[0].name).toBe("new-name");
		expect(result[0].requests).toBe(3);
	});

	it("falls back to the snapshot name for deleted keys, one row per key id", async () => {
		// Key existed once, was renamed (leaving mixed snapshots), then deleted.
		insertRequest(db, "gone", "legacy-a");
		insertRequest(db, "gone", "legacy-b");
		// No api_keys row for "gone" — hard-deleted.

		const result = await stats.getApiKeyStats();
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("gone");
		// MAX() over the snapshots gives a single deterministic name.
		expect(result[0].name).toBe("legacy-b");
		expect(result[0].requests).toBe(2);
	});
});
