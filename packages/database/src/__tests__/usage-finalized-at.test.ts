/**
 * Tests for `requests.usage_finalized_at` — the moment a persistable token
 * vector became known, as opposed to `requests.timestamp`, which is stamped when
 * the async writer actually ran.
 *
 * The load-bearing property is that the stamp only ever moves BACKWARD in
 * information terms: once written it is never overwritten, by a re-upsert or by
 * a late usage patch. A stamp that drifted to the patch time would be a slower
 * clock than the one it exists to replace.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import {
	type RequestData,
	RequestRepository,
} from "../repositories/request.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	return db;
}

function requestData(overrides: Partial<RequestData> = {}): RequestData {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acct-a",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTime: 1_200,
		failoverAttempts: 0,
		projectAttributionSource: null,
		...overrides,
	};
}

function readStamp(db: Database, id = "req-1"): number | null {
	const row = db
		.query(`SELECT usage_finalized_at FROM requests WHERE id = ?`)
		.get(id) as { usage_finalized_at: number | null } | null;
	return row?.usage_finalized_at ?? null;
}

describe("requests.usage_finalized_at", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("round-trips the stamp on insert", async () => {
		await repo.save(requestData({ usageFinalizedAt: 1_700_000_000_000 }));
		expect(readStamp(db)).toBe(1_700_000_000_000);
	});

	it("stores NULL when no usable usage ever arrived", async () => {
		await repo.save(requestData());
		expect(readStamp(db)).toBeNull();
	});

	it("keeps the earliest stamp across a re-upsert", async () => {
		await repo.save(requestData({ usageFinalizedAt: 1_000 }));
		await repo.save(requestData({ usageFinalizedAt: 9_999 }));
		expect(readStamp(db)).toBe(1_000);
	});

	it("lets a re-upsert fill in a stamp the first write did not have", async () => {
		await repo.save(requestData());
		await repo.save(requestData({ usageFinalizedAt: 2_000 }));
		expect(readStamp(db)).toBe(2_000);
	});

	it("fills the stamp in on the late usage patch", async () => {
		await repo.save(requestData());
		await repo.updateUsage(
			"req-1",
			{ model: "claude-sonnet-4-5", outputTokens: 7 },
			3_000,
		);
		expect(readStamp(db)).toBe(3_000);
	});

	it("does NOT let the late usage patch move an existing stamp", async () => {
		await repo.save(requestData({ usageFinalizedAt: 1_000 }));
		await repo.updateUsage(
			"req-1",
			{ model: "claude-sonnet-4-5", outputTokens: 7 },
			9_999,
		);
		expect(readStamp(db)).toBe(1_000);
	});

	it("leaves the stamp alone when the patch carries none", async () => {
		await repo.save(requestData({ usageFinalizedAt: 1_000 }));
		await repo.updateUsage("req-1", { model: "claude-sonnet-4-5" });
		expect(readStamp(db)).toBe(1_000);
	});
});
