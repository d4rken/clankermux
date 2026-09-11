import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
	EMPTY_REQUEST_FILTERS,
	type RequestFilters,
	RequestRepository,
} from "@clankermux/database";
import { BunSqlAdapter } from "../../../../database/src/adapters/bun-sql-adapter";
import { ensureSchema } from "../../../../database/src/migrations";
import { computeStopsHistory } from "../stops-history-direct";

const NOW = Date.UTC(2026, 8, 11, 6);
let db: Database;
afterEach(() => db?.close());

describe("outcome totals over real filtered request queries", () => {
	it.each([
		undefined,
		{
			...EMPTY_REQUEST_FILTERS,
			models: ["astra"],
			accounts: ["a"],
			apiKeys: ["k"],
			projects: ["p"],
		},
	])("excludes audits symmetrically and keeps only actual eligibility records (%j)", async (filters) => {
		db = new Database(":memory:");
		ensureSchema(db);
		const insert = db.prepare(
			`INSERT INTO requests (id,timestamp,method,path,status_code,success,error_message,model,requested_model,account_used,api_key_id,project) VALUES (?,?,'POST','/v1/messages',?,?,?,?,?,'a','k','p')`,
		);
		const groups = [
			["success", 200, 1, null, false],
			["block", 429, 0, "family_weekly_exhausted", false],
			["failure", 200, 0, "stream error", false],
			["disconnect", 200, 0, "client disconnected", false],
			["audit", 429, 0, "family_weekly_exhausted_429", true],
			["fallback-audit", 429, 0, "model_fallback_429", true],
		] as const;
		for (const [id, status, success, error, audit] of groups) {
			insert.run(id, NOW - 1000, status, success, error, "astra", "astra");
			if (!audit)
				db.run(
					`INSERT INTO request_routing (request_id,strategy,decision,candidates_count,created_at) VALUES (?,'session','ordered',2,?)`,
					[id, NOW - 1000],
				);
		}
		// A different model and an out-of-range audit must not be subtracted from
		// the filtered denominator. Both still exercise the real SQL grouping.
		insert.run(
			"other-model",
			NOW - 1000,
			429,
			0,
			"model_fallback_429",
			"other",
			"other",
		);
		insert.run(
			"old",
			NOW - 8 * 86400000,
			429,
			0,
			"model_fallback_429",
			"astra",
			"astra",
		);
		const repo = new RequestRepository(new BunSqlAdapter(db));
		const sources = {
			now: () => NOW,
			getStopsByBucket: repo.getStopsByBucket.bind(repo),
			getStopModelBreakdown: repo.getStopModelBreakdown.bind(repo),
			countRequestsSince: repo.countRequestsSince.bind(repo),
			getCandidateCountDistribution:
				repo.getCandidateCountDistribution.bind(repo),
		};
		const result = await computeStopsHistory(sources, "7d", {
			filters: filters as RequestFilters | undefined,
		});
		expect(result.totalRequests).toBe(4);
		expect(result.excludedAttemptAuditRows).toBe(filters ? 2 : 3);
		expect(result.outcomeTotals).toEqual({
			blocked: 1,
			failed: 1,
			disconnected: 1,
			unclassified: 0,
		});
		expect(result.candidates.observedRequests).toBe(4);
		expect(result.causes.every((c) => c.topRequestedModel === "astra")).toBe(
			true,
		);
		const success = await computeStopsHistory(sources, "7d", {
			filters: { ...EMPTY_REQUEST_FILTERS, status: "success" },
		});
		expect(success.totalRequests).toBe(1);
		expect(success.excludedAttemptAuditRows).toBe(0);
		expect(success.causes).toEqual([]);
	});
});
