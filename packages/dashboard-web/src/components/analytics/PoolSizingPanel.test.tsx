/**
 * What the pool-sizing panel must say, and what it must never say.
 *
 * The load-bearing assertions are the ones about refusal: a row whose tiers
 * differ has to state that in words rather than showing a verdict the number
 * alone would support, a lower-bound figure has to carry its ≥, and the
 * explanatory prose has to stay inside a `<details>` so the panel opens as
 * numbers rather than as an essay.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	emptyPoolSizingFixture,
	POOL_SIZING_NOW,
	poolSizingFixture,
} from "./__fixtures__/pool-sizing";
import { PoolSizingPanel } from "./PoolSizingPanel";

function render(
	props: Partial<React.ComponentProps<typeof PoolSizingPanel>> = {},
): string {
	return renderToStaticMarkup(<PoolSizingPanel {...props} />);
}

describe("PoolSizingPanel", () => {
	it("renders skeletons while the first read is in flight", () => {
		const html = render({ loading: true });
		expect(html).toContain("Pool sizing");
		expect(html).toContain("animate-pulse");
		expect(html).not.toContain("No weekly usage samples recorded yet.");
	});

	it("states the reason instead of a body when the read failed", () => {
		const html = render({
			unavailableReason: "Pool sizing data is unavailable",
		});
		expect(html).toContain("Pool sizing data is unavailable");
		expect(html).not.toContain("animate-pulse");
		expect(html).not.toContain("How this is computed");
	});

	it("says nothing was recorded rather than drawing an empty table", () => {
		const html = render({ data: emptyPoolSizingFixture() });
		expect(html).toContain("No weekly usage samples recorded yet.");
		expect(html).not.toContain("<table");
	});

	it("renders one row per pool with its verdict and latest completed cycle", () => {
		const html = render({ data: poolSizingFixture() });

		expect(html).toContain("Claude");
		expect(html).toContain("GPT");
		expect(html).toContain("Removal infeasible");
		expect(html).toContain("Removal not established");
		expect(html).toContain("4.79 of 5");
		expect(html).toContain("account-weeks");
	});

	it("names the reason a row's account-weeks are not a comparable unit", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("tiers differ or unknown");
	});

	it("nests the family row under its class with the family label", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("Fable");
		expect(html).toContain("4.66 of 5");
		expect(html.indexOf("Fable")).toBeGreaterThan(html.indexOf("Claude"));
		expect(html.indexOf("Fable")).toBeLessThan(html.indexOf("GPT"));
	});

	it("marks a lower-bound cycle and explains the marker", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("≥ 4.50 of 5");
		expect(html).toContain("lower bound: part of this cycle was not sampled");
	});

	it("shows the running cycle apart from the completed ones", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("In progress");
		expect(html).toContain("1.50 of 5 so far");
	});

	it("keeps rejected attempts visible and separate from terminal stops", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("Rejected attempts");
		expect(html).toContain("Stops");
	});

	it("lists stops that are not capacity evidence in their own block", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("Stops not counted as capacity");
		expect(html).toContain("all_accounts_failed");
		expect(html).toContain("claude-3-opus-retired");
	});

	it("keeps the method behind a collapsed summary, never as page prose", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("How this is computed");

		const summaryIndex = html.indexOf("How this is computed");
		const body = "Deleting an account deletes its usage history";
		const bodyIndex = html.indexOf(body);
		expect(bodyIndex).toBeGreaterThan(summaryIndex);

		// The whole explanation lives inside the LAST <details> opened before it.
		const detailsOpen = html.lastIndexOf("<details", summaryIndex);
		const detailsClose = html.indexOf("</details>", summaryIndex);
		expect(detailsOpen).toBeGreaterThanOrEqual(0);
		expect(bodyIndex).toBeGreaterThan(detailsOpen);
		expect(bodyIndex).toBeLessThan(detailsClose);
		// And it is collapsed: no `open` attribute on that element.
		expect(html.slice(detailsOpen, summaryIndex)).not.toContain("open");
	});

	it("never offers a verdict that an account could be removed", () => {
		const html = render({ data: poolSizingFixture() });
		// The one-sided verdict has exactly two spellings, and neither is a
		// green light.
		expect(html).not.toContain("Removal possible");
		expect(html).not.toContain("Removable");
		// "removable" appears once, in the sentence that rules it out.
		expect(html).toContain("Nothing here ever says an account is removable.");
		expect(html.split("removable")).toHaveLength(2);
	});
});

describe("PoolSizingPanel — an in-progress cycle that opens after now", () => {
	it("shows the running GPT cycle whose window ends in the next ISO week", () => {
		const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
		// Monday 00:00 UTC after POOL_SIZING_NOW (Saturday): the ISO-week cycle a
		// Codex account produces when its open window resets next week. It is the
		// only unfinished cycle the row has, and it starts AFTER `now`.
		const start = Date.UTC(2026, 8, 7);
		const html = render({
			data: {
				...emptyPoolSizingFixture(),
				rows: [
					{
						kind: "class",
						classId: "codex",
						classLabel: "GPT",
						family: null,
						familyLabel: null,
						boundaryRule: "iso_week",
						accountsVoting: 1,
						accountsLocked: 0,
						tierComparable: true,
						verdict: "insufficient_history",
						verdictBasis: null,
						verdictCycles: 0,
						reserveBandCycles: 0,
						terminalStopCycles: 0,
						cycles: [
							{
								start,
								end: start + WEEK_MS,
								resetFrom: start + 3 * 24 * 60 * 60 * 1000,
								resetTo: start + 3 * 24 * 60 * 60 * 1000,
								status: "in_progress",
								accountsInPool: 1,
								accountsObserved: 1,
								consumed: 0.3,
								lowerBound: false,
								removalInfeasible: false,
								verdictBasis: "in_progress",
								reserveBandEntered: false,
								terminalStops: 0,
								rejectedAttempts: 0,
								burstPeakAccounts: null,
								tierLabel: "Pro",
								accounts: [
									{
										accountId: "codex-1",
										accountName: "Codex 1",
										peakPct: 30,
										windows: 1,
										resetAt: start + 3 * 24 * 60 * 60 * 1000,
										effectiveEnd: start + 3 * 24 * 60 * 60 * 1000,
										abandoned: false,
										sampleCount: 120,
										observedThroughEnd: true,
										tierLabel: "Pro",
									},
								],
							},
						],
					},
				],
			},
		});

		expect(html).toContain("0.30 of 1 so far");
	});
});

describe("PoolSizingPanel — separate stops with no sampled pools", () => {
	it("lists stops that are not capacity evidence even when no row has samples", () => {
		const html = render({
			data: {
				...poolSizingFixture(),
				rows: [],
				separateStops: [
					{
						label: "all_accounts_failed",
						model: "gpt-5.2-codex",
						count: 300,
						firstAt: POOL_SIZING_NOW - 1,
						lastAt: POOL_SIZING_NOW,
					},
				],
			},
		});

		expect(html).toContain("Stops not counted as capacity");
	});
});

describe("PoolSizingPanel — an iso_week cycle labelled by its week span", () => {
	it("labels a GPT cycle by its Monday-to-Sunday week, not by where its windows ended", () => {
		const DAY_MS = 24 * 60 * 60 * 1000;
		const WEEK_MS = 7 * DAY_MS;
		// Monday 2026-08-31 00:00 UTC through Monday 2026-09-07 00:00 UTC: one
		// ISO week. The row's single Codex window ended inside it, on Sep 5, so
		// the end-range label collapses to that one day — which names the window,
		// not the cycle this row is boundaried by.
		const start = Date.UTC(2026, 7, 31);
		const windowEnd = Date.UTC(2026, 8, 5, 7);
		const html = render({
			data: {
				...emptyPoolSizingFixture(),
				rows: [
					{
						kind: "class",
						classId: "codex",
						classLabel: "GPT",
						family: null,
						familyLabel: null,
						boundaryRule: "iso_week",
						accountsVoting: 1,
						accountsLocked: 1,
						tierComparable: true,
						verdict: "removal_not_established",
						verdictBasis: "at_or_below_threshold",
						verdictCycles: 1,
						reserveBandCycles: 0,
						terminalStopCycles: 0,
						cycles: [
							{
								start,
								end: start + WEEK_MS,
								resetFrom: windowEnd,
								resetTo: windowEnd,
								status: "completed",
								accountsInPool: 1,
								accountsObserved: 1,
								consumed: 0.9,
								lowerBound: false,
								removalInfeasible: false,
								verdictBasis: "at_or_below_threshold",
								reserveBandEntered: false,
								terminalStops: 0,
								rejectedAttempts: 0,
								burstPeakAccounts: null,
								tierLabel: "Pro",
								accounts: [
									{
										accountId: "codex-1",
										accountName: "Codex 1",
										peakPct: 90,
										windows: 1,
										resetAt: windowEnd,
										effectiveEnd: windowEnd,
										abandoned: false,
										sampleCount: 120,
										observedThroughEnd: true,
										tierLabel: "Pro",
									},
								],
							},
						],
					},
				],
			},
		});

		expect(html).toContain("Aug 31 – Sep 6");
		expect(html).not.toMatch(/>Sep 5</);
	});
});
