import { describe, expect, it } from "bun:test";
import type { SystemStatusResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
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

		expect(html).toContain("bg-warning/10");
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

		expect(html).toContain("bg-destructive/10");
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
		expect(html).toContain("bg-destructive/10");
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
		expect(html).not.toContain("bg-destructive/10");
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
		const html = render();

		expect(html).not.toContain("aria-label=");
		expect(html).toContain("Open the System Health page");
	});

	it("degrades to a labelled unavailable state without status data", () => {
		const html = render({ status: null, isLoading: false });

		expect(html).toContain("Status unavailable");
		expect(html).toContain("Could not reach the proxy status endpoint.");
		// Metric slots need live data — none of them should render placeholders.
		expect(html).not.toContain("RSS");
		// `>up ` rather than a bare `up `: the uptime text is rendered directly
		// after the clock icon's </svg>, and a bare "up " also matches inside
		// class attributes (`gap-x-group ` ends with it).
		expect(html).not.toContain(">up ");
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
