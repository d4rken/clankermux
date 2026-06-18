import { describe, expect, it, mock } from "bun:test";
import { createConfigHandlers } from "../config";

function makeConfig() {
	let cacheWarmingMode: "off" | "static" | "dynamic" = "off";
	let cacheWarmingMinTokens = 100_000;
	let cacheKeepaliveSnapshotDays = 30;
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
		getUsageSnapshotRetentionDays: () => 90,
		getMemorySnapshotRetentionDays: () => 30,
		getCacheKeepaliveSnapshotRetentionDays: () => cacheKeepaliveSnapshotDays,
		setCacheKeepaliveSnapshotRetentionDays: mock((v: number) => {
			cacheKeepaliveSnapshotDays = v;
		}),
		getStorePayloads: () => true,
		setDataRetentionDays: mock(() => {}),
		setRequestRetentionDays: mock(() => {}),
		setUsageSnapshotRetentionDays: mock(() => {}),
		setMemorySnapshotRetentionDays: mock(() => {}),
		setStorePayloads: mock(() => {}),
		getCacheWarmingMode: () => cacheWarmingMode,
		setCacheWarmingMode: mock((v: "off" | "static" | "dynamic") => {
			cacheWarmingMode = v;
		}),
		getCacheWarmingEnabled: () => cacheWarmingMode !== "off",
		setCacheWarmingEnabled: mock((v: boolean) => {
			cacheWarmingMode = v ? "dynamic" : "off";
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

	it("returns current cache-warming settings (mode + minTokens + enabled)", async () => {
		const handlers = createConfigHandlers(makeConfig(), {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getCacheWarming();
		const body = (await response.json()) as {
			mode: string;
			enabled: boolean;
			minTokens: number;
		};

		expect(body.mode).toBe("off");
		expect(body.enabled).toBe(false);
		expect(body.minTokens).toBe(100_000);
	});

	it("persists a valid mode and returns the new mode-aware shape", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setCacheWarming(
			new Request("http://localhost/api/config/cache-warming", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "static", minTokens: 50_000 }),
			}),
		);
		const body = (await response.json()) as {
			mode: string;
			enabled: boolean;
			minTokens: number;
		};

		expect(response.status).toBe(200);
		expect(config.setCacheWarmingMode).toHaveBeenCalledWith("static");
		expect(config.setCacheWarmingMinTokens).toHaveBeenCalledWith(50_000);
		expect(body).toEqual({ mode: "static", enabled: true, minTokens: 50_000 });
	});

	it("rejects an invalid mode with a 400", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setCacheWarming(
			new Request("http://localhost/api/config/cache-warming", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "turbo" }),
			}),
		);

		expect(response.status).toBe(400);
		expect(config.setCacheWarmingMode).not.toHaveBeenCalled();
	});

	it("still honors the legacy {enabled:true} toggle", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setCacheWarming(
			new Request("http://localhost/api/config/cache-warming", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: true }),
			}),
		);
		const body = (await response.json()) as {
			mode: string;
			enabled: boolean;
			minTokens: number;
		};

		expect(response.status).toBe(200);
		expect(config.setCacheWarmingEnabled).toHaveBeenCalledWith(true);
		expect(config.setCacheWarmingMode).not.toHaveBeenCalled();
		expect(body.mode).toBe("dynamic");
		expect(body.enabled).toBe(true);
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

	it("includes cacheKeepaliveSnapshotDays in the retention payload", async () => {
		const handlers = createConfigHandlers(makeConfig(), {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getRetention();
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.cacheKeepaliveSnapshotDays).toBe(30);
		expect(body.memorySnapshotDays).toBe(30);
	});

	it("persists cacheKeepaliveSnapshotDays from the retention setter", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setRetention(
			new Request("http://localhost/api/config/retention", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cacheKeepaliveSnapshotDays: 14 }),
			}),
		);

		expect(response.status).toBe(204);
		expect(config.setCacheKeepaliveSnapshotRetentionDays).toHaveBeenCalledWith(
			14,
		);
	});

	it("rejects an out-of-range cacheKeepaliveSnapshotDays", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		// validateNumber throws ValidationError (400) for out-of-range; the
		// router's try/catch surfaces it as a 400.
		await expect(
			handlers.setRetention(
				new Request("http://localhost/api/config/retention", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ cacheKeepaliveSnapshotDays: 0 }),
				}),
			),
		).rejects.toThrow();
		expect(
			config.setCacheKeepaliveSnapshotRetentionDays,
		).not.toHaveBeenCalled();
	});
});
