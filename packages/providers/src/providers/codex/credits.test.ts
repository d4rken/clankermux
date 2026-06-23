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

	it("returns null weeklyUsedPct when secondary-used-percent is missing", () => {
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
