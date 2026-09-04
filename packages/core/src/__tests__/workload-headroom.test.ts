import { describe, expect, it } from "bun:test";
import {
	computeCapacityRunway,
	computeWorkloadHeadroom,
	type RunwayAccountSource,
	runwayPaceHeadroom,
	scopedWeeklyWindowKind,
	toScopedFamilyRunwayInput,
} from "@clankermux/core";
import type {
	AnthropicLimitEntry,
	AnthropicUsageData,
} from "@clankermux/types";

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const iso = (ms: number): string => new Date(ms).toISOString();

function scopedEntry(percent: number, resetMs: number): AnthropicLimitEntry {
	return {
		kind: "weekly_scoped",
		group: "weekly",
		percent,
		resets_at: iso(resetMs),
		scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
		is_active: true,
	};
}

function anthropicUsage(opts: {
	fiveHourPct: number;
	fiveHourResetMs: number;
	weeklyPct: number;
	weeklyResetMs: number;
	scoped?: { pct: number; resetMs?: number } | null;
}): AnthropicUsageData {
	const scoped = opts.scoped;
	return {
		five_hour: {
			utilization: opts.fiveHourPct,
			resets_at: iso(opts.fiveHourResetMs),
		},
		seven_day: {
			utilization: opts.weeklyPct,
			resets_at: iso(opts.weeklyResetMs),
		},
		limits: scoped
			? [scopedEntry(scoped.pct, scoped.resetMs ?? opts.weeklyResetMs)]
			: [],
	} as AnthropicUsageData;
}

/**
 * An account whose ACCOUNT-WIDE weekly window exhausts before its reset, and
 * whose scoped Fable window does not.
 *
 * The arithmetic is pinned deliberately: weekly at 80% with a reset in 2 days
 * has a structural start 5 days back, so it burns 0.667%/h and fills 30h from
 * now, 18h before the window resets. Fable at 70% over the same span burns
 * 0.583%/h and would need 51h, which is past its reset, so it contributes no
 * dead time at all. That asymmetry is what makes the two counterfactuals
 * disagree.
 */
function accountWideConstrained(id: string): RunwayAccountSource {
	return {
		id,
		name: id,
		provider: "anthropic",
		usageData: anthropicUsage({
			fiveHourPct: 1,
			fiveHourResetMs: NOW + HOUR,
			weeklyPct: 80,
			weeklyResetMs: NOW + 2 * DAY,
			scoped: { pct: 70 },
		}),
		usageObservedAtMs: NOW,
	};
}

describe("computeWorkloadHeadroom — class rows", () => {
	it("reports one row per servable class and never pools across them", () => {
		const rows = computeWorkloadHeadroom(
			[
				accountWideConstrained("claude-1"),
				{
					id: "codex-1",
					name: "codex-1",
					provider: "codex",
					usageData: anthropicUsage({
						fiveHourPct: 1,
						fiveHourResetMs: NOW + HOUR,
						weeklyPct: 80,
						weeklyResetMs: NOW + 2 * DAY,
						scoped: null,
					}),
					usageObservedAtMs: NOW,
				},
			],
			NOW,
		);

		const classRows = rows.filter((row) => row.dimensionKind === "class");
		expect(classRows.map((row) => row.dimensionId).sort()).toEqual([
			"anthropic",
			"codex",
		]);
		for (const row of classRows) {
			expect(row.eligibleAccountIds).toHaveLength(1);
			// Basis is what stops a reader treating these like the family rows:
			// a class row varies every window it has, so it states a threshold.
			expect(row.basis).toBe("exact");
			expect(row.projectionBasis).toBe("measured");
		}
	});

	it("does not let a healthy class rescue a constrained one", () => {
		const rows = computeWorkloadHeadroom(
			[
				accountWideConstrained("claude-1"),
				{
					id: "codex-1",
					name: "codex-1",
					provider: "codex",
					usageData: anthropicUsage({
						fiveHourPct: 0,
						fiveHourResetMs: NOW + HOUR,
						weeklyPct: 1,
						weeklyResetMs: NOW + 6 * DAY,
						scoped: null,
					}),
					usageObservedAtMs: NOW,
				},
			],
			NOW,
		);

		const anthropic = rows.find((row) => row.dimensionId === "anthropic");
		const codex = rows.find((row) => row.dimensionId === "codex");
		expect(anthropic?.outcome.kind).toBe("runway");
		expect(codex?.outcome.kind).toBe("beyond-horizon");
	});
});

describe("computeWorkloadHeadroom — family rows", () => {
	it("states the baseline outcome from the unscaled scan, not from a probe", () => {
		const account = accountWideConstrained("claude-1");
		const row = computeWorkloadHeadroom([account], NOW).find(
			(candidate) => candidate.dimensionKind === "family",
		);

		expect(row).toBeDefined();
		expect(row?.dimensionId).toBe("fable");
		expect(row?.outcome.kind).toBe("runway");
		if (row?.outcome.kind !== "runway") throw new Error("unreachable");
		// 30h out, from the account-wide weekly window. Exact: at pace 1 no window
		// is scaled, so the unknown share cannot affect this instant.
		expect(row.outcome.exhaustsAtMs).toBeCloseTo(NOW + 30 * HOUR, -5);
	});

	it("prices the deficit with the family's own window only, not uniformly", () => {
		// THE bound-direction regression test. Cutting Fable alone cannot clear an
		// account-wide weekly exhaustion, so the honest answer is "no certifiable
		// cut". Scaling every window together instead would relieve the
		// account-wide window as well and report a comfortable cut that no amount
		// of Fable restraint would actually deliver.
		const rows = computeWorkloadHeadroom([accountWideConstrained("c1")], NOW);
		const family = rows.find((row) => row.dimensionKind === "family");
		const cls = rows.find((row) => row.dimensionId === "anthropic");

		expect(family?.headroom).toBeNull();
		expect(family?.headroomAbsence).toBe("beyond-probe-range");
		expect(family?.basis).toBe("conservative-bound");

		// The class row, which legitimately varies everything, still states one.
		expect(cls?.headroom?.direction).toBe("deficit");
		expect(cls?.headroom?.pct).toBeGreaterThan(0);

		// And the null above is caused by the PACING SCOPE, not by the pool being
		// beyond rescue: the very same family pool, scanned with every window
		// paced together, does report a comfortable cut. That number is the one a
		// uniform implementation would publish, and it is unreachable by cutting
		// Fable alone. Without this assertion the test would still pass if the
		// scoped pool were simply unsalvageable for unrelated reasons.
		const familyInputs = [
			toScopedFamilyRunwayInput(accountWideConstrained("c1"), "fable", NOW),
		].filter((input) => input !== null);
		const uniform = runwayPaceHeadroom(
			computeCapacityRunway(familyInputs, NOW),
		);
		expect(uniform?.direction).toBe("deficit");
		expect(uniform?.pct).toBeGreaterThan(0);
	});

	it("discloses that a family projection rests on the structural estimate", () => {
		const row = computeWorkloadHeadroom(
			[accountWideConstrained("c1")],
			NOW,
		).find((candidate) => candidate.dimensionKind === "family");
		// Scoped windows carry no prediction and no burn anchor, so their ETA is a
		// now-anchored lifetime average that drifts later on a stale reading.
		expect(row?.projectionBasis).toBe("structural");
	});

	it("drops an account that reports no scoped window for the family", () => {
		const withScope = accountWideConstrained("c1");
		const withoutScope: RunwayAccountSource = {
			id: "c2",
			name: "c2",
			provider: "anthropic",
			usageData: anthropicUsage({
				fiveHourPct: 1,
				fiveHourResetMs: NOW + HOUR,
				weeklyPct: 5,
				weeklyResetMs: NOW + 6 * DAY,
				scoped: null,
			}),
			usageObservedAtMs: NOW,
		};

		const row = computeWorkloadHeadroom([withScope, withoutScope], NOW).find(
			(candidate) => candidate.dimensionKind === "family",
		);
		// c2 has plenty of account-wide room, so pooling it would make the family
		// look beyond-horizon on capacity it may not have for Fable at all.
		expect(row?.eligibleAccountIds).toEqual(["c1"]);
		expect(row?.outcome.kind).toBe("runway");
	});

	it("withholds headroom when a modelled credit bank breaks the bound", () => {
		const account: RunwayAccountSource = {
			...accountWideConstrained("c1"),
			codexResetCredits: {
				credits: [{ expiresAtMs: NOW + 5 * DAY }],
				onWeeklyLimitEnabled: true,
				onExpiryEnabled: false,
			},
		};

		const row = computeWorkloadHeadroom([account], NOW).find(
			(candidate) => candidate.dimensionKind === "family",
		);
		// A faster pace can pull a dead span back inside a credit's expiry and
		// revive the window, so dead sets stop nesting and neither endpoint of the
		// share range dominates. The bound is simply unavailable.
		expect(row?.headroom).toBeNull();
		expect(row?.headroomAbsence).toBe("bound-broken-by-credits");
	});
});

describe("toScopedFamilyRunwayInput", () => {
	it("never names the scoped window with the credit-bearing weekly kind", () => {
		const input = toScopedFamilyRunwayInput(
			accountWideConstrained("c1"),
			"fable",
			NOW,
		);
		const kinds = input?.windows.map((window) => window.windowKind) ?? [];
		expect(kinds).toContain(scopedWeeklyWindowKind("fable"));
		expect(kinds.filter((kind) => kind === "seven_day")).toHaveLength(1);
	});

	it("refuses a scoped window whose reset disagrees with the account-wide one", () => {
		const account: RunwayAccountSource = {
			id: "c1",
			name: "c1",
			provider: "anthropic",
			usageData: anthropicUsage({
				fiveHourPct: 1,
				fiveHourResetMs: NOW + HOUR,
				weeklyPct: 80,
				weeklyResetMs: NOW + 2 * DAY,
				// A different reset means a different cycle length, and the 7-day
				// structural start would put a fabricated denominator under the slope.
				scoped: { pct: 70, resetMs: NOW + 5 * DAY },
			}),
			usageObservedAtMs: NOW,
		};
		expect(toScopedFamilyRunwayInput(account, "fable", NOW)).toBeNull();
	});
});
