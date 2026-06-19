/**
 * Tests for the PURE `buildCacheKeepaliveSnapshotRow` helper that maps the live
 * session-cache gauges plus the cumulative bridge-stats counters into a
 * write-ready `CacheKeepaliveSnapshotRow` for the keepalive economics
 * time-series, plus a light check of the sampler's tick → insert wiring through
 * mocked deps. The timer/scheduling path is exercised via integration in the
 * running server (mirrors usage-snapshot-sampler.test.ts).
 */
import { describe, expect, it } from "bun:test";
import type { CacheKeepaliveSnapshotRow } from "@clankermux/database";
import type { BridgeStatsSnapshot } from "@clankermux/proxy";
import {
	buildCacheKeepaliveSnapshotRow,
	CacheKeepaliveSnapshotSampler,
} from "./cache-keepalive-snapshot-sampler";

const NOW = 1_700_000_000_000; // fixed "now" for deterministic sampledAt

/** A full bridge-stats snapshot with caller-overridable counters. */
function stats(
	overrides: Partial<BridgeStatsSnapshot> = {},
): BridgeStatsSnapshot {
	return {
		keepalivesSent: 0,
		hits: 0,
		misses: 0,
		failures: 0,
		warmResumes: 0,
		spentUsd: 0,
		savedUsd: 0,
		savedUsdConservative: 0,
		netUsd: 0,
		netUsdConservative: 0,
		hitRate: 0,
		...overrides,
	};
}

describe("buildCacheKeepaliveSnapshotRow", () => {
	it("maps gauges + stats counters into a row stamped with `now`", () => {
		const gauges = { warmSessions: 5, promotedSessions: 2, totalBytes: 4096 };
		const s = stats({
			keepalivesSent: 30,
			hits: 24,
			misses: 6,
			failures: 1,
			spentUsd: 0.12,
			savedUsd: 0.9,
			savedUsdConservative: 0.55,
			warmResumes: 11,
			// netUsd / netUsdConservative / hitRate are present on the snapshot but
			// derivable on read, so the mapper must NOT carry them into the row.
			netUsd: 0.78,
			netUsdConservative: 0.43,
			hitRate: 0.8,
		});

		const row = buildCacheKeepaliveSnapshotRow(NOW, gauges, s);

		expect(row).toEqual({
			sampledAt: NOW,
			warmSessions: 5,
			promotedSessions: 2,
			totalBytes: 4096,
			keepalivesSent: 30,
			hits: 24,
			misses: 6,
			failures: 1,
			spentUsd: 0.12,
			savedUsd: 0.9,
			warmResumes: 11,
			savedUsd5m: 0.55,
		} satisfies CacheKeepaliveSnapshotRow);
	});

	it("records an all-zero row when nothing has happened (continuous series)", () => {
		const row = buildCacheKeepaliveSnapshotRow(
			NOW,
			{ warmSessions: 0, promotedSessions: 0, totalBytes: 0 },
			stats(),
		);

		expect(row).toEqual({
			sampledAt: NOW,
			warmSessions: 0,
			promotedSessions: 0,
			totalBytes: 0,
			keepalivesSent: 0,
			hits: 0,
			misses: 0,
			failures: 0,
			spentUsd: 0,
			savedUsd: 0,
			warmResumes: 0,
			savedUsd5m: 0,
		});
	});

	it("persists warmResumes + savedUsd5m but not the derived net/hitRate fields", () => {
		const row = buildCacheKeepaliveSnapshotRow(
			NOW,
			{ warmSessions: 1, promotedSessions: 1, totalBytes: 8 },
			stats({
				netUsd: 5,
				netUsdConservative: 3,
				warmResumes: 7,
				savedUsdConservative: 2.5,
				hitRate: 0.5,
			}),
		);
		// Persisted (cannot be derived from the other columns):
		expect(row.warmResumes).toBe(7);
		expect(row.savedUsd5m).toBe(2.5);
		// Derived on read → not stored:
		expect(row).not.toHaveProperty("netUsd");
		expect(row).not.toHaveProperty("netUsdConservative");
		expect(row).not.toHaveProperty("hitRate");
	});
});

describe("CacheKeepaliveSnapshotSampler tick", () => {
	it("reads gauges + stats and inserts exactly one row per tick", async () => {
		const inserted: CacheKeepaliveSnapshotRow[] = [];
		const sampler = new CacheKeepaliveSnapshotSampler({
			getGauges: () => ({
				warmSessions: 3,
				promotedSessions: 1,
				totalBytes: 1024,
			}),
			getStats: () =>
				stats({ keepalivesSent: 10, hits: 8, misses: 2, spentUsd: 0.05 }),
			insertSnapshot: async (row) => {
				inserted.push(row);
			},
			getPollIntervalMs: () => 90_000,
		});

		await sampler.tick();

		expect(inserted).toHaveLength(1);
		expect(inserted[0]?.warmSessions).toBe(3);
		expect(inserted[0]?.promotedSessions).toBe(1);
		expect(inserted[0]?.totalBytes).toBe(1024);
		expect(inserted[0]?.keepalivesSent).toBe(10);
		expect(inserted[0]?.hits).toBe(8);
		expect(inserted[0]?.spentUsd).toBe(0.05);
		expect(typeof inserted[0]?.sampledAt).toBe("number");
	});

	it("isolates DB errors — a failed insert must not throw out of tick()", async () => {
		const sampler = new CacheKeepaliveSnapshotSampler({
			getGauges: () => ({
				warmSessions: 0,
				promotedSessions: 0,
				totalBytes: 0,
			}),
			getStats: () => stats(),
			insertSnapshot: async () => {
				throw new Error("db down");
			},
			getPollIntervalMs: () => 90_000,
		});

		// Must resolve, not reject.
		await expect(sampler.tick()).resolves.toBeUndefined();
	});
});
