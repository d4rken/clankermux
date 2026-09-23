/**
 * Golden record of the Codex client identity on every request ClankerMux
 * originates to OpenAI, captured at the fetch boundary. Values are literals on
 * purpose: a change to any constant has to show up as a diff in this file.
 *
 * Calls that set no User-Agent go out with Bun's own default on the wire.
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

const SIDE_CALL_WITH_ACCOUNT: Pairs = [
	["accept", "application/json"],
	["authorization", "Bearer access-token"],
	["chatgpt-account-id", "acct-123"],
	["originator", "codex_cli_rs"],
	["user-agent", "codex-cli/0.155.1 (Windows 10.0.26100; x64)"],
	["version", "0.155.1"],
];

const SIDE_CALL_WITHOUT_ACCOUNT: Pairs = SIDE_CALL_WITH_ACCOUNT.filter(
	([name]) => name !== "chatgpt-account-id",
);

describe("Codex identity golden: inference headers (prepareHeaders)", () => {
	const provider = new CodexProvider();

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
			connection: "keep-alive",
			"content-length": "1234",
			"content-type": "application/json",
			host: "localhost:8080",
			"sec-fetch-mode": "cors",
			"user-agent": "claude-cli/2.1.237 (external, cli)",
			"x-api-key": "client-api-key",
			"x-app": "cli",
			"x-claude-code-session-id": "4b1f5c1e-8f0e-4d7a-9c3b-2a6d7e8f9a0b",
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

	it("rewrites a Claude Code inbound set", () => {
		const outbound = provider.prepareHeaders(
			claudeCodeInbound(),
			"access-token",
		);
		expect(headerPairs(outbound)).toEqual([
			["accept", "application/json"],
			["accept-encoding", "gzip, deflate, br, zstd"],
			["accept-language", "*"],
			["authorization", "Bearer access-token"],
			["connection", "keep-alive"],
			["content-length", "1234"],
			["content-type", "application/json"],
			["openai-beta", "responses=experimental"],
			["originator", "codex_cli_rs"],
			["sec-fetch-mode", "cors"],
			["user-agent", "codex-cli/0.155.1 (Windows 10.0.26100; x64)"],
			["version", "0.155.1"],
			["x-app", "cli"],
			["x-claude-code-session-id", "4b1f5c1e-8f0e-4d7a-9c3b-2a6d7e8f9a0b"],
		]);
	});

	it("sets no Authorization without an access token", () => {
		const outbound = provider.prepareHeaders(claudeCodeInbound());
		expect(outbound.get("authorization")).toBeNull();
		expect(outbound.get("x-api-key")).toBeNull();
	});

	it("rewrites a Codex CLI inbound set", () => {
		const inbound = new Headers({
			accept: "text/event-stream",
			authorization: "Bearer client-key",
			"chatgpt-account-id": "client-workspace",
			"content-type": "application/json",
			"openai-beta": "responses=experimental",
			originator: "codex-tui",
			session_id: "0198a0b1-0000-7000-8000-000000000001",
			"user-agent":
				"codex-tui/0.160.0 (Mac OS 15.5.0; arm64) iTerm.app/3.5.14 (codex-tui; 0.160.0)",
			version: "0.160.0",
			"x-codex-installation-id": "inst-1",
			"x-codex-turn-state": "ts-1",
			"x-openai-client-version": "1.2.3",
			"x-openai-subagent": "review",
		});
		const outbound = provider.prepareHeaders(inbound, "access-token");
		expect(headerPairs(outbound)).toEqual([
			["accept", "text/event-stream"],
			["authorization", "Bearer access-token"],
			["chatgpt-account-id", "client-workspace"],
			["content-type", "application/json"],
			["openai-beta", "responses=experimental"],
			["originator", "codex_cli_rs"],
			["session_id", "0198a0b1-0000-7000-8000-000000000001"],
			["user-agent", "codex-cli/0.155.1 (Windows 10.0.26100; x64)"],
			["version", "0.155.1"],
			["x-codex-installation-id", "inst-1"],
			["x-codex-turn-state", "ts-1"],
			["x-openai-subagent", "review"],
		]);
	});
});

describe("Codex identity golden: inference request after body transform", () => {
	const provider = new CodexProvider();
	const account = { id: "a", name: "a", custom_endpoint: null } as never;

	it("translated Claude Code request derives session-id from prompt_cache_key", async () => {
		const prepared = provider.prepareHeaders(
			new Headers({
				"content-type": "application/json",
				"user-agent": "claude-cli/2.1.237 (external, cli)",
				"x-app": "cli",
				"x-claude-code-session-id": "4b1f5c1e-8f0e-4d7a-9c3b-2a6d7e8f9a0b",
			}),
			"access-token",
		);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: prepared,
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
		expect(body.prompt_cache_key).toBe(
			"clankermux-convo-29e8c3bb751b608dd200322ecc0efcee196d1f89de10f",
		);
		expect(headerPairs(out.headers)).toEqual([
			["authorization", "Bearer access-token"],
			["content-type", "application/json"],
			["openai-beta", "responses=experimental"],
			["originator", "codex_cli_rs"],
			[
				"session-id",
				"clankermux-convo-29e8c3bb751b608dd200322ecc0efcee196d1f89de10f",
			],
			["user-agent", "codex-cli/0.155.1 (Windows 10.0.26100; x64)"],
			["version", "0.155.1"],
			["x-app", "cli"],
			[
				"x-clankermux-reasoning-effort",
				"eyJyZXF1ZXN0ZWQiOm51bGwsImVmZmVjdGl2ZSI6Im1lZGl1bSIsInJlYXNvbiI6InByb3h5X2RlZmF1bHQifQ==",
			],
			["x-clankermux-request-stream", "false"],
			["x-claude-code-session-id", "4b1f5c1e-8f0e-4d7a-9c3b-2a6d7e8f9a0b"],
		]);
	});
});

describe("Codex identity golden: native Responses passthrough", () => {
	const provider = new CodexProvider();
	const account = { id: "a", name: "a", custom_endpoint: null } as never;

	it("Codex CLI request keeps its session_id and gains a derived session-id", async () => {
		const prepared = provider.prepareHeaders(
			new Headers({
				"content-type": "application/json",
				originator: "codex-tui",
				session_id: "0198a0b1-0000-7000-8000-000000000001",
				"user-agent": "codex-tui/0.160.0 (Mac OS 15.5.0; arm64)",
				version: "0.160.0",
				"x-clankermux-native-responses": "1",
			}),
			"access-token",
		);
		const request = new Request("https://proxy.local/v1/responses", {
			method: "POST",
			headers: prepared,
			body: JSON.stringify({
				model: "gpt-5.4-mini",
				input: [],
				prompt_cache_key: "0198a0b1-0000-7000-8000-000000000001",
			}),
		});
		const out = await provider.transformRequestBody(request, account);
		expect(headerPairs(out.headers)).toEqual([
			["authorization", "Bearer access-token"],
			["content-type", "application/json"],
			["openai-beta", "responses=experimental"],
			["originator", "codex_cli_rs"],
			["session-id", "0198a0b1-0000-7000-8000-000000000001"],
			["session_id", "0198a0b1-0000-7000-8000-000000000001"],
			["user-agent", "codex-cli/0.155.1 (Windows 10.0.26100; x64)"],
			["version", "0.155.1"],
			["x-clankermux-native-responses", "1"],
			["x-clankermux-request-stream", "true"],
		]);
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
		expect(calls[0].headers).toEqual(SIDE_CALL_WITH_ACCOUNT);
		expect(calls[1].headers).toEqual(SIDE_CALL_WITHOUT_ACCOUNT);
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
		expect(calls[0].headers).toEqual(SIDE_CALL_WITH_ACCOUNT);
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
		expect(calls[0].headers).toEqual(SIDE_CALL_WITH_ACCOUNT);
		expect(calls[1].headers).toEqual(SIDE_CALL_WITHOUT_ACCOUNT);
	});

	it("reset-credit read takes the account id from the JWT", async () => {
		await fetchCodexRateLimitResetCredits(TOKEN_WITH_ACCOUNT);
		await fetchCodexRateLimitResetCredits("opaque-token");
		expect(calls.map(({ url, method }) => [url, method])).toEqual([
			["https://chatgpt.com/backend-api/codex/rate-limit-reset-credits", "GET"],
			["https://chatgpt.com/backend-api/codex/rate-limit-reset-credits", "GET"],
		]);
		expect(calls[0].headers).toEqual([
			["accept", "application/json"],
			["authorization", `Bearer ${TOKEN_WITH_ACCOUNT}`],
			["chatgpt-account-id", "acct-from-jwt"],
			["originator", "codex_cli_rs"],
			["user-agent", "codex-cli/0.155.1 (Windows 10.0.26100; x64)"],
			["version", "0.155.1"],
		]);
		expect(calls[1].headers).toEqual([
			["accept", "application/json"],
			["authorization", "Bearer opaque-token"],
			["originator", "codex_cli_rs"],
			["user-agent", "codex-cli/0.155.1 (Windows 10.0.26100; x64)"],
			["version", "0.155.1"],
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
			["accept", "application/json"],
			["authorization", `Bearer ${TOKEN_WITH_ACCOUNT}`],
			["chatgpt-account-id", "acct-from-jwt"],
			["content-type", "application/json"],
			["originator", "codex_cli_rs"],
			["user-agent", "codex-cli/0.155.1 (Windows 10.0.26100; x64)"],
			["version", "0.155.1"],
		]);
	});
});

describe("Codex identity golden: native ping", () => {
	it("sends no ChatGPT-Account-ID", async () => {
		await sendCodexNativePing(TOKEN_WITH_ACCOUNT);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].headers).toEqual([
			["accept", "text/event-stream"],
			["authorization", `Bearer ${TOKEN_WITH_ACCOUNT}`],
			["content-type", "application/json"],
			["openai-beta", "responses=experimental"],
			["originator", "codex_cli_rs"],
			["user-agent", "codex-cli/0.155.1 (Windows 10.0.26100; x64)"],
			["version", "0.155.1"],
		]);
	});
});

describe("Codex identity golden: OAuth", () => {
	const FORM: Pairs = [["content-type", "application/x-www-form-urlencoded"]];
	const JSON_BODY: Pairs = [["content-type", "application/json"]];
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
				"?client_id=app_EMoamEEZ73f0CkXaXp7hrann" +
				"&response_type=code" +
				"&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" +
				"&scope=openid%20profile%20email%20offline_access%20api.connectors.read%20api.connectors.invoke" +
				"&code_challenge=challenge" +
				"&code_challenge_method=S256" +
				"&state=STATE" +
				"&id_token_add_organizations=true" +
				"&codex_cli_simplified_flow=true" +
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
				headers: FORM,
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
				headers: FORM,
				body:
					"grant_type=refresh_token&refresh_token=old-refresh" +
					"&client_id=app_EMoamEEZ73f0CkXaXp7hrann" +
					"&scope=openid+profile+email+offline_access+api.connectors.read+api.connectors.invoke",
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
				headers: JSON_BODY,
				body: '{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}',
			},
			{
				url: "https://auth.openai.com/api/accounts/deviceauth/token",
				method: "POST",
				headers: JSON_BODY,
				body: '{"device_auth_id":"dev-1","user_code":"ABCD"}',
			},
			{
				url: "https://auth.openai.com/oauth/token",
				method: "POST",
				headers: FORM,
				body:
					"grant_type=authorization_code&code=auth-code" +
					"&redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback" +
					"&client_id=app_EMoamEEZ73f0CkXaXp7hrann&code_verifier=cv",
			},
		]);
	});
});
