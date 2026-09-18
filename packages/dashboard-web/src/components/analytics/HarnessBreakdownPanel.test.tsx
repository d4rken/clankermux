import { describe, expect, it } from "bun:test";
import type { ClientEfficiencyRow } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessBreakdownPanel } from "./HarnessBreakdownPanel";

function row(
	overrides: Partial<ClientEfficiencyRow> = {},
): ClientEfficiencyRow {
	return {
		apiKeyId: "key-1",
		apiKey: "client",
		harness: "claude-code",
		declaredApplication: null,
		requests: 1,
		successfulRequests: 1,
		observedRequests: 1,
		inferredSessionRequests: 0,
		inferredDeclaredRequests: 0,
		inputTokens: 100,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: 0,
		pricedRequests: 1,
		unpricedRequests: 0,
		contextCoveredRequests: 0,
		contextTokensSum: 0,
		contextToolsCharsSum: 0,
		contextSystemCharsSum: 0,
		contextToolCountSum: 0,
		...overrides,
	};
}

const zeroContext = {
	coveredRequests: 1,
	systemCharsSum: 0,
	toolsCharsSum: 0,
	toolResultCharsSum: 0,
	otherMessagesCharsSum: 0,
	messageCountSum: 0,
};

function cells(html: string, table: string, label: string): string[] {
	const markup =
		html.match(
			new RegExp(`<table[^>]*aria-label="${table}"[^>]*>([\\s\\S]*?)</table>`),
		)?.[1] ?? "";
	for (const match of markup.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
		const values = Array.from(
			match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g),
			(cell) => cell[1].replace(/<[^>]*>/g, ""),
		);
		if (values[0] === label) return values;
	}
	throw new Error(`Missing ${table} row ${label}`);
}

function text(html: string): string {
	return html.replace(/<[^>]*>/g, "");
}

describe("HarnessBreakdownPanel", () => {
	it("shows loading and empty states without comparison tables", () => {
		const loading = renderToStaticMarkup(
			<HarnessBreakdownPanel rows={[row()]} loading />,
		);
		expect(loading).toContain("Loading harness breakdown…");
		expect(loading).not.toContain("<table");
		const empty = renderToStaticMarkup(<HarnessBreakdownPanel rows={[]} />);
		expect(empty).toContain("No client activity in this range");
		expect(empty).not.toContain("<table");
	});

	it("shows one harness without a comparison selector or difference column", () => {
		const html = renderToStaticMarkup(<HarnessBreakdownPanel rows={[row()]} />);
		expect(html).toContain('aria-label="Baseline harness"');
		expect(html).not.toContain('aria-label="Comparison harness"');
		expect(cells(html, "Recorded tokens", "Total tokens")).toEqual([
			"Total tokens",
			"100",
		]);
		expect(text(html)).toContain(
			"Only one harness is present in this selection.",
		);
		expect(text(html)).toContain("Characters are not token estimates.");
	});

	it("distinguishes missing composition from measured zeros and leaves the difference unknown", () => {
		const html = renderToStaticMarkup(
			<HarnessBreakdownPanel
				rows={[row(), row({ harness: "pi", contextBreakdown: zeroContext })]}
			/>,
		);
		expect(cells(html, "Context carried", "System prompt")).toEqual([
			"System prompt",
			"—",
			"0",
			"—",
		]);
		expect(cells(html, "Context carried", "Total chars")).toEqual([
			"Total chars",
			"—",
			"0",
			"—",
		]);
		expect(text(html)).toContain("Context measured for 0 of 1 requests");
		expect(text(html)).toContain(
			"Context measured for 1 of 1 requests · 0.0 messages/request",
		);
	});

	it("reports measured coverage, inference and truncation beside the selected harness", () => {
		const html = renderToStaticMarkup(
			<HarnessBreakdownPanel
				truncated
				rows={[
					row({
						requests: 10,
						observedRequests: 7,
						inferredSessionRequests: 2,
						inferredDeclaredRequests: 1,
						contextBreakdown: {
							...zeroContext,
							coveredRequests: 2,
							messageCountSum: 8,
						},
					}),
				]}
			/>,
		);
		expect(text(html)).toContain("7 observed · 3 inferred");
		expect(text(html)).toContain(
			"Context measured for 2 of 10 requests · 4.0 messages/request",
		);
		expect(text(html)).toContain(
			"only the busiest client rows returned by the server",
		);
	});

	it("weights token and character averages by their respective request counts across keys", () => {
		const html = renderToStaticMarkup(
			<HarnessBreakdownPanel
				rows={[
					row({ contextBreakdown: { ...zeroContext, systemCharsSum: 100 } }),
					row({
						apiKeyId: "key-2",
						requests: 9,
						inputTokens: 9000,
						contextBreakdown: {
							...zeroContext,
							coveredRequests: 3,
							systemCharsSum: 900,
						},
					}),
				]}
			/>,
		);
		expect(cells(html, "Recorded tokens", "Uncached input")).toEqual([
			"Uncached input",
			"910",
		]);
		expect(cells(html, "Context carried", "System prompt")).toEqual([
			"System prompt",
			"250",
		]);
		expect(text(html)).toContain("Context measured for 4 of 10 requests");
	});

	it("explains decreases and increases with the same comparison-minus-baseline sign as the table", () => {
		for (const [cacheReads, delta, direction, driver] of [
			[100, "-600", "fewer", "700 fewer"],
			[1600, "+900", "more", "800 more"],
		] as const) {
			const html = renderToStaticMarkup(
				<HarnessBreakdownPanel
					rows={[
						row({ cacheReadTokens: 800 }),
						row({
							harness: "pi",
							inputTokens: 200,
							cacheReadTokens: cacheReads,
						}),
					]}
				/>,
			);
			expect(cells(html, "Recorded tokens", "Total tokens").at(-1)).toBe(delta);
			expect(text(html)).toContain(
				`pi records ${delta.slice(1)} ${direction} tokens/request than Claude Code.`,
			);
			expect(text(html)).toContain(`cache reads (${driver}).`);
			expect(text(html)).toContain("Differences are pi minus Claude Code.");
		}
	});
});

it("rounds tiny signed differences without negative zero or a zero-sized driver", () => {
	const html = renderToStaticMarkup(
		<HarnessBreakdownPanel
			rows={[
				row({
					requests: 10,
					inputTokens: 100,
					cacheReadTokens: 100,
					cacheCreationTokens: 100,
					outputTokens: 100,
				}),
				row({
					harness: "pi",
					requests: 10,
					inputTokens: 98,
					cacheReadTokens: 98,
					cacheCreationTokens: 98,
					outputTokens: 98,
				}),
			]}
		/>,
	);
	expect(cells(html, "Recorded tokens", "Uncached input").at(-1)).toBe("0");
	expect(text(html)).toContain(
		"pi records 1 fewer tokens/request than Claude Code.",
	);
	expect(text(html)).not.toContain("largest decrease");
});
