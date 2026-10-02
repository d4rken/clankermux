import { describe, expect, it } from "bun:test";
import {
	NATIVE_RESPONSES_REQUEST_HEADER,
	readServiceTierAdaptation,
	SERVICE_TIER_ADAPTATION_HEADER,
} from "@clankermux/types";
import { applyFastModeServiceTier } from "../backend-params";
import { CodexProvider } from "../provider";

type TransformAccount = Parameters<CodexProvider["transformRequestBody"]>[1];

const codexAccount = (overrides: Record<string, unknown> = {}) =>
	({
		id: "codex-1",
		name: "codex-test",
		provider: "codex",
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		created_at: Date.now(),
		request_count: 0,
		total_requests: 0,
		priority: 20,
		custom_endpoint: null,
		codex_fast_mode_enabled: false,
		...overrides,
	}) as unknown as TransformAccount;

const fast = codexAccount({ codex_fast_mode_enabled: true });

const nativeRequest = (
	payload: Record<string, unknown>,
	headers: Record<string, string> = {},
) =>
	new Request("https://chatgpt.com/backend-api/codex/responses", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[NATIVE_RESPONSES_REQUEST_HEADER]: "1",
			...headers,
		},
		body: JSON.stringify({
			model: "gpt-6-astra",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Hi" }],
				},
			],
			...payload,
		}),
	});

const translatedRequest = (headers: Record<string, string> = {}) =>
	new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			model: "gpt-6-astra",
			max_tokens: 10,
			messages: [{ role: "user", content: "hello" }],
		}),
	});

const transform = async (request: Request, account: TransformAccount) => {
	const transformed = await new CodexProvider().transformRequestBody(
		request,
		account,
	);
	// The translated fallback hands back the original, already-read request.
	let body: Record<string, unknown> | null = null;
	if (!transformed.bodyUsed) {
		try {
			body = JSON.parse(await transformed.text());
		} catch {}
	}
	return {
		body,
		tier: readServiceTierAdaptation(transformed.headers),
		rawHeader: transformed.headers.get(SERVICE_TIER_ADAPTATION_HEADER),
	};
};

describe("applyFastModeServiceTier", () => {
	it("forces priority and records the client's own tier", () => {
		const body: Record<string, unknown> = { service_tier: "default" };
		expect(applyFastModeServiceTier(body, true, true)).toEqual({
			requested: "default",
			sent: "priority",
			reason: "account_fast_mode",
		});
		expect(body.service_tier).toBe("priority");
	});

	it("still records the policy when the client already asked for priority", () => {
		const body: Record<string, unknown> = { service_tier: "priority" };
		expect(applyFastModeServiceTier(body, true, true)?.reason).toBe(
			"account_fast_mode",
		);
	});

	it("leaves the body alone when the flag is off, recording a client tier as passed through", () => {
		const body: Record<string, unknown> = { service_tier: "priority" };
		expect(applyFastModeServiceTier(body, false, true)).toEqual({
			requested: "priority",
			sent: "priority",
			reason: null,
		});
		expect(applyFastModeServiceTier({}, false, true)).toBeNull();
	});

	it("never touches a body bound for another backend", () => {
		const body: Record<string, unknown> = {};
		expect(applyFastModeServiceTier(body, true, false)).toBeNull();
		expect("service_tier" in body).toBe(false);
	});
});

describe("CodexProvider fast mode", () => {
	it("sets priority on the native passthrough, overriding the client's default", async () => {
		const { body, tier } = await transform(
			nativeRequest({ service_tier: "default" }),
			fast,
		);
		expect(body?.service_tier).toBe("priority");
		expect(tier).toEqual({
			requested: "default",
			sent: "priority",
			reason: "account_fast_mode",
		});
	});

	it("sets priority on the translated path, where the client tier is not carried", async () => {
		const { body, tier } = await transform(translatedRequest(), fast);
		expect(body?.service_tier).toBe("priority");
		expect(tier).toEqual({
			requested: null,
			sent: "priority",
			reason: "account_fast_mode",
		});
	});

	it("does nothing on an account with fast mode off", async () => {
		const native = await transform(nativeRequest({}), codexAccount());
		expect(native.body && "service_tier" in native.body).toBe(false);
		expect(native.rawHeader).toBeNull();

		const translated = await transform(translatedRequest(), codexAccount());
		expect(translated.body && "service_tier" in translated.body).toBe(false);
		expect(translated.rawHeader).toBeNull();
	});

	it("does nothing on a custom endpoint, even with fast mode on", async () => {
		const custom = codexAccount({
			codex_fast_mode_enabled: true,
			custom_endpoint: "https://example.test/v1",
		});
		const native = await transform(nativeRequest({}), custom);
		expect(native.body && "service_tier" in native.body).toBe(false);
		const translated = await transform(translatedRequest(), custom);
		expect(translated.body && "service_tier" in translated.body).toBe(false);
	});

	it("drops a forged audit header when nothing was set", async () => {
		const forged = { [SERVICE_TIER_ADAPTATION_HEADER]: "Zm9yZ2Vk" };
		expect(
			(await transform(nativeRequest({}, forged), codexAccount())).rawHeader,
		).toBeNull();
		expect(
			(await transform(translatedRequest(forged), codexAccount())).rawHeader,
		).toBeNull();
	});

	it("claims no tier on the native fallback, which forwards the body as it arrived", async () => {
		const request = new Request(
			"https://chatgpt.com/backend-api/codex/responses",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					[NATIVE_RESPONSES_REQUEST_HEADER]: "1",
					[SERVICE_TIER_ADAPTATION_HEADER]: "Zm9yZ2Vk",
				},
				body: "[]",
			},
		);
		const { rawHeader } = await transform(request, fast);
		expect(rawHeader).toBeNull();
	});

	it("claims no tier on the translated fallback either", async () => {
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[SERVICE_TIER_ADAPTATION_HEADER]: "Zm9yZ2Vk",
			},
			body: "{not json",
		});
		const { rawHeader } = await transform(request, fast);
		expect(rawHeader).toBeNull();
	});
});
