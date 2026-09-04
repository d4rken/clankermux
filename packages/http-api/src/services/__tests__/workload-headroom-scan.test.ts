import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import type {
	Account,
	ApiKey,
	ScopedUsageSnapshotSample,
	UsageSnapshotSample,
} from "@clankermux/types";
import { computeWorkloadHeadroomScan } from "../workload-headroom-scan";

/**
 * End-to-end over the seam the per-family row actually reads: database rows ->
 * `computeRunwayScan` -> `computeWorkloadHeadroom`.
 *
 * The family dimension has now twice been broken by something BETWEEN those
 * stages while every unit test stayed green, because each side was exercised
 * against hand-built inputs that production never produces. Assert here, where
 * the only inputs are rows.
 */

const BASE = Date.UTC(2026, 8, 4, 12, 0, 0);
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ACCOUNTS = ["cold-1", "cold-2"];

function makeAccount(partial: Partial<Account>): Account {
	return {
		id: "cold-1",
		name: "Cold 1",
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

function makeKey(partial: Partial<ApiKey> = {}): ApiKey {
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
	} as ApiKey;
}

function accountWide(
	accountId: string,
	over: Partial<UsageSnapshotSample> = {},
): UsageSnapshotSample {
	return {
		accountId,
		provider: "anthropic",
		sampledAt: BASE - MINUTE_MS,
		observedAt: BASE - 2 * MINUTE_MS,
		fiveHourPct: 10,
		fiveHourReset: BASE + 2 * HOUR_MS,
		sevenDayPct: 30,
		sevenDayReset: BASE + 3 * DAY_MS,
		planTier: null,
		rateLimitTier: null,
		...over,
	} as UsageSnapshotSample;
}

function scopedRow(
	accountId: string,
	over: Partial<ScopedUsageSnapshotSample> = {},
): ScopedUsageSnapshotSample {
	return {
		accountId,
		sampledAt: BASE - MINUTE_MS,
		family: "fable",
		displayName: "Fable",
		pct: 50,
		resetAt: BASE + 3 * DAY_MS,
		...over,
	} as ScopedUsageSnapshotSample;
}

function makeDbOps(options: {
	accounts: Account[];
	snapshots?: UsageSnapshotSample[];
	scopedSnapshots?: ScopedUsageSnapshotSample[];
}): DatabaseOperations {
	return {
		getAllAccounts: async () => options.accounts,
		getApiKeys: async () => [makeKey()],
		getAdapter: () => ({
			query: async () => [],
			get: async () => null,
		}),
		getRecentUsageSnapshotsForAccounts: async (accountIds: string[]) =>
			(options.snapshots ?? []).filter((s) => accountIds.includes(s.accountId)),
		getRecentScopedUsageSnapshotsForAccounts: async (accountIds: string[]) =>
			(options.scopedSnapshots ?? []).filter((s) =>
				accountIds.includes(s.accountId),
			),
	} as unknown as DatabaseOperations;
}

describe("computeWorkloadHeadroomScan from persisted rows only", () => {
	let nowSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		nowSpy = spyOn(Date, "now").mockReturnValue(BASE);
		for (const id of ACCOUNTS) usageCache.delete(id);
	});

	afterEach(() => {
		for (const id of ACCOUNTS) usageCache.delete(id);
		nowSpy.mockRestore();
	});

	it("emits a family row from snapshot evidence alone", async () => {
		// The restart case, and the one that had no coverage: the cache is empty,
		// so every reading comes from the persisted series. Before the scoped rows
		// were loaded this produced class rows only, and the family dimension
		// disappeared without a single test noticing.
		const scan = await computeWorkloadHeadroomScan(
			makeDbOps({
				accounts: [
					makeAccount({ id: "cold-1" }),
					makeAccount({ id: "cold-2", name: "Cold 2" }),
				],
				snapshots: [accountWide("cold-1"), accountWide("cold-2")],
				scopedSnapshots: [scopedRow("cold-1"), scopedRow("cold-2")],
			}),
		);

		const family = scan.rows.filter((r) => r.dimensionKind === "family");
		expect(family).toHaveLength(1);
		expect(family[0]?.dimensionId).toBe("fable");
		expect(family[0]?.eligibleAccountIds.sort()).toEqual(["cold-1", "cold-2"]);
		expect(family[0]?.unreadableAccountIds).toEqual([]);
	});

	it("marks an account unreadable rather than dropping it when its tick wrote no scoped row", async () => {
		// The sampler writes the two series in separate statements, so an
		// account-wide row is NOT evidence that the scoped write for its tick
		// landed. Reading that absence as "reports no families" would silently
		// shrink the pool the family row is computed over; it is unreadable.
		const scan = await computeWorkloadHeadroomScan(
			makeDbOps({
				accounts: [
					makeAccount({ id: "cold-1" }),
					makeAccount({ id: "cold-2", name: "Cold 2" }),
				],
				snapshots: [accountWide("cold-1"), accountWide("cold-2")],
				scopedSnapshots: [scopedRow("cold-1")],
			}),
		);

		const family = scan.rows.find((r) => r.dimensionKind === "family");
		expect(family?.eligibleAccountIds.sort()).toEqual(["cold-1", "cold-2"]);
		expect(family?.unreadableAccountIds).toEqual(["cold-2"]);
	});

	it("still finds a family whose only evidence is a scoped-row-only tick", async () => {
		// Reachable through the sampler's separate inserts: an account-wide write
		// that fails leaves the scoped write to land alone. If that account is the
		// family's only reporter, discarding the row deletes the family outright.
		const scan = await computeWorkloadHeadroomScan(
			makeDbOps({
				accounts: [makeAccount({ id: "cold-1" })],
				snapshots: [],
				scopedSnapshots: [scopedRow("cold-1")],
			}),
		);

		const family = scan.rows.find((r) => r.dimensionKind === "family");
		expect(family?.dimensionId).toBe("fable");
		expect(family?.eligibleAccountIds).toEqual(["cold-1"]);
	});

	it("pairs each account's scoped rows to its own tick", async () => {
		// Two accounts sampled at different ticks. Pairing on the account rather
		// than the tick would let one account's reading pick up the other's row.
		const scan = await computeWorkloadHeadroomScan(
			makeDbOps({
				accounts: [
					makeAccount({ id: "cold-1" }),
					makeAccount({ id: "cold-2", name: "Cold 2" }),
				],
				snapshots: [
					accountWide("cold-1", { sampledAt: BASE - 3 * MINUTE_MS }),
					accountWide("cold-2", { sampledAt: BASE - MINUTE_MS }),
				],
				scopedSnapshots: [
					scopedRow("cold-1", { sampledAt: BASE - 3 * MINUTE_MS, pct: 20 }),
					scopedRow("cold-2", { sampledAt: BASE - MINUTE_MS, pct: 80 }),
				],
			}),
		);

		const family = scan.rows.find((r) => r.dimensionKind === "family");
		expect(family?.eligibleAccountIds.sort()).toEqual(["cold-1", "cold-2"]);
		expect(family?.unreadableAccountIds).toEqual([]);
	});
});
