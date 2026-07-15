import { describe, expect, it } from "bun:test";
import { AsyncDbWriter } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import type { Account, AnthropicUsageData } from "@clankermux/types";
import { computePoolStatus, createHealthHandler } from "../health";

const EXH_NOW = 1_750_000_000_000;
const EXH_FUTURE_ISO = new Date(EXH_NOW + 3_600_000).toISOString();

/** A limits[]-only Anthropic payload with a single account-wide weekly window. */
function weeklyAllUsage(
	percent: number,
	resetsAt: string | null,
): AnthropicUsageData {
	return {
		limits: [
			{
				kind: "weekly_all",
				group: "weekly",
				percent,
				resets_at: resetsAt,
				scope: null,
				is_active: true,
			},
		],
	};
}

/**
 * A flat Anthropic payload where the OAuth-apps weekly window (Claude Code
 * quota) is the binding one — `seven_day` stays below 100.
 */
function oauthAppsUsage(
	oauthPercent: number,
	oauthResetsAt: string | null,
	sevenDayPercent = 50,
): AnthropicUsageData {
	return {
		five_hour: { utilization: 10, resets_at: EXH_FUTURE_ISO },
		seven_day: { utilization: sevenDayPercent, resets_at: EXH_FUTURE_ISO },
		seven_day_oauth_apps: {
			utilization: oauthPercent,
			resets_at: oauthResetsAt,
		},
	};
}

/** Partial shape of the /health JSON body, covering fields asserted in tests. */
interface HealthTestBody {
	status?: string;
	accounts?: number;
	strategy?: string;
	pool?: unknown;
	runtime?: {
		asyncWriter?: unknown;
		usageWorker?: unknown;
		[key: string]: unknown;
	};
	accounts_detail?: Array<Record<string, unknown>>;
	[key: string]: unknown;
}

describe("health runtime payload", () => {
	it("returns unhealthy status when no routable accounts and no recovery time", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "paused1", paused: true, rate_limited_until: null },
				{ name: "paused2", paused: true, rate_limited_until: null },
			],
		} as unknown as import("@clankermux/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;

		const handler = createHealthHandler(db, config);
		const url = new URL("http://localhost/health");
		const response = await handler(url);
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(503);
		expect(body.status).toBe("unhealthy");
		expect(body.accounts).toBe(2);
	});

	it("includes runtime health when callbacks are provided", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: false, rate_limited_until: null },
				{ name: "acc2", paused: false, rate_limited_until: null },
				{ name: "acc3", paused: false, rate_limited_until: null },
			],
		} as unknown as import("@clankermux/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;

		const handler = createHealthHandler(db, config, () => ({
			healthy: true,
			failureCount: 0,
			recentDrops: 0,
			queuedJobs: 2,
		}));

		const url = new URL("http://localhost/health");
		const response = await handler(url);
		const body = (await response.json()) as HealthTestBody;

		expect(response.status).toBe(200);
		expect(body.status).toBe("ok");
		expect(body.accounts).toBe(3);
		expect(body.strategy).toBe("session");
		expect(body.runtime).toBeDefined();
		expect(body.runtime.asyncWriter).toEqual({
			healthy: true,
			failureCount: 0,
			recentDrops: 0,
			queuedJobs: 2,
		});
		// The usage worker has been retired — only asyncWriter (+ storage) remain.
		expect(body.runtime.usageWorker).toBeUndefined();
	});

	it("omits runtime health when callbacks are not provided", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: false, rate_limited_until: null },
			],
		} as unknown as import("@clankermux/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;

		const handler = createHealthHandler(db, config);
		const url = new URL("http://localhost/health");
		const response = await handler(url);
		const body = (await response.json()) as Record<string, unknown>;

		expect(body).not.toHaveProperty("runtime");
	});
});

describe("AsyncDbWriter.getHealth", () => {
	it("reports healthy state with zero failures by default", async () => {
		const writer = new AsyncDbWriter();
		const health = writer.getHealth();

		expect(health).toEqual({
			healthy: true,
			failureCount: 0,
			recentDrops: 0,
			queuedJobs: 0,
			metadataQueuedJobs: 0,
			payloadQueuedJobs: 0,
			payloadBytesPending: 0,
			oldestMetadataAgeMs: 0,
			oldestPayloadAgeMs: 0,
			metadataDropped: 0,
			payloadDropped: 0,
			payloadDroppedBytes: 0,
		});

		await writer.dispose();
	});

	it("returns numeric queuedJobs after enqueue", async () => {
		const writer = new AsyncDbWriter();
		writer.enqueue(() => {});

		const health = writer.getHealth();
		expect(typeof health.queuedJobs).toBe("number");
		expect(health.queuedJobs).toBeGreaterThanOrEqual(0);

		await writer.dispose();
	});
});

describe("computePoolStatus", () => {
	it("calculates pool status with mixed account states", async () => {
		const { computePoolStatus } = await import("../health");
		const now = Date.now();

		const accounts = [
			{ name: "available1", paused: false, rate_limited_until: null },
			{ name: "available2", paused: false, rate_limited_until: null },
			{ name: "paused1", paused: true, rate_limited_until: null },
			{ name: "paused2", paused: true, rate_limited_until: null },
			{
				name: "rate-limited",
				paused: false,
				rate_limited_until: now + 3600000,
			},
		] as unknown as Account[];

		const status = computePoolStatus(accounts, now);

		expect(status.configured).toBe(5);
		expect(status.paused).toBe(2);
		expect(status.rate_limited).toBe(1);
		expect(status.routable).toBe(2);
		expect(status.next_available_at).toBe(
			new Date(now + 3600000).toISOString(),
		);
	});

	it("handles empty pool", async () => {
		const { computePoolStatus } = await import("../health");
		const status = computePoolStatus([], Date.now());

		expect(status.configured).toBe(0);
		expect(status.paused).toBe(0);
		expect(status.rate_limited).toBe(0);
		expect(status.routable).toBe(0);
		expect(status.next_available_at).toBeNull();
	});

	it("handles all paused accounts", async () => {
		const { computePoolStatus } = await import("../health");
		const accounts = [
			{ name: "paused1", paused: true, rate_limited_until: null },
			{ name: "paused2", paused: true, rate_limited_until: null },
		] as unknown as Account[];

		const status = computePoolStatus(accounts, Date.now());

		expect(status.configured).toBe(2);
		expect(status.paused).toBe(2);
		expect(status.rate_limited).toBe(0);
		expect(status.routable).toBe(0);
		expect(status.next_available_at).toBeNull();
	});

	it("handles all rate-limited accounts with recovery times", async () => {
		const { computePoolStatus } = await import("../health");
		const now = Date.now();
		const accounts = [
			{
				name: "limited1",
				paused: false,
				rate_limited_until: now + 1800000,
			},
			{
				name: "limited2",
				paused: false,
				rate_limited_until: now + 3600000,
			},
		] as unknown as Account[];

		const status = computePoolStatus(accounts, now);

		expect(status.configured).toBe(2);
		expect(status.paused).toBe(0);
		expect(status.rate_limited).toBe(2);
		expect(status.routable).toBe(0);
		expect(status.next_available_at).toBe(
			new Date(now + 1800000).toISOString(),
		);
	});

	it("ignores expired rate limits", async () => {
		const { computePoolStatus } = await import("../health");
		const now = Date.now();
		const accounts = [
			{
				name: "expired-limit",
				paused: false,
				rate_limited_until: now - 1000,
			},
			{ name: "available", paused: false, rate_limited_until: null },
		] as unknown as Account[];

		const status = computePoolStatus(accounts, now);

		expect(status.rate_limited).toBe(0);
		expect(status.routable).toBe(2);
		expect(status.next_available_at).toBeNull();
	});
});

describe("computePoolStatus usage-window exhaustion", () => {
	it("counts a 100%-weekly account as usage_exhausted, not routable, and recovers at the weekly reset", () => {
		const accounts = [
			{ name: "healthy", paused: false, rate_limited_until: null },
			{ name: "exhausted", paused: false, rate_limited_until: null },
		] as unknown as Account[];
		const status = computePoolStatus(accounts, EXH_NOW, (a) =>
			a.name === "exhausted" ? weeklyAllUsage(100, EXH_FUTURE_ISO) : null,
		);
		expect(status.routable).toBe(1);
		expect(status.usage_exhausted).toBe(1);
		expect(status.rate_limited).toBe(0);
		expect(status.next_available_at).toBe(EXH_FUTURE_ISO);
	});

	it("keeps a scoped-only exhausted account routable (family-scoped is detail-only)", () => {
		const scopedOnly: AnthropicUsageData = {
			limits: [
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 100,
					resets_at: EXH_FUTURE_ISO,
					scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
					is_active: true,
				},
			],
		};
		const accounts = [
			{ name: "scoped", paused: false, rate_limited_until: null },
		] as unknown as Account[];
		const status = computePoolStatus(accounts, EXH_NOW, () => scopedOnly);
		expect(status.routable).toBe(1);
		expect(status.usage_exhausted).toBe(0);
	});

	it("does not flag a 100%-weekly window whose reset is already in the past (stale)", () => {
		const accounts = [
			{ name: "stale", paused: false, rate_limited_until: null },
		] as unknown as Account[];
		const status = computePoolStatus(accounts, EXH_NOW, () =>
			weeklyAllUsage(100, new Date(EXH_NOW - 1000).toISOString()),
		);
		expect(status.routable).toBe(1);
		expect(status.usage_exhausted).toBe(0);
	});

	it("does not double-count: a paused exhausted account is paused, not usage_exhausted", () => {
		const accounts = [
			{ name: "paused-exh", paused: true, rate_limited_until: null },
		] as unknown as Account[];
		const status = computePoolStatus(accounts, EXH_NOW, () =>
			weeklyAllUsage(100, EXH_FUTURE_ISO),
		);
		expect(status.paused).toBe(1);
		expect(status.usage_exhausted).toBe(0);
		expect(status.routable).toBe(0);
	});

	it("flags an account whose seven_day_oauth_apps is spent even when seven_day < 100", () => {
		const accounts = [
			{ name: "oauth-exhausted", paused: false, rate_limited_until: null },
		] as unknown as Account[];
		const status = computePoolStatus(accounts, EXH_NOW, () =>
			oauthAppsUsage(100, EXH_FUTURE_ISO, 50),
		);
		expect(status.routable).toBe(0);
		expect(status.usage_exhausted).toBe(1);
		expect(status.next_available_at).toBe(EXH_FUTURE_ISO);
	});

	it("does not flag a spent seven_day_oauth_apps whose reset is already past (stale)", () => {
		const accounts = [
			{ name: "oauth-stale", paused: false, rate_limited_until: null },
		] as unknown as Account[];
		const status = computePoolStatus(accounts, EXH_NOW, () =>
			oauthAppsUsage(100, new Date(EXH_NOW - 1000).toISOString(), 50),
		);
		expect(status.routable).toBe(1);
		expect(status.usage_exhausted).toBe(0);
	});
});

describe("computeHealthStatus three-state logic", () => {
	it("returns ok when runtime healthy and routable accounts exist", async () => {
		const { computeHealthStatus } = await import("../health");
		const pool = {
			configured: 3,
			paused: 1,
			rate_limited: 0,
			routable: 2,
			next_available_at: null,
		};

		const status = computeHealthStatus(true, pool);
		expect(status).toBe("ok");
	});

	it("returns degraded when routable is 0 but next_available_at is set", async () => {
		const { computeHealthStatus } = await import("../health");
		const pool = {
			configured: 2,
			paused: 0,
			rate_limited: 2,
			routable: 0,
			next_available_at: new Date(Date.now() + 3600000).toISOString(),
		};

		const status = computeHealthStatus(true, pool);
		expect(status).toBe("degraded");
	});

	it("returns unhealthy when runtime is broken", async () => {
		const { computeHealthStatus } = await import("../health");
		const pool = {
			configured: 3,
			paused: 0,
			rate_limited: 0,
			routable: 3,
			next_available_at: null,
		};

		const status = computeHealthStatus(false, pool);
		expect(status).toBe("unhealthy");
	});

	it("returns unhealthy when configured is 0", async () => {
		const { computeHealthStatus } = await import("../health");
		const pool = {
			configured: 0,
			paused: 0,
			rate_limited: 0,
			routable: 0,
			next_available_at: null,
		};

		const status = computeHealthStatus(true, pool);
		expect(status).toBe("unhealthy");
	});

	it("returns unhealthy when routable is 0 with no recovery time", async () => {
		const { computeHealthStatus } = await import("../health");
		const pool = {
			configured: 2,
			paused: 2,
			rate_limited: 0,
			routable: 0,
			next_available_at: null,
		};

		const status = computeHealthStatus(true, pool);
		expect(status).toBe("unhealthy");
	});
});

describe("HTTP status codes", () => {
	it("returns 200 when status is ok", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: false, rate_limited_until: null },
			],
		} as unknown as import("@clankermux/database").DatabaseOperations;
		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;
		const response = await createHealthHandler(
			db,
			config,
		)(new URL("http://localhost/health"));
		expect(response.status).toBe(200);
	});

	it("returns 503 when degraded (no routable, has recovery time)", async () => {
		const db = {
			getAllAccounts: async () => [
				{
					name: "acc1",
					paused: false,
					rate_limited_until: Date.now() + 3600000,
				},
			],
		} as unknown as import("@clankermux/database").DatabaseOperations;
		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;
		const response = await createHealthHandler(
			db,
			config,
		)(new URL("http://localhost/health"));
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.status).toBe("degraded");
		expect(response.status).toBe(503);
	});

	it("returns 503 when unhealthy", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: true, rate_limited_until: null },
			],
		} as unknown as import("@clankermux/database").DatabaseOperations;
		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;
		const response = await createHealthHandler(
			db,
			config,
		)(new URL("http://localhost/health"));
		expect(response.status).toBe(503);
	});

	it("returns 200 when some accounts rate-limited but routable accounts exist", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "available", paused: false, rate_limited_until: null },
				{
					name: "limited",
					paused: false,
					rate_limited_until: Date.now() + 3600000,
				},
			],
		} as unknown as import("@clankermux/database").DatabaseOperations;
		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;
		const response = await createHealthHandler(
			db,
			config,
		)(new URL("http://localhost/health"));
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(response.status).toBe(200);
	});
});

describe("?detail=1 parameter", () => {
	it("includes accounts_detail array when detail=1", async () => {
		const db = {
			getAllAccounts: async () => [
				{
					name: "acc1",
					paused: false,
					rate_limited_until: null,
					rate_limited_reason: null,
					rate_limited_at: null,
				},
				{
					name: "acc2",
					paused: true,
					rate_limited_until: null,
					rate_limited_reason: null,
					rate_limited_at: null,
				},
				{
					name: "acc3",
					paused: false,
					rate_limited_until: Date.now() + 3600000,
					rate_limited_reason: "upstream_429_with_reset",
					rate_limited_at: Date.now() - 60000,
				},
			],
		} as unknown as import("@clankermux/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;

		const handler = createHealthHandler(db, config);
		const url = new URL("http://localhost/health?detail=1");
		const response = await handler(url);
		const body = (await response.json()) as HealthTestBody;

		expect(body.accounts_detail).toBeDefined();
		expect(body.accounts_detail).toHaveLength(3);
		expect(body.accounts_detail[0]).toEqual({
			name: "acc1",
			status: "available",
			rate_limited_until: null,
			rate_limited_reason: null,
			rate_limited_at: null,
		});
		expect(body.accounts_detail[1]).toEqual({
			name: "acc2",
			status: "paused",
			rate_limited_until: null,
			rate_limited_reason: null,
			rate_limited_at: null,
		});
		expect(body.accounts_detail[2]).toEqual({
			name: "acc3",
			status: "rate_limited",
			rate_limited_until: expect.any(Number),
			rate_limited_reason: "upstream_429_with_reset",
			rate_limited_at: expect.any(Number),
		});
	});

	it("omits accounts_detail when detail parameter absent", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: false, rate_limited_until: null },
			],
		} as unknown as import("@clankermux/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;

		const handler = createHealthHandler(db, config);
		const url = new URL("http://localhost/health");
		const response = await handler(url);
		const body = (await response.json()) as Record<string, unknown>;

		expect(body).not.toHaveProperty("accounts_detail");
	});

	it("marks a 100%-weekly account as usage_exhausted in accounts_detail", async () => {
		const id = "health-exh-acct-1";
		// The handler uses real Date.now(), so the reset must be genuinely future.
		const futureIso = new Date(Date.now() + 3_600_000).toISOString();
		usageCache.set(id, weeklyAllUsage(100, futureIso));
		try {
			const db = {
				getAllAccounts: async () => [
					{
						id,
						name: "exhausted",
						provider: "anthropic",
						paused: false,
						rate_limited_until: null,
						rate_limited_reason: null,
						rate_limited_at: null,
					},
				],
			} as unknown as import("@clankermux/database").DatabaseOperations;
			const config = {
				getStrategy: () => "session",
			} as unknown as import("@clankermux/config").Config;

			const handler = createHealthHandler(db, config);
			const response = await handler(
				new URL("http://localhost/health?detail=1"),
			);
			const body = (await response.json()) as HealthTestBody;

			expect(body.accounts_detail).toBeDefined();
			expect(body.accounts_detail?.[0]?.status).toBe("usage_exhausted");
			expect(typeof body.accounts_detail?.[0]?.usage_exhausted_until).toBe(
				"number",
			);
		} finally {
			usageCache.delete(id);
		}
	});

	it("marks an account with a spent seven_day_oauth_apps as usage_exhausted in accounts_detail", async () => {
		const id = "health-oauth-acct-1";
		const futureIso = new Date(Date.now() + 3_600_000).toISOString();
		usageCache.set(id, {
			five_hour: { utilization: 10, resets_at: futureIso },
			seven_day: { utilization: 50, resets_at: futureIso },
			seven_day_oauth_apps: { utilization: 100, resets_at: futureIso },
		} as AnthropicUsageData);
		try {
			const db = {
				getAllAccounts: async () => [
					{
						id,
						name: "oauth-exhausted",
						provider: "anthropic",
						paused: false,
						rate_limited_until: null,
						rate_limited_reason: null,
						rate_limited_at: null,
					},
				],
			} as unknown as import("@clankermux/database").DatabaseOperations;
			const config = {
				getStrategy: () => "session",
			} as unknown as import("@clankermux/config").Config;

			const handler = createHealthHandler(db, config);
			const response = await handler(
				new URL("http://localhost/health?detail=1"),
			);
			const body = (await response.json()) as HealthTestBody;

			expect(body.accounts_detail?.[0]?.status).toBe("usage_exhausted");
			expect(typeof body.accounts_detail?.[0]?.usage_exhausted_until).toBe(
				"number",
			);
		} finally {
			usageCache.delete(id);
		}
	});

	it("keeps a scoped-only exhausted account available but lists the scoped family", async () => {
		const id = "health-scoped-acct-1";
		const futureIso = new Date(Date.now() + 3_600_000).toISOString();
		usageCache.set(id, {
			limits: [
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 100,
					resets_at: futureIso,
					scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
					is_active: true,
				},
			],
		} as AnthropicUsageData);
		try {
			const db = {
				getAllAccounts: async () => [
					{
						id,
						name: "scoped",
						provider: "anthropic",
						paused: false,
						rate_limited_until: null,
						rate_limited_reason: null,
						rate_limited_at: null,
					},
				],
			} as unknown as import("@clankermux/database").DatabaseOperations;
			const config = {
				getStrategy: () => "session",
			} as unknown as import("@clankermux/config").Config;

			const handler = createHealthHandler(db, config);
			const response = await handler(
				new URL("http://localhost/health?detail=1"),
			);
			const body = (await response.json()) as HealthTestBody;

			expect(body.accounts_detail?.[0]?.status).toBe("available");
			expect(body.accounts_detail?.[0]?.usage_exhausted_families).toEqual([
				"fable",
			]);
		} finally {
			usageCache.delete(id);
		}
	});

	it("shows available status for accounts with expired rate limits", async () => {
		const db = {
			getAllAccounts: async () => [
				{
					name: "expired",
					paused: false,
					rate_limited_until: Date.now() - 1000,
				},
			],
		} as unknown as import("@clankermux/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;

		const handler = createHealthHandler(db, config);
		const url = new URL("http://localhost/health?detail=1");
		const response = await handler(url);
		const body = (await response.json()) as HealthTestBody;

		expect(body.accounts_detail[0].status).toBe("available");
		expect(body.accounts_detail[0].rate_limited_until).toBeNull();
	});
});

describe("cache isolation between detail and non-detail", () => {
	it("does not serve cached detail response to non-detail request", async () => {
		let callCount = 0;
		const db = {
			getAllAccounts: async () => {
				callCount++;
				return [
					{ name: `acc-${callCount}`, paused: false, rate_limited_until: null },
				];
			},
		} as unknown as import("@clankermux/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;

		const handler = createHealthHandler(db, config);

		// First request with detail=1
		const detailResp = await handler(
			new URL("http://localhost/health?detail=1"),
		);
		const detailBody = (await detailResp.json()) as HealthTestBody;
		expect(detailBody.accounts_detail).toBeDefined();
		expect(detailBody.accounts_detail[0].name).toBe("acc-1");
		expect(callCount).toBe(1);

		// Second request without detail — should NOT hit the detail cache
		const normalResp = await handler(new URL("http://localhost/health"));
		const normalBody = (await normalResp.json()) as Record<string, unknown>;
		expect(normalBody).not.toHaveProperty("accounts_detail");
		expect(callCount).toBe(2);
	});

	it("does not serve cached non-detail response to detail request", async () => {
		let callCount = 0;
		const db = {
			getAllAccounts: async () => {
				callCount++;
				return [
					{ name: `acc-${callCount}`, paused: false, rate_limited_until: null },
				];
			},
		} as unknown as import("@clankermux/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;

		const handler = createHealthHandler(db, config);

		// First request without detail
		const normalResp = await handler(new URL("http://localhost/health"));
		const normalBody = (await normalResp.json()) as Record<string, unknown>;
		expect(normalBody).not.toHaveProperty("accounts_detail");
		expect(callCount).toBe(1);

		// Second request with detail=1 — should NOT hit the non-detail cache
		const detailResp = await handler(
			new URL("http://localhost/health?detail=1"),
		);
		const detailBody = (await detailResp.json()) as HealthTestBody;
		expect(detailBody.accounts_detail).toBeDefined();
		expect(callCount).toBe(2);
	});

	it("caches same-mode repeated requests (hits cache, no extra DB call)", async () => {
		let callCount = 0;
		const db = {
			getAllAccounts: async () => {
				callCount++;
				return [
					{ name: `acc-${callCount}`, paused: false, rate_limited_until: null },
				];
			},
		} as unknown as import("@clankermux/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@clankermux/config").Config;

		const handler = createHealthHandler(db, config);

		const resp1 = await handler(new URL("http://localhost/health"));
		const body1 = (await resp1.json()) as HealthTestBody;
		expect(body1.accounts_detail).toBeUndefined();
		expect(callCount).toBe(1);

		// Repeated non-detail request — should hit cache
		const resp2 = await handler(new URL("http://localhost/health"));
		const body2 = (await resp2.json()) as HealthTestBody;
		expect(body2.accounts_detail).toBeUndefined();
		expect(callCount).toBe(1); // no extra DB call
	});
});
