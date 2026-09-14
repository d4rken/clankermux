import { beforeEach, describe, expect, it } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import { KiloProvider } from "../provider";

describe("KiloProvider", () => {
	let provider: KiloProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new KiloProvider();
		mockAccount = canonicalAccount({
			id: "test-id",
			name: "test-kilo-account",
			provider: "kilo",
			refresh_token: "test-api-key",
			api_key: "test-api-key",
			created_at: Date.now(),
		});
	});

	describe("name", () => {
		it("should have the correct provider name", () => {
			expect(provider.name).toBe("kilo");
		});
	});

	describe("buildUrl", () => {
		it("should route /v1/messages to /chat/completions on kilo gateway", () => {
			const url = provider.buildUrl("/v1/messages", "", mockAccount);
			expect(url).toBe("https://api.kilo.ai/api/gateway/chat/completions");
		});

		it("should include query string", () => {
			const url = provider.buildUrl(
				"/v1/messages",
				"?stream=true",
				mockAccount,
			);
			expect(url).toBe(
				"https://api.kilo.ai/api/gateway/chat/completions?stream=true",
			);
		});

		it("should strip /v1 prefix from other paths", () => {
			const url = provider.buildUrl("/v1/models", "", mockAccount);
			expect(url).toBe("https://api.kilo.ai/api/gateway/models");
		});

		it("should use custom endpoint when provided", () => {
			const accountWithCustomEndpoint = {
				...mockAccount,
				custom_endpoint: "https://custom.kilo.example.com/gateway",
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"",
				accountWithCustomEndpoint,
			);
			expect(url).toBe(
				"https://custom.kilo.example.com/gateway/chat/completions",
			);
		});

		it("should strip trailing slash from custom endpoint", () => {
			const accountWithCustomEndpoint = {
				...mockAccount,
				custom_endpoint: "https://custom.kilo.example.com/gateway/",
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"",
				accountWithCustomEndpoint,
			);
			expect(url).toBe(
				"https://custom.kilo.example.com/gateway/chat/completions",
			);
		});
	});
});
