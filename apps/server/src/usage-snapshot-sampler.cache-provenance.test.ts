/**
 * Integration between the REAL usage cache and the snapshot sampler, on the one
 * axis the two were designed independently: observation provenance.
 *
 * `usageCache` distinguishes a reading it JUST OBSERVED (`set()`, observation
 * time = write time) from a RECONSTRUCTED one with no trustworthy observation
 * time (`setUntimed()`, observation time null — today the Codex stored-payload
 * recovery after a restart, whose headers can predate the write by hours).
 *
 * The sampler persists `usage_snapshots.observed_at` from that provenance. It
 * used to derive the instant as `now - peekAge()`, which is the age of the cache
 * WRITE — so a payload-recovered reading was stamped with the recovery instant
 * and became indistinguishable from an honestly-observed sample in permanent
 * history. These tests pin the composed behaviour against the real cache, not a
 * fake: an untimed reading is an honest gap, and a live one keeps its exact
 * observation instant.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { UsageData } from "@clankermux/providers";
import { usageCache } from "@clankermux/providers";
import type {
	Account,
	ScopedUsageSnapshotRow,
	UsageSnapshotRow,
} from "@clankermux/types";
import { UsageSnapshotSampler } from "./usage-snapshot-sampler";

const ACCOUNT_ID = "acc-codex-provenance";
const FRESHNESS = 150_000;

/** Account-wide 5h/7d windows plus one per-family weekly window. */
function usagePayload(): UsageData {
	const weekAhead = new Date(
		Date.now() + 7 * 24 * 60 * 60 * 1000,
	).toISOString();
	const hourAhead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	return {
		five_hour: { utilization: 99, resets_at: hourAhead },
		seven_day: { utilization: 71, resets_at: weekAhead },
		limits: [
			{
				kind: "weekly_scoped",
				percent: 63,
				resets_at: weekAhead,
				is_active: true,
				scope: { model: { display_name: "Claude Opus 5" } },
			},
		],
	} as unknown as UsageData;
}

interface Harness {
	tick: () => Promise<void>;
	rows: UsageSnapshotRow[];
	scopedRows: ScopedUsageSnapshotRow[];
}

/** A sampler wired to the REAL usageCache, with the DB writes captured. */
function makeSampler(): Harness {
	const rows: UsageSnapshotRow[] = [];
	const scopedRows: ScopedUsageSnapshotRow[] = [];
	const sampler = new UsageSnapshotSampler({
		getAccounts: async () => [
			{
				id: ACCOUNT_ID,
				provider: "codex",
				paused: false,
			} as unknown as Account,
		],
		insertSnapshots: async (batch) => {
			rows.push(...batch);
		},
		insertScopedSnapshots: async (batch) => {
			scopedRows.push(...batch);
		},
		getRecentSnapshots: async () => [],
		cache: usageCache,
		getFreshnessMs: () => FRESHNESS,
		getPollIntervalMs: () => 90_000,
	});
	return { tick: () => sampler.tick(), rows, scopedRows };
}

afterEach(() => usageCache.delete(ACCOUNT_ID));

describe("sampler × usageCache observation provenance", () => {
	it("writes no snapshot at all for a setUntimed() (payload-recovered) reading", async () => {
		usageCache.setUntimed(ACCOUNT_ID, usagePayload());

		// The entry is present, fresh and carries real windows — the ONLY thing
		// missing is when it was observed. Anything skipped below is skipped for
		// that reason and no other.
		const cached = usageCache.peekWithAge(ACCOUNT_ID);
		expect(cached).not.toBeNull();
		expect(cached?.ageMs).toBeLessThan(FRESHNESS);
		expect(cached?.observedAtMs).toBeNull();

		const h = makeSampler();
		await h.tick();

		expect(h.rows).toHaveLength(0);
		expect(h.scopedRows).toHaveLength(0);
	});

	it("persists the exact observation instant of a set() reading", async () => {
		usageCache.set(ACCOUNT_ID, usagePayload());
		const observedAtMs = usageCache.peekWithAge(ACCOUNT_ID)?.observedAtMs;
		expect(typeof observedAtMs).toBe("number");

		// Let the tick clock advance past the observation instant, so "kept the
		// observation time" and "stamped the tick clock" cannot look alike.
		await Bun.sleep(5);

		const h = makeSampler();
		await h.tick();

		expect(h.rows).toHaveLength(1);
		expect(h.rows[0].observedAt).toBe(observedAtMs as number);
		expect(h.rows[0].observedAt).toBeLessThan(h.rows[0].sampledAt);
		expect(h.scopedRows).toHaveLength(1);
		expect(h.scopedRows[0].family).toBe("opus");
	});

	it("keeps the gap on every later tick, not just the recovering one", async () => {
		// setUntimed() writes null provenance INTO the entry, so it stays null on
		// re-read: a second tick must not "age into" a confident timestamp.
		usageCache.setUntimed(ACCOUNT_ID, usagePayload());

		const first = makeSampler();
		await first.tick();
		await Bun.sleep(5);
		const second = makeSampler();
		await second.tick();

		expect(first.rows).toHaveLength(0);
		expect(second.rows).toHaveLength(0);
		expect(second.scopedRows).toHaveLength(0);

		// A live observation replacing it restores recording immediately.
		usageCache.set(ACCOUNT_ID, usagePayload());
		const third = makeSampler();
		await third.tick();
		expect(third.rows).toHaveLength(1);
	});
});
