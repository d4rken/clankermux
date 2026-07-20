import { describe, expect, test } from "bun:test";
import type { FamilyWeeklyUsage } from "../../../lib/pool-usage";
import { familyWeeklyBadge } from "../PoolMetricCard";

function makeFamily(
	overrides: Partial<FamilyWeeklyUsage> & { worstPct: number },
): FamilyWeeklyUsage {
	const { worstPct } = overrides;
	return {
		family: "fable",
		label: "Fable",
		worstPct,
		worstAccountName: "acct-a",
		earliestResetMs: 0,
		elevated: worstPct >= 80,
		accounts: [{ name: "acct-a", pct: worstPct, resetMs: 0 }],
		...overrides,
	} as FamilyWeeklyUsage;
}

describe("familyWeeklyBadge", () => {
	test("empty input → no badge", () => {
		expect(familyWeeklyBadge([])).toEqual({ label: null, colorClass: null });
	});

	test("single non-elevated family → no badge", () => {
		const families = [makeFamily({ worstPct: 45, elevated: false })];
		expect(familyWeeklyBadge(families)).toEqual({
			label: null,
			colorClass: null,
		});
	});

	test("single elevated family below 100 → warning at pct", () => {
		const families = [makeFamily({ worstPct: 92 })];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "Fable weekly limit at 92%",
			colorClass: "text-warning",
		});
	});

	test("single elevated family at 100 → destructive exhausted", () => {
		const families = [makeFamily({ worstPct: 100 })];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "Fable weekly limit exhausted",
			colorClass: "text-destructive",
		});
	});

	test("two elevated families, one at 100 → destructive count", () => {
		const families = [
			makeFamily({ worstPct: 100, family: "opus", label: "Opus" }),
			makeFamily({ worstPct: 88 }),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "2 model limits elevated",
			colorClass: "text-destructive",
		});
	});

	test("two elevated families, none at 100 → warning count", () => {
		const families = [
			makeFamily({ worstPct: 95, family: "opus", label: "Opus" }),
			makeFamily({ worstPct: 88 }),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "2 model limits elevated",
			colorClass: "text-warning",
		});
	});
});
