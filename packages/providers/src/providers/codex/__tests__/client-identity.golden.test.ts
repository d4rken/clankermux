/**
 * Golden record of the Codex client identity on every request ClankerMux
 * originates to OpenAI, captured at the fetch boundary. Values are literals on
 * purpose: a change to any constant has to show up as a diff in this file.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import { initiateCodexDeviceFlow, pollCodexForToken } from "../device-oauth";
import { fetchCodexModelCatalog } from "../models-catalog";
import { sendCodexNativePing } from "../native-ping";
import { CodexOAuthProvider } from "../oauth";
import { CodexProvider } from "../provider";
import {
	consumeCodexRateLimitResetCredit,
	fetchCodexRateLimitResetCredits,
} from "../rate-limit-reset-credits";
import { fetchCodexSubscription } from "../subscription";
import { fetchCodexUsageStatus } from "../usage-status";

type Pairs = [string, string][];

function headerPairs(init: HeadersInit | undefined): Pairs {
	return [...new Headers(init).entries()]
		.map(([name, value]): [string, string] => [name.toLowerCase(), value])
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

interface Captured {
	url: string;
	method: string | undefined;
	headers: Pairs;
	body: string | undefined;
}

let calls: Captured[];
let respond: (url: string) => Response;

const recordingFetch = mockFetch(async (input, init) => {
	const url = String(input);
	calls.push({
		url,
		method: init?.method,
		headers: headerPairs(init?.headers),
		body: typeof init?.body === "string" ? init.body : undefined,
	});
	return respond(url);
});

const originalFetch = globalThis.fetch;

beforeEach(() => {
	calls = [];
	respond = () => Response.json({});
	globalThis.fetch = recordingFetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

const TOKEN_WITH_ACCOUNT = jwt({
	"https://api.openai.com/auth": { chatgpt_account_id: "acct-from-jwt" },
});

const EXEC_UA =
	"codex_exec/0.155.1 (Debian 13.0.0; x86_64) xterm-256color (codex_exec; 0.155.1)";
const LOGIN_UA = "codex_cli_rs/0.155.1 (Debian 13.0.0; x86_64) xterm-256color";

const BACKEND_CLIENT_WITH_ACCOUNT: Pairs = [
	["accept", "*/*"],
	["authorization", "Bearer access-token"],
	["chatgpt-account-id", "acct-123"],
	["user-agent", EXEC_UA],
];

const BACKEND_CLIENT_WITHOUT_ACCOUNT: Pairs =
	BACKEND_CLIENT_WITH_ACCOUNT.filter(([name]) => name !== "chatgpt-account-id");

const MODELS_WITH_ACCOUNT: Pairs = [
	["accept", "*/*"],
	["authorization", "Bearer access-token"],
	["chatgpt-account-id", "acct-123"],
	["originator", "codex_exec"],
	["user-agent", EXEC_UA],
	["version", "0.155.1"],
];

const MODELS_WITHOUT_ACCOUNT: Pairs = MODELS_WITH_ACCOUNT.filter(
	([name]) => name !== "chatgpt-account-id",
);

/** The codex_exec persona before the body transform knows the endpoint. */
const EXEC_BASE: Pairs = [
	["accept", "text/event-stream"],
	["authorization", `Bearer ${TOKEN_WITH_ACCOUNT}`],
	["content-type", "application/json"],
	["originator", "codex_exec"],
	["user-agent", EXEC_UA],
	["version", "0.155.1"],
];

/** What every translated request to chatgpt.com carries, before any session headers. */
const EXEC_INFERENCE: Pairs = sortedPairs([
	...EXEC_BASE,
	["chatgpt-account-id", "acct-from-jwt"],
]);

function sortedPairs(pairs: Pairs): Pairs {
	return [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// Shaped like Claude Code 2.1.x on the Stainless Anthropic SDK.
const claudeCodeInbound = () =>
	new Headers({
		accept: "application/json",
		"accept-encoding": "gzip, deflate, br, zstd",
		"accept-language": "*",
		"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-version": "2023-06-01",
		authorization: "Bearer client-key",
		"chatgpt-account-id": "client-workspace",
		connection: "keep-alive",
		"content-length": "1234",
		"content-type": "application/json",
		cookie: "a=b",
		host: "localhost:8080",
		"openai-beta": "responses=experimental",
		"sec-fetch-mode": "cors",
		"session-id": "client-session",
		"user-agent": "claude-cli/2.1.237 (external, cli)",
		"x-api-key": "client-api-key",
		"x-app": "cli",
		"x-claude-code-session-id": "4b1f5c1e-8f0e-4d7a-9c3b-2a6d7e8f9a0b",
		"x-clankermux-request-id": "req-1",
		"x-openai-client-version": "1.2.3",
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

// Shaped like Codex 0.160 codex-tui on its HTTP Responses transport.
const codexTuiInbound = () =>
	new Headers({
		accept: "text/event-stream",
		authorization: "Bearer client-key",
		"chatgpt-account-id": "client-workspace",
		"content-type": "application/json",
		"openai-beta": "responses=experimental",
		originator: "codex-tui",
		"session-id": "0198a0b1-0000-7000-8000-000000000001",
		session_id: "0198a0b1-0000-7000-8000-000000000001",
		"thread-id": "0198a0b1-0000-7000-8000-000000000002",
		"user-agent":
			"codex-tui/0.160.0 (Mac OS 15.5.0; arm64) iTerm.app/3.5.14 (codex-tui; 0.160.0)",
		version: "0.160.0",
		"x-client-request-id": "0198a0b1-0000-7000-8000-000000000002",
		"x-codex-beta-features": "feature_a",
		"x-codex-installation-id": "inst-1",
		"x-codex-parent-thread-id": "0198a0b1-0000-7000-8000-000000000003",
		"x-codex-routing-hint": "hint-1",
		"x-codex-turn-metadata": '{"turn_id":"t-1"}',
		"x-codex-turn-state": "ts-1",
		"x-codex-window-id": "0198a0b1-0000-7000-8000-000000000002:0",
		"x-oai-attestation": "att-1",
		"x-openai-client-version": "1.2.3",
		"x-openai-internal-codex-responses-lite": "true",
		"x-openai-memgen-request": "true",
		"x-openai-subagent": "review",
	});

/** The continuity headers a Codex client's own request keeps. */
const CODEX_TUI_CONTINUITY: Pairs = [
	["session-id", "0198a0b1-0000-7000-8000-000000000001"],
	["thread-id", "0198a0b1-0000-7000-8000-000000000002"],
	["x-client-request-id", "0198a0b1-0000-7000-8000-000000000002"],
	["x-codex-beta-features", "feature_a"],
	["x-codex-parent-thread-id", "0198a0b1-0000-7000-8000-000000000003"],
	["x-codex-routing-hint", "hint-1"],
	["x-codex-turn-metadata", '{"turn_id":"t-1"}'],
	["x-codex-turn-state", "ts-1"],
	["x-codex-window-id", "0198a0b1-0000-7000-8000-000000000002:0"],
	["x-oai-attestation", "att-1"],
	["x-openai-internal-codex-responses-lite", "true"],
	["x-openai-memgen-request", "true"],
	["x-openai-subagent", "review"],
];

describe("Codex identity golden: inference headers (prepareHeaders)", () => {
	const provider = new CodexProvider();

	it("reduces a Claude Code inbound set to the pinned codex_exec persona", () => {
		const outbound = provider.prepareHeaders(
			claudeCodeInbound(),
			TOKEN_WITH_ACCOUNT,
		);
		expect(headerPairs(outbound)).toEqual(
			sortedPairs([
				...EXEC_BASE,
				["session-id", "client-session"],
				["x-clankermux-request-id", "req-1"],
			]),
		);
	});

	it("sets no Authorization without an access token", () => {
		const outbound = provider.prepareHeaders(claudeCodeInbound());
		expect(outbound.get("authorization")).toBeNull();
		expect(outbound.get("chatgpt-account-id")).toBeNull();
		expect(outbound.get("x-api-key")).toBeNull();
	});

	it("keeps a Codex client's continuity headers and parks its persona", () => {
		const outbound = provider.prepareHeaders(
			codexTuiInbound(),
			TOKEN_WITH_ACCOUNT,
		);
		expect(headerPairs(outbound)).toEqual(
			sortedPairs([
				...EXEC_BASE,
				...CODEX_TUI_CONTINUITY,
				[
					"x-clankermux-codex-client-user-agent",
					"codex-tui/0.155.1 (Mac OS 15.5.0; arm64) iTerm.app/3.5.14 (codex-tui; 0.155.1)",
				],
			]),
		);
	});

	it("drops an inbound native-responses flag and a forged persona header", () => {
		const outbound = provider.prepareHeaders(
			new Headers({
				"user-agent": "pi (linux 6.12; x64)",
				originator: "pi",
				"x-clankermux-native-responses": "1",
				"x-clankermux-codex-client-user-agent": "codex-tui/9.9.9 (forged)",
			}),
			TOKEN_WITH_ACCOUNT,
		);
		expect(headerPairs(outbound)).toEqual(EXEC_BASE);
	});
});

describe("Codex identity golden: translated request after body transform", () => {
	const provider = new CodexProvider();
	const account = { id: "a", name: "a", custom_endpoint: null } as never;

	it("sends the derived UUID as session-id, thread-id and x-client-request-id", async () => {
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: provider.prepareHeaders(claudeCodeInbound(), TOKEN_WITH_ACCOUNT),
			body: JSON.stringify({
				model: "gpt-5.4-mini",
				max_tokens: 16,
				metadata: {
					user_id: JSON.stringify({
						session_id: "4b1f5c1e-8f0e-4d7a-9c3b-2a6d7e8f9a0b",
					}),
				},
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		const out = await provider.transformRequestBody(request, account);
		const body = JSON.parse(await out.text()) as { prompt_cache_key?: string };
		const derived = "29e8c3bb-751b-408d-9200-322ecc0efcee";
		expect(body.prompt_cache_key).toBe(derived);
		expect(headerPairs(out.headers)).toEqual(
			sortedPairs([
				...EXEC_INFERENCE,
				["session-id", derived],
				["thread-id", derived],
				["x-client-request-id", derived],
				[
					"x-clankermux-reasoning-effort",
					"eyJyZXF1ZXN0ZWQiOm51bGwsImVmZmVjdGl2ZSI6Im1lZGl1bSIsInJlYXNvbiI6InByb3h5X2RlZmF1bHQifQ==",
				],
				["x-clankermux-request-id", "req-1"],
				["x-clankermux-request-stream", "false"],
			]),
		);
	});

	it("sends no ChatGPT-Account-ID to a custom endpoint, or for a token without one", async () => {
		const translate = async (token: string, custom_endpoint: string | null) => {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: provider.prepareHeaders(claudeCodeInbound(), token),
				body: JSON.stringify({
					model: "gpt-5.4-mini",
					max_tokens: 16,
					messages: [{ role: "user", content: "hi" }],
				}),
			});
			const out = await provider.transformRequestBody(request, {
				id: "a",
				name: "a",
				custom_endpoint,
			} as never);
			return out.headers.get("chatgpt-account-id");
		};
		expect(await translate(TOKEN_WITH_ACCOUNT, null)).toBe("acct-from-jwt");
		expect(
			await translate(
				TOKEN_WITH_ACCOUNT,
				"https://chatgpt.com/backend-api/codex/responses",
			),
		).toBe("acct-from-jwt");
		expect(
			await translate(
				TOKEN_WITH_ACCOUNT,
				"https://llm.example.com/v1/responses",
			),
		).toBeNull();
		expect(await translate("opaque", null)).toBeNull();
	});

	it("gates ChatGPT-Account-ID on the endpoint when translation fails", async () => {
		const malformed = async (custom_endpoint: string | null) => {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: provider.prepareHeaders(
					claudeCodeInbound(),
					TOKEN_WITH_ACCOUNT,
				),
				body: "{not json",
			});
			const out = await provider.transformRequestBody(request, {
				id: "a",
				name: "a",
				custom_endpoint,
			} as never);
			return out.headers.get("chatgpt-account-id");
		};
		expect(await malformed(null)).toBe("acct-from-jwt");
		expect(
			await malformed("https://chatgpt.com/backend-api/codex/responses"),
		).toBe("acct-from-jwt");
		expect(await malformed("https://llm.example.com/v1/responses")).toBeNull();
	});

	it("keeps the pinned persona for a Codex client routed through the translator", async () => {
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: provider.prepareHeaders(codexTuiInbound(), TOKEN_WITH_ACCOUNT),
			body: JSON.stringify({
				model: "gpt-5.4-mini",
				max_tokens: 16,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		const out = await provider.transformRequestBody(request, account);
		expect(headerPairs(out.headers)).toEqual(
			sortedPairs([
				...EXEC_INFERENCE,
				[
					"x-clankermux-reasoning-effort",
					"eyJyZXF1ZXN0ZWQiOm51bGwsImVmZmVjdGl2ZSI6Im1lZGl1bSIsInJlYXNvbiI6InByb3h5X2RlZmF1bHQifQ==",
				],
				["x-clankermux-request-stream", "false"],
			]),
		);
	});
});

describe("Codex identity golden: native Responses passthrough", () => {
	const provider = new CodexProvider();
	const account = { id: "a", name: "a", custom_endpoint: null } as never;

	// The proxy sets the native flag after prepareHeaders, never the client.
	async function nativeAttempt(
		inbound: Headers,
		body: Record<string, unknown>,
		target = account,
	) {
		const headers = provider.prepareHeaders(inbound, TOKEN_WITH_ACCOUNT);
		headers.set("x-clankermux-native-responses", "1");
		const request = new Request("https://proxy.local/v1/responses", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		return provider.transformRequestBody(request, target);
	}

	it("a Codex client keeps its own persona, version-aligned, and its continuity headers", async () => {
		const out = await nativeAttempt(codexTuiInbound(), {
			model: "gpt-5.4-mini",
			input: [],
			prompt_cache_key: "0198a0b1-0000-7000-8000-000000000001",
		});
		expect(headerPairs(out.headers)).toEqual(
			sortedPairs([
				["accept", "text/event-stream"],
				["authorization", `Bearer ${TOKEN_WITH_ACCOUNT}`],
				["chatgpt-account-id", "acct-from-jwt"],
				["content-type", "application/json"],
				["originator", "codex-tui"],
				[
					"user-agent",
					"codex-tui/0.155.1 (Mac OS 15.5.0; arm64) iTerm.app/3.5.14 (codex-tui; 0.155.1)",
				],
				["version", "0.155.1"],
				...CODEX_TUI_CONTINUITY,
				["x-clankermux-native-responses", "1"],
				["x-clankermux-request-stream", "true"],
			]),
		);
	});

	it("any other client gets the pinned persona and a session-id from prompt_cache_key", async () => {
		const out = await nativeAttempt(
			new Headers({
				"chatgpt-account-id": "client-workspace",
				"content-type": "application/json",
				"openai-beta": "responses=experimental",
				originator: "pi",
				session_id: "pi-session-1",
				"user-agent": "pi (linux 6.12.0; x64)",
			}),
			{ model: "gpt-5.4-mini", input: [], prompt_cache_key: "pi-session-1" },
		);
		expect(headerPairs(out.headers)).toEqual(
			sortedPairs([
				...EXEC_INFERENCE,
				["session-id", "pi-session-1"],
				["thread-id", "pi-session-1"],
				["x-client-request-id", "pi-session-1"],
				["x-clankermux-native-responses", "1"],
				["x-clankermux-request-stream", "true"],
			]),
		);
	});

	it("any other client's own thread-id and per-request x-client-request-id follow its session-id", async () => {
		const out = await nativeAttempt(
			new Headers({
				"content-type": "application/json",
				originator: "pi",
				"session-id": "pi-session-2",
				"thread-id": "pi-thread",
				"user-agent": "pi (linux 6.12.0; x64)",
				"x-client-request-id": "req-0001",
			}),
			{ model: "gpt-5.4-mini", input: [], prompt_cache_key: "other-key" },
		);
		expect(headerPairs(out.headers)).toEqual(
			sortedPairs([
				...EXEC_INFERENCE,
				["session-id", "pi-session-2"],
				["thread-id", "pi-session-2"],
				["x-client-request-id", "pi-session-2"],
				["x-clankermux-native-responses", "1"],
				["x-clankermux-request-stream", "true"],
			]),
		);
	});

	it("any other client without a usable session id sends no thread-id or x-client-request-id", async () => {
		const out = await nativeAttempt(
			new Headers({
				"content-type": "application/json",
				"thread-id": "pi-thread",
				"user-agent": "pi (linux 6.12.0; x64)",
				"x-client-request-id": "req-0001",
			}),
			{ model: "gpt-5.4-mini", input: [] },
		);
		expect(headerPairs(out.headers)).toEqual(
			sortedPairs([
				...EXEC_INFERENCE,
				["x-clankermux-native-responses", "1"],
				["x-clankermux-request-stream", "true"],
			]),
		);
	});

	it("a custom endpoint gets no ChatGPT-Account-ID, for a Codex client or any other", async () => {
		const custom = {
			id: "a",
			name: "a",
			custom_endpoint: "https://llm.example.com/v1/responses",
		} as never;
		const codex = await nativeAttempt(
			codexTuiInbound(),
			{ model: "gpt-5.4-mini", input: [] },
			custom,
		);
		const other = await nativeAttempt(
			new Headers({ "user-agent": "pi (linux 6.12.0; x64)" }),
			{ model: "gpt-5.4-mini", input: [] },
			custom,
		);
		expect(codex.headers.get("chatgpt-account-id")).toBeNull();
		expect(other.headers.get("chatgpt-account-id")).toBeNull();
	});
});

describe("Codex identity golden: side calls", () => {
	it("model catalog", async () => {
		await fetchCodexModelCatalog({
			accessToken: "access-token",
			chatgptAccountId: " acct-123 ",
			fetchImpl: recordingFetch,
		});
		await fetchCodexModelCatalog({
			accessToken: "access-token",
			chatgptAccountId: null,
			fetchImpl: recordingFetch,
		});
		expect(calls.map(({ url, method }) => [url, method])).toEqual([
			[
				"https://chatgpt.com/backend-api/codex/models?client_version=0.155.1",
				"GET",
			],
			[
				"https://chatgpt.com/backend-api/codex/models?client_version=0.155.1",
				"GET",
			],
		]);
		expect(calls[0].headers).toEqual(MODELS_WITH_ACCOUNT);
		expect(calls[1].headers).toEqual(MODELS_WITHOUT_ACCOUNT);
	});

	it("subscription", async () => {
		await fetchCodexSubscription({
			accessToken: "access-token",
			chatgptAccountId: " acct-123 ",
			fetchImpl: recordingFetch,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(
			"https://chatgpt.com/backend-api/subscriptions?account_id=acct-123",
		);
		expect(calls[0].method).toBe("GET");
		expect(calls[0].headers).toEqual(BACKEND_CLIENT_WITH_ACCOUNT);
	});

	it("usage status", async () => {
		await fetchCodexUsageStatus({
			accessToken: "access-token",
			chatgptAccountId: " acct-123 ",
			fetchImpl: recordingFetch,
		});
		await fetchCodexUsageStatus({
			accessToken: "access-token",
			chatgptAccountId: "  ",
			fetchImpl: recordingFetch,
		});
		expect(calls.map(({ url, method }) => [url, method])).toEqual([
			["https://chatgpt.com/backend-api/wham/usage", "GET"],
			["https://chatgpt.com/backend-api/wham/usage", "GET"],
		]);
		expect(calls[0].headers).toEqual(BACKEND_CLIENT_WITH_ACCOUNT);
		expect(calls[1].headers).toEqual(BACKEND_CLIENT_WITHOUT_ACCOUNT);
	});

	it("reset-credit read takes the account id from the JWT", async () => {
		await fetchCodexRateLimitResetCredits(TOKEN_WITH_ACCOUNT);
		await fetchCodexRateLimitResetCredits("opaque-token");
		expect(calls.map(({ url, method }) => [url, method])).toEqual([
			["https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", "GET"],
			["https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", "GET"],
		]);
		expect(calls[0].headers).toEqual([
			["accept", "*/*"],
			["authorization", `Bearer ${TOKEN_WITH_ACCOUNT}`],
			["chatgpt-account-id", "acct-from-jwt"],
			["user-agent", EXEC_UA],
		]);
		expect(calls[1].headers).toEqual([
			["accept", "*/*"],
			["authorization", "Bearer opaque-token"],
			["user-agent", EXEC_UA],
		]);
	});

	it("reset-credit consume", async () => {
		respond = () => Response.json({ code: "reset", windowsReset: 1 });
		await consumeCodexRateLimitResetCredit(TOKEN_WITH_ACCOUNT, {
			idempotencyKey: "idem-1",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
		);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].headers).toEqual([
			["accept", "*/*"],
			["authorization", `Bearer ${TOKEN_WITH_ACCOUNT}`],
			["chatgpt-account-id", "acct-from-jwt"],
			["content-type", "application/json"],
			["user-agent", EXEC_UA],
		]);
	});
});

describe("Codex identity golden: native ping", () => {
	it("sends the translated inference identity", async () => {
		await sendCodexNativePing(TOKEN_WITH_ACCOUNT);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].headers).toEqual(EXEC_INFERENCE);
	});

	it("sends no ChatGPT-Account-ID to a custom endpoint", async () => {
		await sendCodexNativePing(
			TOKEN_WITH_ACCOUNT,
			"https://llm.example.com/v1/responses",
		);
		expect(calls[0].headers).toEqual(EXEC_BASE);
	});
});

describe("Codex identity golden: OAuth", () => {
	// Real login requests carry no User-Agent at all; Bun cannot omit one, so
	// they carry the pre-init CLI identity instead of Bun's own.
	const LOGIN_FORM: Pairs = [
		["content-type", "application/x-www-form-urlencoded"],
		["user-agent", LOGIN_UA],
	];
	const LOGIN_JSON: Pairs = [
		["content-type", "application/json"],
		["user-agent", LOGIN_UA],
	];
	const tokenResponse = () =>
		Response.json({
			access_token: "new-access",
			refresh_token: "new-refresh",
			expires_in: 3600,
		});

	it("authorize URL", () => {
		const oauth = new CodexOAuthProvider();
		const url = oauth.generateAuthUrl(oauth.getOAuthConfig(), {
			verifier: "verifier",
			challenge: "challenge",
		});
		expect(url.replace(/state=[0-9a-f]{64}/, "state=STATE")).toBe(
			"https://auth.openai.com/oauth/authorize" +
				"?response_type=code" +
				"&client_id=app_EMoamEEZ73f0CkXaXp7hrann" +
				"&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" +
				"&scope=openid%20profile%20email%20offline_access%20api.connectors.read%20api.connectors.invoke" +
				"&code_challenge=challenge" +
				"&code_challenge_method=S256" +
				"&id_token_add_organizations=true" +
				"&codex_cli_simplified_flow=true" +
				"&state=STATE" +
				"&originator=codex_cli_rs",
		);
	});

	it("authorization-code exchange", async () => {
		respond = tokenResponse;
		const oauth = new CodexOAuthProvider();
		await oauth.exchangeCode("code-1", "verifier-1", oauth.getOAuthConfig());
		expect(calls).toEqual([
			{
				url: "https://auth.openai.com/oauth/token",
				method: "POST",
				headers: LOGIN_FORM,
				body:
					"grant_type=authorization_code&code=code-1" +
					"&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" +
					"&client_id=app_EMoamEEZ73f0CkXaXp7hrann&code_verifier=verifier-1",
			},
		]);
	});

	it("refresh", async () => {
		respond = tokenResponse;
		await new CodexProvider().refreshToken(
			{ id: "a", name: "a", refresh_token: "old-refresh" } as never,
			"ignored-client-id",
		);
		expect(calls).toEqual([
			{
				url: "https://auth.openai.com/oauth/token",
				method: "POST",
				headers: [
					["accept", "*/*"],
					["content-type", "application/json"],
					["originator", "codex_exec"],
					["user-agent", EXEC_UA],
				],
				body:
					'{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann",' +
					'"grant_type":"refresh_token","refresh_token":"old-refresh"}',
			},
		]);
	});

	it("device flow: user code, poll, exchange", async () => {
		respond = (url) =>
			url.endsWith("/usercode")
				? Response.json({ device_auth_id: "dev-1", user_code: "ABCD" })
				: url.endsWith("/deviceauth/token")
					? Response.json({
							authorization_code: "auth-code",
							code_challenge: "cc",
							code_verifier: "cv",
						})
					: tokenResponse();
		await initiateCodexDeviceFlow();
		await pollCodexForToken("dev-1", "ABCD", 0, 1);
		expect(calls).toEqual([
			{
				url: "https://auth.openai.com/api/accounts/deviceauth/usercode",
				method: "POST",
				headers: LOGIN_JSON,
				body: '{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}',
			},
			{
				url: "https://auth.openai.com/api/accounts/deviceauth/token",
				method: "POST",
				headers: LOGIN_JSON,
				body: '{"device_auth_id":"dev-1","user_code":"ABCD"}',
			},
			{
				url: "https://auth.openai.com/oauth/token",
				method: "POST",
				headers: LOGIN_FORM,
				body:
					"grant_type=authorization_code&code=auth-code" +
					"&redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback" +
					"&client_id=app_EMoamEEZ73f0CkXaXp7hrann&code_verifier=cv",
			},
		]);
	});
});
