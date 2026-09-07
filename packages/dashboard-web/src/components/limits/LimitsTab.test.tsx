import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { queryKeys } from "../../lib/query-keys";
import { LimitsTab } from "./LimitsTab";

function client() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnMount: false, retryOnMount: false },
		},
	});
}
function render(c: QueryClient, path = "/limits") {
	return renderToStaticMarkup(
		<MemoryRouter initialEntries={[path]}>
			<QueryClientProvider client={c}>
				<LimitsTab />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}
const a = {
	id: "a",
	name: "Claud1",
	provider: "anthropic",
	rateLimitCause: "ok",
	usageData: {
		seven_day: {
			utilization: 25,
			resets_at: new Date(Date.now() + 86400000).toISOString(),
		},
		limits: [
			{
				kind: "weekly_scoped",
				percent: 40,
				resets_at: new Date(Date.now() + 86400000).toISOString(),
				scope: { model: { display_name: "Fable", id: "fable" } },
			},
		],
	},
} as AccountResponse;
describe("focused Usage page", () => {
	it("uses the shared remaining summary and removes billing and competing quota panels", () => {
		const c = client();
		c.setQueryData(queryKeys.accounts(), [a]);
		const html = render(c);
		expect(html).toContain("Remaining quota");
		expect(html).toContain("75%");
		expect(html).toContain("Usage history");
		expect(html).toContain("Weekly left");
		expect(html).not.toContain("Payments");
		expect(html).not.toContain("Account Performance");
		expect(html).not.toContain("lowest ·");
		expect(html).not.toContain("Quota runway");
		expect(html).toContain("Show forecast");
		expect(html).not.toContain('checked=""');
		expect(
			c
				.getQueryCache()
				.getAll()
				.some(
					(q) =>
						q.queryKey[1] === "analytics" ||
						q.queryKey[1] === "payments-summary",
				),
		).toBe(false);
	});
	it("opens the provider/model chosen on Overview", () => {
		const c = client();
		c.setQueryData(queryKeys.accounts(), [a]);
		const html = render(c, "/limits?provider=anthropic&model=fable");
		expect(html).toContain('<option value="fable" selected="">Fable</option>');
		expect(html).toContain("Fable accounts");
		expect(html).toContain("60%");
	});
	it("shows missing history explicitly without hiding account details", () => {
		const c = client();
		c.setQueryData(queryKeys.accounts(), [a]);
		c.getQueryCache()
			.build(c, { queryKey: queryKeys.usageHistory("7d") })
			.setState({
				status: "error",
				error: new Error("failed"),
				fetchStatus: "idle",
				data: undefined,
			});
		const html = render(c);
		expect(html).toContain("Usage history unavailable");
		expect(html).toContain("Claud1");
	});
	it("does not interpret missing accounts as an empty provider pool", () => {
		const html = render(client());
		expect(html).not.toContain("No accounts configured");
		expect(html).not.toContain("0% remaining");
	});
});

it("opens forecast review links with the projection enabled", () => {
	const c = client();
	c.setQueryData(queryKeys.accounts(), [a]);
	const html = render(c, "/limits?provider=anthropic&forecast=1#forecast");
	expect(html).toContain('checked=""');
	expect(html).toContain("Dashed lines assume the current pace continues");
});
