import { describe, expect, it } from "bun:test";
import {
	computeCapacityRunway,
	computeWorkloadHeadroom,
	normalizeAnthropicUsage,
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

	it("discloses that a BINDING scoped window rests on the structural estimate", () => {
		// Fable at 90% fills 13h from now, well before its reset, so it is what
		// this row's outcome rests on. Scoped windows carry no prediction and no
		// burn anchor, so that estimate is a now-anchored lifetime average which
		// drifts later while a reading is stale — optimistic drift, disclosed.
		const binding: RunwayAccountSource = {
			id: "c1",
			name: "c1",
			provider: "anthropic",
			usageData: anthropicUsage({
				fiveHourPct: 1,
				fiveHourResetMs: NOW + HOUR,
				weeklyPct: 80,
				weeklyResetMs: NOW + 2 * DAY,
				scoped: { pct: 90 },
			}),
			usageObservedAtMs: NOW,
		};
		const row = computeWorkloadHeadroom([binding], NOW).find(
			(candidate) => candidate.dimensionKind === "family",
		);
		expect(row?.projectionBasis).toBe("structural");
		if (row?.outcome.kind !== "runway") throw new Error("unreachable");
		expect(row.outcome.exhaustsAtMs).toBeCloseTo(NOW + 13.33 * HOUR, -6);
	});

	it("does not downgrade a family row for a scoped window that binds nothing", () => {
		// Fable at 70% never fills before its reset, so the outcome rests entirely
		// on the well-evidenced account-wide weekly window. Marking the row weak
		// because a scoped window merely EXISTS would make the field useless: it
		// would read `structural` on every family row forever, saying nothing
		// about the projection actually served.
		const row = computeWorkloadHeadroom(
			[accountWideConstrained("c1")],
			NOW,
		).find((candidate) => candidate.dimensionKind === "family");
		expect(row?.projectionBasis).toBe("measured");
		// The row is still a BOUND — that is what `basis` says, and it is a
		// different claim from how well-evidenced the projection is.
		expect(row?.basis).toBe("conservative-bound");
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

describe("computeWorkloadHeadroom — sources shaped like the server's scan", () => {
	/**
	 * The server's runway scan resolves every account through its freshness
	 * tiers and hands on `usageData: null` with the readings in
	 * `windowObservations`. Every other test here uses a raw payload, so none of
	 * them exercises the shape production actually passes.
	 */
	function scanShaped(id: string): RunwayAccountSource {
		const payload = anthropicUsage({
			fiveHourPct: 1,
			fiveHourResetMs: NOW + HOUR,
			weeklyPct: 80,
			weeklyResetMs: NOW + 2 * DAY,
			scoped: { pct: 70 },
		});
		return {
			id,
			name: id,
			provider: "anthropic",
			usageData: null,
			windowObservations: {
				fiveHour: { pct: 1, resetMs: NOW + HOUR },
				sevenDay: { pct: 80, resetMs: NOW + 2 * DAY },
				weeklyScoped: normalizeAnthropicUsage(payload, NOW).weeklyScoped,
			},
			usageObservedAtMs: NOW,
		};
	}

	it("still discovers families when the readings are pre-extracted", () => {
		// The regression that a green suite hid: family discovery read only
		// `usageData`, so the whole dimension came out empty in production while
		// every payload-shaped test passed.
		const rows = computeWorkloadHeadroom([scanShaped("c1")], NOW);
		expect(rows.map((row) => row.dimensionId)).toContain("fable");
	});
});

describe("computeWorkloadHeadroom — honest counts", () => {
	it("counts an account blocked by its 5-hour window as spent", () => {
		const account: RunwayAccountSource = {
			id: "c1",
			name: "c1",
			provider: "anthropic",
			usageData: anthropicUsage({
				// Spent right now on the 5-hour window while the week has room. Either
				// account-wide window blocks routing, so a count that tested only the
				// weekly one reported zero beside an `out-now` outcome.
				fiveHourPct: 100,
				fiveHourResetMs: NOW + HOUR,
				weeklyPct: 20,
				weeklyResetMs: NOW + 5 * DAY,
				scoped: null,
			}),
			usageObservedAtMs: NOW,
		};

		const row = computeWorkloadHeadroom([account], NOW).find(
			(candidate) => candidate.dimensionId === "anthropic",
		);
		expect(row?.outcome.kind).toBe("out-now");
		expect(row?.spentAccountIds).toEqual(["c1"]);
	});

	it("separates accounts considered from accounts projected from", () => {
		const readable = accountWideConstrained("c1");
		const unreadable: RunwayAccountSource = {
			id: "c2",
			name: "c2",
			provider: "anthropic",
			usageData: null,
			usageObservedAtMs: null,
		};

		const row = computeWorkloadHeadroom([readable, unreadable], NOW).find(
			(candidate) => candidate.dimensionId === "anthropic",
		);
		expect(row?.eligibleAccountIds).toEqual(["c1", "c2"]);
		// Counting c2 as depth behind the projection would claim two accounts of
		// cover for a runway computed from one.
		expect(row?.unreadableAccountIds).toEqual(["c2"]);
	});

	it("reports a live family it cannot project rather than dropping it", () => {
		const mismatched: RunwayAccountSource = {
			id: "c1",
			name: "c1",
			provider: "anthropic",
			usageData: anthropicUsage({
				fiveHourPct: 1,
				fiveHourResetMs: NOW + HOUR,
				weeklyPct: 80,
				weeklyResetMs: NOW + 2 * DAY,
				scoped: { pct: 70, resetMs: NOW + 5 * DAY },
			}),
			usageObservedAtMs: NOW,
		};

		const row = computeWorkloadHeadroom([mismatched], NOW).find(
			(candidate) => candidate.dimensionKind === "family",
		);
		// Silently omitting the row would read as "no such limit", which is the
		// opposite of "this limit exists and we cannot see it".
		expect(row?.outcome.kind).toBe("unknown");
		expect(row?.unreadableAccountIds).toEqual(["c1"]);
		expect(row?.headroomAbsence).toBe("not-projected");
	});

	it("does not claim measured evidence for an unanchored weekly window", () => {
		const unanchored: RunwayAccountSource = {
			...accountWideConstrained("c1"),
			// No honest observation time, so the weekly window degrades to the
			// amber-capped now-anchored estimate. A hardcoded "measured" claimed
			// evidence the scan did not have.
			usageObservedAtMs: null,
		};
		const row = computeWorkloadHeadroom([unanchored], NOW).find(
			(candidate) => candidate.dimensionId === "anthropic",
		);
		expect(row?.projectionBasis).toBe("structural");
	});
});

describe("computeWorkloadHeadroom — counts that must not mislead", () => {
	it("does not count a non-Anthropic account as failing to report a family", () => {
		// Production puts `weeklyScoped: []` on every non-Anthropic scan winner, so
		// a non-null check counted every Codex account as an account that failed to
		// state a Claude family window. A Codex account has no Fable limit to be
		// missing; it is not eligible for the row at all.
		const rows = computeWorkloadHeadroom(
			[
				accountWideConstrained("claude-1"),
				{
					id: "codex-1",
					name: "codex-1",
					provider: "codex",
					usageData: null,
					windowObservations: {
						fiveHour: { pct: 10, resetMs: NOW + HOUR },
						sevenDay: { pct: 30, resetMs: NOW + 5 * DAY },
						weeklyScoped: [],
					},
					usageObservedAtMs: NOW,
				},
			],
			NOW,
		);

		const family = rows.find((row) => row.dimensionKind === "family");
		expect(family?.eligibleAccountIds).toEqual(["claude-1"]);
		expect(family?.unreadableAccountIds).toEqual([]);
	});

	it("keeps unreadable a SUBSET of eligible on a family row", () => {
		const mismatched: RunwayAccountSource = {
			id: "c1",
			name: "c1",
			provider: "anthropic",
			usageData: anthropicUsage({
				fiveHourPct: 1,
				fiveHourResetMs: NOW + HOUR,
				weeklyPct: 80,
				weeklyResetMs: NOW + 2 * DAY,
				scoped: { pct: 70, resetMs: NOW + 5 * DAY },
			}),
			usageObservedAtMs: NOW,
		};

		const row = computeWorkloadHeadroom([mismatched], NOW).find(
			(candidate) => candidate.dimensionKind === "family",
		);
		// The wire tells clients to subtract one count from the other. Building
		// eligible from the successful inputs alone made that go negative.
		expect(row?.eligibleAccountIds).toEqual(["c1"]);
		expect(row?.unreadableAccountIds).toEqual(["c1"]);
		expect(row?.projectionBasis).toBeNull();
	});

	it("reports a wholly blind class as wholly unreadable", () => {
		const blind: RunwayAccountSource = {
			id: "c1",
			name: "c1",
			provider: "anthropic",
			usageData: null,
			usageObservedAtMs: null,
		};
		const row = computeWorkloadHeadroom([blind], NOW).find(
			(candidate) => candidate.dimensionId === "anthropic",
		);
		// `unknown` carries no id list of its own, so reading only the outcome
		// reported zero unreadable accounts — the most reassuring possible answer
		// to the least informative scan.
		expect(row?.outcome.kind).toBe("unknown");
		expect(row?.unreadableAccountIds).toEqual(["c1"]);
		expect(row?.projectionBasis).toBeNull();
	});

	it("does not call an account spent when the scan revived it with a credit", () => {
		const credited: RunwayAccountSource = {
			id: "credited",
			name: "credited",
			provider: "codex",
			usageData: anthropicUsage({
				fiveHourPct: 0,
				fiveHourResetMs: NOW + HOUR,
				weeklyPct: 100,
				weeklyResetMs: NOW + 2 * DAY,
				scoped: null,
			}),
			usageObservedAtMs: NOW,
			codexResetCredits: {
				credits: [{ expiresAtMs: NOW + 5 * DAY }],
				onWeeklyLimitEnabled: true,
				onExpiryEnabled: false,
			},
		};

		const row = computeWorkloadHeadroom([credited], NOW).find(
			(candidate) => candidate.dimensionId === "codex",
		);
		// Reporting it spent while the same scan models it revived puts a
		// contradiction inside one row.
		expect(row?.outcome.kind).not.toBe("out-now");
		expect(row?.spentAccountIds).toEqual([]);
	});
});

describe("computeWorkloadHeadroom — projection basis follows the claim", () => {
	it("marks a beyond-horizon structural when only a weak estimate holds it up", () => {
		// Both weekly windows reset in a day, so their structural start is six days
		// back and both burn slowly enough never to fill before that reset. Fable
		// therefore emits no dead interval — and that absence IS the claim holding
		// the row at beyond-horizon. Scoping evidence to windows that emit
		// intervals called this `measured`, which is exactly where a stale scoped
		// reading's optimistic drift would bite.
		const roomy: RunwayAccountSource = {
			id: "c1",
			name: "c1",
			provider: "anthropic",
			usageData: anthropicUsage({
				fiveHourPct: 1,
				fiveHourResetMs: NOW + HOUR,
				weeklyPct: 5,
				weeklyResetMs: NOW + DAY,
				scoped: { pct: 40 },
			}),
			usageObservedAtMs: NOW,
		};
		const row = computeWorkloadHeadroom([roomy], NOW).find(
			(candidate) => candidate.dimensionKind === "family",
		);
		expect(row?.outcome.kind).toBe("beyond-horizon");
		expect(row?.projectionBasis).toBe("structural");
	});

	it("ignores a weak window that is not among the causes of a stated instant", () => {
		// Weekly is spent now and is the sole cause. The 5-hour window is on a
		// low-confidence estimate but has nothing to do with the reported instant,
		// and marking the row weak because of it described the wrong measurement.
		const spentWeekly: RunwayAccountSource = {
			id: "c1",
			name: "c1",
			provider: "anthropic",
			usageData: anthropicUsage({
				fiveHourPct: 40,
				fiveHourResetMs: NOW + HOUR,
				weeklyPct: 100,
				weeklyResetMs: NOW + 2 * DAY,
				scoped: null,
			}),
			usageObservedAtMs: NOW,
		};
		const row = computeWorkloadHeadroom([spentWeekly], NOW).find(
			(candidate) => candidate.dimensionId === "anthropic",
		);
		expect(row?.outcome.kind).toBe("out-now");
		if (row?.outcome.kind !== "out-now") throw new Error("unreachable");
		expect(row.outcome.causes.map((cause) => cause.windowKind)).toEqual([
			"seven_day",
		]);
		expect(row.projectionBasis).toBe("measured");
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
