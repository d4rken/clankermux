/**
 * Tests for ApiKeyRepository.rename — change only the human-readable label,
 * preserving the secret, stats, active state, and the routing pin.
 *
 * Covers:
 *  - rename() updates `name`, returns true, and leaves every other column
 *    (hashed_key, prefix_last_8, usage_count, is_active, created_at, last_used,
 *    pinned_account_id, pinned_providers) untouched.
 *  - rename() returns false when no row matches the id (e.g. a TOCTOU delete).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as api-key-pin.test.ts.
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { ApiKeyRepository } from "../api-key.repository";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: Database; repo: ApiKeyRepository } {
	const db = new Database(":memory:");
	// Use the real schema so the test exercises ensureSchema's api_keys columns.
	ensureSchema(db);
	const adapter = new BunSqlAdapter(db);
	const repo = new ApiKeyRepository(adapter);
	return { db, repo };
}

function insertApiKey(db: Database, id: string): void {
	db.run(
		`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, last_used, usage_count, is_active)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
		[id, id, `hash-${id}`, "abcdefgh", 1000, 2000, 7],
	);
}

interface FullRow {
	id: string;
	name: string;
	hashed_key: string;
	prefix_last_8: string;
	created_at: number;
	last_used: number | null;
	usage_count: number;
	is_active: number;
	pinned_account_id: string | null;
	pinned_providers: string | null;
}

function getRow(db: Database, id: string): FullRow {
	return db
		.query<FullRow, [string]>("SELECT * FROM api_keys WHERE id = ?")
		.get(id) as FullRow;
}

// ---------------------------------------------------------------------------
// Repository.rename
// ---------------------------------------------------------------------------

describe("ApiKeyRepository.rename", () => {
	let db: Database;
	let repo: ApiKeyRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("changes name, returns true, and preserves every other column", async () => {
		insertApiKey(db, "k1");
		// Set a routing pin so we can prove rename does not touch it.
		await repo.updatePin("k1", "acc-123", JSON.stringify(["codex"]));

		const before = getRow(db, "k1");

		const changed = await repo.rename("k1", "renamed-key");
		expect(changed).toBe(true);

		const after = getRow(db, "k1");
		expect(after.name).toBe("renamed-key");

		// Secret, prefix, stats, active state, and timestamps are unchanged.
		expect(after.hashed_key).toBe(before.hashed_key);
		expect(after.prefix_last_8).toBe(before.prefix_last_8);
		expect(after.usage_count).toBe(before.usage_count);
		expect(after.is_active).toBe(before.is_active);
		expect(after.created_at).toBe(before.created_at);
		expect(after.last_used).toBe(before.last_used);

		// The routing pin is preserved.
		expect(after.pinned_account_id).toBe("acc-123");
		expect(after.pinned_providers).toBe('["codex"]');

		// findById surfaces the new name.
		const key = await repo.findById("k1");
		expect(key?.name).toBe("renamed-key");
	});

	it("returns false when no row matches the id", async () => {
		const changed = await repo.rename("missing", "whatever");
		expect(changed).toBe(false);
	});
});
