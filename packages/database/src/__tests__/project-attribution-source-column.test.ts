/**
 * Tests for requests.project_attribution_source — which tier produced a row's
 * `project` value (see ProjectAttributionSource).
 *
 * Covers BOTH halves of the mandatory two-step migration rule:
 *   1. ensureSchema() includes the column for fresh installs.
 *   2. runMigrations()'s ADDITIVE_COLUMNS adds it to a pre-existing live DB.
 *
 * Plus the persistence rules:
 *   - the value round-trips through DatabaseOperations.saveRequest,
 *   - an explicit null leaves the column NULL (ineligible rows); the field is
 *     REQUIRED, so omitting it is a compile error rather than a silent NULL,
 *   - a follow-up partial re-save does NOT null an already-recorded value
 *     (the UPSERT's COALESCE).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tempDbTracker } from "@clankermux/test-support";
import { DatabaseOperations } from "../database-operations";
import { ensureSchema, runMigrations } from "../migrations";

const tmpDb = tempDbTracker("test-proj-source");

const COLUMN = "project_attribution_source";

function columnNames(db: Database, table: string): Set<string> {
	return new Set(
		(
			db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
				name: string;
			}>
		).map((c) => c.name),
	);
}

describe("requests.project_attribution_source migration", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("ensureSchema() creates the column on a fresh DB", () => {
		ensureSchema(db);
		expect(columnNames(db, "requests").has(COLUMN)).toBe(true);
	});

	it("runMigrations() adds the column to an existing DB that lacks it", () => {
		ensureSchema(db);
		db.run(`ALTER TABLE requests DROP COLUMN ${COLUMN}`);
		expect(columnNames(db, "requests").has(COLUMN)).toBe(false);

		runMigrations(db);
		expect(columnNames(db, "requests").has(COLUMN)).toBe(true);
	});

	it("runMigrations() is idempotent when the column already exists", () => {
		ensureSchema(db);
		runMigrations(db);
		expect(() => runMigrations(db)).not.toThrow();
		expect(columnNames(db, "requests").has(COLUMN)).toBe(true);
	});
});

describe("project_attribution_source persistence through saveRequest", () => {
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

	async function readSource(id: string): Promise<string | null | undefined> {
		const row = await dbOps
			.getAdapter()
			.get<{ project_attribution_source: string | null }>(
				`SELECT ${COLUMN} FROM requests WHERE id = ?`,
				[id],
			);
		return row?.project_attribution_source;
	}

	it("round-trips the source alongside the project", async () => {
		await dbOps.saveRequest({
			id: "src-1",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 100,
			failoverAttempts: 0,
			project: "clankermux",
			projectAttributionSource: "session_inherited",
		});

		expect(await readSource("src-1")).toBe("session_inherited");
	});

	it("records a source even when the project is null (ambiguous session)", async () => {
		await dbOps.saveRequest({
			id: "src-ambiguous",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 100,
			failoverAttempts: 0,
			project: null,
			projectAttributionSource: "session_ambiguous",
		});

		expect(await readSource("src-ambiguous")).toBe("session_ambiguous");
	});

	it("leaves the column NULL when the caller states an explicit null", async () => {
		await dbOps.saveRequest({
			id: "src-none",
			method: "POST",
			path: "/v1/responses",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 100,
			failoverAttempts: 0,
			projectAttributionSource: null,
		});

		expect(await readSource("src-none")).toBeNull();
	});

	it("preserves the source across a metadata-only re-save (UPSERT COALESCE)", async () => {
		await dbOps.saveRequest({
			id: "src-resave",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 100,
			failoverAttempts: 0,
			project: "clankermux",
			projectAttributionSource: "wd_primary",
		});

		// Re-save the same id with an explicit null source — must not null the
		// column (the UPSERT COALESCEs against the stored value).
		await dbOps.saveRequest({
			id: "src-resave",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 110,
			failoverAttempts: 0,
			projectAttributionSource: null,
		});

		expect(await readSource("src-resave")).toBe("wd_primary");
	});
});
