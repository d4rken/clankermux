import { describe, expect, it } from "bun:test";
import type { StopsHistoryResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { StopsHistoryCard } from "./StopsHistoryCard";

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const HOUR = 60 * 60_000;

function response(
	over: Partial<StopsHistoryResponse> = {},
): StopsHistoryResponse {
	return {
		range: "6h",
		bucketMs: HOUR,
		windowStartsAt: NOW - 6 * HOUR,
		windowEndsAt: NOW,
		totalRequests: 1000,
		blockedRequests: 12,
		causes: [
			{
				cause: "pool_quota_exhausted",
				count: 9,
				firstSeenMs: NOW - 5 * HOUR,
				lastSeenMs: NOW - 2 * HOUR,
				topRequestedModel: "gpt-5.2-codex",
				topRequestedModelCount: 300,
				sampleErrorMessage: "all_accounts_failed",
				series: [
					{ ts: NOW - 2 * HOUR, count: 9 },
					{ ts: NOW - HOUR, count: 0 },
				],
			},
			{
				cause: "model_not_served",
				count: 3,
				firstSeenMs: NOW - 3 * HOUR,
				lastSeenMs: NOW - HOUR,
				topRequestedModel: null,
				topRequestedModelCount: 0,
				sampleErrorMessage: null,
				series: [
					{ ts: NOW - 2 * HOUR, count: 0 },
					{ ts: NOW - HOUR, count: 3 },
				],
			},
		],
		candidates: {
			observedRequests: 800,
			zeroCandidateRequests: 4,
			distribution: [
				{ candidatesCount: 0, requests: 4 },
				{ candidatesCount: 1, requests: 196 },
				{ candidatesCount: 3, requests: 600 },
			],
		},
		...over,
	};
}

function render(props: Record<string, unknown> = {}) {
	return renderToStaticMarkup(
		<StopsHistoryCard data={response()} now={NOW} {...props} />,
	);
}

describe("StopsHistoryCard", () => {
	it("states the blocked share and the cause breakdown", () => {
		const html = render();

		expect(html).toContain("Stops");
		expect(html).toContain("12 of 1000 requests blocked");
		expect(html).toContain("(1.20%)");
		expect(html).toContain("Pool quota exhausted");
		expect(html).toContain("Model not served by any account");
		expect(html).toContain("gpt-5.2-codex ×300");
		expect(html).toContain("2h ago");
		expect(html).toContain("all_accounts_failed");
	});

	it("buckets the candidate distribution into the three answers that differ", () => {
		// Zero candidates means the request could not be served at all; one means
		// it was one failure from that; two or more means it had a fallback. The
		// raw distribution buries that under a list of account counts.
		const html = render();

		// Count AND share for all three, so no bucket is stated in a different
		// unit than the ones beside it.
		expect(html).toContain(
			"none: 4 (0.5%) · one: 196 (24.5%) · two or more: 600 (75.0%)",
		);
		expect(html).toContain("eligibility observed for 800 of 1000 requests");
	});

	it("says there is no eligibility data rather than dividing by zero", () => {
		const html = render({
			data: response({
				candidates: {
					observedRequests: 0,
					zeroCandidateRequests: 0,
					distribution: [],
				},
			}),
		});

		expect(html).toContain("No eligibility data");
		expect(html).not.toContain("NaN");
	});

	it("shows a dash instead of a percentage when nothing was requested", () => {
		const html = render({
			data: response({ totalRequests: 0, blockedRequests: 0, causes: [] }),
		});

		expect(html).toContain("0 of 0 requests blocked (—)");
		expect(html).not.toContain("NaN");
	});

	it("says the range was clean rather than drawing an empty chart", () => {
		const html = render({
			data: response({ blockedRequests: 0, causes: [] }),
		});

		expect(html).toContain("No blocked requests in this range");
	});

	it("states nothing measured while the read is in flight", () => {
		const html = render({ data: undefined, loading: true });

		expect(html).toContain("Stops");
		expect(html).toContain("animate-pulse");
		expect(html).not.toContain("requests blocked");
	});

	it("reports a failed read as unavailable rather than as a clean range", () => {
		const html = render({
			data: undefined,
			unavailableReason: "Stops data unavailable",
		});

		expect(html).toContain("Stops data unavailable");
		expect(html).not.toContain("No blocked requests in this range");
	});
});
