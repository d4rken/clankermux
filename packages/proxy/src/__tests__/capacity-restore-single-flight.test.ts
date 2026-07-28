import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
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
import { setOverloadHoldBudgetOverrideForTests } from "../overload-hold";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
} from "../provider-overload-cooldown";

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
	options: {
		/** Accounts the SessionStrategy fallback may return (defaults to all). */
		strategyAccounts?: Account[];
		/** Active combo for the request family, or null. */
		combo?: {
			name: string;
			slots: Array<{ account_id: string; model: string; enabled: boolean }>;
		} | null;
	} = {},
): ProxyContext {
	const byId = new Map(accounts.map((a) => [a.id, a]));
	const strategyPool = options.strategyAccounts ?? accounts;
	const baseStrategy = makeStrategy(heldAccountId, decision) as {
		select: (accs: Account[], meta: RequestMeta) => Account[];
	};
	return {
		strategy: {
			// Restrict the pool the STRATEGY may return without touching what
			// getAllAccounts reports (combo routing resolves slots from the latter).
			select: (_accs: Account[], meta: RequestMeta) =>
				baseStrategy.select(strategyPool, meta),
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(async (id: string) => byId.get(id) ?? null),
			getActiveComboForFamily: mock(async () => options.combo ?? null),
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

/** Marker body text for an upstream 529, to tell a forwarded body from a synthetic one. */
const UPSTREAM_529_MESSAGE = "upstream-529-from-the-real-account";

/**
 * Fetch stub that routes by access token. The RESTORED account's first upstream
 * call parks until released, so the single-flight lease is still held while the
 * other concurrent requests run; the sibling always answers immediately.
 */
function makeGatedFetch(
	originalFetch: typeof globalThis.fetch,
	options: {
		/** Auth-token fragment whose upstream call throws (network failure). */
		failingToken?: string;
	} = {},
) {
	const state = {
		restoredCalls: 0,
		siblingCalls: 0,
		failingCalls: 0,
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
			if (options.failingToken && auth.includes(options.failingToken)) {
				state.failingCalls += 1;
				throw new TypeError("upstream unreachable");
			}
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

/**
 * A candidate suppressed by the single-flight gate was NEVER ATTEMPTED, so a
 * request whose every candidate is suppressed has learned nothing about any of
 * them. Both attempt loops used to `continue` past all of them and fall through
 * to ServiceUnavailableError — a hard 503 against a pool of healthy accounts,
 * not one of which was tried. No intermediate escape caught it: the burst
 * terminal needs `burstHoldDeclined`, the combo terminal needs a combo name, the
 * overload terminal needs an outcome that only an ATTEMPT can produce, and the
 * abort terminal needs a disconnected client.
 */
describe("probe-suppression recovery (handleProxy)", () => {
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

	it("serves the request instead of 503ing when the ONLY candidate is probe-suppressed", async () => {
		const restored = makeAccount({
			id: "restored",
			name: "Restored",
			access_token: "at-restored",
		});
		seedFreshHeadroom("restored");
		markCapacityRestoredProbePending("restored");

		const state = makeGatedFetch(originalFetch);
		// Single-account pool: there is no sibling to fail over to, so a suppressed
		// candidate leaves the loop with nothing at all.
		const ctx = makeContext([restored], "restored", "none");
		const url = new URL("https://proxy.local/v1/messages");

		const first = callHandleProxy(makeRequest(), url, ctx);
		while (state.restoredCalls === 0) await tick();

		// Second request: its only candidate is suppressed. It must hold for the
		// in-flight probe rather than fail.
		const second = callHandleProxy(makeRequest(), url, ctx);
		await tick(20);
		// Still bounded to the single admitted probe — the holder did not stampede.
		expect(state.restoredCalls).toBe(1);

		// The probe reaches its verdict; the holder re-selects and is served.
		state.release?.();
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
	});

	it("bounds fan-in to ONE upstream call while many requests hold behind the probe", async () => {
		const restored = makeAccount({
			id: "restored",
			name: "Restored",
			access_token: "at-restored",
		});
		seedFreshHeadroom("restored");
		markCapacityRestoredProbePending("restored");

		const state = makeGatedFetch(originalFetch);
		const ctx = makeContext([restored], "restored", "none");
		const url = new URL("https://proxy.local/v1/messages");

		const first = callHandleProxy(makeRequest(), url, ctx);
		while (state.restoredCalls === 0) await tick();

		const holders = [
			callHandleProxy(makeRequest(), url, ctx),
			callHandleProxy(makeRequest(), url, ctx),
			callHandleProxy(makeRequest(), url, ctx),
			callHandleProxy(makeRequest(), url, ctx),
			callHandleProxy(makeRequest(), url, ctx),
		];
		await tick(30);
		// The hold is the fan-in control: five concurrent requests against a
		// one-account pool produced no extra upstream traffic at all.
		expect(state.restoredCalls).toBe(1);

		state.release?.();
		expect((await first).status).toBe(200);
		for (const r of await Promise.all(holders)) expect(r.status).toBe(200);
	});

	it("recovers in the COMBO FALLBACK loop even though the main loop already attempted (per-loop flag)", async () => {
		// A request-wide "did anything get attempted" flag would be true here (the
		// combo slot WAS attempted and failed), suppressing recovery in the
		// fallback loop and reproducing the 503 this fix removes.
		const comboAcct = makeAccount({
			id: "combo",
			name: "Combo",
			access_token: "at-combo",
		});
		const restored = makeAccount({
			id: "restored",
			name: "Restored",
			access_token: "at-restored",
		});
		seedFreshHeadroom("restored");
		markCapacityRestoredProbePending("restored");

		const state = makeGatedFetch(originalFetch, { failingToken: "at-combo" });
		// getAllAccounts reports both (combo slots resolve from it); the strategy
		// fallback may only return the suppressed account.
		const ctx = makeContext([comboAcct, restored], "restored", "none", {
			strategyAccounts: [restored],
			combo: {
				name: "test-combo",
				slots: [
					{ account_id: "combo", model: "claude-sonnet-4-5", enabled: true },
				],
			},
		});
		const url = new URL("https://proxy.local/v1/messages");

		// Park the probe on the restored account with an unrelated request.
		const prober = callHandleProxy(
			makeRequest(),
			url,
			makeContext([restored], "restored", "none"),
		);
		while (state.restoredCalls === 0) await tick();

		const comboRequest = callHandleProxy(makeRequest(), url, ctx);
		await tick(30);
		// The combo slot was attempted and failed; the fallback candidate is
		// suppressed, so the request is now holding rather than 503ing.
		expect(state.failingCalls).toBeGreaterThan(0);

		state.release?.();
		expect((await prober).status).toBe(200);
		expect((await comboRequest).status).toBe(200);
	});

	it("falls back to an UNGATED retry when the probe hold times out", async () => {
		// Slow by construction: the hold bound is PROBE_HOLD_MAX_MS (10s) and the
		// only way to observe the timeout branch is to let it elapse.
		const restored = makeAccount({
			id: "restored",
			name: "Restored",
			access_token: "at-restored",
		});
		seedFreshHeadroom("restored");
		markCapacityRestoredProbePending("restored");

		const state = makeGatedFetch(originalFetch);
		const ctx = makeContext([restored], "restored", "none");
		const url = new URL("https://proxy.local/v1/messages");

		// This request parks upstream and never returns within the hold budget, so
		// its lease is still held when the holder's wait expires.
		callHandleProxy(makeRequest(), url, ctx).catch(() => {});
		while (state.restoredCalls === 0) await tick();

		const startedAt = Date.now();
		const holder = await callHandleProxy(makeRequest(), url, ctx);
		// Served by the ungated retry (a SECOND upstream call on the same account),
		// not a 503 against an untried pool.
		expect(holder.status).toBe(200);
		expect(state.restoredCalls).toBe(2);
		// It got there by TIMING OUT, not by being admitted straight away: the wait
		// is bounded by PROBE_HOLD_MAX_MS (10s), so a fast return would mean the
		// candidate was never suppressed and the test proved nothing.
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_000);

		state.release?.();
	}, 30_000);

	it("admits exactly ONE ungated bypass when MANY waiters time out on the same probe", async () => {
		// Fan-in control at the timeout boundary. Every waiter's budget expires at
		// roughly the same instant against a stuck probe; without the single-winner
		// permit each of them fires its own ungated request at the account the gate
		// is protecting — the 429 storm this whole mechanism exists to prevent.
		const restored = makeAccount({
			id: "restored",
			name: "Restored",
			access_token: "at-restored",
		});
		seedFreshHeadroom("restored");
		markCapacityRestoredProbePending("restored");

		// EVERY upstream call parks here, so the probe lease stays held for the
		// whole test: no completion can release it and hand a later waiter a fresh,
		// legitimately-admitted probe, which would blur what is being counted.
		let calls = 0;
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				calls += 1;
				await gate;
				return ok200();
			},
		);

		const ctx = makeContext([restored], "restored", "none");
		const url = new URL("https://proxy.local/v1/messages");

		const prober = callHandleProxy(makeRequest(), url, ctx);
		while (calls === 0) await tick();

		const startedAt = Date.now();
		const holders = [
			callHandleProxy(makeRequest(), url, ctx),
			callHandleProxy(makeRequest(), url, ctx),
			callHandleProxy(makeRequest(), url, ctx),
		];
		// The losers reject at the budget boundary, well before the winner settles.
		for (const h of holders) h.catch(() => {});
		while (calls < 2 && Date.now() - startedAt < 20_000) await tick(50);
		// Give any further (wrongly-granted) bypass a chance to fire.
		await tick(300);

		// The parked probe plus exactly ONE backup attempt — not one per waiter.
		expect(calls).toBe(2);
		// The losers did not retry immediately: they waited out the shared budget
		// (a fresh budget per round would let them re-run without ever waiting) and
		// only then fell through to the normal terminal.
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_000);

		release?.();
		const settled = await Promise.allSettled(holders);
		expect(
			settled.filter((r) => r.status === "fulfilled" && r.value.status === 200),
		).toHaveLength(1);
		expect(settled.filter((r) => r.status === "rejected")).toHaveLength(2);
		expect((await prober).status).toBe(200);
	}, 30_000);

	it("does NOT attempt the stale pre-hold target when the fresh selection is empty", async () => {
		// The probe reaches a verdict, but by then the account is gone from routing
		// (paused here; a re-cooled, usage-throttled or family-gated account is the
		// same shape). Attempting the pre-hold target anyway would bypass the fresh
		// routing decision entirely.
		const restored = makeAccount({
			id: "restored",
			name: "Restored",
			access_token: "at-restored",
		});
		seedFreshHeadroom("restored");
		markCapacityRestoredProbePending("restored");

		const state = makeGatedFetch(originalFetch);
		const ctx = makeContext([restored], "restored", "none");
		const url = new URL("https://proxy.local/v1/messages");

		const first = callHandleProxy(makeRequest(), url, ctx);
		while (state.restoredCalls === 0) await tick();

		const holder = callHandleProxy(makeRequest(), url, ctx);
		await tick(20);
		// The account leaves the pool, THEN the probe reports its verdict.
		restored.paused = true;
		state.release?.();

		await expect(holder).rejects.toThrow();
		expect((await first).status).toBe(200);
		// No second upstream call: the stale target was never attempted.
		expect(state.restoredCalls).toBe(1);
	}, 15_000);

	it("reports the FRESH gate's 529 when the in-flight probe's own verdict opens the breaker", async () => {
		// The other half of "the fresh selection is empty": it is empty BECAUSE the
		// probe answered 529, which releases the lease AND trips the provider
		// overload breaker in one step. The pre-hold overload array was captured
		// before that (the account was selectable then — that is why this request
		// was waiting on it), so returning a bare null degrades a genuine
		// provider-overloaded 529 into the generic ALL_ACCOUNTS_FAILED 503.
		const restored = makeAccount({
			id: "restored",
			name: "Restored",
			access_token: "at-restored",
		});
		seedFreshHeadroom("restored");
		markCapacityRestoredProbePending("restored");

		let calls = 0;
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				calls += 1;
				await gate;
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "overloaded_error", message: "Overloaded" },
					}),
					{ status: 529, headers: { "content-type": "application/json" } },
				);
			},
		);

		const ctx = makeContext([restored], "restored", "none");
		const url = new URL("https://proxy.local/v1/messages");

		const prober = callHandleProxy(makeRequest(), url, ctx);
		prober.catch(() => {});
		while (calls === 0) await tick();

		// The waiter's only candidate is suppressed, so it is holding for the probe.
		const holder = callHandleProxy(makeRequest(), url, ctx);
		await tick(20);
		release?.();

		const response = await holder;
		expect(response.status).toBe(529);
		const body = (await response.json()) as { error?: { type?: string } };
		expect(body.error?.type).toBe("overloaded_error");
		// The waiter never made an upstream call of its own — the terminal comes
		// from the fresh gate's evidence, not from an attempt.
		expect(calls).toBe(1);
		await prober.catch(() => {});
	}, 15_000);

	it("stops treating a re-selection as combo-routed once the combo loses its slots", async () => {
		// An initially active combo whose remaining slots become unavailable during
		// the hold falls back to plain SessionStrategy accounts — but
		// `selectByStrategy` does not clear `requestMeta.comboName`, so recovery
		// keyed on the name alone kept treating those normal accounts as
		// combo-routed. The visible consequence: `!comboInfo?.comboName` stays false
		// for the (now slot-less) combo, so the normal account's attempt is never
		// the terminal one and its genuine upstream 529 is discarded — the client
		// gets a locally synthesized overload terminal instead of the real body.
		const comboAcct = makeAccount({
			id: "combo",
			name: "Combo",
			access_token: "at-combo",
		});
		const normal = makeAccount({
			id: "normal",
			name: "Normal",
			access_token: "at-normal",
		});
		markCapacityRestoredProbePending("combo");

		const state = { comboCalls: 0, normalCalls: 0 };
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const headers =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				const auth = headers.get("authorization") ?? "";
				if (auth.includes("at-combo")) {
					state.comboCalls += 1;
					await gate;
					return ok200();
				}
				state.normalCalls += 1;
				// A distinctive message: it is what tells a FORWARDED upstream body
				// apart from a locally synthesized overload terminal, which is what
				// the client gets when the attempt is not treated as terminal.
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "overloaded_error", message: UPSTREAM_529_MESSAGE },
					}),
					{ status: 529, headers: { "content-type": "application/json" } },
				);
			},
		);

		const url = new URL("https://proxy.local/v1/messages");
		// Park the probe on the combo account with an unrelated request.
		const prober = callHandleProxy(
			makeRequest(),
			url,
			makeContext([comboAcct], "combo", "none"),
		);
		while (state.comboCalls === 0) await tick();

		// The combo request: its single slot is probe-suppressed, so it holds.
		const ctx = makeContext([comboAcct, normal], "normal", "none", {
			strategyAccounts: [normal],
			combo: {
				name: "test-combo",
				slots: [
					{ account_id: "combo", model: "claude-sonnet-4-5", enabled: true },
				],
			},
		});
		const holder = callHandleProxy(makeRequest(), url, ctx);
		await tick(20);
		// The combo slot leaves the pool, THEN the probe reports its verdict: the
		// re-selection falls back to normal SessionStrategy routing.
		comboAcct.paused = true;
		release?.();

		// Discarding the 529 lands the request in the combo-fallback tail's overload
		// terminal, which HOLDS first; cap that budget so the assertions below fail
		// fast rather than at the test timeout.
		setOverloadHoldBudgetOverrideForTests(50);
		try {
			const response = await holder;
			expect(response.status).toBe(529);
			const body = (await response.json()) as {
				error?: { type?: string; message?: string };
			};
			expect(body.error?.type).toBe("overloaded_error");
			// The normal account is the terminal attempt of a NON-combo re-selection,
			// so the client gets its REAL upstream body — not a locally synthesized
			// "provider temporarily overloaded" stand-in.
			expect(body.error?.message).toBe(UPSTREAM_529_MESSAGE);
			expect(state.normalCalls).toBe(1);
		} finally {
			setOverloadHoldBudgetOverrideForTests(null);
		}
		expect((await prober).status).toBe(200);
	}, 20_000);

	it("discards the staged cache body when the client disconnects during the hold", async () => {
		// The early 499 return emits no worker end/summary, so without an explicit
		// discard a staged body (0.5–1.5 MB) survives to the age sweep and evicts
		// live staging entries.
		const restored = makeAccount({
			id: "restored",
			name: "Restored",
			access_token: "at-restored",
		});
		seedFreshHeadroom("restored");
		markCapacityRestoredProbePending("restored");

		const state = makeGatedFetch(originalFetch);
		const ctx = makeContext([restored], "restored", "none");
		const url = new URL("https://proxy.local/v1/messages");

		const first = callHandleProxy(makeRequest(), url, ctx);
		while (state.restoredCalls === 0) await tick();

		const discard = spyOn(cacheBodyStore, "discardStaged");
		try {
			const controller = new AbortController();
			const req = new Request(makeRequest(), { signal: controller.signal });
			const holder = callHandleProxy(req, url, ctx);
			await tick(20);
			controller.abort();

			const response = await holder;
			expect(response.status).toBe(499);
			// Nothing else in this request reached a terminal (its only candidate was
			// suppressed, so no attempt ever staged or discarded), which makes this
			// call unambiguously the hold's abort branch.
			expect(discard.mock.calls.length).toBeGreaterThanOrEqual(1);
		} finally {
			discard.mockRestore();
		}

		state.release?.();
		expect((await first).status).toBe(200);
	}, 15_000);

	it("keeps the onOutcome sink wired on the ungated retry (a late overload rejection is not a generic 503)", async () => {
		// Without `onOutcome: noteOverloadSuppression`, an authoritative
		// provider-overload refusal inside the ungated retry would return null and
		// fall straight back into the generic ALL_ACCOUNTS_FAILED 503 this recovery
		// exists to eliminate. With the sink, the terminal is the 529 instead.
		const restored = makeAccount({
			id: "restored",
			name: "Restored",
			access_token: "at-restored",
		});
		seedFreshHeadroom("restored");
		markCapacityRestoredProbePending("restored");

		const state = makeGatedFetch(originalFetch);
		const ctx = makeContext([restored], "restored", "none");
		const url = new URL("https://proxy.local/v1/messages");

		callHandleProxy(makeRequest(), url, ctx).catch(() => {});
		while (state.restoredCalls === 0) await tick();

		const holder = callHandleProxy(makeRequest(), url, ctx);
		// Trip the provider-overload breaker DURING the hold, after the holder's
		// selection has already run: the ungated retry then hits the authoritative
		// admission chokepoint and is refused without an upstream call. The 5-minute
		// deadline is deliberately beyond the overload hold budget so the terminal
		// is the immediate synthetic 529 rather than another hold.
		setTimeout(() => {
			applyProviderOverloadCooldown("anthropic", Date.now() + 5 * 60_000);
		}, 200);

		const response = await holder;
		expect(response.status).toBe(529);
		expect(state.restoredCalls).toBe(1);

		state.release?.();
	}, 30_000);
});
