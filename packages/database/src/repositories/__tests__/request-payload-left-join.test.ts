/**
 * Tests for RequestRepository.listPayloadsWithAccountNames after the
 * INNER JOIN → LEFT JOIN fix.
 *
 * Before the fix, any request that lacked a row in request_payloads was
 * silently excluded.  After the fix, all requests appear; those without a
 * payload have json=null in the result.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { buildPayloadFrame } from "../../payload-frame";
import { RequestRepository } from "../request.repository";

// ---------------------------------------------------------------------------
// Schema setup
// ---------------------------------------------------------------------------

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	return db;
}

// ---------------------------------------------------------------------------
// Insert helpers
// ---------------------------------------------------------------------------

function insertRequest(db: Database, id: string, timestamp: number): void {
	db.run(
		`INSERT INTO requests
			(id, timestamp, method, path, account_used, status_code, success,
			 error_message, response_time_ms, failover_attempts)
		 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
		[id, timestamp],
	);
}

function insertRequestWithPayload(
	db: Database,
	id: string,
	timestamp: number,
	json: string,
): void {
	insertRequest(db, id, timestamp);
	db.run(
		`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)`,
		[id, json, timestamp],
	);
}

function insertRequestWithBlob(
	db: Database,
	id: string,
	timestamp: number,
	payload: Uint8Array,
): void {
	insertRequest(db, id, timestamp);
	db.run(
		`INSERT INTO request_payloads (id, json, payload, timestamp) VALUES (?, '', ?, ?)`,
		[id, payload, timestamp],
	);
}

function insertAccount(db: Database, id: string, name: string): void {
	db.run(
		`INSERT INTO accounts
			(id, name, provider, created_at, priority)
		 VALUES (?, ?, 'anthropic-compatible', ?, 0)`,
		[id, name, Date.now()],
	);
}

function linkAccountToRequest(
	db: Database,
	requestId: string,
	accountId: string,
): void {
	db.run(`UPDATE requests SET account_used = ? WHERE id = ?`, [
		accountId,
		requestId,
	]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RequestRepository.listPayloadsWithAccountNames", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("returns requests that have no payload (json=null)", async () => {
		const now = Date.now();
		insertRequest(db, "req-no-payload", now);

		const results = await repo.listPayloadsWithAccountNames(10);

		expect(results).toHaveLength(1);
		expect(results[0].id).toBe("req-no-payload");
		expect(results[0].json).toBeNull();
	});

	it("returns requests that have a payload (json is present/non-null)", async () => {
		const now = Date.now();
		const payloadData = JSON.stringify({ model: "claude-3", messages: [] });
		insertRequestWithPayload(db, "req-with-payload", now, payloadData);

		const results = await repo.listPayloadsWithAccountNames(10);

		expect(results).toHaveLength(1);
		expect(results[0].id).toBe("req-with-payload");
		// json may be returned as-is or re-serialized after decrypt; it must be non-null
		expect(results[0].json).not.toBeNull();
	});

	it("reads the production writer's binary form in single and both list readers", async () => {
		const skeleton = JSON.stringify({
			request: { headers: {}, body: null },
			response: { status: 200, headers: {}, body: null },
		});
		const requestBody = new TextEncoder().encode(
			"repeated message ".repeat(10_000),
		);
		const frame = buildPayloadFrame(skeleton, requestBody, []);
		const stored = await repo.encodePayloadForStorage(frame);
		expect(stored.byteLength).toBeLessThan(frame.byteLength);
		insertRequestWithBlob(db, "encoded", Date.now(), stored);

		const envelope = {
			request: {
				headers: {},
				body: Buffer.from(requestBody).toString("base64"),
			},
			response: { status: 200, headers: {}, body: null },
		};
		expect(await repo.getPayload("encoded")).toEqual(envelope);
		expect((await repo.listPayloads())[0].json).toBe(JSON.stringify(envelope));
		expect((await repo.listPayloadsWithAccountNames())[0].json).toBe(
			JSON.stringify(envelope),
		);
	});

	it("throws on a corrupt blob in strict reads but isolates list failures", async () => {
		insertRequestWithBlob(db, "corrupt", Date.now(), Uint8Array.of(0, 1, 2));
		await expect(repo.getPayload("corrupt")).rejects.toThrow();
		for (const rows of [
			await repo.listPayloads(),
			await repo.listPayloadsWithAccountNames(),
		]) {
			expect(JSON.parse(rows[0]?.json ?? "null").error).toBe(
				"Payload could not be decoded",
			);
		}
	});

	it("decodes compressed rows in single and both list readers", async () => {
		const json = JSON.stringify({ messages: ["history ".repeat(1000)] });
		const stored = `zst:${(await Bun.zstdCompress(json)).toString("base64")}`;
		insertRequestWithPayload(db, "compressed", Date.now(), stored);

		expect(await repo.getPayload("compressed")).toEqual(JSON.parse(json));
		expect((await repo.listPayloads())[0].json).toBe(json);
		expect((await repo.listPayloadsWithAccountNames())[0].json).toBe(json);
	});

	it("throws on corrupt compressed rows in strict reads but isolates list failures", async () => {
		insertRequestWithPayload(db, "corrupt", Date.now(), "zst:bm90IHpzdGQ=");
		insertRequestWithPayload(db, "valid", Date.now() - 1, '{"ok":true}');

		await expect(repo.getPayload("corrupt")).rejects.toThrow();
		for (const rows of [
			await repo.listPayloads(),
			await repo.listPayloadsWithAccountNames(),
		]) {
			expect(
				JSON.parse(rows.find((row) => row.id === "corrupt")?.json ?? "null")
					.error,
			).toBe("Payload could not be decoded");
			expect(rows.find((row) => row.id === "valid")?.json).toBe('{"ok":true}');
		}
	});

	it("timestamp field is present and correct for requests without payload", async () => {
		const ts = 1_700_000_000_000;
		insertRequest(db, "req-ts", ts);

		const results = await repo.listPayloadsWithAccountNames(10);

		expect(results[0].timestamp).toBe(ts);
	});

	it("timestamp field is present and correct for requests with payload", async () => {
		const ts = 1_700_100_000_000;
		insertRequestWithPayload(db, "req-ts-payload", ts, "{}");

		const results = await repo.listPayloadsWithAccountNames(10);

		expect(results[0].timestamp).toBe(ts);
	});

	it("results are ordered by timestamp DESC", async () => {
		const base = 1_700_000_000_000;
		insertRequest(db, "oldest", base);
		insertRequest(db, "middle", base + 1000);
		insertRequest(db, "newest", base + 2000);

		const results = await repo.listPayloadsWithAccountNames(10);

		expect(results.map((r) => r.id)).toEqual(["newest", "middle", "oldest"]);
	});

	it("account_name is null when no account is linked", async () => {
		insertRequest(db, "req-no-acct", Date.now());

		const results = await repo.listPayloadsWithAccountNames(10);

		expect(results[0].account_name).toBeNull();
	});

	it("account_name is set when an account is linked", async () => {
		const now = Date.now();
		insertAccount(db, "acct-1", "my-account");
		insertRequest(db, "req-acct", now);
		linkAccountToRequest(db, "req-acct", "acct-1");

		const results = await repo.listPayloadsWithAccountNames(10);

		expect(results[0].account_name).toBe("my-account");
	});

	it("limit param is respected", async () => {
		const base = 1_700_000_000_000;
		for (let i = 0; i < 5; i++) {
			insertRequest(db, `req-${i}`, base + i * 1000);
		}

		const results = await repo.listPayloadsWithAccountNames(3);

		expect(results).toHaveLength(3);
	});

	it("returns both payload and non-payload requests in the same result set", async () => {
		const base = 1_700_000_000_000;
		insertRequest(db, "no-payload", base);
		insertRequestWithPayload(db, "has-payload", base + 1000, "{}");

		const results = await repo.listPayloadsWithAccountNames(10);

		expect(results).toHaveLength(2);
		const noPayload = results.find((r) => r.id === "no-payload");
		const hasPayload = results.find((r) => r.id === "has-payload");
		expect(noPayload?.json).toBeNull();
		expect(hasPayload?.json).not.toBeNull();
	});
});
