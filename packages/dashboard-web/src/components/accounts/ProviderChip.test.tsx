import { describe, expect, it } from "bun:test";
import { PROVIDER_NAMES } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderChip } from "./ProviderChip";
import { getProviderMark } from "./provider-marks";

describe("ProviderChip", () => {
	it("renders the human-readable provider name", () => {
		const html = renderToStaticMarkup(<ProviderChip provider="codex" />);
		expect(html).toContain("OpenAI");
	});

	it("uses one neutral pill for every provider", () => {
		const providers = Object.values(PROVIDER_NAMES);
		const pills = providers.map((provider) => {
			const html = renderToStaticMarkup(<ProviderChip provider={provider} />);
			const match = html.match(/<span class="([^"]*)"/);
			return match?.[1] ?? "";
		});
		// No provider-specific tint: every pill carries the same classes, and
		// none of them is a colored fill that could read as a status.
		expect(new Set(pills).size).toBe(1);
		expect(pills[0]).toContain("bg-muted");
		expect(pills[0]).not.toMatch(/bg-(orange|amber|emerald|red|rose|teal)-/);
	});

	it("draws the brand mark for providers that have one", () => {
		const html = renderToStaticMarkup(<ProviderChip provider="anthropic" />);
		expect(html).toContain("<svg");
		expect(html).toContain("aria-hidden");
	});

	it("falls back to text only when a provider has no brand mark", () => {
		const html = renderToStaticMarkup(<ProviderChip provider="kilo" />);
		expect(html).not.toContain("<svg");
		expect(html).toContain("Kilo");
	});

	it("keeps the caller's className on the pill", () => {
		const html = renderToStaticMarkup(
			<ProviderChip provider="qwen" className="shrink-0" />,
		);
		expect(html).toContain("shrink-0");
	});
});

describe("getProviderMark", () => {
	it("colors marks whose brand color reads in both themes", () => {
		expect(getProviderMark("anthropic")?.color).toBe("#D97757");
		expect(getProviderMark("qwen")?.color).toBe("#6950EF");
	});

	it("inherits the text color for monochrome brands", () => {
		// OpenAI, Ollama and the Anthropic wordmark are near-black by brand, so a
		// literal hex would disappear on a dark card.
		expect(getProviderMark("codex")?.color).toBeUndefined();
		expect(getProviderMark("ollama")?.color).toBeUndefined();
		expect(getProviderMark("anthropic-compatible")?.color).toBeUndefined();
		expect(getProviderMark("zai")?.color).toBeUndefined();
	});

	it("has no mark for providers without a published logo", () => {
		expect(getProviderMark("kilo")).toBeUndefined();
		expect(getProviderMark("something-custom")).toBeUndefined();
	});

	it("gives every mark a non-empty path", () => {
		for (const provider of Object.values(PROVIDER_NAMES)) {
			const mark = getProviderMark(provider);
			if (!mark) continue;
			expect(mark.path.length).toBeGreaterThan(20);
		}
	});
});
