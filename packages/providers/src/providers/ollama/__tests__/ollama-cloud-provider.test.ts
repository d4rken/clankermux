import { describe, expect, it } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import { OllamaCloudProvider } from "../ollama-cloud-provider";

/** `config` is protected on the base class; the constructor sets it. */
class ConfigReadableProvider extends OllamaCloudProvider {
	get streamingConfigured(): boolean | undefined {
		return this.config.supportsStreaming;
	}
}

describe("OllamaCloudProvider", () => {
	const provider = new OllamaCloudProvider();

	const makeAccount = (): Account =>
		canonicalAccount({
			id: "ollama-cloud-1",
			name: "ollama-cloud-test",
			provider: "ollama-cloud",
			refresh_token: "sk-test-token",
			created_at: Date.now(),
		});

	describe("constructor", () => {
		it("instantiates without errors", () => {
			expect(() => new OllamaCloudProvider()).not.toThrow();
		});
	});

	describe("name", () => {
		it('should be "ollama-cloud"', () => {
			expect(provider.name).toBe("ollama-cloud");
		});
	});

	describe("getEndpoint", () => {
		it("returns the Ollama Cloud endpoint", () => {
			expect(provider.getEndpoint()).toBe("https://ollama.com");
		});
	});

	describe("getAuthHeader", () => {
		it("returns authorization", () => {
			expect(provider.getAuthHeader()).toBe("authorization");
		});
	});

	describe("getAuthType", () => {
		it("returns bearer", () => {
			expect(provider.getAuthType()).toBe("bearer");
		});
	});

	describe("canHandle", () => {
		it("returns true for any path", () => {
			expect(provider.canHandle("/v1/messages")).toBe(true);
		});
	});

	describe("buildUrl", () => {
		it("routes /v1/messages to ollama.com", () => {
			const url = provider.buildUrl("/v1/messages", "");
			expect(url).toBe("https://ollama.com/v1/messages");
		});

		it("preserves query string", () => {
			const url = provider.buildUrl("/v1/messages", "?stream=true");
			expect(url).toBe("https://ollama.com/v1/messages?stream=true");
		});

		it("handles custom paths", () => {
			const url = provider.buildUrl("/api/tags", "");
			expect(url).toBe("https://ollama.com/api/tags");
		});
	});

	describe("prepareHeaders", () => {
		it("sets Bearer token with authorization header", () => {
			const headers = new Headers({
				"x-api-key": "old-key",
				"anthropic-version": "2023-06-01",
				host: "localhost:8081",
				"accept-encoding": "gzip",
			});

			const result = provider.prepareHeaders(headers, "sk-ollama-token");

			expect(result.get("Authorization")).toBe("Bearer sk-ollama-token");
			expect(result.has("x-api-key")).toBe(false);
			expect(result.has("anthropic-version")).toBe(false);
			expect(result.has("host")).toBe(false);
			expect(result.has("accept-encoding")).toBe(false);
		});

		it("removes existing authorization header before setting new one", () => {
			const headers = new Headers({
				authorization: "Bearer old-token",
			});

			const result = provider.prepareHeaders(headers, "sk-new-token");

			expect(result.get("Authorization")).toBe("Bearer sk-new-token");
		});

		it("handles empty token gracefully", () => {
			const headers = new Headers({
				"x-api-key": "some-key",
			});

			const result = provider.prepareHeaders(headers, "");

			expect(result.has("x-api-key")).toBe(true);
			expect(result.has("Authorization")).toBe(false);
			expect(result.has("host")).toBe(false);
			expect(result.has("accept-encoding")).toBe(false);
		});

		it("uses apiKey when accessToken is not provided", () => {
			const headers = new Headers();

			const result = provider.prepareHeaders(headers, undefined, "sk-api-key");

			expect(result.get("Authorization")).toBe("Bearer sk-api-key");
		});

		it("prefers accessToken over apiKey", () => {
			const headers = new Headers();

			const result = provider.prepareHeaders(headers, "sk-access", "sk-api");

			expect(result.get("Authorization")).toBe("Bearer sk-access");
		});

		it("strips host and accept-encoding even without credentials", () => {
			const headers = new Headers({
				host: "localhost:8081",
				"accept-encoding": "gzip, deflate",
			});

			const result = provider.prepareHeaders(headers);

			expect(result.has("host")).toBe(false);
			expect(result.has("accept-encoding")).toBe(false);
		});
	});

	describe("supportsStreaming", () => {
		it("supports streaming", () => {
			expect(new ConfigReadableProvider().streamingConfigured).toBe(true);
		});

		it("detects streaming responses by content-type", () => {
			const streamResponse = new Response("", {
				headers: { "Content-Type": "text/event-stream" },
			});
			expect(provider.isStreamingResponse?.(streamResponse)).toBe(true);
		});
	});

	describe("transformRequestBody (model mapping)", () => {
		it("maps model name via model_mappings", async () => {
			const account = makeAccount();
			const request = new Request("https://ollama.com/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hi" }],
					stream: true,
				}),
			});

			const transformed = await provider.transformRequestBody(request, account);
			const body = await transformed.json();

			expect(body.model).toBe("claude-sonnet-4-5");
		});

		it("passes through model unchanged without model_mappings", async () => {
			const account = makeAccount();
			const request = new Request("https://ollama.com/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gemma3:4b",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});

			const transformed = await provider.transformRequestBody(request, account);
			const body = await transformed.json();

			expect(body.model).toBe("gemma3:4b");
		});
	});
});
