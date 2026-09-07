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
