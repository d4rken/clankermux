import { describe, expect, it } from "bun:test";
import { providerDisplayName } from "../provider-display";

describe("providerDisplayName", () => {
	it("names subscriptions by vendor and API keys by product", () => {
		expect(providerDisplayName("anthropic")).toBe("Anthropic");
		expect(providerDisplayName("claude-console-api")).toBe("Claude API");
		expect(providerDisplayName("codex")).toBe("OpenAI");
		expect(providerDisplayName("grok-subscription")).toBe("xAI");
		expect(providerDisplayName("grok")).toBe("Grok API");
		expect(providerDisplayName("mimo")).toBe("Xiaomi");
	});

	it("title-cases an unknown provider key", () => {
		expect(providerDisplayName("brand-new_thing")).toBe("Brand New Thing");
	});
});
