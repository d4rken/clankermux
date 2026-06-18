import { describe, expect, it, mock } from "bun:test";
import { createConfigHandlers } from "../config";

function makeConfig() {
	let cacheWarmingEnabled = false;
	let cacheWarmingMinTokens = 100_000;
	return {
		getAllSettings: () => ({
			lb_strategy: "session",
			port: 8080,
			sessionDurationMs: 18_000_000,
			usage_throttling_five_hour_enabled: true,
			usage_throttling_weekly_enabled: true,
		}),
		getUsageThrottlingFiveHourEnabled: () => true,
		getUsageThrottlingWeeklyEnabled: () => true,
		setUsageThrottlingFiveHourEnabled: mock(() => {}),
		setUsageThrottlingWeeklyEnabled: mock(() => {}),
		getStrategy: () => "session",
		setStrategy: mock(() => {}),
		getDataRetentionDays: () => 3,
		getRequestRetentionDays: () => 90,
		getStorePayloads: () => true,
		setDataRetentionDays: mock(() => {}),
		setRequestRetentionDays: mock(() => {}),
		setStorePayloads: mock(() => {}),
		getCacheWarmingEnabled: () => cacheWarmingEnabled,
		setCacheWarmingEnabled: mock((v: boolean) => {
			cacheWarmingEnabled = v;
		}),
		getCacheWarmingMinTokens: () => cacheWarmingMinTokens,
		setCacheWarmingMinTokens: mock((v: number) => {
			cacheWarmingMinTokens = Math.max(0, v);
		}),
	} as unknown as import("@clankermux/config").Config;
}

describe("createConfigHandlers", () => {
	it("includes per-window usage throttling flags in config payload", async () => {
		const handlers = createConfigHandlers(makeConfig(), {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getConfig();
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.usage_throttling_five_hour_enabled).toBe(true);
		expect(body.usage_throttling_weekly_enabled).toBe(true);
	});

	it("updates usage throttling windows from POST body", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setUsageThrottling(
			new Request("http://localhost/api/config/usage-throttling", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					fiveHourEnabled: false,
					weeklyEnabled: true,
				}),
			}),
		);

		expect(response.status).toBe(204);
		expect(config.setUsageThrottlingFiveHourEnabled).toHaveBeenCalledWith(
			false,
		);
		expect(config.setUsageThrottlingWeeklyEnabled).toHaveBeenCalledWith(true);
	});

	it("returns current cache-warming settings", async () => {
		const handlers = createConfigHandlers(makeConfig(), {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getCacheWarming();
		const body = (await response.json()) as {
			enabled: boolean;
			minTokens: number;
		};

		expect(body.enabled).toBe(false);
		expect(body.minTokens).toBe(100_000);
	});

	it("updates cache-warming settings and returns the new values", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setCacheWarming(
			new Request("http://localhost/api/config/cache-warming", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: true, minTokens: 50_000 }),
			}),
		);
		const body = (await response.json()) as {
			enabled: boolean;
			minTokens: number;
		};

		expect(response.status).toBe(200);
		expect(config.setCacheWarmingEnabled).toHaveBeenCalledWith(true);
		expect(config.setCacheWarmingMinTokens).toHaveBeenCalledWith(50_000);
		expect(body).toEqual({ enabled: true, minTokens: 50_000 });
	});

	it("rejects a negative minTokens (router maps the thrown ValidationError to 400)", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		// validateNumber throws ValidationError (statusCode 400) for out-of-range
		// values; the router's try/catch turns that into a 400 response.
		await expect(
			handlers.setCacheWarming(
				new Request("http://localhost/api/config/cache-warming", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ minTokens: -1 }),
				}),
			),
		).rejects.toThrow();
		expect(config.setCacheWarmingMinTokens).not.toHaveBeenCalled();
	});

	it("rejects a non-boolean enabled with a 400", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setCacheWarming(
			new Request("http://localhost/api/config/cache-warming", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: "yes" }),
			}),
		);

		expect(response.status).toBe(400);
		expect(config.setCacheWarmingEnabled).not.toHaveBeenCalled();
	});
});
