/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RateLimitProgress } from "./RateLimitProgress";

describe("RateLimitProgress", () => {
	it("shows the throttling message for Zai tokens_limit windows", () => {
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
				usageUtilization={92}
				usageWindow="tokens_limit"
				usageData={{
					tokens_limit: {
						percentage: 92,
						resetAt: Date.now() + 60 * 60 * 1000,
					},
					time_limit: null,
				}}
				usageThrottledUntil={Date.now() + 10 * 60 * 1000}
				usageThrottledWindows={["tokens_limit"]}
				provider="zai"
				showWeekly
			/>,
		);

		expect(html).toContain(
			"Usage throttling enabled; requests are being delayed",
		);
		expect(html).toContain("Usage (5-hour)");
	});

	describe("weekly window with no reset timestamp", () => {
		const futureFiveHour = () => ({
			utilization: 10,
			resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		});

		it("shows 'Not started yet' / 'No usage this week' when seven_day utilization is 0", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
					usageUtilization={10}
					usageWindow="five_hour"
					usageData={{
						five_hour: futureFiveHour(),
						seven_day: { utilization: 0, resets_at: null },
					}}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain("Not started yet");
			expect(html).toContain("No usage this week");
			expect(html).not.toContain("Data unavailable");
		});

		it("shows 'Not started yet' / 'No usage this week' for seven_day_sonnet with utilization 0", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
					usageUtilization={10}
					usageWindow="five_hour"
					usageData={{
						five_hour: futureFiveHour(),
						seven_day: { utilization: 0, resets_at: null },
						seven_day_sonnet: { utilization: 0, resets_at: null },
					}}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain("Not started yet");
			expect(html).toContain("No usage this week");
			expect(html).not.toContain("Data unavailable");
		});

		it("shows 'Usage data unavailable' when seven_day utilization is null", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
					usageUtilization={10}
					usageWindow="five_hour"
					usageData={{
						five_hour: futureFiveHour(),
						seven_day: { utilization: null, resets_at: null },
					}}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain("Usage data unavailable");
			expect(html).not.toContain("Not started yet");
			expect(html).not.toContain("Data unavailable");
		});

		it("shows neither primed-window phrase when seven_day utilization is positive but reset is missing", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
					usageUtilization={10}
					usageWindow="five_hour"
					usageData={{
						five_hour: futureFiveHour(),
						seven_day: { utilization: 42, resets_at: null },
					}}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).not.toContain("No usage this week");
			expect(html).not.toContain("Not started yet");
			expect(html).not.toContain("Data unavailable");
		});
	});

	describe("secondary weekly windows", () => {
		const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const usageData = () => ({
			five_hour: { utilization: 10, resets_at: future() },
			seven_day: { utilization: 20, resets_at: future() },
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 0,
					resets_at: future(),
					scope: null,
					is_active: false,
				},
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 20,
					resets_at: future(),
					scope: null,
					is_active: false,
				},
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 30,
					resets_at: future(),
					scope: { model: { id: null, display_name: "Opus" }, surface: null },
					is_active: false,
				},
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 5,
					resets_at: future(),
					scope: {
						model: { id: null, display_name: "Sonnet" },
						surface: null,
					},
					is_active: false,
				},
			],
		});

		it("hides the scoped weekly bars when showSecondaryWeekly is false", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future()}
					usageUtilization={10}
					usageWindow="five_hour"
					usageData={usageData()}
					provider="anthropic"
					showWeekly
					showSecondaryWeekly={false}
				/>,
			);

			expect(html).toContain("5-hour");
			expect(html).toContain("Weekly");
			expect(html).not.toContain("Opus");
			expect(html).not.toContain("Sonnet");
		});

		it("shows the scoped weekly bars when showSecondaryWeekly is true", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future()}
					usageUtilization={10}
					usageWindow="five_hour"
					usageData={usageData()}
					provider="anthropic"
					showWeekly
					showSecondaryWeekly
				/>,
			);

			expect(html).toContain("Opus");
			expect(html).toContain("30%");
			expect(html).toContain("Sonnet");
			expect(html).toContain("5%");
		});

		it("shows the scoped weekly bars by default (prop omitted)", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future()}
					usageUtilization={10}
					usageWindow="five_hour"
					usageData={usageData()}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain("Opus");
			expect(html).toContain("Sonnet");
		});

		it("shows a weekly_scoped limit for a model family other than Opus/Sonnet (regression for the Fable bug)", () => {
			const resetsAt = future();
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future()}
					usageUtilization={10}
					usageWindow="five_hour"
					usageData={{
						five_hour: { utilization: 10, resets_at: future() },
						seven_day: { utilization: 20, resets_at: future() },
						limits: [
							{
								kind: "weekly_scoped",
								group: "weekly",
								percent: 69,
								resets_at: resetsAt,
								scope: {
									model: { id: null, display_name: "Fable" },
									surface: null,
								},
								is_active: true,
							},
						],
					}}
					provider="anthropic"
					showWeekly
					showSecondaryWeekly
				/>,
			);

			expect(html).toContain("Fable");
			expect(html).toContain("69%");
		});
	});

	describe("inline projection color", () => {
		// Legacy-path smoke test: no `prediction` prop, so this flows through
		// computeProjectedMessage. 5% used one hour into a five-hour window is
		// *behind* the flat 20% pace, so exhaustion is projected far past the reset
		// and the reassuring "Resets … before exhaustion" line renders green. The
		// legacy path was always internally consistent (safe ⟺ not over-pacing), so
		// this only guards the render wiring — see the prediction-path test below
		// for the actual regression case.
		it("renders a legacy 'before exhaustion' projection green (text-success)", () => {
			const reset = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={reset}
					usageUtilization={5}
					usageWindow="five_hour"
					usageData={{
						five_hour: { utilization: 5, resets_at: reset },
						seven_day: null,
					}}
					provider="anthropic"
					showWeekly
					inlineProjection
				/>,
			);

			expect(html).toContain("before exhaustion");
			expect(html).toContain("text-success");
			expect(html).not.toContain("text-destructive");
		});

		// Regression for the reported bug, which lived ONLY on the server-prediction
		// path: usage is over-pacing (90% at the four-hour mark of a five-hour
		// window, vs an 80% flat pace) — the old code keyed the color off
		// isOverPacing and painted this red — while the regression prediction
		// projects exhaustion (now + 2h) AFTER the reset (now + 1h), i.e. the window
		// resets before it runs out. The line must be green, not red: a safe
		// projection should never render alarming just for being ahead of pace.
		it("renders an over-pacing but safe prediction green, not red", () => {
			const now = Date.now();
			const resetMs = now + 60 * 60 * 1000; // reset in 1h → 4h elapsed, 80% pace
			const reset = new Date(resetMs).toISOString();
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={reset}
					usageUtilization={90}
					usageWindow="five_hour"
					usageData={{
						five_hour: { utilization: 90, resets_at: reset },
						seven_day: null,
					}}
					provider="anthropic"
					showWeekly
					inlineProjection
					prediction={{
						fiveHour: {
							state: "rising",
							slopePerHour: 5,
							etaExhaustMs: now + 2 * 60 * 60 * 1000, // exhausts AFTER the reset
							predictedAtReset: null,
							resetsAtMs: resetMs,
							willExhaustBeforeReset: false,
							lowConfidence: false,
						},
						sevenDay: undefined,
					}}
				/>,
			);

			expect(html).toContain("before exhaustion");
			expect(html).toContain("text-success");
			expect(html).not.toContain("text-destructive");
		});
	});

	it("does not display a throttled-until time past reset for over-100% usage", () => {
		const now = Date.now();
		const resetAt = now + 30 * 1000;
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(resetAt).toISOString()}
				usageUtilization={120}
				usageWindow="five_hour"
				usageData={{
					five_hour: {
						utilization: 120,
						resets_at: new Date(resetAt).toISOString(),
					},
					seven_day: null,
				}}
				usageThrottledUntil={resetAt}
				usageThrottledWindows={["five_hour"]}
				provider="codex"
				showWeekly
			/>,
		);

		expect(html).toContain(
			"Usage throttling enabled; requests are being delayed",
		);
		expect(html).not.toContain("Until");
		expect(html).toContain("Less than 1 minute");
	});

	describe("fallback rate-limit window reset label", () => {
		it("includes the date when the reset is days away (window unknown)", () => {
			const reset = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={reset.toISOString()}
					provider="anthropic"
					showWeekly
				/>,
			);

			const expectedDate = reset.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
			expect(html).toContain("Rate limit window");
			expect(html).toContain(`Resets ${expectedDate} (local)`);
		});

		it("keeps the time-only label when the reset is later today", () => {
			// 1 minute out is on the same local day in any timezone except at the
			// stroke of midnight; accept either format at that boundary.
			const reset = new Date(Date.now() + 60 * 1000);
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={reset.toISOString()}
					provider="anthropic"
					showWeekly
				/>,
			);

			const timeOnly = reset.toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			});
			const withDate = reset.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
			const sameDay = new Date().getDate() === reset.getDate();
			expect(html).toContain(
				sameDay ? `Resets ${timeOnly} (local)` : `Resets ${withDate} (local)`,
			);
		});
	});

	describe("stale usage fallback", () => {
		const staleUsage = () => {
			const reset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
			const asOf = new Date(Date.now() - 2 * 60 * 60 * 1000);
			return {
				info: {
					sevenDayUtilization: 85,
					sevenDayResetIso: reset.toISOString(),
					asOfIso: asOf.toISOString(),
				},
				reset,
				asOf,
			};
		};

		it("renders the last-known weekly window with reset date when live data is gone", () => {
			const { info, reset } = staleUsage();
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={reset.toISOString()}
					usageData={null}
					staleUsage={info}
					provider="anthropic"
					showWeekly
				/>,
			);

			const expectedDate = reset.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
			expect(html).toContain("Usage (Weekly): last known as of");
			expect(html).toContain("85%");
			expect(html).toContain(`Resets ${expectedDate} (local)`);
			expect(html).toContain(
				"Live usage unavailable — showing last known data",
			);
		});

		it("renders even when there is no rate-limit reset at all", () => {
			const { info } = staleUsage();
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={null}
					usageData={null}
					staleUsage={info}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain("Usage (Weekly): last known as of");
		});

		it("prefers live usage data over the stale snapshot", () => {
			const { info } = staleUsage();
			const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future}
					usageData={{
						five_hour: { utilization: 10, resets_at: future },
						seven_day: { utilization: 42, resets_at: future },
					}}
					staleUsage={info}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).not.toContain("last known as of");
			expect(html).toContain("42%");
		});
	});
});
