/**
 * Tests for `requests.session_key` + `requests.cache_prefix_hashes` — the
 * passive cache-measurement columns (Claude Code session identity, and the
 * per-breakpoint prompt-cache prefix digests).
 *
 * Both are ingress-derived facts: once written they must survive later
 * upserts that omit them (the usage-patch re-upsert carries neither), the same
 * COALESCE contract `project` has. The JSON1 assertions pin the exact
 * expressions the offline analysis relies on (`json_array_length`,
 * `json_extract('$[#-1]')`, `json_each`).
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

function readRow(
	db: Database,
	id = "req-1",
): { session_key: string | null; cache_prefix_hashes: string | null } | null {
	return db
		.query(`SELECT session_key, cache_prefix_hashes FROM requests WHERE id = ?`)
		.get(id) as {
		session_key: string | null;
		cache_prefix_hashes: string | null;
	} | null;
}

describe("requests cache-measurement columns", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("fresh schema has both columns", () => {
		const columns = db.query(`PRAGMA table_info(requests)`).all() as {
			name: string;
		}[];
		const names = new Set(columns.map((c) => c.name));
		expect(names.has("session_key")).toBe(true);
		expect(names.has("cache_prefix_hashes")).toBe(true);
	});

	it("round-trips both values on insert", async () => {
		await repo.save(
			requestData({
				sessionKey: "key1:abc-session",
				cachePrefixHashes: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
			}),
		);
		const row = readRow(db);
		expect(row?.session_key).toBe("key1:abc-session");
		expect(row?.cache_prefix_hashes).toBe(
			'["aaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbb"]',
		);
	});

	it("stores NULL when the fields are omitted", async () => {
		await repo.save(requestData());
		const row = readRow(db);
		expect(row?.session_key).toBeNull();
		expect(row?.cache_prefix_hashes).toBeNull();
	});

	it("a later upsert without the fields does not clobber them", async () => {
		await repo.save(
			requestData({
				sessionKey: "anon:s1",
				cachePrefixHashes: ["cccccccccccccccc"],
			}),
		);
		await repo.save(requestData());
		const row = readRow(db);
		expect(row?.session_key).toBe("anon:s1");
		expect(row?.cache_prefix_hashes).toBe('["cccccccccccccccc"]');
	});

	it("supports the offline-analysis JSON1 expressions on a stored row", async () => {
		await repo.save(
			requestData({
				sessionKey: "anon:s1",
				cachePrefixHashes: [
					"aaaaaaaaaaaaaaaa",
					"bbbbbbbbbbbbbbbb",
					"cccccccccccccccc",
				],
			}),
		);
		const derived = db
			.query(
				`SELECT json_array_length(cache_prefix_hashes) AS n,
				        json_extract(cache_prefix_hashes, '$[#-1]') AS last_hash
				 FROM requests WHERE id = 'req-1'`,
			)
			.get() as { n: number; last_hash: string };
		expect(derived.n).toBe(3);
		expect(derived.last_hash).toBe("cccccccccccccccc");

		const contained = db
			.query(
				`SELECT EXISTS (
				   SELECT 1 FROM requests, json_each(requests.cache_prefix_hashes)
				   WHERE requests.id = 'req-1' AND json_each.value = ?
				 ) AS hit`,
			)
			.get("bbbbbbbbbbbbbbbb") as { hit: number };
		expect(contained.hit).toBe(1);
	});
});
