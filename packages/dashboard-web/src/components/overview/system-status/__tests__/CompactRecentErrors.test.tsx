import { describe, expect, it } from "bun:test";
import type { RecentErrorGroup } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { CompactRecentErrors } from "../CompactRecentErrors";

const NOW = 1_750_000_000_000;

function makeError(
	overrides: Partial<RecentErrorGroup> = {},
): RecentErrorGroup {
	return {
		errorCode: "rate_limited",
		accountId: "a1",
		accountName: "acct-one",
		provider: "anthropic",
		occurrenceCount: 12,
		latestTimestamp: NOW,
		firstTimestamp: NOW - 60_000,
		latestRequestId: "req-1",
		model: "claude-opus-5",
		statusCode: 429,
		path: "/v1/messages",
		failoverAttempts: 1,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		...overrides,
	};
}

function render(errors: RecentErrorGroup[]): string {
	return renderToStaticMarkup(
		<MemoryRouter>
			<CompactRecentErrors errors={errors} accounts={[]} onDismiss={() => {}} />
		</MemoryRouter>,
	);
}

describe("CompactRecentErrors", () => {
	it("renders nothing when there are no visible errors", () => {
		expect(render([])).toBe("");
	});

	it("links to the full list on the System Health page", () => {
		const html = render([makeError()]);

		expect(html).toContain('href="/system"');
		expect(html).toContain("View all");
		expect(html).toContain("Last hour");
	});

	it("caps the list at three rows", () => {
		const errors = Array.from({ length: 5 }, (_, i) =>
			makeError({
				accountId: `a${i}`,
				accountName: `acct-${i}`,
				latestRequestId: `req-${i}`,
			}),
		);

		const html = render(errors);

		expect(html).toContain("acct-0");
		expect(html).toContain("acct-2");
		expect(html).not.toContain("acct-3");
		expect(html).not.toContain("acct-4");
	});

	it("reports how many groups were left off", () => {
		const errors = Array.from({ length: 5 }, (_, i) =>
			makeError({ accountId: `a${i}`, latestRequestId: `req-${i}` }),
		);

		expect(render(errors)).toContain("+2 more error groups in the last hour");
	});

	it("singularizes the overflow line", () => {
		const errors = Array.from({ length: 4 }, (_, i) =>
			makeError({ accountId: `a${i}`, latestRequestId: `req-${i}` }),
		);

		expect(render(errors)).toContain("+1 more error group in the last hour");
	});

	it("omits the overflow line when everything fits", () => {
		expect(render([makeError()])).not.toContain("more error");
	});
});
