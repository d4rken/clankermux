import { describe, expect, it } from "bun:test";
import {
	createMemoizedPublicSnapshotReader,
	PUBLIC_SNAPSHOT_TTL_MS,
	type PublicSnapshot,
} from "../public-snapshot";

/**
 * The memo in front of `GET /public/v1/status` and `GET /public/v1/accounts`.
 *
 * These two were the routes on this surface with NO memo at all: every
 * anonymous GET queried every account and then ran `buildPredictionsForAccounts`
 * over up to 24 h of stored usage snapshots, one regression per account. Both
 * are polled by a desk panel and a panel applet, and neither can be asked for a
 * credential, so the poll rate was the load.
 *
 * Driven through an injected reader rather than a database: what is pinned here
 * is the memo, and standing up the account query would test the query.
 */

const NOW = 1_700_000_000_000;

function snapshot(nowMs: number): PublicSnapshot {
	return {
		nowMs,
		pool: {
			configured: 0,
			defaultRoutable: 0,
			paused: 0,
			rateLimited: 0,
			usageExhausted: 0,
			nextAvailableAtMs: null,
		},
		routing: {
			context: "fresh_unpinned_nominal",
			defaultCandidateAccountId: null,
		},
		usage: {
			fiveHour: {
				meanUtilizationPct: null,
				contributingAccountCount: 0,
				unknownAccountCount: 0,
				earliestResetsAtMs: null,
				leastUsedUtilizationPct: null,
				leastUsedAccountId: null,
			},
			sevenDay: {
				meanUtilizationPct: null,
				contributingAccountCount: 0,
				unknownAccountCount: 0,
				earliestResetsAtMs: null,
				leastUsedUtilizationPct: null,
				leastUsedAccountId: null,
			},
			worstAccountUtilizationPct: null,
		},
		providers: [],
		accounts: [],
	};
}

describe("the public snapshot memo", () => {
	it("builds the pool once for a burst of polls inside the TTL", async () => {
		let builds = 0;
		let clock = NOW;
		const read = createMemoizedPublicSnapshotReader(
			async (now = clock) => {
				builds++;
				return snapshot(now);
			},
			{ now: () => clock },
		);

		await read();
		clock = NOW + PUBLIC_SNAPSHOT_TTL_MS - 1;
		const second = await read();

		expect(builds).toBe(1);
		// `generatedAt` is derived from this, so it stays the instant the data
		// describes rather than the instant it was served.
		expect(second.nowMs).toBe(NOW);
	});

	it("rebuilds once the TTL has passed", async () => {
		let builds = 0;
		let clock = NOW;
		const read = createMemoizedPublicSnapshotReader(
			async (now = clock) => {
				builds++;
				return snapshot(now);
			},
			{ now: () => clock },
		);

		await read();
		clock = NOW + PUBLIC_SNAPSHOT_TTL_MS;
		const second = await read();

		expect(builds).toBe(2);
		expect(second.nowMs).toBe(clock);
	});

	it("keeps the TTL short enough for a panel poll", () => {
		// Seconds, not the minute the projections get: this pair is what a desk
		// panel polls, and the memo is here to bound the COST of that loop rather
		// than to slow the reading down.
		expect(PUBLIC_SNAPSHOT_TTL_MS).toBeLessThanOrEqual(10_000);
	});

	it("collapses concurrent cold polls onto one build", async () => {
		let builds = 0;
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = createMemoizedPublicSnapshotReader(
			async (now = NOW) => {
				builds++;
				await gate;
				return snapshot(now);
			},
			{ now: () => NOW },
		);

		const polls = Promise.all([read(), read(), read()]);
		release?.();
		await polls;

		expect(builds).toBe(1);
	});

	it("backs a failed build off rather than retrying it every poll", async () => {
		let builds = 0;
		let clock = NOW;
		const read = createMemoizedPublicSnapshotReader(
			async () => {
				builds++;
				throw new Error("account query failed");
			},
			{ now: () => clock, failureTtlMs: 5_000 },
		);

		await expect(read()).rejects.toThrow("account query failed");
		clock = NOW + 4_999;
		await expect(read()).rejects.toThrow("account query failed");

		expect(builds).toBe(1);
	});

	it("retries the build once the negative TTL has passed", async () => {
		let builds = 0;
		let clock = NOW;
		const read = createMemoizedPublicSnapshotReader(
			async (now = clock) => {
				builds++;
				if (builds === 1) throw new Error("account query failed");
				return snapshot(now);
			},
			{ now: () => clock, failureTtlMs: 5_000 },
		);

		await expect(read()).rejects.toThrow("account query failed");
		clock = NOW + 5_000;
		expect((await read()).nowMs).toBe(NOW + 5_000);
		expect(builds).toBe(2);
	});
});
