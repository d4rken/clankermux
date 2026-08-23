/**
 * Tests for the payload BYTE BUDGET: the second retention rule on
 * `request_payloads`, alongside the existing age window.
 *
 * Covers the whole chain against REAL temp databases (never the live DB):
 *   - the `bytes` column + `idx_request_payloads_size` covering index reaching
 *     both fresh installs (ensureSchema) and upgraded DBs (ADDITIVE_COLUMNS),
 *   - the payload writer recording the UTF-8 size on every write AND rewrite,
 *   - the eviction pass itself: what it counts, what it may delete, the order
 *     it runs in, and the select-then-delete race the atomic delete closes.
 *
 * Governing invariant under test: the budget counts EXACTLY the rows the pass
 * can evict (`bytes IS NOT NULL AND timestamp IS NOT NULL`). Counting a row it
 * cannot delete would pin the total over budget forever; deleting a row it does
 * not count would throw away data that contributed nothing to the overage.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "../database-operations";
import { deleteBatched } from "../incremental-vacuum-worker";
import { ensureSchema, runMigrations } from "../migrations";
import {
	createPayloadWriteEngine,
	openPayloadWriteDatabase,
	type PayloadWriteRowMessage,
} from "../payload-write-worker";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

let tmpDir: string;
let dbPath: string;

function open(): Database {
	const db = new Database(dbPath);
	db.exec("PRAGMA busy_timeout = 5000");
	return db;
}

/** Seed a request row plus its payload. `bytes: null` models a legacy row. */
function seedPayload(
	db: Database,
	id: string,
	timestamp: number | null,
	bytes: number | null,
	json = "{}",
): void {
	db.run(
		"INSERT INTO requests (id, timestamp, method, path) VALUES (?, ?, 'POST', '/v1/m')",
		[id, timestamp ?? Date.now()],
	);
	db.run(
		"INSERT INTO request_payloads (id, json, timestamp, bytes) VALUES (?, ?, ?, ?)",
		[id, json, timestamp, bytes],
	);
}

function payloadIds(db: Database): string[] {
	return (
		db.query("SELECT id FROM request_payloads ORDER BY id").all() as Array<{
			id: string;
		}>
	).map((r) => r.id);
}

function storedBytes(db: Database, id: string): number | null {
	const row = db
		.query("SELECT bytes FROM request_payloads WHERE id = ?")
		.get(id) as { bytes: number | null } | null;
	return row ? row.bytes : null;
}

function totalPayloadBytes(db: Database): number {
	const row = db
		.query(
			"SELECT COALESCE(SUM(bytes), 0) AS total FROM request_payloads WHERE bytes IS NOT NULL AND timestamp IS NOT NULL",
		)
		.get() as { total: number };
	return row.total;
}

function indexExists(db: Database, name: string): boolean {
	return (
		db
			.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
			.get(name) != null
	);
}

function columnNames(db: Database, table: string): Set<string> {
	return new Set(
		(
			db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
		).map((c) => c.name),
	);
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clankermux-payload-size-"));
	dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("schema: bytes column + size index", () => {
	it("adds `bytes` and the size index to a DB created WITHOUT the column", () => {
		// Regression for the migration ordering trap: an index over a column that
		// only ADDITIVE_COLUMNS can supply must not be created before the ALTER
		// that supplies it, or startup throws `no such column: bytes` on every
		// upgraded DB. runMigrations() now applies the ALTERs BEFORE
		// ensureSchema() (whose last statement is addPerformanceIndexes()), so
		// the index is created unconditionally and this DB must come out with
		// both the column and the index.
		const db = new Database(dbPath, { create: true });
		try {
			// The pre-`bytes` shape, exactly as an existing deployment has it.
			db.run(`
				CREATE TABLE request_payloads (
					id TEXT PRIMARY KEY,
					json TEXT NOT NULL,
					timestamp INTEGER,
					FOREIGN KEY (id) REFERENCES requests(id) ON DELETE CASCADE
				)
			`);
			expect(columnNames(db, "request_payloads").has("bytes")).toBe(false);

			expect(() => runMigrations(db)).not.toThrow();

			expect(columnNames(db, "request_payloads").has("bytes")).toBe(true);
			expect(indexExists(db, "idx_request_payloads_size")).toBe(true);
		} finally {
			db.close();
		}
	});

	it("creates the size index from a bare ensureSchema() on a fresh DB", () => {
		// The completeness contract: ensureSchema() ALONE must produce the full
		// current schema (repository fixtures build DBs with nothing else).
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			expect(columnNames(db, "request_payloads").has("bytes")).toBe(true);
			expect(indexExists(db, "idx_request_payloads_size")).toBe(true);
		} finally {
			db.close();
		}
	});

	it("is idempotent when runMigrations() runs twice", () => {
		const db = new Database(dbPath, { create: true });
		try {
			runMigrations(db);
			expect(() => runMigrations(db)).not.toThrow();
			expect(indexExists(db, "idx_request_payloads_size")).toBe(true);
		} finally {
			db.close();
		}
	});
});

describe("payload writer records the size", () => {
	function row(
		overrides: Partial<PayloadWriteRowMessage> = {},
	): PayloadWriteRowMessage {
		return {
			type: "write",
			generation: 1,
			seq: 1,
			id: "req-1",
			ciphertext: "{}",
			timestamp: Date.now(),
			...overrides,
		};
	}

	it("stores the UTF-8 byte length, not the character count", () => {
		const schemaDb = new Database(dbPath, { create: true });
		runMigrations(schemaDb);
		schemaDb.run(
			"INSERT INTO requests (id, timestamp, method, path) VALUES ('req-1', ?, 'POST', '/v1/m')",
			[Date.now()],
		);
		schemaDb.close();

		// Multi-byte content: character count ≠ byte count, and the budget is in
		// BYTES — a String.length here would under-count by ~3x on such payloads.
		const ciphertext = JSON.stringify({ text: "héllo → wörld ✓" });
		expect(ciphertext.length).not.toBe(Buffer.byteLength(ciphertext));

		const db = openPayloadWriteDatabase(dbPath, 1000);
		try {
			const engine = createPayloadWriteEngine({
				db,
				generation: 1,
				post: () => {},
			});
			engine.accept(row({ ciphertext }));
			engine.flush();
		} finally {
			db.close();
		}

		const reader = open();
		try {
			expect(storedBytes(reader, "req-1")).toBe(Buffer.byteLength(ciphertext));
		} finally {
			reader.close();
		}
	});

	it("UPDATES bytes when an existing id is re-written", () => {
		// The replay path re-sends entries and a payload can be rewritten with
		// different content; a stale size would survive indefinitely and
		// mis-drive eviction.
		const schemaDb = new Database(dbPath, { create: true });
		runMigrations(schemaDb);
		schemaDb.run(
			"INSERT INTO requests (id, timestamp, method, path) VALUES ('req-1', ?, 'POST', '/v1/m')",
			[Date.now()],
		);
		schemaDb.close();

		const small = JSON.stringify({ a: 1 });
		const large = JSON.stringify({ a: "x".repeat(500) });

		const db = openPayloadWriteDatabase(dbPath, 1000);
		try {
			const engine = createPayloadWriteEngine({
				db,
				generation: 1,
				post: () => {},
			});
			engine.accept(row({ seq: 1, ciphertext: small }));
			engine.flush();
			engine.accept(row({ seq: 2, ciphertext: large }));
			engine.flush();
		} finally {
			db.close();
		}

		const reader = open();
		try {
			expect(storedBytes(reader, "req-1")).toBe(Buffer.byteLength(large));
		} finally {
			reader.close();
		}
	});
});

describe("byte-budget eviction pass", () => {
	let now: number;

	beforeEach(async () => {
		now = Date.now();
		const dbOps = new DatabaseOperations(dbPath);
		await dbOps.close();
	});

	/**
	 * Run cleanup with the byte budget only: a 1-year payload window and no
	 * request window, so nothing but the size pass can delete a payload.
	 */
	async function runSizeCleanup(payloadMaxBytes: number) {
		const dbOps = new DatabaseOperations(dbPath);
		try {
			return await dbOps.cleanupOldRequests(
				YEAR_MS,
				undefined,
				undefined,
				undefined,
				payloadMaxBytes,
			);
		} finally {
			await dbOps.close();
		}
	}

	it("evicts oldest-first until the total fits, leaving the newest rows intact", async () => {
		const db = open();
		try {
			for (let i = 1; i <= 5; i++) {
				seedPayload(db, `p${i}`, now - (6 - i) * 1000, 100);
			}
		} finally {
			db.close();
		}

		// 500 bytes stored, 250 allowed: newest-first the running sum crosses at
		// p3, so p1..p3 go and p4+p5 (200 bytes) stay.
		const res = await runSizeCleanup(250);
		expect(res.removedPayloadsBySize).toBe(3);
		expect(res.removedPayloads).toBe(3);

		const reader = open();
		try {
			expect(payloadIds(reader)).toEqual(["p4", "p5"]);
			expect(totalPayloadBytes(reader)).toBeLessThanOrEqual(250);
			// The request rows themselves are untouched — only payloads are capped.
			expect(
				(
					reader.query("SELECT COUNT(*) AS n FROM requests").get() as {
						n: number;
					}
				).n,
			).toBe(5);
		} finally {
			reader.close();
		}
	});

	it("does nothing when the budget is 0 (disabled)", async () => {
		const db = open();
		try {
			for (let i = 1; i <= 5; i++) {
				seedPayload(db, `p${i}`, now - (6 - i) * 1000, 100);
			}
		} finally {
			db.close();
		}

		const res = await runSizeCleanup(0);
		expect(res.removedPayloadsBySize).toBe(0);
		expect(res.removedPayloads).toBe(0);

		const reader = open();
		try {
			expect(payloadIds(reader)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
		} finally {
			reader.close();
		}
	});

	it("does nothing when the total is already under budget", async () => {
		const db = open();
		try {
			seedPayload(db, "p1", now - 2000, 100);
			seedPayload(db, "p2", now - 1000, 100);
		} finally {
			db.close();
		}

		const res = await runSizeCleanup(10_000);
		expect(res.removedPayloadsBySize).toBe(0);

		const reader = open();
		try {
			expect(payloadIds(reader)).toEqual(["p1", "p2"]);
		} finally {
			reader.close();
		}
	});

	it("SURVIVES a legacy bytes-IS-NULL row older than the cutoff", async () => {
		// The pass cannot delete what it does not count: a pre-migration row
		// contributes nothing to the overage, so evicting it would destroy data
		// for no benefit.
		const db = open();
		try {
			seedPayload(db, "legacy", now - 5000, null);
			seedPayload(db, "old", now - 2000, 100);
			seedPayload(db, "new", now - 1000, 100);
		} finally {
			db.close();
		}

		const res = await runSizeCleanup(150);
		expect(res.removedPayloadsBySize).toBe(1);

		const reader = open();
		try {
			// "legacy" is OLDER than the evicted "old" row and still survives.
			expect(payloadIds(reader)).toEqual(["legacy", "new"]);
		} finally {
			reader.close();
		}
	});

	it("EXCLUDES a timestamp-IS-NULL row from the running sum so it cannot pin the total", async () => {
		// The mirror image: counting a row the pass can never delete would keep
		// the total permanently over budget, so every tick would evict collectable
		// rows without ever converging.
		const db = open();
		try {
			seedPayload(db, "no-ts", null, 100_000);
			seedPayload(db, "old", now - 2000, 100);
			seedPayload(db, "new", now - 1000, 100);
		} finally {
			db.close();
		}

		const res = await runSizeCleanup(150);
		// Only "old" — had the 100 KB unstamped row counted, both stamped rows
		// would have been evicted (and the total would STILL be over budget).
		expect(res.removedPayloadsBySize).toBe(1);

		const reader = open();
		try {
			expect(payloadIds(reader)).toEqual(["new", "no-ts"]);
		} finally {
			reader.close();
		}
	});

	it("does not crash on an empty table", async () => {
		const res = await runSizeCleanup(1000);
		expect(res.removedPayloadsBySize).toBe(0);
		expect(res.removedPayloads).toBe(0);
	});

	it("does not crash when every row has NULL bytes and NULL timestamps", async () => {
		const db = open();
		try {
			seedPayload(db, "a", null, null);
			seedPayload(db, "b", null, null);
		} finally {
			db.close();
		}

		const res = await runSizeCleanup(1);
		expect(res.removedPayloadsBySize).toBe(0);

		const reader = open();
		try {
			expect(payloadIds(reader)).toEqual(["a", "b"]);
		} finally {
			reader.close();
		}
	});

	it("evicts a single payload larger than the entire budget", async () => {
		const db = open();
		try {
			seedPayload(db, "huge", now - 1000, 5000);
		} finally {
			db.close();
		}

		const res = await runSizeCleanup(1000);
		expect(res.removedPayloadsBySize).toBe(1);

		const reader = open();
		try {
			expect(payloadIds(reader)).toEqual([]);
			expect(totalPayloadBytes(reader)).toBe(0);
		} finally {
			reader.close();
		}
	});

	it("empties the table when the NEWEST row alone exceeds the budget", async () => {
		// Policy, not collateral damage: retention keeps a CONTIGUOUS PREFIX of the
		// newest rows. When the newest row alone busts the budget, no prefix fits,
		// so nothing is retained. The older small rows are not innocent bystanders —
		// they are older than a row that itself cannot be kept, and keeping them
		// while discarding a newer row would be a different, non-age-prioritized
		// policy.
		const db = open();
		try {
			seedPayload(db, "small-old", now - 3000, 100);
			seedPayload(db, "small-mid", now - 2000, 100);
			seedPayload(db, "huge", now - 1000, 5000);
		} finally {
			db.close();
		}

		const res = await runSizeCleanup(1000);
		expect(res.removedPayloadsBySize).toBe(3);

		const reader = open();
		try {
			expect(payloadIds(reader)).toEqual([]);
			expect(totalPayloadBytes(reader)).toBe(0);
		} finally {
			reader.close();
		}
	});

	it("removes rows tied on the cutoff millisecond as a whole bucket", async () => {
		// Deliberate: `timestamp <= cutoff` can land marginally UNDER budget
		// rather than carry tuple-cutoff complexity. Measured live, at most two
		// rows share a millisecond.
		const db = open();
		try {
			seedPayload(db, "tied-a", now - 2000, 100);
			seedPayload(db, "tied-b", now - 2000, 100);
			seedPayload(db, "newest", now - 1000, 100);
		} finally {
			db.close();
		}

		const res = await runSizeCleanup(150);
		expect(res.removedPayloadsBySize).toBe(2);

		const reader = open();
		try {
			expect(payloadIds(reader)).toEqual(["newest"]);
			// 100 bytes left against a 150 budget — the whole-bucket delete
			// undershoots by design.
			expect(totalPayloadBytes(reader)).toBe(100);
		} finally {
			reader.close();
		}
	});

	it("runs AFTER the request age pass, so cascaded payloads do not drive eviction", async () => {
		// A payload whose parent request is about to be deleted still counts
		// toward the budget until that cascade happens. Running the size pass
		// earlier would evict survivors to make room for a row that is leaving
		// anyway.
		const db = open();
		try {
			// Old REQUEST, freshly-rewritten payload (600 of the 1200 bytes).
			db.run(
				"INSERT INTO requests (id, timestamp, method, path) VALUES ('stale-req', ?, 'POST', '/v1/m')",
				[now - 10 * 24 * HOUR_MS],
			);
			db.run(
				"INSERT INTO request_payloads (id, json, timestamp, bytes) VALUES ('stale-req', '{}', ?, 600)",
				[now - 1000],
			);
			seedPayload(db, "keep-1", now - 3000, 300);
			seedPayload(db, "keep-2", now - 2000, 300);
		} finally {
			db.close();
		}

		const dbOps = new DatabaseOperations(dbPath);
		let res: Awaited<ReturnType<DatabaseOperations["cleanupOldRequests"]>>;
		try {
			// Request window (1 day) shorter than the payload window (1 year).
			res = await dbOps.cleanupOldRequests(
				YEAR_MS,
				24 * HOUR_MS,
				undefined,
				undefined,
				1000,
			);
		} finally {
			await dbOps.close();
		}

		expect(res.removedRequests).toBe(1);
		// After the cascade only 600 bytes remain — under budget, nothing evicted.
		expect(res.removedPayloadsBySize).toBe(0);

		const reader = open();
		try {
			// Had the size pass run first, the 1200-byte total would have evicted
			// the oldest survivor (keep-1).
			expect(payloadIds(reader)).toEqual(["keep-1", "keep-2"]);
		} finally {
			reader.close();
		}
	});

	it("composes with the age pass: removedPayloads is the TOTAL, bySize the detail", async () => {
		const db = open();
		try {
			for (let i = 1; i <= 3; i++) {
				seedPayload(db, `aged-${i}`, now - 2 * HOUR_MS - i, 100);
			}
			for (let i = 1; i <= 5; i++) {
				seedPayload(db, `recent-${i}`, now - (6 - i) * 1000, 100);
			}
		} finally {
			db.close();
		}

		const dbOps = new DatabaseOperations(dbPath);
		let res: Awaited<ReturnType<DatabaseOperations["cleanupOldRequests"]>>;
		try {
			// 1-hour payload window kills the three aged rows; the 250-byte budget
			// then trims the five recent ones down to two.
			res = await dbOps.cleanupOldRequests(
				HOUR_MS,
				undefined,
				undefined,
				undefined,
				250,
			);
		} finally {
			await dbOps.close();
		}

		expect(res.removedPayloadsBySize).toBe(3);
		expect(res.removedPayloads).toBe(6);

		const reader = open();
		try {
			expect(payloadIds(reader)).toEqual(["recent-4", "recent-5"]);
		} finally {
			reader.close();
		}
	});
});

describe("deleteBatched: select-then-delete race", () => {
	/**
	 * Wrap a real handle so a concurrent payload upsert lands at the exact
	 * moment a candidate row has been chosen but not yet deleted. In atomic mode
	 * the candidate is chosen INSIDE the delete statement, so mutating the row
	 * just before the statement runs models precisely that window.
	 */
	function wrapWithConcurrentUpsert(
		db: Database,
		id: string,
		freshTimestamp: number,
	): { handle: Database; injected: () => boolean } {
		let injected = false;
		const handle = {
			query: (sql: string) => db.query(sql),
			run: (sql: string, params?: unknown[]) => {
				if (!injected) {
					injected = true;
					db.run(
						`INSERT INTO request_payloads (id, json, timestamp, bytes) VALUES (?, '{"fresh":true}', ?, 10)
						 ON CONFLICT (id) DO UPDATE SET json = excluded.json, timestamp = excluded.timestamp, bytes = excluded.bytes`,
						[id, freshTimestamp],
					);
				}
				return db.run(sql, params as never);
			},
		} as unknown as Database;
		return { handle, injected: () => injected };
	}

	const PREDICATE =
		"bytes IS NOT NULL AND timestamp IS NOT NULL AND timestamp <= ?";

	it("atomic mode does NOT delete a row rewritten after the candidates were chosen", async () => {
		const now = Date.now();
		const schemaDb = new Database(dbPath, { create: true });
		runMigrations(schemaDb);
		seedPayload(schemaDb, "p-old", now - 10_000, 100);
		schemaDb.close();

		const db = open();
		try {
			const { handle } = wrapWithConcurrentUpsert(db, "p-old", now);
			const removed = await deleteBatched(
				handle,
				"request_payloads",
				PREDICATE,
				now - 5000,
				{ atomic: true },
			);
			expect(removed).toBe(0);

			// The FRESH payload is intact — the delete re-applied the predicate.
			const stored = db
				.query(
					"SELECT json, timestamp FROM request_payloads WHERE id = 'p-old'",
				)
				.get() as { json: string; timestamp: number } | null;
			expect(stored?.json).toBe('{"fresh":true}');
			expect(stored?.timestamp).toBe(now);
		} finally {
			db.close();
		}
	});

	it("the id-only path (used for cascading tables) DOES lose that row — why payloads use atomic", async () => {
		// Discriminating counterpart: without the atomic mode the same interleave
		// deletes the freshly-written payload. `requests` keeps this path because
		// its FK cascade makes `.changes` unusable as a per-table count.
		const now = Date.now();
		const schemaDb = new Database(dbPath, { create: true });
		runMigrations(schemaDb);
		seedPayload(schemaDb, "p-old", now - 10_000, 100);
		schemaDb.close();

		const db = open();
		try {
			const { handle } = wrapWithConcurrentUpsert(db, "p-old", now);
			const removed = await deleteBatched(
				handle,
				"request_payloads",
				PREDICATE,
				now - 5000,
			);
			expect(removed).toBe(1);
			expect(
				db.query("SELECT id FROM request_payloads WHERE id = 'p-old'").get(),
			).toBeNull();
		} finally {
			db.close();
		}
	});
});
