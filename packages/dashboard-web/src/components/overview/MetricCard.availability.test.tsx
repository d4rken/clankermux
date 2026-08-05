/**
 * A metric card must never present a fallback zero as a measurement.
 *
 * The Overview's Active Sessions tile rendered `stats?.activeSessions?.total ?? 0`,
 * so a failed /api/stats read displayed a confident "0" — the reported "not all
 * results are correct" symptom.
 */
import { describe, expect, it } from "bun:test";
import { Users } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricCard } from "./MetricCard";

describe("MetricCard availability states", () => {
	it("renders the value normally when the read succeeded", () => {
		const html = renderToStaticMarkup(
			<MetricCard
				title="Active Sessions"
				value="7"
				icon={Users}
				subRows={[{ label: "Claude", value: "5" }]}
			/>,
		);
		expect(html).toContain(">7<");
		expect(html).toContain("Claude");
	});

	it("renders a genuine zero as a real measurement", () => {
		const html = renderToStaticMarkup(
			<MetricCard title="Active Sessions" value="0" icon={Users} />,
		);
		expect(html).toContain(">0<");
		expect(html).not.toContain("unavailable");
	});

	it("replaces the value with an explicit unavailable state, not a zero", () => {
		const html = renderToStaticMarkup(
			<MetricCard
				title="Active Sessions"
				value="0"
				icon={Users}
				unavailableReason="Session data unavailable"
				subRows={[{ label: "Claude", value: "0" }]}
			/>,
		);
		expect(html).toContain("Session data unavailable");
		expect(html).not.toContain(">0<");
		// Sub-rows would carry the same misleading fallback zeros.
		expect(html).not.toContain("Claude");
	});

	it("keeps a stale value visible but labels its age", () => {
		const html = renderToStaticMarkup(
			<MetricCard
				title="Active Sessions"
				value="7"
				icon={Users}
				staleNote="Last updated 2m ago"
			/>,
		);
		expect(html).toContain(">7<");
		expect(html).toContain("Last updated 2m ago");
	});
});
