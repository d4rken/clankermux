/**
 * The `strategies` one-shot claim used by async (network-bound) backfill passes,
 * which cannot claim inside runOneShotBackfills' transaction.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency (mirrors the other repository tests).
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { StrategyRepository } from "../strategy.repository";

const MARKER = "backfill:test-pass";

let repo: StrategyRepository;
let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	db.run(`
		CREATE TABLE strategies (
			name TEXT PRIMARY KEY,
			config TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	repo = new StrategyRepository(new BunSqlAdapter(db));
});

describe("StrategyRepository.claimMarker", () => {
	it("claims an unheld marker exactly once", async () => {
		expect(await repo.claimMarker(MARKER)).toBe(true);
		expect(await repo.claimMarker(MARKER)).toBe(false);
		expect(await repo.claimMarker(MARKER)).toBe(false);
	});

	it("records the claim as a readable strategies row", async () => {
		await repo.claimMarker(MARKER);

		const stored = await repo.getStrategy(MARKER);
		expect(stored?.name).toBe(MARKER);
		expect(stored?.config).toEqual({});
		expect(typeof stored?.updatedAt).toBe("number");
	});

	it("leaves an existing row untouched rather than failing on its unique name", async () => {
		await repo.set(MARKER, { appliedAt: 7 });

		expect(await repo.claimMarker(MARKER)).toBe(false);
		expect((await repo.getStrategy(MARKER))?.config).toEqual({ appliedAt: 7 });
	});

	it("claims distinct markers independently", async () => {
		expect(await repo.claimMarker(MARKER)).toBe(true);
		expect(await repo.claimMarker("backfill:other-pass")).toBe(true);
	});
});
