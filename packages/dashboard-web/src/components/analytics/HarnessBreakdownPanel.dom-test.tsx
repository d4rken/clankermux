import { afterEach, describe, expect, it } from "bun:test";
import type { ClientEfficiencyRow } from "@clankermux/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HarnessBreakdownPanel } from "./HarnessBreakdownPanel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function row(harness: string, cacheReadTokens: number): ClientEfficiencyRow {
	return {
		apiKeyId: harness,
		apiKey: harness,
		harness,
		declaredApplication: null,
		requests: 1,
		successfulRequests: 1,
		observedRequests: 1,
		inferredSessionRequests: 0,
		inferredDeclaredRequests: 0,
		inputTokens: 100,
		outputTokens: 0,
		cacheReadTokens,
		cacheCreationTokens: 0,
		costUsd: 0,
		pricedRequests: 1,
		unpricedRequests: 0,
		contextCoveredRequests: 0,
		contextTokensSum: 0,
		contextToolsCharsSum: 0,
		contextSystemCharsSum: 0,
		contextToolCountSum: 0,
	};
}

const ROWS = [row("claude-code", 600), row("pi", 200), row("codex", 400)];

async function render(rows = ROWS): Promise<void> {
	if (!host) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	await act(async () => root?.render(<HarnessBreakdownPanel rows={rows} />));
}

function selector(label: string): HTMLElement {
	const trigger = host?.querySelector<HTMLElement>(
		`[role="combobox"][aria-label="${label}"]`,
	);
	if (!trigger) throw new Error(`Missing selector ${label}`);
	return trigger;
}

async function select(label: string, harness: string): Promise<void> {
	const trigger = selector(label);
	trigger.focus();
	await act(async () => {
		trigger.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
		);
	});
	const option = Array.from(document.querySelectorAll('[role="option"]')).find(
		(element) => element.textContent === harness,
	);
	if (!option) throw new Error(`Missing harness option ${harness}`);
	await act(async () => {
		option.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		);
	});
}

function totalCells(): string[] {
	const rows = Array.from(
		host?.querySelectorAll('table[aria-label="Recorded tokens"] tbody tr') ??
			[],
	);
	const total = rows.find(
		(element) => element.querySelector("td")?.textContent === "Total tokens",
	);
	return Array.from(
		total?.querySelectorAll("td") ?? [],
		(element) => element.textContent ?? "",
	);
}

function explanation(): string {
	return host?.querySelector('[aria-live="polite"]')?.textContent ?? "";
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
	host = null;
});

describe("HarnessBreakdownPanel selectors", () => {
	it("updates values, labels and explanation when both Radix selectors change", async () => {
		await render();
		expect(totalCells()).toEqual(["Total tokens", "700", "300", "-400"]);
		await select("Comparison harness", "codex");
		expect(selector("Comparison harness").textContent).toBe("codex");
		expect(totalCells()).toEqual(["Total tokens", "700", "500", "-200"]);
		expect(explanation()).toContain(
			"codex records 200 fewer tokens/request than Claude Code.",
		);

		await select("Baseline harness", "pi");
		expect(selector("Baseline harness").textContent).toBe("pi");
		expect(totalCells()).toEqual(["Total tokens", "300", "500", "+200"]);
		expect(explanation()).toContain(
			"codex records 200 more tokens/request than pi.",
		);
		expect(explanation()).toContain(
			"largest increase is cache reads (200 more)",
		);
		expect(host?.textContent).toContain("Differences are codex minus pi.");
	});

	it("falls back to a present baseline when filtering removes the selected harness", async () => {
		await render();
		await select("Baseline harness", "codex");
		await render(ROWS.filter((item) => item.harness !== "codex"));
		expect(selector("Baseline harness").textContent).toBe("Claude Code");
		expect(selector("Comparison harness").textContent).toBe("pi");
		expect(totalCells()).toEqual(["Total tokens", "700", "300", "-400"]);
		expect(explanation()).toContain(
			"pi records 400 fewer tokens/request than Claude Code.",
		);
		expect(explanation()).not.toContain("codex");
	});

	it("replaces a removed comparison and drops it entirely when only one harness remains", async () => {
		await render();
		await select("Comparison harness", "codex");
		await render(ROWS.filter((item) => item.harness !== "codex"));
		expect(selector("Comparison harness").textContent).toBe("pi");
		expect(totalCells()).toEqual(["Total tokens", "700", "300", "-400"]);
		await render(ROWS.filter((item) => item.harness === "claude-code"));
		expect(host?.querySelector('[aria-label="Comparison harness"]')).toBeNull();
		expect(totalCells()).toEqual(["Total tokens", "700"]);
		expect(explanation()).toBe("");
		expect(host?.textContent).toContain(
			"Only one harness is present in this selection.",
		);
	});
});
