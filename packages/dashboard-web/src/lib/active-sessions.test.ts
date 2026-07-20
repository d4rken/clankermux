import { describe, expect, it } from "bun:test";
import type { ActiveSessionsTimePoint } from "@clankermux/types";
import {
	buildActiveSessionsTrend,
	SCOPE_ORDER,
	SESSION_SCOPE_COLORS,
} from "./active-sessions";

const CLAUDE_KEY = "scope:claude_session";
const CODEX_KEY = "scope:codex_thread";
const PROJECT_KEY = "scope:project";

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
			{ ts: 10, [CLAUDE_KEY]: 1, [CODEX_KEY]: 0, [PROJECT_KEY]: 0 },
			{ ts: 20, [CLAUDE_KEY]: 0, [CODEX_KEY]: 0, [PROJECT_KEY]: 3 },
			{ ts: 30, [CLAUDE_KEY]: 0, [CODEX_KEY]: 7, [PROJECT_KEY]: 0 },
		]);
	});

	it("merges multiple scopes that share a ts into one row", () => {
		const timeSeries: ActiveSessionsTimePoint[] = [
			{ ts: 5, scope: "claude_session", sessions: 2 },
			{ ts: 5, scope: "codex_thread", sessions: 3 },
		];

		const { rows } = buildActiveSessionsTrend(timeSeries);
		expect(rows).toEqual([
			{ ts: 5, [CLAUDE_KEY]: 2, [CODEX_KEY]: 3, [PROJECT_KEY]: 0 },
		]);
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
