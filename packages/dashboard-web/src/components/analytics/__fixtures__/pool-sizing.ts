/**
 * Hand-built pool-sizing payloads for the panel test.
 *
 * Deliberately NOT named *.test.ts so bun's runner doesn't pick it up.
 *
 * One payload carries every state the panel renders differently at once — a
 * proven-infeasible class row, a family row nested under it, a class row the
 * tiers make incomparable, a lower-bound cycle, an in-progress cycle, and a
 * separated stop — because the assertions are about the panel telling them
 * apart on ONE screen, which a payload per state could not check.
 */
import type {
	PoolSizingAccountCycle,
	PoolSizingCycle,
	PoolSizingResponse,
	PoolSizingRow,
	PoolSizingVerdictBasis,
} from "@clankermux/types";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

export const POOL_SIZING_NOW = Date.UTC(2026, 8, 5, 12);

/** Thursday 20:00 UTC — the anchor the live Claude reset phases produce. */
const CURRENT_CYCLE_START = Date.UTC(2026, 8, 3, 20);
const LATEST_COMPLETED_START = CURRENT_CYCLE_START - WEEK;
const PREVIOUS_COMPLETED_START = CURRENT_CYCLE_START - 2 * WEEK;

function accountCycle(
	accountId: string,
	name: string,
	peakPct: number,
	effectiveEnd: number,
	tierLabel: string | null = "Max 20x",
): PoolSizingAccountCycle {
	return {
		accountId,
		accountName: name,
		peakPct,
		windows: 1,
		resetAt: effectiveEnd,
		effectiveEnd,
		abandoned: false,
		sampleCount: 400,
		observedThroughEnd: true,
		tierLabel,
	};
}

function cycle(
	start: number,
	overrides: Partial<PoolSizingCycle> = {},
): PoolSizingCycle {
	const accounts = overrides.accounts ?? [];
	const ends = accounts.map((account) => account.effectiveEnd);
	return {
		start,
		end: start + WEEK,
		resetFrom: ends.length > 0 ? Math.min(...ends) : null,
		resetTo: ends.length > 0 ? Math.max(...ends) : null,
		status: start + WEEK <= POOL_SIZING_NOW ? "completed" : "in_progress",
		accountsInPool: 5,
		accountsObserved: 5,
		consumed: accounts.reduce((sum, a) => sum + a.peakPct / 100, 0),
		lowerBound: false,
		removalInfeasible: false,
		verdictBasis: "at_or_below_threshold" as PoolSizingVerdictBasis,
		reserveBandEntered: false,
		terminalStops: 0,
		rejectedAttempts: 0,
		burstPeakAccounts: 0,
		tierLabel: "Max 20x",
		...overrides,
		accounts,
	};
}

const CLAUDE_ACCOUNTS = [
	["claude-1", "Claude 1", 96],
	["claude-5", "Claude 5", 96],
	["claude-3", "Claude 3", 96],
	["claude-2", "Claude 2", 96],
	["claude-4", "Claude 4", 95],
] as const;

function claudeRow(): PoolSizingRow {
	const latest = cycle(LATEST_COMPLETED_START, {
		accounts: CLAUDE_ACCOUNTS.map(([id, name, peak], index) =>
			accountCycle(id, name, peak, Date.UTC(2026, 7, 30, 7) + index * DAY),
		),
		consumed: 4.79,
		removalInfeasible: true,
		verdictBasis: "above_threshold",
		reserveBandEntered: true,
		terminalStops: 2,
		rejectedAttempts: 11,
		burstPeakAccounts: 3,
	});
	const previous = cycle(PREVIOUS_COMPLETED_START, {
		accounts: CLAUDE_ACCOUNTS.map(([id, name], index) =>
			accountCycle(id, name, 90, Date.UTC(2026, 7, 23, 7) + index * DAY),
		),
		consumed: 4.5,
		// Not every account was sampled through this cycle, so the figure is a
		// floor and the panel has to say so.
		accountsObserved: 4,
		lowerBound: true,
		removalInfeasible: true,
		verdictBasis: "above_threshold",
		reserveBandEntered: true,
		burstPeakAccounts: 5,
	});
	const current = cycle(CURRENT_CYCLE_START, {
		accounts: CLAUDE_ACCOUNTS.map(([id, name], index) =>
			accountCycle(id, name, 30, Date.UTC(2026, 8, 6, 7) + index * DAY),
		),
		consumed: 1.5,
		status: "in_progress",
		verdictBasis: "in_progress",
		burstPeakAccounts: null,
	});

	return {
		kind: "class",
		classId: "anthropic",
		classLabel: "Claude",
		family: null,
		familyLabel: null,
		boundaryRule: "reset_phase_gap",
		accountsVoting: 5,
		accountsLocked: 5,
		tierComparable: true,
		verdict: "removal_infeasible",
		verdictBasis: "above_threshold",
		verdictCycles: 2,
		reserveBandCycles: 2,
		terminalStopCycles: 1,
		cycles: [current, latest, previous],
	};
}

function fableRow(): PoolSizingRow {
	const latest = cycle(LATEST_COMPLETED_START, {
		accounts: CLAUDE_ACCOUNTS.map(([id, name], index) =>
			accountCycle(id, name, 93, Date.UTC(2026, 7, 30, 7) + index * DAY),
		),
		consumed: 4.66,
		removalInfeasible: true,
		verdictBasis: "above_threshold",
		burstPeakAccounts: null,
	});
	return {
		kind: "family",
		classId: "anthropic",
		classLabel: "Claude",
		family: "fable",
		familyLabel: "Fable",
		boundaryRule: "reset_phase_gap",
		accountsVoting: 5,
		accountsLocked: 5,
		tierComparable: true,
		verdict: "removal_infeasible",
		verdictBasis: "above_threshold",
		verdictCycles: 1,
		reserveBandCycles: 0,
		terminalStopCycles: 0,
		cycles: [latest],
	};
}

function gptRow(): PoolSizingRow {
	const latest = cycle(LATEST_COMPLETED_START, {
		accountsInPool: 2,
		accountsObserved: 2,
		accounts: [
			accountCycle("codex-1", "Codex 1", 80, Date.UTC(2026, 7, 31), "Pro"),
			accountCycle("codex-2", "Codex 2", 70, Date.UTC(2026, 8, 1), "Plus"),
		],
		consumed: 1.5,
		verdictBasis: "tiers_not_comparable",
		tierLabel: "mixed",
		rejectedAttempts: 4,
		burstPeakAccounts: 1,
	});
	return {
		kind: "class",
		classId: "codex",
		classLabel: "GPT",
		family: null,
		familyLabel: null,
		boundaryRule: "iso_week",
		accountsVoting: 2,
		accountsLocked: 0,
		tierComparable: false,
		verdict: "removal_not_established",
		verdictBasis: "tiers_not_comparable",
		verdictCycles: 1,
		reserveBandCycles: 0,
		terminalStopCycles: 0,
		cycles: [latest],
	};
}

/** Every state the panel renders differently, in one payload. */
export function poolSizingFixture(): PoolSizingResponse {
	return {
		generatedAt: POOL_SIZING_NOW,
		sinceMs: POOL_SIZING_NOW - 15 * WEEK,
		windowMs: WEEK,
		reserveHeadroomPct: 20,
		verdictCycles: 4,
		maxCycles: 12,
		rows: [claudeRow(), fableRow(), gptRow()],
		separateStops: [
			{
				label: "all_accounts_failed",
				model: "claude-3-opus-retired",
				count: 300,
				firstAt: POOL_SIZING_NOW - 40 * DAY,
				lastAt: POOL_SIZING_NOW - 5 * DAY,
			},
		],
	};
}

/** A pool with no recorded samples at all. */
export function emptyPoolSizingFixture(): PoolSizingResponse {
	return {
		generatedAt: POOL_SIZING_NOW,
		sinceMs: POOL_SIZING_NOW - 15 * WEEK,
		windowMs: WEEK,
		reserveHeadroomPct: 20,
		verdictCycles: 4,
		maxCycles: 12,
		rows: [],
		separateStops: [],
	};
}
