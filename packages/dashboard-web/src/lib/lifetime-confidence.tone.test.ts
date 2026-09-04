import { describe, expect, it } from "bun:test";
import {
	estimateWindowExhaustion,
	weeklyLifetimeConfidence,
} from "@clankermux/core";
import { earlyExhaustionTone, type ProjectionTone } from "./format-prediction";

/**
 * The half of the lifetime-confidence suite that could NOT move to core with
 * the module: it drives `earlyExhaustionTone` from `./format-prediction`, which
 * is display formatting and stays in the dashboard. The pure cases now live in
 * `packages/core/src/__tests__/lifetime-confidence.test.ts`.
 */

/**
 * The pair in use: the weekly window's full-confidence projection, coloured by
 * the same margin rule the surfaces apply.
 *
 * The fixture sits five seconds of margin above the red threshold (10% of a
 * seven-day window, about 16.8 hours). A now-anchored lifetime ETA slides later
 * by 1 + (100 - pct)/pct per unit of wall clock — 1.25 here — so 30 seconds of
 * ticker eats ~9.5 seconds of margin and drops the projection under the
 * threshold. That is the flicker: two adjacent dashboard ticks disagreeing about
 * red on evidence that never changed.
 */
describe("weekly projection tone stability", () => {
	const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
	const WEEK = 7 * 24 * 60 * 60 * 1000;
	// Elapsed window time at the observation that puts the margin at
	// 0.1 * WEEK + 5s: margin = WEEK - 1.25 * elapsed.
	const ELAPSED_AT_OBSERVATION = 435_452_000;
	const windowStartMs = NOW - ELAPSED_AT_OBSERVATION;
	const resetsAtMs = windowStartMs + WEEK;

	function tone(now: number, observedAtMs: number | null): ProjectionTone {
		const estimate = estimateWindowExhaustion(
			{
				utilizationPct: 80,
				resetsAtMs,
				windowStartMs,
				prediction: null,
				lifetimeConfidence: weeklyLifetimeConfidence("seven_day"),
				observedAtMs,
			},
			now,
		);
		if (estimate.exhaustsAtMs == null) return "neutral";
		if (estimate.exhaustsAtMs >= resetsAtMs) return "safe";
		if (estimate.lowConfidence) return "warning";
		return earlyExhaustionTone(resetsAtMs - estimate.exhaustsAtMs, WEEK);
	}

	it("holds the tone across ticks when the reading has not changed", () => {
		expect(tone(NOW, NOW)).toBe("danger");
		expect(tone(NOW + 30_000, NOW)).toBe("danger");
		expect(tone(NOW + 5 * 60_000, NOW)).toBe("danger");
	});

	// Positive control for the fixture: re-anchoring at every tick — which is what
	// a now-anchored estimate does — flips this exact case within one 30-second
	// dashboard refresh. Without this the test above could pass on a projection
	// that was never near the threshold at all.
	it("would flip within one tick if it re-anchored at render time", () => {
		expect(tone(NOW, NOW)).toBe("danger");
		expect(tone(NOW + 30_000, NOW + 30_000)).toBe("warning");
	});

	it("caps the weekly projection at amber when nothing stamped the reading", () => {
		expect(tone(NOW, null)).toBe("warning");
	});
});
