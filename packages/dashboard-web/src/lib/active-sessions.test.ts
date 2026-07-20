import { describe, expect, it } from "bun:test";
import type { ActiveSessionsTimePoint } from "@clankermux/types";
import {
	type ActiveSessionsAccountRow,
	buildActiveSessionsTrend,
	SCOPE_ORDER,
	SESSION_SCOPE_COLORS,
	SESSION_TOTAL_KEY,
	sortActiveSessionsByAccount,
} from "./active-sessions";

const CLAUDE_KEY = "scope:claude_session";
const CODEX_KEY = "scope:codex_thread";
const PROJECT_KEY = "scope:project";
const TOTAL_KEY = SESSION_TOTAL_KEY;

describe("buildActiveSessionsTrend", () => {
	it("returns empty rows and series for empty input", () => {
		expect(buildActiveSessionsTrend([])).toEqual({ rows: [], series: [] });
	});

	it("orders series claude_session, codex_thread, project regardless of input order", () => {
		const timeSeries: ActiveSessionsTimePoint[] = [
			{ ts: 1, scope: "project", sessions: 3 },
			{ ts: 1, scope: "codex_thread", sessions: 2 },
			{ ts: 1, scope: "claude_session", sessions: 1 },
		];

		const { series } = buildActiveSessionsTrend(timeSeries);
		expect(series).toEqual([
			{ key: CLAUDE_KEY, label: "Claude" },
			{ key: CODEX_KEY, label: "Codex" },
			{ key: PROJECT_KEY, label: "Other (project)" },
		]);
	});

	it("0-fills every scope key in a bucket that only has one scope", () => {
		const timeSeries: ActiveSessionsTimePoint[] = [
			{ ts: 10, scope: "claude_session", sessions: 5 },
		];

		const { rows } = buildActiveSessionsTrend(timeSeries);
		expect(rows).toEqual([
			{
				ts: 10,
				[CLAUDE_KEY]: 5,
				[CODEX_KEY]: 0,
				[PROJECT_KEY]: 0,
				[TOTAL_KEY]: 5,
			},
		]);
	});

	it("omits absent scopes from series but keeps fixed relative order of present ones", () => {
		// project + claude present, codex absent everywhere.
		const timeSeries: ActiveSessionsTimePoint[] = [
			{ ts: 1, scope: "project", sessions: 4 },
			{ ts: 1, scope: "claude_session", sessions: 2 },
		];

		const { series } = buildActiveSessionsTrend(timeSeries);
		expect(series).toEqual([
			{ key: CLAUDE_KEY, label: "Claude" },
			{ key: PROJECT_KEY, label: "Other (project)" },
		]);
	});

	it("sorts rows ascending by ts and 0-fills each bucket", () => {
		const timeSeries: ActiveSessionsTimePoint[] = [
			{ ts: 30, scope: "codex_thread", sessions: 7 },
			{ ts: 10, scope: "claude_session", sessions: 1 },
			{ ts: 20, scope: "project", sessions: 3 },
		];

		const { rows } = buildActiveSessionsTrend(timeSeries);
		expect(rows.map((r) => r.ts)).toEqual([10, 20, 30]);
		expect(rows).toEqual([
			{
				ts: 10,
				[CLAUDE_KEY]: 1,
				[CODEX_KEY]: 0,
				[PROJECT_KEY]: 0,
				[TOTAL_KEY]: 1,
			},
			{
				ts: 20,
				[CLAUDE_KEY]: 0,
				[CODEX_KEY]: 0,
				[PROJECT_KEY]: 3,
				[TOTAL_KEY]: 3,
			},
			{
				ts: 30,
				[CLAUDE_KEY]: 0,
				[CODEX_KEY]: 7,
				[PROJECT_KEY]: 0,
				[TOTAL_KEY]: 7,
			},
		]);
	});

	it("merges multiple scopes that share a ts into one row", () => {
		const timeSeries: ActiveSessionsTimePoint[] = [
			{ ts: 5, scope: "claude_session", sessions: 2 },
			{ ts: 5, scope: "codex_thread", sessions: 3 },
		];

		const { rows } = buildActiveSessionsTrend(timeSeries);
		expect(rows).toEqual([
			{
				ts: 5,
				[CLAUDE_KEY]: 2,
				[CODEX_KEY]: 3,
				[PROJECT_KEY]: 0,
				[TOTAL_KEY]: 5,
			},
		]);
	});

	it("adds a per-bucket total equal to the sum of all client scopes", () => {
		const timeSeries: ActiveSessionsTimePoint[] = [
			{ ts: 1, scope: "claude_session", sessions: 2 },
			{ ts: 1, scope: "codex_thread", sessions: 3 },
			{ ts: 1, scope: "project", sessions: 4 },
			{ ts: 2, scope: "claude_session", sessions: 1 },
		];

		const { rows } = buildActiveSessionsTrend(timeSeries);
		// Bucket 1: 2 + 3 + 4 = 9 across all three scopes.
		expect(rows[0][TOTAL_KEY]).toBe(9);
		// Bucket 2: single scope + 0-filled siblings = 1.
		expect(rows[1][TOTAL_KEY]).toBe(1);
	});
});

describe("sortActiveSessionsByAccount", () => {
	it("sorts rows descending by sessions", () => {
		const rows: ActiveSessionsAccountRow[] = [
			{ accountId: "a", accountName: "Alpha", sessions: 2 },
			{ accountId: "b", accountName: "Bravo", sessions: 5 },
			{ accountId: "c", accountName: "Charlie", sessions: 3 },
		];

		expect(sortActiveSessionsByAccount(rows).map((r) => r.sessions)).toEqual([
			5, 3, 2,
		]);
	});

	it("does not mutate its input", () => {
		const rows: ActiveSessionsAccountRow[] = [
			{ accountId: "a", accountName: "Alpha", sessions: 1 },
			{ accountId: "b", accountName: "Bravo", sessions: 4 },
		];
		const snapshot = rows.map((r) => r.sessions);

		sortActiveSessionsByAccount(rows);
		expect(rows.map((r) => r.sessions)).toEqual(snapshot);
	});

	it("returns an empty array for empty input", () => {
		expect(sortActiveSessionsByAccount([])).toEqual([]);
	});
});

describe("SCOPE_ORDER / SESSION_SCOPE_COLORS", () => {
	it("declares the three scopes in fixed order with stable keys/labels", () => {
		expect(SCOPE_ORDER.map((s) => s.scope)).toEqual([
			"claude_session",
			"codex_thread",
			"project",
		]);
		expect(SCOPE_ORDER.map((s) => s.key)).toEqual([
			CLAUDE_KEY,
			CODEX_KEY,
			PROJECT_KEY,
		]);
	});

	it("exposes a color for every scope key", () => {
		for (const { key } of SCOPE_ORDER) {
			expect(SESSION_SCOPE_COLORS[key]).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});
});
