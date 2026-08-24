/**
 * The "all accounts failed" terminal — the last thing `handleProxy` does when
 * every candidate has been attempted and none produced a response.
 *
 * It used to throw WITHOUT writing anything: eight of these in a week existed
 * only as a log line, invisible in Request History while the client got a 503.
 * These tests pin the synthetic row it now writes: its two distinct labels, the
 * REAL attempt count it persists, and the collision guard that keeps it from
 * overwriting a live record that already exists for the same request id.
 *
 * They also pin the narrowed provider-path validation: an account whose
 * provider cannot serve the path fails over exactly as before, but is now a
 * DEBUG note rather than an ERROR classified as a network failure.
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
import { logBus } from "@clankermux/logger";
import { usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import {
	resetOverloadHoldSlots,
	setOverloadHoldBudgetOverrideForTests,
} from "../overload-hold";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
} from "../provider-overload-cooldown";

let idCounter = 0;
function uniqueId(prefix: string): string {
	idCounter++;
	return `${prefix}-${idCounter}`;
}

const MODEL = "claude-haiku-4-5";
/** Older than the refresh-token max age, so the token reads as expired. */
const LONG_AGO = Date.now() - 400 * 24 * 60 * 60 * 1000;

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: uniqueId("acc"),
		name: "Main-me",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: null,
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
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

type RecorderMock = {
	begin: ReturnType<typeof mock>;
	hasRecord: ReturnType<typeof mock>;
	recordSynthetic: ReturnType<typeof mock>;
	captureResponseChunk: ReturnType<typeof mock>;
	finishTransport: ReturnType<typeof mock>;
	attachUsageSummary: ReturnType<typeof mock>;
	markUsageUnavailable: ReturnType<typeof mock>;
	sweep: ReturnType<typeof mock>;
	dispose: ReturnType<typeof mock>;
};

function makeContext(
	accounts: Account[],
	recorderOverrides: Partial<Record<"hasRecord", () => boolean>> = {},
): ProxyContext & { recorder: RecorderMock } {
	const recorder: RecorderMock = {
		begin: mock(() => {}),
		hasRecord: mock(recorderOverrides.hasRecord ?? (() => false)),
		recordSynthetic: mock(() => {}),
		captureResponseChunk: mock(() => {}),
		finishTransport: mock(() => {}),
		attachUsageSummary: mock(() => {}),
		markUsageUnavailable: mock(() => {}),
		sweep: mock(() => {}),
		dispose: mock(() => {}),
	};
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
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(
				async (id: string) => accounts.find((a) => a.id === id) ?? null,
			),
			getActiveComboForFamily: mock(async () => null),
			getApiKeyPin: mock(async () => null),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
			updateAccountRateLimitMeta: mock(async () => {}),
			resetConsecutiveRateLimits: mock(async () => {}),
			getAdapter: mock(() => ({
				run: mock(async () => {}),
				get: mock(async () => null),
			})),
		} as never,
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
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		requestRecorder: recorder as never,
	} as unknown as ProxyContext;
	return Object.assign(ctx, { recorder });
}

function makeRequest(path = "/v1/messages"): Request {
	return new Request(`https://proxy.local${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function ok200() {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: MODEL,
			stop_reason: "end_turn",
			usage: { input_tokens: 10, output_tokens: 5 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function unauthorized() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "authentication_error", message: "bad token" },
		}),
		{ status: 401, headers: { "content-type": "application/json" } },
	);
}

/** Keep unrelated background fetches (pricing catalog) off the handler. */
function upstreamOnlyFetch(
	handler: (input: Request | string | URL) => Response | Promise<Response>,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.includes("api.anthropic.com") && !url.includes("chatgpt.com")) {
			return new Response("unavailable", { status: 500 });
		}
		return handler(input);
	}) as never;
}

/** The RecordMeta of the single synthetic row written, plus its label. */
function syntheticCall(recorder: RecorderMock): {
	meta: { responseStatus: number; failoverAttempts: number };
	label: string;
} {
	expect(recorder.recordSynthetic).toHaveBeenCalledTimes(1);
	const call = recorder.recordSynthetic.mock.calls[0] as unknown[];
	return {
		meta: call[0] as { responseStatus: number; failoverAttempts: number },
		label: call[2] as string,
	};
}

describe("all-accounts-failed terminal", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		await import("../proxy");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
		setOverloadHoldBudgetOverrideForTests(null);
	});

	it("records the generic exhaustion terminal with the real attempt count", async () => {
		globalThis.fetch = upstreamOnlyFetch(async () => unauthorized());
		const account = makeAccount();
		usageCache.delete(account.id);
		const ctx = makeContext([account]);

		await expect(
			callHandleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			),
		).rejects.toThrow(/All accounts failed/);

		const { meta, label } = syntheticCall(ctx.recorder);
		expect(label).toBe("all_accounts_failed");
		expect(meta.responseStatus).toBe(503);
		expect(meta.failoverAttempts).toBe(1);
	});

	it("records the OAuth-expired terminal under its own distinct label", async () => {
		globalThis.fetch = upstreamOnlyFetch(async () => unauthorized());
		// An OAuth account whose refresh token is far past its max age: the
		// terminal names it and tells the operator to re-authenticate, which is a
		// different diagnosis from generic exhaustion and must stay distinguishable
		// in history.
		const account = makeAccount({
			api_key: null,
			refresh_token: "rt-old",
			access_token: "at",
			expires_at: Date.now() + 3_600_000,
			created_at: LONG_AGO,
			refresh_token_issued_at: LONG_AGO,
		});
		usageCache.delete(account.id);
		const ctx = makeContext([account]);

		await expect(
			callHandleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			),
		).rejects.toThrow(/OAuth tokens have expired/);

		const { meta, label } = syntheticCall(ctx.recorder);
		expect(label).toBe("oauth_tokens_expired");
		expect(meta.responseStatus).toBe(503);
	});

	it("writes NOTHING when a live record already exists for the request id", async () => {
		// begin() ran (an upstream responded, then a setup exception turned into
		// failover). recordSynthetic bypasses the live-record map and the row
		// upserts, so writing here would either overwrite the real completion or
		// emit a second summary.
		globalThis.fetch = upstreamOnlyFetch(async () => unauthorized());
		const account = makeAccount();
		usageCache.delete(account.id);
		const ctx = makeContext([account], { hasRecord: () => true });

		await expect(
			callHandleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			),
		).rejects.toThrow(/All accounts failed/);

		expect(ctx.recorder.recordSynthetic).not.toHaveBeenCalled();
	});

	it("persists attempts actually made, not the candidate count", async () => {
		// Two candidates, ONE attempt: the first is tried and fails, and that
		// attempt trips the breaker, so the second is dropped by the loop's late
		// overload gate before any upstream work.
		//
		// This now lands on the provider-overloaded terminal rather than
		// ALL_ACCOUNTS_FAILED: a request blocked by an overload is told so, and
		// can wait for recovery instead of eating a hard 503 (production
		// 2026-08-24 18:43:08 — one such 503 alongside two 200s a second apart).
		//
		// The accounting invariant is the same at either terminal and is the
		// point of this test: the row records ATTEMPTS, not candidates. Recording
		// 0 here would understate what happened in exactly the way this file
		// exists to prevent. Budget shrunk so the hold gives up promptly.
		setOverloadHoldBudgetOverrideForTests(300);
		let fetchCalls = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
			fetchCalls++;
			applyProviderOverloadCooldown("anthropic", Date.now() + 60_000, MODEL);
			return unauthorized();
		});
		const first = makeAccount({ name: "First" });
		const second = makeAccount({ name: "Second" });
		for (const a of [first, second]) usageCache.delete(a.id);
		const ctx = makeContext([first, second]);

		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(529);
		expect(fetchCalls).toBe(1);
		const { meta, label } = syntheticCall(ctx.recorder);
		expect(label).toBe("provider_overloaded");
		expect(meta.failoverAttempts).toBe(1);
	}, 10_000);

	it("fails over past a path-incompatible candidate without an ERROR", async () => {
		// CodexProvider serves only /v1/messages(+count_tokens). The incompatible
		// candidate must still fail over silently — it is a routing fact, not a
		// network failure.
		const errorLines: string[] = [];
		const listener = (event: { level: string; msg: string }): void => {
			if (event.level === "ERROR") errorLines.push(event.msg);
		};
		logBus.on("log", listener);
		try {
			globalThis.fetch = upstreamOnlyFetch(async () => ok200());
			const codex = makeAccount({
				name: "Codex",
				provider: "codex",
				api_key: null,
				access_token: "at",
				refresh_token: "rt",
				expires_at: Date.now() + 3_600_000,
				priority: 0,
			});
			const anthropic = makeAccount({ name: "Anthropic", priority: 1 });
			for (const a of [codex, anthropic]) usageCache.delete(a.id);
			const ctx = makeContext([codex, anthropic]);

			const res = await callHandleProxy(
				makeRequest("/v1/chat/completions"),
				new URL("https://proxy.local/v1/chat/completions"),
				ctx,
			);

			expect(res.status).toBe(200);
			expect(errorLines).toEqual([]);
		} finally {
			logBus.off("log", listener);
		}
	});

	it("records generic exhaustion for an all-Codex pool on an unsupported endpoint", async () => {
		// No new terminal category: the pool simply had nothing that could serve
		// the path.
		globalThis.fetch = upstreamOnlyFetch(async () => ok200());
		const codex = makeAccount({
			name: "Codex",
			provider: "codex",
			api_key: null,
			access_token: "at",
			refresh_token: "rt",
			expires_at: Date.now() + 3_600_000,
		});
		usageCache.delete(codex.id);
		const ctx = makeContext([codex]);

		await expect(
			callHandleProxy(
				makeRequest("/v1/chat/completions"),
				new URL("https://proxy.local/v1/chat/completions"),
				ctx,
			),
		).rejects.toThrow(/All accounts failed/);

		const { label } = syntheticCall(ctx.recorder);
		expect(label).toBe("all_accounts_failed");
	});
});
