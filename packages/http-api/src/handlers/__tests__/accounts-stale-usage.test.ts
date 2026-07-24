import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import type { AccountResponse, RankedSnapshot } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface AccountRow {
	id: string;
	name: string;
	provider: string | null;
	request_count: number;
	total_requests: number;
	last_used: number | null;
	created_at: number;
	expires_at: number | null;
	rate_limited_until: number | null;
	rate_limited_reason: string | null;
	rate_limited_at: number | null;
	rate_limit_reset: number | null;
	rate_limit_status: string | null;
	rate_limit_remaining: number | null;
	session_start: number | null;
	session_request_count: number;
	refresh_token: string;
	access_token: string | null;
	paused: 0 | 1;
	priority: number;
	token_valid: 0 | 1;
	rate_limited: 0 | 1;
	session_info: string | null;
	auto_fallback_enabled: 0 | 1;
	auto_refresh_enabled: 0 | 1;
	auto_pause_on_overage_enabled: 0 | 1;
	peak_hours_pause_enabled: 0 | 1;
	custom_endpoint: string | null;
	model_mappings: string | null;
	model_fallbacks: string | null;
	billing_type: string | null;
	pause_reason: string | null;
}

function makeAccountRow(overrides: Partial<AccountRow>): AccountRow {
	return {
		id: "acc-1",
		name: "Account 1",
		provider: "anthropic",
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		expires_at: Date.now() + 60_000,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		session_start: null,
		session_request_count: 0,
		refresh_token: "refresh-token",
		access_token: "access-token",
		paused: 0,
		priority: 0,
		token_valid: 1,
		rate_limited: 0,
		session_info: "-",
		auto_fallback_enabled: 0,
		auto_refresh_enabled: 0,
		auto_pause_on_overage_enabled: 0,
		peak_hours_pause_enabled: 0,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		...overrides,
	};
}

function makeDbOps(
	accounts: AccountRow[],
	latestSnapshots: RankedSnapshot[],
	// Invoked while the handler awaits its first repository call — lets a test
	// advance a mocked clock so wall-time really elapses between the handler's
	// `now` capture and the later usage-cache read.
	onFirstQuery?: () => void,
): DatabaseOperations {
	return {
		getAdapter: () => ({
			query: async (sql: string) => {
				if (sql.includes("FROM accounts")) return accounts;
				return [];
			},
			get: async () => null,
		}),
		getStatsRepository: () => ({
			getSessionStats: async () => {
				onFirstQuery?.();
				return new Map();
			},
			getActiveSessionCountsByAccount: async () => new Map(),
		}),
		getLatestUsageSnapshots: async (ids: string[]) =>
			latestSnapshots.filter((s) => ids.includes(s.accountId)),
		getRecentUsageSnapshotsForAccounts: async () => [],
	} as unknown as DatabaseOperations;
}

const config = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

const throttlingConfig = {
	getUsageThrottlingFiveHourEnabled: () => true,
	getUsageThrottlingWeeklyEnabled: () => true,
} as unknown as Config;

const ACCOUNT_ID = "acc-stale";

function snapshot(overrides: Partial<RankedSnapshot>): RankedSnapshot {
	return {
		accountId: ACCOUNT_ID,
		provider: "anthropic",
		ts: Date.now(),
		fiveHourPct: null,
		fiveHourReset: null,
		sevenDayPct: null,
		sevenDayReset: null,
		...overrides,
	};
}

async function runHandler(
	snapshots: RankedSnapshot[],
): Promise<AccountResponse | undefined> {
	const handler = createAccountsListHandler(
		makeDbOps(
			[
				makeAccountRow({
					id: ACCOUNT_ID,
					name: "Stale",
					provider: "anthropic",
				}),
			],
			snapshots,
		),
		config,
	);
	const response = await handler();
	const body = (await response.json()) as AccountResponse[];
	return body.find((a) => a.id === ACCOUNT_ID);
}

describe("accounts list staleUsage builder", () => {
	// The builder only runs for accounts whose live usage cache is cold, so keep
	// the cache empty for the account under test throughout.
	beforeEach(() => {
		usageCache.delete(ACCOUNT_ID);
	});
	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
	});

	it("carries a fresh 5h-only snapshot (within 4 min) with the weekly window absent", async () => {
		const now = Date.now();
		const acc = await runHandler([
			snapshot({
				ts: now - 1 * MINUTE_MS,
				fiveHourPct: 42,
				fiveHourReset: now + 90 * MINUTE_MS,
				// No weekly data.
			}),
		]);
		expect(acc?.staleUsage?.fiveHour?.utilization).toBe(42);
		expect(acc?.staleUsage?.fiveHour?.resetIso).toBe(
			new Date(now + 90 * MINUTE_MS).toISOString(),
		);
		expect(acc?.staleUsage?.sevenDay).toBeUndefined();
	});

	it("omits the 5h window when the snapshot is older than 4 min but keeps the ungated weekly window", async () => {
		const now = Date.now();
		const acc = await runHandler([
			snapshot({
				ts: now - 5 * MINUTE_MS, // older than 2 * SAMPLE_INTERVAL_MS (~4 min)
				fiveHourPct: 42,
				fiveHourReset: now + 90 * MINUTE_MS,
				sevenDayPct: 85,
				sevenDayReset: now + 3 * DAY_MS,
			}),
		]);
		expect(acc?.staleUsage?.fiveHour).toBeUndefined();
		expect(acc?.staleUsage?.sevenDay?.utilization).toBe(85);
	});

	it("omits the 5h window when its reset is already in the past", async () => {
		const now = Date.now();
		const acc = await runHandler([
			snapshot({
				ts: now - 1 * MINUTE_MS,
				fiveHourPct: 42,
				fiveHourReset: now - 5 * MINUTE_MS, // already rolled
			}),
		]);
		expect(acc?.staleUsage).toBeNull();
	});

	it("drops the whole snapshot when its timestamp is in the future (clock anomaly)", async () => {
		const now = Date.now();
		const acc = await runHandler([
			snapshot({
				ts: now + 5 * MINUTE_MS, // future
				fiveHourPct: 42,
				fiveHourReset: now + 90 * MINUTE_MS,
				sevenDayPct: 85,
				sevenDayReset: now + 3 * DAY_MS,
			}),
		]);
		expect(acc?.staleUsage).toBeNull();
	});

	it("carries both windows when the snapshot is fresh and both are valid", async () => {
		const now = Date.now();
		const acc = await runHandler([
			snapshot({
				ts: now - 1 * MINUTE_MS,
				fiveHourPct: 42,
				fiveHourReset: now + 90 * MINUTE_MS,
				sevenDayPct: 85,
				sevenDayReset: now + 3 * DAY_MS,
			}),
		]);
		expect(acc?.staleUsage?.fiveHour?.utilization).toBe(42);
		expect(acc?.staleUsage?.sevenDay?.utilization).toBe(85);
		expect(acc?.staleUsage?.asOfIso).toBe(
			new Date(now - 1 * MINUTE_MS).toISOString(),
		);
	});
});

/**
 * The accounts list reads live usage NON-evictively and reports the reading's
 * "as of" time, so a reading past the routing TTL still renders as live data
 * (annotated with its age) instead of collapsing into the amber snapshot
 * fallback. Regression for the TTL/poll-cadence collision.
 */
describe("accounts list live usage freshness (usageAsOfIso)", () => {
	const BASE = 1_700_000_000_000;
	let nowSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		nowSpy = spyOn(Date, "now").mockReturnValue(BASE);
		usageCache.delete(ACCOUNT_ID);
	});
	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
		nowSpy.mockRestore();
	});

	const liveUsage = () => ({
		five_hour: {
			utilization: 12,
			resets_at: new Date(BASE + 2 * HOUR_MS).toISOString(),
		},
		seven_day: {
			utilization: 34,
			resets_at: new Date(BASE + 3 * DAY_MS).toISOString(),
		},
	});

	it("serves live usage past the routing TTL with an honest as-of timestamp", async () => {
		usageCache.set(ACCOUNT_ID, liveUsage()); // stamped at BASE
		nowSpy.mockReturnValue(BASE + 11 * MINUTE_MS); // past the 10-min routing TTL

		const acc = await runHandler([
			snapshot({
				ts: BASE,
				sevenDayPct: 99,
				sevenDayReset: BASE + 3 * DAY_MS,
			}),
		]);

		expect(acc?.usageData).not.toBeNull();
		expect(acc?.usageUtilization).toBe(34);
		expect(acc?.usageAsOfIso).toBe(new Date(BASE).toISOString());
		// Live data present → no snapshot fallback (which would paint the amber
		// "Live usage unavailable" banner in the dashboard).
		expect(acc?.staleUsage).toBeNull();
	});

	it("reports the as-of timestamp for a fresh reading too", async () => {
		usageCache.set(ACCOUNT_ID, liveUsage());
		nowSpy.mockReturnValue(BASE + 2 * MINUTE_MS);

		const acc = await runHandler([]);
		expect(acc?.usageAsOfIso).toBe(new Date(BASE).toISOString());
	});

	it("does not evict the cache entry it read", async () => {
		usageCache.set(ACCOUNT_ID, liveUsage());
		nowSpy.mockReturnValue(BASE + 11 * MINUTE_MS);

		await runHandler([]);
		// A second request must still see the same reading (the old evicting get()
		// dropped it on the first read).
		const acc = await runHandler([]);
		expect(acc?.usageData).not.toBeNull();
		expect(acc?.usageAsOfIso).toBe(new Date(BASE).toISOString());
	});

	it("falls back to the persisted snapshot past the UI horizon", async () => {
		usageCache.set(ACCOUNT_ID, liveUsage());
		nowSpy.mockReturnValue(BASE + 31 * MINUTE_MS); // past UI_STALE_HORIZON_MS

		const acc = await runHandler([
			snapshot({
				ts: BASE + 30 * MINUTE_MS,
				sevenDayPct: 85,
				sevenDayReset: BASE + 31 * MINUTE_MS + 3 * DAY_MS,
			}),
		]);

		expect(acc?.usageData).toBeNull();
		expect(acc?.usageAsOfIso).toBeNull();
		expect(acc?.staleUsage?.sevenDay?.utilization).toBe(85);
	});

	it("reports a null as-of timestamp when there is no live reading at all", async () => {
		const acc = await runHandler([
			snapshot({
				ts: BASE - 1 * MINUTE_MS,
				sevenDayPct: 85,
				sevenDayReset: BASE + 3 * DAY_MS,
			}),
		]);
		expect(acc?.usageAsOfIso).toBeNull();
		expect(acc?.staleUsage?.sevenDay?.utilization).toBe(85);
	});

	// The handler captures `now` up front and then awaits several repository
	// calls, so deriving the as-of time as `now - ageMs` reports the reading as
	// older than it is by the handler's own elapsed time. A running clock exposes
	// that; the fixed-clock tests above cannot.
	it("reports the exact sample time even when the handler takes time to run", async () => {
		let clock = BASE;
		nowSpy.mockImplementation(() => clock);
		usageCache.set(ACCOUNT_ID, liveUsage()); // stamped at BASE

		const handler = createAccountsListHandler(
			makeDbOps(
				[makeAccountRow({ id: ACCOUNT_ID, provider: "anthropic" })],
				[],
				// 4s of "DB time" between the handler's `now` and its cache read.
				() => {
					clock += 4_000;
				},
			),
			config,
		);
		const body = (await (await handler()).json()) as AccountResponse[];
		const acc = body.find((a) => a.id === ACCOUNT_ID);

		expect(acc?.usageAsOfIso).toBe(new Date(BASE).toISOString());
	});

	// getCachedOrPersistedCodexUsage() substitutes DB-restored usage when the
	// cached entry cannot be normalized (or drops it entirely). Labelling that
	// result with the live cache entry's sample time would describe data that was
	// never returned.
	it("omits the as-of timestamp when Codex normalization rejects the cached entry", async () => {
		// Both windows lack a reset time and there are no scoped limits, so
		// normalizeCodexUsageData returns null → the persisted path takes over.
		usageCache.set(ACCOUNT_ID, {
			five_hour: null,
			seven_day: { utilization: 50, resets_at: null },
		});
		nowSpy.mockReturnValue(BASE + 2 * MINUTE_MS);

		const handler = createAccountsListHandler(
			makeDbOps([makeAccountRow({ id: ACCOUNT_ID, provider: "codex" })], []),
			config,
		);
		const body = (await (await handler()).json()) as AccountResponse[];
		const acc = body.find((a) => a.id === ACCOUNT_ID);

		expect(acc?.usageData).toBeNull();
		expect(acc?.usageAsOfIso).toBeNull();
	});

	// The throttle annotation states that the PROXY is delaying requests. The
	// proxy decides that from a routing-fresh reading (usageCache.peek()), so an
	// aged display reading must not announce a delay that is not happening.
	it("suppresses the throttle annotation for a reading past the routing TTL", async () => {
		// Utilization far ahead of the window's elapsed pace → throttled when fresh.
		const burning = () => ({
			five_hour: {
				utilization: 95,
				resets_at: new Date(BASE + 4 * HOUR_MS).toISOString(),
			},
			seven_day: {
				utilization: 95,
				resets_at: new Date(BASE + 6 * DAY_MS).toISOString(),
			},
		});
		const run = async (ageMs: number) => {
			usageCache.delete(ACCOUNT_ID);
			nowSpy.mockReturnValue(BASE);
			usageCache.set(ACCOUNT_ID, burning());
			nowSpy.mockReturnValue(BASE + ageMs);
			const handler = createAccountsListHandler(
				makeDbOps(
					[makeAccountRow({ id: ACCOUNT_ID, provider: "anthropic" })],
					[],
				),
				throttlingConfig,
			);
			const body = (await (await handler()).json()) as AccountResponse[];
			return body.find((a) => a.id === ACCOUNT_ID);
		};

		const fresh = await run(2 * MINUTE_MS);
		expect(fresh?.usageThrottledWindows.length).toBeGreaterThan(0);

		const aged = await run(12 * MINUTE_MS);
		// Bars still render (with their age)...
		expect(aged?.usageData).not.toBeNull();
		// ...but the "requests are being delayed" claim is withdrawn.
		expect(aged?.usageThrottledWindows).toEqual([]);
		expect(aged?.usageThrottledUntil).toBeNull();
	});

	it("keeps the as-of timestamp for a Codex entry that normalizes from the live cache", async () => {
		usageCache.set(ACCOUNT_ID, {
			five_hour: null,
			seven_day: {
				utilization: 50,
				resets_at: new Date(BASE + 3 * DAY_MS).toISOString(),
			},
		});
		nowSpy.mockReturnValue(BASE + 2 * MINUTE_MS);

		const handler = createAccountsListHandler(
			makeDbOps([makeAccountRow({ id: ACCOUNT_ID, provider: "codex" })], []),
			config,
		);
		const body = (await (await handler()).json()) as AccountResponse[];
		const acc = body.find((a) => a.id === ACCOUNT_ID);

		expect(acc?.usageData).not.toBeNull();
		expect(acc?.usageAsOfIso).toBe(new Date(BASE).toISOString());
	});
});
