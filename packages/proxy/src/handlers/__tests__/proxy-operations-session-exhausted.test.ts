import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
} from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import {
	proxyWithAccount,
	routingAttempts,
} from "../../__tests__/fixtures/routing-harness";
import {
	getFamilyWeeklyExhaustedUntil,
	resetFamilyWeeklyMemoForTests,
} from "../../family-weekly-memo";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import {
	clearAnthropicBurstThrottle,
	isAnthropicBurstThrottleActive,
} from "../burst-cooldown";
import type { ProxyContext } from "../proxy-types";
import {
	getRateLimitProbeAdmission,
	resetRateLimitProbeGatesForTests,
} from "../rate-limit-cooldown";
import { processProxyResponse } from "../response-processor";
import {
	QUOTA_INCIDENT_NOW as NOW,
	quotaIncidentResponse,
	QUOTA_INCIDENT_SESSION_RESET as SESSION_RESET,
	QUOTA_INCIDENT_WEEKLY_RESET as WEEKLY_RESET,
} from "./anthropic-quota-incident.fixture";

/**
 * The account-wide exhaustion rung now covers EVERY window that sidelines the
 * whole account, not just weekly. A 429 while the 5-hour session window is spent
 * (fresh usage evidence) records `session_exhausted_429` — a sibling of
 * `weekly_exhausted_429`, quota-derived by construction — and fails over
 * immediately instead of being held/re-probed by the burst-retry machinery.
 * Weekly outranks session, so a weekly-spent account still reports weekly.
 */

const ACCOUNT_ID = "acc-session";
/** Retry-after on every stubbed 429, in seconds. */
const RETRY_AFTER_S = 600;

function makeOAuthAnthropicAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "oauth-session",
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
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		notes: null,
		refresh_token_issued_at: null,
		renewal_anchor: null,
		renewal_cadence: null,
		renewal_price_usd_micros: null,
		renewal_auto_start_date: null,
		...overrides,
	} as Account;
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-session-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	} as RequestMeta;
}

function makeRequestBody(model: string) {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

/** 5h spent, weekly with headroom → the session window binds. */
function seedSessionExhausted() {
	usageCache.set(ACCOUNT_ID, {
		five_hour: {
			utilization: 100,
			resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: 42,
			resets_at: new Date(Date.now() + 23 * 3_600_000).toISOString(),
		},
	} as never);
}

/** Both spent → weekly outranks session. */
function seedBothExhausted() {
	usageCache.set(ACCOUNT_ID, {
		five_hour: {
			utilization: 100,
			resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: 100,
			resets_at: new Date(Date.now() + 23 * 3_600_000).toISOString(),
		},
	} as never);
}

/** Only a model FAMILY is spent; account-wide windows keep headroom. */
function seedFamilyOnlyExhausted() {
	usageCache.set(ACCOUNT_ID, {
		five_hour: {
			utilization: 20,
			resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: 30,
			resets_at: new Date(Date.now() + 23 * 3_600_000).toISOString(),
		},
		limits: [
			{
				kind: "weekly_scoped",
				percent: 100,
				resets_at: new Date(Date.now() + 20 * 3_600_000).toISOString(),
				scope: { model: { display_name: "Claude Opus 4.8" } },
			},
		],
	} as never);
}

/** One persisted request row, as handed to dbOps.saveRequest. */
type SaveRequestCall = Record<string, unknown>;

function makeProxyContext() {
	const attemptCalls: SaveRequestCall[] = [];
	let persistedStreak = 0;
	const markCalls: Array<{ id: string; until: number; reason: string }> = [];
	const ctx = {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(accountId: string, until: number, reason: string) => {
					markCalls.push({ id: accountId, until, reason });
					return Promise.resolve(++persistedStreak);
				},
			),
			markAccountRateLimitedDeadlineOnly: mock(
				(accountId: string, until: number, reason: string) => {
					markCalls.push({ id: accountId, until, reason });
					return Promise.resolve();
				},
			),
			saveRequest: mock((data: SaveRequestCall) => {
				attemptCalls.push(data);
				return Promise.resolve();
			}),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 429,
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
		config: { getStorePayloads: () => true } as never,
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
	} as unknown as ProxyContext;
	return { ctx, attemptCalls: routingAttempts(ctx), markCalls };
}

function makeRequest(body: ArrayBuffer, headers: Record<string, string> = {}) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function rejected429() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "rate limited" },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-unified-status": "rejected",
				"x-should-retry": "true",
				"retry-after": String(RETRY_AFTER_S),
			},
		},
	);
}

function reasonsFrom(calls: SaveRequestCall[]): unknown[] {
	return calls.map((row) => row.error);
}

async function run(
	ctx: ProxyContext,
	account: Account,
	model = "claude-opus-4-8",
	options?: Parameters<typeof proxyWithAccount>[13],
	requestHeaders: Record<string, string> = {},
	meta: RequestMeta = makeRequestMeta(),
) {
	const bodyBuffer = makeRequestBody(model);
	return proxyWithAccount(
		makeRequest(bodyBuffer, requestHeaders),
		new URL("https://proxy.local/v1/messages"),
		account,
		meta,
		bodyBuffer,
		() => undefined,
		0,
		ctx,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		options,
	);
}

describe("proxyWithAccount — account-wide session-exhausted 429", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		usageCache.delete(ACCOUNT_ID);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		usageCache.delete(ACCOUNT_ID);
	});

	it("records session_exhausted_429, keeps the extractCooldownUntil deadline and skips burst-retry", async () => {
		globalThis.fetch = mock(async () => rejected429());
		seedSessionExhausted();

		const { ctx, attemptCalls, markCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const before = Date.now();

		const result = await run(ctx, account);

		expect(result).toBeNull();
		expect(reasonsFrom(attemptCalls)).toContain("session_exhausted_429");
		expect(reasonsFrom(attemptCalls)).not.toContain("model_fallback_429");
		expect(isAnthropicBurstThrottleActive()).toBe(false);
		// The deadline is still extractCooldownUntil's retry-after value, NOT the
		// (later) 5h window reset.
		const until = account.rate_limited_until as number;
		expect(until).toBeGreaterThanOrEqual(before + RETRY_AFTER_S * 1000);
		expect(until).toBeLessThan(before + (RETRY_AFTER_S + 5) * 1000);
		expect(markCalls).toEqual([
			{ id: ACCOUNT_ID, until, reason: "session_exhausted_429" },
		]);
	});

	it("still reports weekly_exhausted_429 when BOTH windows are spent (v2026.7.28 behaviour)", async () => {
		globalThis.fetch = mock(async () => rejected429());
		seedBothExhausted();

		const { ctx, attemptCalls } = makeProxyContext();
		await run(ctx, makeOAuthAnthropicAccount());

		expect(reasonsFrom(attemptCalls)).toContain("weekly_exhausted_429");
		expect(reasonsFrom(attemptCalls)).not.toContain("session_exhausted_429");
	});

	it("fails open to today's behaviour when usage is absent/stale", async () => {
		globalThis.fetch = mock(async () => rejected429());
		// No usage cache entry ⇒ getFreshCapacity returns null ⇒ no evidence.

		const { ctx, attemptCalls } = makeProxyContext();
		await run(ctx, makeOAuthAnthropicAccount());

		expect(reasonsFrom(attemptCalls)).not.toContain("session_exhausted_429");
		expect(reasonsFrom(attemptCalls)).toContain("model_fallback_429");
	});

	it("is skipped in reprobe mode (the hold orchestrator owns that outcome)", async () => {
		globalThis.fetch = mock(async () => rejected429());
		seedSessionExhausted();

		const { ctx, attemptCalls } = makeProxyContext();
		await run(ctx, makeOAuthAnthropicAccount(), "claude-opus-4-8", {
			reprobe: true,
		});

		expect(reasonsFrom(attemptCalls)).not.toContain("session_exhausted_429");
	});

	it("is skipped for a TRUSTED in-process probe but NOT for a spoofed header", async () => {
		globalThis.fetch = mock(async () => rejected429());
		seedSessionExhausted();

		const trusted = makeProxyContext();
		await run(
			trusted.ctx,
			makeOAuthAnthropicAccount(),
			"claude-opus-4-8",
			undefined,
			{ "x-clankermux-keepalive": "1" },
			makeRequestMeta({ internal: true }),
		);
		expect(reasonsFrom(trusted.attemptCalls)).not.toContain(
			"session_exhausted_429",
		);

		const spoofed = makeProxyContext();
		await run(
			spoofed.ctx,
			makeOAuthAnthropicAccount(),
			"claude-opus-4-8",
			undefined,
			{ "x-clankermux-keepalive": "1" },
		);
		expect(reasonsFrom(spoofed.attemptCalls)).toContain(
			"session_exhausted_429",
		);
	});

	it("does not fire for a non-Anthropic account", async () => {
		globalThis.fetch = mock(async () => rejected429());
		seedSessionExhausted();

		const { ctx, attemptCalls } = makeProxyContext();
		await run(ctx, makeOAuthAnthropicAccount({ provider: "codex" }), "gpt-5.5");

		expect(reasonsFrom(attemptCalls)).not.toContain("session_exhausted_429");
	});

	it("leaves the family-weekly rung reachable when only a FAMILY is spent", async () => {
		globalThis.fetch = mock(async () => rejected429());
		seedFamilyOnlyExhausted();

		const { ctx, attemptCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		await run(ctx, account);

		const reasons = reasonsFrom(attemptCalls);
		expect(reasons).not.toContain("session_exhausted_429");
		expect(reasons).not.toContain("weekly_exhausted_429");
		expect(reasons).toContain("family_weekly_exhausted_429");
		// The family rung deliberately applies NO account-wide cooldown.
		expect(account.rate_limited_until).toBeNull();
	});
});

describe("live account-wide quota rejection with lagging usage", () => {
	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		setSystemTime(new Date(NOW));
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		resetFamilyWeeklyMemoForTests();
		resetRateLimitProbeGatesForTests();
		usageCache.setWithAgeForTests(
			ACCOUNT_ID,
			{
				five_hour: {
					utilization: 97,
					resets_at: new Date(SESSION_RESET).toISOString(),
				},
				seven_day: {
					utilization: 55,
					resets_at: new Date(WEEKLY_RESET).toISOString(),
				},
				limits: [
					{
						kind: "weekly_scoped",
						percent: 99,
						resets_at: new Date(WEEKLY_RESET).toISOString(),
						scope: { model: { display_name: "Claude Fable 5.1" } },
					},
				],
			} as never,
			92_000,
		);
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		setSystemTime();
		usageCache.delete(ACCOUNT_ID);
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		resetFamilyWeeklyMemoForTests();
		resetRateLimitProbeGatesForTests();
	});

	it("replays Claude-1's mixed rejection with its actual session deadline and a recoverable cause", async () => {
		globalThis.fetch = mock(async () => quotaIncidentResponse());
		const { ctx, markCalls, attemptCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const outcomes: string[] = [];
		expect(
			await run(ctx, account, "claude-fable-5-1", {
				onOutcome: (o) => {
					outcomes.push(o.kind);
				},
			}),
		).toBeNull();
		expect(markCalls).toEqual([
			{ id: ACCOUNT_ID, until: SESSION_RESET, reason: "session_exhausted_429" },
		]);
		expect(reasonsFrom(attemptCalls)).toEqual(["session_exhausted_429"]);
		expect(outcomes).toEqual(["hard_429"]);
		expect(account.rate_limited_until).toBe(SESSION_RESET);
		expect(account.consecutive_rate_limits).toBe(0);
		expect(isAnthropicBurstThrottleActive()).toBe(false);
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT_ID, "fable", NOW)).toBeNull();
	});

	it("honors live account quota with no usage cache and without an extra usage fetch", async () => {
		usageCache.delete(ACCOUNT_ID);
		globalThis.fetch = mock(async () => quotaIncidentResponse());
		const { ctx, markCalls } = makeProxyContext();
		await run(ctx, makeOAuthAnthropicAccount());
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(markCalls[0]).toEqual({
			id: ACCOUNT_ID,
			until: SESSION_RESET,
			reason: "session_exhausted_429",
		});
	});

	it("persists quota exhaustion discovered during a burst reprobe and ends the hold", async () => {
		globalThis.fetch = mock(async () => quotaIncidentResponse());
		const { ctx, markCalls } = makeProxyContext();
		const outcomes: string[] = [];
		const account = makeOAuthAnthropicAccount({
			rate_limited_until: NOW + 60_000,
		});
		await run(ctx, account, "claude-fable-5-1", {
			reprobe: true,
			onOutcome: (o) => {
				outcomes.push(o.kind);
			},
		});
		expect(markCalls).toEqual([
			{ id: ACCOUNT_ID, until: SESSION_RESET, reason: "session_exhausted_429" },
		]);
		expect(outcomes).toEqual(["hard_429"]);
	});

	it("uses the same claim deadline in generic response processing", async () => {
		const { ctx, markCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		expect(
			await processProxyResponse(
				quotaIncidentResponse({ "content-type": "text/event-stream" }),
				account,
				ctx,
			),
		).toBe(true);
		expect(markCalls).toEqual([
			{ id: ACCOUNT_ID, until: SESSION_RESET, reason: "session_exhausted_429" },
		]);
		expect(isAnthropicBurstThrottleActive()).toBe(false);
	});

	it("keeps billing depletion ahead of live quota exhaustion", async () => {
		globalThis.fetch = mock(async () =>
			quotaIncidentResponse({
				"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
			}),
		);
		const { ctx, markCalls } = makeProxyContext();
		await run(ctx, makeOAuthAnthropicAccount());
		expect(markCalls[0]?.reason).toBe("out_of_credits");
	});

	it("does not trust custom endpoint claims", async () => {
		globalThis.fetch = mock(async () => quotaIncidentResponse());
		const { ctx, markCalls } = makeProxyContext();
		await run(
			ctx,
			makeOAuthAnthropicAccount({ custom_endpoint: "https://proxy.example" }),
		);
		expect(markCalls[0]?.reason).toBe("model_fallback_429");
		expect(markCalls[0]?.until).toBe(NOW + 86_400_000);
	});

	it("preserves trusted keepalive exemptions while rejecting spoofed ones", async () => {
		globalThis.fetch = mock(async () => quotaIncidentResponse());
		const trusted = makeProxyContext();
		await run(
			trusted.ctx,
			makeOAuthAnthropicAccount(),
			"claude-fable-5-1",
			undefined,
			{ "x-clankermux-keepalive": "1" },
			makeRequestMeta({ internal: true }),
		);
		expect(trusted.markCalls).toHaveLength(0);
		const spoofed = makeProxyContext();
		await run(
			spoofed.ctx,
			makeOAuthAnthropicAccount(),
			"claude-fable-5-1",
			undefined,
			{ "x-clankermux-keepalive": "1" },
		);
		expect(spoofed.markCalls[0]?.reason).toBe("session_exhausted_429");
	});

	it("backs off repeated quota rejections with malformed resets instead of treating defaults as upstream deadlines", async () => {
		globalThis.fetch = mock(async () =>
			quotaIncidentResponse({
				"anthropic-ratelimit-unified-5h-reset": "invalid",
			}),
		);
		const { ctx, markCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const deadlines: number[] = [];
		for (const backoff of [
			30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
		]) {
			const now = Date.now();
			await run(ctx, account, "claude-fable-5-1", {
				onOutcome: (o) => {
					if (o.kind === "hard_429" && o.cooldownUntil)
						deadlines.push(o.cooldownUntil);
				},
			});
			expect(account.rate_limited_until).toBe(now + backoff);
			expect(account.rate_limited_reason).toBe("session_exhausted_429");
			setSystemTime(new Date(now + backoff + 1));
		}
		expect(account.consecutive_rate_limits).toBe(6);
		expect(deadlines).toEqual(markCalls.map((call) => call.until));
		expect(isAnthropicBurstThrottleActive()).toBe(false);
	});

	it("classifies an internal auto-refresh quota rejection without writing a client request-history row", async () => {
		globalThis.fetch = mock(async () => quotaIncidentResponse());
		const { ctx, markCalls, attemptCalls } = makeProxyContext();
		await run(
			ctx,
			makeOAuthAnthropicAccount(),
			"claude-fable-5-1",
			undefined,
			{ "x-clankermux-auto-refresh": "true" },
			makeRequestMeta({ internal: true }),
		);
		expect(markCalls).toEqual([
			{ id: ACCOUNT_ID, until: SESSION_RESET, reason: "session_exhausted_429" },
		]);
		expect(attemptCalls).toHaveLength(1);
		expect(ctx.dbOps.saveRequest).not.toHaveBeenCalled();
	});

	it("keeps a both-rejecting account locked after 5h resets while weekly remains exhausted", async () => {
		globalThis.fetch = mock(async () =>
			quotaIncidentResponse({
				"anthropic-ratelimit-unified-7d-status": "rejected",
				"anthropic-ratelimit-unified-7d-utilization": "1.0",
			}),
		);
		const { ctx } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		await run(ctx, account, "claude-fable-5-1");
		expect(account.rate_limited_until).toBe(WEEKLY_RESET);
		expect(account.rate_limited_reason).toBe("weekly_exhausted_429");
		setSystemTime(new Date(SESSION_RESET + 1));
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						five_hour: { utilization: 0, resets_at: null },
						seven_day: {
							utilization: 100,
							resets_at: new Date(WEEKLY_RESET).toISOString(),
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		let recoveryReports = 0;
		try {
			usageCache.startPolling(
				ACCOUNT_ID,
				"token",
				"anthropic",
				3_600_000,
				undefined,
				undefined,
				() => {
					recoveryReports++;
				},
			);
			expect(await usageCache.refreshNow(ACCOUNT_ID)).toBe(true);
			expect(recoveryReports).toBe(0);
			expect(account.rate_limited_until).toBe(WEEKLY_RESET);
			expect(account.rate_limited_until).toBeGreaterThan(Date.now());
		} finally {
			usageCache.stopPolling(ACCOUNT_ID);
		}
	});

	it("natural session expiry uses ordinary admission and can then discover a scoped-only rejection", async () => {
		globalThis.fetch = mock(async () => quotaIncidentResponse());
		const { ctx } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		await run(ctx, account, "claude-fable-5-1");
		setSystemTime(new Date(SESSION_RESET + 1));
		account.expires_at = Date.now() + 3_600_000;
		expect(account.rate_limited_until).toBeLessThan(Date.now());
		expect(getRateLimitProbeAdmission(account)).toBe("not_required");
		globalThis.fetch = mock(async () =>
			quotaIncidentResponse({
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-5h-utilization": "0.0",
			}),
		);
		const next = makeProxyContext();
		await run(next.ctx, account, "claude-fable-5-1");
		expect(next.markCalls).toHaveLength(0);
		expect(reasonsFrom(next.attemptCalls)).toEqual([
			"family_weekly_exhausted_429",
		]);
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT_ID, "fable", Date.now())).toBe(
			WEEKLY_RESET,
		);
	});
});
