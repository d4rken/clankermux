import { describe, expect, it } from "bun:test";
import { classifyWorkloadGuidance } from "./workload-guidance";
import type { WorkloadHeadroomRow } from "./workload-headroom";

const coverage = {
	eligibleAccountIds: ["a", "b"],
	unreadableAccountIds: [] as string[],
	unopenedAccountIds: [] as string[],
	learningAccountIds: [] as string[],
};
const clear: Pick<
	WorkloadHeadroomRow,
	"outcome" | "headroom" | "projectionBasis"
> = {
	outcome: {
		kind: "beyond-horizon",
		horizonMs: 1000,
		unprojectableAccountIds: [],
	},
	headroom: { pct: 25, direction: "margin" },
	projectionBasis: "measured",
};
const shortfall: typeof clear = {
	...clear,
	outcome: { kind: "runway", exhaustsAtMs: 500, durationMs: 500, causes: [] },
	headroom: { pct: 20, direction: "deficit" },
};

describe("workload guidance", () => {
	it("uses each interval's own outcome, with no burn-ratio conversion", () => {
		expect(classifyWorkloadGuidance(coverage, clear)).toBe("increase");
		expect(classifyWorkloadGuidance(coverage, shortfall)).toBe("reduce");
	});
	it.each([
		"unreadableAccountIds",
		"unopenedAccountIds",
		"learningAccountIds",
	] as const)("withholds advice for %s, including omitted family inputs", (field) => {
		const partial = { ...coverage, [field]: ["b"] };
		expect(classifyWorkloadGuidance(partial, clear)).toBe("uncertain");
		expect(classifyWorkloadGuidance(partial, shortfall)).toBe("uncertain");
		expect(
			classifyWorkloadGuidance(partial, {
				...clear,
				headroom: null,
				outcome: { kind: "out-now", causes: [] },
			}),
		).toBe("uncertain");
	});
	it.each([
		"structural",
		null,
	] as const)("withholds advice for %s evidence", (projectionBasis) => {
		expect(
			classifyWorkloadGuidance(coverage, { ...clear, projectionBasis }),
		).toBe("uncertain");
	});
	it("only calls a wholly learning pool learning", () => {
		const unknown = {
			...clear,
			outcome: { kind: "unknown" as const },
			headroom: null,
			projectionBasis: null,
		};
		expect(
			classifyWorkloadGuidance(
				{
					...coverage,
					unreadableAccountIds: ["a", "b"],
					learningAccountIds: ["a", "b"],
				},
				unknown,
			),
		).toBe("learning");
		expect(
			classifyWorkloadGuidance(
				{
					...coverage,
					unreadableAccountIds: ["a", "b"],
					learningAccountIds: ["a"],
				},
				unknown,
			),
		).toBe("unknown");
		expect(classifyWorkloadGuidance(coverage, unknown)).toBe("unknown");
	});
	it("distinguishes exhausted and no accounts from an unavailable numeric threshold", () => {
		expect(
			classifyWorkloadGuidance(coverage, {
				...clear,
				outcome: { kind: "out-now", causes: [] },
				headroom: null,
			}),
		).toBe("exhausted");
		expect(
			classifyWorkloadGuidance(
				{ ...coverage, eligibleAccountIds: [] },
				{
					...clear,
					outcome: { kind: "no-accounts" },
					headroom: null,
					projectionBasis: null,
				},
			),
		).toBe("no-accounts");
		for (const forecast of [clear, shortfall]) {
			expect(
				classifyWorkloadGuidance(coverage, { ...forecast, headroom: null }),
			).toBe("unquantified");
		}
	});
	it("degrades invalid inputs without inventing an adjustment", () => {
		for (const pct of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				classifyWorkloadGuidance(coverage, {
					...clear,
					headroom: { pct, direction: "margin" },
				}),
			).toBe("other");
		}
		expect(
			classifyWorkloadGuidance(coverage, {
				...clear,
				headroom: { pct: 20, direction: "deficit" },
			}),
		).toBe("other");
		expect(
			classifyWorkloadGuidance(coverage, {
				...clear,
				outcome: { kind: "future-kind" },
			} as unknown as typeof clear),
		).toBe("other");
		expect(
			classifyWorkloadGuidance(
				{ ...coverage, unreadableAccountIds: ["not-eligible"] },
				clear,
			),
		).toBe("other");
	});
});
