/**
 * Ingress-to-persistence pin for `requests.client_user_agent` /
 * `requests.client_harness`.
 *
 * The two values are derived once at ingress and then copied by hand through
 * `RequestMeta` → the forward options → `RecordMeta` → `SaveRequestData` →
 * the repository. Every type in that chain declares them OPTIONAL, so a hop
 * that forgets to copy one compiles clean and writes SQL NULL — which reads as
 * "this client sent no user-agent", not as a bug. Neither the detector's unit
 * test nor the repository's round-trip test can see that; only a run through
 * the real path can.
 *
 * Both terminal shapes are covered because they build `RecordMeta` in different
 * places: `forwardToClient` for an upstream response, and
 * `createSyntheticTerminalRecorder` for a locally-produced one.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, GatewayHintMetadata } from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import { setForcedAccount } from "../handlers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { RequestRecorder } from "../request-recorder";
import { sessionProjectCache } from "../session-project-cache";
import { sessionPromotionTracker } from "../session-promotion";

const ACCOUNT_ID = "acc-harness-capture";
const CLAUDE_CODE_UA = "claude-cli/2.1.270 (external, cli)";

/** The columns under test, as the repository would receive them. */
interface SavedRow extends GatewayHintMetadata {
	id: string;
	clientUserAgent?: string | null;
	clientHarness?: string | null;
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "harness-capture",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		custom_endpoint: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

/**
 * A context carrying a REAL `RequestRecorder`. A recorder mock would only prove
 * the value reached `RecordMeta`; the assertion has to be on what the
 * repository is handed, because two more hand-copied hops sit between them.
 */
function makeContext(accounts: Account[]): {
	ctx: ProxyContext;
	saved: SavedRow[];
} {
	const saved: SavedRow[] = [];
	const dbOps = {
		getAllAccounts: mock(async () => accounts),
		getAccount: mock(
			async (id: string) => accounts.find((a) => a.id === id) ?? null,
		),
		getActiveComboForFamily: mock(async () => null),
		getApiKeyPin: mock(async () => null),
		markAccountRateLimited: mock(async () => 1),
		markAccountRateLimitedDeadlineOnly: mock(async () => {}),
		saveRequest: mock(async (data: SavedRow) => {
			saved.push(data);
		}),
		saveRequestRouting: mock(async () => {}),
		saveRequestHeaders: mock(async () => {}),
		saveRequestToolCalls: mock(async () => {}),
		encryptPayloadForStorage: mock(async (json: string) => json),
		updateRequestUsage: mock(async () => {}),
		updateAccountUsage: mock(async () => {}),
		updateAccountRateLimitMeta: mock(async () => {}),
		resetConsecutiveRateLimits: mock(async () => {}),
		pauseAccount: mock(async () => {}),
		getAdapter: mock(() => ({
			run: mock(async () => {}),
			get: mock(async () => null),
		})),
	};
	const asyncWriter = {
		enqueue: mock((job: () => void | Promise<void>) => {
			void job();
			return true;
		}),
		canAcceptPayload: mock(() => false),
		recordPayloadDrop: mock(() => {}),
		reservePayload: mock(() => null),
		enqueuePayload: mock(() => false),
	};
	const requestRecorder = new RequestRecorder({
		dbOps: dbOps as never,
		asyncWriter: asyncWriter as never,
		emitSummaryEvent: () => {},
		getStorePayloads: () => false,
		// Short grace so a request whose usage summary never arrives still
		// persists inside the poll window below.
		config: { SUMMARY_GRACE_MS: 5 },
	});

	const ctx = {
		strategy: {
			select: (accs: Account[]) => {
				const now = Date.now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= now),
				);
			},
		} as never,
		dbOps: dbOps as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: asyncWriter as never,
		requestRecorder: requestRecorder as never,
		server: { timeout: mock(() => {}) } as never,
	} as unknown as ProxyContext;

	return { ctx, saved };
}

/** Shunt the pricing-catalogue refresh so only the upstream stub answers. */
function upstreamOnlyFetch(
	onUpstream: () => Response,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.includes("api.anthropic.com")) {
			return new Response("unavailable", { status: 500 });
		}
		return onUpstream();
	}) as never;
}

function messagesRequest(headers: Record<string, string>): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function upstreamJson(): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "hi" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 11, output_tokens: 7 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

async function callHandleProxy(req: Request, ctx: ProxyContext) {
	const { handleProxy } = await import("./fixtures/routing-harness");
	return handleProxy(req, new URL("https://proxy.local/v1/messages"), ctx);
}

/** Wait for the recorder's async write to land, or give up. */
async function waitForSave(saved: SavedRow[]): Promise<SavedRow> {
	for (let i = 0; i < 200 && saved.length === 0; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const row = saved[0];
	if (!row) throw new Error("no request row was saved");
	return row;
}

function resetSingletons(): void {
	setForcedAccount(null);
	cacheBodyStore.setEnabled(false);
	sessionPromotionTracker.setMode("off");
	sessionPromotionTracker.clear();
	sessionProjectCache.clear();
	clearProviderOverloadCooldown();
	resetOverloadHoldSlots();
	resetRateLimitProbeGatesForTests();
	usageCache.delete(ACCOUNT_ID);
}

describe("client user-agent / harness capture", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		await import("./fixtures/routing-harness");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		resetSingletons();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetSingletons();
	});

	it("lands both columns on the row written for an upstream response", async () => {
		globalThis.fetch = upstreamOnlyFetch(upstreamJson);
		const { ctx, saved } = makeContext([makeAccount()]);

		const res = await callHandleProxy(
			messagesRequest({
				"User-Agent": CLAUDE_CODE_UA,
				"X-Claude-Code-Agent-Type": "explore",
				"x-claude-code-request-class": "primary",
			}),
			ctx,
		);
		expect(res.status).toBe(200);

		const row = await waitForSave(saved);
		expect(row.clientUserAgent).toBe(CLAUDE_CODE_UA);
		expect(row.clientHarness).toBe("claude-code");
		expect(row.gatewayHintAgentType).toBe("explore");
		expect(row.gatewayHintRequestClass).toBe("primary");
	});

	it("lands both columns on a synthetic terminal row", async () => {
		globalThis.fetch = upstreamOnlyFetch(upstreamJson);
		// A paused pool produces the pool_exhausted terminal, which writes its row
		// through createSyntheticTerminalRecorder instead of forwardToClient.
		const { ctx, saved } = makeContext([
			makeAccount({ paused: true, provider: "codex" }),
		]);

		const res = await callHandleProxy(
			messagesRequest({
				"User-Agent": "codex_cli_rs/0.104.0",
				originator: "codex_cli_rs",
				"x-claude-code-compaction": "false",
			}),
			ctx,
		);
		expect(res.status).toBe(503);

		const row = await waitForSave(saved);
		expect(row.clientUserAgent).toBe("codex_cli_rs/0.104.0");
		expect(row.clientHarness).toBe("codex");
		expect(row.gatewayHintCompaction).toBe("false");
	});

	it("writes NULL for both when the request carried no user-agent", async () => {
		globalThis.fetch = upstreamOnlyFetch(upstreamJson);
		const { ctx, saved } = makeContext([makeAccount()]);

		// Bun's Request adds no user-agent of its own, so this is a genuinely
		// agentless request — the shape that must stay distinguishable from a
		// client whose harness simply went unrecognized.
		const res = await callHandleProxy(messagesRequest({}), ctx);
		expect(res.status).toBe(200);

		const row = await waitForSave(saved);
		expect(row.clientUserAgent).toBeNull();
		expect(row.clientHarness).toBeNull();
	});
});
