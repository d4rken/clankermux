import { describe, expect, it } from "bun:test";
import type { AccountResponse, RunwayResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { queryKeys } from "../lib/query-keys";
import { OverviewTab } from "./OverviewTab";

function client() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnMount: false, retryOnMount: false },
		},
	});
}
function render(c: QueryClient) {
	return renderToStaticMarkup(
		<MemoryRouter>
			<QueryClientProvider client={c}>
				<OverviewTab />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}
function account(name: string, used: number): AccountResponse {
	return {
		id: name,
		name,
		provider: "anthropic",
		rateLimitCause: "ok",
		usageData: {
			seven_day: {
				utilization: used,
				resets_at: new Date(Date.now() + 86400000).toISOString(),
			},
			five_hour: { utilization: 10, resets_at: null },
		},
	} as AccountResponse;
}
describe("Overview hierarchy and progressive data", () => {
	it("puts capacity before live activity without waiting for other data", () => {
		const c = client();
		const html = render(c);
		expect(html).toContain("Live Activity");
		expect(html.indexOf("Remaining quota")).toBeLessThan(
			html.indexOf("Live Activity"),
		);
		expect(html).not.toContain("lowest ·");
		expect(html).not.toContain("% remaining");
		expect(
			c
				.getQueryCache()
				.getAll()
				.some((q) => q.queryKey[1] === "analytics"),
		).toBe(false);
	});
	it("shows remaining quota across the whole provider with links into Usage", () => {
		const c = client();
		c.setQueryData(queryKeys.accounts(), [account("a", 20), account("b", 80)]);
		const html = render(c);
		expect(html).toContain("50%");
		expect(html).toContain("2 of 2 accounts");
		expect(html).toContain("/limits?provider=anthropic");
		expect(html).not.toContain("lowest ·");
		expect(html).toContain("Account breakdown");
	});
	it("distinguishes failed reads from empty capacity", () => {
		const c = client();
		c.getQueryCache()
			.build(c, { queryKey: queryKeys.accounts() })
			.setState({
				status: "error",
				error: new Error("failed"),
				fetchStatus: "idle",
				data: undefined,
			});
		const html = render(c);
		expect(html).toContain("Account data unavailable");
		expect(html).not.toContain("No accounts configured");
		expect(html).toContain("Live Activity");
	});
	it("keeps a service-level forecast readable if accounts fail", () => {
		const c = client();
		c.setQueryData(queryKeys.runway(), {
			keys: [
				{
					keyId: "key",
					keyName: "Production",
					isActive: true,
					outcome: { kind: "runway", exhaustsAtMs: Date.now() + 86400000 },
				},
			],
		} as RunwayResponse);
		const html = render(c);
		expect(html).toContain("access through Production may run out");
		expect(html).toContain("Review forecast");
	});
	it("keeps all-blocked provider quota visible without duplicate model alerts", () => {
		const c = client();
		const a = account("a", 20);
		a.paused = true;
		a.usageData = {
			...a.usageData,
			limits: [
				{
					kind: "weekly_scoped",
					percent: 30,
					resets_at: new Date(Date.now() + 86400000).toISOString(),
					scope: { model: { display_name: "Fable" } },
				},
			],
		} as AccountResponse["usageData"];
		c.setQueryData(queryKeys.accounts(), [a]);
		const html = render(c);
		expect(html).toContain("80%");
		expect(html).toContain("Fable");
		expect(html.match(/no account currently available/g)).toHaveLength(1);
	});
});
