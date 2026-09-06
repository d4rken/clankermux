import { describe, expect, it } from "bun:test";
import { type WindowExhaustionInput, windowForecast } from "./capacity-runway";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const input: WindowExhaustionInput = {
	utilizationPct: 13,
	windowStartMs: NOW - 8 * MINUTE,
	resetsAtMs: NOW + 292 * MINUTE,
	prediction: null,
	observedAtMs: NOW,
};

describe("window forecast evidence", () => {
	it("keeps a learning deadline fixed between reads", () => {
		expect(windowForecast(input, NOW)).toEqual({
			state: "learning",
			reason: "short-history",
			readyAtMs: NOW + 52 * MINUTE,
		});
		expect(windowForecast(input, NOW + MINUTE)).toEqual(
			windowForecast(input, NOW),
		);
	});
	it("requires usage rather than promising that time resolves a zero reading", () => {
		expect(windowForecast({ ...input, utilizationPct: 0 }, NOW)).toEqual({
			state: "learning",
			reason: "no-usage",
			readyAtMs: null,
		});
		expect(
			windowForecast({ ...input, utilizationPct: 0, windowStartMs: NOW }, NOW),
		).toEqual({ state: "learning", reason: "unstarted", readyAtMs: null });
	});
	it("counts the hour from a valid credit anchor", () => {
		const anchored = {
			...input,
			lifetimeConfidence: "full" as const,
			windowStartMs: NOW - 180 * MINUTE,
			anchor: {
				anchorMs: NOW - 10 * MINUTE,
				anchorPct: 5,
				windowResetMs: NOW + 292 * MINUTE,
			},
		};
		expect(windowForecast(anchored, NOW)?.state).toBe("learning");
		expect(windowForecast(anchored, NOW)).toMatchObject({
			readyAtMs: NOW + 50 * MINUTE,
		});
	});
	it("keeps a mature weekly forecast while the session is learning", () => {
		expect(windowForecast(input, NOW)?.state).toBe("learning");
		expect(
			windowForecast(
				{
					...input,
					utilizationPct: 47,
					windowStartMs: NOW - 6 * 24 * 60 * MINUTE,
					resetsAtMs: NOW + 24 * 60 * MINUTE,
					lifetimeConfidence: "full",
				},
				NOW,
			),
		).toMatchObject({ state: "projected", lowConfidence: false });
		expect(windowForecast({ ...input, resetsAtMs: NOW - 1 }, NOW)).toBeNull();
	});
});
