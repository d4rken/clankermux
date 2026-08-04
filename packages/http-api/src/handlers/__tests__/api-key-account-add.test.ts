import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@clankermux/database";
import { DatabaseFactory } from "@clankermux/database";
import {
	API_KEY_PROVIDERS,
	createApiKeyAccountAddHandler,
} from "../api-key-account-add";

const TEST_DB_PATH = "/tmp/test-api-key-account-add.db";

function post(body: unknown): Request {
	return new Request("http://localhost/api/accounts/x", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("createApiKeyAccountAddHandler", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(() => {
		DatabaseFactory.reset();
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
	});

	function row(name: string) {
		return dbOps
			.getDatabase()
			.query<
				{
					provider: string;
					api_key: string;
					refresh_token: string | null;
					access_token: string | null;
					custom_endpoint: string | null;
					model_mappings: string | null;
				},
				[string]
			>(
				`SELECT provider, api_key, refresh_token, access_token,
				        custom_endpoint, model_mappings
				 FROM accounts WHERE name = ?`,
			)
			.get(name);
	}

	describe("provider identity", () => {
		it("writes the spec's provider string, not the spec key", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.openai,
			);

			const res = await handler(
				post({
					name: "acct",
					apiKey: "k",
					customEndpoint: "https://example.test/v1",
				}),
			);

			expect(res.status).toBe(200);
			expect(row("acct")?.provider).toBe("openai-compatible");
		});

		it("uses the spec's label in the success message", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.zai,
			);

			const res = await handler(post({ name: "acct", apiKey: "k" }));
			const data = (await res.json()) as { message: string };

			expect(data.message).toBe("z.ai account 'acct' added successfully");
		});
	});

	describe("api key source", () => {
		it("requires apiKey when the spec reads it from the body", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			const res = await handler(post({ name: "acct" }));
			const data = (await res.json()) as { error: string };

			expect(res.status).toBe(400);
			expect(data.error).toContain("apiKey is required");
		});

		it("substitutes the fixed key without requiring one in the body", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.ollama,
			);

			const res = await handler(post({ name: "acct" }));

			expect(res.status).toBe(200);
			expect(row("acct")?.api_key).toBe("ollama");
		});
	});

	describe("token mirroring", () => {
		it("mirrors the key into both token columns when the spec says so", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.zai,
			);

			await handler(post({ name: "acct", apiKey: "secret" }));

			const stored = row("acct");
			expect(stored?.refresh_token).toBe("secret");
			expect(stored?.access_token).toBe("secret");
		});

		it("leaves both token columns NULL for providers that opt out", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.openrouter,
			);

			await handler(post({ name: "acct", apiKey: "secret" }));

			const stored = row("acct");
			expect(stored?.api_key).toBe("secret");
			expect(stored?.refresh_token).toBeNull();
			expect(stored?.access_token).toBeNull();
		});
	});

	describe("custom endpoint", () => {
		it("rejects a missing endpoint when the spec requires one", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.openai,
			);

			const res = await handler(post({ name: "acct", apiKey: "k" }));

			expect(res.status).toBe(400);
		});

		it("accepts a missing endpoint when the spec makes it optional", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.zai,
			);

			const res = await handler(post({ name: "acct", apiKey: "k" }));

			expect(res.status).toBe(200);
			expect(row("acct")?.custom_endpoint).toBeNull();
		});

		it("rejects a malformed endpoint URL", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.zai,
			);

			const res = await handler(
				post({ name: "acct", apiKey: "k", customEndpoint: "not-a-url" }),
			);

			expect(res.status).toBe(400);
		});

		it("writes the fixed endpoint and ignores any body value", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.ollamaCloud,
			);

			await handler(
				post({
					name: "acct",
					apiKey: "k",
					customEndpoint: "https://attacker.test",
				}),
			);

			expect(row("acct")?.custom_endpoint).toBe("https://ollama.com");
		});

		it("writes NULL for providers with no endpoint", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			await handler(post({ name: "acct", apiKey: "k" }));

			expect(row("acct")?.custom_endpoint).toBeNull();
		});
	});

	describe("model mappings", () => {
		it("stores sanitized mappings as JSON", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			const res = await handler(
				post({
					name: "acct",
					apiKey: "k",
					modelMappings: { "claude-sonnet-5": "claude-opus-5" },
				}),
			);

			expect(res.status).toBe(200);
			expect(JSON.parse(row("acct")?.model_mappings ?? "null")).toEqual({
				"claude-sonnet-5": "claude-opus-5",
			});
		});

		it("stores SQL NULL — not the string 'null' — when mappings are absent", async () => {
			// Regression: ollama and ollama-cloud previously ran
			// JSON.stringify(validated) unguarded, so an absent/invalid mapping
			// wrote the 4-character string "null" into the column.
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.ollama,
			);

			await handler(post({ name: "acct" }));

			const stored = row("acct");
			expect(stored?.model_mappings).toBeNull();
			expect(stored?.model_mappings).not.toBe("null");
		});

		it("rejects mappings that do not survive sanitization", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.openai,
			);

			const res = await handler(
				post({
					name: "acct",
					apiKey: "k",
					customEndpoint: "https://example.test/v1",
					modelMappings: { "": "" },
				}),
			);

			expect(res.status).toBe(400);
		});

		it("rejects a non-object modelMappings", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			const res = await handler(
				post({ name: "acct", apiKey: "k", modelMappings: "nope" }),
			);

			expect(res.status).toBe(400);
		});

		it("ignores modelMappings for a provider that does not support them", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.minimax,
			);

			const res = await handler(
				post({
					name: "acct",
					apiKey: "k",
					modelMappings: { "claude-sonnet-5": "claude-opus-5" },
				}),
			);

			expect(res.status).toBe(200);
			expect(row("acct")?.model_mappings).toBeNull();
		});
	});

	describe("shared validation", () => {
		it("requires a name", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			const res = await handler(post({ apiKey: "k" }));
			const data = (await res.json()) as { error: string };

			expect(res.status).toBe(400);
			expect(data.error).toContain("name is required");
		});

		it("defaults priority to 0", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			const res = await handler(post({ name: "acct", apiKey: "k" }));
			const data = (await res.json()) as { account: { priority: number } };

			expect(data.account.priority).toBe(0);
		});

		it("rejects a duplicate account name", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			expect((await handler(post({ name: "dup", apiKey: "k" }))).status).toBe(
				200,
			);
			expect(
				(await handler(post({ name: "dup", apiKey: "k" }))).status,
			).not.toBe(200);
		});
	});

	describe("spec table", () => {
		it("has a unique provider string per entry", () => {
			const providers = Object.values(API_KEY_PROVIDERS).map((s) => s.provider);
			expect(new Set(providers).size).toBe(providers.length);
		});
	});
});
