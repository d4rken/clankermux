/**
 * A provider-reported zero must be STORED as 0, not folded into NULL.
 *
 * The two values answer different questions: NULL is "no count for this class
 * was received", 0 is "the provider reported none consumed". A consumer that
 * settles per-class accounting cannot resolve a row whose classes it can only
 * read as absent, so collapsing the two strands every request that simply
 * created no cache entry, which is the ordinary case rather than an edge one.
 *
 * Historical rows keep whatever they already hold; nothing here backfills.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { type RequestData, RequestRepository } from "../request.repository";

const TOKEN_COLUMNS = [
	"prompt_tokens",
	"completion_tokens",
	"total_tokens",
	"input_tokens",
	"cache_read_input_tokens",
	"cache_creation_input_tokens",
	"output_tokens",
] as const;

type TokenRow = Record<(typeof TOKEN_COLUMNS)[number], number | null>;

const ALL_ZERO: NonNullable<RequestData["usage"]> = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	inputTokens: 0,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	outputTokens: 0,
};

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

describe("requests token columns — a reported zero survives the write", () => {
	let db: Database;
	let repo: RequestRepository;

	const readTokens = (id = "req-1"): TokenRow =>
		db
			.query(`SELECT ${TOKEN_COLUMNS.join(", ")} FROM requests WHERE id = ?`)
			.get(id) as TokenRow;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("stores 0 on the INSERT path", async () => {
		await repo.save(requestData({ usage: { ...ALL_ZERO } }));

		const row = readTokens();
		for (const column of TOKEN_COLUMNS) {
			expect([column, row[column]]).toEqual([column, 0]);
		}
	});

	it("stores 0 on the updateUsage path", async () => {
		await repo.save(requestData());
		await repo.updateUsage("req-1", { ...ALL_ZERO });

		const row = readTokens();
		for (const column of TOKEN_COLUMNS) {
			expect([column, row[column]]).toEqual([column, 0]);
		}
	});

	it("still stores NULL for a class the provider did not report", async () => {
		// The distinction is the whole point: absent stays absent.
		await repo.save(
			requestData({ usage: { inputTokens: 0, outputTokens: 40 } }),
		);

		const row = readTokens();
		expect(row.input_tokens).toBe(0);
		expect(row.output_tokens).toBe(40);
		expect(row.cache_read_input_tokens).toBeNull();
		expect(row.cache_creation_input_tokens).toBeNull();
	});

	it("lets a patched 0 replace a stored count", async () => {
		// updateUsage binds parameter-first, `COALESCE(?, column)`, so only a
		// NULL parameter defers to what is already stored. A real 0 is not NULL
		// in SQL and must win, exactly as any other reported count would.
		await repo.save(requestData({ usage: { cacheReadInputTokens: 900 } }));
		await repo.updateUsage("req-1", { cacheReadInputTokens: 0 });

		expect(readTokens().cache_read_input_tokens).toBe(0);
	});
});
