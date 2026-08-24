/**
 * Tests for the PURE `buildSnapshotRows` helper that turns the in-memory usage
 * cache into write-ready `UsageSnapshotRow`s for the rate-limit "sawtooth"
 * time-series, plus the sampler's pure read-through `tick()` behavior. The
 * sampler never probes/spends — it only reads the shared cache — so pause is
 * irrelevant to what gets recorded. The timer/scheduling path is still exercised
 * via integration in the running server.
 */
import { describe, expect, it } from "bun:test";
import type { AnyUsageData, UsageData } from "@clankermux/providers";
import { getWeeklyBurnSlope } from "@clankermux/proxy";
import type {
	Account,
	ScopedUsageSnapshotRow,
	UsageSnapshotRow,
	UsageSnapshotSample,
} from "@clankermux/types";
import {
	buildSamplerRows,
	buildSnapshotRows,
	type SamplerCache,
	UsageSnapshotSampler,
} from "./usage-snapshot-sampler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed "now" for deterministic sampledAt
const FRESHNESS = 150_000; // 150s freshness window

interface SeedEntry {
	data: AnyUsageData | null;
	ageMs: number | null;
	/**
	 * Observation provenance of the entry. Omitted means "a live reading", i.e.
	 * observed when it was written (`NOW - ageMs`) — what `usageCache.set()`
	 * records. Pass `null` explicitly for a RECONSTRUCTED entry with no
	 * trustworthy observation time (`usageCache.setUntimed()`).
	 */
	observedAtMs?: number | null;
}

/** Minimal SamplerCache backed by a plain map of accountId → {data, age}. */
function makeCache(entries: Record<string, SeedEntry>): SamplerCache {
	return {
		peekWithAge(id: string) {
			const e = entries[id];
			if (!e || e.ageMs === null || e.data === null) return null;
			return {
				data: e.data,
				ageMs: e.ageMs,
				observedAtMs:
					e.observedAtMs === undefined ? NOW - e.ageMs : e.observedAtMs,
			};
		},
	};
}

function usageData(opts: {
	fiveHourUtil?: number | null;
	fiveHourReset?: string | null;
	sevenDayUtil?: number | null;
	sevenDayReset?: string | null;
}): UsageData {
	const data: Record<string, unknown> = {};
	if (opts.fiveHourUtil !== undefined || opts.fiveHourReset !== undefined) {
		data.five_hour = {
			utilization: opts.fiveHourUtil ?? 0,
			resets_at: opts.fiveHourReset ?? null,
		};
	}
	if (opts.sevenDayUtil !== undefined || opts.sevenDayReset !== undefined) {
		data.seven_day = {
			utilization: opts.sevenDayUtil ?? 0,
			resets_at: opts.sevenDayReset ?? null,
		};
	}
	return data as UsageData;
}

/**
 * Usage payload carrying per-family `weekly_scoped` limits (the generic
 * `limits[]` form) alongside optional flat account-wide windows.
 */
function usageDataWithScoped(
	scoped: Array<{
		displayName: string;
		percent: number;
		resetsAt: string;
		isActive?: boolean;
	}>,
	flat?: Parameters<typeof usageData>[0],
): UsageData {
	const data = (flat ? usageData(flat) : {}) as Record<string, unknown>;
	data.limits = scoped.map((s) => ({
		kind: "weekly_scoped",
		percent: s.percent,
		resets_at: s.resetsAt,
		is_active: s.isActive ?? true,
		scope: { model: { display_name: s.displayName } },
	}));
	return data as UsageData;
}

interface Acct {
	id: string;
	provider: string;
	identity_plan_tier?: string | null;
	identity_rate_limit_tier?: string | null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildSnapshotRows", () => {
	it("includes anthropic + codex accounts with fresh cache and converts ISO resets to ms", () => {
		const fiveReset = "2023-11-14T22:13:20.000Z"; // == NOW + 100s
		const sevenReset = "2023-11-21T22:13:20.000Z";
		const accounts: Acct[] = [
			{ id: "anth-1", provider: "anthropic" },
			{ id: "codex-1", provider: "codex" },
		];
		const cache = makeCache({
			"anth-1": {
				ageMs: 1_000,
				data: usageData({
					fiveHourUtil: 42,
					fiveHourReset: fiveReset,
					sevenDayUtil: 7,
					sevenDayReset: sevenReset,
				}),
			},
			"codex-1": {
				ageMs: 2_000,
				data: usageData({
					fiveHourUtil: 90,
					fiveHourReset: fiveReset,
					sevenDayUtil: 12,
					sevenDayReset: sevenReset,
				}),
			},
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		expect(rows).toHaveLength(2);
		const anth = rows.find((r) => r.accountId === "anth-1");
		expect(anth).toEqual({
			accountId: "anth-1",
			provider: "anthropic",
			sampledAt: NOW,
			fiveHourPct: 42,
			fiveHourReset: new Date(fiveReset).getTime(),
			sevenDayPct: 7,
			sevenDayReset: new Date(sevenReset).getTime(),
			// The reading is as old as the cache entry, not as old as the tick.
			observedAt: NOW - 1_000,
			planTier: null,
			rateLimitTier: null,
		});
		const codex = rows.find((r) => r.accountId === "codex-1");
		expect(codex?.fiveHourPct).toBe(90);
		expect(codex?.provider).toBe("codex");
		expect(codex?.fiveHourReset).toBe(new Date(fiveReset).getTime());
	});

	it("excludes zai/kilo/other providers entirely", () => {
		const accounts: Acct[] = [
			{ id: "zai-1", provider: "zai" },
			{ id: "kilo-1", provider: "kilo" },
			{ id: "alibaba-1", provider: "alibaba-coding-plan" },
			{ id: "anth-1", provider: "anthropic" },
		];
		const cache = makeCache({
			// Even with fresh, window-shaped data, non-anthropic/codex are dropped.
			"zai-1": { ageMs: 100, data: usageData({ fiveHourUtil: 50 }) },
			"kilo-1": { ageMs: 100, data: usageData({ fiveHourUtil: 50 }) },
			"alibaba-1": { ageMs: 100, data: usageData({ fiveHourUtil: 50 }) },
			"anth-1": { ageMs: 100, data: usageData({ fiveHourUtil: 50 }) },
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.accountId).toBe("anth-1");
	});

	it("skips accounts whose cache age exceeds freshness or is null (never carry-forward)", () => {
		const accounts: Acct[] = [
			{ id: "stale", provider: "anthropic" },
			{ id: "absent", provider: "codex" },
			{ id: "fresh", provider: "anthropic" },
		];
		const cache = makeCache({
			stale: {
				ageMs: FRESHNESS + 1, // just over the freshness window
				data: usageData({ fiveHourUtil: 50 }),
			},
			absent: {
				ageMs: null, // not in cache / evicted
				data: null,
			},
			fresh: {
				ageMs: FRESHNESS, // exactly at the boundary is still fresh
				data: usageData({ fiveHourUtil: 33 }),
			},
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.accountId).toBe("fresh");
		expect(rows[0]?.fiveHourPct).toBe(33);
	});

	it("records null pct for an absent window but keeps the row when the other window exists", () => {
		const accounts: Acct[] = [{ id: "anth-1", provider: "anthropic" }];
		const cache = makeCache({
			"anth-1": {
				ageMs: 1_000,
				// Only seven_day present; five_hour absent entirely.
				data: usageData({ sevenDayUtil: 20, sevenDayReset: null }),
			},
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.fiveHourPct).toBeNull();
		expect(rows[0]?.fiveHourReset).toBeNull();
		expect(rows[0]?.sevenDayPct).toBe(20);
		expect(rows[0]?.sevenDayReset).toBeNull();
	});

	it("skips the account when BOTH windows are absent/null (nothing meaningful)", () => {
		const accounts: Acct[] = [
			{ id: "empty", provider: "anthropic" },
			{ id: "real", provider: "codex" },
		];
		const cache = makeCache({
			empty: { ageMs: 1_000, data: usageData({}) }, // no windows at all
			real: { ageMs: 1_000, data: usageData({ fiveHourUtil: 5 }) },
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.accountId).toBe("real");
	});

	it("treats a null utilization as null pct (window present but utilization missing)", () => {
		const accounts: Acct[] = [{ id: "anth-1", provider: "anthropic" }];
		const cache = makeCache({
			"anth-1": {
				ageMs: 1_000,
				// five_hour present but utilization is null; seven_day has a real value.
				data: {
					five_hour: { utilization: null, resets_at: null },
					seven_day: { utilization: 15, resets_at: null },
				} as unknown as UsageData,
			},
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.fiveHourPct).toBeNull();
		expect(rows[0]?.sevenDayPct).toBe(15);
	});

	it("maps null resets_at to null reset and invalid ISO to null reset", () => {
		const accounts: Acct[] = [
			{ id: "null-reset", provider: "anthropic" },
			{ id: "bad-reset", provider: "codex" },
		];
		const cache = makeCache({
			"null-reset": {
				ageMs: 1_000,
				data: usageData({ fiveHourUtil: 10, fiveHourReset: null }),
			},
			"bad-reset": {
				ageMs: 1_000,
				data: usageData({
					fiveHourUtil: 10,
					fiveHourReset: "not-a-real-date",
				}),
			},
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		expect(rows).toHaveLength(2);
		expect(
			rows.find((r) => r.accountId === "null-reset")?.fiveHourReset,
		).toBeNull();
		expect(
			rows.find((r) => r.accountId === "bad-reset")?.fiveHourReset,
		).toBeNull();
	});

	it("stamps the same sampledAt on every row from one tick", () => {
		const accounts: Acct[] = [
			{ id: "a", provider: "anthropic" },
			{ id: "b", provider: "codex" },
		];
		const cache = makeCache({
			a: { ageMs: 1_000, data: usageData({ fiveHourUtil: 1 }) },
			b: { ageMs: 1_000, data: usageData({ fiveHourUtil: 2 }) },
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		expect(rows.every((r) => r.sampledAt === NOW)).toBe(true);
	});

	it("returns an empty array when there are no anthropic/codex accounts", () => {
		const accounts: Acct[] = [{ id: "zai-1", provider: "zai" }];
		const cache = makeCache({
			"zai-1": { ageMs: 1_000, data: usageData({ fiveHourUtil: 50 }) },
		});
		expect(buildSnapshotRows(accounts, cache, NOW, FRESHNESS)).toEqual([]);
	});

	it("records a row for a limits[]-only anthropic account (no flat keys)", () => {
		const fiveReset = "2023-11-14T22:13:20.000Z"; // == NOW + 100s
		const sevenReset = "2023-11-21T22:13:20.000Z";
		const accounts: Acct[] = [{ id: "limits-1", provider: "anthropic" }];
		const cache = makeCache({
			"limits-1": {
				ageMs: 1_000,
				data: {
					limits: [
						{
							kind: "session",
							group: "session",
							percent: 55,
							resets_at: fiveReset,
							scope: null,
							is_active: true,
						},
						{
							kind: "weekly_all",
							group: "weekly",
							percent: 8,
							resets_at: sevenReset,
							scope: null,
							is_active: true,
						},
					],
				} as unknown as AnyUsageData,
			},
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			accountId: "limits-1",
			provider: "anthropic",
			sampledAt: NOW,
			fiveHourPct: 55,
			fiveHourReset: new Date(fiveReset).getTime(),
			sevenDayPct: 8,
			sevenDayReset: new Date(sevenReset).getTime(),
			observedAt: NOW - 1_000,
			planTier: null,
			rateLimitTier: null,
		});
	});

	it("stamps the observation clock and the tiers as of the sample", () => {
		const accounts: Acct[] = [
			{
				id: "anth-1",
				provider: "anthropic",
				identity_plan_tier: "max",
				identity_rate_limit_tier: "20x",
			},
		];
		const cache = makeCache({
			"anth-1": { ageMs: 45_000, data: usageData({ fiveHourUtil: 42 }) },
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		expect(rows[0].observedAt).toBe(NOW - 45_000);
		expect(rows[0].planTier).toBe("max");
		expect(rows[0].rateLimitTier).toBe("20x");
	});

	it("takes the entry's observation time even when it long predates the write", () => {
		// A reading observed 3h before it was cached, but written 1s ago: the
		// freshness gate runs on the WRITE age, the row records the OBSERVATION.
		const observed = NOW - 3 * 60 * 60 * 1000;
		const accounts: Acct[] = [{ id: "codex-1", provider: "codex" }];
		const cache = makeCache({
			"codex-1": {
				ageMs: 1_000,
				observedAtMs: observed,
				data: usageData({ fiveHourUtil: 88 }),
			},
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		expect(rows).toHaveLength(1);
		expect(rows[0].sampledAt).toBe(NOW);
		expect(rows[0].observedAt).toBe(observed);
	});

	it("writes no row when the reading has no observation time (never substitutes the tick clock)", () => {
		// What `usageCache.setUntimed()` produces: a fresh WRITE whose reading was
		// observed at an unknowable time (Codex usage recovered from a retained
		// payload). Fabricating `now` here would look authoritative forever.
		const accounts: Acct[] = [
			{ id: "recovered", provider: "codex" },
			{ id: "live", provider: "anthropic" },
		];
		const cache = makeCache({
			recovered: {
				ageMs: 1_000,
				observedAtMs: null,
				data: usageData({ fiveHourUtil: 99, sevenDayUtil: 71 }),
			},
			live: { ageMs: 1_000, data: usageData({ fiveHourUtil: 12 }) },
		});

		const rows = buildSnapshotRows(accounts, cache, NOW, FRESHNESS);

		// The untimed account is an honest gap; its neighbour is unaffected.
		expect(rows.map((r) => r.accountId)).toEqual(["live"]);
	});
});

// ---------------------------------------------------------------------------
// Pure read-through behavior (via the sampler's public `tick()`)
// ---------------------------------------------------------------------------

/** Minimal Account-shaped object for the sampler's getAccounts/provider/paused. */
function acct(id: string, provider: string, paused = false): Account {
	return { id, provider, paused } as unknown as Account;
}

interface SamplerHarness {
	sampler: UsageSnapshotSampler;
	insertedRows: () => UsageSnapshotRow[];
	insertedScopedRows: () => ScopedUsageSnapshotRow[];
	snapshotQueries: () => Array<{ accountIds: string[]; sinceMs: number }>;
}

/**
 * Build a sampler with mocked deps. There is NO refresher/probe dependency —
 * the sampler is a pure read-through observer, so it only reads the supplied
 * cache and never spends quota. `storedSnapshots` is the persisted history the
 * weekly burn-slope fit regresses over (returned as-is; the real query filters
 * by `sinceMs`).
 */
function makeSampler(opts: {
	accounts: Account[];
	cache: SamplerCache;
	storedSnapshots?: () => UsageSnapshotSample[];
}): SamplerHarness {
	const inserted: UsageSnapshotRow[] = [];
	const insertedScoped: ScopedUsageSnapshotRow[] = [];
	const queries: Array<{ accountIds: string[]; sinceMs: number }> = [];
	const sampler = new UsageSnapshotSampler({
		getAccounts: async () => opts.accounts,
		insertSnapshots: async (rows) => {
			inserted.push(...rows);
		},
		insertScopedSnapshots: async (rows) => {
			insertedScoped.push(...rows);
		},
		getRecentSnapshots: async (accountIds, sinceMs) => {
			queries.push({ accountIds, sinceMs });
			return (opts.storedSnapshots?.() ?? []).filter(
				(s) => s.sampledAt >= sinceMs,
			);
		},
		cache: opts.cache,
		getFreshnessMs: () => FRESHNESS,
		getPollIntervalMs: () => 90_000,
	});
	return {
		sampler,
		insertedRows: () => inserted,
		insertedScopedRows: () => insertedScoped,
		snapshotQueries: () => queries,
	};
}

describe("buildSamplerRows scoped (per-family weekly) projection", () => {
	const RESET = "2023-11-21T22:13:20.000Z";

	it("emits one scoped row per reported family, carrying the display name", () => {
		const accounts: Acct[] = [{ id: "anth-1", provider: "anthropic" }];
		const cache = makeCache({
			"anth-1": {
				ageMs: 1_000,
				data: usageDataWithScoped(
					[
						{ displayName: "Claude Opus 5", percent: 63, resetsAt: RESET },
						{ displayName: "Claude Sonnet 4.6", percent: 12, resetsAt: RESET },
					],
					{ fiveHourUtil: 42 },
				),
			},
		});

		const { rows, scopedRows } = buildSamplerRows(
			accounts,
			cache,
			NOW,
			FRESHNESS,
		);

		expect(rows).toHaveLength(1);
		expect(scopedRows).toHaveLength(2);
		expect(scopedRows).toContainEqual({
			accountId: "anth-1",
			sampledAt: NOW,
			family: "opus",
			displayName: "Claude Opus 5",
			pct: 63,
			resetAt: new Date(RESET).getTime(),
		});
		expect(scopedRows.find((r) => r.family === "sonnet")?.displayName).toBe(
			"Claude Sonnet 4.6",
		);
	});

	it("writes nothing at all when the cache entry is stale", () => {
		const accounts: Acct[] = [{ id: "anth-1", provider: "anthropic" }];
		const cache = makeCache({
			"anth-1": {
				ageMs: FRESHNESS + 1,
				data: usageDataWithScoped([
					{ displayName: "Claude Opus 5", percent: 63, resetsAt: RESET },
				]),
			},
		});

		const { rows, scopedRows } = buildSamplerRows(
			accounts,
			cache,
			NOW,
			FRESHNESS,
		);

		expect(rows).toHaveLength(0);
		expect(scopedRows).toHaveLength(0);
	});

	it("writes nothing at all when the reading has no observation time", () => {
		// The scoped series carries only the tick clock, so an unknown observation
		// time would file these percentages under a time they were not observed at.
		const accounts: Acct[] = [{ id: "anth-1", provider: "anthropic" }];
		const cache = makeCache({
			"anth-1": {
				ageMs: 1_000,
				observedAtMs: null,
				data: usageDataWithScoped(
					[{ displayName: "Claude Opus 5", percent: 63, resetsAt: RESET }],
					{ fiveHourUtil: 42 },
				),
			},
		});

		const { rows, scopedRows } = buildSamplerRows(
			accounts,
			cache,
			NOW,
			FRESHNESS,
		);

		expect(rows).toHaveLength(0);
		expect(scopedRows).toHaveLength(0);
	});

	it("records scoped windows even when no account-wide window is reported", () => {
		const accounts: Acct[] = [{ id: "anth-1", provider: "anthropic" }];
		const cache = makeCache({
			"anth-1": {
				ageMs: 1_000,
				data: usageDataWithScoped([
					{ displayName: "Claude Fable 5", percent: 90, resetsAt: RESET },
				]),
			},
		});

		const { rows, scopedRows } = buildSamplerRows(
			accounts,
			cache,
			NOW,
			FRESHNESS,
		);

		// No 5h/7d evidence, so no account-wide row - but the scoped evidence is
		// real and must not be discarded with it.
		expect(rows).toHaveLength(0);
		expect(scopedRows).toHaveLength(1);
		expect(scopedRows[0].family).toBe("fable");
	});

	it("drops a scoped window whose reset is already in the past", () => {
		const accounts: Acct[] = [{ id: "anth-1", provider: "anthropic" }];
		const cache = makeCache({
			"anth-1": {
				ageMs: 1_000,
				data: usageDataWithScoped([
					{
						displayName: "Claude Opus 5",
						percent: 63,
						resetsAt: new Date(NOW - 1000).toISOString(),
					},
				]),
			},
		});

		const { scopedRows } = buildSamplerRows(accounts, cache, NOW, FRESHNESS);

		expect(scopedRows).toHaveLength(0);
	});
});

describe("UsageSnapshotSampler read-through tick", () => {
	it("records rows purely from the cache for both codex and anthropic", async () => {
		const h = makeSampler({
			accounts: [acct("codex-1", "codex"), acct("anth-1", "anthropic")],
			cache: makeCache({
				"codex-1": { ageMs: 1_000, data: usageData({ fiveHourUtil: 7 }) },
				"anth-1": { ageMs: 1_000, data: usageData({ fiveHourUtil: 42 }) },
			}),
		});

		await h.sampler.tick();

		const rows = h.insertedRows();
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.accountId === "codex-1")?.fiveHourPct).toBe(7);
		expect(rows.find((r) => r.accountId === "anth-1")?.fiveHourPct).toBe(42);
	});

	it("persists scoped rows from the same tick as the account-wide rows", async () => {
		// tick() stamps the real clock, so the window must reset in the FUTURE or
		// the normalizer drops it as a rolled-over window.
		const reset = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
		const h = makeSampler({
			accounts: [acct("anth-1", "anthropic")],
			cache: makeCache({
				"anth-1": {
					ageMs: 1_000,
					data: usageDataWithScoped(
						[{ displayName: "Claude Opus 5", percent: 63, resetsAt: reset }],
						{ fiveHourUtil: 42 },
					),
				},
			}),
		});

		await h.sampler.tick();

		expect(h.insertedRows()).toHaveLength(1);
		const scoped = h.insertedScopedRows();
		expect(scoped).toHaveLength(1);
		expect(scoped[0].family).toBe("opus");
		// Both series share the tick's single `now`.
		expect(scoped[0].sampledAt).toBe(h.insertedRows()[0].sampledAt);
	});

	it("writes no scoped rows when the cache is stale", async () => {
		const reset = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
		const h = makeSampler({
			accounts: [acct("anth-1", "anthropic")],
			cache: makeCache({
				"anth-1": {
					ageMs: FRESHNESS + 1,
					data: usageDataWithScoped([
						{ displayName: "Claude Opus 5", percent: 63, resetsAt: reset },
					]),
				},
			}),
		});

		await h.sampler.tick();

		expect(h.insertedRows()).toHaveLength(0);
		expect(h.insertedScopedRows()).toHaveLength(0);
	});

	it("writes an honest gap (no row) when a codex cache entry is missing", async () => {
		const h = makeSampler({
			accounts: [acct("codex-1", "codex")],
			cache: makeCache({ "codex-1": { ageMs: null, data: null } }),
		});

		await h.sampler.tick();

		expect(h.insertedRows()).toHaveLength(0);
	});

	it("writes an honest gap (no row) when a cache entry is staler than freshness", async () => {
		const h = makeSampler({
			accounts: [acct("anth-1", "anthropic")],
			cache: makeCache({
				"anth-1": {
					ageMs: FRESHNESS + 1, // just over the freshness window
					data: usageData({ fiveHourUtil: 50 }),
				},
			}),
		});

		await h.sampler.tick();

		expect(h.insertedRows()).toHaveLength(0);
	});

	it("writes an honest gap (no row, either series) when the reading has no observation time", async () => {
		const reset = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
		const h = makeSampler({
			accounts: [acct("codex-1", "codex")],
			cache: makeCache({
				"codex-1": {
					ageMs: 1_000, // freshly WRITTEN...
					observedAtMs: null, // ...but observed at an unknowable time
					data: usageDataWithScoped(
						[{ displayName: "Claude Opus 5", percent: 63, resetsAt: reset }],
						{ fiveHourUtil: 99 },
					),
				},
			}),
		});

		await h.sampler.tick();

		expect(h.insertedRows()).toHaveLength(0);
		expect(h.insertedScopedRows()).toHaveLength(0);
	});

	it("still records a PAUSED codex account with a fresh cache entry (pause is irrelevant to reading)", async () => {
		const h = makeSampler({
			accounts: [acct("codex-1", "codex", true)],
			cache: makeCache({
				"codex-1": { ageMs: 1_000, data: usageData({ fiveHourUtil: 7 }) },
			}),
		});

		await h.sampler.tick();

		const rows = h.insertedRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.accountId).toBe("codex-1");
		expect(rows[0]?.provider).toBe("codex");
		expect(rows[0]?.fiveHourPct).toBe(7);
	});

	it("writes an honest gap for a paused codex account with a missing entry", async () => {
		const h = makeSampler({
			accounts: [acct("codex-1", "codex", true)],
			cache: makeCache({ "codex-1": { ageMs: null, data: null } }),
		});

		await h.sampler.tick();

		expect(h.insertedRows()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Weekly burn-slope feed (refreshBurnSlopes)
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR_MS = 3_600_000;

// The burn-slope store is module-level state shared by every test file in one
// Bun process, so each test uses a unique account id.
let slopeSeq = 0;
const slopeAccountId = () => `sampler-slope-${slopeSeq++}`;

/**
 * A rising 7d series: `count` samples spaced `stepMs` apart ending `endsAgoMs`
 * before `base`, climbing `pctPerStep` each step. The weekly reset is constant
 * across the series (no window roll), so the whole series is one segment.
 */
function risingSeries(opts: {
	accountId: string;
	base: number;
	endsAgoMs: number;
	count: number;
	stepMs: number;
	startPct: number;
	pctPerStep: number;
	resetMs: number;
}): UsageSnapshotSample[] {
	const rows: UsageSnapshotSample[] = [];
	const newest = opts.base - opts.endsAgoMs;
	for (let i = opts.count - 1; i >= 0; i--) {
		rows.push({
			accountId: opts.accountId,
			provider: "anthropic",
			sampledAt: newest - i * opts.stepMs,
			fiveHourPct: null,
			fiveHourReset: null,
			sevenDayPct: opts.startPct + (opts.count - 1 - i) * opts.pctPerStep,
			sevenDayReset: opts.resetMs,
		});
	}
	return rows;
}

describe("UsageSnapshotSampler weekly burn-slope feed", () => {
	it("fits the 7d series from persisted snapshots and publishes it to the store", async () => {
		const now = Date.now();
		const id = slopeAccountId();
		const resetMs = now + 3 * 24 * HOUR_MS;
		// 1% per 5 minutes ⇒ 12%/h.
		const rows = risingSeries({
			accountId: id,
			base: now,
			endsAgoMs: 0,
			count: 5,
			stepMs: 5 * MINUTE,
			startPct: 40,
			pctPerStep: 1,
			resetMs,
		});
		const h = makeSampler({
			accounts: [acct(id, "anthropic")],
			cache: makeCache({}),
			storedSnapshots: () => rows,
		});

		await h.sampler.refreshBurnSlopes();
		const after = Date.now();

		const entry = getWeeklyBurnSlope(id, Date.now());
		expect(entry).not.toBeNull();
		expect(entry?.slopePctPerHour).toBeCloseTo(12, 5);
		expect(entry?.windowResetMs).toBe(resetMs);

		// The history query is bounded to the 24h lookback and asks only for the
		// windowed (anthropic/codex) accounts.
		//
		// `sinceMs` is derived from the sampler's OWN `Date.now()`, taken somewhere
		// inside the `[now, after]` bracket around the call above — so it lands in
		// `[now - 24h, after - 24h]`. Bracketing pins it exactly; the previous
		// `now - sinceMs >= 24h` floor could only hold when no millisecond
		// boundary fell between the test's read and the sampler's, which made it
		// fail ~1 full-suite run in 10. Same idiom as memory-history.test.ts.
		const q = h.snapshotQueries();
		expect(q).toHaveLength(1);
		expect(q[0]?.accountIds).toEqual([id]);
		expect(q[0]?.sinceMs).toBeGreaterThanOrEqual(now - 24 * HOUR_MS);
		expect(q[0]?.sinceMs).toBeLessThanOrEqual(after - 24 * HOUR_MS);
	});

	it("goes evidence-stale when no new snapshot has landed for >15 minutes", async () => {
		const now = Date.now();
		const id = slopeAccountId();
		const newestSampledAt = now - 16 * MINUTE;
		const rows = risingSeries({
			accountId: id,
			base: now,
			endsAgoMs: 16 * MINUTE,
			count: 5,
			stepMs: 5 * MINUTE,
			startPct: 40,
			pctPerStep: 1,
			resetMs: now + 3 * 24 * HOUR_MS,
		});
		const h = makeSampler({
			accounts: [acct(id, "anthropic")],
			cache: makeCache({}),
			storedSnapshots: () => rows,
		});

		await h.sampler.refreshBurnSlopes();

		// The SAME record read as of the newest sample is usable — freshness is
		// keyed on the evidence, and this evidence has simply aged out by now.
		expect(getWeeklyBurnSlope(id, newestSampledAt + MINUTE)).not.toBeNull();
		expect(getWeeklyBurnSlope(id, Date.now())).toBeNull();
	});

	it("bootstraps stale-on-arrival from old history, then goes live as fresh samples accrue", async () => {
		const now = Date.now();
		const id = slopeAccountId();
		const resetMs = now + 3 * 24 * HOUR_MS;
		// Restart case: everything in the DB predates the staleness bound.
		let rows = risingSeries({
			accountId: id,
			base: now,
			endsAgoMs: 40 * MINUTE,
			count: 5,
			stepMs: 5 * MINUTE,
			startPct: 40,
			pctPerStep: 1,
			resetMs,
		});
		const h = makeSampler({
			accounts: [acct(id, "anthropic")],
			cache: makeCache({}),
			storedSnapshots: () => rows,
		});

		await h.sampler.refreshBurnSlopes();
		// Fitted, but not usable: the gates keep their static fallback.
		expect(getWeeklyBurnSlope(id, Date.now())).toBeNull();

		// A fresh sample lands and the next refit becomes usable immediately.
		rows = [
			...rows,
			{
				accountId: id,
				provider: "anthropic",
				sampledAt: now,
				fiveHourPct: null,
				fiveHourReset: null,
				sevenDayPct: 52,
				sevenDayReset: resetMs,
			},
		];
		await h.sampler.refreshBurnSlopes();

		expect(getWeeklyBurnSlope(id, Date.now())).not.toBeNull();
	});

	it("does not refit an account whose newest sample has not advanced", async () => {
		const now = Date.now();
		const id = slopeAccountId();
		const resetMs = now + 3 * 24 * HOUR_MS;
		let rows = risingSeries({
			accountId: id,
			base: now,
			endsAgoMs: 0,
			count: 5,
			stepMs: 5 * MINUTE,
			startPct: 40,
			pctPerStep: 1, // 12 %/h
			resetMs,
		});
		const h = makeSampler({
			accounts: [acct(id, "anthropic")],
			cache: makeCache({}),
			storedSnapshots: () => rows,
		});

		await h.sampler.refreshBurnSlopes();
		expect(getWeeklyBurnSlope(id, Date.now())?.slopePctPerHour).toBeCloseTo(
			12,
			5,
		);

		// Same sample times, wildly different utilizations: a refit would change the
		// slope. The account is skipped, so the earlier fit stands.
		rows = rows.map((r) => ({ ...r, sevenDayPct: (r.sevenDayPct ?? 0) * 2 }));
		await h.sampler.refreshBurnSlopes();

		expect(getWeeklyBurnSlope(id, Date.now())?.slopePctPerHour).toBeCloseTo(
			12,
			5,
		);
	});

	it("refits on a tick that recorded NO fresh rows (persisted history is independent)", async () => {
		const now = Date.now();
		const id = slopeAccountId();
		const h = makeSampler({
			// Empty cache ⇒ buildSnapshotRows produces nothing and tick() early-returns
			// from its write half.
			accounts: [acct(id, "anthropic")],
			cache: makeCache({ [id]: { ageMs: null, data: null } }),
			storedSnapshots: () =>
				risingSeries({
					accountId: id,
					base: now,
					endsAgoMs: 0,
					count: 5,
					stepMs: 5 * MINUTE,
					startPct: 40,
					pctPerStep: 1,
					resetMs: now + 3 * 24 * HOUR_MS,
				}),
		});

		await h.sampler.tick();

		expect(h.insertedRows()).toHaveLength(0);
		expect(getWeeklyBurnSlope(id, Date.now())).not.toBeNull();
	});

	it("refits even when the snapshot insert fails", async () => {
		const now = Date.now();
		const id = slopeAccountId();
		const failing = new UsageSnapshotSampler({
			getAccounts: async () => [acct(id, "anthropic")],
			insertSnapshots: async () => {
				throw new Error("db down");
			},
			insertScopedSnapshots: async () => {},
			getRecentSnapshots: async () =>
				risingSeries({
					accountId: id,
					base: now,
					endsAgoMs: 0,
					count: 5,
					stepMs: 5 * MINUTE,
					startPct: 40,
					pctPerStep: 1,
					resetMs: now + 3 * 24 * HOUR_MS,
				}),
			cache: makeCache({
				[id]: { ageMs: 1_000, data: usageData({ sevenDayUtil: 44 }) },
			}),
			getFreshnessMs: () => FRESHNESS,
			getPollIntervalMs: () => 90_000,
		});

		await failing.tick();

		expect(getWeeklyBurnSlope(id, Date.now())).not.toBeNull();
	});

	it("never throws when the history read fails", async () => {
		const id = slopeAccountId();
		const sampler = new UsageSnapshotSampler({
			getAccounts: async () => [acct(id, "anthropic")],
			insertSnapshots: async () => {},
			insertScopedSnapshots: async () => {},
			getRecentSnapshots: async () => {
				throw new Error("db down");
			},
			cache: makeCache({}),
			getFreshnessMs: () => FRESHNESS,
			getPollIntervalMs: () => 90_000,
		});

		await sampler.refreshBurnSlopes();
		expect(getWeeklyBurnSlope(id, Date.now())).toBeNull();
	});

	it("ignores providers that have no windowed usage series", async () => {
		const id = slopeAccountId();
		const h = makeSampler({
			accounts: [acct(id, "zai")],
			cache: makeCache({}),
			storedSnapshots: () => [],
		});

		await h.sampler.refreshBurnSlopes();

		expect(h.snapshotQueries()).toHaveLength(0);
	});
});
