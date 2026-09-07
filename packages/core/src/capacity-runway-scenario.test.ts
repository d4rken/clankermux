import { describe, expect, it } from "bun:test";
import {
	computeCapacityRunway,
	estimateWindowExhaustion,
	type RunwayAccountInput,
	type RunwayResetCreditBank,
	type RunwayWindowInput,
} from "./capacity-runway";
import {
	computeCapacityRunwayScenario,
	equalShareRule,
	observationLagMs,
	proportionalShareRule,
	type RunwayScenarioAccountInput,
	type RunwayScenarioOutcome,
	type RunwayScenarioPresence,
	type ShareCandidate,
	type ShareRule,
} from "./capacity-runway-scenario";
import { type AccountTier, tierCapacityUnits } from "./tier-capacity";

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const MAX20: AccountTier = {
	provider: "anthropic",
	planTier: "max",
	rateLimitTier: "20x",
	provenance: "recorded",
};
const MAX5: AccountTier = {
	provider: "anthropic",
	planTier: "max",
	rateLimitTier: "5x",
	provenance: "recorded",
};
const PRO1: AccountTier = {
	provider: "anthropic",
	planTier: "pro",
	rateLimitTier: null,
	provenance: "recorded",
};
const CODEX_PRO: AccountTier = {
	provider: "codex",
	planTier: "pro",
	rateLimitTier: null,
	provenance: "recorded",
};
const CODEX_PROLITE: AccountTier = {
	provider: "codex",
	planTier: "prolite",
	rateLimitTier: null,
	provenance: "recorded",
};
const CODEX_PLUS: AccountTier = {
	provider: "codex",
	planTier: "plus",
	rateLimitTier: null,
	provenance: "assumed",
};

/** Weekly window read at `pct`, started `startedDaysAgo` ago, 7-day cycle. */
function weekly(pct: number, startedDaysAgo = 1): RunwayWindowInput {
	const startMs = NOW - startedDaysAgo * DAY;
	return {
		windowKind: "seven_day",
		utilizationPct: pct,
		windowStartMs: startMs,
		resetsAtMs: startMs + 7 * DAY,
		prediction: null,
		lifetimeConfidence: "full",
		observedAtMs: NOW,
	};
}

/** Five-hour window read at `pct`, started `startedHoursAgo` ago. */
function fiveHour(pct: number, startedHoursAgo: number): RunwayWindowInput {
	const startMs = NOW - startedHoursAgo * HOUR;
	return {
		windowKind: "five_hour",
		utilizationPct: pct,
		windowStartMs: startMs,
		resetsAtMs: startMs + 5 * HOUR,
		prediction: null,
		lifetimeConfidence: "full",
		observedAtMs: NOW,
	};
}

function acct(
	accountId: string,
	windows: RunwayWindowInput[],
	options: {
		tier?: AccountTier | null;
		demandClass?: string;
		presence?: RunwayScenarioPresence;
		unmetered?: boolean;
		codexResetCredits?: RunwayResetCreditBank;
	} = {},
): RunwayScenarioAccountInput {
	return {
		accountId,
		unmetered: options.unmetered ?? false,
		windows,
		demandClass: options.demandClass ?? "anthropic",
		tier: options.tier === undefined ? MAX20 : options.tier,
		...(options.presence ? { presence: options.presence } : {}),
		...(options.codexResetCredits
			? { codexResetCredits: options.codexResetCredits }
			: {}),
	};
}

/** The same accounts as the CURRENT model sees them — scenario fields stripped. */
function baselineInputs(
	accounts: RunwayScenarioAccountInput[],
): RunwayAccountInput[] {
	return accounts.map((account) => ({
		accountId: account.accountId,
		unmetered: account.unmetered,
		windows: account.windows,
		...(account.codexResetCredits
			? { codexResetCredits: account.codexResetCredits }
			: {}),
	}));
}

describe("computeCapacityRunwayScenario", () => {
	it("moves a dead account's demand onto the survivor", () => {
		const accounts = [acct("A", [weekly(20)]), acct("B", [weekly(40)])];

		// The current model holds both slopes fixed: B dies at 1.5d, A at 4d.
		const fixed = computeCapacityRunway(baselineInputs(accounts), NOW);
		expect(fixed.kind).toBe("runway");
		if (fixed.kind !== "runway") throw new Error("unreachable");
		expect(fixed.exhaustsAtMs).toBeCloseTo(NOW + 4 * DAY, -3);

		// Conserved: 60%/d of MAX20 demand, split 30%/d each. B dies at 2d, A is
		// then at 80% and takes the whole 60%/d — 8h later the pool is out.
		const result = computeCapacityRunwayScenario(accounts, NOW);
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + 2 * DAY + 8 * HOUR, -3);
		expect(result.causes).toEqual([
			{ accountId: "A", windowKind: "seven_day" },
			{ accountId: "B", windowKind: "seven_day" },
		]);
		expect(result.basis).toBe("demand-conserving");
		expect(result.demandUnitsPerHour).toEqual([
			{ demandClass: "anthropic", windowKind: "seven_day", unitsPerHour: 50 },
		]);
		expect(result.tiers).toEqual([
			{
				accountId: "A",
				provider: "anthropic",
				planTier: "max",
				rateLimitTier: "20x",
				capacityUnits: 20,
				provenance: "recorded",
			},
			{
				accountId: "B",
				provider: "anthropic",
				planTier: "max",
				rateLimitTier: "20x",
				capacityUnits: 20,
				provenance: "recorded",
			},
		]);
		expect(result.includedLearningAccounts).toEqual([]);
		expect(result.unknownTierAccountIds).toEqual([]);
		expect(result.demandOnlyAccountIds).toEqual([]);
	});

	it("gives a newcomer a share instead of withholding it", () => {
		const accounts = [
			acct("A", [weekly(30)]),
			acct("B", [weekly(30)]),
			acct("N", [weekly(0)]),
		];

		// Today: N is learning, so it is excluded and A/B keep their own slopes.
		const excluded = computeCapacityRunway(baselineInputs(accounts), NOW);
		expect(excluded.kind).toBe("runway");
		if (excluded.kind !== "runway") throw new Error("unreachable");
		expect(excluded.learningAccountIds).toEqual(["N"]);
		expect(excluded.exhaustsAtMs).toBeCloseTo(NOW + (7 / 3) * DAY, -3);

		// Conserved: the same 60%/d over three accounts, 20%/d each. A and B die
		// at 3.5d with N at 70%, which then takes the whole 60%/d. The equal
		// split is passed explicitly because that even division is what this
		// case is about; the scan's default is the proportional rule.
		const result = computeCapacityRunwayScenario(accounts, NOW, undefined, {
			shareRule: equalShareRule,
		});
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + 4 * DAY, -3);
		expect(result.includedLearningAccounts).toHaveLength(1);
		expect(result.includedLearningAccounts[0].accountId).toBe("N");
		expect(
			result.includedLearningAccounts[0].shareOfClassByKind.seven_day,
		).toBeCloseTo(1 / 3, 10);
		expect(result.learningAccountIds).toBeUndefined();
		expect(result.unprojectableAccountIds).toEqual([]);
	});

	it("turns a mixed account's withheld infinity into a date", () => {
		const accounts = [
			acct("A", [fiveHour(10, 2), weekly(5)]),
			acct("B", [fiveHour(2, 0.5), weekly(40)]),
		];

		// Today: B's 30-minute 5h reading is learning, so the whole account is
		// withheld and A alone never runs out.
		const withheld = computeCapacityRunway(baselineInputs(accounts), NOW);
		expect(withheld.kind).toBe("beyond-horizon");
		if (withheld.kind !== "beyond-horizon") throw new Error("unreachable");
		expect(withheld.learningAccountIds).toEqual(["B"]);

		// Conserved: 45%/d of weekly demand split 22.5%/d each — the equal split,
		// passed explicitly, since the even division is the arithmetic below. B
		// dies at 8/3 d with A at 65%, which then takes the whole 45%/d. Neither
		// 5h window can fill inside a cycle, so no 5h window is ever a cause.
		const result = computeCapacityRunwayScenario(accounts, NOW, undefined, {
			shareRule: equalShareRule,
		});
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + (8 / 3 + 35 / 45) * DAY, -3);
		expect(
			result.causes.every((cause) => cause.windowKind === "seven_day"),
		).toBe(true);
		expect(result.includedLearningAccounts).toHaveLength(1);
		expect(result.includedLearningAccounts[0].accountId).toBe("B");
		expect(
			result.includedLearningAccounts[0].shareOfClassByKind.seven_day,
		).toBeCloseTo(0.5, 10);
	});

	it("keeps a paused or removed account's burn as demand without ever making it alive", () => {
		const result = computeCapacityRunwayScenario(
			[
				acct("A", [weekly(20)]),
				acct("R", [weekly(20)], { presence: "demand-only" }),
			],
			NOW,
		);

		// A carries both accounts' 20%/d: 40%/d, so 80% of headroom lasts 2 days.
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + 2 * DAY, -3);
		expect(result.causes).toEqual([
			{ accountId: "A", windowKind: "seven_day" },
		]);
		expect(result.demandOnlyAccountIds).toEqual(["R"]);
		expect(result.tiers.map((tier) => tier.accountId)).toEqual(["A", "R"]);
		expect(result.unprojectableAccountIds).toEqual([]);
	});

	it("reads the same slope as more demand on a bigger tier", () => {
		const unitsFor = (tier: AccountTier): number => {
			const result = computeCapacityRunwayScenario(
				[acct("C", [weekly(24)], { tier, demandClass: "codex" })],
				NOW,
			);
			if (result.demandUnitsPerHour.length !== 1) {
				throw new Error("expected one measured demand row");
			}
			return result.demandUnitsPerHour[0].unitsPerHour;
		};

		// 24%/d is 1%/h, so the units per hour ARE the tier's capacity units.
		expect(unitsFor(CODEX_PRO)).toBeCloseTo(20, 10);
		expect(unitsFor(CODEX_PROLITE)).toBeCloseTo(5, 10);
		expect(unitsFor(CODEX_PLUS)).toBeCloseTo(1, 10);
	});

	it("redistributes capacity units, never averaged percentages", () => {
		const result = computeCapacityRunwayScenario(
			[
				acct("A", [weekly(90)], { tier: MAX20 }),
				acct("B", [weekly(10)], { tier: PRO1 }),
			],
			NOW,
		);

		// Averaging the percentages would give both 50%/d and put the pool out at
		// about a day. In units: 1810/d split evenly is 45.25%/d for A and
		// 905%/d for B, so B dies in 90/905 d with A at 94.5%.
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(
			NOW + (90 / 905 + 5.5 / 90.5) * DAY,
			-3,
		);
		expect(result.demandUnitsPerHour[0].unitsPerHour).toBeCloseTo(1810 / 24, 8);
	});

	it("excludes and discloses an unknown tier instead of weighting it 1", () => {
		const result = computeCapacityRunwayScenario(
			[acct("A", [weekly(20)]), acct("U", [weekly(60)], { tier: null })],
			NOW,
		);

		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + 4 * DAY, -3);
		expect(result.unknownTierAccountIds).toEqual(["U"]);
		expect(result.unprojectableAccountIds).toEqual(["U"]);
		expect(result.tiers.map((tier) => tier.accountId)).toEqual(["A"]);
		expect(result.demandUnitsPerHour).toEqual([
			{
				demandClass: "anthropic",
				windowKind: "seven_day",
				unitsPerHour: (20 * 20) / 24,
			},
		]);

		// The same roster with U's tier known runs out 2.5 days sooner.
		const known = computeCapacityRunwayScenario(
			[acct("A", [weekly(20)]), acct("U", [weekly(60)])],
			NOW,
		);
		expect(known.kind).toBe("runway");
		if (known.kind !== "runway") throw new Error("unreachable");
		expect(known.exhaustsAtMs).toBeCloseTo(NOW + 1.5 * DAY, -3);
	});

	it("honours an injected capacity table that cannot place a tier", () => {
		const result = computeCapacityRunwayScenario(
			[acct("A", [weekly(20)]), acct("U", [weekly(60)], { tier: PRO1 })],
			NOW,
			undefined,
			{
				capacityUnits: (tier) =>
					tier.planTier === "pro" ? null : tierCapacityUnits(tier),
			},
		);

		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + 4 * DAY, -3);
		expect(result.unknownTierAccountIds).toEqual(["U"]);
		expect(result.unprojectableAccountIds).toEqual(["U"]);
		expect(result.tiers.map((tier) => tier.accountId)).toEqual(["A"]);
	});

	it("withholds a learning window whose class never measured that kind", () => {
		// (a) Nothing measured anywhere: unknown, not infinity.
		const alone = computeCapacityRunwayScenario([acct("N", [weekly(0)])], NOW);
		expect(alone.kind).toBe("unknown");
		if (alone.kind !== "unknown") throw new Error("unreachable");
		expect(alone.learningAccountIds).toEqual(["N"]);
		expect(alone.includedLearningAccounts).toEqual([]);
		expect(alone.basis).toBe("demand-conserving");

		// (b) Demand is never moved across classes, so an anthropic slope is not
		// something a codex learner can borrow.
		const otherClass = computeCapacityRunwayScenario(
			[
				acct("A", [weekly(20)]),
				acct("N", [weekly(0)], { demandClass: "codex", tier: CODEX_PRO }),
			],
			NOW,
		);
		expect(otherClass.kind).toBe("runway");
		if (otherClass.kind !== "runway") throw new Error("unreachable");
		expect(otherClass.unprojectableAccountIds).toEqual(["N"]);
		expect(otherClass.learningAccountIds).toEqual(["N"]);
		expect(otherClass.exhaustsAtMs).toBeCloseTo(NOW + 4 * DAY, -3);

		// (c) ONE unmeasured kind is enough: the class measured seven_day but
		// nothing measured five_hour.
		const mixed = computeCapacityRunwayScenario(
			[acct("A", [weekly(20)]), acct("M", [fiveHour(2, 0.5), weekly(0)])],
			NOW,
		);
		expect(mixed.kind).toBe("runway");
		if (mixed.kind !== "runway") throw new Error("unreachable");
		expect(mixed.unprojectableAccountIds).toEqual(["M"]);
		expect(mixed.learningAccountIds).toEqual(["M"]);
		expect(mixed.exhaustsAtMs).toBeCloseTo(NOW + 4 * DAY, -3);
	});

	it("lets a reset credit revive a window and take a share again", () => {
		const bank: RunwayResetCreditBank = {
			onWeeklyLimitEnabled: true,
			onExpiryEnabled: false,
			credits: [{ expiresAtMs: null }],
		};
		const withBank = computeCapacityRunwayScenario(
			[
				acct("C", [weekly(90)], {
					tier: CODEX_PRO,
					demandClass: "codex",
					codexResetCredits: bank,
				}),
			],
			NOW,
		);

		// Dead at 10/90 d, revived at 0%, and back to 100% a full 100/90 d later.
		expect(withBank.kind).toBe("runway");
		if (withBank.kind !== "runway") throw new Error("unreachable");
		expect(withBank.exhaustsAtMs).toBeCloseTo(
			NOW + (10 / 90 + 100 / 90) * DAY,
			-3,
		);
		expect(withBank.assumedResetCredits).toEqual([
			{ accountId: "C", count: 1 },
		]);

		const withoutBank = computeCapacityRunwayScenario(
			[acct("C", [weekly(90)], { tier: CODEX_PRO, demandClass: "codex" })],
			NOW,
		);
		expect(withoutBank.kind).toBe("runway");
		if (withoutBank.kind !== "runway") throw new Error("unreachable");
		expect(withoutBank.exhaustsAtMs).toBeCloseTo(NOW + (10 / 90) * DAY, -3);
		expect(withoutBank.assumedResetCredits).toBeUndefined();
	});

	it("revives a dead window at a credit's expiry", () => {
		const codex = (
			id: string,
			pct: number,
			bank?: RunwayResetCreditBank,
		): RunwayScenarioAccountInput =>
			acct(id, [weekly(pct)], {
				tier: CODEX_PRO,
				demandClass: "codex",
				...(bank ? { codexResetCredits: bank } : {}),
			});

		// C is spent now; its window took a day to fill, so it carries 100%/d of
		// the class demand even while it is dead.
		const withoutBank = computeCapacityRunwayScenario(
			[codex("C", 100), codex("D", 50)],
			NOW,
		);
		expect(withoutBank.kind).toBe("runway");
		if (withoutBank.kind !== "runway") throw new Error("unreachable");
		expect(withoutBank.exhaustsAtMs).toBeCloseTo(NOW + DAY / 3, -3);

		const withBank = computeCapacityRunwayScenario(
			[
				codex("C", 100, {
					onWeeklyLimitEnabled: false,
					onExpiryEnabled: true,
					credits: [{ expiresAtMs: NOW + 0.1 * DAY }],
				}),
				codex("D", 50),
			],
			NOW,
		);
		// C comes back at 0.1d with D at 65%; from there they share 75%/d each,
		// D dies at 0.5667d and C carries the whole 150%/d from 35%.
		expect(withBank.kind).toBe("runway");
		if (withBank.kind !== "runway") throw new Error("unreachable");
		expect(withBank.exhaustsAtMs).toBeCloseTo(NOW + DAY, -3);
		expect(withBank.assumedResetCredits).toEqual([
			{ accountId: "C", count: 1 },
		]);
	});

	it("redeems a weekly-limit credit at setup for a window already spent at now", () => {
		const bank: RunwayResetCreditBank = {
			onWeeklyLimitEnabled: true,
			onExpiryEnabled: false,
			credits: [{ expiresAtMs: null }],
		};
		const pair = computeCapacityRunwayScenario(
			[
				acct("C", [weekly(100)], {
					tier: CODEX_PRO,
					demandClass: "codex",
					codexResetCredits: bank,
				}),
				acct("D", [weekly(50)], { tier: CODEX_PRO, demandClass: "codex" }),
			],
			NOW,
		);

		// Revived before the first assignment: 75%/d each from now, D out at 2/3 d
		// with C at 50%, C alone at 150%/d for the last third of a day.
		expect(pair.kind).toBe("runway");
		if (pair.kind !== "runway") throw new Error("unreachable");
		expect(pair.exhaustsAtMs).toBeCloseTo(NOW + DAY, -3);
		expect(pair.assumedResetCredits).toEqual([{ accountId: "C", count: 1 }]);

		const alone = computeCapacityRunwayScenario(
			[
				acct("C", [weekly(100)], {
					tier: CODEX_PRO,
					demandClass: "codex",
					codexResetCredits: bank,
				}),
			],
			NOW,
		);
		// The credit applies, so this is a runway and never `out-now`.
		expect(alone.kind).toBe("runway");
		if (alone.kind !== "runway") throw new Error("unreachable");
		expect(alone.exhaustsAtMs).toBeCloseTo(NOW + DAY, -3);
		expect(alone.assumedResetCredits).toEqual([{ accountId: "C", count: 1 }]);
	});

	it("discloses how fragile a beyond-horizon verdict is", () => {
		// 86%/14%/d is 6.14d, just past the 6d reset, and a fresh cycle needs
		// 7.14d — so nothing is ever dead at pace 1.
		const result = computeCapacityRunwayScenario(
			[acct("A", [weekly(14)])],
			NOW,
		);
		expect(result.kind).toBe("beyond-horizon");
		if (result.kind !== "beyond-horizon") throw new Error("unreachable");
		const margin = result.paceMargin;
		expect(margin).toBeDefined();
		if (!margin) throw new Error("unreachable");
		expect(margin.multiplier).toBeCloseTo(1.03, 5);
		expect(margin.exhaustsAtMs).toBeCloseTo(NOW + (86 / (14 * 1.03)) * DAY, -3);
	});

	it("discloses the slowdown a finite runway needs", () => {
		const result = computeCapacityRunwayScenario(
			[acct("A", [weekly(20)])],
			NOW,
		);
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + 4 * DAY, -3);
		// 0.66 clears the first cycle (6.06d > 6d) and every later one (7.58d >
		// 7d); 0.67 fills in 5.97d and dies before the reset.
		expect(result.paceDeficit?.multiplier).toBeCloseTo(0.66, 5);

		const unprobed = computeCapacityRunwayScenario(
			[acct("A", [weekly(20)])],
			NOW,
			undefined,
			{ probePaceMargin: false },
		);
		expect(unprobed.kind).toBe("runway");
		if (unprobed.kind !== "runway") throw new Error("unreachable");
		expect(unprobed.paceDeficit).toBeUndefined();
		expect(unprobed.eventBudgetExhausted).toBeUndefined();
	});

	it("keeps a baseline that finished and says which scan ran out of budget", () => {
		// The pool-out itself needs one event (A's exhaustion at 4d) and stands.
		// What runs out of budget is the walk PAST it: the baseline keeps going to
		// complete `projectedExhaustions`, and A's reset at 6d is a second event.
		// The deficit walk is also cut short (at pace 0.5 A survives its first
		// cycle and needs two reset events before it can conclude), but the
		// incomplete projection list is the stronger caveat and is the one named.
		const result = computeCapacityRunwayScenario(
			[acct("A", [weekly(20)])],
			NOW,
			undefined,
			{ maxEvents: 1 },
		);
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + 4 * DAY, -3);
		expect(result.paceDeficit).toBeUndefined();
		expect(result.eventBudgetExhausted).toBe("projection");
	});

	it("keeps the pool alive on an unmetered account and probes nothing", () => {
		const result = computeCapacityRunwayScenario(
			[acct("A", [weekly(90)]), acct("O", [], { unmetered: true, tier: null })],
			NOW,
		);

		expect(result.kind).toBe("beyond-horizon");
		if (result.kind !== "beyond-horizon") throw new Error("unreachable");
		expect(result.paceMargin).toBeUndefined();
		expect(result.unknownTierAccountIds).toEqual([]);
		expect(result.unprojectableAccountIds).toEqual([]);
	});

	it("reports a pool that is already out", () => {
		const spent = computeCapacityRunwayScenario(
			[acct("A", [weekly(100)])],
			NOW,
		);
		expect(spent.kind).toBe("out-now");
		if (spent.kind !== "out-now") throw new Error("unreachable");
		expect(spent.causes).toEqual([{ accountId: "A", windowKind: "seven_day" }]);
		expect(spent.learningAccountIds).toBeUndefined();

		// Every account of the class spent on its 5h window, exactly as the
		// current model reports the same inputs.
		const accounts = [
			acct("A", [fiveHour(100, 4), weekly(20)]),
			acct("B", [fiveHour(100, 4), weekly(20)]),
		];
		const fiveHourOut = computeCapacityRunwayScenario(accounts, NOW);
		expect(fiveHourOut.kind).toBe("out-now");
		if (fiveHourOut.kind !== "out-now") throw new Error("unreachable");
		expect(fiveHourOut.causes).toEqual([
			{ accountId: "A", windowKind: "five_hour" },
			{ accountId: "B", windowKind: "five_hour" },
		]);
		expect(computeCapacityRunway(baselineInputs(accounts), NOW).kind).toBe(
			"out-now",
		);
	});

	it("pools an account whose only projection is exhausted plus learning", () => {
		const withPeer = computeCapacityRunwayScenario(
			[acct("A", [fiveHour(100, 4), weekly(0)]), acct("B", [weekly(20)])],
			NOW,
			undefined,
			// The halves below are the equal split's, so it is the rule passed.
			{ shareRule: equalShareRule },
		);
		// A's weekly kind is measured by B, and an exhausted window is a fact
		// rather than a projection, so A stays in and takes half the class at its
		// first alive assignment (its 5h reset, one hour out).
		expect(withPeer.unprojectableAccountIds).toEqual([]);
		expect(withPeer.includedLearningAccounts).toHaveLength(1);
		expect(withPeer.includedLearningAccounts[0].accountId).toBe("A");
		expect(
			withPeer.includedLearningAccounts[0].shareOfClassByKind.seven_day,
		).toBeCloseTo(0.5, 10);
		expect(
			withPeer.includedLearningAccounts[0].shareOfClassByKind.five_hour,
		).toBeCloseTo(0.5, 10);

		const alone = computeCapacityRunwayScenario(
			[acct("A", [fiveHour(100, 4), weekly(0)])],
			NOW,
			undefined,
			{ shareRule: equalShareRule },
		);
		expect(alone.kind).toBe("unknown");
		if (alone.kind !== "unknown") throw new Error("unreachable");
		expect(alone.learningAccountIds).toEqual(["A"]);
	});

	it("treats a reset that coincides with an exhaustion as no dead span", () => {
		// A refills its 5h window exactly once per cycle (20%/h from 20% at +1h),
		// so its projected exhaustion lands ON every reset. B is a codex account
		// dead from 4d to 6d; a mishandled tie would hold A dead for whole cycles
		// and overlap that span.
		const roster = (utilizationPct: number): RunwayScenarioAccountInput[] => [
			{ ...acct("A", [{ ...fiveHour(20, 1), utilizationPct }]) },
			acct("B", [weekly(20)], { tier: CODEX_PRO, demandClass: "codex" }),
		];

		const exact = computeCapacityRunwayScenario(roster(20), NOW);
		expect(exact.kind).toBe("beyond-horizon");

		// A is alone in class anthropic and classes are assigned in
		// first-appearance order, so a round in which A is alive contributes an
		// ["A"] call before B's. A round where A is dead shows up as two
		// consecutive calls without A.
		const sawAAbsent = (calls: string[][]): boolean =>
			calls.some(
				(ids, index) =>
					index + 1 < calls.length &&
					!ids.includes("A") &&
					!calls[index + 1].includes("A"),
			);
		const spyOn = (
			accounts: RunwayScenarioAccountInput[],
		): {
			calls: string[][];
			result: ReturnType<typeof computeCapacityRunwayScenario>;
		} => {
			const calls: string[][] = [];
			const shareRule: ShareRule = (candidates) => {
				calls.push(candidates.map((candidate) => candidate.accountId));
				return candidates.map(() => 1);
			};
			// The probes would run the same rule again; this test asserts on the
			// baseline's call list only.
			const result = computeCapacityRunwayScenario(accounts, NOW, undefined, {
				shareRule,
				probePaceMargin: false,
			});
			return { calls, result };
		};

		// A perturbed reading perturbs the slope too, so a fresh cycle fills short
		// of 5h by the same amount before EVERY reset. Half a millisecond stays
		// inside the tie tolerance, cycle after cycle.
		const within = spyOn(roster(20 + (20 * 0.1) / HOUR));
		expect(within.result.kind).toBe("beyond-horizon");
		expect(sawAAbsent(within.calls)).toBe(false);

		// Nine-tenths of a second is a real dead sliver before each reset. A's
		// reset at +99h falls inside B's dead span, so the pool goes out there.
		const outside = spyOn(roster(20.001));
		expect(outside.result.kind).toBe("runway");
		if (outside.result.kind !== "runway") throw new Error("unreachable");
		expect(outside.result.exhaustsAtMs).toBeGreaterThanOrEqual(
			NOW + 99 * HOUR - 2000,
		);
		expect(outside.result.exhaustsAtMs).toBeLessThan(NOW + 99 * HOUR);
		expect(sawAAbsent(outside.calls)).toBe(true);
	});

	it("derives the schedule of an exhausted window whose timestamps are unvalidated", () => {
		// (a) No structural start: no observed fill, so no demand, and the single
		// reset at +1d is a one-time recovery with no cycle behind it.
		const recovered = computeCapacityRunwayScenario(
			[
				acct("A", [
					{
						windowKind: "seven_day",
						utilizationPct: 100,
						windowStartMs: null,
						resetsAtMs: NOW + DAY,
						prediction: null,
						lifetimeConfidence: "full",
						observedAtMs: NOW,
					},
				]),
				acct("B", [weekly(30)]),
			],
			NOW,
		);
		// B carries 30%/d alone to +1d (at 60%), then 15%/d each: B dies at 11/3 d
		// with A at 40%, and A alone at 30%/d takes two more days. Without the
		// recovery the pool would have been out at 7/3 d.
		expect(recovered.kind).toBe("runway");
		if (recovered.kind !== "runway") throw new Error("unreachable");
		expect(recovered.exhaustsAtMs).toBeCloseTo(NOW + (17 / 3) * DAY, -3);

		// (b) A stale reset: the reading itself is stale, so it contributes no
		// demand and the window never revives.
		const staleWindow: RunwayWindowInput = {
			windowKind: "seven_day",
			utilizationPct: 100,
			windowStartMs: NOW - 8 * DAY,
			resetsAtMs: NOW - DAY,
			prediction: null,
			lifetimeConfidence: "full",
			observedAtMs: NOW,
		};
		const staleAlone = computeCapacityRunwayScenario(
			[acct("A", [staleWindow])],
			NOW,
		);
		expect(staleAlone.kind).toBe("out-now");

		const stalePair = computeCapacityRunwayScenario(
			[acct("A", [staleWindow]), acct("B", [weekly(20)])],
			NOW,
		);
		expect(stalePair.kind).toBe("runway");
		if (stalePair.kind !== "runway") throw new Error("unreachable");
		expect(stalePair.exhaustsAtMs).toBeCloseTo(NOW + 4 * DAY, -3);
	});

	it("activates an unstarted window on its first burn and ignores the placeholder reset", () => {
		const result = computeCapacityRunwayScenario(
			[
				acct("A", [fiveHour(50, 1)]),
				acct("N", [
					{
						windowKind: "five_hour",
						utilizationPct: 0,
						windowStartMs: NOW - 4 * HOUR,
						resetsAtMs: NOW + HOUR,
						prediction: null,
						lifetimeConfidence: "full",
						observedAtMs: NOW - 4 * HOUR,
					},
				]),
			],
			NOW,
		);

		// Activated at now, so N's real cycle ends at +5h. At 25%/h each A dies at
		// +2h and N — at 50% — takes the whole 50%/h and dies at +3h. Honouring
		// the placeholder would have reset N at +1h and pushed this to +3.5h.
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + 3 * HOUR, -3);
	});

	it("reports an empty roster without inventing a basis", () => {
		const result = computeCapacityRunwayScenario([], NOW);
		expect(result).toEqual({
			kind: "no-accounts",
			basis: "demand-conserving",
			demandUnitsPerHour: [],
			tiers: [],
			includedLearningAccounts: [],
			unknownTierAccountIds: [],
			demandOnlyAccountIds: [],
			projectedExhaustions: [],
			firstExhaustionAfterNowByClass: [],
		});
	});

	it("stops a runaway baseline scan and says so", () => {
		// J's window is a one-millisecond cycle: it resets every millisecond, so
		// the walk cannot reach the horizon.
		const result = computeCapacityRunwayScenario(
			[
				acct("A", [weekly(20)]),
				acct("J", [
					{
						windowKind: "seven_day",
						utilizationPct: 50,
						windowStartMs: NOW - 1,
						resetsAtMs: NOW + 1,
						prediction: null,
						lifetimeConfidence: "full",
						observedAtMs: NOW,
					},
				]),
			],
			NOW,
		);

		expect(result.kind).toBe("unknown");
		expect(result.eventBudgetExhausted).toBe("baseline");
	});

	it("routes demand through the injected share rule", () => {
		const roster = (): RunwayScenarioAccountInput[] => [
			acct("A", [fiveHour(50, 1)]),
			acct("B", [fiveHour(50, 4)]),
		];
		const seen: Array<Array<{ accountId: string; pct: number }>> = [];
		const record =
			(rule: ShareRule): ShareRule =>
			(candidates, windowKind) => {
				seen.push(
					candidates.map((candidate) => ({
						accountId: candidate.accountId,
						pct: candidate.windows[0].utilizationPct,
					})),
				);
				return rule(candidates, windowKind);
			};

		// Equal: B resets at +1h with A at 81.25%, A dies at +1.6h, and B alone
		// burns 62.5%/h from 18.75% to reach 100% at +2.9h.
		const equal = computeCapacityRunwayScenario(roster(), NOW, undefined, {
			shareRule: record((candidates) => candidates.map(() => 1)),
			probePaceMargin: false,
		});
		expect(equal.kind).toBe("runway");
		if (equal.kind !== "runway") throw new Error("unreachable");
		expect(equal.exhaustsAtMs).toBeCloseTo(NOW + 2.9 * HOUR, -3);
		expect(seen[0]).toEqual([
			{ accountId: "A", pct: 50 },
			{ accountId: "B", pct: 50 },
		]);
		expect(
			seen.some((call) => call.length === 1 && call[0].accountId === "B"),
		).toBe(true);

		// All of it on A: A dies at +0.8h, B resets at +1h without having burned
		// anything, and then carries everything to +2.6h.
		const favourA: ShareRule = (candidates) =>
			candidates.some((candidate) => candidate.accountId === "A")
				? candidates.map((candidate) => (candidate.accountId === "A" ? 1 : 0))
				: candidates.map(() => 1);
		const skewed = computeCapacityRunwayScenario(roster(), NOW, undefined, {
			shareRule: favourA,
			probePaceMargin: false,
		});
		expect(skewed.kind).toBe("runway");
		if (skewed.kind !== "runway") throw new Error("unreachable");
		expect(skewed.exhaustsAtMs).toBeCloseTo(NOW + 2.6 * HOUR, -3);
	});

	describe("projectedExhaustions", () => {
		it("lists every window the baseline drove to 100% in its first cycle", () => {
			// The module's first case: 60%/d of demand split 30%/d each — the equal
			// split, passed explicitly — B out at 2d, A — then carrying all of it
			// from 80% — 8h later.
			const result = computeCapacityRunwayScenario(
				[acct("A", [weekly(20)]), acct("B", [weekly(40)])],
				NOW,
				undefined,
				{ shareRule: equalShareRule },
			);
			expect(result.kind).toBe("runway");
			if (result.kind !== "runway") throw new Error("unreachable");
			expect(result.exhaustsAtMs).toBeCloseTo(NOW + 2 * DAY + 8 * HOUR, -3);
			expect(result.projectedExhaustions).toHaveLength(2);
			expect(result.projectedExhaustions[0].accountId).toBe("B");
			expect(result.projectedExhaustions[0].windowKind).toBe("seven_day");
			expect(result.projectedExhaustions[0].exhaustsAtMs).toBeCloseTo(
				NOW + 2 * DAY,
				-3,
			);
			expect(result.projectedExhaustions[1].accountId).toBe("A");
			expect(result.projectedExhaustions[1].exhaustsAtMs).toBeCloseTo(
				NOW + 2 * DAY + 8 * HOUR,
				-3,
			);
		});

		it("omits an exhaustion that only happens in a later cycle", () => {
			// D = 50 + 1600 units/h, 825 each => 41.25%/h each. B (80%, resets at
			// +4h) dies at 20/41.25 h; A then takes all 1650 units (82.5%/h) from
			// 30%, reaches 72.5% at its own reset at +1h, and only exhausts ~1.21h
			// into the SECOND cycle — which the caller's reading says nothing about.
			const result = computeCapacityRunwayScenario(
				[acct("A", [fiveHour(10, 4)]), acct("B", [fiveHour(80, 1)])],
				NOW,
				undefined,
				{ shareRule: equalShareRule },
			);
			expect(result.kind).toBe("runway");
			if (result.kind !== "runway") throw new Error("unreachable");
			expect(result.projectedExhaustions).toHaveLength(1);
			expect(result.projectedExhaustions[0]).toMatchObject({
				accountId: "B",
				windowKind: "five_hour",
			});
			expect(result.projectedExhaustions[0].exhaustsAtMs).toBeCloseTo(
				NOW + (20 / 41.25) * HOUR,
				-3,
			);
		});

		it("keeps walking past the pool-out to finish a still-pending window", () => {
			// A: 5h at 80% (1h in, resets at +4h) and a weekly at 99% (3.5d in);
			// B: a weekly already spent, 3.5d in, whose fill demand still counts.
			//
			// Weekly demand = (99 + 100)/84 %/h x 20 = 47.38 units/h, and B is dead
			// throughout, so A carries all of it at 199/84 %/h. A's 5h carries the
			// whole 1600 units/h => 80%/h, so it dies 0.25h in and the pool is out
			// there. A's weekly is at 99 + 199/336 % by then; the 5h window resets
			// at +4h, A is alive again, and 137/796 h later the weekly fills — still
			// inside the cycle the reading came from (its reset is at +3.5d).
			const accounts = [
				acct("A", [fiveHour(80, 1), weekly(99, 3.5)]),
				acct("B", [weekly(100, 3.5)]),
			];
			const result = computeCapacityRunwayScenario(accounts, NOW);
			expect(result.kind).toBe("runway");
			if (result.kind !== "runway") throw new Error("unreachable");
			expect(result.exhaustsAtMs).toBeCloseTo(NOW + 0.25 * HOUR, -3);
			expect(result.causes).toEqual([
				{ accountId: "A", windowKind: "five_hour" },
				{ accountId: "B", windowKind: "seven_day" },
			]);
			expect(result.eventBudgetExhausted).toBeUndefined();
			expect(result.projectedExhaustions).toHaveLength(2);
			expect(result.projectedExhaustions[0]).toMatchObject({
				accountId: "A",
				windowKind: "five_hour",
			});
			expect(result.projectedExhaustions[0].exhaustsAtMs).toBeCloseTo(
				NOW + 0.25 * HOUR,
				-3,
			);
			expect(result.projectedExhaustions[1]).toMatchObject({
				accountId: "A",
				windowKind: "seven_day",
			});
			expect(result.projectedExhaustions[1].exhaustsAtMs).toBeCloseTo(
				NOW + 4 * HOUR + (137 / 796) * HOUR,
				-3,
			);
			expect(result.projectedExhaustions[1].exhaustsAtMs).toBeLessThan(
				NOW + 3.5 * DAY,
			);
		});

		it("reports nothing for a pool that is already out", () => {
			const result = computeCapacityRunwayScenario(
				[acct("A", [weekly(100)])],
				NOW,
			);
			expect(result.kind).toBe("out-now");
			expect(result.projectedExhaustions).toEqual([]);
		});

		/**
		 * A's weekly is spent and resets one hour out, so the pool is out AT `now`
		 * and A's five-hour window is the one still pending.
		 *
		 * Weekly demand: the spent window filled 100 pp over 7 d − 1 h, which is
		 * demand the survivors carry, but nothing here turns on its size. Five-hour
		 * demand: 60 pp in the 1 h since the window started = 60 %/h x 20 units =
		 * 1200 units/h. A is alone in its class, so from the weekly reset at
		 * NOW+1 h it takes all of it back at 60 %/h and fills the last 40 pp
		 * 40/60 h later, at NOW+1h+2/3h — still inside the five-hour window's FIRST
		 * cycle, which runs to its reset at NOW+4 h.
		 */
		const outNowWithPendingSibling = (): RunwayScenarioAccountInput[] => [
			acct("A", [weekly(100, 7 - 1 / 24), fiveHour(60, 1)]),
		];

		it("keeps walking a dead account's other windows when the pool is out now", () => {
			const result = computeCapacityRunwayScenario(
				outNowWithPendingSibling(),
				NOW,
			);
			expect(result.kind).toBe("out-now");
			if (result.kind !== "out-now") throw new Error("unreachable");
			expect(result.causes).toEqual([
				{ accountId: "A", windowKind: "seven_day" },
			]);
			expect(result.eventBudgetExhausted).toBeUndefined();
			// The weekly itself is a fact at 100 %, never a projection; the
			// five-hour window is the projection the caller can still act on.
			expect(result.projectedExhaustions).toHaveLength(1);
			expect(result.projectedExhaustions[0]).toMatchObject({
				accountId: "A",
				windowKind: "five_hour",
			});
			expect(result.projectedExhaustions[0].exhaustsAtMs).toBeCloseTo(
				NOW + HOUR + (40 / 60) * HOUR,
				-3,
			);
		});

		it("discloses a truncated walk on an out-now pool too", () => {
			// One event (the weekly reset at NOW+1 h) fits the budget; the five-hour
			// exhaustion is the second, so the scan stops right after recording it
			// and cannot say the list is complete.
			const result = computeCapacityRunwayScenario(
				outNowWithPendingSibling(),
				NOW,
				undefined,
				{ maxEvents: 1 },
			);
			expect(result.kind).toBe("out-now");
			expect(result.eventBudgetExhausted).toBe("projection");
		});

		it("lists an included learner's own exhaustion", () => {
			// The add case: 60%/d over three accounts, 20%/d each. A and B fill at
			// 3.5d with the newcomer at 70%, which then takes all of it and fills
			// half a day later.
			const result = computeCapacityRunwayScenario(
				[
					acct("A", [weekly(30)]),
					acct("B", [weekly(30)]),
					acct("N", [weekly(0)]),
				],
				NOW,
				undefined,
				{ shareRule: equalShareRule },
			);
			expect(result.kind).toBe("runway");
			if (result.kind !== "runway") throw new Error("unreachable");
			expect(
				result.projectedExhaustions.map((entry) => entry.accountId),
			).toEqual(["A", "B", "N"]);
			expect(result.projectedExhaustions[0].exhaustsAtMs).toBeCloseTo(
				NOW + 3.5 * DAY,
				-3,
			);
			expect(result.projectedExhaustions[2].exhaustsAtMs).toBeCloseTo(
				NOW + 4 * DAY,
				-3,
			);
		});

		it("reports nothing at all when the baseline itself ran out of budget", () => {
			const result = computeCapacityRunwayScenario(
				[acct("A", [weekly(20)])],
				NOW,
				undefined,
				{ maxEvents: 0 },
			);
			expect(result.kind).toBe("unknown");
			expect(result.eventBudgetExhausted).toBe("baseline");
			expect(result.projectedExhaustions).toEqual([]);
		});

		it("says the list may be incomplete when only the walk past the hit ran out", () => {
			// The fixture above reaches its pool-out on ONE event (the 5h exhaustion
			// at +0.25h). Everything after that is the walk for A's still-pending
			// weekly: the 5h reset at +4h is the second event, and the budget stops
			// the scan there, before the weekly fill it was walking towards.
			const accounts = [
				acct("A", [fiveHour(80, 1), weekly(99, 3.5)]),
				acct("B", [weekly(100, 3.5)]),
			];
			const result = computeCapacityRunwayScenario(accounts, NOW, undefined, {
				maxEvents: 1,
			});
			expect(result.kind).toBe("runway");
			if (result.kind !== "runway") throw new Error("unreachable");
			expect(result.exhaustsAtMs).toBeCloseTo(NOW + 0.25 * HOUR, -3);
			expect(result.eventBudgetExhausted).toBe("projection");
			expect(result.projectedExhaustions).toHaveLength(1);
			expect(result.projectedExhaustions[0]).toMatchObject({
				accountId: "A",
				windowKind: "five_hour",
			});
		});

		it("lists the later fill of a window a setup credit revived", () => {
			const bank: RunwayResetCreditBank = {
				onWeeklyLimitEnabled: true,
				onExpiryEnabled: false,
				credits: [{ expiresAtMs: null }],
			};
			// C is revived at 0% before the first assignment, so its own later fill
			// is the first one the caller can act on: 75%/d each on the equal
			// split, passed explicitly, D out at 2/3 d, C alone at 150%/d for the
			// last third of a day.
			const result = computeCapacityRunwayScenario(
				[
					acct("C", [weekly(100)], {
						tier: CODEX_PRO,
						demandClass: "codex",
						codexResetCredits: bank,
					}),
					acct("D", [weekly(50)], { tier: CODEX_PRO, demandClass: "codex" }),
				],
				NOW,
				undefined,
				{ shareRule: equalShareRule },
			);
			expect(result.kind).toBe("runway");
			if (result.kind !== "runway") throw new Error("unreachable");
			expect(result.projectedExhaustions).toHaveLength(2);
			expect(result.projectedExhaustions[0].accountId).toBe("D");
			expect(result.projectedExhaustions[0].exhaustsAtMs).toBeCloseTo(
				NOW + (2 / 3) * DAY,
				-3,
			);
			expect(result.projectedExhaustions[1].accountId).toBe("C");
			expect(result.projectedExhaustions[1].exhaustsAtMs).toBeCloseTo(
				NOW + DAY,
				-3,
			);
		});

		it("leaves the pace probes exactly where they were", () => {
			// The same fixture and the same expectations as the probe test above:
			// probes never capture, so they still stop at their first pool-out.
			const result = computeCapacityRunwayScenario(
				[acct("A", [weekly(20)])],
				NOW,
			);
			expect(result.kind).toBe("runway");
			if (result.kind !== "runway") throw new Error("unreachable");
			expect(result.paceDeficit?.multiplier).toBeCloseTo(0.66, 5);
			expect(result.eventBudgetExhausted).toBeUndefined();
			expect(result.projectedExhaustions).toHaveLength(1);
			expect(result.projectedExhaustions[0].exhaustsAtMs).toBeCloseTo(
				NOW + 4 * DAY,
				-3,
			);

			const margin = computeCapacityRunwayScenario(
				[acct("A", [weekly(14)])],
				NOW,
			);
			expect(margin.kind).toBe("beyond-horizon");
			if (margin.kind !== "beyond-horizon") throw new Error("unreachable");
			expect(margin.paceMargin?.multiplier).toBeCloseTo(1.03, 5);
			expect(margin.projectedExhaustions).toEqual([]);
		});
	});

	describe("firstExhaustionAfterNowByClass", () => {
		it("carries a death no first cycle can, in the class it happened in", () => {
			// A's five-hour window is spent AT `now` — a fact rather than a
			// projection, so the first-cycle list is empty — and it resets at +4h.
			// The cycle after that reset burns the demand the fill measured
			// (100 %/h) and dies an hour later. Nothing in the projection list can
			// say the class re-split there; this is what does.
			const result = computeCapacityRunwayScenario(
				[acct("A", [fiveHour(100, 1)])],
				NOW,
			);
			expect(result.kind).toBe("out-now");
			expect(result.projectedExhaustions).toEqual([]);
			expect(result.firstExhaustionAfterNowByClass).toHaveLength(1);
			expect(result.firstExhaustionAfterNowByClass[0].demandClass).toBe(
				"anthropic",
			);
			expect(result.firstExhaustionAfterNowByClass[0].atMs).toBeCloseTo(
				NOW + 5 * HOUR,
				-3,
			);
		});

		it("is the earliest of them, first cycle or not", () => {
			// The roster two blocks up: B dies in its first cycle at 20/41.25 h and
			// A only in its second. The earliest is B's, and it is the same instant
			// the projection list carries for it.
			const result = computeCapacityRunwayScenario(
				[acct("A", [fiveHour(10, 4)]), acct("B", [fiveHour(80, 1)])],
				NOW,
				undefined,
				{ shareRule: equalShareRule },
			);
			expect(result.firstExhaustionAfterNowByClass).toHaveLength(1);
			expect(result.firstExhaustionAfterNowByClass[0].atMs).toBeCloseTo(
				result.projectedExhaustions[0].exhaustsAtMs,
				-3,
			);
			expect(result.firstExhaustionAfterNowByClass[0].atMs).toBeCloseTo(
				NOW + (20 / 41.25) * HOUR,
				-3,
			);
		});

		it("says nothing when the baseline itself ran out of budget", () => {
			const result = computeCapacityRunwayScenario(
				[acct("A", [weekly(20)])],
				NOW,
				undefined,
				{ maxEvents: 0 },
			);
			expect(result.eventBudgetExhausted).toBe("baseline");
			expect(result.firstExhaustionAfterNowByClass).toEqual([]);
		});
	});

	describe("contract violations", () => {
		const roster = (): RunwayScenarioAccountInput[] => [
			acct("A", [weekly(20)]),
			acct("B", [weekly(40)]),
		];
		const run = (shareRule: ShareRule): void => {
			computeCapacityRunwayScenario(roster(), NOW, undefined, { shareRule });
		};

		it("rejects a weight list of the wrong length", () => {
			expect(() =>
				run((candidates) => candidates.map(() => 1).slice(1)),
			).toThrow(/weights for/);
		});

		it("rejects a negative weight", () => {
			expect(() =>
				run((candidates) =>
					candidates.map((candidate) => (candidate.accountId === "A" ? -1 : 1)),
				),
			).toThrow(/finite number/);
		});

		it("rejects a NaN weight", () => {
			expect(() =>
				run((candidates) => candidates.map(() => Number.NaN)),
			).toThrow(/finite number/);
		});

		it("rejects dropping demand on the floor", () => {
			expect(() => run((candidates) => candidates.map(() => 0))).toThrow(
				/all-zero weights/,
			);
		});

		it("rejects a capacity that is not a positive finite number", () => {
			expect(() =>
				computeCapacityRunwayScenario(roster(), NOW, undefined, {
					capacityUnits: () => 0,
				}),
			).toThrow(/capacityUnits/);
			expect(() =>
				computeCapacityRunwayScenario(roster(), NOW, undefined, {
					capacityUnits: () => -1,
				}),
			).toThrow(/capacityUnits/);
		});
	});
});

// ---------------------------------------------------------------------------
// The proportional share rule
// ---------------------------------------------------------------------------

/** Every share rule call of one scan, in order. */
interface RuleCall {
	windowKind: string;
	accountIds: string[];
	/** `w_j/Σw`, so a test can read the split rather than the raw weights. */
	shares: number[];
}

/**
 * `proportionalShareRule` with every call recorded. The rule itself answers, so
 * what the test reads is what the scan used.
 */
function recordingProportional(calls: RuleCall[]): ShareRule {
	return (candidates, windowKind) => {
		const weights = proportionalShareRule(candidates, windowKind);
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		calls.push({
			windowKind,
			accountIds: candidates.map((candidate) => candidate.accountId),
			shares: weights.map((weight) => (total > 0 ? weight / total : 0)),
		});
		return weights;
	};
}

const runProportional = (
	accounts: RunwayScenarioAccountInput[],
	calls?: RuleCall[],
): RunwayScenarioOutcome =>
	computeCapacityRunwayScenario(accounts, NOW, undefined, {
		shareRule:
			calls === undefined
				? proportionalShareRule
				: recordingProportional(calls),
		probePaceMargin: false,
	});

/** The window's OWN measured burn, in percentage points per hour. */
function ownSlope(window: RunwayWindowInput): number {
	const slope = estimateWindowExhaustion(window, NOW).slopePctPerHour;
	if (slope == null) throw new Error("expected a measured slope");
	return slope;
}

const exhaustOf = (
	result: RunwayScenarioOutcome,
	accountId: string,
): number | undefined =>
	result.projectedExhaustions.find((entry) => entry.accountId === accountId)
		?.exhaustsAtMs;

const exhaustOfWindow = (
	result: RunwayScenarioOutcome,
	accountId: string,
	windowKind: string,
): number | undefined =>
	result.projectedExhaustions.find(
		(entry) => entry.accountId === accountId && entry.windowKind === windowKind,
	)?.exhaustsAtMs;

/** How far behind `now` every {@link tied} reading was observed. */
const TIED_LAG_MS = 0.5 * HOUR;
/** How long after ITS OWN observation a {@link tied} window projects to fill. */
const TIED_RUN_MS = 1.6 * HOUR;

/**
 * A window read at `pct`, observed {@link TIED_LAG_MS} ago, whose own measured
 * burn fills it exactly {@link TIED_RUN_MS} after that reading.
 *
 * The elapsed time is solved from the two: a lifetime-primary estimate burns
 * `pct` in `elapsed`, so it needs `elapsed · (100 − pct) / pct` more, and
 * fixing that at `TIED_RUN_MS` fixes the window's start. Every window built
 * this way therefore projects to the SAME instant however it is read, whatever
 * its percentage, cycle length or account's capacity.
 */
function tied(
	windowKind: string,
	pct: number,
	cycleMs: number,
): RunwayWindowInput {
	const observedAtMs = NOW - TIED_LAG_MS;
	const windowStartMs = observedAtMs - (TIED_RUN_MS * pct) / (100 - pct);
	return {
		windowKind,
		utilizationPct: pct,
		windowStartMs,
		resetsAtMs: windowStartMs + cycleMs,
		prediction: null,
		lifetimeConfidence: "full",
		observedAtMs,
	};
}

/** Where the CURRENT model puts this one window, with nothing else in the pool. */
function aloneExhaust(accountId: string, window: RunwayWindowInput): number {
	const alone = computeCapacityRunway(
		[{ accountId, unmetered: false, windows: [window] }],
		NOW,
	);
	if (alone.kind !== "runway") {
		throw new Error(`expected a runway for ${accountId}/${window.windowKind}`);
	}
	return alone.exhaustsAtMs;
}

describe("proportionalShareRule", () => {
	it("reproduces the current model exactly while every account is alive", () => {
		// A is 0.833 %/h with 40 points left, B is 1.042 %/h with 50: different
		// slopes, the same 48 h. Neither death precedes the other, so BOTH
		// windows are projected on the scan's first assignment, which is the
		// instant the identity is about.
		const aWindow = weekly(60, 3);
		const bWindow = weekly(50, 2);
		const accounts = [acct("A", [aWindow]), acct("B", [bWindow])];
		const calls: RuleCall[] = [];
		const result = runProportional(accounts, calls);

		// The assigned slope IS the measured one: demand times share over units.
		const demand = result.demandUnitsPerHour[0].unitsPerHour;
		expect(calls[0].windowKind).toBe("seven_day");
		expect(calls[0].accountIds).toEqual(["A", "B"]);
		expect((demand * calls[0].shares[0]) / 20).toBeCloseTo(
			ownSlope(aWindow),
			10,
		);
		expect((demand * calls[0].shares[1]) / 20).toBeCloseTo(
			ownSlope(bWindow),
			10,
		);

		// And so the projection is the current model's, window by window.
		for (const account of accounts) {
			const alone = computeCapacityRunway(baselineInputs([account]), NOW);
			expect(alone.kind).toBe("runway");
			if (alone.kind !== "runway") throw new Error("unreachable");
			expect(alone.exhaustsAtMs).toBeCloseTo(NOW + 48 * HOUR, -3);
			expect(exhaustOf(result, account.accountId)).toBeCloseTo(
				alone.exhaustsAtMs,
				-3,
			);
		}
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + 48 * HOUR, -3);

		// Not a property of any share rule: the equal split moves A's projection
		// more than five hours earlier over the same reading.
		const equal = computeCapacityRunwayScenario(accounts, NOW, undefined, {
			shareRule: equalShareRule,
			probePaceMargin: false,
		});
		expect(exhaustOf(equal, "A")).toBeCloseTo(NOW + (40 / 0.9375) * HOUR, -3);
	});

	it("is the rule a call with no shareRule option runs on", () => {
		// The scan's default, and the identity that makes it one: on a two-account
		// roster with nothing dead yet, the default projects each window exactly
		// where the current model does. The equal split does not.
		const accounts = [acct("A", [weekly(60, 3)]), acct("B", [weekly(50, 2)])];
		const byDefault = computeCapacityRunwayScenario(accounts, NOW);
		expect(byDefault).toEqual(
			computeCapacityRunwayScenario(accounts, NOW, undefined, {
				shareRule: proportionalShareRule,
			}),
		);
		for (const account of accounts) {
			const alone = computeCapacityRunway(baselineInputs([account]), NOW);
			expect(alone.kind).toBe("runway");
			if (alone.kind !== "runway") throw new Error("unreachable");
			expect(exhaustOf(byDefault, account.accountId)).toBeCloseTo(
				alone.exhaustsAtMs,
				-3,
			);
		}
		expect(byDefault).not.toEqual(
			computeCapacityRunwayScenario(accounts, NOW, undefined, {
				shareRule: equalShareRule,
			}),
		);
	});

	it("splits each kind by that kind's own demand, never a blend of both", () => {
		// A carries 70 % of the class's five-hour burn and 40 % of its weekly.
		const accounts = [
			acct("A", [fiveHour(70, 1), weekly(40, 1)]),
			acct("B", [fiveHour(30, 1), weekly(60, 1)]),
		];
		const calls: RuleCall[] = [];
		runProportional(accounts, calls);

		const first = (windowKind: string): RuleCall => {
			const call = calls.find((entry) => entry.windowKind === windowKind);
			if (call === undefined) throw new Error(`no call for ${windowKind}`);
			return call;
		};
		expect(first("five_hour").accountIds).toEqual(["A", "B"]);
		expect(first("five_hour").shares[0]).toBeCloseTo(0.7, 10);
		expect(first("five_hour").shares[1]).toBeCloseTo(0.3, 10);
		expect(first("seven_day").shares[0]).toBeCloseTo(0.4, 10);
		expect(first("seven_day").shares[1]).toBeCloseTo(0.6, 10);
	});

	it("applies each kind's share to that kind's own windows, in the scan", () => {
		// What the call-level test above cannot see: which window the scan gave
		// each weight to. Every window here is read half an hour behind `now` and
		// projects to fill exactly TIED_RUN_MS after that reading, so all four
		// die at ONE instant — nothing re-splits the class before any of them,
		// and the rule's identity with the current model therefore has to hold
		// for every window at once. A window that took its ACCOUNT's other
		// kind's share instead would burn at a slope its own reading never
		// measured, and land somewhere else.
		const aFive = tied("five_hour", 65, 5 * HOUR);
		const aWeek = tied("seven_day", 90, 7 * DAY);
		const bFive = tied("five_hour", 40, 5 * HOUR);
		const bWeek = tied("seven_day", 40, 7 * DAY);
		// Unequal capacity: 20 units against 5, so a share is not a slope ratio.
		const accounts = [
			acct("A", [aFive, aWeek]),
			acct("B", [bFive, bWeek], { tier: MAX5 }),
		];
		const calls: RuleCall[] = [];
		const result = runProportional(accounts, calls);
		expect(result.tiers.map((tier) => tier.capacityUnits)).toEqual([20, 5]);

		// A carries 70 % of the five-hour demand and 40 % of the weekly.
		expect(calls[0].windowKind).toBe("five_hour");
		expect(calls[0].shares[0]).toBeCloseTo(0.7, 9);
		expect(calls[1].windowKind).toBe("seven_day");
		expect(calls[1].shares[0]).toBeCloseTo(0.4, 9);

		// The identity, window by window: each one lands where the current model
		// puts it from its own reading, observation lag included.
		for (const [accountId, window] of [
			["A", aFive],
			["A", aWeek],
			["B", bFive],
			["B", bWeek],
		] as const) {
			const projected = exhaustOfWindow(result, accountId, window.windowKind);
			// Absent is a failure of its own: a window given another kind's share
			// misses its cycle instead of landing late.
			expect(projected).toBeDefined();
			expect(projected as number).toBeCloseTo(
				aloneExhaust(accountId, window),
				-3,
			);
		}
		expect(exhaustOfWindow(result, "A", "seven_day")).toBeCloseTo(
			NOW + TIED_RUN_MS - TIED_LAG_MS,
			-3,
		);

		// And the shares are not interchangeable: answering each kind with the
		// OTHER kind's weights moves A's weekly — 0.7 of the weekly demand rather
		// than 0.4 — hours earlier, and with it the whole pool-out.
		const swapped = computeCapacityRunwayScenario(accounts, NOW, undefined, {
			shareRule: (candidates, windowKind) =>
				proportionalShareRule(
					candidates,
					windowKind === "five_hour" ? "seven_day" : "five_hour",
				),
			probePaceMargin: false,
		});
		expect(exhaustOfWindow(swapped, "A", "seven_day") as number).toBeLessThan(
			exhaustOfWindow(result, "A", "seven_day") as number,
		);
		expect(result.kind).toBe("runway");
		expect(swapped.kind).toBe("runway");
		if (result.kind !== "runway" || swapped.kind !== "runway") {
			throw new Error("unreachable");
		}
		expect(swapped.exhaustsAtMs).toBeLessThan(result.exhaustsAtMs);
	});

	it("moves a dead account's demand in proportion to the survivors' own burn", () => {
		// 80/20/10 %/h on one class. A dies at +0.25 h, and its 80 %/h goes 2:1
		// to B and C: B burns 20 + 80·(2/3) = 73.33 %/h from 25 %, C burns
		// 10 + 80·(1/3) = 36.67 %/h from 12.5 %.
		const accounts = [
			acct("A", [fiveHour(80, 1)]),
			acct("B", [fiveHour(20, 1)]),
			acct("C", [fiveHour(10, 1)]),
		];
		const calls: RuleCall[] = [];
		const result = runProportional(accounts, calls);

		const aDies = NOW + 0.25 * HOUR;
		const bDies = aDies + (75 / (110 * (2 / 3))) * HOUR;
		expect(exhaustOf(result, "A")).toBeCloseTo(aDies, -3);
		expect(exhaustOf(result, "B")).toBeCloseTo(bDies, -3);
		// C is at 50 % when B dies and then carries all 110 %/h.
		expect(exhaustOf(result, "C")).toBeCloseTo(bDies + (50 / 110) * HOUR, -3);

		// The re-split itself: the first assignment without A.
		const afterDeath = calls.find(
			(call) => !call.accountIds.includes("A"),
		) as RuleCall;
		expect(afterDeath.accountIds).toEqual(["B", "C"]);
		expect(afterDeath.shares[0]).toBeCloseTo(2 / 3, 10);
		expect(afterDeath.shares[1]).toBeCloseTo(1 / 3, 10);
	});

	it("falls back to the equal split for a kind no live account measured", () => {
		// Both learners have no slope of their own, so nothing can be weighted by
		// burn — but R's removed burn is still demand that has to be placed.
		const calls: RuleCall[] = [];
		const result = runProportional(
			[
				acct("N1", [weekly(0)]),
				acct("N2", [weekly(0)]),
				acct("R", [weekly(40)], { presence: "demand-only" }),
			],
			calls,
		);

		expect(calls[0].windowKind).toBe("seven_day");
		expect(calls[0].accountIds).toEqual(["N1", "N2"]);
		expect(calls[0].shares).toEqual([0.5, 0.5]);
		// 40 %/d of demand, halved: 20 %/d each from 0 %, so five days.
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + 5 * DAY, -3);
		expect(result.includedLearningAccounts).toEqual([
			{ accountId: "N1", shareOfClassByKind: { seven_day: 0.5 } },
			{ accountId: "N2", shareOfClassByKind: { seven_day: 0.5 } },
		]);
	});

	it("is asked once per measured kind, and told which kind it is answering for", () => {
		const calls: RuleCall[] = [];
		runProportional([acct("A", [fiveHour(50, 1), weekly(20)])], calls);

		// One assignment, one call per kind, in the order the kinds were measured.
		expect(calls.slice(0, 2).map((call) => call.windowKind)).toEqual([
			"five_hour",
			"seven_day",
		]);
		expect(
			calls.every((call) =>
				["five_hour", "seven_day"].includes(call.windowKind),
			),
		).toBe(true);
		// No assignment asks twice about one kind.
		for (let index = 0; index + 1 < calls.length; index += 2) {
			expect(calls[index].windowKind).not.toBe(calls[index + 1].windowKind);
		}
	});

	it("weights a candidate by its own measured units, and zero without them", () => {
		const seen: ShareCandidate[][] = [];
		const rule: ShareRule = (candidates, windowKind) => {
			seen.push(candidates.map((candidate) => candidate));
			return proportionalShareRule(candidates, windowKind);
		};
		computeCapacityRunwayScenario(
			[acct("A", [weekly(24)]), acct("N", [weekly(0)])],
			NOW,
			undefined,
			{ shareRule: rule, probePaceMargin: false },
		);

		// 24 %/d is 1 %/h, so A's window carries its tier's units per hour.
		expect(seen[0][0].windows[0].measuredUnitsPerHour).toBeCloseTo(20, 10);
		// A learning window measured nothing, and `null` is not `0`.
		expect(seen[0][1].windows[0].measuredUnitsPerHour).toBeNull();
	});
});

describe("equalShareRule", () => {
	it("ignores the window kind it is asked about", () => {
		const candidates: ShareCandidate[] = [
			{
				accountId: "A",
				demandClass: "anthropic",
				capacityUnits: 20,
				windows: [
					{
						windowKind: "five_hour",
						utilizationPct: 10,
						measuredUnitsPerHour: 200,
					},
					{
						windowKind: "seven_day",
						utilizationPct: 10,
						measuredUnitsPerHour: 1,
					},
				],
			},
			{
				accountId: "B",
				demandClass: "anthropic",
				capacityUnits: 20,
				windows: [
					{
						windowKind: "five_hour",
						utilizationPct: 90,
						measuredUnitsPerHour: 1,
					},
				],
			},
		];
		expect(equalShareRule(candidates, "five_hour")).toEqual([1, 1]);
		expect(equalShareRule(candidates, "seven_day")).toEqual(
			equalShareRule(candidates, "five_hour"),
		);
		// The proportional rule is the one that reads the kind.
		expect(proportionalShareRule(candidates, "five_hour")).toEqual([200, 1]);
		expect(proportionalShareRule(candidates, "seven_day")).toEqual([1, 0]);
	});
});

// ---------------------------------------------------------------------------
// Observation lag
// ---------------------------------------------------------------------------

const MIN = 60 * 1000;

/**
 * A five-hour window whose server regression is anchored `lagMinutes` before
 * `NOW` — the fit's own last point, which is what the regression path's ETA is
 * measured from and what the correction has to consume.
 */
function regressionWindow(options: {
	pct: number;
	slopePctPerHour: number;
	lagMinutes: number;
	startedHoursAgo?: number;
	/** Overrides the window's own `start + 5 h`, for the tie fixtures. */
	resetsAtMs?: number;
	observedAtMs?: number;
}): RunwayWindowInput {
	const startedHoursAgo = options.startedHoursAgo ?? 3;
	const startMs = NOW - startedHoursAgo * HOUR;
	const resetsAtMs = options.resetsAtMs ?? startMs + 5 * HOUR;
	const anchorMs = NOW - options.lagMinutes * MIN;
	const etaExhaustMs =
		options.slopePctPerHour > 0
			? anchorMs + ((100 - options.pct) / options.slopePctPerHour) * HOUR
			: null;
	return {
		windowKind: "five_hour",
		utilizationPct: options.pct,
		windowStartMs: startMs,
		resetsAtMs,
		prediction: {
			state: "rising",
			slopePerHour: options.slopePctPerHour,
			etaExhaustMs,
			predictedAtReset: null,
			resetsAtMs,
			willExhaustBeforeReset:
				etaExhaustMs !== null && etaExhaustMs < resetsAtMs,
			lowConfidence: false,
		},
		lifetimeConfidence: "full",
		observedAtMs: options.observedAtMs ?? NOW,
	};
}

/** A weekly window read at `pct`, observed `lagMinutes` before `NOW`. */
function weeklyObserved(options: {
	pct: number;
	startedMs: number;
	lagMinutes: number;
}): RunwayWindowInput {
	return {
		windowKind: "seven_day",
		utilizationPct: options.pct,
		windowStartMs: options.startedMs,
		resetsAtMs: options.startedMs + 7 * DAY,
		prediction: null,
		lifetimeConfidence: "full",
		observedAtMs: NOW - options.lagMinutes * MIN,
	};
}

/*
 * The lag block holds the share rule FIXED at the equal split, the way the
 * redistribution backtest's `scenario-equal`/`scenario-equal-original` pair
 * does: the only thing that may differ between two runs here is the lag
 * treatment, so the split each case's arithmetic is written for cannot move
 * under it. The scan's own default is the proportional rule, covered above.
 */
const ignored = (
	accounts: RunwayScenarioAccountInput[],
): RunwayScenarioOutcome =>
	computeCapacityRunwayScenario(accounts, NOW, undefined, {
		shareRule: equalShareRule,
		observationLag: "ignore",
	});

const corrected = (
	accounts: RunwayScenarioAccountInput[],
): RunwayScenarioOutcome =>
	computeCapacityRunwayScenario(accounts, NOW, undefined, {
		shareRule: equalShareRule,
	});

const runwayEtaOf = (outcome: RunwayScenarioOutcome): number => {
	if (outcome.kind !== "runway") {
		throw new Error(`expected a runway, got ${outcome.kind}`);
	}
	return outcome.exhaustsAtMs;
};

const currentEtaOf = (accounts: RunwayScenarioAccountInput[]): number => {
	const outcome = computeCapacityRunway(baselineInputs(accounts), NOW);
	if (outcome.kind !== "runway") {
		throw new Error(`expected a runway, got ${outcome.kind}`);
	}
	return outcome.exhaustsAtMs;
};

describe("observation lag", () => {
	it("advances a regression reading to now, reaching the current model's ETA", () => {
		// The fit's last point sits 10 min back; the scenario used to schedule the
		// remaining 50 % from `now`, which is 10 min of burn nobody projected.
		const accounts = [
			acct("A", [
				regressionWindow({ pct: 50, slopePctPerHour: 50, lagMinutes: 10 }),
			]),
		];

		const advanced = runwayEtaOf(corrected(accounts));
		const raw = runwayEtaOf(ignored(accounts));
		expect(raw).toBeCloseTo(NOW + HOUR, -3);
		expect(advanced).toBeCloseTo(raw - 10 * MIN, -3);
		// A lone account's scenario slope IS its own slope, so the corrected scan
		// must land exactly where the current model does.
		expect(advanced).toBeCloseTo(currentEtaOf(accounts), -3);
	});

	it("advances an observation-anchored weekly reading by its observation age", () => {
		const accounts = [
			acct("A", [
				weeklyObserved({ pct: 40, startedMs: NOW - 2 * DAY, lagMinutes: 10 }),
			]),
		];

		const advanced = runwayEtaOf(corrected(accounts));
		expect(advanced).toBeCloseTo(runwayEtaOf(ignored(accounts)) - 10 * MIN, -3);
		expect(advanced).toBeCloseTo(currentEtaOf(accounts), -3);
	});

	it("leaves a now-anchored lifetime-average reading where it is", () => {
		// The low lifetime path measures its burn to `now`, so there is no lag to
		// consume and the corrected scan must not invent one.
		const accounts = [
			acct("A", [
				{
					windowKind: "five_hour",
					utilizationPct: 70,
					windowStartMs: NOW - 3 * HOUR,
					resetsAtMs: NOW + 2 * HOUR,
					prediction: null,
					observedAtMs: NOW - 10 * MIN,
				},
			]),
		];

		const advanced = runwayEtaOf(corrected(accounts));
		expect(advanced).toBeCloseTo(runwayEtaOf(ignored(accounts)), -3);
		expect(advanced).toBeCloseTo(currentEtaOf(accounts), -3);
	});

	describe("observationLagMs", () => {
		const lagOf = (window: RunwayWindowInput): number =>
			observationLagMs(estimateWindowExhaustion(window, NOW), window, NOW);

		it("has nothing to advance when the regression states no ETA", () => {
			expect(
				lagOf(
					regressionWindow({ pct: 50, slopePctPerHour: 0, lagMinutes: 10 }),
				),
			).toBe(0);
		});

		it("clamps a fit or an observation that is ahead of now", () => {
			expect(
				lagOf(
					regressionWindow({ pct: 50, slopePctPerHour: 50, lagMinutes: -5 }),
				),
			).toBe(0);
			expect(
				lagOf(
					weeklyObserved({
						pct: 40,
						startedMs: NOW - 2 * DAY,
						lagMinutes: -5,
					}),
				),
			).toBe(0);
		});

		it("reports no lag for the sources that measure no burn", () => {
			// already-exhausted: a fact, not a projection.
			expect(
				lagOf({
					windowKind: "seven_day",
					utilizationPct: 100,
					windowStartMs: NOW - DAY,
					resetsAtMs: NOW + 6 * DAY,
					prediction: null,
					lifetimeConfidence: "full",
					observedAtMs: NOW - 10 * MIN,
				}),
			).toBe(0);
			// unstarted: the provider's reset is a sliding placeholder.
			expect(
				lagOf({
					windowKind: "five_hour",
					utilizationPct: 0,
					windowStartMs: NOW - 10 * MIN,
					resetsAtMs: NOW + 5 * HOUR,
					prediction: null,
					lifetimeConfidence: "full",
					observedAtMs: NOW - 10 * MIN,
				}),
			).toBe(0);
			// none: no usable evidence at all.
			expect(
				lagOf({
					windowKind: "seven_day",
					utilizationPct: 40,
					windowStartMs: null,
					resetsAtMs: null,
					prediction: null,
					lifetimeConfidence: "full",
					observedAtMs: NOW - 10 * MIN,
				}),
			).toBe(0);
		});
	});

	it("changes nothing when the reading cannot be placed before now", () => {
		const cases: RunwayWindowInput[] = [
			// No observation instant: the estimate degrades to the now-anchored path.
			{
				windowKind: "seven_day",
				utilizationPct: 40,
				windowStartMs: NOW - 2 * DAY,
				resetsAtMs: NOW + 5 * DAY,
				prediction: null,
				lifetimeConfidence: "full",
				observedAtMs: null,
			},
			weeklyObserved({ pct: 40, startedMs: NOW - 2 * DAY, lagMinutes: 0 }),
			weeklyObserved({ pct: 40, startedMs: NOW - 2 * DAY, lagMinutes: -5 }),
		];
		for (const window of cases) {
			const accounts = [acct("A", [window])];
			expect(corrected(accounts)).toEqual(ignored(accounts));
		}
	});

	it("kills a window that fills inside its lag at now, keeping its true instant", () => {
		// A is 0.3 pp short and takes half the class demand; B has no measured
		// burn of its own, so the whole demand is A's and B's share is what A
		// leaves behind.
		const aStart = NOW - DAY;
		const accounts = [
			acct("A", [
				weeklyObserved({ pct: 99.7, startedMs: aStart, lagMinutes: 10 }),
			]),
			acct("B", [
				weeklyObserved({ pct: 5, startedMs: NOW - 30 * MIN, lagMinutes: 0 }),
			]),
		];

		const slopeA = 99.7 / ((DAY - 10 * MIN) / HOUR);
		const shareOfA = slopeA / 2;
		const result = corrected(accounts);
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		// B survives A and inherits the whole class demand from `now`.
		expect(result.exhaustsAtMs).toBeCloseTo(
			NOW + ((100 - 5) / slopeA) * HOUR,
			-3,
		);
		const aExhaust = result.projectedExhaustions.find(
			(entry) => entry.accountId === "A",
		);
		expect(aExhaust?.exhaustsAtMs).toBeCloseTo(
			NOW - 10 * MIN + ((100 - 99.7) / shareOfA) * HOUR,
			-3,
		);
		expect(aExhaust?.exhaustsAtMs as number).toBeLessThan(NOW);
		// The share reported for a learning account is its FINAL assignment at
		// `now`: the split that stood before the lag death was provisional.
		expect(result.includedLearningAccounts).toEqual([
			{ accountId: "B", shareOfClassByKind: { seven_day: 1 } },
		]);
		// Without the correction A is still alive at `now` and the pool lasts
		// longer.
		expect(runwayEtaOf(ignored(accounts))).toBeGreaterThan(result.exhaustsAtMs);
	});

	it("reports out-now when the only account fills inside its lag", () => {
		const accounts = [
			acct("A", [
				weeklyObserved({ pct: 99.9, startedMs: NOW - DAY, lagMinutes: 10 }),
			]),
		];
		const slope = 99.9 / ((DAY - 10 * MIN) / HOUR);

		const result = corrected(accounts);
		expect(result.kind).toBe("out-now");
		if (result.kind !== "out-now") throw new Error("unreachable");
		expect(result.causes).toEqual([
			{ accountId: "A", windowKind: "seven_day" },
		]);
		expect(result.projectedExhaustions).toHaveLength(1);
		expect(result.projectedExhaustions[0].exhaustsAtMs).toBeCloseTo(
			NOW - 10 * MIN + ((100 - 99.9) / slope) * HOUR,
			-3,
		);
		expect(ignored(accounts).kind).toBe("runway");
	});

	it("leaves an already-exhausted reading alone whatever its observation age", () => {
		const accounts = [
			acct("A", [
				{
					windowKind: "seven_day",
					utilizationPct: 100,
					windowStartMs: NOW - DAY,
					resetsAtMs: NOW + 6 * DAY,
					prediction: null,
					lifetimeConfidence: "full",
					observedAtMs: NOW - 10 * MIN,
				},
			]),
			acct("B", [
				weeklyObserved({ pct: 30, startedMs: NOW - DAY, lagMinutes: 0 }),
			]),
		];
		expect(corrected(accounts)).toEqual(ignored(accounts));
	});

	it("advances a learning window by its ASSIGNED share, not a slope of its own", () => {
		// A has 20 minutes of evidence, so it borrows the class slope; the lag is
		// still real and its share still burned through it.
		const accounts = [
			acct("A", [
				weeklyObserved({ pct: 20, startedMs: NOW - 30 * MIN, lagMinutes: 10 }),
			]),
			acct("B", [
				weeklyObserved({ pct: 90, startedMs: NOW - 12 * HOUR, lagMinutes: 0 }),
			]),
		];

		const demand = 90 / 12;
		const advance = (demand / 2) * (10 / 60);
		const raw = runwayEtaOf(ignored(accounts));
		// B dies first either way; A carries the whole demand from there, so the
		// advance shows up divided by the FINAL slope.
		expect(runwayEtaOf(corrected(accounts))).toBeCloseTo(
			raw - (advance / demand) * HOUR,
			-3,
		);
		expect(corrected(accounts).includedLearningAccounts).toEqual([
			{ accountId: "A", shareOfClassByKind: { seven_day: 0.5 } },
		]);
	});

	describe("a weekly lag death and reset credits", () => {
		const weeklyBank = (
			credits: Array<{ expiresAtMs: number | null }>,
		): RunwayResetCreditBank => ({
			onWeeklyLimitEnabled: true,
			onExpiryEnabled: false,
			credits,
		});
		const filling = (lagMinutes: number, pct = 99.9): RunwayWindowInput =>
			weeklyObserved({ pct, startedMs: NOW - DAY, lagMinutes });
		const slope = 99.9 / ((DAY - 10 * MIN) / HOUR);

		it("redeems a credit at now and keeps the first exhaustion", () => {
			const accounts = [
				acct("A", [filling(10)], {
					codexResetCredits: weeklyBank([{ expiresAtMs: null }]),
				}),
			];
			const result = corrected(accounts);
			expect(result.kind).toBe("runway");
			if (result.kind !== "runway") throw new Error("unreachable");
			expect(result.assumedResetCredits).toEqual([
				{ accountId: "A", count: 1 },
			]);
			// Revived at `now` and burning the whole demand from 0 %.
			expect(result.exhaustsAtMs).toBeCloseTo(NOW + (100 / slope) * HOUR, -3);
			expect(result.projectedExhaustions).toHaveLength(1);
			expect(result.projectedExhaustions[0].exhaustsAtMs).toBeLessThan(NOW);
		});

		it("is out-now with an empty bank", () => {
			expect(
				corrected([
					acct("A", [filling(10)], { codexResetCredits: weeklyBank([]) }),
				]).kind,
			).toBe("out-now");
		});

		it("treats a credit expiring AT now exactly as the plain exhaust path does", () => {
			const viaLag = corrected([
				acct("A", [filling(10)], {
					codexResetCredits: weeklyBank([{ expiresAtMs: NOW }]),
				}),
			]);
			// The same window one second of burn short of full, with no lag: its
			// exhaustion is an ordinary event just after `now`.
			const viaEvent = corrected([
				acct("A", [filling(0)], {
					codexResetCredits: weeklyBank([{ expiresAtMs: NOW }]),
				}),
			]);
			expect(viaLag.kind).toBe("out-now");
			expect(viaEvent.kind).toBe("runway");
			// Neither path spends a credit that has already expired.
			expect("assumedResetCredits" in viaLag).toBe(false);
			expect("assumedResetCredits" in viaEvent).toBe(false);
		});
	});

	it("applies the reset tie policy to a lag death", () => {
		// The scan batches events within one millisecond of each other, and a
		// projected exhaustion tied with the window's own reset is not a dead
		// span. A lag death at `now` is held to the same policy.
		const tiedReset = corrected([
			acct("A", [
				regressionWindow({
					pct: 99,
					slopePctPerHour: 12,
					lagMinutes: 10,
					startedHoursAgo: 5,
					resetsAtMs: NOW + 0.5,
				}),
			]),
		]);
		expect(tiedReset.kind).toBe("beyond-horizon");
		expect(tiedReset.projectedExhaustions).toEqual([]);

		const separateReset = corrected([
			acct("A", [
				regressionWindow({
					pct: 99,
					slopePctPerHour: 12,
					lagMinutes: 10,
					startedHoursAgo: 5,
					resetsAtMs: NOW + 2,
				}),
			]),
		]);
		expect(separateReset.kind).toBe("out-now");
		expect(separateReset.projectedExhaustions[0]?.exhaustsAtMs).toBeCloseTo(
			NOW - 10 * MIN + (1 / 12) * HOUR,
			-3,
		);
	});

	it("never re-burns the past at a probe's pace", () => {
		// The lag interval already happened, at pace 1. A probe that re-burned it
		// at its own pace would report a different margin from the identical
		// reading advanced by hand.
		const lagged = computeCapacityRunwayScenario(
			[
				acct("A", [
					regressionWindow({
						pct: 50,
						slopePctPerHour: 12,
						lagMinutes: 10,
						startedHoursAgo: 2,
					}),
				]),
			],
			NOW,
		);
		const preAdvanced = computeCapacityRunwayScenario(
			[
				acct("A", [
					regressionWindow({
						pct: 52,
						slopePctPerHour: 12,
						lagMinutes: 0,
						startedHoursAgo: 2,
					}),
				]),
			],
			NOW,
		);
		expect(lagged.kind).toBe("beyond-horizon");
		expect(preAdvanced.kind).toBe("beyond-horizon");
		if (lagged.kind !== "beyond-horizon") throw new Error("unreachable");
		if (preAdvanced.kind !== "beyond-horizon") throw new Error("unreachable");
		expect(lagged.paceMargin).not.toBeNull();
		expect(lagged.paceMargin).toEqual(preAdvanced.paceMargin);
	});
});
