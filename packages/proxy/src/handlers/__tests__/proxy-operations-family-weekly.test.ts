import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import { clearAnthropicBurstThrottle } from "../burst-cooldown";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * Reactive family-weekly safety net: an Anthropic 429 for a model family whose
 * weekly quota is exhausted (limits[]), while the account still has unified
 * 5h/7d headroom, must fail over WITHOUT an account-wide cooldown and record the
 * `family_weekly_exhausted_429` reason — so the account stays available for
 * other families. When unified headroom is also gone, the guard must fail open
 * to normal account-wide handling.
 */

const ACCOUNT_ID = "acc-fam";

function makeOAuthAnthropicAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "oauth-fam",
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

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-fam-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
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

/** Seed usageCache: `fiveHourUtil`/`sevenDayUtil` unified windows + a Fable
 *  weekly_scoped limit at 100%. */
function seedUsage(fiveHourUtil: number, sevenDayUtil: number) {
	usageCache.set(ACCOUNT_ID, {
		five_hour: {
			utilization: fiveHourUtil,
			resets_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: sevenDayUtil,
			resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		},
		limits: [
			{
				kind: "weekly_scoped",
				group: "weekly",
				percent: 100,
				resets_at: new Date(Date.now() + 16 * 3_600_000).toISOString(),
				scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
				is_active: true,
			},
		],
	} as never);
}

type SaveRequestCall = unknown[];

function makeProxyContext() {
	const saveRequestCalls: SaveRequestCall[] = [];
	const markCalls: Array<{ id: string; until: number; reason: string }> = [];
	const ctx = {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(accountId: string, until: number, reason: string) => {
					markCalls.push({ id: accountId, until, reason });
					return Promise.resolve(1);
				},
			),
			markAccountRateLimitedDeadlineOnly: mock(
				(accountId: string, until: number, reason: string) => {
					markCalls.push({ id: accountId, until, reason });
					return Promise.resolve();
				},
			),
			saveRequest: mock((...args: unknown[]) => {
				saveRequestCalls.push(args);
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
	return { ctx, saveRequestCalls, markCalls };
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function plain429() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "rate limited" },
		}),
		{
			status: 429,
			headers: { "content-type": "application/json", "x-should-retry": "true" },
		},
	);
}

/** A 429 asserting a HARD account-level unified status — authoritative, must
 *  override cached family evidence. */
function hardLimit429() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "rate limited" },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-unified-status": "rate_limited",
			},
		},
	);
}

describe("proxyWithAccount — reactive family-weekly 429 guard", () => {
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

	it("fails over without an account-wide cooldown and records family_weekly_exhausted_429", async () => {
		globalThis.fetch = mock(async () => plain429());
		seedUsage(0, 83); // Fable exhausted, unified 5h/7d have headroom

		const { ctx, saveRequestCalls, markCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const bodyBuffer = makeRequestBody("claude-fable-5");

		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// Failed over (null) rather than forwarding the 429.
		expect(result).toBeNull();
		// CRITICAL: no account-wide cooldown — the account stays available for
		// other families.
		expect(account.rate_limited_until).toBeNull();
		expect(markCalls).toHaveLength(0);
		// Audit row carries the family reason + the request model.
		const familyRow = saveRequestCalls.find(
			(args) => args[6] === "family_weekly_exhausted_429",
		);
		expect(familyRow).toBeDefined();
		expect(familyRow?.[9]).toEqual({ model: "claude-fable-5" });
	});

	it("defers to a hard account-level unified status (does NOT skip the cooldown)", async () => {
		globalThis.fetch = mock(async () => hardLimit429());
		// Cache still shows Fable exhausted + unified headroom, but the LIVE 429
		// asserts a hard account-level limit — that is authoritative.
		seedUsage(0, 83);

		const { ctx, saveRequestCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const bodyBuffer = makeRequestBody("claude-fable-5");

		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// The family guard must NOT fire on a hard account-level 429...
		const familyRow = saveRequestCalls.find(
			(args) => args[6] === "family_weekly_exhausted_429",
		);
		expect(familyRow).toBeUndefined();
		// ...and the account-wide cooldown must be applied (normal handling).
		expect(account.rate_limited_until).not.toBeNull();
	});

	it("fails open to normal handling when unified headroom is also gone", async () => {
		globalThis.fetch = mock(async () => plain429());
		seedUsage(100, 83); // 5h ALSO exhausted ⇒ minHeadroom 0 ⇒ guard must NOT fire

		const { ctx, saveRequestCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const bodyBuffer = makeRequestBody("claude-fable-5");

		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// The family guard did NOT fire — no family_weekly_exhausted_429 row.
		const familyRow = saveRequestCalls.find(
			(args) => args[6] === "family_weekly_exhausted_429",
		);
		expect(familyRow).toBeUndefined();
	});

	it("does not fire for a family that is not exhausted (Opus request)", async () => {
		globalThis.fetch = mock(async () => plain429());
		seedUsage(0, 83); // only Fable exhausted; Opus has room

		const { ctx, saveRequestCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const bodyBuffer = makeRequestBody("claude-opus-4-8");

		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const familyRow = saveRequestCalls.find(
			(args) => args[6] === "family_weekly_exhausted_429",
		);
		expect(familyRow).toBeUndefined();
	});
});
