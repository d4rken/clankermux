import { describe, expect, it, mock } from "bun:test";
import { createConfigHandlers } from "../config";

function makeConfig() {
	let cacheWarmingMode: "off" | "static" | "dynamic" = "off";
	let cacheWarmingMinTokens = 100_000;
	let cacheWarmingRiskFactor = 0.4;
	let cacheKeepaliveSnapshotDays = 30;
	let payloadMaxMb = 0;
	let projectRules: {
		roots: string[];
		overrides: { prefix: string; name: string }[];
	} = { roots: ["/home/*"], overrides: [] };
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
		getPayloadRetentionHours: () => 72,
		getRequestRetentionDays: () => 90,
		getUsageSnapshotRetentionDays: () => 90,
		getMemorySnapshotRetentionDays: () => 30,
		getCacheKeepaliveSnapshotRetentionDays: () => cacheKeepaliveSnapshotDays,
		setCacheKeepaliveSnapshotRetentionDays: mock((v: number) => {
			cacheKeepaliveSnapshotDays = v;
		}),
		getStorePayloads: () => true,
		getPayloadMaxMb: () => payloadMaxMb,
		setPayloadMaxMb: mock((v: number) => {
			payloadMaxMb = v;
		}),
		setPayloadRetentionHours: mock(() => {}),
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
		getCacheWarmingRiskFactor: () => cacheWarmingRiskFactor,
		setCacheWarmingRiskFactor: mock((v: number) => {
			cacheWarmingRiskFactor = Math.min(Math.max(v, 0), 1);
		}),
		getProjectRules: () => projectRules,
		setProjectRules: mock((v: typeof projectRules) => {
			projectRules = v;
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
		expect(body).toMatchObject({
			mode: "static",
			enabled: true,
			minTokens: 50_000,
		});
	});

	it("GET exposes bridge-horizon fields (riskFactor, bridgeHours, conversion constants)", async () => {
		const handlers = createConfigHandlers(makeConfig(), {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getCacheWarming();
		const body = (await response.json()) as {
			riskFactor: number;
			bridgeHours: number;
			maxBridgeHours: number;
			hoursPerRiskUnit: number;
			refreshMinutes: number;
		};

		expect(body.riskFactor).toBe(0.4);
		// 0.4 × ~9.58 ≈ 3.83h.
		expect(body.bridgeHours).toBeCloseTo(3.8333, 2);
		expect(body.hoursPerRiskUnit).toBeCloseTo(9.5833, 2);
		expect(body.maxBridgeHours).toBeCloseTo(9.5833, 2);
		expect(body.refreshMinutes).toBe(50);
	});

	it("accepts bridgeHours and stores the derived risk factor", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setCacheWarming(
			new Request("http://localhost/api/config/cache-warming", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				// ~5.75h ≈ risk factor 0.6.
				body: JSON.stringify({ bridgeHours: 5.75 }),
			}),
		);
		const body = (await response.json()) as {
			riskFactor: number;
			bridgeHours: number;
		};

		expect(response.status).toBe(200);
		const rf = (config.setCacheWarmingRiskFactor as ReturnType<typeof mock>)
			.mock.calls[0][0] as number;
		expect(rf).toBeCloseTo(0.6, 2);
		expect(body.bridgeHours).toBeCloseTo(5.75, 1);
	});

	it("accepts a raw riskFactor when bridgeHours is absent", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setCacheWarming(
			new Request("http://localhost/api/config/cache-warming", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ riskFactor: 0.7 }),
			}),
		);

		expect(response.status).toBe(200);
		expect(config.setCacheWarmingRiskFactor).toHaveBeenCalledWith(0.7);
	});

	it("clamps an out-of-range bridgeHours to the max (risk factor 1.0) instead of rejecting", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setCacheWarming(
			new Request("http://localhost/api/config/cache-warming", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ bridgeHours: 999 }),
			}),
		);

		expect(response.status).toBe(200);
		const rf = (config.setCacheWarmingRiskFactor as ReturnType<typeof mock>)
			.mock.calls[0][0] as number;
		expect(rf).toBeCloseTo(1.0, 6); // clamped to MAX_RISK_FACTOR
	});

	it("rejects a non-numeric bridgeHours (router maps the thrown ValidationError to 400)", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		await expect(
			handlers.setCacheWarming(
				new Request("http://localhost/api/config/cache-warming", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ bridgeHours: "soon" }),
				}),
			),
		).rejects.toThrow();
		expect(config.setCacheWarmingRiskFactor).not.toHaveBeenCalled();
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

	it("reports the payload window in hours, not days", async () => {
		const handlers = createConfigHandlers(makeConfig(), {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getRetention();
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.payloadHours).toBe(72);
		expect(body).not.toHaveProperty("payloadDays");
	});

	it("persists a sub-day payloadHours from the retention setter", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setRetention(
			new Request("http://localhost/api/config/retention", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ payloadHours: 12 }),
			}),
		);

		expect(response.status).toBe(204);
		expect(config.setPayloadRetentionHours).toHaveBeenCalledWith(12);
	});

	it("rejects an out-of-range payloadHours", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		// validateNumber throws ValidationError (400) for out-of-range; only the
		// router turns that into an HTTP 400, so assert rejection here.
		await expect(
			handlers.setRetention(
				new Request("http://localhost/api/config/retention", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ payloadHours: 8761 }),
				}),
			),
		).rejects.toThrow();
		expect(config.setPayloadRetentionHours).not.toHaveBeenCalled();
	});

	it("rejects a zero payloadHours", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		await expect(
			handlers.setRetention(
				new Request("http://localhost/api/config/retention", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ payloadHours: 0 }),
				}),
			),
		).rejects.toThrow();
		expect(config.setPayloadRetentionHours).not.toHaveBeenCalled();
	});

	it("rejects a fractional payloadHours", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		await expect(
			handlers.setRetention(
				new Request("http://localhost/api/config/retention", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ payloadHours: 1.5 }),
				}),
			),
		).rejects.toThrow();
		expect(config.setPayloadRetentionHours).not.toHaveBeenCalled();
	});

	it("includes payloadMaxMb in the retention payload", async () => {
		const handlers = createConfigHandlers(makeConfig(), {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getRetention();
		const body = (await response.json()) as Record<string, unknown>;

		// 0 = the byte budget is off; the field must still be present so the
		// dashboard can render the control.
		expect(body.payloadMaxMb).toBe(0);
	});

	it("persists payloadMaxMb from the retention setter", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setRetention(
			new Request("http://localhost/api/config/retention", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ payloadMaxMb: 4096 }),
			}),
		);

		expect(response.status).toBe(204);
		expect(config.setPayloadMaxMb).toHaveBeenCalledWith(4096);
		// Round-trip: the GET reflects what was just set.
		const getBody = (await handlers.getRetention().json()) as Record<
			string,
			unknown
		>;
		expect(getBody.payloadMaxMb).toBe(4096);
	});

	it("accepts payloadMaxMb = 0 (disables the budget)", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setRetention(
			new Request("http://localhost/api/config/retention", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ payloadMaxMb: 0 }),
			}),
		);

		expect(response.status).toBe(204);
		expect(config.setPayloadMaxMb).toHaveBeenCalledWith(0);
	});

	it("rejects a negative payloadMaxMb", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		// validateNumber THROWS a ValidationError (400) rather than returning;
		// only the router turns that into an HTTP response.
		await expect(
			handlers.setRetention(
				new Request("http://localhost/api/config/retention", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ payloadMaxMb: -1 }),
				}),
			),
		).rejects.toThrow();
		expect(config.setPayloadMaxMb).not.toHaveBeenCalled();
	});

	it("rejects an out-of-range payloadMaxMb", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		await expect(
			handlers.setRetention(
				new Request("http://localhost/api/config/retention", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ payloadMaxMb: 1_048_577 }),
				}),
			),
		).rejects.toThrow();
		expect(config.setPayloadMaxMb).not.toHaveBeenCalled();
	});

	it("rejects a fractional payloadMaxMb", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		await expect(
			handlers.setRetention(
				new Request("http://localhost/api/config/retention", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ payloadMaxMb: 1.5 }),
				}),
			),
		).rejects.toThrow();
		expect(config.setPayloadMaxMb).not.toHaveBeenCalled();
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

	describe("project rules", () => {
		function handlersFor(config: import("@clankermux/config").Config) {
			return createConfigHandlers(config, { port: 8080, tlsEnabled: false });
		}

		function post(body: unknown): Request {
			return new Request("http://localhost/api/config/project-rules", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		}

		it("returns the stored rules plus the defaults", async () => {
			const response = handlersFor(makeConfig()).getProjectRules();
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.roots).toEqual(["/home/*"]);
			expect(body.overrides).toEqual([]);
			// The UI offers "restore defaults" from this rather than hardcoding a
			// list that would drift from the server's.
			expect(Array.isArray(body.defaultRoots)).toBe(true);
			expect(body.defaultRoots).toContain("/home/*");
			expect(Array.isArray(body.unmatched)).toBe(true);
		});

		it("stores a valid payload and answers 204", async () => {
			const config = makeConfig();
			const response = await handlersFor(config).setProjectRules(
				post({
					roots: ["/workspace"],
					overrides: [{ prefix: "/home/u/.claude", name: ".claude" }],
				}),
			);
			expect(response.status).toBe(204);
			expect(config.setProjectRules).toHaveBeenCalledWith({
				roots: ["/workspace"],
				overrides: [{ prefix: "/home/u/.claude", name: ".claude" }],
			});
		});

		it("rejects a bad payload with 400 and writes nothing", async () => {
			// Hand-rolled BadRequest, not a throwing validator, so assert on the
			// status here rather than with rejects.toThrow().
			const config = makeConfig();
			const response = await handlersFor(config).setProjectRules(
				post({ roots: ["relative/path"], overrides: [] }),
			);
			expect(response.status).toBe(400);
			expect(config.setProjectRules).not.toHaveBeenCalled();
		});

		it("writes NOTHING when a later entry is invalid", async () => {
			// The all-or-nothing property this handler exists to have: a
			// half-applied rule set silently changes which upstream account the
			// affected projects pin to.
			const config = makeConfig();
			const response = await handlersFor(config).setProjectRules(
				post({
					roots: ["/workspace", "/srv", "nope"],
					overrides: [{ prefix: "/home/u", name: "u" }],
				}),
			);
			expect(response.status).toBe(400);
			expect(config.setProjectRules).not.toHaveBeenCalled();
		});

		it("accepts empty lists", async () => {
			const config = makeConfig();
			const response = await handlersFor(config).setProjectRules(
				post({ roots: [], overrides: [] }),
			);
			expect(response.status).toBe(204);
			expect(config.setProjectRules).toHaveBeenCalledWith({
				roots: [],
				overrides: [],
			});
		});
	});
});
