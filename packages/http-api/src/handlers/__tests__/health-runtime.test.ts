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

/**
 * A flat Anthropic payload whose only spent account-wide window is the rolling
 * 5-hour session; the weekly window keeps headroom.
 */
function sessionSpentUsage(
	sessionResetsAt: string | null,
	sessionPercent = 100,
): AnthropicUsageData {
	return {
		five_hour: { utilization: sessionPercent, resets_at: sessionResetsAt },
		seven_day: { utilization: 40, resets_at: EXH_FUTURE_ISO },
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
		const response = await handler();
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

		const response = await handler();
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
		const response = await handler();
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
			payloadInFlightJobs: 0,
			payloadBytesPending: 0,
			payloadReservedBytes: 0,
			payloadInFlightBytes: 0,
			payloadInFlightOriginalBytes: 0,
			oldestMetadataAgeMs: 0,
			oldestPayloadAgeMs: 0,
			metadataDropped: 0,
			payloadDropped: 0,
			payloadDroppedBytes: 0,
			payloadCommitted: 0,
			payloadExpired: 0,
			payloadAbandoned: 0,
			// No payload has been published, so no worker exists yet — an absent
			// writer reports healthy rather than fabricating an unhealthy state.
			payloadWriterHealthy: true,
			payloadWriterSuspended: false,
			payloadWriterFatal: null,
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

	// The 5h session is an ACCOUNT-WIDE window: a spent one sidelines the whole
	// account exactly like a spent weekly, so the pool counters must classify it
	// the same way instead of counting it as routable.
	it("counts a 100%-session account as usage_exhausted and recovers at the 5h reset", () => {
		const sessionReset = new Date(EXH_NOW + 12 * 60_000).toISOString();
		const accounts = [
			{ name: "healthy", paused: false, rate_limited_until: null },
			{ name: "session-exhausted", paused: false, rate_limited_until: null },
		] as unknown as Account[];
		const status = computePoolStatus(accounts, EXH_NOW, (a) =>
			a.name === "session-exhausted" ? sessionSpentUsage(sessionReset) : null,
		);
		expect(status.routable).toBe(1);
		expect(status.usage_exhausted).toBe(1);
		expect(status.rate_limited).toBe(0);
		expect(status.next_available_at).toBe(sessionReset);
	});

	it("does not flag a 100%-session window whose reset is already past (stale)", () => {
		const accounts = [
			{ name: "session-stale", paused: false, rate_limited_until: null },
		] as unknown as Account[];
		const status = computePoolStatus(accounts, EXH_NOW, () =>
			sessionSpentUsage(new Date(EXH_NOW - 1000).toISOString()),
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
		const response = await createHealthHandler(db, config)();
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
		const response = await createHealthHandler(db, config)();
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
		const response = await createHealthHandler(db, config)();
		expect(response.status).toBe(503);
	});

	/**
	 * DELIBERATE, DECLARED behaviour change: a session-exhausted, unlocked,
	 * unpaused account no longer counts as `routable`, so a pool whose only
	 * account is in that state reports `degraded` → HTTP 503 where it previously
	 * reported `ok` → 200. This is not a new contract (a weekly-exhausted pool
	 * already behaves exactly this way, and a LOCKED session-exhausted account
	 * already zeroes `routable` via its lock); it only covers the pre-429 window
	 * where the session window is spent but nothing has cooled the account yet.
	 */
	it("returns 503 (degraded) when the only unlocked account is session-exhausted", async () => {
		const id = "health-session-503";
		const sessionReset = new Date(Date.now() + 12 * 60_000).toISOString();
		usageCache.set(id, sessionSpentUsage(sessionReset));
		try {
			const db = {
				getAllAccounts: async () => [
					{
						id,
						name: "session-exhausted",
						provider: "anthropic",
						paused: false,
						rate_limited_until: null,
					},
				],
			} as unknown as import("@clankermux/database").DatabaseOperations;
			const config = {
				getStrategy: () => "session",
			} as unknown as import("@clankermux/config").Config;
			const response = await createHealthHandler(db, config)();
			const body = (await response.json()) as HealthTestBody;

			expect(body.status).toBe("degraded");
			expect(response.status).toBe(503);
			// It recovers at the 5h reset rather than being reported as dead.
			expect(
				(body.pool as { next_available_at: string | null }).next_available_at,
			).toBe(sessionReset);
		} finally {
			usageCache.delete(id);
		}
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
		const response = await createHealthHandler(db, config)();
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(response.status).toBe(200);
	});
});

describe("terseness", () => {
	/**
	 * The reason `?detail=1` is gone: this endpoint is unauthenticated, because
	 * a container health check has to reach it before anything else works, and
	 * the detail view answered it with account names and per-account
	 * availability. Anyone who could reach the port could enumerate the pool.
	 */
	const db = {
		getAllAccounts: async () => [
			{ name: "secret-account-name", paused: false, rate_limited_until: null },
			{ name: "another-one", paused: true, rate_limited_until: null },
		],
	} as unknown as import("@clankermux/database").DatabaseOperations;
	const config = {
		getStrategy: () => "session",
	} as unknown as import("@clankermux/config").Config;

	it("never discloses an account name", async () => {
		const response = await createHealthHandler(db, config)();
		const text = await response.text();
		expect(text).not.toContain("secret-account-name");
		expect(text).not.toContain("another-one");
	});

	it("carries a rollup and nothing per-account", async () => {
		const response = await createHealthHandler(db, config)();
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("accounts_detail");
		expect(body.accounts).toBe(2);
		expect(body.pool).toMatchObject({ configured: 2, paused: 1 });
	});

	it("ignores a legacy ?detail=1 rather than failing an old caller", async () => {
		// The query string never reaches the handler now, so an old health check
		// still gets a valid answer instead of an error.
		const handler = createHealthHandler(db, config);
		const first = await handler();
		const body = (await first.json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("accounts_detail");
		expect(first.status).toBe(200);
	});

	it("serves one cache for every caller", async () => {
		let calls = 0;
		const counting = {
			getAllAccounts: async () => {
				calls++;
				return [{ name: "a", paused: false, rate_limited_until: null }];
			},
		} as unknown as import("@clankermux/database").DatabaseOperations;
		const handler = createHealthHandler(counting, config);
		await handler();
		await handler();
		// One cache, not one per query-string shape.
		expect(calls).toBe(1);
	});
});
