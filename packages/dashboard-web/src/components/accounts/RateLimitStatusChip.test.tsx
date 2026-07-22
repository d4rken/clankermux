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
		expect(html).toContain("bg-red-100");
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
});
