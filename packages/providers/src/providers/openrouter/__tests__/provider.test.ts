import { beforeEach, describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import { OpenRouterProvider } from "../provider";

describe("OpenRouterProvider", () => {
	let provider: OpenRouterProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new OpenRouterProvider();
		mockAccount = {
			id: "test-id",
			name: "test-openrouter-account",
			provider: "openrouter",
			refresh_token: "test-api-key",
			access_token: null,
			expires_at: null,
			api_key: "test-api-key",
			custom_endpoint: null,
			rate_limited_until: null,
			rate_limit_status: null,
			rate_limit_reset: null,
			rate_limit_remaining: null,
			created_at: Date.now(),
			last_used: null,
			request_count: 0,
			total_requests: 0,
			session_start: null,
			session_request_count: 0,
			paused: false,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
		};
	});

	describe("getEndpoint", () => {
		it("returns the OpenRouter Anthropic-compatible base URL", () => {
			expect(provider.getEndpoint()).toBe("https://openrouter.ai/api/v1");
		});
	});

	describe("buildUrl", () => {
		it("does not double the /v1 segment already present in the base URL", () => {
			expect(provider.buildUrl("/v1/messages", "", mockAccount)).toBe(
				"https://openrouter.ai/api/v1/messages",
			);
		});

		it("preserves the query string", () => {
			expect(provider.buildUrl("/v1/messages", "?beta=true", mockAccount)).toBe(
				"https://openrouter.ai/api/v1/messages?beta=true",
			);
		});

		it("routes count_tokens to the local estimate", () => {
			expect(
				provider.buildUrl("/v1/messages/count_tokens", "", mockAccount),
			).toBe("https://clankermux.local/openrouter/count_tokens");
		});

		it.each([
			"https://proxy.example.com",
			"https://proxy.example.com/api/v1",
		])("preserves upstream counts at custom endpoint %s", async (custom_endpoint) => {
			const account = { ...mockAccount, custom_endpoint };
			const url = provider.buildUrl("/v1/messages/count_tokens", "", account);
			expect(url).toBe(
				custom_endpoint +
					(custom_endpoint.endsWith("/v1")
						? "/messages/count_tokens"
						: "/v1/messages/count_tokens"),
			);
			const body = {
				model: "m",
				messages: [{ role: "user", content: "hello" }],
			};
			const transformed = await provider.transformRequestBody(
				new Request(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			);
			expect(
				transformed.headers.get("x-clankermux-synthetic-response"),
			).toBeNull();
			expect(await transformed.json()).toEqual(body);
		});

		it("dedups /v1 against a custom endpoint whose path ends in /v1", () => {
			const account = {
				...mockAccount,
				custom_endpoint: "https://proxy.example.com/api/v1",
			};
			expect(provider.buildUrl("/v1/messages", "", account)).toBe(
				"https://proxy.example.com/api/v1/messages",
			);
		});

		it("strips a trailing slash from the custom endpoint before dedup", () => {
			const account = {
				...mockAccount,
				custom_endpoint: "https://proxy.example.com/api/v1/",
			};
			expect(provider.buildUrl("/v1/messages", "", account)).toBe(
				"https://proxy.example.com/api/v1/messages",
			);
		});

		it("keeps /v1 when the custom endpoint path does not end in /v1", () => {
			const account = {
				...mockAccount,
				custom_endpoint: "https://proxy.example.com/gateway",
			};
			expect(provider.buildUrl("/v1/messages", "", account)).toBe(
				"https://proxy.example.com/gateway/v1/messages",
			);
		});

		it("only strips /v1 on a segment boundary", () => {
			expect(provider.buildUrl("/v1beta/messages", "", mockAccount)).toBe(
				"https://openrouter.ai/api/v1/v1beta/messages",
			);
		});
	});

	describe("prepareHeaders", () => {
		it("sends the API key as a Bearer authorization header", () => {
			const headers = new Headers({ "content-type": "application/json" });
			const prepared = provider.prepareHeaders(
				headers,
				undefined,
				"or-key-123",
			);

			expect(prepared.get("authorization")).toBe("Bearer or-key-123");
			expect(prepared.get("content-type")).toBe("application/json");
		});

		it("replaces inbound client credentials with the account's Bearer token", () => {
			const headers = new Headers({
				authorization: "Bearer client-token",
				"x-api-key": "client-key",
			});
			const prepared = provider.prepareHeaders(headers, "account-token");

			expect(prepared.get("authorization")).toBe("Bearer account-token");
			expect(prepared.get("x-api-key")).toBeNull();
		});
	});
});

describe("OpenRouter conversation reasoning configuration", () => {
	const provider = new OpenRouterProvider();
	const body = (model = "deepseek/deepseek-v4-pro") => ({
		model,
		thinking: { type: "adaptive" },
		output_config: { effort: "low", format: { type: "text" } },
		messages: [
			{ role: "user", content: "hello" },
			{
				role: "system",
				content: [
					{
						type: "text",
						text: "tokens left",
						cache_control: { type: "ephemeral" },
					},
				],
				output_config: { effort: "high" },
			},
		],
	});
	const req = (value: unknown) =>
		new Request("https://openrouter.ai/api/v1/messages", {
			method: "POST",
			body: JSON.stringify(value),
		});
	it("folds the last effort into current configuration and preserves message position/content", async () => {
		const original = body();
		const result = await provider.transformRequestBody(req(original));
		const j = await result.clone().json();
		expect(j).toEqual({
			...original,
			output_config: { effort: "high", format: { type: "text" } },
			messages: [
				original.messages[0],
				{ role: "system", content: original.messages[1].content },
			],
		});
		expect(await (await provider.transformRequestBody(result)).text()).toBe(
			JSON.stringify(j),
		);
	});
	it.each([
		"anthropic/claude-fable-5-1",
		"claude-fable-5-1",
	])("preserves %s bytes", async (model) => {
		const request = req(body(model));
		expect(await provider.transformRequestBody(request)).toBe(request);
	});
	it("leaves unknown message controls for the upstream to validate", async () => {
		const original = body();
		original.messages[1].output_config = {
			...original.messages[1].output_config,
			unknown: true,
		} as (typeof original.messages)[1]["output_config"];
		const request = req(original);
		expect(await (await provider.transformRequestBody(request)).json()).toEqual(
			original,
		);
	});
});

describe("OpenRouter effort ordering", () => {
	it.each([
		["low", "high", "low"],
		["high", "low", "high"],
	])("applies updates in conversation order (%s,%s,%s)", async (first, second, last) => {
		const provider = new OpenRouterProvider();
		const request = new Request("https://openrouter.ai/api/v1/messages", {
			method: "POST",
			body: JSON.stringify({
				model: "deepseek/deepseek-v4-pro",
				output_config: { effort: first },
				messages: [
					{ role: "system", content: "one", output_config: { effort: second } },
					{ role: "system", content: "two", output_config: { effort: last } },
				],
			}),
		});
		const body = await (await provider.transformRequestBody(request)).json();
		expect(body.output_config.effort).toBe(last);
		expect(body.messages).toEqual([
			{ role: "system", content: "one" },
			{ role: "system", content: "two" },
		]);
	});
});

describe("OpenRouter malformed body preservation", () => {
	it.each([
		["high"],
		[42],
		[null],
		[[]],
	])("leaves malformed top-level output_config %j for upstream validation", async (output_config) => {
		const provider = new OpenRouterProvider();
		const request = new Request("https://openrouter.ai/api/v1/messages", {
			method: "POST",
			body: JSON.stringify({
				model: "deepseek/deepseek-v4-pro",
				output_config,
				messages: [
					{
						role: "system",
						content: "notice",
						output_config: { effort: "low" },
					},
				],
			}),
		});
		expect(await provider.transformRequestBody(request)).toBe(request);
	});
	it("leaves a non-JSON POST unchanged", async () => {
		const request = new Request("https://openrouter.ai/api/v1/messages", {
			method: "POST",
			body: "not json",
		});
		expect(await new OpenRouterProvider().transformRequestBody(request)).toBe(
			request,
		);
	});
});
