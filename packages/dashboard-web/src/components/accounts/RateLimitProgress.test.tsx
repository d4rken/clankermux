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
		expect(html).toContain("5-hour");
	});

	describe("weekly window with no reset timestamp", () => {
		const futureFiveHour = () => ({
			utilization: 10,
			resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		});

		it("shows 'Not started yet' when seven_day utilization is 0", () => {
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
			expect(html).not.toContain("Data unavailable");
		});

		it("shows 'Not started yet' for seven_day_sonnet with utilization 0", () => {
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

		it("always shows the scoped weekly bars", () => {
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
			expect(html).toContain("30%");
			expect(html).toContain("Sonnet");
			expect(html).toContain("5%");
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
				/>,
			);

			expect(html).toContain("Fable");
			expect(html).toContain("69%");
		});

		it("gives primary and secondary family windows different card tints", () => {
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

			// Primary 5-hour/weekly cards are filled; the scoped model-family
			// cards (Opus/Sonnet) are left unfilled (outline only).
			expect(html).toContain("bg-muted/50");
			expect(html).toContain("bg-transparent");
		});
	});

	describe("5-hour card 0-vs-null contract", () => {
		const future = () =>
			new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

		it("hides the 5-hour card when Codex reports five_hour: null (retired window) but keeps the weekly card", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={null}
					usageWindow="seven_day"
					usageData={{
						five_hour: null,
						seven_day: { utilization: 21, resets_at: future() },
					}}
					provider="codex"
					showWeekly
				/>,
			);

			expect(html).not.toContain("5-hour");
			expect(html).toContain("Weekly");
			expect(html).toContain("21%");
		});

		it("still renders an Anthropic 5-hour window at 0% when it carries a real reset", () => {
			const reset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={reset}
					usageUtilization={0}
					usageWindow="five_hour"
					usageData={{
						five_hour: { utilization: 0, resets_at: reset },
						seven_day: { utilization: 20, resets_at: reset },
					}}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain("5-hour");
		});

		it("renders a real Anthropic 5-hour window at 0% with a null reset (idle-but-live window must show)", () => {
			// Regression: an idle Anthropic account (0% 5h, null reset) carries a REAL
			// window that is byte-identical to Codex's retired placeholder — the old
			// shape-based suppression wrongly hid it. The 0-vs-null contract keeps it.
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={null}
					usageUtilization={0}
					usageWindow="five_hour"
					usageData={{
						five_hour: { utilization: 0, resets_at: null },
						seven_day: { utilization: 20, resets_at: future() },
					}}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain("5-hour");
		});

		it("renders a Codex scoped weekly (Spark) secondary card even when the 5-hour window is null", () => {
			const reset = future();
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={null}
					usageWindow="seven_day"
					usageData={{
						five_hour: null,
						seven_day: { utilization: 21, resets_at: reset },
						limits: [
							{
								kind: "weekly_scoped",
								group: "codex",
								percent: 0,
								resets_at: reset,
								scope: {
									model: {
										id: "GPT-5.3-Codex-Spark",
										display_name: "GPT-5.3-Codex-Spark",
									},
									surface: null,
								},
								is_active: true,
							},
						],
					}}
					provider="codex"
					showWeekly
				/>,
			);

			expect(html).not.toContain("5-hour");
			expect(html).toContain("GPT-5.3-Codex-Spark");
		});
	});

	describe("caption reset status", () => {
		it("shows a 24-hour reset time with the remaining time in brackets and no AM/PM", () => {
			const reset = new Date(Date.now() + 2 * 60 * 60 * 1000 + 30 * 60 * 1000);
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={reset.toISOString()}
					usageUtilization={40}
					usageWindow="five_hour"
					usageData={{
						five_hour: { utilization: 40, resets_at: reset.toISOString() },
						seven_day: null,
					}}
					provider="anthropic"
					showWeekly
				/>,
			);

			// Time remaining rendered in brackets (largest units first)...
			expect(html).toContain("(2h ");
			// ...and the absolute reset time uses a 24-hour clock, never AM/PM.
			expect(html).not.toContain("AM");
			expect(html).not.toContain("PM");
		});

		it("shows days for a multi-day reset", () => {
			const reset = new Date(
				Date.now() + 4 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000,
			);
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={reset.toISOString()}
					usageUtilization={20}
					usageWindow="five_hour"
					usageData={{
						five_hour: { utilization: 20, resets_at: reset.toISOString() },
						seven_day: null,
					}}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain("(4d ");
		});
	});

	describe("inline projection color", () => {
		// Legacy-path smoke test: no `prediction` prop, so this flows through
		// computeProjectedMessage. 5% used one hour into a five-hour window is
		// *behind* the flat 20% pace, so exhaustion is projected far past the reset
		// and the reassuring "on track" line renders green. The safe case is stated
		// qualitatively (no unbounded "resets N hours before exhaustion" number). The
		// legacy path was always internally consistent (safe ⟺ not over-pacing), so
		// this only guards the render wiring — see the prediction-path test below
		// for the actual regression case.
		it("renders a legacy safe projection green (text-success)", () => {
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

			expect(html).toContain("On track to reset before running out");
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

			expect(html).toContain("On track to reset before running out");
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
				hour12: false,
			});
			expect(html).toContain("Rate limit");
			expect(html).toContain(`Resets ${expectedDate}`);
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
				hour12: false,
			});
			const withDate = reset.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
			const sameDay = new Date().getDate() === reset.getDate();
			expect(html).toContain(
				sameDay ? `Resets ${timeOnly}` : `Resets ${withDate}`,
			);
		});
	});

	describe("stale usage fallback", () => {
		const staleUsage = () => {
			const reset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
			const asOf = new Date(Date.now() - 2 * 60 * 60 * 1000);
			return {
				info: {
					sevenDay: { utilization: 85, resetIso: reset.toISOString() },
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
				hour12: false,
			});
			expect(html).toContain("Weekly: last known as of");
			expect(html).toContain("85%");
			expect(html).toContain(`Resets ${expectedDate}`);
			expect(html).toContain(
				"Live usage unavailable — showing last known data",
			);
		});

		it("renders a last-known 5-hour window alongside the weekly window", () => {
			const fiveReset = new Date(Date.now() + 90 * 60 * 1000);
			const sevenReset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
			const asOf = new Date(Date.now() - 60 * 1000);
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={null}
					usageData={null}
					staleUsage={{
						fiveHour: { utilization: 42, resetIso: fiveReset.toISOString() },
						sevenDay: { utilization: 85, resetIso: sevenReset.toISOString() },
						asOfIso: asOf.toISOString(),
					}}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain("5h: last known as of");
			expect(html).toContain("42%");
			expect(html).toContain("Weekly: last known as of");
			expect(html).toContain("85%");
		});

		it("renders a 5h-only stale reading when the weekly window is absent", () => {
			const fiveReset = new Date(Date.now() + 90 * 60 * 1000);
			const asOf = new Date(Date.now() - 60 * 1000);
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={null}
					usageData={null}
					staleUsage={{
						fiveHour: { utilization: 42, resetIso: fiveReset.toISOString() },
						asOfIso: asOf.toISOString(),
					}}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain("5h: last known as of");
			expect(html).toContain("42%");
			expect(html).not.toContain("Weekly: last known as of");
		});

		it("shows the persisted stale fallback even when the usage API is rate limited", () => {
			const { info } = staleUsage();
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={null}
					usageData={null}
					staleUsage={info}
					usageRateLimitedUntil={Date.now() + 60 * 1000}
					provider="anthropic"
					showWeekly
				/>,
			);

			// The stale block wins over the bare "Rate limited" branch, and carries
			// its own rate-limited note.
			expect(html).toContain("Weekly: last known as of");
			expect(html).toContain("85%");
			expect(html).toContain(
				"Usage API rate limited — showing last known data",
			);
			expect(html).not.toContain("usage data unavailable");
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

			expect(html).toContain("Weekly: last known as of");
		});

		// Data that is 11 minutes old is not "unavailable" — it is live data with an
		// honest age. The amber warning is reserved for genuinely absent data.
		describe("aging live usage", () => {
			const liveWindows = () => {
				const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
				return {
					five_hour: { utilization: 10, resets_at: future },
					seven_day: { utilization: 42, resets_at: future },
				};
			};

			it("annotates the live bars with an 'as of' time once past the routing TTL", () => {
				const asOf = new Date(Date.now() - 11 * 60 * 1000);
				const html = renderToStaticMarkup(
					<RateLimitProgress
						resetIso={null}
						usageData={liveWindows()}
						usageAsOfIso={asOf.toISOString()}
						provider="anthropic"
						showWeekly
					/>,
				);

				expect(html).toContain("Live usage as of");
				// The real bars are still rendered, not the amber fallback.
				expect(html).toContain("42%");
				expect(html).not.toContain(
					"Live usage unavailable — showing last known data",
				);
			});

			it("does not annotate a reading that is still within the routing TTL", () => {
				const asOf = new Date(Date.now() - 2 * 60 * 1000);
				const html = renderToStaticMarkup(
					<RateLimitProgress
						resetIso={null}
						usageData={liveWindows()}
						usageAsOfIso={asOf.toISOString()}
						provider="anthropic"
						showWeekly
					/>,
				);

				expect(html).not.toContain("Live usage as of");
				expect(html).toContain("42%");
			});

			it("does not annotate when the server sent no as-of timestamp", () => {
				const html = renderToStaticMarkup(
					<RateLimitProgress
						resetIso={null}
						usageData={liveWindows()}
						provider="anthropic"
						showWeekly
					/>,
				);

				expect(html).not.toContain("Live usage as of");
			});

			// The Kilo credits card returns before the window grid is built, so it
			// needs the disclosure applied on its own path — a balance served from a
			// 20-minute-old cache entry must not read as a current balance.
			it("discloses the age on an aged Kilo credit balance", () => {
				const html = renderToStaticMarkup(
					<RateLimitProgress
						resetIso={null}
						usageData={{
							remainingUsd: 12.5,
							totalMicrodollarsAcquired: 50_000_000,
						}}
						usageAsOfIso={new Date(Date.now() - 20 * 60 * 1000).toISOString()}
						provider="kilo"
					/>,
				);

				expect(html).toContain("$12.50 remaining");
				expect(html).toContain("Live usage as of");
			});

			it("does not annotate a fresh Kilo credit balance", () => {
				const html = renderToStaticMarkup(
					<RateLimitProgress
						resetIso={null}
						usageData={{
							remainingUsd: 12.5,
							totalMicrodollarsAcquired: 50_000_000,
						}}
						usageAsOfIso={new Date(Date.now() - 60 * 1000).toISOString()}
						provider="kilo"
					/>,
				);

				expect(html).toContain("$12.50 remaining");
				expect(html).not.toContain("Live usage as of");
			});

			it("still shows the amber fallback when there is genuinely no live data", () => {
				const { info } = staleUsage();
				const html = renderToStaticMarkup(
					<RateLimitProgress
						resetIso={null}
						usageData={null}
						staleUsage={info}
						usageAsOfIso={new Date(Date.now() - 11 * 60 * 1000).toISOString()}
						provider="anthropic"
						showWeekly
					/>,
				);

				expect(html).toContain(
					"Live usage unavailable — showing last known data",
				);
				expect(html).not.toContain("Live usage as of");
			});

			it("keeps the rate-limited wording when the usage API is 429ing", () => {
				const { info } = staleUsage();
				const html = renderToStaticMarkup(
					<RateLimitProgress
						resetIso={null}
						usageData={null}
						staleUsage={info}
						usageRateLimitedUntil={Date.now() + 60 * 1000}
						provider="anthropic"
						showWeekly
					/>,
				);

				expect(html).toContain(
					"Usage API rate limited — showing last known data",
				);
				expect(html).not.toContain(
					"Live usage unavailable — showing last known data",
				);
			});
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
	describe("compact layout", () => {
		const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const anthropicUsage = () => ({
			five_hour: { utilization: 12, resets_at: future() },
			seven_day: { utilization: 42, resets_at: future() },
		});

		it("keeps the two-column wrapping grid by default", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future()}
					usageData={anthropicUsage()}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain("sm:grid-cols-2");
			expect(html).not.toContain("xl:grid-flow-col");
			// Default card padding stays roomy.
			expect(html).toContain("rounded-lg border p-3");
		});

		it("flows every window card into one row and tightens padding when compact", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future()}
					usageData={anthropicUsage()}
					provider="anthropic"
					showWeekly
					compact
				/>,
			);

			expect(html).toContain("xl:grid-flow-col");
			expect(html).toContain("xl:auto-cols-fr");
			expect(html).toContain("xl:grid-cols-none");
			expect(html).toContain("rounded-lg border p-2");
			expect(html).not.toContain("rounded-lg border p-3");
		});

		it("leads the caption with the countdown so truncation eats the date", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future()}
					usageData={anthropicUsage()}
					provider="anthropic"
					showWeekly
					compact
				/>,
			);

			// A fifth-of-a-row card truncates the centre caption, so the visible
			// text puts the time-remaining first and the absolute stamp second.
			expect(html).toMatch(/>\d+[hm] \d*[m]? ?· /);
			expect(html).not.toMatch(/>Resets /);
			// …and the untruncated sentence survives as a native tooltip.
			expect(html).toMatch(/title="Resets [^"]+\(\d+[dhm][^"]*\)"/);
		});

		it("leaves the default caption wording untouched", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future()}
					usageData={anthropicUsage()}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toMatch(/>Resets [^<]+\(\d+[dhm][^<]*\)</);
		});

		it("lets a long window label truncate instead of overflowing the card", () => {
			// Codex's synthetic per-model weekly windows carry the full model name,
			// which cannot fit beside a percentage in a fifth-of-a-row card. Only
			// the centre caption can absorb a squeeze, so a `shrink-0` label would
			// push the row past the card edge.
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future()}
					usageData={{
						...anthropicUsage(),
						limits: [
							{
								kind: "weekly_scoped",
								percent: 63,
								resets_at: future(),
								scope: {
									model: {
										id: "gpt-5.3-codex-spark",
										display_name: "GPT-5.3-Codex-Spark",
									},
								},
							},
						],
					}}
					provider="anthropic"
					showWeekly
					compact
				/>,
			);

			// Anchored on the label text so the assertion is about that span, not
			// the percentage span (which stays `shrink-0` in both modes).
			expect(html).toContain(
				'<span class="text-muted-foreground min-w-0 shrink truncate" title="GPT-5.3-Codex-Spark">GPT-5.3-Codex-Spark</span>',
			);
		});

		it("keeps the label unshrinkable in the roomy default layout", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future()}
					usageData={anthropicUsage()}
					provider="anthropic"
					showWeekly
				/>,
			);

			expect(html).toContain(
				'<span class="text-muted-foreground shrink-0">Weekly</span>',
			);
			expect(html).not.toContain("min-w-0 shrink truncate");
		});

		it("renders every window as its own card in compact mode", () => {
			const html = renderToStaticMarkup(
				<RateLimitProgress
					resetIso={future()}
					usageData={{
						...anthropicUsage(),
						limits: [
							{
								kind: "weekly_scoped",
								percent: 63,
								resets_at: future(),
								scope: { model: { id: "fable", display_name: "Fable" } },
							},
						],
					}}
					provider="anthropic"
					showWeekly
					compact
				/>,
			);

			expect(html).toContain("5-hour");
			expect(html).toContain("Weekly");
			expect(html).toContain("Fable");
			expect((html.match(/rounded-lg border p-2/g) ?? []).length).toBe(3);
		});
	});
});
