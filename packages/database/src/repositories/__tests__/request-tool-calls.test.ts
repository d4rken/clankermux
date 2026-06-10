import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { RequestRepository } from "../request.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA foreign_keys = ON");
	ensureSchema(db);
	return db;
}

function insertRequest(db: Database, id: string): void {
	db.run(
		`INSERT INTO requests
			(id, timestamp, method, path, account_used, status_code, success,
			 error_message, response_time_ms, failover_attempts)
		 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
		[id, Date.now()],
	);
}

interface ToolCallRow {
	request_id: string;
	tool_name: string;
	call_count: number;
	error_count: number;
}

interface ToolErrorRow {
	request_id: string;
	tool_name: string;
	error_text: string | null;
}

function toolCallRows(db: Database, requestId: string): ToolCallRow[] {
	return db
		.query<ToolCallRow, [string]>(
			"SELECT request_id, tool_name, call_count, error_count FROM request_tool_calls WHERE request_id = ? ORDER BY tool_name",
		)
		.all(requestId);
}

function toolErrorRows(db: Database, requestId: string): ToolErrorRow[] {
	return db
		.query<ToolErrorRow, [string]>(
			"SELECT request_id, tool_name, error_text FROM request_tool_errors WHERE request_id = ? ORDER BY id",
		)
		.all(requestId);
}

describe("RequestRepository.saveToolCalls", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("persists per-tool call/error counts keyed by (request_id, tool_name)", async () => {
		insertRequest(db, "req-tools");

		await repo.saveToolCalls("req-tools", [
			{ toolName: "Bash", callCount: 3, errorCount: 1, errorSamples: ["boom"] },
			{ toolName: "Read", callCount: 2, errorCount: 0, errorSamples: [] },
		]);

		expect(toolCallRows(db, "req-tools")).toEqual([
			{
				request_id: "req-tools",
				tool_name: "Bash",
				call_count: 3,
				error_count: 1,
			},
			{
				request_id: "req-tools",
				tool_name: "Read",
				call_count: 2,
				error_count: 0,
			},
		]);
	});

	it("persists one error-sample row per sample with the tool name", async () => {
		insertRequest(db, "req-errs");

		await repo.saveToolCalls("req-errs", [
			{
				toolName: "Bash",
				callCount: 4,
				errorCount: 3,
				errorSamples: ["command not found", "permission denied"],
			},
			{ toolName: "Edit", callCount: 1, errorCount: 1, errorSamples: ["oops"] },
		]);

		expect(toolErrorRows(db, "req-errs")).toEqual([
			{
				request_id: "req-errs",
				tool_name: "Bash",
				error_text: "command not found",
			},
			{
				request_id: "req-errs",
				tool_name: "Bash",
				error_text: "permission denied",
			},
			{ request_id: "req-errs", tool_name: "Edit", error_text: "oops" },
		]);
	});

	it("is idempotent across retries: re-saving upserts counts and does not duplicate error rows", async () => {
		insertRequest(db, "req-retry");

		const stats = [
			{
				toolName: "Bash",
				callCount: 2,
				errorCount: 1,
				errorSamples: ["first failure"],
			},
		];
		await repo.saveToolCalls("req-retry", stats);
		// Simulate a withDatabaseRetry re-run with updated counts.
		await repo.saveToolCalls("req-retry", [
			{
				toolName: "Bash",
				callCount: 5,
				errorCount: 2,
				errorSamples: ["first failure", "second failure"],
			},
		]);

		expect(toolCallRows(db, "req-retry")).toEqual([
			{
				request_id: "req-retry",
				tool_name: "Bash",
				call_count: 5,
				error_count: 2,
			},
		]);
		expect(toolErrorRows(db, "req-retry")).toEqual([
			{
				request_id: "req-retry",
				tool_name: "Bash",
				error_text: "first failure",
			},
			{
				request_id: "req-retry",
				tool_name: "Bash",
				error_text: "second failure",
			},
		]);
	});

	it("is a no-op for an empty stats array", async () => {
		insertRequest(db, "req-empty");
		await repo.saveToolCalls("req-empty", []);
		expect(toolCallRows(db, "req-empty")).toEqual([]);
		expect(toolErrorRows(db, "req-empty")).toEqual([]);
	});

	it("cascades both tables when the parent request is deleted", async () => {
		insertRequest(db, "req-delete");
		await repo.saveToolCalls("req-delete", [
			{ toolName: "Bash", callCount: 1, errorCount: 1, errorSamples: ["x"] },
		]);

		db.run("DELETE FROM requests WHERE id = 'req-delete'");

		expect(toolCallRows(db, "req-delete")).toEqual([]);
		expect(toolErrorRows(db, "req-delete")).toEqual([]);
	});
});
