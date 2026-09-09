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

		it("keeps sub-paths below /v1/messages intact", () => {
			expect(
				provider.buildUrl("/v1/messages/count_tokens", "", mockAccount),
			).toBe("https://openrouter.ai/api/v1/messages/count_tokens");
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
