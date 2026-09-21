/**
 * Tests for assemblePaymentsSummary — the pure step that turns the worker's
 * raw aggregates into the API response.
 *
 * Focused on which prices are allowed to reach a money total. A `derived`
 * price is a list price looked up from the plan tier, so it is shown on the
 * account but must not appear in the amortized monthly figure or in the
 * per-account price, on the same reasoning that keeps it out of the ledger.
 */
import { describe, expect, it } from "bun:test";
import "@clankermux/core";
import { toCostCoverage } from "../cost-coverage";
import { assemblePaymentsSummary } from "../payments";
import type { PaymentsSummaryData } from "../payments-summary-direct";

/** 2026-06-09, local noon. */
const NOW = new Date(2026, 5, 9, 12).getTime();

type RenewalConfig = PaymentsSummaryData["renewalConfigs"][number];

function config(overrides: Partial<RenewalConfig> = {}): RenewalConfig {
	return {
		id: "acc-1",
		name: "acc-1",
		renewal_anchor: "2026-06-20",
		renewal_cadence: "monthly",
		renewal_price_usd_micros: 200_000_000,
		renewal_price_source: null,
		...overrides,
	};
}

function data(renewalConfigs: RenewalConfig[]): PaymentsSummaryData {
	const costs = {
		tokenCostUsd: 0,
		planValueUsd: 0,
		overageTokenCostUsd: 0,
		apiCostCoverage: toCostCoverage(null),
	};
	return {
		nowMs: NOW,
		range: { range: "30d", from: NOW - 30 * 86_400_000, to: NOW },
		monthStartMs: new Date(2026, 5, 1).getTime(),
		currentMonth: { ledgerByKind: [], costs },
		rangeWindow: { ledgerByKind: [], costs },
		perAccountLedgerMicros: [],
		perAccountTokenCostUsd: [],
		ledgerAccountNames: [],
		renewalConfigs,
		recentPayments: [],
	} as PaymentsSummaryData;
}

describe("assemblePaymentsSummary — derived prices stay out of the totals", () => {
	it("counts a confirmed price toward the amortized monthly figure", () => {
		const summary = assemblePaymentsSummary(
			data([config({ renewal_price_source: "manual" })]),
		);

		expect(summary.amortizedMonthlyUsd).toBe(200);
		expect(summary.perAccount[0]?.priceUsd).toBe(200);
	});

	it("counts a price that predates the provenance column", () => {
		const summary = assemblePaymentsSummary(
			data([config({ renewal_price_source: null })]),
		);

		expect(summary.amortizedMonthlyUsd).toBe(200);
	});

	it("leaves a derived price out of the total and out of the row", () => {
		const summary = assemblePaymentsSummary(
			data([config({ renewal_price_source: "derived" })]),
		);

		expect(summary.amortizedMonthlyUsd).toBe(0);
		// With no price it may book, no ledger rows and no usage, the account has
		// nothing to say in a payments summary at all.
		expect(summary.perAccount).toHaveLength(0);
	});

	it("adds up only the confirmed prices in a mixed fleet", () => {
		const summary = assemblePaymentsSummary(
			data([
				config({ id: "a", name: "a", renewal_price_source: "manual" }),
				config({
					id: "b",
					name: "b",
					renewal_price_source: "derived",
					renewal_price_usd_micros: 100_000_000,
				}),
				config({
					id: "c",
					name: "c",
					renewal_price_source: "manual",
					renewal_price_usd_micros: 20_000_000,
					renewal_cadence: "yearly",
				}),
			]),
		);

		// 200 monthly + 20/12 yearly; the 100 derived contributes nothing.
		expect(summary.amortizedMonthlyUsd).toBeCloseTo(200 + 20 / 12, 6);
		expect(summary.perAccount.map((r) => r.accountId).sort()).toEqual([
			"a",
			"c",
		]);
	});
});
