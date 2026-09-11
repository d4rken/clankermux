import { describe, expect, it } from "bun:test";
import { parseOpenRouterMetadata } from "@clankermux/providers";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenRouterAccountDetails } from "./OpenRouterAccountDetails";

describe("OpenRouter account details", () => {
	it("labels key budget separately from balance and displays creator identity and zero usage", () => {
		const metadata = parseOpenRouterMetadata(
			{
				data: {
					label: "redacted...key",
					creator_user_id: "user_123",
					is_free_tier: false,
					limit: 100,
					limit_remaining: 75,
					limit_reset: "monthly",
					usage: 25,
					usage_daily: 0,
				},
			},
			1_700_000_000_000,
		);
		const html = renderToStaticMarkup(
			<OpenRouterAccountDetails metadata={metadata} />,
		);
		for (const text of [
			"redacted...key",
			"user_123",
			"Paid",
			"Key spending limit",
			"$100.00",
			"monthly",
			"Key budget remaining",
			"$75.00",
			"Today",
			"$0.00",
			"Updated",
			"does not provide the account email",
		])
			expect(html).toContain(text);
		expect(html).not.toContain("balance");
	});
	it("does not turn missing limits or usage into zero balances", () => {
		const html = renderToStaticMarkup(
			<OpenRouterAccountDetails
				metadata={parseOpenRouterMetadata({ data: { label: "key" } })}
			/>,
		);
		expect(html).not.toContain("$0.00");
		expect(html).not.toContain("Key spending limit");
		expect(html).not.toContain("Paid");
	});
	it("offers a retry when metadata is unavailable", () => {
		expect(renderToStaticMarkup(<OpenRouterAccountDetails />)).toContain(
			"Use Refresh to try again",
		);
	});
});
