import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import {
	clearAnthropicBurstThrottle,
	markAnthropicBurstThrottle,
	resetHoldSlots,
} from "../handlers/burst-cooldown";
import {
	clearCapacityRestoredProbePending,
	markCapacityRestoredProbePending,
	resetRateLimitProbeGatesForTests,
} from "../handlers/rate-limit-cooldown";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";

/**
 * After the usage poller releases an account EARLY, the capacity-restored marker
 * must limit the next wave to ONE upstream probe — on every dispatch path, not
 * just the two candidate loops. The affinity-first attempt and the burst-hold
 * re-probe used to call `proxyWithAccount` directly, so concurrent requests all
 * reached the freshly-recovered account (and, holding no lease, could not clear
 * the marker on success either). Both now go through the same probe gate.
 */

const HOLD_TIMING_OVERRIDE = {
	// Forward-dated clock so the held account's cooldown always reads as elapsed
	// and each re-probe fires immediately (no wall-clock sleep).
	now: () => Date.now() + 10 * 60 * 1000,
	jitterMs: 0,
	maxHoldMs: 2_000,
};

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(
		req,
		url,
		ctx,
		undefined,
		undefined,
		false,
		HOLD_TIMING_OVERRIDE,
	);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
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
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

/** Strategy stub with a fixed decision + held (affinity) account id. */
function makeStrategy(heldAccountId: string, decision: string) {
	return {
		select: (accs: Account[], meta: RequestMeta) => {
			const now = Date.now();
			const available = accs.filter(
				(acc) =>
					!acc.paused &&
					(!acc.rate_limited_until || acc.rate_limited_until <= now),
			);
			meta.routing = {
				strategy: "session",
				decision,
				affinityScope: "project",
				affinityKey: "k",
				selectedAccountId: available[0]?.id ?? null,
				previousAccountId: null,
				candidatesCount: available.length,
				failoverReason: null,
				heldAccountId,
			};
			return available;
		},
	} as never;
}

function makeContext(
	accounts: Account[],
	heldAccountId: string,
	decision: string,
): ProxyContext {
	const byId = new Map(accounts.map((a) => [a.id, a]));
	return {
		strategy: makeStrategy(heldAccountId, decision),
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(async (id: string) => byId.get(id) ?? null),
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
			max_tokens: 10,
		}),
	});
}

function isProxyCall(input: RequestInfo | URL): boolean {
	const url = input instanceof Request ? input.url : String(input);
	return url.includes("api.anthropic.com") || url.includes("/v1/messages");
}

function ok200() {
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
}

/** Fresh, positive 5h headroom so the burst hold treats the account as holdable. */
function seedFreshHeadroom(accountId: string) {
	usageCache.set(accountId, {
		five_hour: {
			utilization: 40,
			resets_at: new Date(Date.now() + 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: 20,
			resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		},
	} as never);
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch stub that routes by access token. The RESTORED account's first upstream
 * call parks until released, so the single-flight lease is still held while the
 * other concurrent requests run; the sibling always answers immediately.
 */
function makeGatedFetch(originalFetch: typeof globalThis.fetch) {
	const state = {
		restoredCalls: 0,
		siblingCalls: 0,
		release: null as (() => void) | null,
	};
	const gate = new Promise<void>((resolve) => {
		state.release = resolve;
	});
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			if (!isProxyCall(input)) return originalFetch(input as never, init);
			const headers =
				input instanceof Request ? input.headers : new Headers(init?.headers);
			const auth = headers.get("authorization") ?? "";
			if (auth.includes("at-restored")) {
				state.restoredCalls += 1;
				// Only the FIRST call parks (holding the lease); any further call is
				// a stampede and returns immediately, so the assertions below fail
				// with a count rather than hanging.
				if (state.restoredCalls === 1) await gate;
				return ok200();
			}
			state.siblingCalls += 1;
			return ok200();
		},
	);
	return state;
}

describe("capacity-restored single-flight (handleProxy)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		resetHoldSlots();
		resetRateLimitProbeGatesForTests();
		usageCache.delete("restored");
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		resetHoldSlots();
		resetRateLimitProbeGatesForTests();
		clearCapacityRestoredProbePending("restored");
		usageCache.delete("restored");
	});

	it("concurrent AFFINITY-HIT requests after a capacity restore produce exactly ONE upstream attempt", async () => {
		// Post-early-release shape: available again, streak 0, no deadline — the
		// mature-streak gate would say "not_required", so only the capacity marker
		// keeps this to one probe.
		const restored = makeAccount({
			id: "restored",
			name: "Restored",
			access_token: "at-restored",
		});
		const sibling = makeAccount({
			id: "sibling",
			name: "Sibling",
			access_token: "at-sibling",
		});
		seedFreshHeadroom("restored");
		markCapacityRestoredProbePending("restored");

		const state = makeGatedFetch(originalFetch);
		const ctx = makeContext([restored, sibling], "restored", "affinity_hit");
		const url = new URL("https://proxy.local/v1/messages");

		// Request A takes the single probe and parks upstream.
		const first = callHandleProxy(makeRequest(), url, ctx);
		while (state.restoredCalls === 0) await tick();

		// Two more concurrent affinity requests arrive while A holds the lease.
		const others = await Promise.all([
			callHandleProxy(makeRequest(), url, ctx),
			callHandleProxy(makeRequest(), url, ctx),
		]);

		// They were suppressed on the restored account and failed over to the
		// sibling instead of stampeding it.
		expect(state.restoredCalls).toBe(1);
		expect(state.siblingCalls).toBe(2);
		for (const r of others) expect(r.status).toBe(200);

		state.release?.();
		expect((await first).status).toBe(200);
		expect(state.restoredCalls).toBe(1);
	});

	it("concurrent HELD (burst-hold) requests after a capacity restore produce exactly ONE upstream attempt", async () => {
		// The hold's re-probe is a real upstream request; it used to bypass the gate
		// entirely, so every concurrently-held request re-probed the same account.
		const restored = makeAccount({
			id: "restored",
			name: "Restored",
			access_token: "at-restored",
			// Cooled → affinity_hold (excluded from the available list); expired so
			// the hold's re-probe fires immediately.
			rate_limited_until: Date.now() - 1,
		});
		const sibling = makeAccount({
			id: "sibling",
			name: "Sibling",
			access_token: "at-sibling",
		});
		seedFreshHeadroom("restored");
		// A concurrent request already tripped the shared burst marker, so the hold
		// is entered directly (no first attempt).
		markAnthropicBurstThrottle();
		markCapacityRestoredProbePending("restored");

		const state = makeGatedFetch(originalFetch);
		const ctx = makeContext([restored, sibling], "restored", "affinity_hold");
		const url = new URL("https://proxy.local/v1/messages");

		const first = callHandleProxy(makeRequest(), url, ctx);
		while (state.restoredCalls === 0) await tick();

		const others = await Promise.all([
			callHandleProxy(makeRequest(), url, ctx),
			callHandleProxy(makeRequest(), url, ctx),
		]);

		// Their re-probes were suppressed (reported as "still throttled"), the holds
		// gave up within budget and the sibling served them.
		expect(state.restoredCalls).toBe(1);
		for (const r of others) expect(r.status).toBe(200);

		state.release?.();
		expect((await first).status).toBe(200);
		expect(state.restoredCalls).toBe(1);
	});
});
