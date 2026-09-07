import { describe, expect, it } from "bun:test";
import type {
	RunwayScenarioOutcome,
	RunwayWindowForecast,
} from "@clankermux/types";
import {
	FAILOVER_MIN_EARLIER_MS,
	FAILOVER_WINDOW_KIND,
	type FailoverForecastInput,
	failoverForecast,
} from "./failover-forecast";

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const RESET = NOW + 3 * HOUR;

function scenario(
	over: Partial<RunwayScenarioOutcome> = {},
): RunwayScenarioOutcome {
	return {
		kind: "runway",
		exhaustsAtMs: NOW + 2 * HOUR,
		durationMs: 2 * HOUR,
		causes: [],
		unprojectableAccountIds: [],
		basis: "demand-conserving",
		demandUnitsPerHour: [],
		tiers: [],
		includedLearningAccounts: [],
		unknownTierAccountIds: [],
		demandOnlyAccountIds: [],
		projectedExhaustions: [
			{ accountId: "peer", windowKind: "five_hour", exhaustsAtMs: NOW + HOUR },
			{
				accountId: "me",
				windowKind: "five_hour",
				exhaustsAtMs: NOW + 2 * HOUR,
			},
		],
		firstExhaustionAfterNowByClass: [
			{ demandClass: "anthropic", atMs: NOW + HOUR },
		],
		...over,
	} as RunwayScenarioOutcome;
}

const projected = (exhaustsAtMs: number | null): RunwayWindowForecast => ({
	state: "projected",
	exhaustsAtMs,
	lowConfidence: false,
});

function input(
	over: Partial<FailoverForecastInput> = {},
): FailoverForecastInput {
	return {
		scenario: scenario(),
		accountId: "me",
		windowKind: "five_hour",
		utilizationPct: 40,
		resetsAtMs: RESET,
		// Standalone says this window lasts until after the reset.
		standalone: projected(NOW + 4 * HOUR),
		now: NOW,
		...over,
	};
}

describe("failoverForecast", () => {
	it("emits the scenario run-out when it precedes both the standalone one and the reset", () => {
		expect(failoverForecast(input())).toEqual({ exhaustsAtMs: NOW + 2 * HOUR });
	});

	it("emits when the standalone forecast projects no run-out at all", () => {
		expect(failoverForecast(input({ standalone: projected(null) }))).toEqual({
			exhaustsAtMs: NOW + 2 * HOUR,
		});
	});

	it("emits when the standalone run-out is later by more than the display tolerance", () => {
		expect(
			failoverForecast(
				input({
					standalone: projected(NOW + 2 * HOUR + FAILOVER_MIN_EARLIER_MS + 1),
				}),
			),
		).toEqual({ exhaustsAtMs: NOW + 2 * HOUR });
	});

	it("is silent when the scenario agrees with the standalone forecast to within the tolerance", () => {
		expect(
			failoverForecast(input({ standalone: projected(NOW + 2 * HOUR) })),
		).toBeNull();
		expect(
			failoverForecast(
				input({
					standalone: projected(NOW + 2 * HOUR + FAILOVER_MIN_EARLIER_MS),
				}),
			),
		).toBeNull();
		// A float hair earlier than the standalone is agreement, not a warning.
		expect(
			failoverForecast(input({ standalone: projected(NOW + 2 * HOUR + 1) })),
		).toBeNull();
	});

	it("is silent when the scenario run-out is LATER than the standalone one", () => {
		// A recipient stalled behind its own weekly window projects later, and a
		// later instant is not a failover warning.
		expect(
			failoverForecast(input({ standalone: projected(NOW + HOUR) })),
		).toBeNull();
	});

	it("is silent when the scenario run-out is at or after the reset", () => {
		expect(
			failoverForecast(
				input({
					resetsAtMs: NOW + 2 * HOUR,
					standalone: projected(NOW + 4 * HOUR),
				}),
			),
		).toBeNull();
		expect(failoverForecast(input({ resetsAtMs: null }))).toBeNull();
	});

	it("is silent for every window kind but the five-hour one", () => {
		expect(FAILOVER_WINDOW_KIND).toBe("five_hour");
		expect(
			failoverForecast(
				input({
					windowKind: "seven_day",
					scenario: scenario({
						projectedExhaustions: [
							{
								accountId: "me",
								windowKind: "seven_day",
								exhaustsAtMs: NOW + HOUR,
							},
						],
					}),
				}),
			),
		).toBeNull();
	});

	it("is silent unless the standalone forecast is a projection", () => {
		expect(failoverForecast(input({ standalone: null }))).toBeNull();
		expect(
			failoverForecast(
				input({
					standalone: {
						state: "learning",
						reason: "short-history",
						readyAtMs: null,
					},
				}),
			),
		).toBeNull();
	});

	it("is silent for a window already at 100 % or with no reading", () => {
		expect(failoverForecast(input({ utilizationPct: 100 }))).toBeNull();
		expect(failoverForecast(input({ utilizationPct: null }))).toBeNull();
	});

	it("is silent when the scenario could not project this account", () => {
		expect(failoverForecast(input({ scenario: null }))).toBeNull();
		expect(
			failoverForecast(input({ scenario: scenario({ kind: "unknown" }) })),
		).toBeNull();
		expect(
			failoverForecast(
				input({ scenario: { kind: "no-accounts" } as RunwayScenarioOutcome }),
			),
		).toBeNull();
		expect(
			failoverForecast(
				input({ scenario: scenario({ unprojectableAccountIds: ["me"] }) }),
			),
		).toBeNull();
		expect(
			failoverForecast(
				input({
					scenario: scenario({
						unprojectableAccountIds: ["me"],
						learningAccountIds: ["me"],
					}),
				}),
			),
		).toBeNull();
		expect(
			failoverForecast(
				input({ scenario: scenario({ projectedExhaustions: [] }) }),
			),
		).toBeNull();
	});

	it("is silent when the scenario ran out of its baseline event budget", () => {
		expect(
			failoverForecast(
				input({
					scenario: scenario({
						kind: "unknown",
						eventBudgetExhausted: "baseline",
					}),
				}),
			),
		).toBeNull();
	});

	it("still reads a present entry when only the projection continuation ran out of budget", () => {
		expect(
			failoverForecast(
				input({ scenario: scenario({ eventBudgetExhausted: "projection" }) }),
			),
		).toEqual({ exhaustsAtMs: NOW + 2 * HOUR });
	});

	it("is silent when the scenario's outcome depends on assumed reset-credit redemptions", () => {
		expect(
			failoverForecast(
				input({
					scenario: scenario({
						assumedResetCredits: [{ accountId: "peer", count: 1 }],
					}),
				}),
			),
		).toBeNull();
		expect(
			failoverForecast(
				input({ scenario: scenario({ assumedResetCredits: [] }) }),
			),
		).toEqual({ exhaustsAtMs: NOW + 2 * HOUR });
	});

	it("reports a run-out the scan reached at or before now as it stands", () => {
		// A recipient filled inside its own observation lag: the scenario's entry
		// carries the true sub-now instant, and the surface renders it as reached.
		expect(
			failoverForecast(
				input({
					scenario: scenario({
						projectedExhaustions: [
							{
								accountId: "me",
								windowKind: "five_hour",
								exhaustsAtMs: NOW - 60_000,
							},
						],
					}),
					standalone: projected(NOW + HOUR),
				}),
			),
		).toEqual({ exhaustsAtMs: NOW - 60_000 });
	});
});
