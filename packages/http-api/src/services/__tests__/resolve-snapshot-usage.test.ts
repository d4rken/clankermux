import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import {
	loadRecentSnapshotObservations,
	projectableWindows,
	snapshotWithin,
} from "../resolve-snapshot-usage";

const NOW = Date.UTC(2026, 8, 4, 13, 40, 0);
const MINUTE = 60_000;
const HORIZON = 30 * MINUTE;

type AccountWideRow = Awaited<
	ReturnType<DatabaseOperations["getRecentUsageSnapshotsForAccounts"]>
>[number];
type ScopedRow = Awaited<
	ReturnType<DatabaseOperations["getRecentScopedUsageSnapshotsForAccounts"]>
>[number];

function accountWide(over: Partial<AccountWideRow> = {}): AccountWideRow {
	return {
		accountId: "acct-1",
		sampledAt: NOW - MINUTE,
		observedAt: NOW - 3 * MINUTE,
		fiveHourPct: 12,
		fiveHourReset: NOW + 2 * 60 * MINUTE,
		sevenDayPct: 65,
		sevenDayReset: NOW + 3 * 24 * 60 * MINUTE,
		...over,
	} as AccountWideRow;
}

function scoped(over: Partial<ScopedRow> = {}): ScopedRow {
	return {
		accountId: "acct-1",
		sampledAt: NOW - MINUTE,
		family: "fable",
		displayName: "Fable",
		pct: 100,
		resetAt: NOW + 2 * 24 * 60 * MINUTE,
		...over,
	} as ScopedRow;
}

function dbWith(rows: {
	accountWide?: AccountWideRow[];
	scoped?: ScopedRow[];
	scopedThrows?: boolean;
	accountWideThrows?: boolean;
}): DatabaseOperations {
	return {
		getRecentUsageSnapshotsForAccounts: async () => {
			if (rows.accountWideThrows) throw new Error("account-wide read failed");
			return rows.accountWide ?? [];
		},
		getRecentScopedUsageSnapshotsForAccounts: async () => {
			if (rows.scopedThrows) throw new Error("scoped read failed");
			return rows.scoped ?? [];
		},
	} as unknown as DatabaseOperations;
}

describe("loadRecentSnapshotObservations", () => {
	it("carries the row's observed_at, distinct from its sampled_at", async () => {
		// The whole point of the field: the sampler stamps every row in a tick with
		// the tick instant, which is LATER than the reading it copied. A caller
		// ranking freshness must see the earlier, true one.
		const map = await loadRecentSnapshotObservations(
			dbWith({ accountWide: [accountWide()] }),
			["acct-1"],
			NOW,
			HORIZON,
		);
		const snapshot = map.get("acct-1");
		expect(snapshot?.sampledAtMs).toBe(NOW - MINUTE);
		expect(snapshot?.observedAtMs).toBe(NOW - 3 * MINUTE);
		expect(snapshot?.observedAtMs).toBeLessThan(snapshot?.sampledAtMs ?? 0);
	});

	it("states a null observed_at rather than substituting the sample time", async () => {
		// A payload-reconstructed reading cannot say when it was observed. Falling
		// back to `sampledAt` here would re-create the very ordering defect this
		// field exists to remove, and would promote an untimed reading to the
		// freshest one in the pool.
		const map = await loadRecentSnapshotObservations(
			dbWith({ accountWide: [accountWide({ observedAt: null })] }),
			["acct-1"],
			NOW,
			HORIZON,
		);
		expect(map.get("acct-1")?.observedAtMs).toBeNull();
	});

	it("pairs scoped rows to the account-wide row by TICK, not by account", async () => {
		// A newer scoped row riding an older account-wide reading is a merge across
		// two observation instants — exactly what the candidate list forbids.
		const map = await loadRecentSnapshotObservations(
			dbWith({
				accountWide: [accountWide({ sampledAt: NOW - 5 * MINUTE })],
				scoped: [
					scoped({ sampledAt: NOW - 5 * MINUTE, pct: 40 }),
					scoped({ sampledAt: NOW - MINUTE, pct: 100 }),
				],
			}),
			["acct-1"],
			NOW,
			HORIZON,
		);
		expect(map.get("acct-1")?.weeklyScoped).toEqual([
			{
				family: "fable",
				percent: 40,
				resetsAtMs: NOW + 2 * 24 * 60 * MINUTE,
				isActive: true,
				displayName: "Fable",
			},
		]);
	});

	it("reports null, not an empty array, when a tick recorded no scoped rows", async () => {
		// An account-wide row is NOT evidence that its tick's scoped write landed:
		// the sampler issues the two inserts separately, under separate error
		// handling, precisely so one failing does not discard the other, and a
		// reader can also arrive between them. `[]` would assert "reports no
		// families" on that non-evidence, and asserting it wrongly removes the
		// account from the family row. Null only marks it unreadable.
		const map = await loadRecentSnapshotObservations(
			dbWith({ accountWide: [accountWide()] }),
			["acct-1"],
			NOW,
			HORIZON,
		);
		expect(map.get("acct-1")?.weeklyScoped).toBeNull();
	});

	it("applies the live path's admissibility to scoped rows", async () => {
		const map = await loadRecentSnapshotObservations(
			dbWith({
				accountWide: [accountWide()],
				scoped: [
					scoped({ displayName: "Fable", pct: 100 }),
					// Reset already passed: the window rolled over since the row.
					scoped({ displayName: "Opus", resetAt: NOW - MINUTE }),
					// No percent recorded.
					scoped({ displayName: "Sonnet", pct: null }),
					// Unresolvable display name.
					scoped({ displayName: "Nonesuch Model" }),
				],
			}),
			["acct-1"],
			NOW,
			HORIZON,
		);
		expect(map.get("acct-1")?.weeklyScoped?.map((l) => l.family)).toEqual([
			"fable",
		]);
	});

	it("keeps the account-wide windows when the scoped read fails, and states null", async () => {
		// A fallback that cannot be read degrades to no fallback; it does not take
		// the windows beside it down. But it must NOT report `[]` either: claiming
		// every account reports no families is a false negative that deletes a
		// family row outright, where null only marks the account unreadable.
		const map = await loadRecentSnapshotObservations(
			dbWith({ accountWide: [accountWide()], scopedThrows: true }),
			["acct-1"],
			NOW,
			HORIZON,
		);
		expect(map.get("acct-1")?.sevenDay?.pct).toBe(65);
		expect(map.get("acct-1")?.weeklyScoped).toBeNull();
	});

	it("carries the whole tick's families, not just the first", async () => {
		const map = await loadRecentSnapshotObservations(
			dbWith({
				accountWide: [accountWide()],
				scoped: [
					scoped({ displayName: "Fable", pct: 90 }),
					scoped({ displayName: "Opus", pct: 91 }),
				],
			}),
			["acct-1"],
			NOW,
			HORIZON,
		);
		expect(
			map
				.get("acct-1")
				?.weeklyScoped?.map((l) => l.percent)
				.sort(),
		).toEqual([90, 91]);
	});

	it("takes the newest ADMISSIBLE account-wide tick, not the greatest stamp", async () => {
		// The symmetric case to the scoped-only one below. A future-stamped row
		// otherwise wins the comparison, shadows a usable older row, and is only
		// rejected later by `snapshotWithin` — leaving the account with nothing, and
		// blocking the scoped-only pass too because the account is already keyed.
		const map = await loadRecentSnapshotObservations(
			dbWith({
				accountWide: [
					accountWide({ sampledAt: NOW - 5 * MINUTE, sevenDayPct: 65 }),
					accountWide({ sampledAt: NOW + 5 * MINUTE, sevenDayPct: 99 }),
				],
			}),
			["acct-1"],
			NOW,
			HORIZON,
		);
		expect(map.get("acct-1")?.sampledAtMs).toBe(NOW - 5 * MINUTE);
		expect(map.get("acct-1")?.sevenDay?.pct).toBe(65);
	});

	it("falls back to a scoped-only tick when every account-wide row is inadmissible", async () => {
		const map = await loadRecentSnapshotObservations(
			dbWith({
				accountWide: [accountWide({ sampledAt: NOW + 5 * MINUTE })],
				scoped: [scoped()],
			}),
			["acct-1"],
			NOW,
			HORIZON,
		);
		expect(map.get("acct-1")?.sevenDay).toBeNull();
		expect(map.get("acct-1")?.weeklyScoped).toHaveLength(1);
	});

	it("keeps readable scoped evidence when the account-wide read fails", async () => {
		// Two separate queries over two separate tables. Abandoning the scoped one
		// because the account-wide one failed would delete a family row on the
		// strength of an unrelated error.
		const map = await loadRecentSnapshotObservations(
			dbWith({ accountWideThrows: true, scoped: [scoped()] }),
			["acct-1"],
			NOW,
			HORIZON,
		);
		expect(map.get("acct-1")?.weeklyScoped).toHaveLength(1);
		expect(map.get("acct-1")?.sevenDay).toBeNull();
	});

	it("surfaces a tick that recorded scoped rows and no account-wide row", async () => {
		// Reachable without an unusual payload: the sampler writes the two series in
		// separate statements under separate error handling, so an account-wide
		// insert that fails still leaves the scoped insert to land.
		const map = await loadRecentSnapshotObservations(
			dbWith({ accountWide: [], scoped: [scoped()] }),
			["acct-1"],
			NOW,
			HORIZON,
		);
		const snapshot = map.get("acct-1");
		expect(snapshot?.fiveHour).toBeNull();
		expect(snapshot?.sevenDay).toBeNull();
		expect(snapshot?.weeklyScoped).toHaveLength(1);
		// The stamp lives on the account-wide row, and there is none.
		expect(snapshot?.observedAtMs).toBeNull();
	});

	it("takes the newest ADMISSIBLE scoped-only tick, not the greatest stamp", async () => {
		// Selecting on the raw maximum let a future-stamped tick win and then be
		// rejected downstream, taking a usable older tick down with it.
		const map = await loadRecentSnapshotObservations(
			dbWith({
				accountWide: [],
				scoped: [
					scoped({ sampledAt: NOW - 5 * MINUTE, pct: 10 }),
					scoped({ sampledAt: NOW - MINUTE, pct: 90 }),
					scoped({ sampledAt: NOW + 5 * MINUTE, pct: 99 }),
				],
			}),
			["acct-1"],
			NOW,
			HORIZON,
		);
		expect(map.get("acct-1")?.sampledAtMs).toBe(NOW - MINUTE);
		expect(map.get("acct-1")?.weeklyScoped?.map((l) => l.percent)).toEqual([
			90,
		]);
	});

	it("never lets a scoped-only tick displace an account-wide observation", async () => {
		// The last-resort rule, stated: an account that HAS an account-wide reading
		// keeps it, and its scoped state stays whatever its own tick recorded.
		// Pulling the newer tick's scoped rows onto it would merge two instants.
		const map = await loadRecentSnapshotObservations(
			dbWith({
				accountWide: [accountWide({ sampledAt: NOW - 5 * MINUTE })],
				scoped: [scoped({ sampledAt: NOW - MINUTE, pct: 90 })],
			}),
			["acct-1"],
			NOW,
			HORIZON,
		);
		expect(map.get("acct-1")?.sevenDay?.pct).toBe(65);
		expect(map.get("acct-1")?.sampledAtMs).toBe(NOW - 5 * MINUTE);
		expect(map.get("acct-1")?.weeklyScoped).toBeNull();
	});
});

describe("projectableWindows", () => {
	const windows = {
		fiveHour: { pct: 12, resetMs: NOW + 60 * MINUTE },
		sevenDay: { pct: 65, resetMs: NOW + 3 * 24 * 60 * MINUTE },
		weeklyScoped: [
			{
				family: "fable" as const,
				percent: 100,
				resetsAtMs: NOW + 2 * 24 * 60 * MINUTE,
				isActive: true,
				displayName: "Fable",
			},
		],
	};

	it("carries scoped windows through", () => {
		// Dropping them made a snapshot-restored account state NO scoped evidence
		// rather than what its own row said, which loses it from a family row.
		expect(projectableWindows(windows, NOW).weeklyScoped).toHaveLength(1);
	});

	it("drops a scoped window whose reset has passed", () => {
		expect(
			projectableWindows(windows, NOW + 3 * 24 * 60 * MINUTE).weeklyScoped,
		).toEqual([]);
	});

	it("still reports an empty array when the source had none", () => {
		expect(
			projectableWindows(
				{ fiveHour: null, sevenDay: null, weeklyScoped: [] },
				NOW,
			).weeklyScoped,
		).toEqual([]);
	});

	it("preserves null rather than filtering it into an empty array", () => {
		// The last step must not turn "not looked at" into "looked, reports none".
		expect(
			projectableWindows(
				{ fiveHour: null, sevenDay: null, weeklyScoped: null },
				NOW,
			).weeklyScoped,
		).toBeNull();
	});
});

describe("snapshotWithin", () => {
	const snapshot = {
		sampledAtMs: NOW - 5 * MINUTE,
		observedAtMs: NOW - 7 * MINUTE,
		fiveHour: null,
		sevenDay: null,
		weeklyScoped: [],
	};

	it("bars on the SAMPLE time, which is the row's own age", () => {
		const map = new Map([["acct-1", snapshot]]);
		expect(snapshotWithin(map, "acct-1", NOW, 10 * MINUTE)).toBe(snapshot);
		expect(snapshotWithin(map, "acct-1", NOW, 2 * MINUTE)).toBeNull();
	});

	it("rejects a future-stamped row", () => {
		const map = new Map([
			["acct-1", { ...snapshot, sampledAtMs: NOW + MINUTE }],
		]);
		expect(snapshotWithin(map, "acct-1", NOW, 10 * MINUTE)).toBeNull();
	});
});
