import { afterEach, describe, expect, it } from "bun:test";
import type { StopsHistoryResponse } from "@clankermux/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StopsHistoryCard } from "./StopsHistoryCard";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const fixture = (): StopsHistoryResponse => ({
	range: "24h",
	bucketMs: 3600000,
	windowStartsAt: 0,
	windowEndsAt: 1,
	totalRequests: 200,
	blockedRequests: 0,
	outcomeTotals: { blocked: 0, failed: 1, disconnected: 129, unclassified: 0 },
	excludedAttemptAuditRows: 31,
	causes: (
		[
			["stream_failed", 1, "upstream socket closed"],
			["client_disconnected", 129, "client disconnected"],
		] as const
	).map(([cause, count, sampleErrorMessage]) => ({
		cause,
		count,
		sampleErrorMessage,
		firstSeenMs: 0,
		lastSeenMs: 1,
		topRequestedModel: "gpt-6-astra",
		topRequestedModelCount: count,
		series: [{ ts: 0, count }],
	})),
	candidates: {
		observedRequests: 200,
		zeroCandidateRequests: 0,
		distribution: [{ candidatesCount: 2, requests: 200 }],
	},
});
async function mount(data = fixture()) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(<StopsHistoryCard data={data} now={1} />);
	});
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
	host = null;
});
function toggle(label: string): HTMLButtonElement {
	const button = Array.from(
		host?.querySelectorAll<HTMLButtonElement>("button[aria-pressed]") ?? [],
	).find((b) => b.textContent?.startsWith(label));
	if (!button) throw new Error(`Missing toggle ${label}`);
	return button;
}
describe("request outcome interactions", () => {
	it("keeps disconnect counts visible while initially showing the real failure", async () => {
		await mount();
		expect(toggle("Disconnected").getAttribute("aria-pressed")).toBe("false");
		expect(toggle("Disconnected").textContent).toContain("129");
		expect(host?.querySelector("tbody")?.textContent).toContain(
			"Stream failed",
		);
		expect(host?.querySelector("tbody")?.textContent).not.toContain(
			"Client disconnected",
		);
		expect(host?.textContent).toContain("31 legacy retry attempts excluded");
		await act(async () => toggle("Disconnected").click());
		expect(toggle("Disconnected").getAttribute("aria-pressed")).toBe("true");
		expect(host?.querySelector("tbody")?.textContent).toContain(
			"Client disconnected",
		);
		expect(host?.textContent).toContain(
			"130 of 200 recorded requests did not complete",
		);
	});
	it("distinguishes a filtered empty view from a clean range", async () => {
		await mount();
		await act(async () => toggle("Failed").click());
		expect(host?.textContent).toContain(
			"No requests in the selected outcome groups",
		);
		expect(host?.textContent).not.toContain(
			"No unsuccessful requests in this range",
		);
	});
	it("makes raw samples available through a focusable disclosure", async () => {
		await mount();
		const summary = host?.querySelector("tbody summary") as HTMLElement;
		expect(summary).not.toBeNull();
		summary.focus();
		expect(document.activeElement).toBe(summary);
		await act(async () => summary.click());
		expect(host?.querySelector("tbody details")?.hasAttribute("open")).toBe(
			true,
		);
		expect(host?.querySelector("tbody details")?.textContent).toContain(
			"upstream socket closed",
		);
	});
	it("shows unclassified only when nonzero and enables it by default", async () => {
		const data = fixture();
		data.outcomeTotals.unclassified = 2;
		data.causes.push({
			...data.causes[0],
			cause: "other",
			count: 2,
			sampleErrorMessage: "unknown",
			series: [{ ts: 0, count: 2 }],
		});
		await mount(data);
		expect(toggle("Unclassified").getAttribute("aria-pressed")).toBe("true");
		expect(host?.querySelector("tbody")?.textContent).toContain("Unclassified");
	});
});
