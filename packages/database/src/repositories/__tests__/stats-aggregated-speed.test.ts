/**
 * Tests for StatsRepository.getAggregatedStats avgTokensPerSecond — the
 * plausibility bound (MAX_PLAUSIBLE_TOKENS_PER_SECOND) must exclude recording
 * artifacts (e.g. a 137k tok/s row) from the average, matching the analytics
 * handlers' SPEED_IN_RANGE_SQL filter.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MAX_PLAUSIBLE_TOKENS_PER_SECOND } from "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { StatsRepository } from "../stats.repository";

describe("getAggregatedStats avgTokensPerSecond plausibility", () => {
	let db: Database;
	let repo: StatsRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new StatsRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	function insertRequest(
		id: string,
		outputTokensPerSecond: number | null,
	): void {
		db.run(
			`INSERT INTO requests (
				id, timestamp, method, path, account_used, status_code, success,
				response_time_ms, model, output_tokens_per_second
			) VALUES (?, ?, 'POST', '/v1/messages', 'account-1', 200, TRUE,
				100, 'claude-test', ?)`,
			[id, Date.now(), outputTokensPerSecond],
		);
	}

	it("excludes implausible artifact rows from the average", async () => {
		insertRequest("req-1", 5);
		insertRequest("req-2", 7);
		// Recording artifact far above the plausibility ceiling — must not skew.
		insertRequest("req-artifact", 137_000);

		const stats = await repo.getAggregatedStats();
		expect(stats.avgTokensPerSecond).toBe(6);
	});

	it("excludes zero/negative speeds and counts NULL speeds as absent", async () => {
		insertRequest("req-1", 10);
		insertRequest("req-zero", 0);
		insertRequest("req-null", null);

		const stats = await repo.getAggregatedStats();
		expect(stats.avgTokensPerSecond).toBe(10);
	});

	it("returns null when every speed is implausible", async () => {
		insertRequest("req-artifact", MAX_PLAUSIBLE_TOKENS_PER_SECOND + 1);

		const stats = await repo.getAggregatedStats();
		expect(stats.avgTokensPerSecond).toBeNull();
	});

	it("keeps a speed exactly at the ceiling", async () => {
		insertRequest("req-max", MAX_PLAUSIBLE_TOKENS_PER_SECOND);

		const stats = await repo.getAggregatedStats();
		expect(stats.avgTokensPerSecond).toBe(MAX_PLAUSIBLE_TOKENS_PER_SECOND);
	});
});
