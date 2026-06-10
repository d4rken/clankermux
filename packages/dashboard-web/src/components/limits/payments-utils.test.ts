import { describe, expect, it } from "bun:test";
import type { PaymentsSummaryPerAccount } from "@clankermux/types";
import {
	amortizedMonthlyByAccountName,
	formatValueRatio,
} from "./payments-utils";

function entry(
	overrides: Partial<PaymentsSummaryPerAccount>,
): PaymentsSummaryPerAccount {
	return {
		accountId: "id-1",
		accountName: "acct",
		priceUsd: 200,
		cadence: "monthly",
		nextDueDate: null,
		amortizedMonthlyUsd: 200,
		rangeLedgerUsd: 0,
		rangeTokenCostUsd: 0,
		...overrides,
	};
}

describe("formatValueRatio", () => {
	it("formats a ratio with one decimal and a multiplication sign", () => {
		expect(formatValueRatio(3.27)).toBe("3.3×");
		expect(formatValueRatio(0)).toBe("0.0×");
		expect(formatValueRatio(12)).toBe("12.0×");
	});

	it("returns an em-dash when the ratio is unavailable", () => {
		expect(formatValueRatio(null)).toBe("—");
		expect(formatValueRatio(undefined)).toBe("—");
		expect(formatValueRatio(Number.NaN)).toBe("—");
		expect(formatValueRatio(Number.POSITIVE_INFINITY)).toBe("—");
	});
});

describe("amortizedMonthlyByAccountName", () => {
	it("maps account names to amortized monthly cost", () => {
		const map = amortizedMonthlyByAccountName([
			entry({ accountName: "a", amortizedMonthlyUsd: 200 }),
			entry({ accountName: "b", amortizedMonthlyUsd: 16.67 }),
		]);
		expect(map.get("a")).toBe(200);
		expect(map.get("b")).toBe(16.67);
	});

	it("omits accounts without a configured price", () => {
		const map = amortizedMonthlyByAccountName([
			entry({ accountName: "a", priceUsd: null, amortizedMonthlyUsd: 0 }),
		]);
		expect(map.has("a")).toBe(false);
	});

	it("sums duplicate names defensively", () => {
		const map = amortizedMonthlyByAccountName([
			entry({ accountName: "a", amortizedMonthlyUsd: 100 }),
			entry({ accountId: "id-2", accountName: "a", amortizedMonthlyUsd: 50 }),
		]);
		expect(map.get("a")).toBe(150);
	});

	it("returns an empty map for no accounts", () => {
		expect(amortizedMonthlyByAccountName([]).size).toBe(0);
	});
});
