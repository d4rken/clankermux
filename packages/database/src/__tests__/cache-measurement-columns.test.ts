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
				cachePrefixHashes: {
					v: 2,
					bp: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
					n: 3,
					tail: ["cccccccccccccccc"],
				},
			}),
		);
		const row = readRow(db);
		expect(row?.session_key).toBe("key1:abc-session");
		expect(row?.cache_prefix_hashes).toBe(
			'{"v":2,"bp":["aaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbb"],"n":3,"tail":["cccccccccccccccc"]}',
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
				cachePrefixHashes: {
					v: 2,
					bp: ["cccccccccccccccc"],
					n: 1,
					tail: ["dddddddddddddddd"],
				},
			}),
		);
		await repo.save(requestData());
		const row = readRow(db);
		expect(row?.session_key).toBe("anon:s1");
		expect(row?.cache_prefix_hashes).toBe(
			'{"v":2,"bp":["cccccccccccccccc"],"n":1,"tail":["dddddddddddddddd"]}',
		);
	});

	it("supports the offline-analysis JSON1 expressions on a stored row", async () => {
		// The position-aligned join the analysis runs: the digest of the whole
		// message prefix is tail[#-1]; the digest at 0-based message index i is
		// tail[i - (n - len(tail))] when the window still covers it.
		await repo.save(
			requestData({
				sessionKey: "anon:s1",
				cachePrefixHashes: {
					v: 2,
					bp: ["aaaaaaaaaaaaaaaa"],
					n: 20,
					tail: ["bbbbbbbbbbbbbbbb", "cccccccccccccccc"],
				},
			}),
		);
		const derived = db
			.query(
				`SELECT json_extract(cache_prefix_hashes, '$.v') AS v,
				        json_extract(cache_prefix_hashes, '$.n') AS n,
				        json_array_length(cache_prefix_hashes, '$.tail') AS tail_len,
				        json_extract(cache_prefix_hashes, '$.tail[#-1]') AS last_tail
				 FROM requests WHERE id = 'req-1'`,
			)
			.get() as { v: number; n: number; tail_len: number; last_tail: string };
		expect(derived.v).toBe(2);
		expect(derived.n).toBe(20);
		expect(derived.tail_len).toBe(2);
		expect(derived.last_tail).toBe("cccccccccccccccc");

		// Aligned lookup at message index 18 (n=20, window of 2 covers 18..19).
		const aligned = db
			.query(
				`SELECT json_extract(cache_prefix_hashes,
				          '$.tail[' || (18 - (json_extract(cache_prefix_hashes,'$.n')
				            - json_array_length(cache_prefix_hashes,'$.tail'))) || ']') AS h
				 FROM requests WHERE id = 'req-1'`,
			)
			.get() as { h: string };
		expect(aligned.h).toBe("bbbbbbbbbbbbbbbb");

		// Out-of-window lookup (index 17 with a 2-deep tail covering 18..19):
		// the guarded form returns NULL — the pair is UNMEASURABLE, not
		// diverged. The unguarded '$.tail[-1]' path would be a JSON1 error, so
		// the analysis SQL must always carry this CASE guard.
		const outOfWindow = db
			.query(
				`SELECT CASE
				   WHEN 17 >= json_extract(cache_prefix_hashes,'$.n')
				          - json_array_length(cache_prefix_hashes,'$.tail')
				   THEN json_extract(cache_prefix_hashes,
				          '$.tail[' || (17 - (json_extract(cache_prefix_hashes,'$.n')
				            - json_array_length(cache_prefix_hashes,'$.tail'))) || ']')
				   ELSE NULL END AS h
				 FROM requests WHERE id = 'req-1'`,
			)
			.get() as { h: string | null };
		expect(outOfWindow.h).toBeNull();
	});
});
