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

describe("RequestRepository.saveRouting", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("persists routing telemetry keyed by request_id", async () => {
		insertRequest(db, "req-routing");

		await repo.saveRouting({
			requestId: "req-routing",
			strategy: "session",
			decision: "affinity_hit",
			affinityScope: "claude_session",
			affinityKeyHash: "hash-1",
			selectedAccountId: "account-a",
			previousAccountId: "account-a",
			candidatesCount: 3,
			failoverAttempts: 0,
			failoverReason: null,
			createdAt: 1_700_000_000_000,
		});

		const row = db
			.query<
				{
					request_id: string;
					strategy: string;
					decision: string;
					affinity_scope: string | null;
					affinity_key_hash: string | null;
					selected_account_id: string | null;
					previous_account_id: string | null;
					candidates_count: number | null;
					failover_attempts: number;
					failover_reason: string | null;
					created_at: number;
				},
				[]
			>("SELECT * FROM request_routing WHERE request_id = 'req-routing'")
			.get();

		expect(row).toEqual({
			request_id: "req-routing",
			strategy: "session",
			decision: "affinity_hit",
			affinity_scope: "claude_session",
			affinity_key_hash: "hash-1",
			selected_account_id: "account-a",
			previous_account_id: "account-a",
			candidates_count: 3,
			failover_attempts: 0,
			failover_reason: null,
			created_at: 1_700_000_000_000,
		});
	});

	it("cascades when the parent request is deleted", async () => {
		insertRequest(db, "req-delete");
		await repo.saveRouting({
			requestId: "req-delete",
			strategy: "session",
			decision: "affinity_miss",
			createdAt: Date.now(),
		});

		db.run("DELETE FROM requests WHERE id = 'req-delete'");

		const remaining = db
			.query<{ n: number }, []>(
				"SELECT COUNT(*) AS n FROM request_routing WHERE request_id = 'req-delete'",
			)
			.get();
		expect(remaining?.n).toBe(0);
	});
});
