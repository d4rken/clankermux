import { describe, expect, it } from "bun:test";
import {
	buildToolErrorTrend,
	groupToolMessages,
	MAX_MESSAGES_PER_TOOL,
	toolKey,
} from "./tool-errors";

describe("toolKey", () => {
	it("prefixes tool names so they can't collide with row fields", () => {
		expect(toolKey("ts")).toBe("tool:ts");
		expect(toolKey("Bash")).toBe("tool:Bash");
	});
});

describe("buildToolErrorTrend", () => {
	it("pivots (ts, tool) points into one row per bucket with error-rate %", () => {
		const { rows, series } = buildToolErrorTrend([
			{ ts: 1000, toolName: "Bash", calls: 10, errors: 2 },
			{ ts: 1000, toolName: "Edit", calls: 4, errors: 1 },
			{ ts: 2000, toolName: "Bash", calls: 5, errors: 0 },
		]);

		expect(rows).toEqual([
			{ ts: 1000, "tool:Bash": 20, "tool:Edit": 25 },
			{ ts: 2000, "tool:Bash": 0 },
		]);
		expect(series).toEqual([
			{ key: "tool:Bash", label: "Bash" },
			{ key: "tool:Edit", label: "Edit" },
		]);
	});

	it("orders series by total errors desc for stable color assignment", () => {
		const { series } = buildToolErrorTrend([
			{ ts: 1000, toolName: "Read", calls: 100, errors: 1 },
			{ ts: 1000, toolName: "Bash", calls: 10, errors: 5 },
			{ ts: 2000, toolName: "Read", calls: 100, errors: 1 },
		]);
		expect(series.map((s) => s.label)).toEqual(["Bash", "Read"]);
	});

	it("sorts rows chronologically regardless of input order", () => {
		const { rows } = buildToolErrorTrend([
			{ ts: 3000, toolName: "Bash", calls: 1, errors: 1 },
			{ ts: 1000, toolName: "Bash", calls: 1, errors: 0 },
		]);
		expect(rows.map((r) => r.ts)).toEqual([1000, 3000]);
	});

	it("skips zero-call points instead of dividing by zero", () => {
		const { rows, series } = buildToolErrorTrend([
			{ ts: 1000, toolName: "Bash", calls: 0, errors: 0 },
		]);
		expect(rows).toEqual([]);
		// A tool with only zero-call points gets no series entry either —
		// zero-call rows carry no ordering weight.
		expect(series).toEqual([]);
	});

	it("returns empty rows and series for an empty input", () => {
		expect(buildToolErrorTrend([])).toEqual({ rows: [], series: [] });
	});
});

describe("groupToolMessages", () => {
	it("groups by tool, ordered by total occurrences desc", () => {
		const groups = groupToolMessages([
			{ toolName: "Edit", errorText: "no match", occurrences: 3 },
			{ toolName: "Bash", errorText: "exit 1", occurrences: 5 },
			{ toolName: "Edit", errorText: "not unique", occurrences: 4 },
		]);

		expect(groups.map((g) => g.toolName)).toEqual(["Edit", "Bash"]);
		expect(groups[0].totalOccurrences).toBe(7);
		expect(groups[0].messages.map((m) => m.errorText)).toEqual([
			"not unique",
			"no match",
		]);
		expect(groups[1].totalOccurrences).toBe(5);
	});

	it("caps messages per tool but counts all occurrences in the total", () => {
		const messages = Array.from({ length: 8 }, (_, i) => ({
			toolName: "Bash",
			errorText: `error ${i}`,
			occurrences: 8 - i,
		}));
		const groups = groupToolMessages(messages);

		expect(groups).toHaveLength(1);
		expect(groups[0].messages).toHaveLength(MAX_MESSAGES_PER_TOOL);
		// 8+7+6+5+4+3+2+1 — the capped tail still counts toward the total.
		expect(groups[0].totalOccurrences).toBe(36);
		// Highest-occurrence messages survive the cap.
		expect(groups[0].messages[0].occurrences).toBe(8);
	});

	it("returns empty for empty input", () => {
		expect(groupToolMessages([])).toEqual([]);
	});
});
