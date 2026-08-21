import { describe, expect, test } from "bun:test";
import {
	FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT,
	type FamilyWeeklyUsage,
} from "../../../lib/pool-usage";
import { familyScopeSummary, familyWeeklyBadge } from "../PoolMetricCard";

function makeFamily(
	overrides: Partial<FamilyWeeklyUsage> & { worstPct: number },
): FamilyWeeklyUsage {
	const { worstPct } = overrides;
	const merged: FamilyWeeklyUsage = {
		family: "fable",
		label: "Fable",
		worstPct,
		worstAccountName: "acct-a",
		earliestResetMs: 0,
		elevated: worstPct >= FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT,
		accounts: [{ name: "acct-a", pct: worstPct, resetMs: 0 }],
		exhaustedCount: 0,
		elevatedCount: 0,
		...overrides,
	};
	// Derive the counts and the worst-account name from the account rows so a
	// test only has to state `accounts` and the fixture stays self-consistent —
	// unless it pinned a field explicitly.
	const worstRow = merged.accounts.reduce(
		(best, a) => (a.pct > best.pct ? a : best),
		merged.accounts[0],
	);
	return {
		...merged,
		worstAccountName: overrides.worstAccountName ?? worstRow.name,
		exhaustedCount:
			overrides.exhaustedCount ??
			merged.accounts.filter((a) => a.pct >= 100).length,
		elevatedCount:
			overrides.elevatedCount ??
			merged.accounts.filter(
				(a) => a.pct >= FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT,
			).length,
	};
}

/** N account rows: the first `elevatedPcts.length` take those pcts, rest are 5%. */
function accountRows(total: number, elevatedPcts: number[]) {
	return Array.from({ length: total }, (_, i) => ({
		name: `acct-${i}`,
		pct: elevatedPcts[i] ?? 5,
		resetMs: 0,
	}));
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

	test("one account exhausted out of six → scope-qualified, not pool-wide", () => {
		const families = [
			makeFamily({ worstPct: 100, accounts: accountRows(6, [100]) }),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "Fable weekly exhausted on 1 of 6 accounts",
			colorClass: "text-destructive-strong",
		});
	});

	test("elevated below 100 reports the elevated count, not the exhausted one", () => {
		const families = [
			makeFamily({ worstPct: 92, accounts: accountRows(6, [92, 85]) }),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "Fable weekly at 92% on 2 of 6 accounts",
			colorClass: "text-warning-strong",
		});
	});

	test("every account exhausted → the count says so", () => {
		const families = [
			makeFamily({ worstPct: 100, accounts: accountRows(3, [100, 100, 100]) }),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "Fable weekly exhausted on 3 of 3 accounts",
			colorClass: "text-destructive-strong",
		});
	});

	test("sole account exhausted → singular noun", () => {
		const families = [
			makeFamily({ worstPct: 100, accounts: accountRows(1, [100]) }),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "Fable weekly exhausted on 1 of 1 account",
			colorClass: "text-destructive-strong",
		});
	});

	test("exhausted count is used even when more accounts are merely elevated", () => {
		const families = [
			makeFamily({ worstPct: 100, accounts: accountRows(5, [100, 90, 82]) }),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "Fable weekly exhausted on 1 of 5 accounts",
			colorClass: "text-destructive-strong",
		});
	});

	test("two elevated families of two, one at 100 → destructive family count", () => {
		const families = [
			makeFamily({
				worstPct: 100,
				family: "opus",
				label: "Opus",
				accounts: accountRows(4, [100]),
			}),
			makeFamily({ worstPct: 88, accounts: accountRows(4, [88]) }),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "2 of 2 model limits elevated",
			colorClass: "text-destructive-strong",
		});
	});

	test("two elevated families, none at 100 → warning family count", () => {
		const families = [
			makeFamily({
				worstPct: 95,
				family: "opus",
				label: "Opus",
				accounts: accountRows(4, [95]),
			}),
			makeFamily({ worstPct: 88, accounts: accountRows(4, [88]) }),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "2 of 2 model limits elevated",
			colorClass: "text-warning-strong",
		});
	});

	test("multi-family denominator counts every tracked family, not just elevated", () => {
		const families = [
			makeFamily({
				worstPct: 95,
				family: "opus",
				label: "Opus",
				accounts: accountRows(4, [95]),
			}),
			makeFamily({ worstPct: 88, accounts: accountRows(4, [88]) }),
			makeFamily({
				worstPct: 12,
				family: "haiku",
				label: "Haiku",
				elevated: false,
				accounts: accountRows(4, [12]),
			}),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "2 of 3 model limits elevated",
			colorClass: "text-warning-strong",
		});
	});

	test("one elevated family among several keeps the named per-account label", () => {
		const families = [
			makeFamily({ worstPct: 92, accounts: accountRows(6, [92]) }),
			makeFamily({
				worstPct: 12,
				family: "haiku",
				label: "Haiku",
				elevated: false,
				accounts: accountRows(6, [12]),
			}),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: "Fable weekly at 92% on 1 of 6 accounts",
			colorClass: "text-warning-strong",
		});
	});

	test("a fractional pct never displays a threshold the counts disagree with", () => {
		// 99.6 is NOT exhausted, so it takes the percentage branch. Rounding would
		// print "at 100%" next to zero exhausted accounts; flooring prints 99%.
		const families = [
			makeFamily({ worstPct: 99.6, accounts: accountRows(4, [99.6]) }),
		];
		const { label, colorClass } = familyWeeklyBadge(families);
		expect(label).toBe("Fable weekly at 99% on 1 of 4 accounts");
		expect(label).not.toContain("100%");
		expect(colorClass).toBe("text-warning-strong");
	});

	test("a fractional pct below the elevated threshold does not display as elevated", () => {
		// 79.6 is below 80, so no badge at all — and nothing may print "80%".
		const families = [
			makeFamily({
				worstPct: 79.6,
				elevated: false,
				accounts: accountRows(4, [79.6]),
			}),
		];
		expect(familyWeeklyBadge(families)).toEqual({
			label: null,
			colorClass: null,
		});
	});
});

describe("familyScopeSummary", () => {
	test("single-account family names the account and uses its reset", () => {
		const f = makeFamily({
			worstPct: 100,
			earliestResetMs: 500,
			accounts: [{ name: "solo", pct: 100, resetMs: 500 }],
		});
		expect(familyScopeSummary(f)).toEqual({ prefix: "solo · ", resetMs: 500 });
	});

	test("reset belongs to the exhausted subset, not a healthy account", () => {
		// The healthy account resets FIRST. Reporting that reset next to
		// "1 of 3 exhausted" would claim the exhausted account recovers then.
		const f = makeFamily({
			worstPct: 100,
			earliestResetMs: 100,
			accounts: [
				{ name: "spent", pct: 100, resetMs: 900 },
				{ name: "healthy-a", pct: 10, resetMs: 100 },
				{ name: "healthy-b", pct: 20, resetMs: 300 },
			],
		});
		expect(familyScopeSummary(f)).toEqual({
			prefix: "1 of 3 exhausted · ",
			resetMs: 900,
		});
	});

	test("reset belongs to the elevated subset when nothing is exhausted", () => {
		const f = makeFamily({
			worstPct: 90,
			earliestResetMs: 100,
			accounts: [
				{ name: "hot-a", pct: 90, resetMs: 800 },
				{ name: "hot-b", pct: 85, resetMs: 600 },
				{ name: "healthy", pct: 10, resetMs: 100 },
			],
		});
		expect(familyScopeSummary(f)).toEqual({
			prefix: "2 of 3 elevated · ",
			resetMs: 600,
		});
	});

	test("all-healthy multi-account family falls back to the family-wide reset", () => {
		const f = makeFamily({
			worstPct: 30,
			elevated: false,
			earliestResetMs: 100,
			accounts: [
				{ name: "a", pct: 30, resetMs: 700 },
				{ name: "b", pct: 10, resetMs: 100 },
			],
		});
		expect(familyScopeSummary(f)).toEqual({
			prefix: "2 accounts · ",
			resetMs: 100,
		});
	});
});
