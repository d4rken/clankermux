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
					series: [{ accountId: "a", name: "a", points: [] }],
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
	expect(row.accounts[0].fiveHourResetMs).toBeNull();
});
