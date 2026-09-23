/**
 * The exact Qwen Code identity ClankerMux presents upstream: the inference
 * header set, the device-OAuth and token requests captured at the fetch
 * boundary, and the rewritten Claude Code system prompt. Headers are
 * lower-cased (name, value) pairs, sorted. A change here changes what
 * DashScope and chat.qwen.ai see, so it must be deliberate.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { OpenAIMessage, OpenAIRequest } from "@clankermux/openai-formats";
import { mockFetch } from "@clankermux/test-support";
import {
	initiateDeviceFlow,
	pollForToken,
	refreshQwenTokens,
} from "../device-oauth";
import { QwenProvider } from "../provider";

const INFERENCE_HEADERS: Array<[string, string]> = [
	["accept", "application/json"],
	["accept-encoding", "br, gzip, deflate"],
	["accept-language", "*"],
	["connection", "keep-alive"],
	["content-type", "application/json"],
	["sec-fetch-mode", "cors"],
	["user-agent", "QwenCode/0.24.4 (linux; x64)"],
	["x-dashscope-authtype", "qwen-oauth"],
	["x-dashscope-cachecontrol", "enable"],
	["x-dashscope-useragent", "QwenCode/0.24.4 (linux; x64)"],
	["x-stainless-arch", "x64"],
	["x-stainless-lang", "js"],
	["x-stainless-os", "Linux"],
	["x-stainless-package-version", "5.11.0"],
	["x-stainless-retry-count", "0"],
	["x-stainless-runtime", "node"],
	["x-stainless-runtime-version", "v22.17.0"],
	["x-stainless-timeout", "120"],
];

/** What Claude Code 2.1.280 sends on /v1/messages, trimmed to headers only. */
function claudeCodeInbound(): Headers {
	return new Headers({
		accept: "application/json",
		"accept-encoding": "gzip, br",
		"accept-language": "*",
		"anthropic-beta":
			"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-version": "2023-06-01",
		authorization: "Bearer sk-ant-oat01-client",
		connection: "keep-alive",
		"content-type": "application/json",
		"sec-fetch-mode": "cors",
		"user-agent": "claude-cli/2.1.280 (external, cli)",
		"x-app": "cli",
		"x-claude-code-session-id": "3f0c9a52-7e1b-4d8a-9c26-5b4e1f7a0d93",
		"x-stainless-arch": "x64",
		"x-stainless-helper-method": "stream",
		"x-stainless-lang": "js",
		"x-stainless-os": "Linux",
		"x-stainless-package-version": "0.60.0",
		"x-stainless-retry-count": "0",
		"x-stainless-runtime": "node",
		"x-stainless-runtime-version": "v24.9.0",
		"x-stainless-timeout": "600",
	});
}

function sorted(headers: HeadersInit | undefined): Array<[string, string]> {
	return Array.from(new Headers(headers).entries()).sort(([a], [b]) =>
		a.localeCompare(b),
	);
}

describe("Qwen inference headers", () => {
	const provider = new QwenProvider();

	it("replace a Claude Code header set with the Qwen Code one", () => {
		expect(
			sorted(provider.prepareHeaders(claudeCodeInbound(), "qwen-at")),
		).toEqual(
			[...INFERENCE_HEADERS, ["authorization", "Bearer qwen-at"]].sort(
				([a], [b]) => a.localeCompare(b),
			) as Array<[string, string]>,
		);
	});

	it("carry no authorization without an access token", () => {
		expect(
			sorted(provider.prepareHeaders(claudeCodeInbound(), undefined, "key")),
		).toEqual(INFERENCE_HEADERS);
	});
});

describe("Qwen OAuth identity at the fetch boundary", () => {
	let calls: Array<[string, RequestInit | undefined]> = [];
	let fetchSpy: ReturnType<typeof spyOn> | null = null;

	function stubFetch(body: unknown): void {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async (input, init) => {
				calls.push([String(input), init]);
				return Response.json(body);
			}),
		);
	}

	/** The form body as sent, with the per-call PKCE challenge masked. */
	function wireBody(index = 0): string {
		return String(calls[index]?.[1]?.body).replace(
			/code_challenge=[\w-]+/,
			"code_challenge=<pkce>",
		);
	}

	/** Headers sorted, with the per-request id checked as a v4 UUID and masked. */
	function wireHeaders(index = 0): Array<[string, string]> {
		return sorted(calls[index]?.[1]?.headers).map(([name, value]) => {
			if (name !== "x-request-id") return [name, value];
			expect(value).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			return [name, "<uuid>"];
		});
	}

	beforeEach(() => {
		calls = [];
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		fetchSpy = null;
	});

	it("device authorization request", async () => {
		stubFetch({
			device_code: "dc",
			user_code: "UC",
			verification_uri: "https://chat.qwen.ai/authorize",
			verification_uri_complete: "https://chat.qwen.ai/authorize?user_code=UC",
			expires_in: 600,
			interval: 5,
		});
		await initiateDeviceFlow();
		await initiateDeviceFlow();
		expect(calls[0]?.[0]).toBe(
			"https://chat.qwen.ai/api/v1/oauth2/device/code",
		);
		expect(calls[0]?.[1]?.method).toBe("POST");
		expect(wireHeaders()).toEqual([
			["accept", "application/json"],
			["content-type", "application/x-www-form-urlencoded"],
			["x-request-id", "<uuid>"],
		]);
		expect(wireBody()).toBe(
			"client_id=f0304373b74a44d2b584a3fb70ca9e56&scope=openid%20profile%20email%20model.completion&code_challenge=<pkce>&code_challenge_method=S256",
		);
		expect(new Headers(calls[1]?.[1]?.headers).get("x-request-id")).not.toBe(
			new Headers(calls[0]?.[1]?.headers).get("x-request-id"),
		);
	});

	it("device-code token poll", async () => {
		stubFetch({
			access_token: "at",
			refresh_token: "rt",
			token_type: "Bearer",
			resource_url: "portal.qwen.ai",
			expires_in: 21600,
		});
		await pollForToken("dc", { verifier: "v", challenge: "c" }, 0, 1);
		expect(calls[0]?.[0]).toBe("https://chat.qwen.ai/api/v1/oauth2/token");
		expect(calls[0]?.[1]?.method).toBe("POST");
		expect(wireHeaders()).toEqual([
			["accept", "application/json"],
			["content-type", "application/x-www-form-urlencoded"],
		]);
		expect(wireBody()).toBe(
			"grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=f0304373b74a44d2b584a3fb70ca9e56&device_code=dc&code_verifier=v",
		);
	});

	it("refresh-token grant", async () => {
		stubFetch({ access_token: "at2", refresh_token: "rt2", expires_in: 21600 });
		await refreshQwenTokens("rt~*");
		expect(calls[0]?.[0]).toBe("https://chat.qwen.ai/api/v1/oauth2/token");
		expect(calls[0]?.[1]?.method).toBe("POST");
		expect(wireHeaders()).toEqual([
			["accept", "application/json"],
			["content-type", "application/x-www-form-urlencoded"],
		]);
		expect(wireBody()).toBe(
			"grant_type=refresh_token&refresh_token=rt~*&client_id=f0304373b74a44d2b584a3fb70ca9e56",
		);
	});
});

describe("Qwen system-prompt identity", () => {
	const provider = new QwenProvider();

	function systemAfterConvert(blocks: string[]): unknown {
		const body: OpenAIRequest = {
			model: "coder-model",
			messages: [
				{
					role: "system",
					content: blocks.map((text) => ({
						type: "text",
						text,
					})) as OpenAIMessage["content"],
				},
				{ role: "user", content: "Hello" },
			],
		};
		provider.afterConvert(body);
		return body;
	}

	const MAIN_BLOCK = [
		"You are an interactive agent that helps users with software engineering tasks.",
		"",
		"If the user asks for help or wants to give feedback inform them of the following:",
		"- /help: Get help with using Claude Code",
		"- To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
		"",
		"# Memory",
		"Project instructions live in CLAUDE.md; a nested CLAUDE.md overrides it. XCLAUDE.md stays.",
		"",
		"<env>",
		"Working directory: /home/user/project",
		"</env>",
		"You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.",
		"The most recent Claude model family is Claude 5.",
		"Claude Code is available as a CLI in the terminal, desktop app and IDE extensions.",
		"Fast mode for Claude Code uses the same model with faster output.",
		"Claude Code on the web lives at claude.ai/code.",
	].join("\n");

	it("rewrites a Claude Code system prompt as Qwen Code", () => {
		expect(
			systemAfterConvert([
				"x-anthropic-billing-header: cc_version=2.1.280.a1b; cc_entrypoint=cli; cch=00000;",
				"You are Claude Code, Anthropic's official CLI for Claude.",
				MAIN_BLOCK,
				"You are powered by the model named Opus 5.5.",
			]),
		).toEqual({
			model: "coder-model",
			messages: [
				{
					role: "system",
					content: [
						{
							type: "text",
							text: "You are Qwen Code, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.",
						},
						{
							type: "text",
							text: [
								"You are an interactive agent that helps users with software engineering tasks.",
								"",
								"If the user asks for help or wants to give feedback inform them of the following:",
								"- /help: Get help with using Qwen Code",
								"- To report a bug or provide feedback, please use the /bug command",
								"",
								"# Memory",
								"Project instructions live in QWEN.md; a nested QWEN.md overrides it. XCLAUDE.md stays.",
								"",
								"<env>",
								"Working directory: /home/user/project",
								"</env>",
							].join("\n"),
						},
					],
				},
				{ role: "user", content: "Hello" },
			],
			vl_high_resolution_images: true,
		});
	});

	it.each([
		"You are Claude Code, Anthropic's official CLI for Claude.",
		"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
		"You are a Claude agent, built on Anthropic's Claude Agent SDK.",
	])("replaces the identity block %p", (identity) => {
		const body = systemAfterConvert([identity]) as OpenAIRequest;
		expect(body.messages[0]?.content).toEqual([
			{
				type: "text",
				text: "You are Qwen Code, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.",
			},
		]);
	});
});
