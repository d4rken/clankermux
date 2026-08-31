import { describe, expect, it } from "bun:test";
import type { SystemStatusResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TONE } from "../../test-utils/tone";
import { SystemHealthStripView } from "./SystemHealthStrip";

function makeStatus(
	overrides: Partial<SystemStatusResponse> = {},
): SystemStatusResponse {
	return {
		status: "ok",
		uptime_s: 3 * 86400 + 4 * 3600,
		memory: { rss_bytes: 432_013_312, rss_mb: 412 },
		pool: {
			configured: 6,
			routable: 6,
			paused: 0,
			rate_limited: 0,
			usage_exhausted: 0,
			next_available_at: null,
		},
		runtime: {
			asyncWriterHealthy: true,
			integrityStatus: "ok",
			pricingGaps: [],
		},
		eventLoop: { lastLagMs: 0.8, maxLagMs: 12, maxRecentLagMs: 3 },
		strategy: "session",
		timestamp: new Date(1_700_000_000_000).toISOString(),
		...overrides,
	};
}

function render(
	props: Partial<Parameters<typeof SystemHealthStripView>[0]> = {},
): string {
	return renderToStaticMarkup(
		<MemoryRouter>
			<SystemHealthStripView
				status={makeStatus()}
				rssHistoryMb={[400, 405, 412]}
				errorGroupCount={0}
				{...props}
			/>
		</MemoryRouter>,
	);
}

/**
 * Rendered text with the markup stripped, so an assertion about what the strip
 * SAYS cannot be decided by a class name that happens to contain the word.
 */
function textOf(markup: string): string {
	return markup
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** The strip's own link tag — the element whose accessible name is at stake. */
function linkTag(markup: string): string {
	const start = markup.indexOf("<a ");
	if (start === -1) throw new Error("strip link not rendered");
	return markup.slice(start, markup.indexOf(">", start) + 1);
}

describe("SystemHealthStripView", () => {
	it("links to the System Health page", () => {
		expect(render()).toContain('href="/system"');
	});

	it("renders the healthy glance line", () => {
		const html = render();

		expect(html).toContain("All Systems Operational");
		expect(html).toContain("up 3d 4h");
		expect(html).toContain("RSS 412 MB");
		expect(html).toContain("DB verified");
		// "<1 ms" is HTML-escaped in the static markup.
		expect(html).toContain("loop &lt;1 ms");
	});

	it("omits the non-ok explanation while healthy", () => {
		expect(render()).not.toContain("No issues detected");
	});

	it("tints and explains a degraded pool", () => {
		const html = render({
			status: makeStatus({
				status: "degraded",
				pool: {
					configured: 6,
					routable: 0,
					paused: 0,
					rate_limited: 6,
					usage_exhausted: 0,
					next_available_at: null,
				},
			}),
		});

		expect(html).toContain(TONE.warningSurface);
		expect(html).toContain("Degraded");
		expect(html).toContain("All accounts rate-limited");
	});

	it("tints an unhealthy proxy and names the cause", () => {
		const html = render({
			status: makeStatus({
				status: "unhealthy",
				runtime: {
					asyncWriterHealthy: false,
					integrityStatus: "corrupt",
					pricingGaps: [],
				},
			}),
		});

		expect(html).toContain(TONE.destructiveSurface);
		expect(html).toContain("Async DB writer is failing");
		expect(html).toContain("DB corrupt");
	});

	it("escalates a corrupt database even when the server rollup says ok", () => {
		// The server's rollup is computed from the async writer and the pool only,
		// so `ok` + `corrupt` is reachable. Taking it at face value would print a
		// green "All Systems Operational" right next to "DB corrupt".
		const html = render({
			status: makeStatus({
				status: "ok",
				runtime: {
					asyncWriterHealthy: true,
					integrityStatus: "corrupt",
					pricingGaps: [],
				},
			}),
		});

		expect(html).toContain("Database corruption detected");
		expect(html).toContain(TONE.destructiveSurface);
		expect(html).toContain("DB corrupt");
		expect(html).not.toContain("All Systems Operational");
	});

	it("does not escalate a skipped integrity check", () => {
		// A check that couldn't finish is not proven corruption.
		const html = render({
			status: makeStatus({
				runtime: {
					asyncWriterHealthy: true,
					integrityStatus: "skipped",
					pricingGaps: [],
				},
			}),
		});

		expect(html).toContain("All Systems Operational");
		expect(html).toContain("DB check skipped");
		expect(html).not.toContain(TONE.destructiveSurface);
	});

	it("does not repeat the integrity suffix when already unhealthy", () => {
		const html = render({
			status: makeStatus({
				status: "unhealthy",
				runtime: {
					asyncWriterHealthy: false,
					integrityStatus: "corrupt",
					pricingGaps: [],
				},
			}),
		});

		expect(html.match(/DB integrity check failed/g)?.length ?? 0).toBe(1);
	});

	it("keeps the strip's own text in the link's accessible name", () => {
		// An aria-label would replace the content-derived name, not extend it.
		// Asserted on the LINK's own tag: a document-wide check also fails on an
		// aria-label that belongs to some icon inside the strip, where it is
		// harmless and where nothing about this rule applies.
		const html = render();

		expect(linkTag(html)).not.toContain("aria-label");
		expect(textOf(html)).toContain("Open the System Health page");
	});

	it("degrades to a labelled unavailable state without status data", () => {
		const html = render({ status: null, isLoading: false });
		const text = textOf(html);

		expect(text).toContain("Status unavailable");
		expect(text).toContain("Could not reach the proxy status endpoint.");
		// Metric slots need live data — none of them should render placeholders.
		// Asserted on the rendered TEXT, so a class name that happens to contain
		// one of these words can neither pass nor fail it. (The previous form had
		// to be written `>up ` because `gap-x-group ` also ends in "up ".)
		expect(text).not.toContain("RSS");
		expect(text).not.toMatch(/\bup \d/);
		expect(text).not.toContain("loop ");
		expect(text).not.toContain("DB ");
	});

	it("shows a loading label instead of an error before the first fetch", () => {
		const html = render({ status: null, isLoading: true });

		expect(html).toContain("Checking status…");
		expect(html).not.toContain("Could not reach");
	});

	it("hides the error pill when nothing is visible", () => {
		expect(render()).not.toMatch(/\d+ errors?</);
	});

	it("pluralizes the error pill", () => {
		expect(render({ errorGroupCount: 1 })).toMatch(/1 error</);
		expect(render({ errorGroupCount: 3 })).toMatch(/3 errors</);
	});

	it("draws a trend line only when there is history to draw", () => {
		// Keyed on the sparkline's own attribute — every lucide icon is an <svg>
		// too, so a bare "<svg" check would pass either way.
		expect(render()).toContain('preserveAspectRatio="none"');
		expect(render({ rssHistoryMb: [] })).not.toContain(
			'preserveAspectRatio="none"',
		);
	});
});
