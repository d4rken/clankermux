/**
 * The terminal-attempt flag (`returnRateLimitedResponseOnExhaustion`) decides
 * whether a real upstream 529 body is FORWARDED to the client or discarded in
 * favour of a generic 503. It was derived from list position plus the
 * same-provider "no cross-provider fallback" test, so it missed a candidate that
 * only LOOKS like a fallback: one the single-flight recovery-probe gate would
 * refuse before any upstream call.
 *
 * Scope of the gap: a MIXED-provider pool — e.g. [anthropic, codex] with the
 * codex account probe-suppressed. The same-provider term does not fire (the
 * remaining candidate is a different provider), so Anthropic's genuine
 * `overloaded_error` was thrown away and the client got ALL_ACCOUNTS_FAILED.
 *
 * Both arms are tested: a suppressed remainder forwards the 529, an attemptable
 * remainder still fails over. This is also the code path that owns
 * `discardUpstreamBody` for the 529 response, so getting it wrong either leaks a
 * body or drops a real one.
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
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import {
	clearCapacityRestoredProbePending,
	completeRateLimitProbe,
	getRateLimitProbeAdmission,
	markCapacityRestoredProbePending,
	resetRateLimitProbeGatesForTests,
} from "../handlers/rate-limit-cooldown";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";

const CODEX_ID = "codex-tail";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc",
		name: "account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt-token",
		access_token: "at-token",
		expires_at: Date.now() + 3_600_000,
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
			// Preserve list order: the anthropic account is the primary, the codex
			// account is the tail candidate whose attemptability is under test.
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
			name: "anthropic",
			canHandle: () => true,
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
	} as ProxyContext;
}

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

const OVERLOADED_BODY = JSON.stringify({
	type: "error",
	error: { type: "overloaded_error", message: "Overloaded" },
});

/** Take the codex account's probe lease, as a concurrent mid-probe request would. */
function holdCodexProbeLease(): void {
	markCapacityRestoredProbePending(CODEX_ID);
	const admission = getRateLimitProbeAdmission({
		id: CODEX_ID,
		name: "lease-holder",
		consecutive_rate_limits: 0,
		rate_limited_until: null,
	} as unknown as Account);
	if (admission !== "admitted") {
		throw new Error(`expected to take the probe lease, got ${admission}`);
	}
}

function installFetch() {
	const state = { anthropicCalls: 0, codexCalls: 0 };
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.includes("api.anthropic.com")) {
				state.anthropicCalls += 1;
				return new Response(OVERLOADED_BODY, {
					status: 529,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("chatgpt.com")) {
				state.codexCalls += 1;
				return new Response('{"error":{"message":"nope"}}', {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			// Unrelated background fetches (pricing catalogue, …).
			void init;
			return new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	) as never;
	return state;
}

async function callHandleProxy(ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(
		makeRequest(),
		new URL("https://proxy.local/v1/messages"),
		ctx,
	);
}

describe("terminal-attempt flag vs a probe-suppressed remainder", () => {
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
		clearCapacityRestoredProbePending(CODEX_ID);
	});

	it("forwards Anthropic's real 529 when the only remaining candidate is probe-suppressed", async () => {
		const anthropic = makeAccount({
			id: "anthropic-primary",
			name: "Anthropic",
			provider: "anthropic",
			api_key: "sk-ant-test",
			refresh_token: "",
			access_token: null,
		});
		const codex = makeAccount({
			id: CODEX_ID,
			name: "Codex",
			provider: "codex",
			api_key: null,
			refresh_token: "rt-codex",
			access_token: "at-codex",
		});
		holdCodexProbeLease();
		const state = installFetch();

		const response = await callHandleProxy(makeContext([anthropic, codex]));

		expect(state.anthropicCalls).toBe(1);
		// The suppressed tail is not a fallback — it was never going to be tried.
		expect(state.codexCalls).toBe(0);
		expect(response.status).toBe(529);
		const body = (await response.json()) as { error?: { type?: string } };
		expect(body.error?.type).toBe("overloaded_error");
	});

	it("re-evaluates the flag WHEN THE 529 ARRIVES, so a tail released mid-flight is still tried", async () => {
		// The flag used to be snapshotted before the fetch. A tail holding a
		// recovery-probe lease at request-preparation time, whose probe completes
		// and releases the lease while the head is still in flight, was therefore
		// never tried: the head's 529 went straight to the client instead of
		// failing over to a now-attemptable account.
		const anthropic = makeAccount({
			id: "anthropic-primary",
			name: "Anthropic",
			provider: "anthropic",
			api_key: "sk-ant-test",
			refresh_token: "",
			access_token: null,
		});
		const codex = makeAccount({
			id: CODEX_ID,
			name: "Codex",
			provider: "codex",
			api_key: null,
			refresh_token: "rt-codex",
			access_token: "at-codex",
		});
		holdCodexProbeLease();

		const state = { anthropicCalls: 0, codexCalls: 0 };
		let releaseHead: (() => void) | null = null;
		const headInFlight = new Promise<void>((resolve) => {
			releaseHead = resolve;
		});
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.includes("api.anthropic.com")) {
				state.anthropicCalls += 1;
				// Hold the head open so the tail's lease can be released underneath it.
				await headInFlight;
				return new Response(OVERLOADED_BODY, {
					status: 529,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("chatgpt.com")) {
				state.codexCalls += 1;
				return new Response('{"error":{"message":"nope"}}', {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as never;

		const pending = callHandleProxy(makeContext([anthropic, codex]));
		while (state.anthropicCalls === 0) {
			await new Promise((r) => setTimeout(r, 5));
		}
		// The tail's own probe reaches a verdict and releases the lease (the marker
		// is deliberately retained), making it attemptable again.
		completeRateLimitProbe(codex, "abandoned");
		releaseHead?.();

		const response = await pending;
		expect(state.anthropicCalls).toBe(1);
		expect(state.codexCalls).toBe(1);
		expect(response.status).not.toBe(529);
	}, 15_000);

	it("still fails over to an ATTEMPTABLE cross-provider tail instead of forwarding the 529", async () => {
		const anthropic = makeAccount({
			id: "anthropic-primary",
			name: "Anthropic",
			provider: "anthropic",
			api_key: "sk-ant-test",
			refresh_token: "",
			access_token: null,
		});
		const codex = makeAccount({
			id: CODEX_ID,
			name: "Codex",
			provider: "codex",
			api_key: null,
			refresh_token: "rt-codex",
			access_token: "at-codex",
		});
		// No probe lease held: the codex account is a genuine fallback.
		const state = installFetch();

		const response = await callHandleProxy(makeContext([anthropic, codex]));

		expect(state.anthropicCalls).toBe(1);
		expect(state.codexCalls).toBe(1);
		// Failover happened, so the Anthropic 529 was NOT the client's answer.
		expect(response.status).not.toBe(529);
	});
});
