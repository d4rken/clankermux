import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { buildQuotaSummary } from "./quota-summary";

const NOW = Date.UTC(2026, 8, 7);
const HOUR = 3_600_000;
function account(
	id: string,
	used: number,
	overrides: Partial<AccountResponse> = {},
): AccountResponse {
	return {
		id,
		name: id,
		provider: "anthropic",
		paused: false,
		rateLimitCause: "ok",
		usageData: {
			five_hour: {
				utilization: 10,
				resets_at: new Date(NOW + HOUR).toISOString(),
			},
			seven_day: {
				utilization: used,
				resets_at: new Date(NOW + 3 * 24 * HOUR).toISOString(),
			},
		},
		...overrides,
	} as AccountResponse;
}
const fable = (pct: number, reset: number | null = NOW + 24 * HOUR) => ({
	kind: "weekly_scoped",
	percent: pct,
	resets_at: reset === null ? null : new Date(reset).toISOString(),
	scope: { model: { id: "fable", display_name: "Fable" } },
});
describe("quota summary", () => {
	it("averages remaining quota across every account rather than picking the lowest", () => {
		const [row] = buildQuotaSummary([account("a", 20), account("b", 80)], NOW);
		expect(row?.remainingPct).toBe(50);
		expect(row?.availableCount).toBe(2);
	});
	it("keeps paused and cooling accounts in the denominator and alphabetical order", () => {
		const accounts = [account("b", 80), account("a", 20)];
		const [before] = buildQuotaSummary(accounts, NOW);
		const [after] = buildQuotaSummary(
			[
				{ ...accounts[0], paused: true },
				{ ...accounts[1], rateLimitedUntil: NOW + HOUR },
			],
			NOW,
		);
		expect(after.remainingPct).toBe(before.remainingPct);
		expect(after.availableCount).toBe(0);
		expect(after.accounts.map((a) => a.id)).toEqual(["a", "b"]);
		expect(after.recoveryMs).toBe(NOW + HOUR);
	});
	it("does not claim a full-pool percentage when a reading is missing or expired", () => {
		expect(
			buildQuotaSummary(
				[account("a", 20), account("b", 80, { usageData: null })],
				NOW,
			)[0].remainingPct,
		).toBeNull();
		expect(
			buildQuotaSummary([account("a", 20)], NOW + 4 * 24 * HOUR)[0]
				.remainingPct,
		).toBeNull();
	});
	it("shows Fable's untouched quota even during an account-wide five-hour block", () => {
		const reporter = account("b", 80);
		reporter.usageData = {
			...reporter.usageData,
			limits: [fable(60)],
		} as AccountResponse["usageData"];
		const blocked = account("a", 20);
		blocked.usageData = {
			...blocked.usageData,
			five_hour: {
				utilization: 100,
				resets_at: new Date(NOW + HOUR).toISOString(),
			},
		} as AccountResponse["usageData"];
		const row = buildQuotaSummary([reporter, blocked], NOW).find(
			(r) => r.model === "fable",
		);
		expect(row?.remainingPct).toBe(70);
		expect(row?.availableCount).toBe(1);
		expect(row?.accounts[0].status).toBe("5h limit reached");
	});
	it("keeps exhausted and expired model rows while using the latest blocking reset for recovery", () => {
		const a = account("a", 20);
		a.usageData = {
			...a.usageData,
			limits: [fable(100)],
			five_hour: {
				utilization: 100,
				resets_at: new Date(NOW + HOUR).toISOString(),
			},
		} as AccountResponse["usageData"];
		const row = buildQuotaSummary([a], NOW).find((r) => r.model === "fable");
		expect(row?.remainingPct).toBe(0);
		expect(row?.recoveryMs).toBe(NOW + 24 * HOUR);
		const expired = buildQuotaSummary([a], NOW + 25 * HOUR).find(
			(r) => r.model === "fable",
		);
		expect(expired?.remainingPct).toBeNull();
		expect(expired?.accounts).toHaveLength(1);
	});
	it("keeps providers separate and supports non-Claude model windows", () => {
		const a = account("a", 10, { provider: "codex" });
		a.usageData = {
			...a.usageData,
			limits: [
				{
					...fable(30),
					scope: { model: { id: "astra", display_name: "Astra" } },
				},
			],
		} as AccountResponse["usageData"];
		const rows = buildQuotaSummary([a, account("b", 80)], NOW);
		expect(
			rows.find((r) => r.provider === "codex" && !r.model)?.remainingPct,
		).toBe(90);
		expect(rows.find((r) => r.model === "astra")?.remainingPct).toBe(70);
	});
});

describe("quota availability evidence", () => {
	it("does not promise recovery at the five-hour reset while payment is required", () => {
		const a = account("a", 20, {
			rateLimitCause: "payment_required",
			rateLimitCauseResetMs: null,
		});
		a.usageData = {
			...a.usageData,
			five_hour: {
				utilization: 100,
				resets_at: new Date(NOW + HOUR).toISOString(),
			},
		} as AccountResponse["usageData"];
		const row = buildQuotaSummary([a], NOW)[0];
		expect(row?.recoveryMs).toBeNull();
		expect(row?.accounts[0].status).toContain("Payment required");
	});
	it("keeps missing availability distinct from confirmed blocking", () => {
		const row = buildQuotaSummary(
			[account("a", 20, { usageData: null })],
			NOW,
		)[0];
		expect(row.unknownCount).toBe(1);
		expect(row?.availableCount).toBe(0);
	});
	it("retains model membership from recorded history after the live window disappears", () => {
		const a = account("a", 20);
		const rows = buildQuotaSummary([a], NOW, {
			range: "30d",
			bucketMs: 60000,
			families: [
				{
					family: "fable",
					displayName: "Fable",
					series: [
						{ accountId: "a", name: "a", provider: "anthropic", points: [] },
					],
					pool: [],
				},
			],
		});
		expect(rows.find((r) => r.model === "fable")?.remainingPct).toBe(100);
	});
});

it("does not display an unopened window's sliding reset as a deadline", () => {
	const a = account("idle", 0, {
		usageAsOfIso: new Date(NOW).toISOString(),
		usageData: {
			seven_day: {
				utilization: 0,
				resets_at: new Date(NOW + 7 * 24 * HOUR).toISOString(),
			},
			five_hour: {
				utilization: 0,
				resets_at: new Date(NOW + 5 * HOUR).toISOString(),
			},
		},
	});
	const row = buildQuotaSummary([a], NOW)[0];
	expect(row.remainingPct).toBe(100);
	expect(row.accounts[0].resetMs).toBeNull();
	expect(row.accounts[0].shortWindowResetMs).toBeNull();
});

describe("short-window evidence", () => {
	const devin = (
		daily: { utilization: number; resetAt: number } | null,
	): AccountResponse =>
		account("Devin-1", 0, {
			provider: "devin",
			usageAsOfIso: new Date(NOW).toISOString(),
			usageData: {
				kind: "devin",
				quotaBased: true,
				daily,
				weekly: { utilization: 20, resetAt: NOW + 3 * 24 * HOUR },
				planName: "Team",
				email: null,
				accountId: null,
			},
		} as Partial<AccountResponse>);

	it("keeps an account available on its readable weekly window alone", () => {
		// A short window with no reading does NOT withhold availability. The
		// extractors return `{ pct: null }` both for a window that could not be
		// read and for one the plan does not run, and Codex's absent 5-hour window
		// is the second: gating on it marks every healthy Codex account
		// unavailable. See the sibling case below, which pins that.
		expect(buildQuotaSummary([devin(null)], NOW)[0].accounts[0].available).toBe(
			true,
		);
		expect(
			buildQuotaSummary(
				[devin({ utilization: 5, resetAt: NOW + 6 * HOUR })],
				NOW,
			)[0].accounts[0].available,
		).toBe(true);
	});

	it("keeps a Codex account with no 5-hour window available", () => {
		// Codex retired its rolling 5-hour window, so `five_hour: null` is
		// routinely the window not existing rather than one that went unread —
		// and a gate that cannot tell the two apart takes every such account
		// offline. A readable weekly window is the whole of the evidence here.
		const row = buildQuotaSummary(
			[
				account("Codex-me", 20, {
					provider: "codex",
					usageData: {
						five_hour: null,
						seven_day: {
							utilization: 20,
							resets_at: new Date(NOW + 3 * 24 * HOUR).toISOString(),
						},
					},
				} as Partial<AccountResponse>),
			],
			NOW,
		)[0];
		expect(row.accounts[0].status).toBe("Available");
		expect(row.availableCount).toBe(1);
	});
});
