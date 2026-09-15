import { describe, expect, it } from "bun:test";
import { makeAccount } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import { QwenProvider } from "../provider";

/**
 * A qwen account keeps its DashScope host in `custom_endpoint`, written from the
 * OAuth token response's `resource_url`. `OpenAICompatibleProvider` falls back
 * to `api.openai.com` when that column yields nothing, which for qwen means
 * handing a DashScope bearer token to OpenAI — a token leak, not a degraded
 * route. The provider overrides the fallback; these pin every path that reaches
 * it, including the ones where the stored value is present but unusable.
 */

const DASHSCOPE = "dashscope.aliyuncs.com";

function hostOf(url: string): string {
	return new URL(url).hostname;
}

function qwenAccount(customEndpoint: string | null): Account {
	return makeAccount({ provider: "qwen", custom_endpoint: customEndpoint });
}

describe("QwenProvider endpoint fallback", () => {
	const provider = new QwenProvider();
	const build = (account?: Account) =>
		provider.buildUrl("/v1/messages", "", account);

	it("never falls back to OpenAI", () => {
		// The property that matters, stated once over every fallback input.
		for (const account of [
			undefined,
			qwenAccount(null),
			qwenAccount(""),
			qwenAccount("   "),
			qwenAccount("not-a-url"),
			qwenAccount("{"),
			qwenAccount("{}"),
		]) {
			expect(hostOf(build(account))).not.toBe("api.openai.com");
		}
	});

	it("uses DashScope when the account carries no endpoint at all", () => {
		expect(hostOf(build(undefined))).toBe(DASHSCOPE);
		expect(hostOf(build(qwenAccount(null)))).toBe(DASHSCOPE);
	});

	it("uses DashScope for an empty or whitespace-only endpoint", () => {
		expect(hostOf(build(qwenAccount("")))).toBe(DASHSCOPE);
		expect(hostOf(build(qwenAccount("   ")))).toBe(DASHSCOPE);
	});

	it("uses DashScope when the stored endpoint is unusable", () => {
		// The parent logs and falls back on a validation throw; that fallback has
		// to be DashScope too, not just the missing-value one.
		expect(hostOf(build(qwenAccount("not-a-url")))).toBe(DASHSCOPE);
		expect(hostOf(build(qwenAccount("{")))).toBe(DASHSCOPE);
		expect(hostOf(build(qwenAccount("{}")))).toBe(DASHSCOPE);
	});

	it("honours a real regional endpoint", () => {
		const url = build(qwenAccount("https://dashscope-intl.aliyuncs.com/v1"));
		expect(hostOf(url)).toBe("dashscope-intl.aliyuncs.com");
	});

	it("keeps the parent's /v1 de-duplication on the fallback host", () => {
		// The configured default already ends in /v1, so the converted
		// /v1/chat/completions must not produce /v1/v1/chat/completions.
		expect(build(qwenAccount(null))).not.toContain("/v1/v1/");
	});
});
