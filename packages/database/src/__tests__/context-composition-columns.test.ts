/**
 * Tests for the 8 requests.context_* columns (ingest-time context composition:
 * per-bucket character counts computed from the parsed /v1/messages body).
 *
 * Covers BOTH halves of the mandatory two-step migration rule:
 *   1. ensureSchema() includes the columns for fresh installs.
 *   2. runMigrations()'s ADDITIVE_COLUMNS adds them to a pre-existing live DB.
 *
 * Plus the persistence rules:
 *   - the 8 columns round-trip through DatabaseOperations.saveRequest,
 *     including ZERO values staying 0 (not NULL) — `?? null` binding,
 *   - a metadata-only re-save (no composition) preserves them via the
 *     UPSERT's COALESCE,
 *   - updateRequestUsage (plain usage UPDATE) does not touch them.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "../database-operations";
import { ensureSchema, runMigrations } from "../migrations";

const CONTEXT_COLUMNS = [
	"context_system_chars",
	"context_tools_chars",
	"context_tool_count",
	"context_messages_chars",
	"context_message_count",
	"context_tool_result_chars",
	"context_largest_tool_chars",
	"context_largest_tool_name",
] as const;

interface ContextRow {
	context_system_chars: number | null;
	context_tools_chars: number | null;
	context_tool_count: number | null;
	context_messages_chars: number | null;
	context_message_count: number | null;
	context_tool_result_chars: number | null;
	context_largest_tool_chars: number | null;
	context_largest_tool_name: string | null;
}

function columnNames(db: Database, table: string): Set<string> {
	return new Set(
		(
			db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
				name: string;
			}>
		).map((c) => c.name),
	);
}

describe("requests.context_* migration", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("ensureSchema() creates all 8 columns on a fresh DB", () => {
		ensureSchema(db);
		const cols = columnNames(db, "requests");
		for (const col of CONTEXT_COLUMNS) {
			expect(cols.has(col)).toBe(true);
		}
	});

	it("runMigrations() adds the columns to an existing DB that lacks them", () => {
		// Simulate a live DB created before these columns existed: full current
		// schema, then drop just these columns (they are not part of any index).
		ensureSchema(db);
		for (const col of CONTEXT_COLUMNS) {
			db.run(`ALTER TABLE requests DROP COLUMN ${col}`);
		}
		const before = columnNames(db, "requests");
		for (const col of CONTEXT_COLUMNS) {
			expect(before.has(col)).toBe(false);
		}

		runMigrations(db);
		const after = columnNames(db, "requests");
		for (const col of CONTEXT_COLUMNS) {
			expect(after.has(col)).toBe(true);
		}
	});

	it("runMigrations() is idempotent when the columns already exist", () => {
		ensureSchema(db);
		runMigrations(db);
		expect(() => runMigrations(db)).not.toThrow();
		const cols = columnNames(db, "requests");
		for (const col of CONTEXT_COLUMNS) {
			expect(cols.has(col)).toBe(true);
		}
	});
});

describe("context composition persistence through saveRequest", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(
			join(tmpdir(), `test-context-comp-${randomBytes(6).toString("hex")}.db`),
		);
	});

	afterEach(() => {
		dbOps.dispose?.();
	});

	async function readRow(id: string): Promise<ContextRow | null> {
		return dbOps
			.getAdapter()
			.get<ContextRow>(
				`SELECT ${CONTEXT_COLUMNS.join(", ")} FROM requests WHERE id = ?`,
				[id],
			);
	}

	it("round-trips all 8 columns including zero values staying 0 (not NULL)", async () => {
		await dbOps.saveRequest(
			"req-comp-1",
			"POST",
			"/v1/messages",
			null,
			200,
			true,
			null,
			120,
			0,
			undefined,
			undefined,
			undefined,
			"my-project",
			"plan",
			null,
			null,
			{
				systemChars: 1234,
				// Zero buckets are valid recorded values (e.g. no tools defined)
				// and must stay 0 — distinct from NULL = "not recorded".
				toolsChars: 0,
				toolCount: 0,
				messagesChars: 5678,
				messageCount: 12,
				toolResultChars: 900,
				largestToolResultChars: 450,
				largestToolName: "read_file",
			},
		);

		const row = await readRow("req-comp-1");
		expect(row).toEqual({
			context_system_chars: 1234,
			context_tools_chars: 0,
			context_tool_count: 0,
			context_messages_chars: 5678,
			context_message_count: 12,
			context_tool_result_chars: 900,
			context_largest_tool_chars: 450,
			context_largest_tool_name: "read_file",
		});
	});

	it("leaves all 8 columns NULL when no composition is provided (legacy callers)", async () => {
		await dbOps.saveRequest(
			"req-comp-null",
			"POST",
			"/v1/messages",
			null,
			200,
			true,
			null,
			80,
			0,
		);

		const row = await readRow("req-comp-null");
		expect(row).toEqual({
			context_system_chars: null,
			context_tools_chars: null,
			context_tool_count: null,
			context_messages_chars: null,
			context_message_count: null,
			context_tool_result_chars: null,
			context_largest_tool_chars: null,
			context_largest_tool_name: null,
		});
	});

	it("preserves the columns across a metadata-only re-save (UPSERT COALESCE)", async () => {
		await dbOps.saveRequest(
			"req-comp-resave",
			"POST",
			"/v1/messages",
			null,
			200,
			true,
			null,
			100,
			0,
			undefined,
			undefined,
			undefined,
			null,
			undefined,
			null,
			null,
			{
				systemChars: 10,
				toolsChars: 20,
				toolCount: 2,
				messagesChars: 30,
				messageCount: 3,
				toolResultChars: 0,
				largestToolResultChars: 0,
				largestToolName: null,
			},
		);

		// Re-save the same id WITHOUT composition — must not null the columns.
		await dbOps.saveRequest(
			"req-comp-resave",
			"POST",
			"/v1/messages",
			null,
			200,
			true,
			null,
			110,
			0,
		);

		const row = await readRow("req-comp-resave");
		expect(row).toEqual({
			context_system_chars: 10,
			context_tools_chars: 20,
			context_tool_count: 2,
			context_messages_chars: 30,
			context_message_count: 3,
			context_tool_result_chars: 0,
			context_largest_tool_chars: 0,
			context_largest_tool_name: null,
		});
	});

	it("survives updateRequestUsage (plain usage UPDATE must not touch them)", async () => {
		await dbOps.saveRequest(
			"req-comp-usage",
			"POST",
			"/v1/messages",
			null,
			200,
			true,
			null,
			100,
			0,
			undefined,
			undefined,
			undefined,
			null,
			undefined,
			null,
			null,
			{
				systemChars: 111,
				toolsChars: 222,
				toolCount: 4,
				messagesChars: 333,
				messageCount: 5,
				toolResultChars: 44,
				largestToolResultChars: 22,
				largestToolName: "bash",
			},
		);

		await dbOps.updateRequestUsage("req-comp-usage", {
			model: "claude-opus-4-8",
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
			inputTokens: 100,
			outputTokens: 50,
		});

		const row = await readRow("req-comp-usage");
		expect(row).toEqual({
			context_system_chars: 111,
			context_tools_chars: 222,
			context_tool_count: 4,
			context_messages_chars: 333,
			context_message_count: 5,
			context_tool_result_chars: 44,
			context_largest_tool_chars: 22,
			context_largest_tool_name: "bash",
		});
	});
});
