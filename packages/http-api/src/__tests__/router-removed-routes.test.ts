import { describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { BunSqlAdapter, DatabaseOperations } from "@clankermux/database";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

/**
 * `handleRequest` answers `null` for a path it has no handler for, which the
 * server turns into a 404. The handler map is keyed by `"METHOD:/path"`
 * strings, so nothing in the type checker ties a route to its handler: a
 * deletion that misses the registration leaves a route serving, and one that
 * misses a sibling takes a live route down with it. Hence both directions.
 */
function makeContext(): APIContext {
	const adapter = {
		query: async () => [],
		get: async () => null,
		run: async () => undefined,
	} as unknown as BunSqlAdapter;

	const dbOps = {
		getAdapter: () => adapter,
		getAllAccounts: async () => [],
	} as unknown as DatabaseOperations;

	const config = {
		getPayloadRetentionHours: () => 72,
		getPayloadMaxMb: () => 0,
		getRequestRetentionDays: () => 90,
		getUsageSnapshotRetentionDays: () => 90,
		getMemorySnapshotRetentionDays: () => 30,
		getCacheKeepaliveSnapshotRetentionDays: () => 30,
		getStorePayloads: () => true,
		getCacheWarmingMode: () => "off",
		getCacheWarmingMinTokens: () => 100_000,
		getCacheWarmingEnabled: () => false,
		getCacheWarmingRiskFactor: () => 0.4,
		getUsageThrottlingFiveHourEnabled: () => false,
		getUsageThrottlingWeeklyEnabled: () => false,
		getProjectRules: () => ({ roots: [], overrides: [] }),
	} as unknown as Config;

	return { db: adapter, config, dbOps } as APIContext;
}

async function dispatch(method: string, path: string) {
	const router = new APIRouter(makeContext());
	const url = new URL(`http://localhost${path}`);
	return router.handleRequest(url, new Request(url, { method }));
}

describe("router: routes removed for having no caller", () => {
	it.each([
		["GET", "/api/config"],
		["GET", "/api/config/strategy"],
		["POST", "/api/config/strategy"],
		["GET", "/api/strategies"],
		["GET", "/api/token-health/reauth-needed"],
		["POST", "/api/accounts/acct-1/reload"],
	])("does not serve %s %s", async (method, path) => {
		expect(await dispatch(method, path)).toBeNull();
	});

	it.each([
		["GET", "/api/config/retention"],
		["GET", "/api/config/cache-warming"],
		["GET", "/api/config/usage-throttling"],
		["GET", "/api/config/project-rules"],
		["GET", "/api/token-health"],
	])("still serves the kept sibling %s %s", async (method, path) => {
		const response = await dispatch(method, path);
		expect(response?.status).toBe(200);
	});
});
