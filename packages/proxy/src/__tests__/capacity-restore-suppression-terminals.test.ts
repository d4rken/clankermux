import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import {
	clearCapacityRestoredProbePending,
	getRateLimitProbeAdmission,
	markCapacityRestoredProbePending,
	resetRateLimitProbeGatesForTests,
} from "../handlers/rate-limit-cooldown";
import { setOverloadHoldBudgetOverrideForTests } from "../overload-hold";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
} from "../provider-overload-cooldown";

/**
 * A recovery-probe SUPPRESSION means nothing was attempted — another request is
 * probing the account right now. It is an AVAILABILITY condition, so it must
 * never be collapsed into a terminal that means something else:
 *   - not a SIZE verdict (a non-retryable context_window_exceeded 400), and
 *   - not "everything failed for ordinary reasons" (an immediate synthetic 529
 *     that abandons a hold with budget still left).
 */

const ACCOUNT_ID = "acc-suppressed";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "codex-suppressed",
		provider: "codex",
		api_key: "test-key",
		refresh_token: null,
		access_token: "at-token",
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
		notes: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

function makeContext(accounts: Account[]): ProxyContext {
	return {
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
			name: "codex",
			canHandle: () => true,
			buildUrl: () => "https://chatgpt.com/backend-api/codex/responses",
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
		requestRecorder: {
			begin: mock(() => {}),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
	};
}

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
}

/**
 * True for a real upstream proxy endpoint. Unrelated background fetches (e.g.
 * the pricing-table refresh in @clankermux/core) must never be counted as
 * upstream attempts — they would make the single-flight assertions lie.
 */
function isProxyCall(input: RequestInfo | URL): boolean {
	const url = input instanceof Request ? input.url : String(input);
	return (
		url.includes("api.anthropic.com") ||
		url.includes("chatgpt.com") ||
		url.includes("/v1/messages")
	);
}

/** Benign stub for those background fetches — never touches the network. */
function backgroundStub(): Response {
	return new Response("{}", {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/**
 * A request whose estimate is `targetEstimate` tokens (chars/3.0 + max_tokens).
 * Mirrors context-window-gate.test.ts.
 */
function makeSizedRequest(targetEstimate: number): Request {
	const overhead = JSON.stringify({
		model: "claude-opus-4-7",
		messages: [{ role: "user", content: "" }],
		max_tokens: 16,
	}).length;
	const neededChars = Math.ceil((targetEstimate - 16) * 3.0) - overhead + 10;
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-7",
			messages: [
				{ role: "user", content: "x".repeat(Math.max(0, neededChars)) },
			],
			max_tokens: 16,
		}),
	});
}

/**
 * Take the account's single-flight recovery-probe lease, exactly as a
 * concurrent request that is mid-probe would hold it.
 */
function holdProbeLease(): void {
	markCapacityRestoredProbePending(ACCOUNT_ID);
	const admission = getRateLimitProbeAdmission({
		id: ACCOUNT_ID,
		name: "lease-holder",
		consecutive_rate_limits: 0,
		rate_limited_until: null,
	} as unknown as Account);
	if (admission !== "admitted") {
		throw new Error(`expected to take the probe lease, got ${admission}`);
	}
}

describe("recovery-probe suppression must not become a size verdict (CW last resort)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		await import("../proxy");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		resetRateLimitProbeGatesForTests();
		clearCapacityRestoredProbePending(ACCOUNT_ID);
	});

	it("returns a RETRYABLE availability terminal when every fitting candidate is suppressed", async () => {
		// gpt-5.5 window = 272_000; the gate's margin excludes anything above
		// floor(272_000 * 0.97) = 263_840, but the unmargined last resort still
		// fits 268_000 — so this request DOES fit a real backend.
		const codex = makeAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		holdProbeLease();
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			if (!isProxyCall(input)) return backgroundStub();
			throw new Error("no upstream call expected — the attempt is suppressed");
		});

		const response = await callHandleProxy(
			makeSizedRequest(268_000),
			new URL("https://proxy.local/v1/messages"),
			makeContext([codex]),
		);

		const body = (await response.json()) as { error?: { type?: string } };
		// The request fits; only availability blocked it. Telling the client its
		// request is too large would be both wrong AND non-retryable.
		expect(response.status).not.toBe(400);
		expect(body.error?.type).not.toBe("context_window_exceeded");
		expect(response.status).toBe(503);
	});

	it("the CW hold keeps polling when its wake attempt is probe-suppressed", async () => {
		// holdForNonCodexRecovery waits on account COOLDOWNS. A probe-suppressed
		// candidate has none (that is why it was selectable), so once the cooldown
		// it was waiting on expires the loop saw "nothing to wait for" and exited —
		// handing the caller its terminal (here the size 400) although an account
		// was about to become usable.
		const codex = makeAccount({
			id: "codex-too-small",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		const anthropic = makeAccount({
			id: ACCOUNT_ID,
			name: "anthropic-suppressed",
			provider: "anthropic",
			access_token: "at-anthropic",
			// Cooled for 200ms: the hold waits this out, then re-selects it.
			rate_limited_until: Date.now() + 200,
		});
		const ctx = makeContext([codex, anthropic]);
		(ctx.provider as unknown as { name: string }).name = "anthropic";
		holdProbeLease();
		// The lease holder finishes after the hold's first (suppressed) wake.
		setTimeout(() => resetRateLimitProbeGatesForTests(), 700);

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			if (!isProxyCall(input)) return backgroundStub();
			anthropic.rate_limited_until = null;
			return new Response(
				JSON.stringify({
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model: "claude-opus-4-7",
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		// Sized past gpt-5.5's FULL window so there is no last-resort Codex
		// candidate: without the fix the request ends at the size 400.
		const response = await callHandleProxy(
			makeSizedRequest(500_000),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(200);
	}, 20_000);

	it("a MIXED CW-hold round polls only the suppressed account, never re-hammering the failed sibling", async () => {
		// Same shape as the overload hold's mixed round, on the other hold loop:
		// keeping the pass alive for A's in-flight probe must not drag B — which
		// has no verdict pending — into every ~1.5s poll for a budget that runs to
		// 330s here.
		const codex = makeAccount({
			id: "codex-too-small",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		const suppressed = makeAccount({
			id: ACCOUNT_ID,
			name: "anthropic-suppressed",
			provider: "anthropic",
			api_key: "key-suppressed",
			access_token: "key-suppressed",
			rate_limited_until: Date.now() + 200,
		});
		const broken = makeAccount({
			id: "acc-broken",
			name: "anthropic-broken",
			provider: "anthropic",
			api_key: "key-broken",
			access_token: "key-broken",
			priority: 1,
			rate_limited_until: Date.now() + 200,
		});
		const ctx = makeContext([codex, suppressed, broken]);
		(ctx.provider as unknown as { name: string }).name = "anthropic";
		holdProbeLease();
		// Long enough for several probe-verdict polls to elapse.
		setTimeout(() => resetRateLimitProbeGatesForTests(), 3_500);

		let brokenCalls = 0;
		let suppressedCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return backgroundStub();
				const headers =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				const credential = `${headers.get("x-api-key") ?? ""} ${headers.get("authorization") ?? ""}`;
				if (credential.includes("key-broken")) {
					brokenCalls += 1;
					throw new Error("connection refused");
				}
				suppressedCalls += 1;
				suppressed.rate_limited_until = null;
				return new Response(
					JSON.stringify({
						id: "msg_1",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
						model: "claude-opus-4-7",
						stop_reason: "end_turn",
						usage: { input_tokens: 1, output_tokens: 1 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		);

		const response = await callHandleProxy(
			makeSizedRequest(500_000),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(brokenCalls).toBe(1);
		expect(response.status).toBe(200);
		expect(suppressedCalls).toBe(1);
	}, 30_000);

	it("still returns the size 400 when NO candidate fits even the full window", async () => {
		// Same suppressed lease, but 500_000 tokens exceeds gpt-5.5's full window,
		// so there is no fitting candidate at all — the size verdict is correct.
		const codex = makeAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		holdProbeLease();

		const response = await callHandleProxy(
			makeSizedRequest(500_000),
			new URL("https://proxy.local/v1/messages"),
			makeContext([codex]),
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as { error?: { type?: string } };
		expect(body.error?.type).toBe("context_window_exceeded");
	});
});

describe("recovery-probe suppression must not abandon an overload hold", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		await import("../proxy");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		resetRateLimitProbeGatesForTests();
		setOverloadHoldBudgetOverrideForTests(12_000);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		resetRateLimitProbeGatesForTests();
		setOverloadHoldBudgetOverrideForTests(null);
		clearCapacityRestoredProbePending(ACCOUNT_ID);
	});

	it("keeps waiting within budget when the wake attempt is probe-suppressed", async () => {
		// The realistic shape: a capacity marker is pending behind an OPEN 529
		// breaker. When the breaker opens up, one request takes the probe lease and
		// this holder's wake attempt is suppressed — nothing was attempted, so the
		// hold must keep polling instead of bouncing a synthetic 529 with most of
		// its budget unspent.
		const account = makeAccount({
			provider: "anthropic",
			name: "anthropic-suppressed",
		});
		const ctx = makeContext([account]);
		(ctx.provider as unknown as { name: string }).name = "anthropic";
		holdProbeLease();
		// Breaker open for 200ms → the hold sleeps to that deadline, then wakes.
		applyProviderOverloadCooldown("anthropic", Date.now() + 200, null);

		let upstreamCalls = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			if (!isProxyCall(input)) return backgroundStub();
			upstreamCalls += 1;
			return new Response(
				JSON.stringify({
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model: "claude-sonnet-4-5",
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		// The lease holder finishes ~700ms in: after the hold's first (suppressed)
		// wake, but well inside its budget.
		setTimeout(() => resetRateLimitProbeGatesForTests(), 700);

		const start = Date.now();
		const response = await callHandleProxy(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			}),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		const elapsed = Date.now() - start;

		// Served after waiting for the in-flight probe — NOT bounced with a 529.
		expect(response.status).toBe(200);
		// Exactly one upstream attempt, made only AFTER the lease holder finished:
		// it waited rather than bouncing a 529 while the probe was in flight.
		expect(upstreamCalls).toBe(1);
		// It actually waited (breaker deadline + at least one suppression poll).
		expect(elapsed).toBeGreaterThan(700);
	}, 20_000);

	it("a MIXED round polls only the suppressed account, never re-hammering the failed sibling", async () => {
		// A is suppressed (a probe is in flight for it); B fails fast for an
		// ordinary reason. Keeping the round alive on A's account must not drag B
		// along: nothing is in flight for B, so every ~1.5s poll would re-attempt a
		// known-broken account for the whole 120s budget — and if B were failing
		// with a 429, that hammering can deepen a real rate limit.
		const suppressed = makeAccount({
			id: ACCOUNT_ID,
			name: "anthropic-suppressed",
			provider: "anthropic",
			api_key: "key-suppressed",
			access_token: "key-suppressed",
		});
		const broken = makeAccount({
			id: "acc-broken",
			name: "anthropic-broken",
			provider: "anthropic",
			api_key: "key-broken",
			access_token: "key-broken",
			priority: 1,
		});
		const ctx = makeContext([suppressed, broken]);
		(ctx.provider as unknown as { name: string }).name = "anthropic";
		holdProbeLease(); // only ACCOUNT_ID is gated by the probe lease
		applyProviderOverloadCooldown("anthropic", Date.now() + 200, null);

		let brokenCalls = 0;
		let suppressedCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return backgroundStub();
				const headers =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				// Anthropic accounts authenticate with x-api-key when they carry an
				// api_key, and with a bearer token otherwise — check both so the
				// routing can never silently collapse the two accounts into one.
				const credential = `${headers.get("x-api-key") ?? ""} ${headers.get("authorization") ?? ""}`;
				if (credential.includes("key-broken")) {
					brokenCalls += 1;
					// An ORDINARY failure (network rejection): the attempt fails over
					// with no verdict pending afterwards.
					throw new Error("connection refused");
				}
				suppressedCalls += 1;
				return new Response(
					JSON.stringify({
						id: "msg_1",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
						model: "claude-sonnet-4-5",
						stop_reason: "end_turn",
						usage: { input_tokens: 1, output_tokens: 1 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		);

		// Hold the lease long enough for SEVERAL probe-verdict polls to elapse, so
		// re-hammering would be unmistakable in `brokenCalls`.
		setTimeout(() => resetRateLimitProbeGatesForTests(), 3_500);

		const response = await callHandleProxy(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			}),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The broken sibling was attempted exactly once across the whole hold…
		expect(brokenCalls).toBe(1);
		// …and the suppressed account still served the request once its probe
		// finished (the F6 property is intact — the hold kept waiting).
		expect(response.status).toBe(200);
		expect(suppressedCalls).toBe(1);
	}, 30_000);
});
