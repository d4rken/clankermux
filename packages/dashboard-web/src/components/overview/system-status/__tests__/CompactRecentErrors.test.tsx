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

function render(
	errors: RecentErrorGroup[],
	extra: { staleNote?: string; unavailable?: boolean } = {},
): string {
	return renderToStaticMarkup(
		<MemoryRouter>
			<CompactRecentErrors
				errors={errors}
				accounts={[]}
				onDismiss={() => {}}
				onDismissAll={() => {}}
				staleNote={extra.staleNote}
				unavailable={extra.unavailable}
			/>
		</MemoryRouter>,
	);
}

describe("CompactRecentErrors", () => {
	it("renders nothing when a successful read reported no visible errors", () => {
		expect(render([])).toBe("");
	});

	it("links to the full list on the System Health page", () => {
		const html = render([makeError()]);

		expect(html).toContain('href="/system"');
		expect(html).toContain("View all");
		expect(html).toContain("Last hour");
	});

	it("offers a clear-all control alongside the link", () => {
		const html = render([makeError()]);

		expect(html).toContain("Clear all");
	});

	/**
	 * The control clears the whole hour, not the three rows on screen, so the
	 * label has to count the groups the card is hiding as well.
	 */
	it("counts the overflow groups in the clear-all label", () => {
		const errors = Array.from({ length: 5 }, (_, i) =>
			makeError({ accountId: `a${i}`, latestRequestId: `req-${i}` }),
		);

		expect(render(errors)).toContain(
			'aria-label="Dismiss all 5 recent error groups"',
		);
	});

	it("singularizes the clear-all label", () => {
		expect(render([makeError()])).toContain(
			'aria-label="Dismiss all 1 recent error group"',
		);
	});

	it("omits the clear-all control when there is nothing to clear", () => {
		expect(render([], { staleNote: "Last updated 12m ago" })).not.toContain(
			"Clear all",
		);
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

	it("labels a non-empty list whose latest refresh failed", () => {
		const html = render([makeError()], { staleNote: "Last updated 4m ago" });

		expect(html).toContain("Last updated 4m ago");
		expect(html).toContain("acct-one");
	});

	/**
	 * An empty list rendered as nothing is read as "no errors right now". That is
	 * only true when the read that produced it SUCCEEDED — otherwise the page is
	 * asserting a confirmed-clean state it cannot see.
	 */
	it("still reports the stale read when the cached list is empty", () => {
		const html = render([], { staleNote: "Last updated 12m ago" });

		expect(html).not.toBe("");
		expect(html).toContain("No errors in the last successful update");
		expect(html).toContain("Last updated 12m ago");
	});

	it("prefers the unavailable card over the stale note", () => {
		const html = render([], {
			unavailable: true,
			staleNote: "Last updated 12m ago",
		});

		expect(html).toContain("Recent errors unavailable");
		expect(html).not.toContain("No errors in the last successful update");
	});
});
