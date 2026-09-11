import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type RequestRow,
	toRequest,
	toRequestResponse,
} from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import {
	type RequestData,
	RequestRepository,
} from "../repositories/request.repository";

let db: Database;
let repo: RequestRepository;
const request: RequestData = {
	id: "r",
	method: "POST",
	path: "/v1/messages",
	accountUsed: "a",
	statusCode: 200,
	success: true,
	errorMessage: null,
	responseTime: 100,
	failoverAttempts: 0,
	projectAttributionSource: null,
};
beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	repo = new RequestRepository(new BunSqlAdapter(db));
});
afterEach(() => db.close());
function row() {
	return db
		.query<RequestRow, []>("SELECT * FROM requests WHERE id = 'r'")
		.get() as RequestRow;
}

describe("request cost persistence", () => {
	it("preserves a reported zero, its estimate, and false BYOK through insert and API conversion", async () => {
		await repo.save({
			...request,
			usage: {
				model: "deepseek/test",
				costUsd: 0,
				costSource: "reported",
				estimatedCostUsd: 0.02,
				costIsByok: false,
			},
		});
		expect(row()).toMatchObject({
			cost_usd: 0,
			cost_source: "reported",
			estimated_cost_usd: 0.02,
			cost_is_byok: 0,
		});
		expect(toRequestResponse(toRequest(row()))).toMatchObject({
			costUsd: 0,
			costSource: "reported",
			estimatedCostUsd: 0.02,
			costIsByok: false,
		});
	});
	it("upgrades an estimate to a reported zero via a late patch without later degrading it", async () => {
		await repo.save({
			...request,
			usage: {
				model: "deepseek/test",
				costUsd: 0.02,
				costSource: "estimated",
				estimatedCostUsd: 0.02,
				costIsByok: false,
			},
		});
		await repo.updateUsage("r", {
			costUsd: 0,
			costSource: "reported",
			costIsByok: true,
		});
		await repo.updateUsage("r", {
			costUsd: 0.03,
			costSource: "estimated",
			estimatedCostUsd: 0.03,
		});
		expect(row()).toMatchObject({
			cost_usd: 0,
			cost_source: "reported",
			estimated_cost_usd: 0.03,
			cost_is_byok: 1,
		});
	});
	it("keeps a coherent reported cost and known model across usage-less or estimated re-upserts", async () => {
		await repo.save({
			...request,
			usage: {
				model: "deepseek/test",
				costUsd: 0.013,
				costSource: "reported",
				estimatedCostUsd: 0.02,
			},
		});
		await repo.save(request);
		await repo.save({
			...request,
			usage: { costUsd: 0.04, costSource: "estimated", estimatedCostUsd: 0.04 },
		});
		expect(row()).toMatchObject({
			model: "deepseek/test",
			cost_usd: 0.013,
			cost_source: "reported",
			estimated_cost_usd: 0.04,
		});
	});
	it("preserves unknown values and keeps legacy amounts unverified", async () => {
		await repo.save(request);
		expect(row()).toMatchObject({
			cost_usd: null,
			cost_source: "unknown",
			estimated_cost_usd: null,
		});
		expect(toRequest(row()).costUsd).toBeUndefined();
		db.run("UPDATE requests SET cost_usd = 0.1, cost_source = NULL");
		expect(toRequest(row())).toMatchObject({
			costUsd: 0.1,
			costSource: "unknown",
		});
	});
	it("adds nullable provenance to existing databases without rewriting historical amounts", async () => {
		await repo.save({ ...request, usage: { model: "old", costUsd: 1 } });
		// The old schema also predates the index that references cost_source.
		db.run("DROP INDEX idx_requests_cost_coverage");
		for (const name of ["cost_source", "estimated_cost_usd", "cost_is_byok"])
			db.run(`ALTER TABLE requests DROP COLUMN ${name}`);
		runMigrations(db);
		runMigrations(db);
		expect(row()).toMatchObject({
			cost_usd: 1,
			cost_source: null,
			estimated_cost_usd: null,
			cost_is_byok: null,
		});
	});
});
