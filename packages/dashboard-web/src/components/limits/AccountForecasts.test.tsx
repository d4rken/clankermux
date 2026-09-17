import { expect, it } from "bun:test";
import type { RunwayWindowSummary } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { windowForecastMessage } from "../../lib/window-forecast-display";
import { AccountForecasts } from "./AccountForecasts";

const NOW = 1_800_000_000_000;
const session: RunwayWindowSummary = {
	kind: "five_hour",
	utilizationPct: 13,
	resetsAtMs: NOW + 5 * 3_600_000,
	prediction: null,
	forecast: {
		state: "learning",
		reason: "short-history",
		readyAtMs: NOW + 52 * 60_000,
	},
};

it("shows a usable weekly forecast beside the reason a session is learning", () => {
	const html = renderToStaticMarkup(
		<AccountForecasts
			now={NOW}
			accounts={[
				{
					id: "a",
					name: "Claude-5",
					windows: [
						session,
						{
							...session,
							kind: "seven_day",
							utilizationPct: 47,
							forecast: {
								state: "projected",
								exhaustsAtMs: NOW + 2 * 3_600_000,
								lowConfidence: false,
							},
						},
					],
				},
			]}
		/>,
	);
	expect(html).toContain("52m remaining, then a fresh reading");
	expect(html).toContain("Runs out in 2h");
	expect(html).toContain("combined account runway unknown");
});

it("does not promote a cached forecast when its learning deadline or reset passes", () => {
	expect(windowForecastMessage(session, NOW + 3_600_000)).toBe(
		"Learning — waiting for a fresh reading",
	);
	expect(windowForecastMessage(session, NOW + 6 * 3_600_000)).toBe(
		"Window reset — waiting for a fresh reading",
	);
});

it("distinguishes a zero reading from a missing reading", () => {
	expect(
		windowForecastMessage(
			{
				...session,
				forecast: { state: "learning", reason: "no-usage", readyAtMs: null },
			},
			NOW,
		),
	).toBe("Waiting for nonzero usage");
	expect(windowForecastMessage({ ...session, forecast: null }, NOW)).toContain(
		"no usable reading",
	);
});

it("gives a daily window its own column instead of dropping it", () => {
	// Devin's short window is a calendar day. With the columns fixed at 5-hour
	// and weekly, this row would show only the comfortable weekly forecast and
	// silently omit the day it has already spent.
	const html = renderToStaticMarkup(
		<AccountForecasts
			now={NOW}
			accounts={[
				{
					id: "devin-1",
					name: "Devin-1",
					windows: [
						{
							...session,
							kind: "daily",
							utilizationPct: 100,
							resetsAtMs: NOW + 6 * 3_600_000,
							forecast: {
								state: "projected",
								exhaustsAtMs: NOW,
								lowConfidence: false,
							},
						},
						{
							...session,
							kind: "seven_day",
							utilizationPct: 20,
							forecast: {
								state: "projected",
								exhaustsAtMs: NOW + 5 * 24 * 3_600_000,
								lowConfidence: false,
							},
						},
					],
				},
			]}
		/>,
	);
	expect(html).toContain("daily forecast");
	expect(html).toContain("weekly forecast");
	// No 5-hour column: nothing listed reports one, so it is left out rather
	// than printed as a column of "Not reported".
	expect(html).not.toContain("5-hour forecast");
});

it("keeps one column set across accounts that report different windows", () => {
	const html = renderToStaticMarkup(
		<AccountForecasts
			now={NOW}
			accounts={[
				{ id: "a", name: "Claude-5", windows: [session] },
				{
					id: "devin-1",
					name: "Devin-1",
					windows: [{ ...session, kind: "daily" }],
				},
			]}
		/>,
	);
	// Shortest first, so a row reads from the constraint that bites soonest.
	expect(html.indexOf("5-hour forecast")).toBeLessThan(
		html.indexOf("daily forecast"),
	);
	// The account that reports neither column still gets a cell in each.
	expect(html).toContain("Not reported");
});
