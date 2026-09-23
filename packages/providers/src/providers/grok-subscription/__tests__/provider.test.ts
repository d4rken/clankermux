import { beforeEach, describe, expect, it } from "bun:test";
import { getProvider } from "../../../index";
import { registry } from "../../../registry";
import { GROK_CLI_USER_AGENT, GROK_CLI_VERSION } from "../client-identity";
import { GrokSubscriptionProvider } from "../provider";
import {
	describeGrokUpgradeRequired,
	isGrokUpgradeRequired,
	parseRequiredGrokCliVersion,
} from "../upgrade-required";

/** The body the live proxy returns when the version gate rejects a client. */
const UPGRADE_BODY = JSON.stringify({
	error:
		"Your Grok CLI version (none) is outdated. Please update to version 0.1.202 or later via `grok update` or the installation documentation.",
});

describe("GrokSubscriptionProvider", () => {
	let provider: GrokSubscriptionProvider;

	beforeEach(() => {
		provider = new GrokSubscriptionProvider();
	});

	describe("identity", () => {
		it("is a separate provider from the metered xAI API", () => {
			expect(provider.name).toBe("grok-subscription");
			expect(provider.getEndpoint()).toBe("https://cli-chat-proxy.grok.com");
		});

		it("resolves the Anthropic messages path against the chat proxy", () => {
			expect(provider.buildUrl("/v1/messages", "?beta=true")).toBe(
				"https://cli-chat-proxy.grok.com/v1/messages?beta=true",
			);
		});
	});

	describe("prepareHeaders", () => {
		function prepared(): Headers {
			return provider.prepareHeaders(
				new Headers({
					"x-api-key": "client-key",
					authorization: "Bearer client-token",
					host: "proxy.local",
					"accept-encoding": "gzip",
					"content-encoding": "gzip",
				}),
				"account-token",
			);
		}

		it("still replaces the client's credentials with our bearer token", () => {
			const headers = prepared();
			expect(headers.get("authorization")).toBe("Bearer account-token");
			expect(headers.get("x-api-key")).toBeNull();
		});

		it("still drops the headers the base class removes", () => {
			const headers = prepared();
			expect(headers.get("host")).toBeNull();
			expect(headers.get("accept-encoding")).toBeNull();
			expect(headers.get("content-encoding")).toBeNull();
		});

		it("attaches every identity header the version gate requires", () => {
			const headers = prepared();
			// A bearer alone is answered with 426, so all six are load-bearing.
			expect({
				identifier: headers.get("x-grok-client-identifier"),
				version: headers.get("x-grok-client-version"),
				mode: headers.get("x-grok-client-mode"),
				tokenAuth: headers.get("x-xai-token-auth"),
				authenticateResponse: headers.get("x-authenticateresponse"),
				userAgent: headers.get("user-agent"),
			}).toEqual({
				identifier: "grok-shell",
				version: GROK_CLI_VERSION,
				mode: "interactive",
				tokenAuth: "xai-grok-cli",
				authenticateResponse: "authenticate-response",
				userAgent: GROK_CLI_USER_AGENT,
			});
		});

		it("names the pinned version in the user agent", () => {
			expect(GROK_CLI_USER_AGENT).toMatch(
				new RegExp(`^grok-shell/${GROK_CLI_VERSION} \\(\\w+\\)$`),
			);
		});

		it("overrides a client-sent identity header rather than forwarding it", () => {
			const headers = provider.prepareHeaders(
				new Headers({ "x-grok-client-version": "0.0.1" }),
				"account-token",
			);
			expect(headers.get("x-grok-client-version")).toBe(GROK_CLI_VERSION);
		});
	});

	describe("the 426 version gate", () => {
		it("recognizes a 426 and nothing else", () => {
			expect(isGrokUpgradeRequired(new Response("", { status: 426 }))).toBe(
				true,
			);
			for (const status of [200, 400, 401, 429, 500]) {
				expect(isGrokUpgradeRequired(new Response("", { status }))).toBe(false);
			}
		});

		it("reads the required version out of the upstream body", () => {
			expect(parseRequiredGrokCliVersion(UPGRADE_BODY)).toBe("0.1.202");
			expect(parseRequiredGrokCliVersion("something else entirely")).toBeNull();
		});

		it("names the required version and the version we sent", () => {
			const message = describeGrokUpgradeRequired(UPGRADE_BODY);
			expect(message).toContain("0.1.202");
			expect(message).toContain(GROK_CLI_VERSION);
			expect(message).toContain("GROK_CLI_VERSION");
		});

		it("still explains itself when the body names no version", () => {
			const message = describeGrokUpgradeRequired("{}");
			expect(message).toContain("newer version");
			expect(message).toContain(GROK_CLI_VERSION);
		});

		it("answers a 426 with that message instead of the upstream body", async () => {
			const processed = await provider.processResponse(
				new Response(UPGRADE_BODY, {
					status: 426,
					headers: { "content-type": "application/json" },
				}),
				null,
			);
			expect(processed.status).toBe(426);
			const body = (await processed.json()) as {
				type: string;
				error: { type: string; message: string };
			};
			expect(body.type).toBe("error");
			expect(body.error.message).toContain("0.1.202");
			// `grok update` is the upstream's advice to a human running the CLI; the
			// fix here is a constant, so the quoted text must not be the whole
			// message.
			expect(body.error.message).toContain("GROK_CLI_VERSION");
		});

		it("passes every other response body through", async () => {
			const processed = await provider.processResponse(
				new Response('{"ok":true}', {
					status: 200,
					headers: { "content-type": "application/json", connection: "close" },
				}),
				null,
			);
			expect(processed.status).toBe(200);
			expect(await processed.text()).toBe('{"ok":true}');
			expect(processed.headers.get("connection")).toBeNull();
		});
	});

	describe("upstream response headers", () => {
		const STRIPPED = [
			"x-ratelimit-limit-tokens",
			"x-ratelimit-remaining-requests",
			"x-zero-data-retention",
			"x-data-retention",
			"x-grok-conv-id",
			"x-xai-request-id",
		];

		function upstreamHeaders(): Headers {
			const headers = new Headers({
				"content-type": "application/json",
				"retry-after": "30",
			});
			for (const name of STRIPPED) headers.set(name, "1");
			return headers;
		}

		it.each([
			["a 200", 200, '{"ok":true}'],
			["the 426 path", 426, UPGRADE_BODY],
		] as const)("strips xAI's own headers from %s and keeps the rest", async (_label, status, body) => {
			const processed = await provider.processResponse(
				new Response(body, { status, headers: upstreamHeaders() }),
				null,
			);
			expect(processed.status).toBe(status);
			for (const name of STRIPPED) {
				expect(processed.headers.has(name)).toBe(false);
			}
			expect(processed.headers.get("retry-after")).toBe("30");
			expect(processed.headers.get("content-type")).toBe("application/json");
		});
	});

	describe("registry", () => {
		it("is registered under its provider name", () => {
			expect(getProvider("grok-subscription")).toBeInstanceOf(
				GrokSubscriptionProvider,
			);
		});

		it("claims OAuth without joining the registry's OAuth map", () => {
			// The qwen pattern: the device flow lives in the HTTP handler layer, so
			// the registry has no OAuth entry to hand out.
			//
			// Asked of the registry singleton rather than the package's
			// `getOAuthProvider` export, which another suite in the shared bun test
			// process module-mocks into answering for every name.
			expect(provider.supportsOAuth()).toBe(true);
			expect(registry.getOAuthProvider("grok-subscription")).toBeUndefined();
			expect(registry.listOAuthProviders()).not.toContain("grok-subscription");
		});
	});

	describe("transformRequestBody", () => {
		async function transformed(body: unknown): Promise<Request> {
			return provider.transformRequestBody(
				new Request("https://cli-chat-proxy.grok.com/v1/messages", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"content-length": "999",
					},
					body: JSON.stringify(body),
				}),
			);
		}

		// The proxy answers a tool whose input_schema omits `required` with
		// 400 `/required: null is not of type "array"`; the same request with
		// `required: []` answers 200. Nested object schemas are accepted as-is.
		it("gives every tool schema a top-level required list", async () => {
			const nested = {
				type: "object",
				properties: { a: { type: "string" } },
			};
			const request = await transformed({
				model: "grok-4.6",
				messages: [{ role: "user", content: "hi" }],
				tools: [
					{
						name: "omits",
						input_schema: { type: "object", properties: { opts: nested } },
					},
					{
						name: "null",
						input_schema: { type: "object", properties: {}, required: null },
					},
					{
						name: "keeps",
						input_schema: { type: "object", properties: {}, required: ["q"] },
					},
				],
			});
			const body = await request.json();
			expect(
				body.tools.map((t: { input_schema: unknown }) => t.input_schema),
			).toEqual([
				{ type: "object", properties: { opts: nested }, required: [] },
				{ type: "object", properties: {}, required: [] },
				{ type: "object", properties: {}, required: ["q"] },
			]);
			expect(request.headers.get("content-length")).toBeNull();
		});

		it("passes a request whose tools already comply through untouched", async () => {
			const original = new Request(
				"https://cli-chat-proxy.grok.com/v1/messages",
				{
					method: "POST",
					body: JSON.stringify({
						model: "grok-4.6",
						messages: [],
						tools: [
							{ name: "t", input_schema: { type: "object", required: [] } },
						],
					}),
				},
			);
			expect(await provider.transformRequestBody(original)).toBe(original);
		});

		it("leaves server tools without an input_schema and non-JSON bodies alone", async () => {
			const request = await transformed({
				model: "grok-4.6",
				messages: [],
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			});
			expect((await request.json()).tools).toEqual([
				{ type: "web_search_20250305", name: "web_search" },
			]);
			const raw = new Request("https://cli-chat-proxy.grok.com/v1/messages", {
				method: "POST",
				body: "not json",
			});
			expect(await provider.transformRequestBody(raw)).toBe(raw);
		});
	});

	// The proxy intermittently answers a request holding any `role: "system"`
	// message with 400 "Invalid message role" (7 of 60 live sends), while the
	// same text inside a user message passed 50 of 50.
	describe("system-role messages", () => {
		async function messagesAfter(
			messages: unknown[],
			extra: Record<string, unknown> = {},
		) {
			const request = await provider.transformRequestBody(
				new Request("https://cli-chat-proxy.grok.com/v1/messages", {
					method: "POST",
					body: JSON.stringify({ model: "grok-4.6", messages, ...extra }),
				}),
			);
			return request.json();
		}
		const reminder = (text: string) => ({
			type: "text",
			text: `<system-reminder>\n${text}\n</system-reminder>`,
		});

		it("appends a system message to the user turn before it", async () => {
			const toolResult = {
				type: "tool_result",
				tool_use_id: "toolu_1",
				content: "ok",
			};
			const body = await messagesAfter([
				{ role: "user", content: "run it" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
					],
				},
				{ role: "user", content: [toolResult] },
				{ role: "system", content: [{ type: "text", text: "Date changed." }] },
			]);
			expect(body.messages.at(-1)).toEqual({
				role: "user",
				content: [toolResult, reminder("Date changed.")],
			});
			expect(body.messages).toHaveLength(3);
		});

		it("prepends to the next user turn when the previous turn is the assistant's", async () => {
			const body = await messagesAfter([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
				{ role: "system", content: "Be brief." },
				{ role: "user", content: "again" },
			]);
			expect(body.messages).toEqual([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
				{
					role: "user",
					content: [reminder("Be brief."), { type: "text", text: "again" }],
				},
			]);
		});

		it("keeps tool results first when prepending to the next user turn", async () => {
			const toolResult = {
				type: "tool_result",
				tool_use_id: "toolu_1",
				content: "ok",
			};
			const body = await messagesAfter([
				{ role: "user", content: "run it" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
					],
				},
				{ role: "system", content: "Date changed." },
				{ role: "user", content: [toolResult, { type: "text", text: "go" }] },
			]);
			expect(body.messages.at(-1).content).toEqual([
				toolResult,
				reminder("Date changed."),
				{ type: "text", text: "go" },
			]);
		});

		it("becomes its own user turn when no user turn is adjacent", async () => {
			const body = await messagesAfter([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
				{ role: "system", content: "Be brief." },
			]);
			expect(body.messages.at(-1)).toEqual({
				role: "user",
				content: [reminder("Be brief.")],
			});
		});

		it("moves an effort update to the request instead of dropping it", async () => {
			const body = await messagesAfter([
				{ role: "user", content: "hi" },
				{
					role: "system",
					content: "Effort changed.",
					output_config: { effort: "low" },
				},
			]);
			expect(body.output_config).toEqual({ effort: "low" });
			expect(body.messages).toEqual([
				{
					role: "user",
					content: [{ type: "text", text: "hi" }, reminder("Effort changed.")],
				},
			]);
		});

		it("leaves a conversation without system messages untouched", async () => {
			const original = new Request(
				"https://cli-chat-proxy.grok.com/v1/messages",
				{
					method: "POST",
					body: JSON.stringify({
						model: "grok-4.6",
						messages: [{ role: "user", content: "hi" }],
					}),
				},
			);
			expect(await provider.transformRequestBody(original)).toBe(original);
		});
	});
});
