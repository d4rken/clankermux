import { afterEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { BunSqlAdapter, DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import type { RunwayResponse } from "@clankermux/types";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

const ACCOUNT_ID = "router-runway-acc";

/**
 * The registration itself is worth a test: the handler map is keyed by
 * `"METHOD:/path"` strings, so a typo there is invisible to the type checker
 * and turns the endpoint into a 404 that no handler-level test would catch.
 */
function makeContext(): APIContext {
	const adapter = {
		query: async () => [],
		get: async () => null,
		run: async () => undefined,
	} as unknown as BunSqlAdapter;

	const dbOps = {
		getAdapter: () => adapter,
		getAllAccounts: async () => [
			{
				id: ACCOUNT_ID,
				name: "Router account",
				provider: "anthropic",
			},
		],
		getApiKeys: async () => [
			{
				id: "router-key",
				name: "prod",
				hashedKey: "sha256$deadbeef",
				prefixLast8: "abcdefgh",
				createdAt: Date.now(),
				lastUsed: null,
				usageCount: 0,
				isActive: true,
				pinnedAccountId: null,
				pinnedProviders: null,
			},
		],
		getRecentUsageSnapshotsForAccounts: async () => [],
	} as unknown as DatabaseOperations;

	const config = {
		getUsageThrottlingFiveHourEnabled: () => false,
		getUsageThrottlingWeeklyEnabled: () => false,
	} as unknown as Config;

	return { db: adapter, config, dbOps } as APIContext;
}

describe("router: GET /api/runway", () => {
	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
	});

	it("is registered and serves the documented top-level shape", async () => {
		const now = Date.now();
		usageCache.set(ACCOUNT_ID, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
			},
			seven_day: {
				utilization: 5,
				resets_at: new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString(),
			},
		});

		const router = new APIRouter(makeContext());
		const url = new URL("http://localhost/api/runway");
		const response = await router.handleRequest(
			url,
			new Request(url, { method: "GET" }),
		);

		expect(response).not.toBeNull();
		expect(response?.status).toBe(200);

		const body = (await response?.json()) as RunwayResponse;
		// A BARE object, matching every read-only GET here — `{success,data}` is
		// the mutation convention.
		expect(Object.keys(body).sort()).toEqual([
			"accounts",
			"generatedAt",
			"horizonMs",
			"keys",
			"worstKeyId",
		]);
		expect(body.keys[0].keyId).toBe("router-key");
		expect(body.accounts[0].id).toBe(ACCOUNT_ID);
		expect(body.accounts[0].windows.map((w) => w.kind)).toEqual([
			"five_hour",
			"seven_day",
		]);
	});

	it("does not answer the path with a method it was not registered for", async () => {
		const router = new APIRouter(makeContext());
		const url = new URL("http://localhost/api/runway");

		const response = await router.handleRequest(
			url,
			new Request(url, { method: "POST" }),
		);

		expect(response).toBeNull();
	});
});
