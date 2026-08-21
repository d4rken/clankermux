import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RateLimitStatusChip } from "./RateLimitStatusChip";

function render(status: string): string {
	return renderToStaticMarkup(<RateLimitStatusChip status={status} />);
}

describe("RateLimitStatusChip", () => {
	it("renders a human label instead of the raw 'allowed' status", () => {
		const html = render("allowed (242m)");
		expect(html).toContain("Healthy");
		expect(html).not.toContain("allowed");
		// 242 minutes -> 4h 2m
		expect(html).toContain("4h 2m");
	});

	it("maps allowed_warning to a 'Near limit' warning chip", () => {
		const html = render("allowed_warning (602m)");
		expect(html).toContain("Near limit");
		expect(html).not.toContain("allowed_warning");
		// 602 minutes -> 10h 2m
		expect(html).toContain("10h 2m");
		// warning variant uses the light amber tint shared by sibling chips
		expect(html).toContain("bg-amber-100");
	});

	it("maps hard-limit statuses to a destructive chip", () => {
		const html = render("rate_limited (30m)");
		expect(html).toContain("Rate limited");
		expect(html).toContain("bg-destructive/15");
		expect(html).toContain("30m");
	});

	it("includes an explanatory tooltip with reset time", () => {
		const html = render("queueing_hard (15m)");
		expect(html).toContain("Queued");
		expect(html).toContain("Resets in 15m");
	});

	it("renders without a reset suffix when none is present", () => {
		const html = render("blocked");
		expect(html).toContain("Blocked");
		expect(html).not.toContain("·");
	});

	it("formats sub-hour durations as minutes only", () => {
		const html = render("allowed (45m)");
		expect(html).toContain("45m");
		expect(html).not.toContain("h ");
	});

	it("gracefully humanizes an unknown status", () => {
		const html = render("some_new_status (5m)");
		expect(html).toContain("Some New Status");
	});

	it("maps a usage_exhausted status string to an amber 'Usage exhausted' chip", () => {
		const html = render("usage_exhausted (2760m)");
		expect(html).toContain("Usage exhausted");
		expect(html).toContain("bg-amber-100");
		expect(html).toContain("46h");
	});

	it("maps the provider's `rejected` status to a destructive 'Rate limited' chip", () => {
		const html = render("rejected (30m)");
		expect(html).toContain("Rate limited");
		expect(html).toContain("bg-destructive/15");
	});
});

const NOW = 1_750_000_000_000;
const MIN = 60_000;

describe("RateLimitStatusChip — structured cause", () => {
	it("renders 'Usage exhausted' (amber) from the cause, with the cause's countdown", () => {
		const html = renderToStaticMarkup(
			<RateLimitStatusChip
				status="usage_exhausted (1380m)"
				cause="usage_exhausted"
				resetMs={NOW + 90 * MIN}
				providerStatus="rejected"
				now={NOW}
			/>,
		);
		expect(html).toContain("Usage exhausted");
		expect(html).toContain("bg-amber-100");
		// 90 minutes -> 1h 30m, taken from resetMs rather than the string.
		expect(html).toContain("1h 30m");
	});

	it("renders a destructive 'Rate limited' chip for a `rejected` provider status", () => {
		const html = renderToStaticMarkup(
			<RateLimitStatusChip
				status="rate_limited (30m)"
				cause="rate_limited"
				resetMs={NOW + 30 * MIN}
				providerStatus="rejected"
				now={NOW}
			/>,
		);
		expect(html).toContain("Rate limited");
		expect(html).toContain("bg-destructive/15");
		expect(html).toContain("30m");
	});

	it("keeps an unrecognized provider status humanized instead of using the cause", () => {
		const html = renderToStaticMarkup(
			<RateLimitStatusChip
				status="some_new_status (5m)"
				cause="unknown"
				resetMs={null}
				providerStatus="some_new_status"
				now={NOW}
			/>,
		);
		expect(html).toContain("Some New Status");
		expect(html).not.toContain("Unknown status");
		// Never red: an unrecognized status is not evidence of a block.
		expect(html).not.toContain("bg-destructive/15");
	});

	it("falls back to a neutral 'Unknown status' chip when no raw value is available", () => {
		const html = renderToStaticMarkup(
			<RateLimitStatusChip
				status=""
				cause="unknown"
				resetMs={null}
				now={NOW}
			/>,
		);
		expect(html).toContain("Unknown status");
		expect(html).not.toContain("bg-destructive/15");
	});

	it("omits the countdown when the cause has no known reset", () => {
		const html = renderToStaticMarkup(
			<RateLimitStatusChip
				status="usage_exhausted"
				cause="usage_exhausted"
				resetMs={null}
				now={NOW}
			/>,
		);
		expect(html).toContain("Usage exhausted");
		expect(html).not.toContain("·");
	});
});

/**
 * The tooltip used to hard-code "Weekly usage quota is spent", which is simply
 * false for a session-exhausted account — and the difference matters: a session
 * window resets in minutes, a weekly one can take days. The LABEL and the amber
 * variant stay the same in all cases; only the explanation changes.
 */
describe("RateLimitStatusChip — usage_exhausted binding", () => {
	function renderExhausted(binding?: "session" | "weekly" | null): string {
		return renderToStaticMarkup(
			<RateLimitStatusChip
				status="usage_exhausted (13m)"
				cause="usage_exhausted"
				binding={binding}
				resetMs={NOW + 13 * MIN}
				providerStatus="rejected"
				now={NOW}
			/>,
		);
	}

	it("explains a session binding as the 5-hour window", () => {
		const html = renderExhausted("session");
		expect(html).toContain("Usage exhausted");
		expect(html).toContain("bg-amber-100");
		expect(html).toContain("5-hour session quota is spent");
		expect(html).not.toContain("Weekly usage quota");
		// The countdown suffix still composes onto the description.
		expect(html).toContain("Resets in 13m");
	});

	it("explains a weekly binding as the weekly window", () => {
		const html = renderExhausted("weekly");
		expect(html).toContain("Usage exhausted");
		expect(html).toContain("bg-amber-100");
		expect(html).toContain("Weekly usage quota is spent");
		expect(html).not.toContain("5-hour session");
	});

	it("falls back to generic wording when no binding is supplied (older payloads)", () => {
		const html = renderExhausted();
		expect(html).toContain("Usage exhausted");
		expect(html).toContain("A usage quota is spent");
		expect(html).not.toContain("Weekly usage quota");
		expect(html).not.toContain("5-hour session");
	});

	it("uses the generic wording on the string path, which carries no binding", () => {
		const html = renderToStaticMarkup(
			<RateLimitStatusChip status="usage_exhausted (2760m)" />,
		);
		expect(html).toContain("Usage exhausted");
		expect(html).toContain("A usage quota is spent");
	});
});
