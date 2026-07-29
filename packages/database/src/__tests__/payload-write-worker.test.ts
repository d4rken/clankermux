/**
 * Unit tests for the payload-write worker's batching engine.
 *
 * The engine is transport-free (it takes a SQLite handle and a `post`
 * callback), so these run on the main thread against a temp-file database —
 * never the live DB. The real Worker wiring is covered by the cross-thread
 * integration test.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../migrations";
import {
	classifyCommitError,
	classifyRowError,
	createPayloadWriteEngine,
	openPayloadWriteDatabase,
	type PayloadWriteDb,
	type PayloadWriteResponse,
	type PayloadWriteRowMessage,
} from "../payload-write-worker";

let dir: string;
let dbPath: string;
let db: Database;

function row(
	overrides: Partial<PayloadWriteRowMessage> = {},
): PayloadWriteRowMessage {
	return {
		type: "write",
		generation: 1,
		seq: 1,
		id: "req-1",
		ciphertext: '{"hello":"world"}',
		timestamp: Date.now(),
		...overrides,
	};
}

function seedRequest(id: string): void {
	db.run(
		`INSERT INTO requests (id, timestamp, method, path, status_code, success, failover_attempts)
		 VALUES (?, ?, 'POST', '/v1/messages', 200, 1, 0)`,
		[id, Date.now()],
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "payload-write-worker-"));
	dbPath = join(dir, "test.db");
	const schemaDb = new Database(dbPath, { create: true });
	runMigrations(schemaDb);
	schemaDb.close();
	db = openPayloadWriteDatabase(dbPath, 1000);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// already closed by a test
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("openPayloadWriteDatabase", () => {
	test("sets every connection pragma explicitly (never inherits defaults)", () => {
		const read = (pragma: string): number =>
			Object.values(
				db.query(`PRAGMA ${pragma}`).get() as Record<string, number>,
			)[0];

		expect(
			(db.query("PRAGMA journal_mode").get() as { journal_mode: string })
				.journal_mode,
		).toBe("wal");
		expect(read("foreign_keys")).toBe(1);
		expect(read("busy_timeout")).toBe(1000);
		expect(read("synchronous")).toBe(2); // FULL
		expect(read("mmap_size")).toBe(0);
		expect(read("cache_size")).toBe(-65536);
		expect(read("temp_store")).toBe(2); // MEMORY
		// Checkpointing stays owned by the existing checkpoint worker.
		expect(read("wal_autocheckpoint")).toBe(0);
	});
});

describe("payload write engine — batching and acks", () => {
	test("commits a batch and acks every row only after COMMIT", () => {
		seedRequest("a");
		seedRequest("b");
		const posted: PayloadWriteResponse[] = [];
		const engine = createPayloadWriteEngine({
			db,
			generation: 7,
			post: (m) => posted.push(m),
			maxBatchRows: 2,
		});

		engine.accept(row({ seq: 1, id: "a" }));
		// Below the row budget → nothing flushed yet (no timer fired).
		expect(posted).toHaveLength(0);
		engine.accept(row({ seq: 2, id: "b" }));

		expect(posted).toHaveLength(1);
		const ack = posted[0];
		expect(ack.type).toBe("ack");
		if (ack.type !== "ack") throw new Error("expected ack");
		expect(ack.generation).toBe(7);
		expect(ack.results.map((r) => r.status)).toEqual([
			"committed",
			"committed",
		]);

		const stored = db
			.query("SELECT id, json FROM request_payloads ORDER BY id")
			.all() as Array<{ id: string; json: string }>;
		expect(stored.map((s) => s.id)).toEqual(["a", "b"]);
	});

	test("flush() drains a partially filled batch", () => {
		seedRequest("a");
		const posted: PayloadWriteResponse[] = [];
		const engine = createPayloadWriteEngine({
			db,
			generation: 1,
			post: (m) => posted.push(m),
			maxBatchRows: 50,
		});
		engine.accept(row({ id: "a" }));
		expect(posted).toHaveLength(0);
		engine.flush();
		expect(posted).toHaveLength(1);
	});

	test("a row larger than the byte budget still forms a one-row batch", () => {
		seedRequest("big");
		const posted: PayloadWriteResponse[] = [];
		const engine = createPayloadWriteEngine({
			db,
			generation: 1,
			post: (m) => posted.push(m),
			maxBatchBytes: 16,
			maxBatchRows: 10,
		});
		engine.accept(row({ id: "big", ciphertext: "x".repeat(1024) }));
		const ack = posted[0];
		if (ack?.type !== "ack") throw new Error("expected ack");
		expect(ack.results).toHaveLength(1);
		expect(ack.results[0].status).toBe("committed");
	});

	test("the batch byte budget counts UTF-8 bytes, not UTF-16 code units", () => {
		seedRequest("multibyte");
		const posted: PayloadWriteResponse[] = [];
		const engine = createPayloadWriteEngine({
			db,
			generation: 1,
			post: (m) => posted.push(m),
			maxBatchBytes: 16,
			maxBatchRows: 100,
		});

		// 8 "€" = 8 UTF-16 code units but 24 UTF-8 bytes, i.e. over the 16-byte
		// budget. Counting code units left it at 8 and never tripped the flush.
		engine.accept(row({ id: "multibyte", ciphertext: "€".repeat(8) }));
		expect(posted).toHaveLength(1);
	});

	test("takeBatch splits on real byte size", () => {
		seedRequest("a");
		seedRequest("b");
		const posted: PayloadWriteResponse[] = [];
		const engine = createPayloadWriteEngine({
			db,
			generation: 1,
			post: (m) => posted.push(m),
			maxBatchBytes: 16,
			maxBatchRows: 100,
		});

		// 12 bytes each: two rows exceed the 16-byte budget, so they must land in
		// two separate transactions rather than one 24-byte batch.
		engine.accept(row({ seq: 1, id: "a", ciphertext: "€".repeat(4) }));
		engine.accept(row({ seq: 2, id: "b", ciphertext: "€".repeat(4) }));
		engine.flush();

		expect(posted).toHaveLength(2);
		for (const message of posted) {
			if (message.type !== "ack") throw new Error("expected ack");
			expect(message.results).toHaveLength(1);
			expect(message.results[0].status).toBe("committed");
		}
	});

	test("replaying the same id is an idempotent upsert", () => {
		seedRequest("a");
		const posted: PayloadWriteResponse[] = [];
		const engine = createPayloadWriteEngine({
			db,
			generation: 1,
			post: (m) => posted.push(m),
			maxBatchRows: 1,
		});
		engine.accept(row({ id: "a", ciphertext: "first", timestamp: 1000 }));
		engine.accept(
			row({ seq: 2, id: "a", ciphertext: "second", timestamp: 2000 }),
		);

		const stored = db
			.query("SELECT id, json, timestamp FROM request_payloads")
			.all() as Array<{ id: string; json: string; timestamp: number }>;
		expect(stored).toHaveLength(1);
		expect(stored[0].json).toBe("second");
		expect(stored[0].timestamp).toBe(2000);
	});

	test("close() flushes pending rows, posts closed and closes the handle", () => {
		seedRequest("a");
		const posted: PayloadWriteResponse[] = [];
		const engine = createPayloadWriteEngine({
			db,
			generation: 3,
			post: (m) => posted.push(m),
			maxBatchRows: 100,
		});
		engine.accept(row({ id: "a" }));
		engine.close();

		expect(posted.map((m) => m.type)).toEqual(["ack", "closed"]);
		const verify = new Database(dbPath);
		expect(
			(
				verify.query("SELECT COUNT(*) AS n FROM request_payloads").get() as {
					n: number;
				}
			).n,
		).toBe(1);
		verify.close();
	});
});

describe("payload write engine — error classes", () => {
	test("a missing FK parent is entry-permanent and the valid subset commits", () => {
		seedRequest("good");
		const posted: PayloadWriteResponse[] = [];
		const engine = createPayloadWriteEngine({
			db,
			generation: 1,
			post: (m) => posted.push(m),
			maxBatchRows: 2,
		});

		engine.accept(row({ seq: 1, id: "orphan" })); // no requests row
		engine.accept(row({ seq: 2, id: "good" }));

		const ack = posted[0];
		if (ack?.type !== "ack") throw new Error("expected ack");
		const orphan = ack.results.find((r) => r.seq === 1);
		const good = ack.results.find((r) => r.seq === 2);
		expect(orphan?.status).toBe("failed");
		expect(orphan?.errorClass).toBe("entry-permanent");
		expect(good?.status).toBe("committed");

		const stored = db.query("SELECT id FROM request_payloads").all() as Array<{
			id: string;
		}>;
		expect(stored.map((s) => s.id)).toEqual(["good"]);
	});

	test("a COMMIT failure NACKs the entire batch — no partial acks", () => {
		seedRequest("a");
		seedRequest("b");
		const posted: PayloadWriteResponse[] = [];
		// Wrap the real handle so COMMIT fails after both inserts succeeded.
		const failingCommit: PayloadWriteDb = {
			exec(sql: string) {
				if (sql === "COMMIT") {
					const err = new Error("disk I/O error") as Error & {
						errno: number;
						code: string;
					};
					err.errno = 13; // SQLITE_FULL
					err.code = "SQLITE_FULL";
					throw err;
				}
				db.exec(sql);
			},
			prepare: (sql: string) => db.prepare(sql),
			close: () => db.close(),
		};
		const engine = createPayloadWriteEngine({
			db: failingCommit,
			generation: 1,
			post: (m) => posted.push(m),
			maxBatchRows: 3,
		});

		engine.accept(row({ seq: 1, id: "a" }));
		engine.accept(row({ seq: 2, id: "orphan" })); // entry-permanent pre-commit
		engine.accept(row({ seq: 3, id: "b" }));
		engine.flush();

		const ack = posted[0];
		if (ack?.type !== "ack") throw new Error("expected ack");
		expect(ack.results).toHaveLength(3);
		// EVERY row is NACKed with the commit's class — including the row whose
		// pre-commit savepoint failed. Nothing may be acked or dropped based on
		// pre-commit insert results.
		expect(ack.results.every((r) => r.status === "failed")).toBe(true);
		expect(ack.results.every((r) => r.errorClass === "writer-fatal")).toBe(
			true,
		);

		const stored = db.query("SELECT id FROM request_payloads").all();
		expect(stored).toHaveLength(0);
	});

	test("a writer-fatal row aborts the batch and NACKs every row", () => {
		const posted: PayloadWriteResponse[] = [];
		const fatal = new Error("database or disk is full") as Error & {
			errno: number;
			code: string;
		};
		fatal.errno = 13;
		fatal.code = "SQLITE_FULL";
		let inserts = 0;
		const failingInsert: PayloadWriteDb = {
			exec: (sql: string) => {
				if (sql === "COMMIT" || sql === "BEGIN IMMEDIATE") return;
			},
			prepare: () => ({
				run: () => {
					inserts++;
					if (inserts === 2) throw fatal;
					return undefined;
				},
			}),
			close: () => {},
		};
		const engine = createPayloadWriteEngine({
			db: failingInsert,
			generation: 1,
			post: (m) => posted.push(m),
			maxBatchRows: 3,
		});
		engine.accept(row({ seq: 1, id: "a" }));
		engine.accept(row({ seq: 2, id: "b" }));
		engine.accept(row({ seq: 3, id: "c" }));

		const ack = posted[0];
		if (ack?.type !== "ack") throw new Error("expected ack");
		expect(ack.results).toHaveLength(3);
		expect(ack.results.every((r) => r.errorClass === "writer-fatal")).toBe(
			true,
		);

		// Once fatal, the connection is not touched again: later rows are NACKed
		// straight away rather than re-attempted.
		engine.accept(row({ seq: 4, id: "d" }));
		engine.flush();
		const second = posted[1];
		if (second?.type !== "ack") throw new Error("expected ack");
		expect(second.results[0].errorClass).toBe("writer-fatal");
	});
});

describe("error classification", () => {
	function sqliteError(code: string, errno: number): Error {
		const err = new Error(code) as Error & { code: string; errno: number };
		err.code = code;
		err.errno = errno;
		return err;
	}

	test("BUSY/LOCKED are retryable", () => {
		expect(classifyRowError(sqliteError("SQLITE_BUSY", 5))).toBe("retryable");
		expect(classifyRowError(sqliteError("SQLITE_LOCKED", 6))).toBe("retryable");
		expect(classifyRowError(sqliteError("SQLITE_BUSY_SNAPSHOT", 517))).toBe(
			"retryable",
		);
	});

	test("constraint violations are entry-permanent", () => {
		expect(
			classifyRowError(sqliteError("SQLITE_CONSTRAINT_FOREIGNKEY", 787)),
		).toBe("entry-permanent");
		expect(
			classifyRowError(sqliteError("SQLITE_CONSTRAINT_NOTNULL", 1299)),
		).toBe("entry-permanent");
		expect(classifyRowError(new TypeError("malformed binding"))).toBe(
			"entry-permanent",
		);
	});

	test("database-wide failures are writer-fatal", () => {
		for (const [code, errno] of [
			["SQLITE_FULL", 13],
			["SQLITE_CORRUPT", 11],
			["SQLITE_NOTADB", 26],
			["SQLITE_READONLY", 8],
			["SQLITE_CANTOPEN", 14],
			["SQLITE_IOERR", 10],
		] as Array<[string, number]>) {
			expect(classifyRowError(sqliteError(code, errno))).toBe("writer-fatal");
		}
		// …with an explicit transient-I/O exception list.
		expect(classifyRowError(sqliteError("SQLITE_IOERR_LOCK", 3850))).toBe(
			"retryable",
		);
	});

	test("an unclassified COMMIT failure is writer-fatal, not a drop", () => {
		expect(classifyCommitError(new Error("something odd"))).toBe(
			"writer-fatal",
		);
		expect(classifyCommitError(sqliteError("SQLITE_BUSY", 5))).toBe(
			"retryable",
		);
	});
});
