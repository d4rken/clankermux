import { describe, expect, it } from "bun:test";
import {
	type CodexCreditsInfo,
	isCodexOnCredits,
	parseCodexCreditsHeaders,
} from "./usage";

const fullCreditsHeaders: Record<string, string> = {
	"x-codex-credits-has-credits": "True",
	"x-codex-credits-balance": "2430.2512500000",
	"x-codex-credits-unlimited": "False",
	"x-codex-plan-type": "prolite",
	"x-codex-secondary-used-percent": "100",
	"x-codex-secondary-window-minutes": "10080",
};

describe("parseCodexCreditsHeaders", () => {
	it("returns null when x-codex-credits-has-credits header is absent", () => {
		expect(parseCodexCreditsHeaders({})).toBeNull();
		expect(
			parseCodexCreditsHeaders({ "x-codex-plan-type": "prolite" }),
		).toBeNull();
	});

	it("parses a full on-credits header set", () => {
		expect(parseCodexCreditsHeaders(fullCreditsHeaders)).toEqual({
			hasCredits: true,
			balance: 2430.25,
			unlimited: false,
			planType: "prolite",
			weeklyUsedPct: 100,
		});
	});

	it("matches boolean values case-insensitively", () => {
		for (const value of ["True", "true", "TRUE"]) {
			const info = parseCodexCreditsHeaders({
				"x-codex-credits-has-credits": value,
			});
			expect(info?.hasCredits).toBe(true);
		}
		const falseInfo = parseCodexCreditsHeaders({
			"x-codex-credits-has-credits": "False",
		});
		expect(falseInfo?.hasCredits).toBe(false);
	});

	it("parses a has-credits:false set with no balance", () => {
		expect(
			parseCodexCreditsHeaders({
				"x-codex-credits-has-credits": "False",
				"x-codex-credits-unlimited": "False",
				"x-codex-plan-type": "prolite",
				"x-codex-secondary-used-percent": "42",
				"x-codex-secondary-window-minutes": "10080",
			}),
		).toEqual({
			hasCredits: false,
			balance: null,
			unlimited: false,
			planType: "prolite",
			weeklyUsedPct: 42,
		});
	});

	it("parses unlimited:true and still reads balance when present", () => {
		expect(
			parseCodexCreditsHeaders({
				"x-codex-credits-has-credits": "True",
				"x-codex-credits-balance": "10.0000",
				"x-codex-credits-unlimited": "True",
				"x-codex-plan-type": "promax",
				"x-codex-secondary-used-percent": "100",
				"x-codex-secondary-window-minutes": "10080",
			}),
		).toEqual({
			hasCredits: true,
			balance: 10,
			unlimited: true,
			planType: "promax",
			weeklyUsedPct: 100,
		});
	});

	it("accepts a Headers instance and a plain record identically", () => {
		const headers = new Headers(fullCreditsHeaders);
		const fromHeaders = parseCodexCreditsHeaders(headers);
		const fromRecord = parseCodexCreditsHeaders(fullCreditsHeaders);
		expect(fromHeaders).toEqual(fromRecord);
		expect(fromHeaders).toEqual({
			hasCredits: true,
			balance: 2430.25,
			unlimited: false,
			planType: "prolite",
			weeklyUsedPct: 100,
		});
	});

	it("returns null balance for malformed balance values", () => {
		for (const balance of ["abc", ""]) {
			const info = parseCodexCreditsHeaders({
				"x-codex-credits-has-credits": "True",
				"x-codex-credits-balance": balance,
			});
			expect(info?.balance).toBeNull();
		}
	});

	it.each([
		["primary weekly with empty secondary", "10080", "100", "0", "0", 100],
		["secondary weekly", "300", "100", "10080", "42", 42],
		["primary precedence", "10080", "0", "10080", "100", 0],
		["missing primary percent fallback", "10080", null, "10080", "73", 73],
		["malformed primary percent fallback", "10080", "bad", "10080", "73", 73],
		["zero is observed without a reset", "10080", "0", null, null, 0],
		["missing durations", null, "100", null, "100", null],
		["unknown durations", "600", "100", "bad", "100", null],
		["empty slots", "0", "100", "0", "100", null],
		["five-hour only", "300", "100", null, null, null],
		["weekly without percent", "10080", null, null, null, null],
		["nonfinite weekly", "10080", "Infinity", null, null, null],
	] as const)("slots weekly usage: %s", (_name, primaryMinutes, primaryPct, secondaryMinutes, secondaryPct, expected) => {
		const headers: Record<string, string> = {
			"x-codex-credits-has-credits": "true",
		};
		for (const [key, value] of Object.entries({
			"x-codex-primary-window-minutes": primaryMinutes,
			"x-codex-primary-used-percent": primaryPct,
			"x-codex-secondary-window-minutes": secondaryMinutes,
			"x-codex-secondary-used-percent": secondaryPct,
		})) {
			if (value !== null) headers[key] = value;
		}
		for (const input of [headers, new Headers(headers)]) {
			const info = parseCodexCreditsHeaders(input);
			expect(info?.weeklyUsedPct).toBe(expected);
			expect(isCodexOnCredits(info)).toBe(expected !== null && expected >= 100);
		}
	});

	it("returns null weeklyUsedPct when no weekly percentage is reported", () => {
		const info = parseCodexCreditsHeaders({
			"x-codex-credits-has-credits": "True",
		});
		expect(info?.weeklyUsedPct).toBeNull();
	});
});

describe("isCodexOnCredits", () => {
	const make = (overrides: Partial<CodexCreditsInfo>): CodexCreditsInfo => ({
		hasCredits: true,
		balance: 100,
		unlimited: false,
		planType: "prolite",
		weeklyUsedPct: 100,
		...overrides,
	});

	it("returns false for null", () => {
		expect(isCodexOnCredits(null)).toBe(false);
	});

	it("returns true when on credits, not unlimited, weekly exhausted", () => {
		expect(
			isCodexOnCredits(make({ unlimited: false, weeklyUsedPct: 100 })),
		).toBe(true);
	});

	it("returns false when weekly not exhausted", () => {
		expect(
			isCodexOnCredits(make({ unlimited: false, weeklyUsedPct: 50 })),
		).toBe(false);
	});

	it("returns false when unlimited (no financial risk)", () => {
		expect(
			isCodexOnCredits(make({ unlimited: true, weeklyUsedPct: 100 })),
		).toBe(false);
	});

	it("returns false when not on credits", () => {
		expect(
			isCodexOnCredits(make({ hasCredits: false, weeklyUsedPct: 100 })),
		).toBe(false);
	});

	it("returns false when weeklyUsedPct is null (cannot confirm exhausted)", () => {
		expect(
			isCodexOnCredits(make({ unlimited: false, weeklyUsedPct: null })),
		).toBe(false);
	});
});
