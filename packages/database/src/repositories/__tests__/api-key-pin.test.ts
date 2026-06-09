/**
 * Tests for the API-key → account/provider pin data layer (Stage A).
 *
 * Covers:
 *  - schema: ensureSchema gives api_keys the pinned_account_id and
 *    pinned_providers columns
 *  - ApiKeyRepository.updatePin round-trips an account id and a serialized
 *    provider-array JSON string, and clears both back to NULL
 *  - findById surfaces the parsed pinnedAccountId / pinnedProviders
 *  - toApiKey parses a valid JSON-array pinned_providers to string[] and
 *    returns null for invalid JSON / empty array / null
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as account-pause-reason.test.ts.
import "@clankermux/core";
import { type ApiKeyRow, toApiKey } from "@clankermux/types";
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
		`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, is_active)
		 VALUES (?, ?, ?, ?, ?, 1)`,
		[id, id, `hash-${id}`, "abcdefgh", Date.now()],
	);
}

interface RawPin {
	pinned_account_id: string | null;
	pinned_providers: string | null;
}

function getPin(db: Database, id: string): RawPin {
	return db
		.query<RawPin, [string]>(
			"SELECT pinned_account_id, pinned_providers FROM api_keys WHERE id = ?",
		)
		.get(id) as RawPin;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("api_keys schema — pin columns", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("ensureSchema gives api_keys pinned_account_id and pinned_providers", () => {
		ensureSchema(db);

		const cols = (
			db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>
		).map((c) => c.name);

		expect(cols).toContain("pinned_account_id");
		expect(cols).toContain("pinned_providers");
	});

	it("new keys default both pin columns to NULL", () => {
		ensureSchema(db);
		insertApiKey(db, "k-default");

		const row = db
			.query<RawPin, [string]>(
				"SELECT pinned_account_id, pinned_providers FROM api_keys WHERE id = ?",
			)
			.get("k-default") as RawPin;

		expect(row.pinned_account_id).toBeNull();
		expect(row.pinned_providers).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Repository.updatePin
// ---------------------------------------------------------------------------

describe("ApiKeyRepository.updatePin", () => {
	let db: Database;
	let repo: ApiKeyRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("pins an exact account id and clears providers", async () => {
		insertApiKey(db, "k1");

		const changed = await repo.updatePin("k1", "acc-123", null);
		expect(changed).toBe(true);

		const raw = getPin(db, "k1");
		expect(raw.pinned_account_id).toBe("acc-123");
		expect(raw.pinned_providers).toBeNull();

		const key = await repo.findById("k1");
		expect(key?.pinnedAccountId).toBe("acc-123");
		expect(key?.pinnedProviders).toBeNull();
	});

	it("pins a serialized providers JSON array and clears account id", async () => {
		insertApiKey(db, "k2");

		const changed = await repo.updatePin(
			"k2",
			null,
			JSON.stringify(["codex", "openai-compatible"]),
		);
		expect(changed).toBe(true);

		const raw = getPin(db, "k2");
		expect(raw.pinned_account_id).toBeNull();
		expect(raw.pinned_providers).toBe('["codex","openai-compatible"]');

		const key = await repo.findById("k2");
		expect(key?.pinnedAccountId).toBeNull();
		expect(key?.pinnedProviders).toEqual(["codex", "openai-compatible"]);
	});

	it("clears both pins back to NULL", async () => {
		insertApiKey(db, "k3");
		await repo.updatePin("k3", "acc-x", null);

		const changed = await repo.updatePin("k3", null, null);
		expect(changed).toBe(true);

		const raw = getPin(db, "k3");
		expect(raw.pinned_account_id).toBeNull();
		expect(raw.pinned_providers).toBeNull();

		const key = await repo.findById("k3");
		expect(key?.pinnedAccountId).toBeNull();
		expect(key?.pinnedProviders).toBeNull();
	});

	it("returns false when the key does not exist", async () => {
		const changed = await repo.updatePin("missing", "acc-1", null);
		expect(changed).toBe(false);
	});

	it("findAll / findActive surface the pin fields", async () => {
		insertApiKey(db, "k4");
		await repo.updatePin("k4", null, JSON.stringify(["codex"]));

		const all = await repo.findAll();
		expect(all.find((k) => k.id === "k4")?.pinnedProviders).toEqual(["codex"]);

		const active = await repo.findActive();
		expect(active.find((k) => k.id === "k4")?.pinnedProviders).toEqual([
			"codex",
		]);
	});
});

// ---------------------------------------------------------------------------
// toApiKey — defensive pinned_providers parsing
// ---------------------------------------------------------------------------

describe("toApiKey — pinned_providers parsing", () => {
	function rowWith(pinned_providers: string | null): ApiKeyRow {
		return {
			id: "id",
			name: "name",
			hashed_key: "h",
			prefix_last_8: "abcdefgh",
			created_at: 1000,
			last_used: null,
			usage_count: 0,
			is_active: 1,
			pinned_account_id: null,
			pinned_providers,
		};
	}

	it("parses a valid JSON array of strings", () => {
		const key = toApiKey(rowWith('["codex","openai-compatible"]'));
		expect(key.pinnedProviders).toEqual(["codex", "openai-compatible"]);
	});

	it("returns null for NULL", () => {
		expect(toApiKey(rowWith(null)).pinnedProviders).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(toApiKey(rowWith("")).pinnedProviders).toBeNull();
	});

	it("returns null for an empty array", () => {
		expect(toApiKey(rowWith("[]")).pinnedProviders).toBeNull();
	});

	it("returns null for invalid JSON (never throws)", () => {
		expect(toApiKey(rowWith("not json")).pinnedProviders).toBeNull();
		expect(toApiKey(rowWith("{")).pinnedProviders).toBeNull();
	});

	it("returns null for a non-array JSON value", () => {
		expect(toApiKey(rowWith('"codex"')).pinnedProviders).toBeNull();
		expect(toApiKey(rowWith('{"a":1}')).pinnedProviders).toBeNull();
		expect(toApiKey(rowWith("42")).pinnedProviders).toBeNull();
	});

	it("returns null when the array contains non-string entries", () => {
		expect(toApiKey(rowWith('["codex", 1]')).pinnedProviders).toBeNull();
		expect(toApiKey(rowWith("[true]")).pinnedProviders).toBeNull();
	});

	it("maps pinned_account_id straight through", () => {
		const row = rowWith(null);
		row.pinned_account_id = "acc-9";
		expect(toApiKey(row).pinnedAccountId).toBe("acc-9");
	});
});
