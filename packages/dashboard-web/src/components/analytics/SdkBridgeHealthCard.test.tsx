import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { healthFixture } from "./__fixtures__/sdk-bridge-health";
import { SdkBridgeHealthCard } from "./SdkBridgeHealthCard";

const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

describe("SdkBridgeHealthCard", () => {
	it("shows the failure rate with its numerator and denominator", () => {
		const out = text(
			renderToStaticMarkup(<SdkBridgeHealthCard data={healthFixture()} />),
		);
		expect(out).toContain("Agent SDK bridge");
		expect(out).toContain(
			"2 of 8 finished turns and side requests failed (25.0%)",
		);
		expect(out).toContain("12 turns · 2 side requests");
	});

	it("counts every status, released ones as waiting for tool results", () => {
		const out = text(
			renderToStaticMarkup(<SdkBridgeHealthCard data={healthFixture()} />),
		);
		for (const part of [
			"Completed 6",
			"Failed 1",
			"Timed out 1",
			"Rejected 2",
			"Aborted 1",
			"Shut down 0",
			"Running 1",
			"Waiting for tool results 2",
			"Expired, tool results never came 1",
		])
			expect(out).toContain(part);
	});

	it("shows percentiles with their sample size, and none without samples", () => {
		const out = text(
			renderToStaticMarkup(<SdkBridgeHealthCard data={healthFixture()} />),
		);
		expect(out).toContain("Start-up p50 1.2s · p95 3.4s · 9 samples");
		expect(out).toContain("First event p50 2.0s · p95 5.0s · 8 samples");
		expect(out).toContain("Duration (wall clock, incl. tool time) no samples");
		expect(out).toContain("Tool rounds per turn p50 2 · p95 6 · 7 turns");
	});

	it("shows history modes, rebuild reasons that occurred, and inner usage", () => {
		const out = text(
			renderToStaticMarkup(<SdkBridgeHealthCard data={healthFixture()} />),
		);
		expect(out).toContain(
			"Fresh session 5 · Resumed session 4 · Resumed, client turns appended 2 · Rebuilt from history 0 · Rebuilt from history, flattened 3",
		);
		expect(out).toContain(
			"Rebuild reasons: continuation 2 · edit 1 · tool results after their query ended 2",
		);
		expect(out).not.toContain("compaction");
		expect(out).toContain(
			"31 model calls · 12,000 in · 3,400 out · 250,000 cache read · $1.5000",
		);
	});

	it("splits by client and account, naming deleted and missing accounts", () => {
		const html = renderToStaticMarkup(
			<SdkBridgeHealthCard data={healthFixture()} />,
		);
		const out = text(html);
		expect(html).toContain('aria-label="By client"');
		expect(html).toContain('aria-label="By account"');
		expect(html).not.toContain(">Turns<");
		expect(out).toContain(
			"Client Total Failed Rejected Failure rate Model calls Cost",
		);
		expect(out).toContain(
			"Account Total Failed Rejected Failure rate Model calls served Cost served",
		);
		expect(out).toContain("pi 12 2 0 25.0% 31 $1.5000");
		expect(out).toContain("codex 2 0 2 — 0 $0.0000");
		expect(out).toContain("Claude-a 10 1 0 14.3% 25 $1.2500");
		expect(out).toContain("acct-gone 2");
		expect(out).toContain("None 2");
		// Served calls after failover, on an account routing chose for no turn.
		expect(out).toContain("Claude-b 0 0 0 — 6 $0.2500");
	});

	it("lists errors and recent failures, each failure opening its turn", () => {
		const html = renderToStaticMarkup(
			<SdkBridgeHealthCard data={healthFixture()} onOpenTurn={() => {}} />,
		);
		const out = text(html);
		expect(out).toContain("Rejected invalid_request_error 400 2");
		expect(out).toContain("Failed overloaded_error 529 1");
		expect(out).toContain(
			"invalid_request_error: pi-head-v1: the forwarded system prompt was refused",
		);
		expect(out).toContain("Side request");
		expect(html).toContain('title="turn-rejected-1"');
		expect((html.match(/<button[^>]*title="turn-/g) ?? []).length).toBe(2);
	});

	it("says so when nothing ran in the range", () => {
		const out = text(
			renderToStaticMarkup(
				<SdkBridgeHealthCard
					data={healthFixture({
						total: 0,
						failureRate: { failures: 0, finished: 0, rate: null },
					})}
				/>,
			),
		);
		expect(out).toContain("No Agent SDK turns in this range");
		expect(out).not.toContain("failed (");
	});

	it("shows a skeleton while loading, and the reason when unavailable", () => {
		const loading = renderToStaticMarkup(
			<SdkBridgeHealthCard data={undefined} loading />,
		);
		expect(loading).toContain("animate-pulse");
		const unavailable = text(
			renderToStaticMarkup(
				<SdkBridgeHealthCard
					data={undefined}
					loading
					unavailableReason="Agent SDK bridge data unavailable"
				/>,
			),
		);
		expect(unavailable).toContain("Agent SDK bridge data unavailable");
	});

	it("keeps showing cached figures with the stale note", () => {
		const out = text(
			renderToStaticMarkup(
				<SdkBridgeHealthCard
					data={healthFixture()}
					staleNote="Last updated 3m ago"
				/>,
			),
		);
		expect(out).toContain("Last updated 3m ago");
		expect(out).toContain("2 of 8 finished turns and side requests failed");
	});
});
