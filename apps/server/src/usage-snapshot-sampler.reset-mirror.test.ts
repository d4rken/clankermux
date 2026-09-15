/**
 * The reset mirror: `accounts.rate_limit_reset` for providers that report no
 * rate-limit headers.
 *
 * Z.AI never populates the column through the request path —
 * `persistRateLimitStatusMeta` returns early without a status header and
 * `ZaiProvider.parseRateLimit` never sets one — so before this mirror existed it
 * stayed NULL for the account's whole life. Two consumers read that NULL as a
 * fact rather than an absence: `bindingWindowResetElapsed` treats it as "the
 * window already rolled" and primes the account every cooldown forever (44
 * synthetic completions in 24h against an account at 1% utilization).
 *
 * The mirror is scoped to ACTIVE accounts and compare-and-sets on the value the
 * tick read. That bounds WHEN it writes, not what happens to the value
 * afterwards: pausing preserves `rate_limit_reset`, so a reset written while an
 * account was active outlives a later pause and the two paused-account readers
 * (`isAutoUnpauseCandidate`, `stampStaleResetIfStranded`) can still consume it.
 * What keeps them inert for Z.AI is their own `isSelfHealingPauseReason` gate,
 * which no reachable Z.AI pause satisfies.
 */
import { describe, expect, it } from "bun:test";
import type { AnyUsageData, UsageData } from "@clankermux/providers";
import type {
	Account,
	ScopedUsageSnapshotRow,
	UsageSnapshotRow,
} from "@clankermux/types";
import {
	type SamplerCache,
	UsageSnapshotSampler,
} from "./usage-snapshot-sampler";

const NOW = 1_700_000_000_000;
const FRESHNESS = 150_000;
const FIVE_RESET = NOW + 100_000;
const SEVEN_RESET = NOW + 3 * 24 * 60 * 60 * 1000;

function makeCache(
	entries: Record<string, { data: AnyUsageData; ageMs: number }>,
): SamplerCache {
	return {
		peekWithAge(id: string) {
			const e = entries[id];
			if (!e) return null;
			return { data: e.data, ageMs: e.ageMs, observedAtMs: NOW - e.ageMs };
		},
	};
}

/**
 * Z.AI's own window names. `percentage` matters: the mirrored reset comes from
 * `extractWindowResetTime`, whose zai arm picks the window with the HIGHEST
 * percentage (ties broken by the later reset), not the earlier boundary.
 */
function zaiUsage(
	opts: { fiveHourPct?: number; sevenDayPct?: number } = {},
): AnyUsageData {
	return {
		tokens_limit: {
			used: 1,
			remaining: 99,
			percentage: opts.fiveHourPct ?? 1,
			resetAt: FIVE_RESET,
			type: "tokens_limit",
		},
		tokens_limit_weekly: {
			used: 1,
			remaining: 99,
			percentage: opts.sevenDayPct ?? 1,
			resetAt: SEVEN_RESET,
			type: "tokens_limit_weekly",
		},
	} as unknown as AnyUsageData;
}

function anthropicUsage(): UsageData {
	return {
		five_hour: {
			utilization: 10,
			resets_at: new Date(FIVE_RESET).toISOString(),
		},
	} as UsageData;
}

function account(
	id: string,
	provider: string,
	rateLimitReset: number | null = null,
	paused = false,
): Account {
	return {
		id,
		provider,
		paused,
		rate_limit_reset: rateLimitReset,
	} as unknown as Account;
}

interface Harness {
	sampler: UsageSnapshotSampler;
	resetWrites: () => Array<{
		accountId: string;
		resetMs: number;
		expectedReset: number | null;
	}>;
	insertedRows: () => UsageSnapshotRow[];
}

function makeSampler(opts: {
	accounts: Account[];
	cache: SamplerCache;
	onPersistWindowReset?: () => Promise<void>;
	/** CAS outcome the fake write reports back (default: it landed). */
	writeLands?: boolean;
}): Harness {
	const resetWrites: Array<{
		accountId: string;
		resetMs: number;
		expectedReset: number | null;
	}> = [];
	const inserted: UsageSnapshotRow[] = [];
	const sampler = new UsageSnapshotSampler({
		getAccounts: async () => opts.accounts,
		insertSnapshots: async (rows) => {
			inserted.push(...rows);
		},
		insertScopedSnapshots: async (_rows: ScopedUsageSnapshotRow[]) => {},
		persistWindowReset: async (accountId, resetMs, expectedReset) => {
			resetWrites.push({ accountId, resetMs, expectedReset });
			await opts.onPersistWindowReset?.();
			return opts.writeLands ?? true;
		},
		getRecentSnapshots: async () => [],
		cache: opts.cache,
		getFreshnessMs: () => FRESHNESS,
		getPollIntervalMs: () => 90_000,
	});
	return {
		sampler,
		resetWrites: () => resetWrites,
		insertedRows: () => inserted,
	};
}

describe("UsageSnapshotSampler — window reset mirror", () => {
	it("writes the representative window's reset when the column is null", async () => {
		const h = makeSampler({
			accounts: [account("zai-1", "zai")],
			cache: makeCache({ "zai-1": { ageMs: 1_000, data: zaiUsage() } }),
		});

		await h.sampler.tick();

		// Equal percentages, so the LATER reset wins the tie. Taking the earlier
		// boundary here would open the prime gate while the weekly window, which
		// is just as used, is still running.
		expect(h.resetWrites()).toEqual([
			{ accountId: "zai-1", resetMs: SEVEN_RESET, expectedReset: null },
		]);
	});

	/**
	 * The case that makes earliest-of wrong. Z.AI's reset order is not its
	 * duration order, so the lightly-used window can be the one that resets
	 * first; mirroring its boundary would mark the account due for a prime while
	 * the window actually near its limit still has hours to run.
	 */
	it("follows utilization, not which boundary comes first", async () => {
		const h = makeSampler({
			accounts: [account("zai-1", "zai")],
			cache: makeCache({
				"zai-1": {
					ageMs: 1_000,
					data: zaiUsage({ fiveHourPct: 10, sevenDayPct: 95 }),
				},
			}),
		});

		await h.sampler.tick();

		expect(h.resetWrites()).toEqual([
			{ accountId: "zai-1", resetMs: SEVEN_RESET, expectedReset: null },
		]);
	});

	it("takes the sooner boundary when that window is the used one", async () => {
		const h = makeSampler({
			accounts: [account("zai-1", "zai")],
			cache: makeCache({
				"zai-1": {
					ageMs: 1_000,
					data: zaiUsage({ fiveHourPct: 95, sevenDayPct: 10 }),
				},
			}),
		});

		await h.sampler.tick();

		expect(h.resetWrites()).toEqual([
			{ accountId: "zai-1", resetMs: FIVE_RESET, expectedReset: null },
		]);
	});

	/**
	 * The write is the signal the prime gate reads. Re-issuing it on every
	 * 2-minute tick would rewrite the column for every mirrored account for as
	 * long as its window runs.
	 */
	it("does not rewrite a column that already holds the observed reset", async () => {
		const h = makeSampler({
			accounts: [account("zai-1", "zai", SEVEN_RESET)],
			cache: makeCache({ "zai-1": { ageMs: 1_000, data: zaiUsage() } }),
		});

		await h.sampler.tick();

		expect(h.resetWrites()).toEqual([]);
	});

	it("writes again once the window rolls to a new boundary", async () => {
		const previousWindow = SEVEN_RESET - 7 * 24 * 60 * 60 * 1000;
		const h = makeSampler({
			accounts: [account("zai-1", "zai", previousWindow)],
			cache: makeCache({ "zai-1": { ageMs: 1_000, data: zaiUsage() } }),
		});

		await h.sampler.tick();

		expect(h.resetWrites()).toEqual([
			{
				accountId: "zai-1",
				resetMs: SEVEN_RESET,
				expectedReset: previousWindow,
			},
		]);
	});

	/**
	 * Anthropic gets the column from unified response headers and Codex from its
	 * own observation path; mirroring them here would overwrite header-derived
	 * evidence with a cache reading.
	 */
	it("leaves providers that have their own writer alone", async () => {
		const h = makeSampler({
			accounts: [account("anth-1", "anthropic"), account("codex-1", "codex")],
			cache: makeCache({
				"anth-1": { ageMs: 1_000, data: anthropicUsage() },
				"codex-1": { ageMs: 1_000, data: anthropicUsage() },
			}),
		});

		await h.sampler.tick();

		expect(h.resetWrites()).toEqual([]);
	});

	/** The mirror inherits the series' freshness gate — no stale write-backs. */
	it("writes nothing from a stale cache entry", async () => {
		const h = makeSampler({
			accounts: [account("zai-1", "zai")],
			cache: makeCache({
				"zai-1": { ageMs: FRESHNESS + 60_000, data: zaiUsage() },
			}),
		});

		await h.sampler.tick();

		expect(h.resetWrites()).toEqual([]);
	});

	/**
	 * A paused account is left entirely alone. Both remaining readers of this
	 * column — `isAutoUnpauseCandidate` and `stampStaleResetIfStranded` — return
	 * early unless the account is paused, and neither has ever seen a non-null
	 * reset for a mirrored provider. Writing one here would hand them evidence
	 * this sampler cannot vouch for.
	 */
	it("does not mirror a paused account", async () => {
		const h = makeSampler({
			accounts: [account("zai-1", "zai", null, true)],
			cache: makeCache({ "zai-1": { ageMs: 1_000, data: zaiUsage() } }),
		});

		await h.sampler.tick();

		expect(h.resetWrites()).toEqual([]);
		// The account is still a normal member of the history series.
		expect(h.insertedRows()).toHaveLength(1);
	});

	/**
	 * Losing the compare-and-set is a normal outcome, not an error: something
	 * with newer evidence wrote the column between this tick's account read and
	 * its write. The tick must carry on and leave the retry to the next one.
	 */
	it("carries on when the compare-and-set does not land", async () => {
		const h = makeSampler({
			accounts: [account("zai-1", "zai")],
			cache: makeCache({ "zai-1": { ageMs: 1_000, data: zaiUsage() } }),
			writeLands: false,
		});

		await h.sampler.tick();

		expect(h.resetWrites()).toHaveLength(1);
		expect(h.insertedRows()).toHaveLength(1);
	});

	/** A DB error must not kill the interval or suppress the series writes. */
	it("still records the series when the mirror write throws", async () => {
		const h = makeSampler({
			accounts: [account("zai-1", "zai")],
			cache: makeCache({ "zai-1": { ageMs: 1_000, data: zaiUsage() } }),
			onPersistWindowReset: async () => {
				throw new Error("db down");
			},
		});

		await h.sampler.tick();

		expect(h.insertedRows()).toHaveLength(1);
	});
});
