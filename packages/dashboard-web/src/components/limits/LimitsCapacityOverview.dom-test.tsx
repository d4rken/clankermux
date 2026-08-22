import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PoolUsageResult } from "../../lib/pool-usage";
import { LimitsCapacityOverview } from "./LimitsCapacityOverview";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function poolResult(): PoolUsageResult {
	return {
		average: 25,
		activeAverage: 25,
		worst: { name: "alpha", pct: 25 },
		contributing: [{ name: "alpha", pct: 25, resetMs: null }],
		exhausted: [],
		excluded: [],
		fallback: [],
		earliestResetMs: null,
		earliestResetAccountName: null,
		atRisk: [],
		familyWeekly: [],
	};
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
	host = null;
});

describe("LimitsCapacityOverview calculation help", () => {
	it("opens the aggregation and routing explanation from its labelled trigger", async () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root?.render(
				<LimitsCapacityOverview
					fiveHour={poolResult()}
					sevenDay={poolResult()}
					now={Date.UTC(2026, 7, 22, 12, 0, 0)}
				/>,
			);
		});

		const trigger = document.querySelector<HTMLButtonElement>(
			'button[aria-label="About quota calculations"]',
		);
		expect(trigger).not.toBeNull();
		expect(document.body.textContent).not.toContain(
			"How the overview is calculated",
		);

		await act(async () => trigger?.click());

		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		expect(document.body.textContent).toContain(
			"How the overview is calculated",
		);
		expect(document.body.textContent).toContain(
			"unavailable count as 100% used",
		);
		expect(document.body.textContent).toContain(
			"never control request routing",
		);
	});
});
