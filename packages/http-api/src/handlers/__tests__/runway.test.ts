import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { RUNWAY_HORIZON_MS } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { type AnyUsageData, usageCache } from "@clankermux/providers";
import type {
	Account,
	ApiKey,
	RunwayResponse,
	UsageSnapshotSample,
} from "@clankermux/types";
import { createRunwayHandler } from "../runway";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BASE = 1_700_000_000_000;

function makeAccount(partial: Partial<Account>): Account {
	return {
		id: "acc-1",
		name: "Account 1",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: BASE,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		codex_auto_apply_reset_on_weekly_limit_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		notes: null,
		refresh_token_issued_at: null,
		refresh_token_expires_at: null,
		renewal_anchor: null,
		renewal_cadence: null,
		renewal_price_usd_micros: null,
		renewal_auto_start_date: null,
		...partial,
	} as Account;
}

function makeKey(partial: Partial<ApiKey>): ApiKey {
	return {
		id: "k1",
		name: "prod",
		hashedKey: "sha256$deadbeef",
		prefixLast8: "abcdefgh",
		createdAt: BASE,
		lastUsed: null,
		usageCount: 0,
		isActive: true,
		pinnedAccountId: null,
		pinnedProviders: null,
		...partial,
	};
}

/**
 * The handler calls `getAllAccounts()` and (through `listApiKeys`)
 * `getApiKeys()` directly — NOT `getAdapter().query`, so a SQL-substring
 * fixture would hand it nothing at all.
 */
function makeDbOps(options: {
	accounts?: Account[];
	keys?: ApiKey[];
	snapshots?: UsageSnapshotSample[];
	snapshotsThrow?: boolean;
}): DatabaseOperations {
	return {
		getAllAccounts: async () => options.accounts ?? [],
		getApiKeys: async () => options.keys ?? [],
		getRecentUsageSnapshotsForAccounts: async (accountIds: string[]) => {
			if (options.snapshotsThrow) throw new Error("snapshot read failed");
			return (options.snapshots ?? []).filter((s) =>
				accountIds.includes(s.accountId),
			);
		},
	} as unknown as DatabaseOperations;
}

/** Anthropic-shaped payload with both account-wide windows. */
function usage(
	fivePct: number,
	fiveResetMs: number,
	sevenPct: number,
	sevenResetMs: number,
): AnyUsageData {
	return {
		five_hour: {
			utilization: fivePct,
			resets_at: new Date(fiveResetMs).toISOString(),
		},
		seven_day: {
			utilization: sevenPct,
			resets_at: new Date(sevenResetMs).toISOString(),
		},
	} as unknown as AnyUsageData;
}

const HEALTHY = () => usage(10, BASE + 4 * HOUR_MS, 5, BASE + 6 * DAY_MS);
const SPENT = () => usage(100, BASE + 2 * HOUR_MS, 20, BASE + 6 * DAY_MS);

const SEEDED_IDS = [
	"acc-1",
	"acc-2",
	"anthropic-1",
	"codex-1",
	"local-1",
	"aged-1",
	"fresh-1",
];

async function runway(dbOps: DatabaseOperations): Promise<RunwayResponse> {
	const response = await createRunwayHandler(dbOps)();
	expect(response.status).toBe(200);
	return (await response.json()) as RunwayResponse;
}

describe("GET /api/runway", () => {
	let nowSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		nowSpy = spyOn(Date, "now").mockReturnValue(BASE);
		for (const id of SEEDED_IDS) usageCache.delete(id);
	});

	afterEach(() => {
		for (const id of SEEDED_IDS) usageCache.delete(id);
		nowSpy.mockRestore();
	});

	it("scopes a provider-pinned key to that provider's accounts", async () => {
		usageCache.set("codex-1", SPENT());
		usageCache.set("anthropic-1", HEALTHY());

		const body = await runway(
			makeDbOps({
				accounts: [
					makeAccount({ id: "codex-1", name: "Codex", provider: "codex" }),
					makeAccount({ id: "anthropic-1", name: "Claude" }),
				],
				keys: [
					makeKey({ id: "k1", name: "codex-only", pinnedProviders: ["codex"] }),
				],
			}),
		);

		expect(body.keys).toHaveLength(1);
		expect(body.keys[0].eligibleAccountIds).toEqual(["codex-1"]);
		expect(body.keys[0].pin).toEqual({
			accountId: null,
			providers: ["codex"],
		});
		expect(body.keys[0].outcome.kind).toBe("out-now");
		expect(body.worstKeyId).toBe("k1");
		// The account block covers the whole pool, pinned or not, so a client can
		// resolve any cause id it is handed.
		expect(body.accounts.map((a) => a.id)).toEqual(["codex-1", "anthropic-1"]);
	});

	it("gives an unpinned key every account", async () => {
		usageCache.set("codex-1", SPENT());
		usageCache.set("anthropic-1", HEALTHY());

		const body = await runway(
			makeDbOps({
				accounts: [
					makeAccount({ id: "codex-1", name: "Codex", provider: "codex" }),
					makeAccount({ id: "anthropic-1", name: "Claude" }),
				],
				keys: [makeKey({ id: "k1", name: "open" })],
			}),
		);

		expect(body.keys[0].eligibleAccountIds).toEqual(["codex-1", "anthropic-1"]);
		// One account is spent, the other is not, so the pool has capacity.
		expect(body.keys[0].outcome.kind).toBe("beyond-horizon");
		expect(body.horizonMs).toBe(RUNWAY_HORIZON_MS);
		expect(body.generatedAt).toBe(BASE);
	});

	it("emits exactly one synthetic row when no key is active", async () => {
		usageCache.set("acc-1", HEALTHY());

		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "acc-1" })],
				keys: [
					makeKey({ id: "k1", name: "retired", isActive: false }),
					makeKey({ id: "k2", name: "also retired", isActive: false }),
				],
			}),
		);

		expect(body.keys).toHaveLength(1);
		expect(body.keys[0].keyId).toBeNull();
		expect(body.keys[0].isActive).toBe(true);
		// The worst row is the synthetic one, which has no key id to name.
		expect(body.worstKeyId).toBeNull();
	});

	it("serves the response with prediction null when the snapshot query fails", async () => {
		usageCache.set("acc-1", HEALTHY());

		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "acc-1" })],
				keys: [makeKey({ id: "k1" })],
				snapshotsThrow: true,
			}),
		);

		expect(body.accounts[0].windows.map((w) => w.prediction)).toEqual([
			null,
			null,
		]);
		// The utilization itself is unaffected — only the regression is missing.
		expect(body.accounts[0].windows[0].utilizationPct).toBe(10);
	});

	it("serves a prediction only once a trend has been established", async () => {
		const reset = BASE + 3 * HOUR_MS;
		usageCache.set("acc-1", usage(60, reset, 20, reset));
		usageCache.set("acc-2", usage(60, reset, 20, reset));

		const body = await runway(
			makeDbOps({
				accounts: [
					makeAccount({ id: "acc-1", name: "Rising" }),
					makeAccount({ id: "acc-2", name: "No history" }),
				],
				keys: [makeKey({ id: "k1" })],
				snapshots: [3, 2, 1].map((hoursAgo, index) => ({
					accountId: "acc-1",
					provider: "anthropic",
					sampledAt: BASE - hoursAgo * HOUR_MS,
					fiveHourPct: 10 * (index + 1),
					fiveHourReset: reset,
					sevenDayPct: 20,
					sevenDayReset: reset,
				})),
			}),
		);

		const rising = body.accounts.find((a) => a.id === "acc-1");
		const bare = body.accounts.find((a) => a.id === "acc-2");
		expect(
			rising?.windows.find((w) => w.kind === "five_hour")?.prediction?.state,
		).toBe("rising");
		// A single point is `insufficient_data`, whose slopePerHour is a
		// placeholder 0 — served as null rather than as a measured zero slope.
		expect(bare?.windows.find((w) => w.kind === "five_hour")?.prediction).toBe(
			null,
		);
	});

	it("reports no as-of time when the utilization it would describe is null", async () => {
		// A cached payload with no readable window: the sample time is real, but
		// there is no value for it to be "as of".
		usageCache.set("acc-1", {
			credits: { balance: 5 },
		} as unknown as AnyUsageData);

		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "acc-1" })],
				keys: [makeKey({ id: "k1" })],
			}),
		);

		expect(body.accounts[0].usageAsOfMs).toBeNull();
		expect(body.accounts[0].windows.map((w) => w.utilizationPct)).toEqual([
			null,
			null,
		]);
		expect(body.accounts[0].metered).toBe(true);
	});

	it("stamps the as-of time from the cache entry, not the handler clock", async () => {
		usageCache.set("acc-1", HEALTHY()); // written at BASE
		nowSpy.mockReturnValue(BASE + 5 * MINUTE_MS);

		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "acc-1" })],
				keys: [makeKey({ id: "k1" })],
			}),
		);

		expect(body.accounts[0].usageAsOfMs).toBe(BASE);
		expect(body.generatedAt).toBe(BASE + 5 * MINUTE_MS);
	});

	it("marks a provider with no account-wide window as unmetered", async () => {
		const body = await runway(
			makeDbOps({
				accounts: [
					makeAccount({ id: "local-1", name: "local", provider: "ollama" }),
				],
				keys: [makeKey({ id: "k1" })],
			}),
		);

		expect(body.accounts[0].metered).toBe(false);
		expect(body.accounts[0].windows).toEqual([]);
		expect(body.accounts[0].usageAsOfMs).toBeNull();
		// Unmetered is positively in quota, NOT unknown.
		expect(body.keys[0].outcome.kind).toBe("beyond-horizon");
	});

	it("emits every window the provider supports, and only those", async () => {
		usageCache.set("acc-1", {
			tokens_limit: { percentage: 40, resetAt: BASE + HOUR_MS },
		} as unknown as AnyUsageData);

		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "acc-1", provider: "zai" })],
				keys: [makeKey({ id: "k1" })],
			}),
		);

		// Zai has a token window but no weekly one, so the absent weekly window
		// means "no such window", never "unread".
		expect(body.accounts[0].windows.map((w) => w.kind)).toEqual(["five_hour"]);
		expect(body.accounts[0].windows[0].utilizationPct).toBe(40);
		expect(body.accounts[0].metered).toBe(true);
	});
});

/**
 * The response reads the usage cache through BOTH documented views. The runway
 * scan and the predictions DERIVE a value modelling "now", so they take the
 * ROUTING-fresh view (10 min); the reported `accounts[]` evidence is an
 * OBSERVATION, so it takes the display view (30 min) with its age. These cases
 * pin both boundaries, and the fact that they cannot contradict each other.
 */
describe("GET /api/runway usage freshness", () => {
	let nowSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		nowSpy = spyOn(Date, "now").mockReturnValue(BASE);
		for (const id of SEEDED_IDS) usageCache.delete(id);
	});

	afterEach(() => {
		for (const id of SEEDED_IDS) usageCache.delete(id);
		nowSpy.mockRestore();
	});

	it("reports a reading past the routing TTL but shows no projection for it", async () => {
		usageCache.set("aged-1", SPENT()); // stamped at BASE
		// 15 minutes on: past the 10-min routing TTL, inside the 30-min UI horizon.
		nowSpy.mockReturnValue(BASE + 15 * MINUTE_MS);

		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "aged-1", name: "Aged" })],
				keys: [makeKey({ id: "k1" })],
			}),
		);

		// The evidence block is an observation with an age: the cache is still
		// willing to show it, so a widget on this endpoint sees what /api/accounts
		// shows, labelled with when it was taken.
		expect(body.accounts[0].windows.map((w) => w.utilizationPct)).toEqual([
			100, 20,
		]);
		expect(body.accounts[0].usageAsOfMs).toBe(BASE);
		expect(body.generatedAt).toBe(BASE + 15 * MINUTE_MS);
		// Nothing DERIVED comes off it: no prediction, and the scan cannot see the
		// account at all, so the key's outcome is unknown rather than "out now".
		expect(body.accounts[0].windows.map((w) => w.prediction)).toEqual([
			null,
			null,
		]);
		expect(body.keys[0].outcome).toEqual({ kind: "unknown" });
	});

	it("reports nothing at all once the reading is past the display horizon", async () => {
		usageCache.set("aged-1", SPENT()); // stamped at BASE
		// 31 minutes on: `peekWithAge` stops serving it, so there is no observation
		// left to report either.
		nowSpy.mockReturnValue(BASE + 31 * MINUTE_MS);

		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "aged-1", name: "Aged" })],
				keys: [makeKey({ id: "k1" })],
			}),
		);

		// Not "0% used" and not "out of quota" — unknown.
		expect(body.accounts[0].windows.map((w) => w.utilizationPct)).toEqual([
			null,
			null,
		]);
		expect(body.accounts[0].usageAsOfMs).toBeNull();
		expect(body.keys[0].outcome).toEqual({ kind: "unknown" });
	});

	it("keeps the still-fresh accounts speaking when only some have aged out", async () => {
		usageCache.set("aged-1", HEALTHY()); // stamped at BASE
		nowSpy.mockReturnValue(BASE + 15 * MINUTE_MS);
		usageCache.set("fresh-1", SPENT()); // stamped 15 min later

		const body = await runway(
			makeDbOps({
				accounts: [
					makeAccount({ id: "aged-1", name: "Aged" }),
					makeAccount({ id: "fresh-1", name: "Fresh" }),
				],
				keys: [makeKey({ id: "k1" })],
			}),
		);

		// The aged account is excluded from the pool, which can only SHORTEN the
		// runway — so the result is a documented lower bound, not a fabricated
		// zero, and it names the account it could not see.
		expect(body.keys[0].outcome.kind).toBe("out-now");
		if (body.keys[0].outcome.kind !== "out-now") throw new Error("unreachable");
		expect(body.keys[0].outcome.unprojectableAccountIds).toEqual(["aged-1"]);
		expect(body.keys[0].outcome.causes).toEqual([
			{ accountId: "fresh-1", windowKind: "five_hour" },
		]);
	});

	it("reads a reading inside the routing TTL", async () => {
		usageCache.set("fresh-1", SPENT()); // stamped at BASE
		nowSpy.mockReturnValue(BASE + 9 * MINUTE_MS);

		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "fresh-1", name: "Fresh" })],
				keys: [makeKey({ id: "k1" })],
			}),
		);

		expect(body.accounts[0].windows[0].utilizationPct).toBe(100);
		expect(body.accounts[0].usageAsOfMs).toBe(BASE);
		expect(body.keys[0].outcome.kind).toBe("out-now");
	});

	it("does not resurrect a Codex reading the cache no longer holds", async () => {
		// /api/accounts can fall back to a DB-restored payload for display. The
		// runway deliberately does not: an unrestored account is unknown, and the
		// key's outcome says so rather than reporting a stale figure as current.
		const body = await runway(
			makeDbOps({
				accounts: [
					makeAccount({ id: "codex-1", name: "Codex", provider: "codex" }),
				],
				keys: [makeKey({ id: "k1" })],
			}),
		);

		expect(body.accounts[0].windows.map((w) => w.utilizationPct)).toEqual([
			null,
			null,
		]);
		expect(body.accounts[0].usageAsOfMs).toBeNull();
		expect(body.keys[0].outcome).toEqual({ kind: "unknown" });
	});
});
