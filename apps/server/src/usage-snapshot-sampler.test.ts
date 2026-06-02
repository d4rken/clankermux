/**
 * Tests for the PURE `buildSnapshotRows` helper that turns the in-memory usage
 * cache into write-ready `UsageSnapshotRow`s for the rate-limit "sawtooth"
 * time-series, plus the sampler's Codex-probe retry/skip behavior driven through
 * its public `tick()`. The timer/scheduling path is still exercised via
 * integration in the running server.
 */
import { describe, expect, it } from "bun:test";
import type { AnyUsageData, UsageData } from "@clankermux/providers";
import type { CodexUsageRefreshOutcome } from "@clankermux/proxy";
import type { Account, UsageSnapshotRow } from "@clankermux/types";
import {
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
}

/** Minimal SamplerCache backed by a plain map of accountId → {data, age}. */
function makeCache(entries: Record<string, SeedEntry>): SamplerCache {
	return {
		get(id: string): AnyUsageData | null {
			return entries[id]?.data ?? null;
		},
		getAge(id: string): number | null {
			const e = entries[id];
			return e ? e.ageMs : null;
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

interface Acct {
	id: string;
	provider: string;
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
});

// ---------------------------------------------------------------------------
// Codex probe behavior (via the sampler's public `tick()`)
// ---------------------------------------------------------------------------

/** Minimal Account-shaped object for the sampler's getAccounts/provider/paused. */
function acct(id: string, provider: string, paused = false): Account {
	return { id, provider, paused } as unknown as Account;
}

interface SamplerHarness {
	sampler: UsageSnapshotSampler;
	probeCalls: () => number;
	insertedRows: () => UsageSnapshotRow[];
}

/**
 * Build a sampler with mocked deps. `refreshCodex` counts calls and returns the
 * supplied outcomes in sequence (last one repeats). `codexProbeRetryDelayMs: 0`
 * keeps retries instant.
 */
function makeSampler(opts: {
	accounts: Account[];
	cache: SamplerCache;
	outcomes: CodexUsageRefreshOutcome[];
}): SamplerHarness {
	let calls = 0;
	const inserted: UsageSnapshotRow[] = [];
	const sampler = new UsageSnapshotSampler({
		getAccounts: async () => opts.accounts,
		insertSnapshots: async (rows) => {
			inserted.push(...rows);
		},
		cache: opts.cache,
		refreshCodex: async () => {
			const outcome = opts.outcomes[Math.min(calls, opts.outcomes.length - 1)];
			calls++;
			return outcome ?? { success: false, message: "no outcome" };
		},
		getFreshnessMs: () => FRESHNESS,
		getPollIntervalMs: () => 90_000,
		codexProbeRetryDelayMs: 0,
	});
	return {
		sampler,
		probeCalls: () => calls,
		insertedRows: () => inserted,
	};
}

describe("UsageSnapshotSampler Codex probe", () => {
	it("retries once when the probe returns no usage (success:false)", async () => {
		const h = makeSampler({
			accounts: [acct("codex-1", "codex")],
			cache: makeCache({ "codex-1": { ageMs: null, data: null } }),
			outcomes: [
				{ success: false, message: "no headers" },
				{ success: false, message: "no headers" },
			],
		});

		await h.sampler.tick();

		// 1 initial attempt + 1 retry = 2 calls; no row (cache empty).
		expect(h.probeCalls()).toBe(2);
		expect(h.insertedRows()).toHaveLength(0);
	});

	it("does not retry when the first probe succeeds", async () => {
		const h = makeSampler({
			accounts: [acct("codex-1", "codex")],
			cache: makeCache({
				// After a successful probe the real cache is warm; simulate fresh data.
				"codex-1": { ageMs: 1_000, data: usageData({ fiveHourUtil: 7 }) },
			}),
			outcomes: [{ success: true, message: "ok" }],
		});

		await h.sampler.tick();

		expect(h.probeCalls()).toBe(1);
		// Fresh codex data → a row is recorded.
		const rows = h.insertedRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.accountId).toBe("codex-1");
		expect(rows[0]?.provider).toBe("codex");
		expect(rows[0]?.fiveHourPct).toBe(7);
	});

	it("never probes a paused Codex account (avoids spend)", async () => {
		const h = makeSampler({
			accounts: [acct("codex-1", "codex", true)],
			cache: makeCache({ "codex-1": { ageMs: null, data: null } }),
			outcomes: [{ success: true, message: "ok" }],
		});

		await h.sampler.tick();

		expect(h.probeCalls()).toBe(0);
		expect(h.insertedRows()).toHaveLength(0);
	});
});
