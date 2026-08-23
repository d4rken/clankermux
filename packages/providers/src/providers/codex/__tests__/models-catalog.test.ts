import { describe, expect, test } from "bun:test";
import {
	CODEX_MODEL_CATALOG_URL,
	fetchCodexModelCatalog,
} from "../models-catalog";

// A payload shaped like the real thing: one field, `models`, whose entries
// carry far more keys than anything here reads. The point of every assertion
// below is that we do NOT understand this body — we hand it back untouched.
const REAL_SHAPED_BODY = JSON.stringify({
	models: [
		{
			slug: "gpt-5.6-sol",
			display_name: "GPT-5.6-Sol",
			base_instructions: "You are Codex…",
			model_messages: { instructions_template: "…", approvals: null },
			context_window: 272000,
			supported_reasoning_levels: [{ effort: "low", description: "…" }],
			visibility: "list",
			priority: 1,
			upgrade: null,
			some_field_shipped_after_this_test_was_written: { nested: true },
		},
	],
});

function okFetch(
	body = REAL_SHAPED_BODY,
	init: { status?: number; etag?: string } = {},
) {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const impl = (async (url: string | URL | Request, reqInit?: RequestInit) => {
		calls.push({ url: String(url), init: reqInit });
		const headers = new Headers({ "Content-Type": "application/json" });
		if (init.etag) headers.set("ETag", init.etag);
		return new Response(body, { status: init.status ?? 200, headers });
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe("fetchCodexModelCatalog", () => {
	test("calls the fixed ChatGPT backend URL with the client version", async () => {
		const { impl, calls } = okFetch();
		const result = await fetchCodexModelCatalog({
			accessToken: "token-abc",
			chatgptAccountId: null,
			clientVersion: "0.149.0",
			fetchImpl: impl,
		});

		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		const requested = new URL(calls[0].url);
		expect(`${requested.origin}${requested.pathname}`).toBe(
			CODEX_MODEL_CATALOG_URL,
		);
		expect(requested.searchParams.get("client_version")).toBe("0.149.0");
	});

	test("omits the query parameter when no client version is given", async () => {
		const { impl, calls } = okFetch();
		await fetchCodexModelCatalog({
			accessToken: "token-abc",
			chatgptAccountId: null,
			clientVersion: null,
			fetchImpl: impl,
		});
		expect(new URL(calls[0].url).searchParams.has("client_version")).toBe(
			false,
		);
	});

	test("sends the bearer, Codex originator, and account id headers", async () => {
		const { impl, calls } = okFetch();
		await fetchCodexModelCatalog({
			accessToken: "token-abc",
			chatgptAccountId: "  acct-42  ",
			clientVersion: "0.149.0",
			fetchImpl: impl,
		});

		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer token-abc");
		expect(headers.get("originator")).toBe("codex_cli_rs");
		expect(headers.get("ChatGPT-Account-ID")).toBe("acct-42");
		expect(headers.get("User-Agent")).toBeTruthy();
	});

	test("leaves the account-id header off when the token carries none", async () => {
		const { impl, calls } = okFetch();
		await fetchCodexModelCatalog({
			accessToken: "token-abc",
			chatgptAccountId: "   ",
			clientVersion: "0.149.0",
			fetchImpl: impl,
		});
		expect(new Headers(calls[0].init?.headers).has("ChatGPT-Account-ID")).toBe(
			false,
		);
	});

	// The whole reason this fetcher returns text: Codex deserializes ~18 required
	// fields per entry. Anything that parses and re-serialises can silently drop
	// one, and the failure is masked by Codex's fallback to its built-in catalog.
	test("returns the body byte-identically, including unknown fields", async () => {
		const { impl } = okFetch();
		const result = await fetchCodexModelCatalog({
			accessToken: "token-abc",
			chatgptAccountId: null,
			clientVersion: "0.149.0",
			fetchImpl: impl,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.bodyText).toBe(REAL_SHAPED_BODY);
		const reparsed = JSON.parse(result.bodyText) as {
			models: Array<Record<string, unknown>>;
		};
		expect(
			reparsed.models[0].some_field_shipped_after_this_test_was_written,
		).toEqual({ nested: true });
	});

	test("surfaces the upstream ETag when present, null when absent", async () => {
		const withEtag = await fetchCodexModelCatalog({
			accessToken: "t",
			chatgptAccountId: null,
			clientVersion: "0.149.0",
			fetchImpl: okFetch(REAL_SHAPED_BODY, { etag: 'W/"abc123"' }).impl,
		});
		expect(withEtag.ok && withEtag.etag).toBe('W/"abc123"');

		const withoutEtag = await fetchCodexModelCatalog({
			accessToken: "t",
			chatgptAccountId: null,
			clientVersion: "0.149.0",
			fetchImpl: okFetch().impl,
		});
		expect(withoutEtag.ok && withoutEtag.etag).toBeNull();
	});

	test("rejects a 200 whose body is not a models envelope", async () => {
		for (const body of [
			JSON.stringify({ object: "list", data: [] }),
			JSON.stringify({ models: {} }),
			"not json at all",
			"",
		]) {
			const result = await fetchCodexModelCatalog({
				accessToken: "t",
				chatgptAccountId: null,
				clientVersion: "0.149.0",
				fetchImpl: okFetch(body).impl,
			});
			expect(result.ok).toBe(false);
		}
	});

	test("fails clean on a non-200 without throwing", async () => {
		for (const status of [401, 403, 429, 500]) {
			const result = await fetchCodexModelCatalog({
				accessToken: "t",
				chatgptAccountId: null,
				clientVersion: "0.149.0",
				fetchImpl: okFetch(REAL_SHAPED_BODY, { status }).impl,
			});
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.status).toBe(status);
		}
	});

	test("fails clean when the network throws", async () => {
		const result = await fetchCodexModelCatalog({
			accessToken: "t",
			chatgptAccountId: null,
			clientVersion: "0.149.0",
			fetchImpl: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBeNull();
	});

	test("requires a non-empty access token", async () => {
		await expect(
			fetchCodexModelCatalog({
				accessToken: "  ",
				chatgptAccountId: null,
				clientVersion: "0.149.0",
				fetchImpl: okFetch().impl,
			}),
		).rejects.toThrow(/access token/i);
	});
});
