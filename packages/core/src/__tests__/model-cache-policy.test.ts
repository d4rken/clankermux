import { describe, expect, it } from "bun:test";
import { type ClientFormat, PROVIDER_NAMES } from "@clankermux/types";
import { resolveModelCachePolicy } from "../model-metadata";

const unknown = {
	mode: "unknown",
	expiry: "unavailable",
	source: "unknown",
} as const;
const implicit = {
	mode: "implicit",
	expiry: "unavailable",
	source: "gateway-policy",
} as const;

function policy(
	provider: string,
	model: string,
	format: ClientFormat = "anthropic",
	customEndpoint?: string,
) {
	return resolveModelCachePolicy(model, [{ provider, format, customEndpoint }]);
}

describe("provider cache policies", () => {
	it("does not infer language-model caching for GLM or Grok media-only variants", () => {
		for (const model of [
			"glm-4.5v",
			"glm-4v-plus",
			"glm-4-voice",
			"glm-6-unverified",
		]) {
			expect(policy("zai", model)).toEqual(unknown);
			expect(policy("openrouter", `z-ai/${model}`)).toEqual(unknown);
		}
		expect(policy("openrouter", "x-ai/grok-imagine-image")).toEqual(unknown);
	});
	it("recognizes documented automatic caching on official compatible API endpoints", () => {
		for (const [endpoint, model] of [
			["https://api.deepseek.com/v1", "deepseek-chat"],
			["https://api.moonshot.ai/v1", "kimi-k2.5"],
			["https://api.x.ai/v1", "grok-4.6"],
			["https://api.z.ai/api/paas/v4", "glm-5.1"],
			[
				"https://generativelanguage.googleapis.com/v1beta/openai",
				"gemini-2.5-pro",
			],
			["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen-plus"],
		]) {
			expect(policy("openai-compatible", model, "openai", endpoint)).toEqual(
				implicit,
			);
		}
	});

	it("scopes compatible API policies to documented models and deployment regions", () => {
		for (const [endpoint, model] of [
			["https://api.groq.com/openai/v1", "openai/gpt-oss-120b"],
			["https://api.groq.com/openai/v1", "openai/gpt-oss-20b"],
			["https://api.groq.com/openai/v1", "openai/gpt-oss-safeguard-20b"],
		]) {
			expect(policy("openai-compatible", model, "openai", endpoint)).toEqual({
				...implicit,
				defaultTtlMs: 7_200_000,
				refreshOnReuse: true,
				ttlAnchor: "unknown",
				ttlSemantics: "configured",
			});
		}
		for (const [endpoint, model] of [
			["https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
			["https://api.mistral.ai/v1", "mistral-large-latest"],
			[
				"https://generativelanguage.googleapis.com/v1beta/openai",
				"gemini-1.5-pro",
			],
			[
				"https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
				"qwen3.6-plus",
			],
			["https://coding-intl.dashscope.aliyuncs.com/v1", "qwen3-coder-plus"],
			[
				"https://dashscope-us.aliyuncs.com/compatible-mode/v1",
				"qwen3-coder-plus",
			],
			["https://api.x.ai/v1", "grok-imagine-image"],
		]) {
			expect(policy("openai-compatible", model, "openai", endpoint)).toEqual(
				unknown,
			);
		}
	});

	it("describes explicit caching injected by the gateway on legacy Beijing DashScope Qwen routes", () => {
		for (const model of ["qwen3-coder-plus", "qwen3.6-plus", "qwen3.5-plus"]) {
			for (const format of ["anthropic", "openai", "codex"] as const) {
				expect(
					policy(
						"openai-compatible",
						model,
						format,
						"https://dashscope.aliyuncs.com/compatible-mode/v1",
					),
				).toEqual({
					mode: "explicit",
					expiry: "unavailable",
					source: "gateway-policy",
					defaultTtlMs: 300_000,
					refreshOnReuse: true,
					ttlAnchor: "unknown",
					ttlSemantics: "configured",
				});
			}
		}
		expect(
			policy(
				"openai-compatible",
				"qwen3-coder-plus",
				"openai",
				"https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
			),
		).toEqual(implicit);
	});

	it("publishes OpenRouter's model-specific capabilities without using its routing-affinity timeout", () => {
		for (const model of [
			"deepseek/deepseek-v3.2",
			"z-ai/glm-5.1",
			"x-ai/grok-4",
			"moonshotai/kimi-k2.5",
		]) {
			expect(policy("openrouter", model)).toEqual(implicit);
		}
		const claude = policy("openrouter", "anthropic/claude-sonnet-4");
		expect(claude).toMatchObject({
			mode: "explicit",
			defaultTtlMs: 300_000,
			supportedTtlMs: [300_000, 3_600_000],
			expiry: "unavailable",
			ttlAnchor: "unknown",
		});
		expect(policy("openrouter", "anthropic/claude-sonnet-4", "openai")).toEqual(
			unknown,
		);
		expect(policy("openrouter", "google/gemini-2.5-pro")).toEqual({
			...implicit,
			ttlSemantics: "typical",
		});
		expect(policy("openrouter", "qwen/qwen3-coder-plus")?.mode).toBe(
			"explicit",
		);
		expect(policy("openrouter", "openrouter/auto")).toEqual(unknown);
		expect(
			policy(
				"openrouter",
				"openai/gpt-6-astra",
				"anthropic",
				"https://unverified.example",
			),
		).toEqual(unknown);
	});

	it("separates MiniMax's explicit-only M2 cache from later automatic caching", () => {
		expect(policy("minimax", "MiniMax-M2")).toEqual({
			mode: "explicit",
			expiry: "unavailable",
			source: "gateway-policy",
			defaultTtlMs: 300_000,
			refreshOnReuse: true,
			ttlAnchor: "unknown",
			ttlSemantics: "configured",
		});
		expect(policy("minimax", "MiniMax-M2", "openai")).toEqual(unknown);
		expect(policy("minimax", "MiniMax-M2.7")).toEqual(implicit);
	});

	it("represents an unverified model for every registered provider without inventing retention", () => {
		for (const provider of Object.values(PROVIDER_NAMES)) {
			const result = policy(provider, "unverified-model", "openai");
			expect(result).toBeDefined();
			expect(result?.expiry).toBe("unavailable");
			expect(result?.defaultTtlMs).toBeUndefined();
			expect(result?.supportedTtlMs).toBeUndefined();
		}
	});

	it("publishes Codex caching independently of API retention and client format", () => {
		for (const format of ["anthropic", "openai", "codex"] as const) {
			for (const model of [
				"gpt-6-astra",
				"gpt-6-astra-2026-09-03",
				"gpt-5.6-sol",
				"gpt-5.5",
			]) {
				expect(policy("codex", model, format)).toEqual(implicit);
			}
		}
	});

	it("publishes the direct API minimum without asserting an undocumented request timestamp anchor", () => {
		for (const model of [
			"gpt-6-astra",
			"gpt-5.6",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]) {
			expect(policy("openai-compatible", model, "openai")).toEqual({
				...implicit,
				defaultTtlMs: 1_800_000,
				refreshOnReuse: true,
				ttlAnchor: "unknown",
				ttlSemantics: "minimum",
			});
		}
	});

	it("does not advertise selectable API TTLs without knowing whether the client uses Responses", () => {
		const endpoint = "https://api.openai.com/v1/responses";
		expect(
			policy("codex", "gpt-6-astra", "openai", endpoint)?.supportedTtlMs,
		).toBeUndefined();
		expect(
			policy("codex", "gpt-6-astra", "anthropic", endpoint)?.supportedTtlMs,
		).toBeUndefined();
		expect(
			policy("codex", "gpt-6-astra", "codex", endpoint)?.supportedTtlMs,
		).toBeUndefined();
	});

	it("does not turn older API retention caps or typical periods into a guaranteed TTL", () => {
		for (const model of [
			"gpt-4o",
			"gpt-4.1",
			"gpt-5",
			"gpt-5.5",
			"o3",
			"o4-mini",
		]) {
			const result = policy("openai-compatible", model);
			expect(result?.mode).toBe("implicit");
			expect(result?.expiry).toBe("unavailable");
			expect(result?.ttlSemantics).toBe("typical");
			expect(result?.defaultTtlMs).toBeUndefined();
			expect(result?.supportedTtlMs).toBeUndefined();
		}
		expect(policy("openai-compatible", "gpt-9-unannounced")).toEqual(unknown);
	});

	it("recognizes official API origins without trusting lookalike hosts or arbitrary paths", () => {
		const direct = policy("openai-compatible", "gpt-6-astra");
		for (const endpoint of [
			"https://api.openai.com",
			"https://api.openai.com/v1",
			'{"endpoint":"https://api.openai.com/v1"}',
		]) {
			expect(
				policy("openai-compatible", "gpt-6-astra", "anthropic", endpoint),
			).toEqual(direct);
		}
		for (const endpoint of [
			"https://api.openai.com.proxy.example/v1",
			"https://proxy.example/v1",
			"https://api.openai.com/arbitrary",
			"http://api.openai.com",
			"https://api.openai.com:444/v1",
			"https://user:password@api.openai.com/v1",
			"invalid-url",
		]) {
			expect(
				policy("openai-compatible", "gpt-6-astra", "anthropic", endpoint),
			).toEqual(unknown);
		}
		expect(
			policy(
				"codex",
				"gpt-6-astra",
				"openai",
				"https://proxy.example/responses",
			),
		).toEqual(unknown);
	});

	it("supports Claude aliases and dated IDs without claiming translated clients can select a TTL", () => {
		const direct = policy("anthropic", "claude-haiku-4-5-20251001");
		for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-latest"]) {
			expect(policy("anthropic", model)).toEqual(direct);
		}
		expect(
			policy(
				"anthropic-compatible",
				"claude-haiku-4-5",
				"anthropic",
				"https://api.anthropic.com/v1",
			),
		).toEqual(direct);
		for (const format of ["openai", "codex"] as const) {
			expect(policy("anthropic", "claude-haiku-4-5", format)).toEqual(unknown);
		}
	});

	it("publishes automatic Z.ai, MiniMax and xAI caching without invented TTLs", () => {
		for (const [provider, model] of [
			["zai", "glm-5.1"],
			["minimax", "MiniMax-M2.7"],
			["minimax", "MiniMax-M3"],
			["grok", "grok-4"],
		]) {
			for (const format of ["anthropic", "openai", "codex"] as const) {
				expect(policy(provider, model, format)).toEqual(implicit);
			}
			// These fixed-endpoint adapters ignore stale custom_endpoint values.
			expect(
				policy(provider, model, "anthropic", "https://ignored.example"),
			).toEqual(implicit);
		}
	});

	it("does not invent lifetime from a subscription product, aggregator, model-load timeout, or compatible protocol", () => {
		for (const [provider, model] of [
			["alibaba-coding-plan", "qwen3-coder-plus"],
			["qwen", "coder-model"],
			["ollama", "llama3.2"],
			["ollama-cloud", "gpt-oss:120b"],
			["mimo", "mimo-v2.6-pro"],
			["devin", "swe-2"],
			["anthropic-compatible", "claude-opus-4-8"],
		]) {
			const result = policy(provider, model);
			expect(result?.expiry).toBe("unavailable");
			expect(result?.defaultTtlMs).toBeUndefined();
		}
		expect(policy("future-provider", "gpt-6-astra")).toEqual(unknown);
	});

	it("reduces API and subscription routes to their common cache capability", () => {
		const result = resolveModelCachePolicy("gpt-6-astra", [
			{ provider: "codex", format: "openai" },
			{ provider: "openai-compatible", format: "openai" },
		]);
		expect(result).toEqual(implicit);
		expect(
			resolveModelCachePolicy("gpt-6-astra", [
				{ provider: "codex", format: "openai" },
				{
					provider: "openai-compatible",
					format: "openai",
					customEndpoint: "https://custom.example",
				},
			]),
		).toEqual(unknown);
	});

	it("leaves unresolved or absent routes unenriched", () => {
		expect(resolveModelCachePolicy("gpt-6-astra", [])).toBeUndefined();
		expect(
			resolveModelCachePolicy(
				"gpt-6-astra",
				[{ provider: "codex", format: "openai" }],
				true,
			),
		).toBeUndefined();
	});
});
