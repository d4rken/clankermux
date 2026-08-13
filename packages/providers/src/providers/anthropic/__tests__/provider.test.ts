import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OAuthRefreshTokenError } from "@clankermux/core";
import type { Account } from "@clankermux/types";
import { AnthropicProvider } from "../provider";

describe("AnthropicProvider", () => {
	let provider: AnthropicProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new AnthropicProvider();
		mockAccount = {
			id: "test-id",
			name: "test-anthropic-account",
			provider: "claude-oauth",
			refresh_token: "test-refresh-token",
			access_token: "test-access-token",
			expires_at: null,
			api_key: null,
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
			auto_pause_on_overage_enabled: false,
			model_mappings: null,
			cross_region_mode: null,
			model_fallbacks: null,
			billing_type: null,
		};
	});

	describe("processResponse", () => {
		it("preserves body and status", async () => {
			const body = JSON.stringify({ type: "message", content: "hello" });
			const original = new Response(body, {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "application/json" },
			});

			const result = await provider.processResponse(original, mockAccount);

			expect(result.status).toBe(200);
			expect(await result.text()).toBe(body);
		});

		it("strips content-encoding, content-length, and transfer-encoding headers", async () => {
			const original = new Response("body", {
				status: 200,
				headers: {
					"content-type": "application/json",
					"content-encoding": "gzip",
					"transfer-encoding": "chunked",
					"content-length": "4",
				},
			});

			const result = await provider.processResponse(original, mockAccount);

			expect(result.headers.get("content-encoding")).toBeNull();
			expect(result.headers.get("transfer-encoding")).toBeNull();
			expect(result.headers.get("content-length")).toBeNull();
		});

		it("preserves non-hop-by-hop headers", async () => {
			const original = new Response("body", {
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-request-id": "abc-123",
				},
			});

			const result = await provider.processResponse(original, mockAccount);

			expect(result.headers.get("content-type")).toBe("application/json");
			expect(result.headers.get("x-request-id")).toBe("abc-123");
		});

		it("preserves non-2xx status codes", async () => {
			const original = new Response(JSON.stringify({ error: "not found" }), {
				status: 404,
				statusText: "Not Found",
				headers: { "content-type": "application/json" },
			});

			const result = await provider.processResponse(original, mockAccount);

			expect(result.status).toBe(404);
		});
	});

	describe("transformRequestBody", () => {
		function makeRequest(model: string): Request {
			return new Request("https://api.anthropic.com/v1/messages", {
				method: "POST",
				body: JSON.stringify({ model, max_tokens: 100 }),
				headers: { "Content-Type": "application/json" },
			});
		}

		it("passes model through unchanged when no account provided", async () => {
			const request = makeRequest("claude-sonnet-4-5-20250929");
			const result = await provider.transformRequestBody(request, undefined);
			const body = await result.json();
			expect(body.model).toBe("claude-sonnet-4-5-20250929");
		});

		it("passes model through unchanged when account has no model_mappings", async () => {
			const account = { ...mockAccount, model_mappings: null };
			const request = makeRequest("claude-sonnet-4-5-20250929");
			const result = await provider.transformRequestBody(request, account);
			const body = await result.json();
			expect(body.model).toBe("claude-sonnet-4-5-20250929");
		});

		it("applies matching model mapping to transform the model", async () => {
			const account = {
				...mockAccount,
				model_mappings: JSON.stringify({ sonnet: "custom-model" }),
			};
			const request = makeRequest("claude-sonnet-4-5-20250929");
			const result = await provider.transformRequestBody(request, account);
			const body = await result.json();
			expect(body.model).toBe("custom-model");
		});

		it("passes model through unchanged when mapping exists for a different family", async () => {
			const account = {
				...mockAccount,
				model_mappings: JSON.stringify({ opus: "custom-opus" }),
			};
			const request = makeRequest("claude-sonnet-4-5-20250929");
			const result = await provider.transformRequestBody(request, account);
			const body = await result.json();
			// No sonnet mapping exists; mapModelName falls back to the sonnet default
			// which is the opus mapping only when no sonnet key exists — so model is unchanged
			expect(body.model).toBe("claude-sonnet-4-5-20250929");
		});

		it("applies the correct mapping when multiple model families are configured", async () => {
			const account = {
				...mockAccount,
				model_mappings: JSON.stringify({
					sonnet: "mapped-sonnet",
					opus: "mapped-opus",
				}),
			};

			const sonnetRequest = makeRequest("claude-sonnet-4-5-20250929");
			const sonnetResult = await provider.transformRequestBody(
				sonnetRequest,
				account,
			);
			const sonnetBody = await sonnetResult.json();
			expect(sonnetBody.model).toBe("mapped-sonnet");

			const opusRequest = makeRequest("claude-opus-4-1-20250805");
			const opusResult = await provider.transformRequestBody(
				opusRequest,
				account,
			);
			const opusBody = await opusResult.json();
			expect(opusBody.model).toBe("mapped-opus");
		});
	});

	describe("refreshToken", () => {
		const origFetch = globalThis.fetch;

		function mockTokenResponse(status: number, body: unknown) {
			globalThis.fetch = (async () =>
				new Response(typeof body === "string" ? body : JSON.stringify(body), {
					status,
					headers: { "Content-Type": "application/json" },
				})) as unknown as typeof fetch;
		}

		afterEach(() => {
			globalThis.fetch = origFetch;
		});

		it("throws OAuthRefreshTokenError on HTTP 400 invalid_grant", async () => {
			mockTokenResponse(400, {
				error: "invalid_grant",
				error_description: "Refresh token not found or invalid",
			});
			await expect(
				provider.refreshToken(mockAccount, "client-id"),
			).rejects.toBeInstanceOf(OAuthRefreshTokenError);
		});

		it("throws OAuthRefreshTokenError on HTTP 401 invalid_grant", async () => {
			mockTokenResponse(401, {
				error: "invalid_grant",
				error_description: "invalid_grant",
			});
			await expect(
				provider.refreshToken(mockAccount, "client-id"),
			).rejects.toBeInstanceOf(OAuthRefreshTokenError);
		});

		it("throws OAuthRefreshTokenError on invalid_refresh_token", async () => {
			mockTokenResponse(400, {
				error: "invalid_refresh_token",
				error_description: "The refresh token is invalid",
			});
			await expect(
				provider.refreshToken(mockAccount, "client-id"),
			).rejects.toBeInstanceOf(OAuthRefreshTokenError);
		});

		it("detects invalid_grant in a non-JSON body", async () => {
			mockTokenResponse(400, "error: invalid_grant — please reauthenticate");
			await expect(
				provider.refreshToken(mockAccount, "client-id"),
			).rejects.toBeInstanceOf(OAuthRefreshTokenError);
		});

		it("throws a generic Error (not OAuthRefreshTokenError) on a 500", async () => {
			mockTokenResponse(500, { error: "internal_error" });
			const err = await provider
				.refreshToken(mockAccount, "client-id")
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			expect(err).not.toBeInstanceOf(OAuthRefreshTokenError);
		});
	});
});
