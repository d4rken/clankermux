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
			seven_day_opus: { utilization: 30, resets_at: future() },
			seven_day_sonnet: { utilization: 5, resets_at: future() },
		});

		it("hides the Opus/Sonnet weekly bars when showSecondaryWeekly is false", () => {
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
			expect(html).not.toContain("Opus (Weekly)");
			expect(html).not.toContain("Sonnet (Weekly)");
		});

		it("shows the Opus/Sonnet weekly bars when showSecondaryWeekly is true", () => {
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

			expect(html).toContain("Opus (Weekly)");
			expect(html).toContain("Sonnet (Weekly)");
		});

		it("shows the Opus/Sonnet weekly bars by default (prop omitted)", () => {
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

			expect(html).toContain("Opus (Weekly)");
			expect(html).toContain("Sonnet (Weekly)");
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
});
