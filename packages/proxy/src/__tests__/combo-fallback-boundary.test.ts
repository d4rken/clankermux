/**
 * Boundary tests for handleProxy's COMBO FALLBACK tail (§10) — the block that
 * runs after every slot of an active combo has failed: it clears the combo,
 * re-selects with plain SessionStrategy routing, re-applies the admission gates
 * (provider-overload → usage-throttle → family-weekly → context-window) and
 * either serves from the fallback pool or emits one of the tail terminals.
 *
 * The whole block had no coverage anywhere. These tests pin the three things a
 * refactor of the gate closures could silently break: that the fallback
 * re-selection actually runs a SECOND gate pass, that its terminals still
 * discard the staged keepalive body, and that the gates the second pass applies
 * really do keep an unfit candidate off the network.
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
import type { Account } from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import { setForcedAccount } from "../handlers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { sessionPromotionTracker } from "../session-promotion";

const SLOT_A = "slot-a";
const SLOT_B = "slot-b";
const FALLBACK = "fallback-1";
const CODEX_SMALL = "codex-small";
const ALL_IDS = [SLOT_A, SLOT_B, FALLBACK, CODEX_SMALL];

/** Distinct upstream host for the Codex candidate — makes "never fetched" provable. */
const CODEX_ENDPOINT = "https://codex-fallback.test.local/v1/responses";

const MODEL = "claude-sonnet-4-5";

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: SLOT_A,
		name: "slot-a",
		provider: "anthropic",
		api_key: "key-slot-a",
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

const slotA = () => makeAccount();
const slotB = () =>
	makeAccount({ id: SLOT_B, name: "slot-b", api_key: "key-slot-b" });
const fallbackAccount = () =>
	makeAccount({ id: FALLBACK, name: "fallback-1", api_key: "key-fallback-1" });
const codexSmallAccount = () =>
	makeAccount({
		id: CODEX_SMALL,
		name: "codex-small",
		provider: "codex",
		api_key: null,
		refresh_token: "codex-refresh",
		access_token: "codex-access",
		expires_at: Date.now() + 3_600_000,
		custom_endpoint: CODEX_ENDPOINT,
		model_mappings: JSON.stringify({ sonnet: "gpt-5.3-codex-spark" }),
	});

type ConfigOverrides = {
	usageThrottlingFiveHour?: boolean;
	usageThrottlingWeekly?: boolean;
};

function makeContext(
	accounts: Account[],
	config: ConfigOverrides = {},
): ProxyContext {
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
			getActiveComboForFamily: mock(async () => ({
				name: "combo-under-test",
				slots: [
					{ account_id: SLOT_A, model: MODEL, enabled: true },
					{ account_id: SLOT_B, model: MODEL, enabled: true },
				],
			})),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
			updateAccountRateLimitMeta: mock(async () => {}),
			resetConsecutiveRateLimits: mock(async () => {}),
			updateRequestUsage: mock(async () => {}),
			getAdapter: mock(() => ({
				run: mock(async () => {}),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () =>
				config.usageThrottlingFiveHour === true,
			getUsageThrottlingWeeklyEnabled: () =>
				config.usageThrottlingWeekly === true,
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
	};
}

type FetchLog = {
	/** EVERY url the process fetched during the test (pricing refreshes included). */
	all: string[];
	/** Upstream Anthropic attempts only, in order, keyed by the account's api key. */
	upstream: string[];
};

/**
 * Records every fetch, answers Anthropic upstream calls via `handler`, and
 * shunts unrelated background fetches (the models.dev pricing-catalog refresh
 * fired by the usage finalizer) with a 500 so they can never reach the handler
 * or a real network — the `upstreamOnlyFetch` pattern from overload-hold.test.ts,
 * extended to also expose the raw url list so "the Codex candidate was never
 * fetched" is checkable.
 */
function recordingFetch(
	log: FetchLog,
	handler: (apiKey: string | null) => Response | Promise<Response>,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		log.all.push(url);
		if (!url.includes("api.anthropic.com")) {
			return new Response("unavailable", { status: 500 });
		}
		const apiKey =
			input instanceof Request ? input.headers.get("x-api-key") : null;
		log.upstream.push(apiKey ?? "<none>");
		return handler(apiKey);
	}) as never;
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

function rateLimited429() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "slot exhausted" },
		}),
		{ status: 429, headers: { "content-type": "application/json" } },
	);
}

/** A cacheable body (carries a cache_control hint, so cacheBodyStore stages it). */
function cacheableRequest(padChars = 0): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			system: [
				{
					type: "text",
					text: `system${"x".repeat(padChars)}`,
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

describe("handleProxy combo fallback", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		await import("../proxy");
	});

	const reset = () => {
		setForcedAccount(null);
		cacheBodyStore.setEnabled(false);
		sessionPromotionTracker.setMode("off");
		sessionPromotionTracker.clear();
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
		for (const id of ALL_IDS) usageCache.delete(id);
	};

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		reset();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		reset();
	});

	it("falls back to SessionStrategy routing when every combo slot fails", async () => {
		const accounts = [slotA(), slotB(), fallbackAccount()];
		const log: FetchLog = { all: [], upstream: [] };
		globalThis.fetch = recordingFetch(log, (apiKey) =>
			apiKey === "key-fallback-1" ? ok200() : rateLimited429(),
		);

		const res = await callHandleProxy(
			cacheableRequest(),
			new URL("https://proxy.local/v1/messages"),
			makeContext(accounts),
		);

		expect(res.status).toBe(200);
		// Slot accounts first (combo order), then the re-selected fallback account.
		expect(log.upstream).toEqual([
			"key-slot-a",
			"key-slot-b",
			"key-fallback-1",
		]);
	}, 15_000);

	it("returns the 529 usage-throttled terminal and discards the staged body when every fallback candidate is throttled", async () => {
		const accounts = [slotA(), slotB(), fallbackAccount()];
		// Throttle the fallback account only: 99% of a 5h window that is 3h old
		// (≈60% expected) resumes ~2h out, so the usage-throttle gate excludes it.
		const now = Date.now();
		usageCache.set(FALLBACK, {
			five_hour: {
				utilization: 99,
				resets_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
			},
			seven_day: { utilization: 10, resets_at: null },
		} as never);

		cacheBodyStore.setEnabled(true);
		const stagedDuringFlight: number[] = [];
		const log: FetchLog = { all: [], upstream: [] };
		globalThis.fetch = recordingFetch(log, () => {
			// Observed from inside the FIRST upstream attempt, while the request is
			// still in flight — this is what makes the post-terminal `=== 0` below a
			// real discard rather than a vacuous "nothing was ever staged".
			stagedDuringFlight.push(cacheBodyStore.getStagingSize());
			return rateLimited429();
		});

		const res = await callHandleProxy(
			cacheableRequest(),
			new URL("https://proxy.local/v1/messages"),
			makeContext(accounts, { usageThrottlingFiveHour: true }),
		);

		expect(res.status).toBe(529);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe("overloaded_error");
		expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
		// Both combo slots were attempted; the throttled fallback never was.
		expect(log.upstream).toEqual(["key-slot-a", "key-slot-b"]);
		// Staged while in flight …
		expect(stagedDuringFlight[0]).toBe(1);
		// … and dropped by the terminal.
		expect(cacheBodyStore.getStagingSize()).toBe(0);
	}, 15_000);

	it("returns the 529 usage-throttled terminal when family-weekly pacing empties the fallback pool", async () => {
		// The family-weekly gate runs AFTER the usage-throttle gate on this chain,
		// so an account it paces never lands in `throttledFallbackAccounts`. Before
		// the paced list was consulted here the pool fell through to the generic
		// "All accounts failed" terminal, which tells the client the wrong thing:
		// nothing failed, one account is simply ahead of its weekly pace.
		const accounts = [slotA(), slotB(), fallbackAccount()];
		const now = Date.now();
		const weeklyReset = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();
		usageCache.set(FALLBACK, {
			// Both ACCOUNT-WIDE windows are comfortably behind pace, so only the
			// per-family weekly window can be what holds this account back.
			five_hour: {
				utilization: 10,
				resets_at: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
			},
			seven_day: { utilization: 10, resets_at: weeklyReset },
			limits: [
				{
					kind: "weekly_scoped",
					group: "weekly",
					// 80% two days into a 7-day window: an even burn is at ~28.6%.
					percent: 80,
					resets_at: weeklyReset,
					scope: { model: { id: "sonnet", display_name: "Sonnet" } },
					is_active: true,
				},
			],
		} as never);

		const log: FetchLog = { all: [], upstream: [] };
		globalThis.fetch = recordingFetch(log, () => rateLimited429());

		const res = await callHandleProxy(
			cacheableRequest(),
			new URL("https://proxy.local/v1/messages"),
			makeContext(accounts, { usageThrottlingWeekly: true }),
		);

		expect(res.status).toBe(529);
		const body = (await res.json()) as {
			error: { type: string; message: string };
		};
		expect(body.error.type).toBe("overloaded_error");
		expect(body.error.message).toContain("fallback-1");
		// Both combo slots were attempted; the paced fallback never was.
		expect(log.upstream).toEqual(["key-slot-a", "key-slot-b"]);
	}, 15_000);

	it("never fetches a fallback candidate that the second-pass context-window gate excludes", async () => {
		const accounts = [slotA(), slotB(), codexSmallAccount(), fallbackAccount()];
		const log: FetchLog = { all: [], upstream: [] };
		globalThis.fetch = recordingFetch(log, (apiKey) =>
			apiKey === "key-fallback-1" ? ok200() : rateLimited429(),
		);

		// ~150K estimated tokens: above gpt-5.3-codex-spark's 128K window
		// threshold (124160), below every Anthropic window.
		const targetEstimate = 150_000;
		const overhead = JSON.stringify({
			model: MODEL,
			system: [
				{ type: "text", text: "system", cache_control: { type: "ephemeral" } },
			],
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}).length;
		const padChars = Math.ceil((targetEstimate - 16) * 3.0) - overhead + 10;

		const res = await callHandleProxy(
			cacheableRequest(padChars),
			new URL("https://proxy.local/v1/messages"),
			makeContext(accounts),
		);

		expect(res.status).toBe(200);
		expect(log.upstream).toEqual([
			"key-slot-a",
			"key-slot-b",
			"key-fallback-1",
		]);
		// The gate kept the Codex account off the network entirely.
		expect(log.all.some((u) => u.includes("codex-fallback.test.local"))).toBe(
			false,
		);
	}, 20_000);
});
