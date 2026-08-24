/**
 * The claim-series audit panel.
 *
 * Two claims under test, both about refusing to say more than the audit does:
 * an absent audit renders NOTHING (an empty table would read as "the series is
 * empty"), and an output with no denominator renders as an em dash rather than
 * as 0%.
 */
import { describe, expect, it } from "bun:test";
import type { QuotaClaimAudit, QuotaClaimAuditEntry } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaimSeriesAuditPanel } from "./ClaimSeriesAuditPanel";

const FROM = Date.UTC(2026, 4, 26, 12, 0, 0, 0);
const TO = Date.UTC(2026, 7, 24, 12, 0, 0, 0);

function entry(over: Partial<QuotaClaimAuditEntry> = {}): QuotaClaimAuditEntry {
	return {
		claim: "5h",
		nSeries: 4,
		nAccounts: 3,
		rows: 8_412,
		firstObservedAt: FROM,
		lastObservedAt: TO,
		rowsPerDay: 93.5,
		nullUtilizationRows: 12,
		nullUtilizationShare: 12 / 8_412,
		distinctValues: 101,
		distinctValuesExact: true,
		topValues: [{ value: 0.42, count: 300 }],
		onGrid01: 8_400,
		onGrid001: 8_400,
		gridShare01: 1,
		gridShare001: 1,
		transitions: 8_000,
		positiveIncrements: 7_800,
		minPositiveIncrement: 0.01,
		medianPositiveIncrement: 0.02,
		stableResetTransitions: 7_000,
		stableResetNegatives: 40,
		giftDrops: 6,
		giftDropsOrderingSuspect: 4,
		giftDropsUnexplained: 2,
		composition: {
			bySource: [
				{ label: "client", count: 8_100 },
				{ label: "keepalive", count: 312 },
			],
			byStatus: [{ label: "allowed", count: 8_412 }],
			byHttpStatus: [{ label: "200", count: 8_400 }],
		},
		...over,
	};
}

function audit(claims: QuotaClaimAuditEntry[]): QuotaClaimAudit {
	return { fromMs: FROM, toMs: TO, claims };
}

describe("ClaimSeriesAuditPanel", () => {
	it("renders nothing at all when the payload carries no audit", () => {
		// A payload written before the audit existed. An empty table here would
		// say the series is empty, which is a claim.
		expect(renderToStaticMarkup(<ClaimSeriesAuditPanel />)).toBe("");
		expect(renderToStaticMarkup(<ClaimSeriesAuditPanel audit={null} />)).toBe(
			"",
		);
	});

	it("is collapsed and says what the numbers are not", () => {
		const html = renderToStaticMarkup(
			<ClaimSeriesAuditPanel audit={audit([entry()])} />,
		);

		expect(html).toContain("<details");
		expect(html).not.toContain("<details open");
		expect(html).toContain("Claim-series audit");
		expect(html).toContain("nothing here is a statement about the provider");
		// COMPOSITION, never coverage.
		expect(html).toContain("say nothing about responses that were not");
		expect(html).not.toContain("coverage");
	});

	it("renders the counters for each claim", () => {
		const html = renderToStaticMarkup(
			<ClaimSeriesAuditPanel
				audit={audit([entry(), entry({ claim: "7d", rows: 900 })])}
			/>,
		);

		expect(html).toContain("5h");
		expect(html).toContain("7d");
		expect(html).toContain("8,412");
		expect(html).toContain("93.5");
		expect(html).toContain("4 ordering, 2 unexplained");
		expect(html).toContain("40 / 7,000");
		expect(html).toContain("client 8,100");
		expect(html).toContain("keepalive 312");
	});

	it("renders an absent output as a dash, never as a zero", () => {
		const html = renderToStaticMarkup(
			<ClaimSeriesAuditPanel
				audit={audit([
					entry({
						rowsPerDay: null,
						gridShare01: null,
						gridShare001: null,
						minPositiveIncrement: null,
						medianPositiveIncrement: null,
						nullUtilizationShare: null,
					}),
				])}
			/>,
		);

		expect(html).toContain("—");
		expect(html).not.toContain("0.0%");
		expect(html).not.toContain("0.0000");
	});

	it("marks a truncated distinct-value count as a floor", () => {
		const html = renderToStaticMarkup(
			<ClaimSeriesAuditPanel
				audit={audit([
					entry({ distinctValues: 2000, distinctValuesExact: false }),
				])}
			/>,
		);

		expect(html).toContain("≥2000");
	});

	it("says so when the span carried no readings at all", () => {
		const html = renderToStaticMarkup(
			<ClaimSeriesAuditPanel audit={audit([])} />,
		);

		expect(html).toContain("No claim readings captured in this span");
		expect(html).not.toContain("<table");
	});
});
