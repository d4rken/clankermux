/**
 * The grouping toggle on the client-efficiency table.
 *
 * The two groupings read ONE payload — the (key × harness) rows — so switching
 * must re-roll them client-side rather than re-query. Under `By harness` the
 * same requests regroup under harness names, and a client used by two harnesses
 * stops being one row. That regrouping only happens on a real click against a
 * mounted component, which is why this lives in the DOM lane.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ClientEfficiencyRow } from "@clankermux/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ClientEfficiencyTable } from "./ClientEfficiencyTable";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function row(
	overrides: Partial<ClientEfficiencyRow> = {},
): ClientEfficiencyRow {
	return {
		apiKeyId: "key-1",
		apiKey: "laptop-key",
		harness: "claude-code",
		declaredApplication: "claude-code",
		requests: 10,
		successfulRequests: 10,
		observedRequests: 10,
		inferredSessionRequests: 0,
		inferredDeclaredRequests: 0,
		inputTokens: 1000,
		outputTokens: 200,
		cacheReadTokens: 4000,
		cacheCreationTokens: 500,
		costUsd: 0.5,
		pricedRequests: 10,
		unpricedRequests: 0,
		contextCoveredRequests: 10,
		contextTokensSum: 55_000,
		contextToolsCharsSum: 20_000,
		contextSystemCharsSum: 10_000,
		contextToolCountSum: 120,
		...overrides,
	};
}

/**
 * One key used by two harnesses, plus a second key on one of them. By client
 * that is two rows; by harness it is two different rows.
 */
const ROWS: ClientEfficiencyRow[] = [
	row({ harness: "claude-code", requests: 8, observedRequests: 8 }),
	row({ harness: "codex", requests: 2, observedRequests: 2 }),
	row({
		apiKeyId: "key-2",
		apiKey: "server-key",
		harness: "codex",
		declaredApplication: "codex",
		requests: 5,
		successfulRequests: 5,
		observedRequests: 5,
	}),
];

async function mount(rows: ClientEfficiencyRow[] = ROWS) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(<ClientEfficiencyTable rows={rows} truncated={false} />);
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
	).find((candidate) => candidate.textContent?.trim() === label);
	if (!button) throw new Error(`Missing toggle ${label}`);
	return button;
}

/** The first cell of every body row — the name column. */
function rowLabels(): string[] {
	return Array.from(host?.querySelectorAll("tbody tr") ?? []).map(
		(tr) => tr.querySelector("td")?.textContent?.trim() ?? "",
	);
}

describe("ClientEfficiencyTable grouping toggle", () => {
	it("opens grouped by client, with the dominant harness and a +N", async () => {
		await mount();

		expect(toggle("By client").getAttribute("aria-pressed")).toBe("true");
		expect(toggle("By harness").getAttribute("aria-pressed")).toBe("false");

		const labels = rowLabels();
		expect(labels.length).toBe(2);
		// key-1 spans claude-code (8) and codex (2): the busier one names the row.
		expect(labels[0]).toContain("laptop-key");
		expect(labels[0]).toContain("claude-code");
		expect(labels[0]).toContain("+1");
		expect(labels[1]).toContain("server-key");
	});

	it("regroups the same rows under harness names when toggled", async () => {
		await mount();

		await act(async () => {
			toggle("By harness").click();
		});

		expect(toggle("By harness").getAttribute("aria-pressed")).toBe("true");
		const labels = rowLabels();
		expect(labels.length).toBe(2);
		// codex now carries key-1's 2 requests plus key-2's 5 (7), still behind
		// claude-code's 8, so the default request sort keeps that order.
		expect(labels[0]).toContain("claude-code");
		expect(labels[1]).toContain("codex");
		// The client names belong to the other grouping and must be gone.
		expect(labels.join(" ")).not.toContain("laptop-key");
		expect(labels.join(" ")).not.toContain("server-key");
	});

	it("sums the regrouped requests rather than re-reading them", async () => {
		await mount();
		await act(async () => {
			toggle("By harness").click();
		});

		const requestCells = Array.from(
			host?.querySelectorAll("tbody tr") ?? [],
		).map((tr) => tr.querySelectorAll("td")[1]?.textContent?.trim() ?? "");
		// claude-code: 8. codex: 2 + 5.
		expect(requestCells[0]).toBe("8");
		expect(requestCells[1]).toBe("7");
	});

	it("returns to the client grouping without losing the +N marking", async () => {
		await mount();
		await act(async () => {
			toggle("By harness").click();
		});
		await act(async () => {
			toggle("By client").click();
		});

		expect(rowLabels()[0]).toContain("+1");
	});
});
