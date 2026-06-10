import { describe, expect, it } from "bun:test";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics";

type AdditionalDataRow = {
	data_type: string;
	name: string;
	secondary_name: string | null;
	count: number | null;
	requests: number | null;
	success_rate: number | null;
	cost_usd: number | null;
	total_tokens: number | null;
	plan_cost_usd: number | null;
	api_cost_usd: number | null;
	total_cost_usd: number | null;
};

function createContext(additionalDataRows: AdditionalDataRow[]): APIContext {
	// Call order: 1 = timeSeries query, 2 = additionalData UNION query, 3 = modelPerfData query
	let callCount = 0;
	const mockDb = {
		get: async () => ({
			total_requests: 0,
			success_rate: 0,
			avg_response_time: 0,
			total_tokens: 0,
			total_cost_usd: 0,
			plan_cost_usd: 0,
			api_cost_usd: 0,
			avg_tokens_per_second: null,
			active_accounts: 0,
			input_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
			output_tokens: 0,
		}),
		query: async (_sql: string) => {
			callCount++;
			if (callCount === 2) {
				// Second call is the additionalData UNION query
				return additionalDataRows;
			}
			return [];
		},
	};

	return {
		db: {} as APIContext["db"],
		config: {} as APIContext["config"],
		dbOps: {
			getAdapter: () => mockDb,
		} as APIContext["dbOps"],
	};
}

describe("analytics account costs", () => {
	it("returns plan/api/total USD per account", async () => {
		const context = createContext([
			{
				data_type: "account_performance",
				name: "acct-1",
				secondary_name: null,
				count: null,
				requests: 3,
				success_rate: 100,
				cost_usd: null,
				total_tokens: null,
				plan_cost_usd: 1.25,
				api_cost_usd: 2.75,
				total_cost_usd: 4,
			},
		]);

		const response = await createAnalyticsHandler(context)(
			new URLSearchParams(),
		);
		const data = await response.json();

		expect(data.accountPerformance[0]).toEqual({
			name: "acct-1",
			requests: 3,
			successRate: 100,
			planCostUsd: 1.25,
			apiCostUsd: 2.75,
			totalCostUsd: 4,
		});
	});

	it("maps null billing_type: cost counts as token (api) cost, not plan", async () => {
		// The SQL buckets non-plan cost with `COALESCE(billing_type, 'api') != 'plan'`,
		// so rows with billing_type IS NULL land in api_cost_usd (a bare
		// `billing_type != 'plan'` would evaluate to NULL and silently drop them).
		// The SQL-level behaviour is covered by the real-DB test in
		// analytics-project-breakdown.test.ts; this documents the mapping.
		const context = createContext([
			{
				data_type: "account_performance",
				name: "acct-null-billing",
				secondary_name: null,
				count: null,
				requests: 1,
				success_rate: 100,
				cost_usd: null,
				total_tokens: null,
				plan_cost_usd: 0,
				api_cost_usd: 5,
				total_cost_usd: 5,
			},
		]);

		const response = await createAnalyticsHandler(context)(
			new URLSearchParams(),
		);
		const data = await response.json();

		expect(data.accountPerformance[0].planCostUsd).toBe(0);
		expect(data.accountPerformance[0].apiCostUsd).toBe(5);
		expect(data.accountPerformance[0].totalCostUsd).toBe(5);
	});

	it("maps null values to zero", async () => {
		const context = createContext([
			{
				data_type: "account_performance",
				name: "acct-null",
				secondary_name: null,
				count: null,
				requests: null,
				success_rate: null,
				cost_usd: null,
				total_tokens: null,
				plan_cost_usd: null,
				api_cost_usd: null,
				total_cost_usd: null,
			},
		]);

		const response = await createAnalyticsHandler(context)(
			new URLSearchParams(),
		);
		const data = await response.json();

		expect(data.accountPerformance[0]).toEqual({
			name: "acct-null",
			requests: 0,
			successRate: 0,
			planCostUsd: 0,
			apiCostUsd: 0,
			totalCostUsd: 0,
		});
	});
});
