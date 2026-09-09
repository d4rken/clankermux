import { describe, expect, it } from "bun:test";
import {
	type RunwayAccountSource,
	toRunwayAccountInput,
} from "./api-key-runway";
import { consumptionPace, type RunwayAccountInput } from "./capacity-runway";
import { computeWeeklyWorkloads, weeklyOnlySource } from "./weekly-workloads";
import { computeWorkloadHeadroom } from "./workload-headroom";

const NOW = Date.parse("2026-09-09T12:00:00Z");
const HOUR = 3600000,
	DAY = 24 * HOUR;
const source = (id = "a", weekly = 60, five = 0): RunwayAccountSource => ({
	id,
	name: id,
	provider: "anthropic",
	usageObservedAtMs: NOW,
	usageData: null,
	windowObservations: {
		fiveHour: { pct: five, resetMs: NOW + HOUR },
		sevenDay: { pct: weekly, resetMs: NOW + 5 * DAY },
		weeklyScoped: [],
	},
});
describe("weekly-only workload evidence", () => {
	it("includes useful weekly evidence when a sibling five-hour window is idle", () => {
		const sources = [source("a"), source("b", 50, 10)];
		expect(
			computeWorkloadHeadroom(sources, NOW)[0]?.learningAccountIds,
		).toEqual(["a"]);
		const row = computeWeeklyWorkloads(sources, NOW)[0];
		expect(row?.coverage).toEqual({
			eligibleAccounts: 2,
			modeledAccounts: 2,
			idleAccounts: 0,
			learningAccounts: 0,
			unavailableAccounts: 0,
		});
		expect(row?.risk.atRiskAccounts).toBe(2);
		expect(
			row?.inputs.every((i) =>
				i.windows.every((w) => w.windowKind !== "five_hour"),
			),
		).toBe(true);
	});
	it("counts idle, short history and absent weekly evidence separately", () => {
		const idle = source("idle", 0);
		const young = {
			...source("young"),
			windowObservations: {
				fiveHour: null,
				sevenDay: { pct: 2, resetMs: NOW + 7 * DAY - 30 * 60000 },
			},
		};
		const missing = {
			...source("missing"),
			windowObservations: { fiveHour: null, sevenDay: null },
		};
		const row = computeWeeklyWorkloads(
			[source(), idle, young, missing],
			NOW,
		)[0];
		expect(row?.coverage).toEqual({
			eligibleAccounts: 4,
			modeledAccounts: 1,
			idleAccounts: 1,
			learningAccounts: 1,
			unavailableAccounts: 1,
		});
		expect(row?.paceReason).toBe("partial_coverage");
		expect(row?.pace.changePct).toBeNull();
	});
	it("keeps revision anchors and omits elapsed weekly cycles", () => {
		const s = source();
		s.burnAnchors = {
			sevenDay: {
				anchorMs: NOW - 30 * 60000,
				anchorPct: 50,
				windowResetMs: NOW + 5 * DAY,
			},
		};
		expect(computeWeeklyWorkloads([s], NOW)[0]?.coverage.learningAccounts).toBe(
			1,
		);
		expect(
			weeklyOnlySource(s, NOW + 6 * DAY).windowObservations?.sevenDay,
		).toBeNull();
		expect(
			computeWeeklyWorkloads([s], NOW + 6 * DAY)[0]?.row.nextReset,
		).toBeNull();
	});
	it("keeps family and account-wide weekly constraints together", () => {
		const s = source();
		if (!s.windowObservations) throw new Error("fixture");
		s.windowObservations.weeklyScoped = [
			{
				family: "fable",
				displayName: "Fable",
				percent: 100,
				resetsAtMs: NOW + 5 * DAY,
			},
		];
		const row = computeWeeklyWorkloads([s], NOW).find(
			(w) => w.row.dimensionKind === "family",
		);
		expect(row?.parentId).toBe("class:anthropic");
		expect(row?.inputs[0]?.windows.map((w) => w.windowKind)).toEqual([
			"seven_day",
			"weekly_scoped:fable",
		]);
		expect(row?.risk.spentAccounts).toBe(1);
		expect(row?.row.nextReset?.outcome.kind).toBe("out-now");
	});
	it("rejects mismatched family resets and does not create a forecast from them", () => {
		const s = source();
		if (!s.windowObservations) throw new Error("fixture");
		s.windowObservations.weeklyScoped = [
			{
				family: "fable",
				displayName: "Fable",
				percent: 50,
				resetsAtMs: NOW + 4 * DAY,
			},
		];
		const row = computeWeeklyWorkloads([s], NOW).find(
			(w) => w.row.dimensionKind === "family",
		);
		expect(row?.coverage.modeledAccounts).toBe(0);
		expect(row?.pace.state).toBe("unavailable");
	});
	it("excludes paused accounts and distinguishes non-weekly providers", () => {
		expect(
			computeWeeklyWorkloads([{ ...source(), paused: true }], NOW),
		).toEqual([]);
		const row = computeWeeklyWorkloads(
			[
				{
					...source(),
					provider: "ollama",
					usageData: null,
					windowObservations: null,
				},
			],
			NOW,
		)[0];
		expect(row?.applicable).toBe(false);
		expect(row?.paceReason).toBe("not_applicable");
	});
});
describe("consumer pace search", () => {
	function input(pct: number): RunwayAccountInput[] {
		return [toRunwayAccountInput(weeklyOnlySource(source("a", pct), NOW))];
	}
	it("returns the last passing step instead of the first failing step", () => {
		// 20% in two days: exhaustion reaches reset at multiplier 8/5 = 1.6, outside cap.
		expect(consumptionPace(input(20), NOW, NOW + 5 * DAY, "increase")).toEqual({
			state: "increase_limit",
			changePct: 50,
		});
		// 25% in two days: remaining quota reaches reset at multiplier 1.2.
		const result = consumptionPace(input(25), NOW, NOW + 5 * DAY, "increase");
		expect(result.state).toBe("estimate");
		expect(result.changePct).toBe(20);
	});
	it("does not equate an aborted/no-evidence search with the search limit", () => {
		expect(consumptionPace([], NOW, NOW + DAY, "increase")).toEqual({
			state: "unavailable",
			changePct: null,
		});
		expect(consumptionPace(input(0), NOW, NOW + DAY, "increase")).toEqual({
			state: "unavailable",
			changePct: null,
		});
		expect(consumptionPace(input(25), NOW, NOW, "increase")).toEqual({
			state: "unavailable",
			changePct: null,
		});
	});
	it("reports a completed insufficient-reduction search separately", () => {
		expect(consumptionPace(input(80), NOW, NOW + 5 * DAY, "reduce")).toEqual({
			state: "reduction_limit",
			changePct: -50,
		});
		const estimate = consumptionPace(input(40), NOW, NOW + 5 * DAY, "reduce");
		expect(estimate.state).toBe("estimate");
		expect(estimate.changePct).toBeLessThan(0);
	});
});

it("rejects elapsed family evidence even inside the reset matching tolerance", () => {
	const s: RunwayAccountSource = {
		...source(),
		windowObservations: {
			fiveHour: null,
			sevenDay: { pct: 60, resetMs: NOW + 30000 },
			weeklyScoped: [
				{
					family: "fable",
					displayName: "Fable",
					percent: 100,
					resetsAtMs: NOW - 10000,
				},
			],
		},
	};
	const row = computeWeeklyWorkloads([s], NOW).find(
		(r) => r.row.dimensionKind === "family",
	);
	expect(row).toBeDefined();
	expect(row?.coverage).toMatchObject({
		eligibleAccounts: 1,
		modeledAccounts: 0,
		unavailableAccounts: 1,
		idleAccounts: 0,
	});
	expect(row?.risk).toMatchObject({ spentAccounts: 0, unknownAccounts: 1 });
	expect(row?.row.nextReset?.outcome.kind).toBe("no-accounts");
});
it("paid fallback does not conceal exhausted subscription budget", () => {
	const subscription = { ...source("sub", 100), provider: "codex" };
	const paid = {
		...source("paid"),
		provider: "openai",
		windowObservations: null,
	};
	const row = computeWeeklyWorkloads([subscription, paid], NOW).find(
		(r) => r.row.dimensionId === "codex",
	);
	expect(row?.coverage.eligibleAccounts).toBe(1);
	expect(row?.coverage.modeledAccounts).toBe(1);
	expect(row?.row.nextReset?.outcome.kind).toBe("out-now");
	expect(row?.risk.spentAccounts).toBe(1);
});
it("an unopened family account still contributes its weekly planning checkpoint", () => {
	const a = source("reported", 50);
	if (!a.windowObservations) throw new Error("fixture");
	a.windowObservations.weeklyScoped = [
		{
			family: "fable",
			displayName: "Fable",
			percent: 60,
			resetsAtMs: NOW + 5 * DAY,
		},
	];
	const b = {
		...source("unopened"),
		windowObservations: {
			fiveHour: null,
			sevenDay: { pct: 40, resetMs: NOW + DAY },
			weeklyScoped: [],
			weeklyScopedPresent: [],
		},
	};
	const row = computeWeeklyWorkloads([a, b], NOW).find(
		(r) => r.row.dimensionKind === "family",
	);
	expect(row?.coverage).toMatchObject({
		eligibleAccounts: 2,
		modeledAccounts: 1,
		idleAccounts: 1,
	});
	expect(row?.row.nextReset?.resetsAtMs).toBe(NOW + DAY);
});
