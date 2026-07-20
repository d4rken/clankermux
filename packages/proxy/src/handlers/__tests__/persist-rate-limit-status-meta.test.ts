import { describe, expect, it, mock } from "bun:test";
import type { Provider } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../proxy-types";
import { persistRateLimitStatusMeta } from "../response-processor";

// Minimal Account fixture — only `id` is read by the helper; the rest exists
// to satisfy the type checker (mirrors response-processor.test.ts).
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3600_000,
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
	};
}

// Spy-style ProxyContext: real Anthropic-shaped header parsing on
// ctx.provider, a recording updateAccountRateLimitMeta, and an asyncWriter
// that runs enqueued jobs immediately so DB-side effects are observable.
function makeCtx() {
	const metaCalls: Array<{
		accountId: string;
		status: string;
		resetTime: number | null;
		remaining: number | undefined;
	}> = [];
	let enqueueCount = 0;

	const ctx = {
		provider: {
			name: "anthropic",
			// Header-only parse, mirroring AnthropicProvider.parseRateLimit's
			// unified-header behaviour closely enough for the helper's contract.
			parseRateLimit: (response: Response) => {
				const statusHeader =
					response.headers.get("anthropic-ratelimit-unified-status") ??
					undefined;
				const resetHeader = response.headers.get(
					"anthropic-ratelimit-unified-reset",
				);
				const remainingHeader = response.headers.get(
					"anthropic-ratelimit-unified-remaining",
				);
				return {
					isRateLimited: response.status === 429,
					resetTime: resetHeader ? Number(resetHeader) * 1000 : undefined,
					statusHeader,
					remaining: remainingHeader ? Number(remainingHeader) : undefined,
				};
			},
		},
		dbOps: {
			updateAccountRateLimitMeta: (
				accountId: string,
				status: string,
				resetTime: number | null,
				remaining: number | undefined,
			) => {
				metaCalls.push({ accountId, status, resetTime, remaining });
			},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				enqueueCount++;
				void job();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, metaCalls, getEnqueueCount: () => enqueueCount };
}

function make429(headers: Record<string, string> = {}) {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "Too many requests" },
		}),
		{
			status: 429,
			headers: { "content-type": "application/json", ...headers },
		},
	);
}

describe("persistRateLimitStatusMeta", () => {
	it("persists status, reset, and remaining via updateAccountRateLimitMeta when the unified-status header is present", () => {
		const { ctx, metaCalls } = makeCtx();
		const resetEpochSec = Math.floor((Date.now() + 60_000) / 1000);
		const response = make429({
			"anthropic-ratelimit-unified-status": "rate_limited",
			"anthropic-ratelimit-unified-reset": String(resetEpochSec),
			"anthropic-ratelimit-unified-remaining": "0",
		});

		persistRateLimitStatusMeta(makeAccount(), response, ctx);

		expect(metaCalls).toHaveLength(1);
		expect(metaCalls[0]).toEqual({
			accountId: "acct-1",
			status: "rate_limited",
			resetTime: resetEpochSec * 1000,
			remaining: 0,
		});
	});

	it("persists null reset when the provider reports no resetTime", () => {
		const { ctx, metaCalls } = makeCtx();
		const response = make429({
			"anthropic-ratelimit-unified-status": "rate_limited",
		});

		persistRateLimitStatusMeta(makeAccount(), response, ctx);

		expect(metaCalls).toHaveLength(1);
		expect(metaCalls[0].resetTime).toBeNull();
		expect(metaCalls[0].remaining).toBeUndefined();
	});

	it("does nothing when the unified-status header is absent (never overwrites the stored status with null)", () => {
		const { ctx, metaCalls, getEnqueueCount } = makeCtx();
		const response = make429(); // no unified headers at all

		persistRateLimitStatusMeta(makeAccount(), response, ctx);

		expect(metaCalls).toHaveLength(0);
		expect(getEnqueueCount()).toBe(0);
	});

	it("never consumes the response body (headers only)", () => {
		const { ctx } = makeCtx();
		const response = make429({
			"anthropic-ratelimit-unified-status": "rate_limited",
		});

		persistRateLimitStatusMeta(makeAccount(), response, ctx);

		expect(response.bodyUsed).toBe(false);
	});

	it("uses the explicitly passed account-specific provider over ctx.provider", () => {
		const { ctx, metaCalls } = makeCtx();
		const accountProvider = {
			parseRateLimit: mock(() => ({
				isRateLimited: true,
				resetTime: undefined,
				statusHeader: "allowed_warning",
				remaining: 5,
			})),
		} as unknown as Provider;
		const response = make429(); // ctx.provider would find no headers here

		persistRateLimitStatusMeta(makeAccount(), response, ctx, accountProvider);

		expect(accountProvider.parseRateLimit).toHaveBeenCalledTimes(1);
		expect(metaCalls).toHaveLength(1);
		expect(metaCalls[0]).toEqual({
			accountId: "acct-1",
			status: "allowed_warning",
			resetTime: null,
			remaining: 5,
		});
	});
});
