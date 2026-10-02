/**
 * Model performance split by `requests.service_tier`, the tier the request's
 * latest upstream attempt went out at (which attempt that is, is the
 * dispatcher's business: service-tier-adaptation.test.ts). NULL reads as
 * standard.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter, ensureSchema } from "@clankermux/database";
import type { ModelPerformance } from "@clankermux/types";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics-direct";

const NOW = Date.now();

let db: Database;
let context: APIContext;

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	db.run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority, request_count)
		 VALUES ('acct-1', 'Codex', 'codex', 'tok', ?, 0, 0)`,
		[NOW],
	);
	const adapter = new BunSqlAdapter(db);
	context = {
		db: adapter,
		config: {},
		dbOps: { getAdapter: () => adapter },
	} as APIContext;
});

afterEach(() => {
	db.close();
});

function seedRequest(
	id: string,
	model: string,
	responseTimeMs: number,
	tier: "standard" | "priority" | null,
	opts: { success?: boolean } = {},
): void {
	const success = opts.success ?? true;
	db.run(
		`INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success, model, response_time_ms, output_tokens_per_second, service_tier)
		 VALUES (?, ?, 'POST', '/v1/responses', 'acct-1', ?, ?, ?, ?, ?, ?)`,
		[
			id,
			NOW - 60_000,
			success ? 200 : 500,
			success ? 1 : 0,
			model,
			responseTimeMs,
			success ? 50 : null,
			tier,
		],
	);
}

async function modelPerformance(): Promise<ModelPerformance[]> {
	const response = await createAnalyticsHandler(context)(
		new URLSearchParams({ range: "24h", sections: "modelPerformance" }),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		modelPerformance?: ModelPerformance[];
	};
	return body.modelPerformance ?? [];
}

const tiersOf = (rows: ModelPerformance[]) =>
	rows.map((row) => [row.model, row.serviceTier]);

describe("model performance by service tier", () => {
	it("files untiered and pre-column rows under standard", async () => {
		seedRequest("r1", "gpt-6-astra", 1000, null);
		seedRequest("r2", "gpt-6-astra", 1200, "standard");

		expect(tiersOf(await modelPerformance())).toEqual([
			["gpt-6-astra", "standard"],
		]);
	});

	it("splits one model into standard and priority rows", async () => {
		seedRequest("r1", "gpt-6-astra", 4000, null);
		seedRequest("r2", "gpt-6-astra", 4000, "standard");
		seedRequest("r3", "gpt-6-astra", 1000, "priority");

		const rows = await modelPerformance();
		expect(tiersOf(rows)).toEqual([
			["gpt-6-astra", "standard"],
			["gpt-6-astra", "priority"],
		]);
		expect(rows[0]?.avgResponseTime).toBe(4000);
		expect(rows[1]?.avgResponseTime).toBe(1000);
	});

	it("counts a failed priority request against priority", async () => {
		seedRequest("r1", "gpt-6-astra", 1000, "priority");
		seedRequest("r2", "gpt-6-astra", 900, "priority", { success: false });

		const [row] = await modelPerformance();
		expect(row?.serviceTier).toBe("priority");
		expect(row?.errorRate).toBe(50);
	});

	it("ranks models, not tier rows, and keeps both tiers of a top model", async () => {
		// Eleven models; m0 is busiest, m10 is the one that falls off.
		for (let m = 0; m <= 10; m++)
			for (let i = 0; i < 12 - m; i++)
				seedRequest(`r-${m}-${i}`, `m${m}`, 1000, "standard");
		// One priority request on the busiest model must not cost m9 its place.
		seedRequest("r-p", "m0", 500, "priority");

		const rows = await modelPerformance();
		const models = [...new Set(rows.map((row) => row.model))];
		expect(models).toEqual(Array.from({ length: 10 }, (_, m) => `m${m}`));
		expect(tiersOf(rows.filter((row) => row.model === "m0"))).toEqual([
			["m0", "standard"],
			["m0", "priority"],
		]);
	});
});
