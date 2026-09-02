import { describe, expect, it } from "bun:test";
import { FIXED_WINDOW_DURATION_MS } from "@clankermux/core";
import type {
	Account,
	RankedScopedSnapshot,
	UsageScopedHistoryResponse,
} from "@clankermux/types";
import {
	createUsageScopedHistoryHandlerFromSources,
	type UsageScopedHistorySources,
} from "../usage-scoped-history-direct";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** An hour-aligned "now" so the hourly bucket grid lands on round numbers. */
const NOW_ALIGNED = Math.floor(1_700_000_000_000 / HOUR) * HOUR;

function makeAccount(id: string, name: string, provider: string): Account {
	return { id, name, provider } as Account;
}

function snapshot(
	partial: Partial<RankedScopedSnapshot>,
): RankedScopedSnapshot {
	const ts = partial.ts ?? NOW_ALIGNED;
	return {
		accountId: "acct-a",
		family: "fable",
		displayName: "Fable",
		pct: 10,
		resetAt: null,
		...partial,
		ts,
		// The raw sample time defaults to the bucket start, so a fixture that
		// only cares about buckets reads the same as before the field existed.
		sampledAt: partial.sampledAt ?? ts,
	};
}

/**
 * Mock UsageScopedHistorySources — the seam the direct handler reads through
 * (repositories on the dashboard worker's read-only connection in production).
 * `nowMs` defaults to the fixture's newest sample, i.e. "the range ends where
 * the data ends"; pass it explicitly to put buckets after the last sample.
 */
function createSources(opts: {
	snapshots: RankedScopedSnapshot[];
	accounts: Account[];
	predecessors?: RankedScopedSnapshot[];
	nowMs?: number;
	captureOpts?: (o: { sinceMs: number; bucketMs: number }) => void;
	/** Captures the (cutoff, lookback) the handler asks the predecessor read for. */
	capturePredecessorArgs?: (a: {
		beforeMs: number;
		lookbackMs: number;
	}) => void;
}): UsageScopedHistorySources {
	const samples = [...opts.snapshots, ...(opts.predecessors ?? [])];
	const pinnedNow =
		opts.nowMs ??
		(samples.length === 0 ? undefined : Math.max(...samples.map((r) => r.ts)));
	return {
		getScopedSnapshots: async (o) => {
			opts.captureOpts?.(o);
			return opts.snapshots;
		},
		getLatestScopedSnapshotsBefore: async (beforeMs, lookbackMs) => {
			opts.capturePredecessorArgs?.({ beforeMs, lookbackMs });
			return opts.predecessors ?? [];
		},
		getAllAccounts: async () => opts.accounts,
		...(pinnedNow === undefined ? {} : { now: () => pinnedNow }),
	};
}

async function callHandler(
	sources: UsageScopedHistorySources,
	range?: string,
): Promise<{ status: number; body: UsageScopedHistoryResponse }> {
	const handler = createUsageScopedHistoryHandlerFromSources(sources);
	const params = new URLSearchParams();
	if (range !== undefined) params.set("range", range);
	const res = await handler(params);
	return {
		status: res.status,
		body: (await res.json()) as UsageScopedHistoryResponse,
	};
}

describe("usage-scoped-history handler", () => {
	describe("range → bucket mapping", () => {
		it("maps 6h → bucketMs 300000", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const sources = createSources({
				snapshots: [],
				accounts: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(sources, "6h");
			expect(captured?.bucketMs).toBe(300_000);
			expect(body.bucketMs).toBe(300_000);
			expect(body.range).toBe("6h");
		});

		it("defaults to 7d and falls back to it for an invalid range", async () => {
			const sources = createSources({ snapshots: [], accounts: [] });
			expect((await callHandler(sources)).body.range).toBe("7d");
			expect((await callHandler(sources, "bogus")).body.range).toBe("7d");
		});

		it("returns no families for an empty database", async () => {
			const { status, body } = await callHandler(
				createSources({ snapshots: [], accounts: [] }),
				"1h",
			);
			expect(status).toBe(200);
			expect(body.families).toEqual([]);
		});
	});

	describe("family grouping", () => {
		it("returns one entry per recorded family, sorted by family", async () => {
			const sources = createSources({
				snapshots: [
					snapshot({ family: "opus", displayName: "Claude Opus 5", pct: 30 }),
					snapshot({ family: "fable", displayName: "Fable", pct: 60 }),
				],
				accounts: [makeAccount("acct-a", "Alpha", "anthropic")],
			});

			const { body } = await callHandler(sources, "24h");

			expect(body.families.map((f) => f.family)).toEqual(["fable", "opus"]);
			expect(body.families.map((f) => f.displayName)).toEqual([
				"Fable",
				"Claude Opus 5",
			]);
		});

		it("labels a family from its most recent row, not its first", async () => {
			// The family key is lossy across generations: the label has to follow
			// the generation currently in force.
			const sources = createSources({
				snapshots: [
					snapshot({
						ts: NOW_ALIGNED - HOUR,
						family: "opus",
						displayName: "Claude Opus 4.8",
					}),
					snapshot({
						ts: NOW_ALIGNED,
						family: "opus",
						displayName: "Claude Opus 5",
					}),
				],
				accounts: [makeAccount("acct-a", "Alpha", "anthropic")],
			});

			const { body } = await callHandler(sources, "24h");

			expect(body.families[0]?.displayName).toBe("Claude Opus 5");
		});

		it("resolves account identity from the accounts list", async () => {
			// The scoped table stores no provider column.
			const sources = createSources({
				snapshots: [snapshot({ accountId: "acct-a" })],
				accounts: [makeAccount("acct-a", "Alpha", "anthropic")],
			});

			const { body } = await callHandler(sources, "24h");

			const series = body.families[0]?.series[0];
			expect(series?.name).toBe("Alpha");
			expect(series?.provider).toBe("anthropic");
		});

		it("keeps history for an account that no longer exists", async () => {
			const sources = createSources({
				snapshots: [snapshot({ accountId: "ghost" })],
				accounts: [],
			});

			const { body } = await callHandler(sources, "24h");

			const series = body.families[0]?.series[0];
			expect(series?.accountId).toBe("ghost");
			expect(series?.name).toBe("ghost");
			expect(series?.provider).toBe("unknown");
		});
	});

	describe("carry-forward and pool aggregation", () => {
		const rangeStart = NOW_ALIGNED - DAY;

		it("holds a value across gap buckets until its window resets", async () => {
			const sources = createSources({
				snapshots: [
					snapshot({
						accountId: "main",
						ts: rangeStart,
						pct: 100,
						resetAt: rangeStart + 3 * HOUR,
					}),
				],
				accounts: [makeAccount("main", "Main-me", "anthropic")],
				nowMs: NOW_ALIGNED,
			});

			const { body } = await callHandler(sources, "24h");

			const family = body.families[0];
			expect(family?.series[0]?.points.map((p) => p.ts)).toEqual([
				rangeStart,
				rangeStart + HOUR,
				rangeStart + 2 * HOUR,
			]);
			expect(family?.series[0]?.points.map((p) => p.pct)).toEqual([
				100, 100, 100,
			]);
			// The grid runs to the current bucket, so the hold has a bucket to
			// expire on instead of freezing at the right edge.
			expect(family?.pool).toHaveLength(25);
			expect(family?.pool[3]?.avg).toBeNull();
			expect(family?.pool[3]?.sampledCount).toBe(0);
			expect(family?.pool[family.pool.length - 1]?.ts).toBe(NOW_ALIGNED);
		});

		it("seeds the range start from the reading in force before it", async () => {
			const sources = createSources({
				snapshots: [],
				predecessors: [
					snapshot({
						accountId: "main",
						ts: rangeStart - 10 * 60 * 1000,
						pct: 80,
						resetAt: rangeStart + 2 * HOUR,
					}),
				],
				accounts: [makeAccount("main", "Main-me", "anthropic")],
				nowMs: NOW_ALIGNED,
			});

			const { body } = await callHandler(sources, "24h");

			const family = body.families[0];
			expect(family?.family).toBe("fable");
			expect(family?.series[0]?.points.map((p) => p.ts)).toEqual([
				rangeStart,
				rangeStart + HOUR,
			]);
			expect(family?.pool[0]?.avg).toBe(80);
		});

		it("averages and maxes the accounts reporting in each bucket", async () => {
			const sources = createSources({
				snapshots: [
					snapshot({ accountId: "a", ts: NOW_ALIGNED - HOUR, pct: 20 }),
					snapshot({ accountId: "b", ts: NOW_ALIGNED - HOUR, pct: 60 }),
					// Only `a` reports in the last bucket; `b` is carried at 60.
					snapshot({ accountId: "a", ts: NOW_ALIGNED, pct: 40 }),
				],
				accounts: [
					makeAccount("a", "Alpha", "anthropic"),
					makeAccount("b", "Beta", "anthropic"),
				],
			});

			const { body } = await callHandler(sources, "24h");

			const pool = body.families[0]?.pool ?? [];
			expect(pool.map((p) => p.avg)).toEqual([40, 50]);
			expect(pool.map((p) => p.max)).toEqual([60, 60]);
			expect(pool.map((p) => p.sampledCount)).toEqual([2, 2]);
		});

		it("keeps each family on its own grid and pool", async () => {
			const sources = createSources({
				snapshots: [
					snapshot({
						accountId: "a",
						ts: NOW_ALIGNED - HOUR,
						family: "fable",
						displayName: "Fable",
						pct: 70,
					}),
					snapshot({
						accountId: "a",
						ts: NOW_ALIGNED,
						family: "opus",
						displayName: "Claude Opus 5",
						pct: 10,
					}),
				],
				accounts: [makeAccount("a", "Alpha", "anthropic")],
			});

			const { body } = await callHandler(sources, "24h");

			const fable = body.families.find((f) => f.family === "fable");
			const opus = body.families.find((f) => f.family === "opus");
			// Fable's evidence starts an hour earlier, so its grid does too; Opus
			// is not back-filled with an empty bucket it never reported in.
			expect(fable?.pool.map((p) => p.ts)).toEqual([
				NOW_ALIGNED - HOUR,
				NOW_ALIGNED,
			]);
			expect(opus?.pool.map((p) => p.ts)).toEqual([NOW_ALIGNED]);
			expect(opus?.pool[0]?.avg).toBe(10);
		});
	});
});

describe("usage-scoped-history handler — predecessor lookback bound", () => {
	it("asks for at most one scoped weekly window before the range start", async () => {
		let captured: { beforeMs: number; lookbackMs: number } | null = null;
		const sources = createSources({
			snapshots: [],
			accounts: [],
			nowMs: NOW_ALIGNED,
			capturePredecessorArgs: (a) => {
				captured = a;
			},
		});

		await callHandler(sources, "24h");

		expect(captured).toEqual({
			beforeMs: NOW_ALIGNED - DAY,
			lookbackMs: FIXED_WINDOW_DURATION_MS.seven_day_scoped,
		});
	});

	it("does not run the predecessor read at all for range=all", async () => {
		let calls = 0;
		const sources = createSources({
			snapshots: [],
			accounts: [],
			nowMs: NOW_ALIGNED,
			capturePredecessorArgs: () => {
				calls += 1;
			},
		});

		await callHandler(sources, "all");

		expect(calls).toBe(0);
	});
});

describe("usage-scoped-history handler — expired predecessor-only family", () => {
	const sinceMs = NOW_ALIGNED - 7 * DAY;

	it("emits no family when its only evidence is a predecessor that reset before the range began", async () => {
		const sources = createSources({
			snapshots: [],
			predecessors: [
				snapshot({
					accountId: "main",
					family: "fable",
					displayName: "Fable",
					ts: sinceMs - 2 * HOUR,
					pct: 30,
					resetAt: sinceMs - HOUR,
				}),
			],
			accounts: [makeAccount("main", "Main-me", "anthropic")],
			nowMs: NOW_ALIGNED,
		});

		const { body } = await callHandler(sources, "7d");

		expect(body.families.map((f) => f.family)).toEqual([]);
		expect(body.families).toEqual([]);
	});

	it("control: a predecessor still in force at the range start seeds the first bucket", async () => {
		const sources = createSources({
			snapshots: [],
			predecessors: [
				snapshot({
					accountId: "main",
					family: "fable",
					displayName: "Fable",
					ts: sinceMs - 2 * HOUR,
					pct: 30,
					resetAt: sinceMs + DAY,
				}),
			],
			accounts: [makeAccount("main", "Main-me", "anthropic")],
			nowMs: NOW_ALIGNED,
		});

		const { body } = await callHandler(sources, "7d");

		expect(body.families).toHaveLength(1);
		expect(body.families[0]?.series).toHaveLength(1);
		expect(body.families[0]?.series[0]?.points[0]).toEqual({
			ts: sinceMs,
			pct: 30,
		});
	});
});

describe("usage-scoped-history handler — displayName by sample recency", () => {
	it("labels a family from the most recently SAMPLED row when two accounts share a bucket", async () => {
		// Same 12:00 bucket for both accounts. Rows arrive in the repository's
		// `ts, family, account_id` order, so the stale-generation account (id
		// "zzz-stale", sampled 12:05) is iterated AFTER the fresh one (id
		// "aaa-fresh", sampled 12:55). The label must follow the later sample.
		const sources = createSources({
			snapshots: [
				snapshot({
					accountId: "aaa-fresh",
					ts: NOW_ALIGNED,
					sampledAt: NOW_ALIGNED + 55 * MINUTE,
					family: "opus",
					displayName: "Claude Opus 5",
					pct: 20,
				}),
				snapshot({
					accountId: "zzz-stale",
					ts: NOW_ALIGNED,
					sampledAt: NOW_ALIGNED + 5 * MINUTE,
					family: "opus",
					displayName: "Claude Opus 4.8",
					pct: 50,
				}),
			],
			accounts: [
				makeAccount("aaa-fresh", "Fresh", "anthropic"),
				makeAccount("zzz-stale", "Stale", "anthropic"),
			],
		});

		const { body } = await callHandler(sources, "24h");

		expect(body.families[0]?.family).toBe("opus");
		expect(body.families[0]?.displayName).toBe("Claude Opus 5");
	});
});
