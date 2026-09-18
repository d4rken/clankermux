import { expect, it } from "bun:test";
import { resolveModelCachePolicy } from "@clankermux/core";
import { makeAccount } from "@clankermux/test-support";
import { OpenAICompatibleProvider } from "../providers/openai/provider";

it("matches DashScope discovery to the endpoint-specific breakpoint injection", async () => {
	for (const [endpoint, explicit] of [
		["https://dashscope.aliyuncs.com/compatible-mode/v1", true],
		["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", false],
		[
			"https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
			false,
		],
	] as const) {
		const account = makeAccount({
			provider: "openai-compatible",
			custom_endpoint: endpoint,
		});
		const provider = new OpenAICompatibleProvider();
		const model = "qwen3-coder-plus";
		const request = new Request(
			provider.buildUrl("/v1/messages", "", account),
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: "A stable prefix" }],
					max_tokens: 10,
				}),
			},
		);
		const body = await (
			await provider.transformRequestBody(request, account)
		).json();
		expect(JSON.stringify(body).includes('"cache_control"')).toBe(explicit);
		const policy = resolveModelCachePolicy(model, [
			{
				provider: account.provider,
				customEndpoint: endpoint,
				format: "openai",
			},
		]);
		expect(policy?.mode).toBe(explicit ? "explicit" : "implicit");
		expect(policy?.defaultTtlMs).toBe(explicit ? 300_000 : undefined);
	}
});

it("preserves the advertised one-hour OpenRouter TTL through Anthropic-to-OpenAI conversion", async () => {
	const account = makeAccount({
		provider: "openai-compatible",
		custom_endpoint: "https://openrouter.ai/api/v1",
	});
	const provider = new OpenAICompatibleProvider();
	const model = "anthropic/claude-sonnet-4";
	const cache_control = { type: "ephemeral", ttl: "1h" };
	const request = new Request(provider.buildUrl("/v1/messages", "", account), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			system: [{ type: "text", text: "Stable instructions", cache_control }],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Stable prefix", cache_control }],
				},
			],
			max_tokens: 10,
		}),
	});
	const body = await (
		await provider.transformRequestBody(request, account)
	).json();
	expect(body.messages[0].content[0].cache_control).toEqual(cache_control);
	expect(body.messages[1].content[0].cache_control).toEqual(cache_control);
	expect(
		resolveModelCachePolicy(model, [
			{
				provider: account.provider,
				customEndpoint: account.custom_endpoint,
				format: "anthropic",
			},
		])?.supportedTtlMs,
	).toEqual([300_000, 3_600_000]);
});
