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

/**
 * One row of the persisted Codex usage pair. `getAllAccounts()` does not select
 * these columns, so the handler loads them separately through the adapter.
 */
interface CodexColumnRow {
	id: string;
	codex_usage_json: string | null;
	codex_usage_observed_at: number | null;
}

/** A persisted Codex snapshot: no 5h window (Codex retired it), a live 7d one. */
function codexSnapshot(sevenPct: number, sevenResetMs: number): string {
	return JSON.stringify({
		five_hour: null,
		seven_day: {
			utilization: sevenPct,
			resets_at: new Date(sevenResetMs).toISOString(),
		},
	});
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
 * The handler takes its accounts and keys from `getAllAccounts()` and (through
 * `listApiKeys`) `getApiKeys()` directly, so a SQL-substring fixture would hand
 * it nothing at all. `getAdapter().query` is used for ONE thing: the persisted
 * Codex columns (`codex_usage_json`, which `getAllAccounts()` deliberately does
 * not select) and the stored-payload scan behind them. `codexColumns` /
 * `payloads` feed those two queries, and `adapterQueries` records every SQL the
 * handler actually issued so a test can assert a query never ran.
 */
function makeDbOps(options: {
	accounts?: Account[];
	keys?: ApiKey[];
	snapshots?: UsageSnapshotSample[];
	snapshotsThrow?: boolean;
	codexColumns?: CodexColumnRow[];
	payloads?: Array<{ json: string; timestamp: number }>;
	adapterQueries?: string[];
}): DatabaseOperations {
	return {
		getAllAccounts: async () => options.accounts ?? [],
		getApiKeys: async () => options.keys ?? [],
		getAdapter: () => ({
			query: async (sql: string) => {
				options.adapterQueries?.push(sql);
				if (sql.includes("request_payloads")) return options.payloads ?? [];
				if (sql.includes("FROM accounts")) return options.codexColumns ?? [];
				return [];
			},
			get: async () => null,
		}),
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
		// The weekly window is served with `prediction: null` even though the same
		// snapshots carry a full weekly history: the server no longer fits one,
		// because the lifetime average the client falls back to measured better.
		expect(
			rising?.windows.find((w) => w.kind === "seven_day")?.prediction,
		).toBe(null);
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

	it("reports a Codex account with no cached and no persisted reading as unknown", async () => {
		// The cache is cold AND the persisted column is empty AND no stored payload
		// carries usage headers: every channel is exhausted, so the account is
		// genuinely unread. Not "0% used" — unknown, and the key's outcome says so.
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

/**
 * The usage cache is in-memory, so a restart leaves every Codex account with
 * nothing in it until Codex traffic lands again. `/api/accounts` has always
 * resolved through the persisted `accounts.codex_usage_json` column in that
 * gap, and the browser computed the runway from exactly that reading before
 * this endpoint existed. Serving it without the persisted resolution turned
 * every Codex account blank after a restart and poisoned every Codex-pinned key
 * to `unknown`; these cases pin the restored path, its honest stamp, and the
 * fact that it stops short of the prediction.
 */
describe("GET /api/runway persisted Codex usage", () => {
	let nowSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		nowSpy = spyOn(Date, "now").mockReturnValue(BASE);
		for (const id of SEEDED_IDS) usageCache.delete(id);
	});

	afterEach(() => {
		for (const id of SEEDED_IDS) usageCache.delete(id);
		nowSpy.mockRestore();
	});

	const OBSERVED_AT = BASE - 3 * HOUR_MS;
	const SEVEN_RESET = BASE + 4 * DAY_MS;

	function restoredCodex(options: { adapterQueries?: string[] } = {}) {
		return makeDbOps({
			accounts: [
				makeAccount({
					id: "codex-1",
					name: "Codex",
					provider: "codex",
					// Nothing has been routed since the observation, so the column is
					// definitively the newest reading and the payload scan is skipped.
					last_used: null,
				}),
			],
			keys: [
				makeKey({ id: "k1", name: "codex-only", pinnedProviders: ["codex"] }),
			],
			codexColumns: [
				{
					id: "codex-1",
					codex_usage_json: codexSnapshot(45, SEVEN_RESET),
					codex_usage_observed_at: OBSERVED_AT,
				},
			],
			adapterQueries: options.adapterQueries,
		});
	}

	it("serves the persisted column when the usage cache is cold", async () => {
		const body = await runway(restoredCodex());

		const sevenDay = body.accounts[0].windows.find(
			(w) => w.kind === "seven_day",
		);
		expect(sevenDay?.utilizationPct).toBe(45);
		expect(sevenDay?.resetsAtMs).toBe(SEVEN_RESET);
		// Codex retired its 5h window, so that one is present-but-null: "no such
		// reading", never "0% used".
		expect(
			body.accounts[0].windows.find((w) => w.kind === "five_hour")
				?.utilizationPct,
		).toBeNull();
	});

	it("stamps the restored reading with the column's observation time", async () => {
		const body = await runway(restoredCodex());

		// NOT the handler clock and NOT a cache sample time (there is no cache
		// entry at all) — the moment that observation was actually made.
		expect(body.accounts[0].usageAsOfMs).toBe(OBSERVED_AT);
		expect(body.generatedAt).toBe(BASE);
	});

	it("gives a Codex-pinned key a real outcome instead of unknown", async () => {
		const body = await runway(restoredCodex());

		expect(body.keys[0].eligibleAccountIds).toEqual(["codex-1"]);
		const outcome = body.keys[0].outcome;
		expect(outcome.kind).not.toBe("unknown");
		if (outcome.kind === "unknown" || outcome.kind === "no-accounts") {
			throw new Error("unreachable");
		}
		// The account is IN the pool: the scan could read it, so it is not
		// reported as one the projection had to skip.
		expect(outcome.unprojectableAccountIds).toEqual([]);
	});

	it("serves no prediction off a restored reading", async () => {
		const body = await runway(
			makeDbOps({
				accounts: [
					makeAccount({
						id: "codex-1",
						name: "Codex",
						provider: "codex",
						last_used: null,
					}),
				],
				keys: [makeKey({ id: "k1" })],
				codexColumns: [
					{
						id: "codex-1",
						codex_usage_json: codexSnapshot(45, SEVEN_RESET),
						codex_usage_observed_at: OBSERVED_AT,
					},
				],
				// A full trend history exists — the prediction is withheld because of
				// where the CURRENT reading came from, not for want of samples.
				snapshots: [3, 2, 1].map((hoursAgo, index) => ({
					accountId: "codex-1",
					provider: "codex",
					sampledAt: BASE - hoursAgo * HOUR_MS,
					fiveHourPct: null,
					fiveHourReset: null,
					sevenDayPct: 10 * (index + 1),
					sevenDayReset: SEVEN_RESET,
				})),
			}),
		);

		// The regression appends its input stamped `t: now`. A reading observed 3
		// hours ago must never enter it claiming to be current, so the restored
		// account reports its utilization and no projection at all.
		expect(body.accounts[0].windows.map((w) => w.prediction)).toEqual([
			null,
			null,
		]);
		expect(
			body.accounts[0].windows.find((w) => w.kind === "seven_day")
				?.utilizationPct,
		).toBe(45);
	});

	it("prefers a live cache entry over the persisted column", async () => {
		usageCache.set("codex-1", usage(0, BASE + HOUR_MS, 12, SEVEN_RESET));

		const body = await runway(restoredCodex());

		const sevenDay = body.accounts[0].windows.find(
			(w) => w.kind === "seven_day",
		);
		expect(sevenDay?.utilizationPct).toBe(12);
		// Stamped by the cache entry's own write time, not the column's.
		expect(body.accounts[0].usageAsOfMs).toBe(BASE);
	});

	it("leaves non-Codex accounts on the cache alone", async () => {
		// A persisted row exists under this id, and it must not be consulted: the
		// column is written by Codex observations only, so reading it for an
		// Anthropic account would serve a snapshot nothing maintains.
		const adapterQueries: string[] = [];
		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "anthropic-1", name: "Claude" })],
				keys: [makeKey({ id: "k1" })],
				codexColumns: [
					{
						id: "anthropic-1",
						codex_usage_json: codexSnapshot(45, SEVEN_RESET),
						codex_usage_observed_at: OBSERVED_AT,
					},
				],
				adapterQueries,
			}),
		);

		expect(body.accounts[0].windows.map((w) => w.utilizationPct)).toEqual([
			null,
			null,
		]);
		expect(body.accounts[0].usageAsOfMs).toBeNull();
		expect(body.keys[0].outcome).toEqual({ kind: "unknown" });
		// With no Codex account in the pool the persisted-column query never runs.
		expect(adapterQueries).toEqual([]);
	});

	it("still resolves an Anthropic account from the usage cache", async () => {
		usageCache.set("anthropic-1", HEALTHY());

		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "anthropic-1", name: "Claude" })],
				keys: [makeKey({ id: "k1" })],
			}),
		);

		expect(body.accounts[0].windows.map((w) => w.utilizationPct)).toEqual([
			10, 5,
		]);
		expect(body.accounts[0].usageAsOfMs).toBe(BASE);
		expect(body.keys[0].outcome.kind).toBe("beyond-horizon");
	});
});

describe("GET /api/runway persisted snapshot fallback", () => {
	let nowSpy: ReturnType<typeof spyOn>;

	const COLD_IDS = ["cold-1", "warm-1"];

	beforeEach(() => {
		nowSpy = spyOn(Date, "now").mockReturnValue(BASE);
		for (const id of COLD_IDS) usageCache.delete(id);
	});

	afterEach(() => {
		for (const id of COLD_IDS) usageCache.delete(id);
		nowSpy.mockRestore();
	});

	/** One persisted sample, `ageMs` before BASE. */
	function snapshot(
		accountId: string,
		ageMs: number,
		partial: Partial<UsageSnapshotSample> = {},
	): UsageSnapshotSample {
		return {
			accountId,
			provider: "anthropic",
			sampledAt: BASE - ageMs,
			fiveHourPct: 100,
			fiveHourReset: BASE + 2 * HOUR_MS,
			sevenDayPct: 20,
			sevenDayReset: BASE + 6 * DAY_MS,
			...partial,
		};
	}

	it("projects a cache-cold account from a recent snapshot", async () => {
		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "cold-1", name: "Cold" })],
				keys: [makeKey({ id: "k1" })],
				snapshots: [snapshot("cold-1", 2 * MINUTE_MS)],
			}),
		);

		// Without the fallback a restart-emptied cache leaves this key `unknown`
		// and the tile built on it blank. The snapshot is two minutes old, well
		// inside the routing bar a cache entry would be held to.
		expect(body.keys[0].outcome.kind).toBe("out-now");
		expect(body.accounts[0].windows[0].utilizationPct).toBe(100);
		expect(body.accounts[0].usageAsOfMs).toBe(BASE - 2 * MINUTE_MS);
	});

	it("never emits a prediction for a snapshot-restored account", async () => {
		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "cold-1", name: "Cold" })],
				keys: [makeKey({ id: "k1" })],
				snapshots: [
					snapshot("cold-1", 6 * MINUTE_MS, { fiveHourPct: 40 }),
					snapshot("cold-1", 4 * MINUTE_MS, { fiveHourPct: 50 }),
					snapshot("cold-1", 2 * MINUTE_MS, { fiveHourPct: 60 }),
				],
			}),
		);

		// The prediction service appends its input stamped `t: now`, so a reading
		// observed minutes ago would enter the regression claiming to be current.
		// The utilization is restored; the projection falls back to the
		// lifetime-average path.
		expect(body.accounts[0].windows[0].utilizationPct).toBe(60);
		expect(body.accounts[0].windows.map((w) => w.prediction)).toEqual([
			null,
			null,
		]);
	});

	it("keeps a live cache reading over a newer-looking snapshot", async () => {
		usageCache.set("warm-1", HEALTHY());

		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "warm-1", name: "Warm" })],
				keys: [makeKey({ id: "k1" })],
				snapshots: [snapshot("warm-1", 0)],
			}),
		);

		// The snapshot is a FALLBACK for a read that produced nothing, never a
		// competitor to one that produced something.
		expect(body.accounts[0].windows[0].utilizationPct).toBe(10);
		expect(body.keys[0].outcome.kind).toBe("beyond-horizon");
	});

	it("shows a snapshot past the routing bar as evidence but does not project it", async () => {
		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "cold-1", name: "Cold" })],
				keys: [makeKey({ id: "k1" })],
				snapshots: [snapshot("cold-1", 20 * MINUTE_MS)],
			}),
		);

		// The two views keep their existing relationship: 20 minutes is inside the
		// display horizon and outside the routing one, so the reading is reported
		// with its age while the scan calls the account unprojectable.
		expect(body.accounts[0].windows[0].utilizationPct).toBe(100);
		expect(body.accounts[0].usageAsOfMs).toBe(BASE - 20 * MINUTE_MS);
		expect(body.keys[0].outcome.kind).toBe("unknown");
	});

	it("ignores a snapshot past the display horizon entirely", async () => {
		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "cold-1", name: "Cold" })],
				keys: [makeKey({ id: "k1" })],
				snapshots: [snapshot("cold-1", 45 * MINUTE_MS)],
			}),
		);

		expect(body.accounts[0].windows[0].utilizationPct).toBeNull();
		expect(body.accounts[0].usageAsOfMs).toBeNull();
		expect(body.keys[0].outcome.kind).toBe("unknown");
	});

	it("drops a snapshot window whose reset has already passed", async () => {
		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "cold-1", name: "Cold" })],
				keys: [makeKey({ id: "k1" })],
				snapshots: [
					snapshot("cold-1", 4 * MINUTE_MS, {
						// Spent, and the window has ROLLED OVER since the row was
						// written. `pct >= 100` is decided before the reset guards, so
						// left in it would report `already-exhausted` with a stale reset
						// and hold the account dead for the whole 14-day horizon —
						// announcing "Out of quota" about quota that has replenished.
						fiveHourPct: 100,
						fiveHourReset: BASE - MINUTE_MS,
						sevenDayPct: null,
						sevenDayReset: null,
					}),
				],
			}),
		);

		expect(body.keys[0].outcome.kind).not.toBe("out-now");
		expect(body.keys[0].outcome.kind).toBe("unknown");
		// The evidence block still REPORTS it: an observation whose reset has
		// since passed is a true statement about when it was taken.
		expect(body.accounts[0].windows[0].utilizationPct).toBe(100);
	});

	it("rejects a snapshot stamped in the future", async () => {
		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "cold-1", name: "Cold" })],
				keys: [makeKey({ id: "k1" })],
				// Clock rollback across a restart. A negative age passes a bare
				// `age <= max` test until the wall clock catches up.
				snapshots: [snapshot("cold-1", -5 * MINUTE_MS)],
			}),
		);

		expect(body.keys[0].outcome.kind).toBe("unknown");
		expect(body.accounts[0].usageAsOfMs).toBeNull();
	});

	it("prefers a recent snapshot over a stale persisted Codex column", async () => {
		const body = await runway(
			makeDbOps({
				accounts: [
					makeAccount({ id: "codex-1", name: "Codex", provider: "codex" }),
				],
				keys: [makeKey({ id: "k1" })],
				codexColumns: [
					{
						id: "codex-1",
						codex_usage_json: codexSnapshot(95, BASE + 6 * DAY_MS),
						codex_usage_observed_at: BASE - 3 * DAY_MS,
					},
				],
				snapshots: [
					{
						accountId: "codex-1",
						provider: "codex",
						sampledAt: BASE - 2 * MINUTE_MS,
						fiveHourPct: null,
						fiveHourReset: null,
						sevenDayPct: 10,
						sevenDayReset: BASE + 6 * DAY_MS,
					},
				],
			}),
		);

		// Candidates are ranked by OBSERVATION TIME, not by source precedence, so
		// a two-minute snapshot beats a three-day-old column. Ranking by source
		// would have let the column derive a projection while the fresher reading
		// sat unread.
		const weekly = body.accounts[0].windows.find((w) => w.kind === "seven_day");
		expect(weekly?.utilizationPct).toBe(10);
		expect(body.accounts[0].usageAsOfMs).toBe(BASE - 2 * MINUTE_MS);
	});

	it("still reports a stale Codex column when nothing fresher exists", async () => {
		const body = await runway(
			makeDbOps({
				accounts: [
					makeAccount({ id: "codex-1", name: "Codex", provider: "codex" }),
				],
				keys: [makeKey({ id: "k1" })],
				codexColumns: [
					{
						id: "codex-1",
						codex_usage_json: codexSnapshot(95, BASE + 6 * DAY_MS),
						codex_usage_observed_at: BASE - 3 * DAY_MS,
					},
				],
			}),
		);

		// The evidence block applies no age bar of its own — the column is the one
		// deliberately unbounded source, and barring it here would show LESS than
		// /api/accounts for exactly the accounts it exists to cover.
		const weekly = body.accounts[0].windows.find((w) => w.kind === "seven_day");
		expect(weekly?.utilizationPct).toBe(95);
		expect(body.accounts[0].usageAsOfMs).toBe(BASE - 3 * DAY_MS);
		// And it DOES still drive the scan. The persisted Codex column is this
		// endpoint's one documented exception to the routing bar (an aged cache
		// entry gets no such licence), because blanking every Codex-pinned key
		// after a restart is what that exception exists to prevent. The reading is
		// reported with its true age, so nothing here presents it as current.
		expect(body.keys[0].outcome.kind).not.toBe("unknown");
	});

	it("serves the response when the snapshot read fails", async () => {
		const body = await runway(
			makeDbOps({
				accounts: [makeAccount({ id: "cold-1", name: "Cold" })],
				keys: [makeKey({ id: "k1" })],
				snapshotsThrow: true,
			}),
		);

		// A fallback for evidence that is already missing must degrade to "no
		// fallback", never take the endpoint down.
		expect(body.keys[0].outcome.kind).toBe("unknown");
		expect(body.accounts[0].usageAsOfMs).toBeNull();
	});
});

/**
 * A Codex reading reconstructed from a stored request payload has NO honest
 * observation time — the headers belong to whatever request happened to be
 * retained. The recovery re-seeds the usage cache (deliberately: that is how the
 * proxy gets to see the reading too), so on the NEXT refresh the very same
 * reconstruction comes back through the cache branch.
 *
 * The point of these cases is that the re-seed writes a FRESHNESS stamp and not
 * an observation: taking the entry's write time as its observation time would
 * hand the reconstruction a confident timestamp anchored to the recovery
 * instant, promoting the weekly window from the degraded now-anchored estimate
 * to the full-confidence observation-anchored one between two refetches, with no
 * new provider evidence behind the change.
 */
describe("GET /api/runway payload-recovered Codex usage", () => {
	let nowSpy: ReturnType<typeof spyOn>;

	const ACCOUNT_ID = "codex-recovered";
	const WEEKLY_PCT = 45;
	const SEVEN_RESET = BASE + 4 * DAY_MS;
	/** `computeWindowStartMs(SEVEN_RESET, "seven_day")`. */
	const WINDOW_START = SEVEN_RESET - 7 * DAY_MS;
	const REFETCH_AT = BASE + 5 * MINUTE_MS;

	beforeEach(() => {
		nowSpy = spyOn(Date, "now").mockReturnValue(BASE);
		usageCache.delete(ACCOUNT_ID);
	});

	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
		nowSpy.mockRestore();
	});

	/** A retained request payload carrying Codex weekly-usage response headers. */
	function payloadRow(timestampMs: number): {
		json: string;
		timestamp: number;
	} {
		return {
			timestamp: timestampMs,
			json: JSON.stringify({
				response: {
					status: 200,
					headers: {
						"x-codex-secondary-window-minutes": String(7 * 24 * 60),
						"x-codex-secondary-used-percent": String(WEEKLY_PCT),
						"x-codex-secondary-reset-at": String(
							Math.floor(SEVEN_RESET / 1000),
						),
					},
				},
				meta: { timestamp: timestampMs },
			}),
		};
	}

	function recoveredCodex(adapterQueries: string[]): DatabaseOperations {
		return makeDbOps({
			accounts: [
				makeAccount({
					id: ACCOUNT_ID,
					name: "Codex",
					provider: "codex",
					last_used: BASE - 10 * MINUTE_MS,
				}),
			],
			keys: [makeKey({ id: "k1" })],
			// No persisted column: the stored-payload scan is the only channel left.
			codexColumns: [],
			payloads: [payloadRow(BASE - 2 * HOUR_MS)],
			adapterQueries,
		});
	}

	/**
	 * The DEGRADED weekly estimate: the lifetime average over the window elapsed
	 * at `now`, anchored at `now`. This is what a reading with no observation time
	 * must produce, on the first request and on every one after it.
	 */
	const nowAnchoredExhaustion = (now: number): number =>
		now + ((100 - WEEKLY_PCT) / WEEKLY_PCT) * (now - WINDOW_START);

	/**
	 * The FULL-CONFIDENCE estimate the defect produced on the second request: the
	 * same lifetime average anchored at the entry's write time, i.e. the moment
	 * the recovery happened.
	 */
	const observationAnchoredExhaustion = (observedAtMs: number): number =>
		observedAtMs +
		((100 - WEEKLY_PCT) / WEEKLY_PCT) * (observedAtMs - WINDOW_START);

	it("reports a recovered reading with no observation time and no prediction", async () => {
		const adapterQueries: string[] = [];
		const body = await runway(recoveredCodex(adapterQueries));

		const weekly = body.accounts[0].windows.find((w) => w.kind === "seven_day");
		expect(weekly?.utilizationPct).toBe(WEEKLY_PCT);
		// The scan really did read the payload channel.
		expect(
			adapterQueries.filter((sql) => sql.includes("request_payloads")),
		).toHaveLength(1);
		// No trustworthy observation time, so none is claimed…
		expect(body.accounts[0].usageAsOfMs).toBeNull();
		// …and nothing is derived that would need one.
		expect(body.accounts[0].windows.map((w) => w.prediction)).toEqual([
			null,
			null,
		]);
		const outcome = body.keys[0].outcome;
		if (outcome.kind !== "runway") throw new Error("expected a runway outcome");
		// The degraded, now-anchored lifetime average — the amber-capped estimate.
		expect(outcome.exhaustsAtMs).toBe(nowAnchoredExhaustion(BASE));
	});

	it("keeps the recovered reading degraded on the next refresh", async () => {
		const adapterQueries: string[] = [];
		const dbOps = recoveredCodex(adapterQueries);

		// Request 1 performs the recovery and re-seeds the cache.
		await runway(dbOps);
		const seeded = usageCache.peekWithAge(ACCOUNT_ID);
		expect(seeded).not.toBeNull();
		// The entry exists and is FRESH (that is the point of the re-seed), while
		// saying nothing about when its reading was observed.
		expect(seeded?.sampledAtMs).toBe(BASE);
		expect(seeded?.observedAtMs).toBeNull();

		// Request 2, five minutes later: same data, now served off that entry.
		nowSpy.mockReturnValue(REFETCH_AT);
		const body = await runway(dbOps);

		// Served from the cache — the payload scan did not run a second time.
		expect(
			adapterQueries.filter((sql) => sql.includes("request_payloads")),
		).toHaveLength(1);
		const weekly = body.accounts[0].windows.find((w) => w.kind === "seven_day");
		expect(weekly?.utilizationPct).toBe(WEEKLY_PCT);

		// The reading has not changed, so neither has what may be claimed about it:
		// still no observation time, still no prediction.
		expect(body.accounts[0].usageAsOfMs).toBeNull();
		expect(body.accounts[0].windows.map((w) => w.prediction)).toEqual([
			null,
			null,
		]);

		const outcome = body.keys[0].outcome;
		if (outcome.kind !== "runway") throw new Error("expected a runway outcome");
		// Still the degraded now-anchored estimate…
		expect(outcome.exhaustsAtMs).toBe(nowAnchoredExhaustion(REFETCH_AT));
		// …and specifically NOT the full-confidence estimate anchored at the moment
		// the recovery wrote the cache entry.
		expect(outcome.exhaustsAtMs).not.toBe(observationAnchoredExhaustion(BASE));
	});

	it("still reports a live-fetched reading's own observation time", async () => {
		// The control: a genuine live write keeps its real observation time on
		// every later read, so the fix costs an honest stamp nothing.
		usageCache.set(ACCOUNT_ID, {
			five_hour: null,
			seven_day: {
				utilization: WEEKLY_PCT,
				resets_at: new Date(SEVEN_RESET).toISOString(),
			},
		} as unknown as AnyUsageData);

		nowSpy.mockReturnValue(REFETCH_AT);
		const body = await runway(recoveredCodex([]));

		expect(body.accounts[0].usageAsOfMs).toBe(BASE);
		const outcome = body.keys[0].outcome;
		if (outcome.kind !== "runway") throw new Error("expected a runway outcome");
		// Observation-anchored, because there IS an observation to anchor to.
		expect(outcome.exhaustsAtMs).toBe(observationAnchoredExhaustion(BASE));
	});
});
