import { describe, expect, it } from "bun:test";
import { PROVIDER_NAMES } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderChip } from "./ProviderChip";
import { getProviderMark } from "./provider-marks";

/** Providers with no published single-color logo we can vendor. */
const TEXT_ONLY_PROVIDERS = new Set<string>(["kilo"]);

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
		expect(pills[0]).toContain("bg-secondary");
		expect(pills[0]).toContain("text-secondary-foreground");
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

	it("keeps the caller's className on the pill and sizes the mark", () => {
		const html = renderToStaticMarkup(
			<ProviderChip provider="qwen" className="shrink-0" />,
		);
		expect(html).toContain("shrink-0");
		expect(html).toMatch(/<svg[^>]*class="[^"]*h-3\.5 w-3\.5/);
	});
});

describe("getProviderMark", () => {
	it("covers every known provider except the text-only ones", () => {
		for (const provider of Object.values(PROVIDER_NAMES)) {
			const mark = getProviderMark(provider);
			if (TEXT_ONLY_PROVIDERS.has(provider)) {
				expect(mark, provider).toBeUndefined();
				continue;
			}
			expect(mark, `no brand mark for ${provider}`).toBeDefined();
			expect(mark?.path.length).toBeGreaterThan(20);
		}
	});

	it("gives a per-theme fill to brands that fail 3:1 on one theme", () => {
		// Claude coral is 2.8:1 on the light pill; Qwen indigo is 2.7:1 on the
		// dark one and Alibaba orange 2.6:1 on the light one. Each needs both
		// halves, not a single hex.
		for (const provider of [
			"anthropic",
			"claude-console-api",
			"qwen",
			"alibaba-coding-plan",
		]) {
			expect(getProviderMark(provider)?.fill, provider).toMatch(
				/^fill-\[#[0-9A-F]{6}\] dark:fill-\[#[0-9A-F]{6}\]$/,
			);
		}
	});

	it("inherits the text color for monochrome brands", () => {
		// OpenAI, Ollama, OpenRouter, Z.ai and the Anthropic wordmark are
		// near-black or near-neutral by brand, so a literal hex would either
		// disappear on a dark card or wash out on a light one.
		for (const provider of [
			"codex",
			"openai-compatible",
			"ollama",
			"ollama-cloud",
			"openrouter",
			"zai",
			"anthropic-compatible",
		]) {
			expect(getProviderMark(provider)?.fill, provider).toBeUndefined();
		}
	});

	it("has no mark for unknown providers", () => {
		expect(getProviderMark("something-custom")).toBeUndefined();
	});

	it("does not resolve inherited object keys to a mark", () => {
		expect(getProviderMark("constructor")).toBeUndefined();
		expect(getProviderMark("toString")).toBeUndefined();
		expect(getProviderMark("__proto__")).toBeUndefined();
	});
});
