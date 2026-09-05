/**
 * Fixtures for the account-weeks computation.
 *
 * Every case here is a shape the LIVE snapshot history actually contains: the
 * one-second reset jitter, the Codex idle creep, an abandoned window, an
 * account whose reset moved. `NOW` is pinned so the reset-phase anchor and the
 * completed/in-progress split are deterministic — the anchor is derived from
 * the data, so a floating clock would silently move every cycle boundary.
 */
import { describe, expect, it } from "bun:test";
import type { PoolSizingCycle } from "@clankermux/types";
import type {
	PoolSizingAccountInput,
	PoolSizingComputeInput,
	PoolSizingResetPeakRow,
	PoolSizingRow,
	PoolSizingScopedResetPeakRow,
} from "../pool-sizing";
import {
	computePoolSizing,
	POOL_SIZING_LOOKBACK_MS,
	POOL_SIZING_MAX_CYCLES,
	stopClassForModel,
} from "../pool-sizing";
import { formatPlanTierLabel } from "../tier-label";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Saturday 2026-09-05 12:00 UTC. */
const NOW = Date.UTC(2026, 8, 5, 12);

/** Cycle boundary the five live Claude reset phases produce: Thursday 20:00 UTC. */
const CLAUDE_CYCLE_1_START = Date.UTC(2026, 7, 20, 20);
const CLAUDE_CYCLE_1_END = Date.UTC(2026, 7, 27, 20);

function account(
	id: string,
	name: string,
	provider = "anthropic",
	createdAt = NOW - 30 * WEEK,
): PoolSizingAccountInput {
	return { id, name, provider, createdAt };
}

interface WeeklyOptions {
	planTier?: string | null;
	rateLimitTier?: string | null;
	/** First sample of the FIRST window; defaults to six days before its reset. */
	firstStart?: number;
}

/**
 * Consecutive weekly windows for one account, one per entry of `ends`.
 *
 * Sample spans are laid out so consecutive windows never overlap and their
 * resets sit a full week apart — the shape an Anthropic account produces, and
 * the one the revision merge must NOT collapse.
 */
function weekly(
	accountId: string,
	ends: readonly number[],
	peaks: readonly number[],
	options: WeeklyOptions = {},
): PoolSizingResetPeakRow[] {
	return ends.map((resetAt, index) => {
		const previous = ends[index - 1];
		const firstSampledAt =
			index === 0
				? (options.firstStart ?? resetAt - 6 * DAY)
				: (previous as number) + MINUTE;
		return {
			accountId,
			resetAt,
			peakPct: peaks[index] ?? 0,
			sampleCount: 200,
			firstSampledAt,
			lastSampledAt: Math.min(resetAt - 5 * MINUTE, NOW),
			firstPct: 0,
			lastPct: peaks[index] ?? 0,
			planTier: options.planTier ?? null,
			rateLimitTier: options.rateLimitTier ?? null,
		};
	});
}

function run(overrides: Partial<PoolSizingComputeInput> = {}) {
	return computePoolSizing({
		accounts: [],
		resetPeaks: [],
		scopedResetPeaks: [],
		presence: [],
		scopedPresence: [],
		burstTicks: [],
		stops: [],
		reserveHeadroomPct: 20,
		now: NOW,
		...overrides,
	});
}

function classRow(
	response: ReturnType<typeof run>,
	classId: string,
): PoolSizingRow {
	const row = response.rows.find(
		(candidate) => candidate.kind === "class" && candidate.classId === classId,
	);
	if (!row) throw new Error(`no ${classId} class row`);
	return row;
}

function familyRow(
	response: ReturnType<typeof run>,
	family: string,
): PoolSizingRow {
	const row = response.rows.find(
		(candidate) => candidate.kind === "family" && candidate.family === family,
	);
	if (!row) throw new Error(`no ${family} family row`);
	return row;
}

function cycleAt(row: PoolSizingRow, ms: number): PoolSizingCycle {
	const cycle = row.cycles.find(
		(candidate) => ms >= candidate.start && ms < candidate.end,
	);
	if (!cycle)
		throw new Error(`no cycle covering ${new Date(ms).toISOString()}`);
	return cycle;
}

function entryFor(cycle: PoolSizingCycle, accountId: string) {
	return cycle.accounts.find((entry) => entry.accountId === accountId);
}

// ---------------------------------------------------------------------------
// The live Claude pool: five accounts, five fixed reset phases.
// ---------------------------------------------------------------------------

const CLAUDE_ENDS: Record<string, number[]> = {
	// Sunday 07:00 UTC
	"claude-1": [
		Date.UTC(2026, 7, 16, 7),
		Date.UTC(2026, 7, 23, 7),
		Date.UTC(2026, 7, 30, 7),
		Date.UTC(2026, 8, 6, 7),
	],
	// Sunday 20:00 UTC
	"claude-5": [
		Date.UTC(2026, 7, 16, 20),
		Date.UTC(2026, 7, 23, 20),
		Date.UTC(2026, 7, 30, 20),
		Date.UTC(2026, 8, 6, 20),
	],
	// Monday 06:00 UTC
	"claude-3": [
		Date.UTC(2026, 7, 17, 6),
		Date.UTC(2026, 7, 24, 6),
		Date.UTC(2026, 7, 31, 6),
		Date.UTC(2026, 8, 7, 6),
	],
	// Tuesday 03:00 UTC
	"claude-2": [
		Date.UTC(2026, 7, 18, 3),
		Date.UTC(2026, 7, 25, 3),
		Date.UTC(2026, 8, 1, 3),
		Date.UTC(2026, 8, 8, 3),
	],
	// Tuesday 09:00 UTC
	"claude-4": [
		Date.UTC(2026, 7, 18, 9),
		Date.UTC(2026, 7, 25, 9),
		Date.UTC(2026, 8, 1, 9),
		Date.UTC(2026, 8, 8, 9),
	],
};

/** Peaks per account, oldest cycle first. Cycle 1 sums to 4.82, cycle 2 to 4.79. */
const CLAUDE_PEAKS: Record<string, number[]> = {
	"claude-1": [70, 96, 96, 30],
	"claude-5": [71, 98, 96, 30],
	"claude-3": [72, 96, 96, 30],
	"claude-2": [73, 98, 96, 30],
	"claude-4": [74, 94, 95, 30],
};

const CLAUDE_ACCOUNTS = Object.keys(CLAUDE_ENDS).map((id) =>
	account(id, id.toUpperCase()),
);

function claudePeaks(
	mutate?: (id: string, ends: number[]) => number[],
): PoolSizingResetPeakRow[] {
	return Object.entries(CLAUDE_ENDS).flatMap(([id, ends]) => {
		const effective = mutate ? mutate(id, ends) : ends;
		return weekly(id, effective, CLAUDE_PEAKS[id] as number[], {
			planTier: "max",
			rateLimitTier: "20x",
			// Inside cycle 0, so the fixture emits exactly the four cycles it
			// describes instead of a fifth, empty one behind them.
			firstStart: Date.UTC(2026, 7, 13, 21),
		});
	});
}

// ---------------------------------------------------------------------------

describe("reset clustering", () => {
	it("collapses one-second reset jitter into a single window", () => {
		const reset = Date.UTC(2026, 7, 23, 7);
		const base = {
			accountId: "claude-1",
			sampleCount: 5,
			firstSampledAt: reset - 6 * DAY,
			lastSampledAt: reset - 5 * MINUTE,
			firstPct: 0,
			lastPct: 96,
			planTier: null,
			rateLimitTier: null,
		};
		const response = run({
			accounts: [account("claude-1", "Claude 1")],
			resetPeaks: [
				{ ...base, resetAt: reset - 1_000, peakPct: 40 },
				{ ...base, resetAt: reset, peakPct: 96, sampleCount: 400 },
				{ ...base, resetAt: reset + 1_000, peakPct: 41 },
			],
		});

		const cycle = cycleAt(classRow(response, "anthropic"), reset);
		const entry = entryFor(cycle, "claude-1");
		expect(entry?.windows).toBe(1);
		expect(entry?.peakPct).toBe(96);
		// The value the provider reported most often is the one that survives.
		expect(entry?.resetAt).toBe(reset);
	});
});

describe("revision merge", () => {
	it("treats a two-minute reset revision with rising usage as one window", () => {
		const reset = Date.UTC(2026, 7, 23, 7);
		const response = run({
			accounts: [account("claude-1", "Claude 1")],
			resetPeaks: [
				{
					accountId: "claude-1",
					resetAt: reset,
					peakPct: 60,
					sampleCount: 100,
					firstSampledAt: reset - 5 * DAY,
					lastSampledAt: reset - 2 * HOUR,
					firstPct: 0,
					lastPct: 60,
					planTier: null,
					rateLimitTier: null,
				},
				{
					accountId: "claude-1",
					resetAt: reset + 2 * MINUTE,
					peakPct: 61,
					sampleCount: 40,
					firstSampledAt: reset - 2 * HOUR + MINUTE,
					lastSampledAt: reset - 5 * MINUTE,
					firstPct: 61,
					lastPct: 61,
					planTier: null,
					rateLimitTier: null,
				},
			],
		});

		const cycle = cycleAt(classRow(response, "anthropic"), reset);
		const entry = entryFor(cycle, "claude-1");
		expect(entry?.windows).toBe(1);
		expect(entry?.peakPct).toBe(61);
	});

	it("starts a new window when usage drops and the reset moves by more than a day", () => {
		const first = Date.UTC(2026, 7, 20, 12);
		const second = first + Math.round(1.6 * DAY);
		const response = run({
			accounts: [account("codex-1", "Codex 1", "codex")],
			resetPeaks: [
				{
					accountId: "codex-1",
					resetAt: first,
					peakPct: 100,
					sampleCount: 100,
					firstSampledAt: first - 5 * DAY,
					lastSampledAt: first - 10 * MINUTE,
					firstPct: 20,
					lastPct: 100,
					planTier: null,
					rateLimitTier: null,
				},
				{
					accountId: "codex-1",
					resetAt: second,
					peakPct: 0,
					sampleCount: 100,
					firstSampledAt: first + 10 * MINUTE,
					lastSampledAt: second - 10 * MINUTE,
					firstPct: 0,
					lastPct: 0,
					planTier: null,
					rateLimitTier: null,
				},
			],
		});

		const row = classRow(response, "codex");
		const windows = row.cycles.flatMap((cycle) =>
			cycle.accounts.map((entry) => entry.windows),
		);
		expect(windows.reduce((sum, count) => sum + count, 0)).toBe(2);
	});

	it("merges clusters whose sample spans overlap even with different resets", () => {
		const reset = Date.UTC(2026, 7, 23, 7);
		const response = run({
			accounts: [account("claude-1", "Claude 1")],
			resetPeaks: [
				{
					accountId: "claude-1",
					resetAt: reset,
					peakPct: 30,
					sampleCount: 100,
					firstSampledAt: reset - 5 * DAY,
					lastSampledAt: reset - 5 * MINUTE,
					firstPct: 0,
					lastPct: 30,
					planTier: null,
					rateLimitTier: null,
				},
				{
					accountId: "claude-1",
					// A whole hour later, and reported from inside the other span.
					resetAt: reset + HOUR,
					peakPct: 44,
					sampleCount: 20,
					firstSampledAt: reset - 3 * DAY,
					lastSampledAt: reset - 2 * DAY,
					firstPct: 10,
					lastPct: 44,
					planTier: null,
					rateLimitTier: null,
				},
			],
		});

		const cycle = cycleAt(classRow(response, "anthropic"), reset);
		const entry = entryFor(cycle, "claude-1");
		expect(entry?.windows).toBe(1);
		expect(entry?.peakPct).toBe(44);
	});
});

describe("placeholders", () => {
	/** The Codex idle creep: `now + 7d` at 0%, one or two samples per value. */
	function creep(
		accountId: string,
		from: number,
		ticks: number,
		step = 10 * MINUTE,
	): PoolSizingResetPeakRow[] {
		return Array.from({ length: ticks }, (_unused, index) => {
			const sampledAt = from + index * step;
			return {
				accountId,
				resetAt: sampledAt + WEEK,
				peakPct: 0,
				sampleCount: 2,
				firstSampledAt: sampledAt,
				lastSampledAt: sampledAt,
				firstPct: 0,
				lastPct: 0,
				planTier: null,
				rateLimitTier: null,
			};
		});
	}

	it("absorbs a creeping idle stretch into the window that follows it", () => {
		const from = Date.UTC(2026, 7, 10, 0);
		const ticks = creep("codex-1", from, 12);
		const frozenReset = from + 11 * 10 * MINUTE + WEEK + 10 * MINUTE;
		const response = run({
			accounts: [account("codex-1", "Codex 1", "codex")],
			resetPeaks: [
				...ticks,
				{
					accountId: "codex-1",
					resetAt: frozenReset,
					peakPct: 40,
					sampleCount: 300,
					firstSampledAt: from + 12 * 10 * MINUTE,
					lastSampledAt: frozenReset - 5 * MINUTE,
					firstPct: 0,
					lastPct: 40,
					planTier: null,
					rateLimitTier: null,
				},
			],
		});

		const cycle = cycleAt(classRow(response, "codex"), frozenReset);
		const entry = entryFor(cycle, "codex-1");
		expect(entry?.windows).toBe(1);
		expect(entry?.peakPct).toBe(40);
	});

	it("drops a pure idle stretch as a window but still counts it as observation", () => {
		const from = Date.UTC(2026, 7, 10, 0);
		const response = run({
			accounts: [account("codex-1", "Codex 1", "codex")],
			resetPeaks: creep("codex-1", from, 20),
		});

		const row = classRow(response, "codex");
		const cycle = cycleAt(row, from + HOUR);
		expect(cycle.accounts).toHaveLength(0);
		expect(cycle.consumed).toBe(0);
		expect(cycle.accountsInPool).toBe(1);
		expect(cycle.accountsObserved).toBe(1);
		expect(cycle.lowerBound).toBe(false);
	});

	it("keeps a briefly-observed window with real consumption and marks it a lower bound", () => {
		const reset = Date.UTC(2026, 7, 23, 7);
		const response = run({
			accounts: [account("claude-1", "Claude 1")],
			resetPeaks: [
				{
					accountId: "claude-1",
					resetAt: reset,
					peakPct: 20,
					sampleCount: 6,
					firstSampledAt: reset - WEEK,
					lastSampledAt: reset - WEEK + HOUR,
					firstPct: 0,
					lastPct: 20,
					planTier: null,
					rateLimitTier: null,
				},
			],
		});

		const cycle = cycleAt(classRow(response, "anthropic"), reset);
		expect(entryFor(cycle, "claude-1")?.peakPct).toBe(20);
		expect(entryFor(cycle, "claude-1")?.observedThroughEnd).toBe(false);
		expect(cycle.lowerBound).toBe(true);
	});

	it("keeps a week observed at 0% as a window contributing nothing", () => {
		const reset = Date.UTC(2026, 7, 23, 7);
		const response = run({
			accounts: [account("claude-1", "Claude 1")],
			resetPeaks: weekly("claude-1", [reset], [0]),
		});

		const cycle = cycleAt(classRow(response, "anthropic"), reset);
		expect(entryFor(cycle, "claude-1")?.windows).toBe(1);
		expect(entryFor(cycle, "claude-1")?.peakPct).toBe(0);
		expect(cycle.consumed).toBe(0);
	});
});

describe("effective end", () => {
	it("places an abandoned window in the week it actually ended", () => {
		const abandonedReset = Date.UTC(2026, 7, 26, 12);
		const restartedAt = Date.UTC(2026, 7, 18, 0);
		const response = run({
			accounts: [account("codex-1", "Codex 1", "codex")],
			resetPeaks: [
				{
					accountId: "codex-1",
					resetAt: abandonedReset,
					peakPct: 55,
					sampleCount: 300,
					firstSampledAt: Date.UTC(2026, 7, 15, 0),
					lastSampledAt: restartedAt - 10 * MINUTE,
					firstPct: 0,
					lastPct: 55,
					planTier: null,
					rateLimitTier: null,
				},
				{
					accountId: "codex-1",
					resetAt: Date.UTC(2026, 7, 24, 12),
					peakPct: 20,
					sampleCount: 300,
					firstSampledAt: restartedAt,
					lastSampledAt: Date.UTC(2026, 7, 24, 12) - 5 * MINUTE,
					firstPct: 0,
					lastPct: 20,
					planTier: null,
					rateLimitTier: null,
				},
			],
		});

		const row = classRow(response, "codex");
		expect(row.boundaryRule).toBe("iso_week");
		const cycle = cycleAt(row, restartedAt);
		// ISO week containing Tue 2026-08-18: Mon 2026-08-17 00:00 UTC.
		expect(cycle.start).toBe(Date.UTC(2026, 7, 17));
		const entry = entryFor(cycle, "codex-1");
		expect(entry?.peakPct).toBe(55);
		expect(entry?.abandoned).toBe(true);
		expect(entry?.observedThroughEnd).toBe(true);
		expect(cycle.lowerBound).toBe(false);
	});

	it("sums two windows that ended in one ISO week", () => {
		const firstEnd = Date.UTC(2026, 7, 18, 6);
		const secondEnd = Date.UTC(2026, 7, 20, 6);
		const response = run({
			accounts: [account("codex-1", "Codex 1", "codex")],
			resetPeaks: [
				{
					accountId: "codex-1",
					resetAt: firstEnd,
					peakPct: 40,
					sampleCount: 200,
					firstSampledAt: Date.UTC(2026, 7, 17, 2),
					lastSampledAt: firstEnd - 5 * MINUTE,
					firstPct: 0,
					lastPct: 40,
					planTier: null,
					rateLimitTier: null,
				},
				{
					accountId: "codex-1",
					resetAt: secondEnd,
					peakPct: 30,
					sampleCount: 200,
					firstSampledAt: firstEnd + HOUR,
					lastSampledAt: secondEnd - 5 * MINUTE,
					firstPct: 0,
					lastPct: 30,
					planTier: null,
					rateLimitTier: null,
				},
			],
		});

		const cycle = cycleAt(classRow(response, "codex"), firstEnd);
		const entry = entryFor(cycle, "codex-1");
		expect(entry?.windows).toBe(2);
		expect(entry?.peakPct).toBe(70);
		expect(cycle.consumed).toBeCloseTo(0.7, 6);
	});
});

describe("cycle boundaries", () => {
	it("anchors the Anthropic grid at the widest gap between reset phases", () => {
		const response = run({
			accounts: CLAUDE_ACCOUNTS,
			resetPeaks: claudePeaks(),
		});
		const row = classRow(response, "anthropic");

		expect(row.boundaryRule).toBe("reset_phase_gap");
		expect(row.accountsVoting).toBe(5);
		expect(row.accountsLocked).toBe(5);

		const cycle = cycleAt(row, Date.UTC(2026, 7, 23, 7));
		// Thursday 20:00 UTC: the midpoint of the empty stretch behind Tue 09:00.
		expect(cycle.start).toBe(CLAUDE_CYCLE_1_START);
		expect(cycle.end).toBe(CLAUDE_CYCLE_1_END);
		expect(cycle.accountsInPool).toBe(5);
		expect(cycle.accounts).toHaveLength(5);
		expect(cycle.consumed).toBeCloseTo(4.82, 6);
		expect(cycle.status).toBe("completed");
		expect(cycle.lowerBound).toBe(false);

		const next = cycleAt(row, Date.UTC(2026, 7, 30, 7));
		expect(next.consumed).toBeCloseTo(4.79, 6);
	});

	it("keeps the phase rule when one account re-anchors, and places it by its own end", () => {
		const movedEnd = Date.UTC(2026, 8, 9, 15);
		const response = run({
			accounts: CLAUDE_ACCOUNTS,
			resetPeaks: claudePeaks((id, ends) =>
				id === "claude-4" ? [...ends.slice(0, 3), movedEnd] : ends,
			),
		});
		const row = classRow(response, "anthropic");

		expect(row.boundaryRule).toBe("reset_phase_gap");
		expect(row.accountsLocked).toBe(4);
		expect(row.accountsVoting).toBe(5);
		// The other four accounts still land together, on a grid the moved
		// account's own window end did not shift them off.
		expect(cycleAt(row, Date.UTC(2026, 7, 23, 7)).consumed).toBeCloseTo(
			4.82,
			6,
		);
		expect(entryFor(cycleAt(row, movedEnd), "claude-4")).toBeDefined();
	});

	it("uses ISO weeks for a non-Anthropic class", () => {
		const response = run({
			accounts: [account("codex-1", "Codex 1", "codex")],
			resetPeaks: weekly("codex-1", [Date.UTC(2026, 7, 20, 6)], [50]),
		});
		const row = classRow(response, "codex");
		expect(row.boundaryRule).toBe("iso_week");
		expect(cycleAt(row, Date.UTC(2026, 7, 20, 6)).start).toBe(
			Date.UTC(2026, 7, 17),
		);
	});
});

describe("pool size", () => {
	it("counts an account only from the cycle its creation falls in", () => {
		const ends = [
			Date.UTC(2026, 7, 16, 7),
			Date.UTC(2026, 7, 23, 7),
			Date.UTC(2026, 7, 30, 7),
		];
		const response = run({
			accounts: [
				account("claude-1", "Claude 1"),
				account("claude-2", "Claude 2", "anthropic", Date.UTC(2026, 7, 26)),
			],
			resetPeaks: [
				...weekly("claude-1", ends, [50, 50, 50], {
					firstStart: ends[0] - 2 * DAY,
				}),
				...weekly("claude-2", [ends[2] as number], [40]),
			],
		});
		const row = classRow(response, "anthropic");

		expect(cycleAt(row, ends[0] as number).accountsInPool).toBe(1);
		expect(cycleAt(row, ends[2] as number).accountsInPool).toBe(2);
	});

	it("counts a never-sampled account in n and flags the cycle a lower bound", () => {
		const reset = Date.UTC(2026, 7, 23, 7);
		const response = run({
			accounts: [account("claude-1", "Claude 1"), account("claude-2", "Idle")],
			resetPeaks: weekly("claude-1", [reset], [50]),
		});

		const cycle = cycleAt(classRow(response, "anthropic"), reset);
		expect(cycle.accountsInPool).toBe(2);
		expect(cycle.accountsObserved).toBe(1);
		expect(cycle.lowerBound).toBe(true);
	});
});

describe("status", () => {
	it("marks a cycle in progress until its span has fully elapsed", () => {
		const response = run({
			accounts: CLAUDE_ACCOUNTS,
			resetPeaks: claudePeaks(),
		});
		const row = classRow(response, "anthropic");

		const current = cycleAt(row, NOW);
		expect(current.status).toBe("in_progress");
		expect(current.start).toBeLessThanOrEqual(NOW);
		expect(current.end).toBeGreaterThan(NOW);
		expect(current.verdictBasis).toBe("in_progress");
		expect(current.removalInfeasible).toBe(false);
		expect(current.reserveBandEntered).toBe(false);
		// Three completed cycles precede it; only they can be considered.
		expect(row.verdictCycles).toBe(3);
	});

	it("reports insufficient history when no cycle has completed", () => {
		const reset = NOW + 2 * DAY;
		const response = run({
			accounts: [account("codex-1", "Codex 1", "codex")],
			resetPeaks: [
				{
					accountId: "codex-1",
					resetAt: reset,
					peakPct: 12,
					sampleCount: 50,
					firstSampledAt: NOW - 2 * DAY,
					lastSampledAt: NOW,
					firstPct: 0,
					lastPct: 12,
					planTier: null,
					rateLimitTier: null,
				},
			],
		});
		const row = classRow(response, "codex");
		expect(row.cycles.every((cycle) => cycle.status === "in_progress")).toBe(
			true,
		);
		expect(row.verdict).toBe("insufficient_history");
		expect(row.verdictBasis).toBeNull();
		expect(row.verdictCycles).toBe(0);
	});
});

describe("scoped family series", () => {
	function scoped(
		accountId: string,
		displayName: string,
		resetAt: number,
		peakPct: number,
		lastSampledAt = resetAt - 5 * MINUTE,
	): PoolSizingScopedResetPeakRow {
		return {
			accountId,
			family: "fable",
			displayName,
			resetAt,
			peakPct,
			sampleCount: 100,
			firstSampledAt: resetAt - 6 * DAY,
			lastSampledAt,
			firstPct: 0,
			lastPct: peakPct,
		};
	}

	it("takes the binding display-name series, never the sum", () => {
		const reset = Date.UTC(2026, 7, 23, 7);
		const response = run({
			accounts: [account("claude-1", "Claude 1")],
			resetPeaks: weekly("claude-1", [reset], [90], {
				planTier: "max",
				rateLimitTier: "20x",
			}),
			scopedResetPeaks: [
				scoped("claude-1", "Mythos", reset + HOUR, 40, reset - 10 * MINUTE),
				scoped("claude-1", "Fable", reset, 70),
			],
		});

		const row = familyRow(response, "fable");
		expect(row.kind).toBe("family");
		expect(row.familyLabel).toBe("Fable");
		const cycle = cycleAt(row, reset);
		const entry = entryFor(cycle, "claude-1");
		expect(entry?.peakPct).toBe(70);
		expect(entry?.windows).toBe(1);
		expect(cycle.burstPeakAccounts).toBeNull();
		// Tier travels from the account-wide samples: the scoped table has none.
		expect(entry?.tierLabel).toBe("Max 20x");
	});

	it("orders family rows directly after their class row", () => {
		const reset = Date.UTC(2026, 7, 23, 7);
		const response = run({
			accounts: [
				account("claude-1", "Claude 1"),
				account("codex-1", "Codex 1", "codex"),
			],
			resetPeaks: [
				...weekly("claude-1", [reset], [90]),
				...weekly("codex-1", [reset], [50]),
			],
			scopedResetPeaks: [scoped("claude-1", "Fable", reset, 70)],
		});

		expect(
			response.rows.map(
				(row) => `${row.classId}:${row.kind}:${row.family ?? "-"}`,
			),
		).toEqual(["anthropic:class:-", "anthropic:family:fable", "codex:class:-"]);
	});
});

describe("verdict", () => {
	it("proves removal infeasible above n - 1 comparable account-weeks", () => {
		const response = run({
			accounts: CLAUDE_ACCOUNTS,
			resetPeaks: claudePeaks(),
		});
		const row = classRow(response, "anthropic");

		expect(row.tierComparable).toBe(true);
		expect(cycleAt(row, Date.UTC(2026, 7, 23, 7)).verdictBasis).toBe(
			"above_threshold",
		);
		expect(cycleAt(row, Date.UTC(2026, 7, 23, 7)).removalInfeasible).toBe(true);
		expect(row.verdict).toBe("removal_infeasible");
		expect(row.verdictBasis).toBe("above_threshold");
	});

	it("leaves removal not established when every completed cycle is below the threshold", () => {
		const ends = [
			Date.UTC(2026, 7, 7, 7),
			Date.UTC(2026, 7, 14, 7),
			Date.UTC(2026, 7, 21, 7),
			Date.UTC(2026, 7, 28, 7),
		];
		const accounts = [1, 2, 3, 4, 5].map((n) => account(`a${n}`, `A${n}`));
		const response = run({
			accounts,
			resetPeaks: accounts.flatMap((entry) =>
				weekly(entry.id, ends, [70, 70, 70, 70], {
					planTier: "max",
					rateLimitTier: "20x",
					firstStart: (ends[0] as number) - 2 * DAY,
				}),
			),
		});
		const row = classRow(response, "anthropic");

		expect(cycleAt(row, ends[3] as number).consumed).toBeCloseTo(3.5, 6);
		expect(cycleAt(row, ends[3] as number).verdictBasis).toBe(
			"at_or_below_threshold",
		);
		expect(row.verdict).toBe("removal_not_established");
	});

	it("refuses to compare account-weeks across different tiers", () => {
		const reset = Date.UTC(2026, 7, 23, 7);
		const response = run({
			accounts: [
				account("codex-1", "Codex 1", "codex"),
				account("codex-2", "Codex 2", "codex"),
			],
			resetPeaks: [
				...weekly("codex-1", [reset], [75], {
					planTier: "pro",
					rateLimitTier: "prolite",
				}),
				...weekly("codex-2", [reset], [75], { planTier: "plus" }),
			],
		});
		const row = classRow(response, "codex");

		expect(row.tierComparable).toBe(false);
		const cycle = cycleAt(row, reset);
		expect(cycle.consumed).toBeCloseTo(1.5, 6);
		expect(cycle.verdictBasis).toBe("tiers_not_comparable");
		expect(cycle.removalInfeasible).toBe(false);
		expect(row.verdict).toBe("removal_not_established");
	});

	it("refuses to compare account-weeks when no tier was ever captured", () => {
		const reset = Date.UTC(2026, 7, 23, 7);
		const response = run({
			accounts: [
				account("codex-1", "Codex 1", "codex"),
				account("codex-2", "Codex 2", "codex"),
			],
			resetPeaks: [
				...weekly("codex-1", [reset], [75]),
				...weekly("codex-2", [reset], [75]),
			],
		});
		const row = classRow(response, "codex");

		expect(row.tierComparable).toBe(false);
		expect(cycleAt(row, reset).verdictBasis).toBe("tiers_not_comparable");
	});

	it("refuses a cycle in which an account ended more than one window", () => {
		const firstEnd = Date.UTC(2026, 7, 18, 6);
		const secondEnd = Date.UTC(2026, 7, 20, 6);
		const response = run({
			accounts: [
				account("codex-1", "Codex 1", "codex"),
				account("codex-2", "Codex 2", "codex"),
			],
			resetPeaks: [
				{
					accountId: "codex-1",
					resetAt: firstEnd,
					peakPct: 60,
					sampleCount: 100,
					firstSampledAt: Date.UTC(2026, 7, 17, 2),
					lastSampledAt: firstEnd - 5 * MINUTE,
					firstPct: 0,
					lastPct: 60,
					planTier: "pro",
					rateLimitTier: null,
				},
				{
					accountId: "codex-1",
					resetAt: secondEnd,
					peakPct: 40,
					sampleCount: 100,
					firstSampledAt: firstEnd + HOUR,
					lastSampledAt: secondEnd - 5 * MINUTE,
					firstPct: 0,
					lastPct: 40,
					planTier: "pro",
					rateLimitTier: null,
				},
				{
					accountId: "codex-2",
					resetAt: secondEnd,
					peakPct: 50,
					sampleCount: 100,
					firstSampledAt: Date.UTC(2026, 7, 17, 2),
					lastSampledAt: secondEnd - 5 * MINUTE,
					firstPct: 0,
					lastPct: 50,
					planTier: "pro",
					rateLimitTier: null,
				},
			],
		});
		const row = classRow(response, "codex");

		expect(row.tierComparable).toBe(true);
		const cycle = cycleAt(row, firstEnd);
		expect(cycle.consumed).toBeCloseTo(1.5, 6);
		expect(cycle.verdictBasis).toBe("multiple_windows");
		expect(cycle.removalInfeasible).toBe(false);
	});

	it("considers only the newest four completed cycles", () => {
		const ends = [0, 1, 2, 3, 4, 5].map(
			(index) => Date.UTC(2026, 6, 20, 7) + index * WEEK,
		);
		const accounts = [account("a1", "A1"), account("a2", "A2")];
		// The two OLDEST cycles cross the threshold; the newest four do not.
		const peaks = [90, 90, 30, 30, 30, 30];
		const response = run({
			accounts,
			resetPeaks: accounts.flatMap((entry) =>
				weekly(entry.id, ends, peaks, {
					planTier: "max",
					rateLimitTier: "20x",
					firstStart: (ends[0] as number) - 2 * DAY,
				}),
			),
		});
		const row = classRow(response, "anthropic");

		expect(cycleAt(row, ends[0] as number).removalInfeasible).toBe(true);
		expect(row.verdictCycles).toBe(4);
		expect(row.verdict).toBe("removal_not_established");
	});
});

describe("add signal", () => {
	function poolAt(peak: number) {
		const reset = Date.UTC(2026, 7, 23, 7);
		const accounts = [1, 2, 3, 4, 5].map((n) => account(`a${n}`, `A${n}`));
		return run({
			accounts,
			resetPeaks: accounts.flatMap((entry) =>
				weekly(entry.id, [reset], [peak]),
			),
		});
	}

	it("enters the reserve band above n × (1 - headroom)", () => {
		const inside = classRow(poolAt(82), "anthropic");
		expect(cycleAt(inside, Date.UTC(2026, 7, 23, 7)).reserveBandEntered).toBe(
			true,
		);
		expect(inside.reserveBandCycles).toBe(1);

		const outside = classRow(poolAt(78), "anthropic");
		expect(cycleAt(outside, Date.UTC(2026, 7, 23, 7)).reserveBandEntered).toBe(
			false,
		);
		expect(outside.reserveBandCycles).toBe(0);
	});
});

describe("stops", () => {
	const reset = Date.UTC(2026, 7, 23, 7);

	function withStops(stops: PoolSizingComputeInput["stops"]) {
		return run({
			accounts: [
				account("claude-1", "Claude 1"),
				account("codex-1", "Codex 1", "codex"),
			],
			resetPeaks: [
				...weekly("claude-1", [reset], [50]),
				...weekly("codex-1", [reset], [50]),
			],
			scopedResetPeaks: [
				{
					accountId: "claude-1",
					family: "fable",
					displayName: "Fable",
					resetAt: reset,
					peakPct: 30,
					sampleCount: 100,
					firstSampledAt: reset - 6 * DAY,
					lastSampledAt: reset - 5 * MINUTE,
					firstPct: 0,
					lastPct: 30,
				},
			],
			stops,
		});
	}

	it("counts a client-facing refusal for the class that serves the model", () => {
		const response = withStops([
			{
				label: "pool_exhausted",
				model: "claude-sonnet-4-5",
				timestamp: reset - DAY,
			},
		]);
		const anthropic = classRow(response, "anthropic");
		const cycle = cycleAt(anthropic, reset);
		expect(cycle.terminalStops).toBe(1);
		expect(cycle.rejectedAttempts).toBe(0);
		expect(anthropic.terminalStopCycles).toBe(1);
		expect(classRow(response, "codex").terminalStopCycles).toBe(0);
	});

	it("keeps per-attempt rejections out of the add signal", () => {
		const response = withStops([
			{
				label: "weekly_exhausted_429",
				model: "claude-sonnet-4-5",
				timestamp: reset - DAY,
			},
		]);
		const cycle = cycleAt(classRow(response, "anthropic"), reset);
		expect(cycle.rejectedAttempts).toBe(1);
		expect(cycle.terminalStops).toBe(0);
		expect(classRow(response, "anthropic").terminalStopCycles).toBe(0);
	});

	it("attributes a family-scoped refusal to its family row only", () => {
		const response = withStops([
			{
				label: "family_weekly_exhausted",
				model: "claude-fable-5",
				timestamp: reset - DAY,
			},
		]);
		expect(cycleAt(familyRow(response, "fable"), reset).terminalStops).toBe(1);
		expect(cycleAt(classRow(response, "anthropic"), reset).terminalStops).toBe(
			1,
		);
		expect(cycleAt(classRow(response, "codex"), reset).terminalStops).toBe(0);
	});

	it("attributes GPT models to the codex class", () => {
		const response = withStops([
			{ label: "pool_exhausted", model: "gpt-5.6", timestamp: reset - DAY },
		]);
		expect(cycleAt(classRow(response, "codex"), reset).terminalStops).toBe(1);
		expect(cycleAt(classRow(response, "anthropic"), reset).terminalStops).toBe(
			0,
		);
	});

	it("lists give-up terminals and unattributable models separately", () => {
		const response = withStops([
			{
				label: "all_accounts_failed",
				model: "claude-3-opus-retired",
				timestamp: reset - DAY,
			},
			{
				label: "all_accounts_failed",
				model: "claude-3-opus-retired",
				timestamp: reset - 2 * DAY,
			},
			{ label: "pool_exhausted", model: "llama-3", timestamp: reset - DAY },
		]);

		expect(response.separateStops).toEqual([
			{
				label: "all_accounts_failed",
				model: "claude-3-opus-retired",
				count: 2,
				firstAt: reset - 2 * DAY,
				lastAt: reset - DAY,
			},
			{
				label: "pool_exhausted",
				model: "llama-3",
				count: 1,
				firstAt: reset - DAY,
				lastAt: reset - DAY,
			},
		]);
		expect(cycleAt(classRow(response, "anthropic"), reset).terminalStops).toBe(
			0,
		);
	});

	it("maps requested models onto the class that serves them", () => {
		expect(stopClassForModel("claude-sonnet-4-5")).toBe("anthropic");
		expect(stopClassForModel("claude-fable-5")).toBe("anthropic");
		expect(stopClassForModel("claude-unknown-9")).toBe("anthropic");
		expect(stopClassForModel("gpt-5.6")).toBe("codex");
		expect(stopClassForModel("o3-mini")).toBe("codex");
		expect(stopClassForModel("codex-mini-latest")).toBe("codex");
		expect(stopClassForModel("llama-3")).toBeNull();
		expect(stopClassForModel(null)).toBeNull();
	});
});

describe("5-hour burst", () => {
	const reset = Date.UTC(2026, 7, 23, 7);

	function withTicks(ticks: PoolSizingComputeInput["burstTicks"]) {
		return run({
			accounts: [account("claude-1", "Claude 1")],
			resetPeaks: weekly("claude-1", [reset], [50]),
			scopedResetPeaks: [
				{
					accountId: "claude-1",
					family: "fable",
					displayName: "Fable",
					resetAt: reset,
					peakPct: 30,
					sampleCount: 100,
					firstSampledAt: reset - 6 * DAY,
					lastSampledAt: reset - 5 * MINUTE,
					firstPct: 0,
					lastPct: 30,
				},
			],
			burstTicks: ticks,
		});
	}

	it("reports the peak simultaneous spent accounts in the cycle", () => {
		const response = withTicks([
			{ sampledAt: reset - 3 * DAY, provider: "anthropic", spent: 3 },
			{ sampledAt: reset - 2 * DAY, provider: "anthropic", spent: 5 },
			{ sampledAt: reset - DAY, provider: "anthropic", spent: 2 },
		]);
		expect(
			cycleAt(classRow(response, "anthropic"), reset).burstPeakAccounts,
		).toBe(5);
	});

	it("never adds accounts spent in different ticks together", () => {
		const response = withTicks([
			{ sampledAt: reset - 2 * DAY, provider: "anthropic", spent: 1 },
			{
				sampledAt: reset - 2 * DAY + 30 * MINUTE,
				provider: "anthropic",
				spent: 1,
			},
		]);
		expect(
			cycleAt(classRow(response, "anthropic"), reset).burstPeakAccounts,
		).toBe(1);
	});

	it("reports zero for a cycle with no spent tick, and null on family rows", () => {
		const response = withTicks([]);
		expect(
			cycleAt(classRow(response, "anthropic"), reset).burstPeakAccounts,
		).toBe(0);
		expect(
			cycleAt(familyRow(response, "fable"), reset).burstPeakAccounts,
		).toBeNull();
	});
});

describe("tier labels", () => {
	const reset = Date.UTC(2026, 7, 23, 7);

	it("names one uniform tier and calls a mixed pool mixed", () => {
		const uniform = run({
			accounts: [account("a1", "A1"), account("a2", "A2")],
			resetPeaks: [
				...weekly("a1", [reset], [50], {
					planTier: "max",
					rateLimitTier: "20x",
				}),
				...weekly("a2", [reset], [50], {
					planTier: "max",
					rateLimitTier: "20x",
				}),
			],
		});
		expect(cycleAt(classRow(uniform, "anthropic"), reset).tierLabel).toBe(
			"Max 20x",
		);

		const mixed = run({
			accounts: [account("c1", "C1", "codex"), account("c2", "C2", "codex")],
			resetPeaks: [
				...weekly("c1", [reset], [50], { planTier: "pro" }),
				...weekly("c2", [reset], [50], { planTier: "plus" }),
			],
		});
		expect(cycleAt(classRow(mixed, "codex"), reset).tierLabel).toBe("mixed");

		const unknown = run({
			accounts: [account("a1", "A1")],
			resetPeaks: weekly("a1", [reset], [50]),
		});
		expect(cycleAt(classRow(unknown, "anthropic"), reset).tierLabel).toBeNull();
	});

	it("spells a plan tier the way the account identity line does", () => {
		expect(formatPlanTierLabel("max", "20x")).toBe("Max 20x");
		expect(formatPlanTierLabel("max", null)).toBe("Max");
		expect(formatPlanTierLabel(null, "20x")).toBe("20x");
		expect(formatPlanTierLabel(null, null)).toBeNull();
		expect(formatPlanTierLabel("pro", "prolite")).toBe("Pro prolite");
	});
});

describe("emission", () => {
	it("returns no rows for empty input", () => {
		const response = run();
		expect(response.rows).toEqual([]);
		expect(response.separateStops).toEqual([]);
		expect(response.sinceMs).toBe(NOW - POOL_SIZING_LOOKBACK_MS);
		expect(response.windowMs).toBe(WEEK);
		expect(response.reserveHeadroomPct).toBe(20);
		expect(response.maxCycles).toBe(POOL_SIZING_MAX_CYCLES);
	});

	it("emits newest first, capped, and never a cycle the lookback could truncate", () => {
		const ends = Array.from(
			{ length: 20 },
			(_unused, index) => NOW - DAY - (19 - index) * WEEK,
		);
		const response = run({
			accounts: [account("a1", "A1")],
			resetPeaks: weekly(
				"a1",
				ends,
				ends.map(() => 40),
				{ firstStart: (ends[0] as number) - 2 * DAY },
			),
		});
		const row = classRow(response, "anthropic");

		expect(row.cycles.length).toBeGreaterThan(1);
		for (let index = 1; index < row.cycles.length; index += 1) {
			expect((row.cycles[index - 1] as PoolSizingCycle).start).toBeGreaterThan(
				(row.cycles[index] as PoolSizingCycle).start,
			);
		}
		const floor = response.sinceMs + 3 * WEEK;
		expect(row.cycles.every((cycle) => cycle.start >= floor)).toBe(true);
		expect(
			row.cycles.filter((cycle) => cycle.status === "completed").length,
		).toBeLessThanOrEqual(POOL_SIZING_MAX_CYCLES);
	});
});

describe("tier capture across placeholders", () => {
	it("keeps the tier reported while an account idled after a completed window", () => {
		const reset = Date.UTC(2026, 7, 23, 7);
		const idleAt = reset + 2 * DAY;
		const response = run({
			accounts: [account("codex-1", "Codex 1", "codex")],
			resetPeaks: [
				// A real, completed window, reported on `pro`.
				{
					accountId: "codex-1",
					resetAt: reset,
					peakPct: 60,
					sampleCount: 300,
					firstSampledAt: reset - 6 * DAY,
					lastSampledAt: reset - 5 * MINUTE,
					firstPct: 0,
					lastPct: 60,
					planTier: "pro",
					rateLimitTier: null,
				},
				// Then the account idles: `now + 7d` at 0%, a placeholder window
				// that never started — but the tier reported alongside it is a
				// DIFFERENT plan, which is evidence the row's account-weeks are not
				// one unit.
				{
					accountId: "codex-1",
					resetAt: idleAt + WEEK,
					peakPct: 0,
					sampleCount: 50,
					firstSampledAt: idleAt,
					lastSampledAt: idleAt,
					firstPct: 0,
					lastPct: 0,
					planTier: "plus",
					rateLimitTier: null,
				},
			],
		});
		const row = classRow(response, "codex");

		expect(row.tierComparable).toBe(false);
	});
});
