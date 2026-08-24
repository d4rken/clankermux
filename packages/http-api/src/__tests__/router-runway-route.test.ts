import { afterEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { BunSqlAdapter, DatabaseOperations } from "@clankermux/database";
import {
	codexRateLimitResetCreditsCache,
	usageCache,
} from "@clankermux/providers";
import {
	clearUsageRevisionAnchors,
	observeUsageReading,
} from "@clankermux/proxy";
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
		clearUsageRevisionAnchors(ACCOUNT_ID);
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

	it("models banked reset credits end-to-end and discloses the assumption", async () => {
		const now = Date.now();
		const HOUR = 60 * 60 * 1000;
		const sevenReset = now + 2 * 24 * HOUR;

		// Codex account, weekly window spent, auto-apply-on-weekly-limit enabled,
		// one available credit in a fresh cache reading.
		const codexContext = makeContext();
		(
			codexContext.dbOps as unknown as {
				getAllAccounts: () => Promise<unknown[]>;
			}
		).getAllAccounts = async () => [
			{
				id: ACCOUNT_ID,
				name: "Router account",
				provider: "codex",
				codex_auto_apply_reset_credits_enabled: false,
				codex_auto_apply_reset_on_weekly_limit_enabled: true,
			},
		];
		usageCache.set(ACCOUNT_ID, {
			five_hour: null,
			seven_day: {
				utilization: 100,
				resets_at: new Date(sevenReset).toISOString(),
			},
		} as never);
		codexRateLimitResetCreditsCache.set(
			ACCOUNT_ID,
			{
				availableCount: 1,
				credits: [
					{
						id: "credit-1",
						resetType: "usage",
						status: "available",
						grantedAt: Math.floor(now / 1000) - 3600,
						expiresAt: null,
						title: null,
						description: null,
					},
				],
			} as never,
			now,
		);

		try {
			const router = new APIRouter(codexContext);
			const url = new URL("http://localhost/api/runway");
			const response = await router.handleRequest(
				url,
				new Request(url, { method: "GET" }),
			);
			const body = (await response?.json()) as RunwayResponse;

			const key = body.keys[0];
			// Without the credit this pool is out now; the modeled redemption
			// revives it and the outcome discloses the assumption.
			expect(key.outcome.kind).toBe("beyond-horizon");
			if (key.outcome.kind === "beyond-horizon") {
				expect(key.outcome.assumedResetCredits).toEqual([
					{ accountId: ACCOUNT_ID, count: 1 },
				]);
			}
		} finally {
			codexRateLimitResetCreditsCache.delete(ACCOUNT_ID);
		}
	});

	it("pads a capped detail list up to the authoritative availableCount", async () => {
		const now = Date.now();
		const HOUR = 60 * 60 * 1000;
		const sevenReset = now + 2 * 24 * HOUR;

		const codexContext = makeContext();
		(
			codexContext.dbOps as unknown as {
				getAllAccounts: () => Promise<unknown[]>;
			}
		).getAllAccounts = async () => [
			{
				id: ACCOUNT_ID,
				name: "Router account",
				provider: "codex",
				codex_auto_apply_reset_credits_enabled: false,
				codex_auto_apply_reset_on_weekly_limit_enabled: true,
			},
		];
		usageCache.set(ACCOUNT_ID, {
			five_hour: null,
			seven_day: {
				utilization: 100,
				resets_at: new Date(sevenReset).toISOString(),
			},
		} as never);
		// availableCount says 2, but the detail list carries only ONE row — and
		// that one already expired, so it cannot cover the exhaustion at `now`.
		// Only the padded synthetic credit (unknown expiry) can revive the
		// window; modeling the list alone would report the pool out now.
		codexRateLimitResetCreditsCache.set(
			ACCOUNT_ID,
			{
				availableCount: 2,
				credits: [
					{
						id: "credit-exp",
						resetType: "usage",
						status: "available",
						grantedAt: Math.floor(now / 1000) - 7200,
						expiresAt: Math.floor(now / 1000) - 3600,
						title: null,
						description: null,
					},
				],
			} as never,
			now,
		);

		try {
			const router = new APIRouter(codexContext);
			const url = new URL("http://localhost/api/runway");
			const response = await router.handleRequest(
				url,
				new Request(url, { method: "GET" }),
			);
			const body = (await response?.json()) as RunwayResponse;

			const key = body.keys[0];
			expect(key.outcome.kind).toBe("beyond-horizon");
			if (key.outcome.kind === "beyond-horizon") {
				expect(key.outcome.assumedResetCredits).toEqual([
					{ accountId: ACCOUNT_ID, count: 1 },
				]);
			}
		} finally {
			codexRateLimitResetCreditsCache.delete(ACCOUNT_ID);
		}
	});

	it("trusts availableCount 0 over a listed available row", async () => {
		const now = Date.now();
		const HOUR = 60 * 60 * 1000;
		const sevenReset = now + 2 * 24 * HOUR;

		const codexContext = makeContext();
		(
			codexContext.dbOps as unknown as {
				getAllAccounts: () => Promise<unknown[]>;
			}
		).getAllAccounts = async () => [
			{
				id: ACCOUNT_ID,
				name: "Router account",
				provider: "codex",
				codex_auto_apply_reset_credits_enabled: false,
				codex_auto_apply_reset_on_weekly_limit_enabled: true,
			},
		];
		usageCache.set(ACCOUNT_ID, {
			five_hour: null,
			seven_day: {
				utilization: 100,
				resets_at: new Date(sevenReset).toISOString(),
			},
		} as never);
		// The count is authoritative in BOTH directions: a stray listed row must
		// not conjure a bank the provider says is empty.
		codexRateLimitResetCreditsCache.set(
			ACCOUNT_ID,
			{
				availableCount: 0,
				credits: [
					{
						id: "phantom",
						resetType: "usage",
						status: "available",
						grantedAt: Math.floor(now / 1000) - 3600,
						expiresAt: null,
						title: null,
						description: null,
					},
				],
			} as never,
			now,
		);

		try {
			const router = new APIRouter(codexContext);
			const url = new URL("http://localhost/api/runway");
			const response = await router.handleRequest(
				url,
				new Request(url, { method: "GET" }),
			);
			const body = (await response?.json()) as RunwayResponse;

			expect(body.keys[0].outcome.kind).toBe("out-now");
		} finally {
			codexRateLimitResetCreditsCache.delete(ACCOUNT_ID);
		}
	});

	it("ignores a stale credit-cache reading (no bank, no assumption)", async () => {
		const now = Date.now();
		const HOUR = 60 * 60 * 1000;
		const sevenReset = now + 2 * 24 * HOUR;

		const codexContext = makeContext();
		(
			codexContext.dbOps as unknown as {
				getAllAccounts: () => Promise<unknown[]>;
			}
		).getAllAccounts = async () => [
			{
				id: ACCOUNT_ID,
				name: "Router account",
				provider: "codex",
				codex_auto_apply_reset_credits_enabled: false,
				codex_auto_apply_reset_on_weekly_limit_enabled: true,
			},
		];
		usageCache.set(ACCOUNT_ID, {
			five_hour: null,
			seven_day: {
				utilization: 100,
				resets_at: new Date(sevenReset).toISOString(),
			},
		} as never);
		codexRateLimitResetCreditsCache.set(
			ACCOUNT_ID,
			{ availableCount: 1, credits: null } as never,
			// Fetched 25h ago: past CREDIT_BANK_MAX_AGE_MS, so no bank is modeled.
			now - 25 * HOUR,
		);

		try {
			const router = new APIRouter(codexContext);
			const url = new URL("http://localhost/api/runway");
			const response = await router.handleRequest(
				url,
				new Request(url, { method: "GET" }),
			);
			const body = (await response?.json()) as RunwayResponse;

			expect(body.keys[0].outcome.kind).toBe("out-now");
		} finally {
			codexRateLimitResetCreditsCache.delete(ACCOUNT_ID);
		}
	});

	it("a seeded gift anchor shortens the weekly runway end-to-end", async () => {
		const now = Date.now();
		const HOUR = 60 * 60 * 1000;
		const sevenReset = now + 1.5 * 24 * HOUR;
		const giftAt = now - 12 * HOUR;

		// The registry sees the gift: 60% → 1% with the reset unchanged, then the
		// post-gift burn to 40%. Fed exactly the way the sampler feeds it.
		observeUsageReading(ACCOUNT_ID, "seven_day", {
			pct: 60,
			resetMs: sevenReset,
			observedAtMs: giftAt - 2 * 60_000,
		});
		observeUsageReading(ACCOUNT_ID, "seven_day", {
			pct: 1,
			resetMs: sevenReset,
			observedAtMs: giftAt,
		});

		usageCache.set(ACCOUNT_ID, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(now + 4 * HOUR).toISOString(),
			},
			seven_day: {
				utilization: 40,
				resets_at: new Date(sevenReset).toISOString(),
			},
		});

		const router = new APIRouter(makeContext());
		const url = new URL("http://localhost/api/runway");
		const response = await router.handleRequest(
			url,
			new Request(url, { method: "GET" }),
		);
		const body = (await response?.json()) as RunwayResponse;

		// Structurally, 40% over 5.5 days clears the reset with days to spare —
		// the pre-anchor bug. Anchored at the gift, the true 40%-in-12h pace
		// exhausts ~18h out (< the 36h reset), so the key reports a runway.
		const key = body.keys[0];
		expect(key.outcome.kind).toBe("runway");
		if (key.outcome.kind === "runway") {
			// The ETA is observation-anchored on the CACHE WRITE instant, which the
			// route stamps itself — assert the window, not an exact instant.
			expect(key.outcome.exhaustsAtMs).toBeGreaterThan(now + 17 * HOUR);
			expect(key.outcome.exhaustsAtMs).toBeLessThan(now + 19 * HOUR);
		}
	});
});
