import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PricingGap } from "@clankermux/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DismissiblePricingGapBanner } from "./PricingGapBanner";
import { PRICING_GAP_DISMISSALS_KEY } from "./useDismissedPricingGaps";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const gap: PricingGap = {
	key: "a".repeat(64),
	fingerprint: "a".repeat(16),
	modelId: "gpt-5.6-luna",
	provider: "codex",
	reason: "cost_missing",
	occurrences: 11,
	firstSeenAt: 1700000000000,
	lastSeenAt: 1700000060000,
};
let root: Root | null = null;
let host: HTMLElement;
const realGetItem = window.localStorage.getItem;
const realSetItem = window.localStorage.setItem;

async function render(gaps: PricingGap[] = [gap]) {
	if (!root) root = createRoot(host);
	await act(async () =>
		root?.render(<DismissiblePricingGapBanner gaps={gaps} />),
	);
}
async function dismiss() {
	const button = host.querySelector<HTMLButtonElement>(
		'button[aria-label="Dismiss pricing warnings"]',
	);
	expect(button).not.toBeNull();
	await act(async () => button?.click());
}
function visible() {
	return host.querySelector('[role="alert"]') !== null;
}

beforeEach(() => {
	window.localStorage.removeItem(PRICING_GAP_DISMISSALS_KEY);
	host = document.createElement("div");
	document.body.appendChild(host);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host.remove();
	window.localStorage.getItem = realGetItem;
	window.localStorage.setItem = realSetItem;
	window.localStorage.removeItem(PRICING_GAP_DISMISSALS_KEY);
});

describe("pricing warning dismissal", () => {
	it("hides observed warnings and keeps them hidden after remount", async () => {
		await render();
		expect(visible()).toBe(true);
		await dismiss();
		expect(visible()).toBe(false);
		await act(async () => root?.unmount());
		root = null;
		await render();
		expect(visible()).toBe(false);
	});

	it("resurfaces for a new occurrence even in the same millisecond", async () => {
		await render();
		await dismiss();
		await render([{ ...gap, occurrences: 12 }]);
		expect(visible()).toBe(true);
	});

	it("resurfaces when a new generation starts with a smaller count", async () => {
		await render();
		await dismiss();
		await render([
			{
				...gap,
				firstSeenAt: gap.lastSeenAt + 1,
				lastSeenAt: gap.lastSeenAt + 1,
				occurrences: 1,
			},
		]);
		expect(visible()).toBe(true);
	});

	it("does not hide a different gap with the same display labels", async () => {
		await render();
		await dismiss();
		await render([
			gap,
			{ ...gap, key: "b".repeat(64), fingerprint: "b".repeat(16) },
		]);
		expect(host.querySelectorAll("li")).toHaveLength(1);
		expect(host.textContent).toContain("#bbbbbbbbbbbbbbbb");
	});

	it("works in memory when browser storage is unavailable", async () => {
		window.localStorage.getItem = () => {
			throw new Error("Storage blocked");
		};
		window.localStorage.setItem = () => {
			throw new Error("Storage blocked");
		};
		await render();
		await dismiss();
		expect(visible()).toBe(false);
		await render([{ ...gap, occurrences: 12 }]);
		expect(visible()).toBe(true);
	});

	it("receives another tab's dismissal and resurfaces on the next request", async () => {
		await render();
		window.localStorage.setItem(
			PRICING_GAP_DISMISSALS_KEY,
			JSON.stringify({
				[`${gap.key}:${gap.firstSeenAt}`]: {
					lastSeenAt: gap.lastSeenAt,
					occurrences: gap.occurrences,
				},
			}),
		);
		await act(async () => {
			window.dispatchEvent(
				new StorageEvent("storage", { key: PRICING_GAP_DISMISSALS_KEY }),
			);
		});
		expect(visible()).toBe(false);
		await render([{ ...gap, occurrences: 12 }]);
		expect(visible()).toBe(true);
	});

	it("preserves dismissals written by another tab before this tab saves", async () => {
		await render();
		const other = { ...gap, key: "b".repeat(64) };
		window.localStorage.setItem(
			PRICING_GAP_DISMISSALS_KEY,
			JSON.stringify({
				[`${other.key}:${other.firstSeenAt}`]: {
					lastSeenAt: other.lastSeenAt,
					occurrences: other.occurrences,
				},
			}),
		);
		await dismiss();
		await act(async () => root?.unmount());
		root = null;
		await render([gap, other]);
		expect(visible()).toBe(false);
	});

	it("ignores malformed persisted data", async () => {
		window.localStorage.setItem(PRICING_GAP_DISMISSALS_KEY, "null");
		await render();
		expect(visible()).toBe(true);
		await dismiss();
		expect(visible()).toBe(false);
	});
});
