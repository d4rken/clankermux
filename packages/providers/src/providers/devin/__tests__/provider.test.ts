import { describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import type { Account } from "@clankermux/types";
import {
	type DevinAccountInfo,
	DevinClient,
	DevinSessionAuthenticationError,
} from "../client";
import {
	DevinProvider,
	isDevinSessionAuthenticationFailure,
} from "../provider";
import {
	ChatMessageSource,
	GetChatMessageRequestSchema,
} from "../vendor/devin-proto";
import { fromBinary } from "../vendor/protobuf";

const info: DevinAccountInfo = {
	userJwt: "jwt-secret",
	endpoint: "https://server.codeium.com",
	models: [
		{
			id: "swe-2-high",
			name: "SWE-2 High",
			defaultInFamily: true,
			disabled: false,
			disabledReason: null,
			contextWindow: 200000,
			maxTokens: 64000,
			supportsImages: true,
			effort: "high",
		},
	],
	usage: {
		kind: "devin",
		quotaBased: true,
		daily: { utilization: 20, resetAt: Date.now() + 3600000 },
		weekly: null,
		planName: "Free",
		email: null,
		accountId: null,
		canUseCli: true,
		overageBalanceUsd: 0,
		includedCreditsRemaining: null,
	},
};
class Client extends DevinClient {
	override async getAccount() {
		return structuredClone(info);
	}
}
const account = {
	id: "one",
	name: "Devin",
	provider: "devin",
	api_key: "session-secret",
	model_mappings: null,
	auto_pause_on_overage_enabled: true,
} as Account;

describe("Devin provider", () => {
	it("rejects empty conversation history before sending an inference request", async () => {
		const provider = new DevinProvider(new Client());
		const result = await provider.transformRequestBody(
			new Request(provider.buildUrl("/v1/messages", "", account), {
				method: "POST",
				body: JSON.stringify({ model: "swe-2", messages: [] }),
			}),
			account,
		);
		expect(result.headers.get("x-clankermux-synthetic-status")).toBe("400");
		expect(await result.text()).toContain("non-empty conversation");
	});
	it("omits an all-redacted assistant turn instead of sending an empty system prompt", async () => {
		const provider = new DevinProvider(new Client());
		const result = await provider.transformRequestBody(
			new Request(provider.buildUrl("/v1/messages", "", account), {
				method: "POST",
				body: JSON.stringify({
					model: "swe-2",
					messages: [
						{ role: "user", content: "hello" },
						{
							role: "assistant",
							content: [{ type: "redacted_thinking", data: "opaque" }],
						},
						{ role: "user", content: "continue" },
					],
				}),
			}),
			account,
		);
		const wire = fromBinary(
			GetChatMessageRequestSchema,
			gunzipSync(new Uint8Array(await result.arrayBuffer()).subarray(5)),
		);
		expect(wire.chatMessagePrompts.map((p) => p.source)).toEqual([
			ChatMessageSource.USER,
			ChatMessageSource.USER,
		]);
	});
	it.each([
		{ type: "tool", name: "read" },
		{ type: "any" },
	])("rejects unverified forced tool selection %j before inference", async (choice) => {
		const provider = new DevinProvider(new Client());
		const result = await provider.transformRequestBody(
			new Request(provider.buildUrl("/v1/messages", "", account), {
				method: "POST",
				body: JSON.stringify({
					model: "swe-2",
					messages: [{ role: "user", content: "Read x" }],
					tools: [{ name: "read", input_schema: { type: "object" } }],
					tool_choice: choice,
				}),
			}),
			account,
		);
		expect(result.headers.get("x-clankermux-synthetic-status")).toBe("400");
		expect(await result.text()).toContain("forced tool selection");
	});
	it("isolates identical conversations and uses verified tool-choice encoding", async () => {
		const provider = new DevinProvider(new Client());
		const build = async (choice: object) => {
			const result = await provider.transformRequestBody(
				new Request(provider.buildUrl("/v1/messages", "", account), {
					method: "POST",
					body: JSON.stringify({
						model: "swe-2",
						messages: [{ role: "user", content: "hello" }],
						tools: [{ name: "read", input_schema: { type: "object" } }],
						tool_choice: choice,
					}),
				}),
				account,
			);
			return fromBinary(
				GetChatMessageRequestSchema,
				gunzipSync(new Uint8Array(await result.arrayBuffer()).subarray(5)),
			);
		};
		const first = await build({ type: "auto" });
		const second = await build({ type: "none" });
		expect(first.cascadeId).not.toBe(second.cascadeId);
		expect(first.toolChoice?.choice).toEqual({
			case: "optionName",
			value: "auto",
		});
		expect(second.tools).toHaveLength(0);
		expect(second.toolChoice?.choice).toEqual({
			case: "optionName",
			value: "auto",
		});
	});
	it("offers an explicit opt-out for unknown included quota", async () => {
		class Unknown extends Client {
			override async getAccount() {
				const data = await super.getAccount();
				data.usage.daily = null;
				data.usage.weekly = null;
				data.usage.includedCreditsRemaining = null;
				return data;
			}
		}
		const provider = new DevinProvider(new Unknown());
		const req = () =>
			new Request(provider.buildUrl("/v1/messages", "", account), {
				method: "POST",
				body: JSON.stringify({
					model: "swe-2",
					messages: [{ role: "user", content: "hello" }],
				}),
			});
		expect(
			(await provider.transformRequestBody(req(), account)).headers.get(
				"x-clankermux-synthetic-status",
			),
		).toBe("429");
		expect(
			(
				await provider.transformRequestBody(req(), {
					...account,
					auto_pause_on_overage_enabled: false,
				})
			).headers.get("content-type"),
		).toBe("application/connect+proto");
	});
	it("translates local tool history and schemas into a framed native request", async () => {
		const provider = new DevinProvider(new Client());
		const request = new Request(
			provider.buildUrl("/v1/messages", "", account),
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "swe-2",
					max_tokens: 1000,
					stream: true,
					system: "Be helpful",
					tools: [
						{
							name: "read",
							description: "Read file",
							input_schema: {
								type: "object",
								properties: { path: { type: "string" } },
							},
						},
					],
					messages: [
						{ role: "user", content: "Read x" },
						{
							role: "assistant",
							content: [
								{
									type: "tool_use",
									id: "call_1",
									name: "read",
									input: { path: "x" },
								},
							],
						},
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "call_1",
									content: "contents",
								},
							],
						},
					],
				}),
			},
		);
		const transformed = await provider.transformRequestBody(request, account);
		const bytes = new Uint8Array(await transformed.arrayBuffer());
		const decoded = fromBinary(
			GetChatMessageRequestSchema,
			gunzipSync(bytes.subarray(5)),
		);
		expect(decoded.metadata?.apiKey).toBe("devin-session-token$session-secret");
		expect(decoded.chatModelUid).toBe("swe-2-high");
		expect(decoded.prompt).toBe("Be helpful");
		expect(decoded.chatMessagePrompts.map((x) => x.source)).toEqual([
			ChatMessageSource.USER,
			ChatMessageSource.SYSTEM,
			ChatMessageSource.TOOL,
		]);
		expect(decoded.chatMessagePrompts[2]?.toolCallId).toBe("call_1");
		expect(
			JSON.parse(decoded.tools[0]?.jsonSchemaString).properties.path.type,
		).toBe("string");
	});
	it("strips inbound credentials and internal markers", () => {
		const headers = new DevinProvider().prepareHeaders(
			new Headers({
				authorization: "Bearer front-door",
				"x-api-key": "front-door",
				cookie: "session=secret",
				"x-clankermux-upstream-model": "forged",
				"anthropic-version": "2023-06-01",
			}),
		);
		expect([...headers.keys()]).toEqual(["content-type"]);
	});
	it("answers count_tokens without network access and refuses unhandled paths", async () => {
		const provider = new DevinProvider(new Client());
		const request = new Request(
			provider.buildUrl("/v1/messages/count_tokens", "", account),
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "swe-2",
					messages: [{ role: "user", content: "hello" }],
				}),
			},
		);
		const result = await provider.transformRequestBody(request, account);
		expect(result.url).toStartWith("https://clankermux.local/");
		expect((await result.json()).input_tokens).toBeGreaterThan(0);
		expect(provider.canHandle("/v1/files")).toBe(false);
	});
	it("blocks known quota exhaustion before using prepaid overage", async () => {
		class Exhausted extends Client {
			override async getAccount() {
				const v = await super.getAccount();
				if (!v.usage.daily) throw new Error("Missing fixture daily quota");
				v.usage.daily.utilization = 100;
				v.usage.overageBalanceUsd = 10;
				return v;
			}
		}
		const provider = new DevinProvider(new Exhausted());
		const result = await provider.transformRequestBody(
			new Request(provider.buildUrl("/v1/messages", "", account), {
				method: "POST",
				body: JSON.stringify({ model: "swe-2", messages: [] }),
			}),
			account,
		);
		expect(result.headers.get("x-clankermux-synthetic-status")).toBe("429");
		const normalized = await provider.normalizeUpstreamResponse(
			Response.json(await result.clone().json(), { status: 429 }),
			result,
		);
		expect(Number(normalized.headers.get("retry-after"))).toBeGreaterThan(3500);
	});
});

it("carries confirmed session rejection only through local request provenance", async () => {
	class RejectedClient extends DevinClient {
		override async getAccount(): Promise<DevinAccountInfo> {
			throw new DevinSessionAuthenticationError();
		}
	}
	const provider = new DevinProvider(new RejectedClient());
	const rejected = await provider.transformRequestBody(
		new Request("https://example.test/v1/messages", {
			method: "POST",
			body: JSON.stringify({
				model: "swe-2",
				messages: [{ role: "user", content: "hello" }],
			}),
		}),
		account,
	);
	expect(rejected.headers.get("x-clankermux-synthetic-status")).toBe("401");
	expect(isDevinSessionAuthenticationFailure(rejected)).toBe(true);
	expect(
		isDevinSessionAuthenticationFailure(
			new Request(rejected.url, { headers: rejected.headers }),
		),
	).toBe(false);
	expect(
		[...rejected.headers.keys()].some(
			(key) => key.includes("reauth") || key.includes("auth-rejected"),
		),
	).toBe(false);
});
