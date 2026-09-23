/**
 * Cache warming is off pending re-evaluation, and the dashboard must not be a
 * way to turn it back on. The card stays so the current settings are readable,
 * but every control is disabled and there is no form to submit.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { CacheWarmingResponse } from "../../api";
import { CacheWarmingCard } from "./CacheWarmingCard";

function render(data?: Partial<CacheWarmingResponse>): string {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnMount: false } },
	});
	if (data) {
		queryClient.setQueryData(["cache-warming"], {
			mode: "off",
			minTokens: 100_000,
			enabled: false,
			riskFactor: 0.5,
			bridgeHours: 6,
			maxBridgeHours: 12,
			hoursPerRiskUnit: 12,
			refreshMinutes: 55,
			...data,
		} satisfies CacheWarmingResponse);
	}
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<CacheWarmingCard />
		</QueryClientProvider>,
	);
}

/** Every `<input>`, `<button>` and `<select>` opening tag in the markup. */
function controls(html: string): string[] {
	return html.match(/<(input|button|select)\b[^>]*>/g) ?? [];
}

describe("CacheWarmingCard (locked)", () => {
	it("explains that the settings can only be changed through the management API", () => {
		const html = render({ mode: "off" });
		expect(html).toContain("being re-evaluated");
		expect(html).toContain("management API");
	});

	it("still shows the current settings", () => {
		const html = render({
			mode: "dynamic",
			minTokens: 150_000,
			bridgeHours: 4,
		});
		expect(html).toContain("Only idle-prone, established sessions");
		expect(html).toContain('value="150000"');
		expect(html).toContain('value="4"');
	});

	it("disables the mode selector, both number fields and both Save buttons", () => {
		for (const mode of ["off", "static", "dynamic"] as const) {
			const html = render({ mode });
			const found = controls(html);
			// Mode trigger + two number inputs + two Save buttons, at least.
			expect(found.length).toBeGreaterThanOrEqual(5);
			for (const tag of found) {
				expect(tag).toContain("disabled");
			}
		}
	});

	it("renders no form, so nothing can be submitted from the keyboard", () => {
		expect(render({ mode: "static" })).not.toContain("<form");
	});

	it("stays disabled before the first read lands", () => {
		const found = controls(render());
		expect(found.length).toBeGreaterThanOrEqual(5);
		for (const tag of found) {
			expect(tag).toContain("disabled");
		}
	});
});
