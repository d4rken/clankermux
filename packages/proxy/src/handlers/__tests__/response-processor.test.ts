import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type CodexCreditsInfo, usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import {
	clearAnthropicBurstThrottle,
	isAnthropicBurstThrottleActive,
} from "../burst-cooldown";
import type { ProxyContext } from "../proxy-types";
import { processProxyResponse } from "../response-processor";

// Minimal Account fixture used by every test in this file. Only the fields
// the response-processor actually reads matter — the rest exist to satisfy
// the type checker.
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

// Spy-style ProxyContext. We don't try to construct a full DatabaseOperations
// or Provider — we hand in just enough method surface for processProxyResponse
// to do its work and we record what it calls.
function makeCtx(opts: {
	isStream: boolean;
	rateLimited: boolean;
	resetTime?: number;
}) {
	const calls = {
		markRateLimited: [] as Array<{
			accountId: string;
			resetTime: number;
			deadlineOnly?: boolean;
		}>,
		resetConsecutive: [] as string[],
		enqueueCount: 0,
		updateAccountUsage: 0,
		manualUsageRun: 0,
	};
	let persistedCounter = 0;

	const ctx = {
		provider: {
			name: "anthropic",
			isStreamingResponse: () => opts.isStream,
			parseRateLimit: () => ({
				isRateLimited: opts.rateLimited,
				resetTime: opts.resetTime,
				statusHeader: opts.rateLimited ? "rate_limited" : undefined,
				remaining: undefined,
			}),
			parseUsage: undefined,
			extractUsageInfo: undefined,
		},
		dbOps: {
			markAccountRateLimited: async (
				accountId: string,
				resetTime: number,
				_reason: string,
			) => {
				calls.markRateLimited.push({ accountId, resetTime });
				persistedCounter += 1;
				return persistedCounter;
			},
			// Lever B: non-incrementing deadline setter for server-directed resets.
			markAccountRateLimitedDeadlineOnly: async (
				accountId: string,
				resetTime: number,
				_reason: string,
			) => {
				calls.markRateLimited.push({
					accountId,
					resetTime,
					deadlineOnly: true,
				});
			},
			resetConsecutiveRateLimits: async (accountId: string) => {
				calls.resetConsecutive.push(accountId);
				persistedCounter = 0;
			},
			updateAccountUsage: () => {
				calls.updateAccountUsage++;
			},
			updateAccountRateLimitMeta: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {
					calls.manualUsageRun++;
				},
			}),
			updateRequestUsage: async () => {},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				calls.enqueueCount++;
				// Run the job immediately so any DB-side mutations are observable
				// from the test. The real AsyncDbWriter is interval-driven; for
				// the assertions we care about, sync execution is equivalent and
				// avoids needing to flush a queue.
				void job();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls };
}

// Extended spy context that captures the reason argument passed to markAccountRateLimited.
function makeCtxWithReason(opts: {
	isStream: boolean;
	rateLimited: boolean;
	resetTime?: number;
}) {
	const calls = {
		markRateLimited: [] as Array<{
			accountId: string;
			resetTime: number;
			reason: string;
			deadlineOnly?: boolean;
		}>,
		resetConsecutive: [] as string[],
		enqueueCount: 0,
	};
	let persistedCounter = 0;

	const ctx = {
		provider: {
			name: "anthropic",
			isStreamingResponse: () => opts.isStream,
			parseRateLimit: () => ({
				isRateLimited: opts.rateLimited,
				resetTime: opts.resetTime,
				statusHeader: opts.rateLimited ? "rate_limited" : undefined,
				remaining: undefined,
			}),
			parseUsage: undefined,
			extractUsageInfo: undefined,
		},
		dbOps: {
			markAccountRateLimited: async (
				accountId: string,
				resetTime: number,
				reason: string,
			) => {
				calls.markRateLimited.push({ accountId, resetTime, reason });
				persistedCounter += 1;
				return persistedCounter;
			},
			// Lever B: non-incrementing deadline setter for server-directed resets.
			markAccountRateLimitedDeadlineOnly: async (
				accountId: string,
				resetTime: number,
				reason: string,
			) => {
				calls.markRateLimited.push({
					accountId,
					resetTime,
					reason,
					deadlineOnly: true,
				});
			},
			resetConsecutiveRateLimits: async (accountId: string) => {
				calls.resetConsecutive.push(accountId);
				persistedCounter = 0;
			},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
			updateRequestUsage: async () => {},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				calls.enqueueCount++;
				void job();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls };
}

describe("processProxyResponse — rate limit audit trail (issue #178)", () => {
	it("passes reason='upstream_429_with_reset' when resetTime is present", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const before = Date.now();
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.accountId).toBe(account.id);
		// Lever B: a server-directed reset is honored verbatim (no backoff cap) and
		// goes through the non-incrementing deadline-only setter.
		expect(calls.markRateLimited[0]?.deadlineOnly).toBe(true);
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBe(resetTime);
		expect(before).toBeLessThanOrEqual(reset); // reset is in the future
		expect(calls.markRateLimited[0]?.reason).toBe("upstream_429_with_reset");
	});

	it("passes reason='upstream_429_no_reset_probe_cooldown' when no resetTime", async () => {
		const account = makeAccount();
		const before = Date.now();
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime: undefined,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.accountId).toBe(account.id);
		expect(calls.markRateLimited[0]?.reason).toBe(
			"upstream_429_no_reset_probe_cooldown",
		);
		// New behavior: first 429 in a streak applies BASE (30s) backoff.
		const BASE = 30 * 1000;
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + BASE - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + BASE + 1000);
	});

	it("passes reason='upstream_429_with_reset' on streaming 429 with resetTime", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 60 * 60_000;
		const { ctx, calls } = makeCtxWithReason({
			isStream: true,
			rateLimited: true,
			resetTime,
		});
		const response = new Response("rate limited", {
			status: 429,
			headers: { "content-type": "text/event-stream" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("upstream_429_with_reset");
	});
});

describe("processProxyResponse — streaming rate-limit failover (issue #114)", () => {
	it("returns true and marks the account on a streaming 429", async () => {
		// Pre-stream 429 — this is the case where Anthropic responds with a
		// 429 but the response happens to carry text/event-stream content-type
		// (e.g. an upstream that preserves the requested content-type on
		// errors). The historic `!isStream` guard would silently bypass both
		// marking and failover here.
		const account = makeAccount();
		const { ctx, calls } = makeCtx({
			isStream: true,
			rateLimited: true,
			resetTime: Date.now() + 30 * 60_000,
		});
		const response = new Response("rate limited", {
			status: 429,
			headers: { "content-type": "text/event-stream" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true); // signals failover loop
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.accountId).toBe(account.id);
	});

	it("returns true and marks the account on a non-streaming 429 (regression)", async () => {
		// Regression guard for the historic happy path: a JSON 429 must still
		// trigger marking + failover.
		const account = makeAccount();
		const { ctx, calls } = makeCtx({
			isStream: false,
			rateLimited: true,
			resetTime: Date.now() + 30 * 60_000,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true);
		expect(calls.markRateLimited).toHaveLength(1);
	});

	it("returns false on a successful streaming response", async () => {
		// Negative case: a healthy SSE response must NOT be marked as
		// rate-limited and must NOT signal failover. This guards against an
		// over-correction where dropping the !isStream guard accidentally
		// flags every stream.
		const account = makeAccount();
		const { ctx, calls } = makeCtx({ isStream: true, rateLimited: false });
		const response = new Response("event: message_start\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(false);
		expect(calls.markRateLimited).toHaveLength(0);
	});

	it("falls back to a BASE backoff cooldown when a streaming 429 has no resetTime", async () => {
		// Some providers return 429s without rate-limit headers. With the
		// adaptive backoff, the first 429 in a streak uses BASE (30s) so the
		// account is excluded briefly, then re-probed.
		const account = makeAccount();
		const before = Date.now();
		const { ctx, calls } = makeCtx({
			isStream: true,
			rateLimited: true,
			resetTime: undefined,
		});
		const response = new Response("rate limited", {
			status: 429,
			headers: { "content-type": "text/event-stream" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true);
		expect(calls.markRateLimited).toHaveLength(1);
		// First 429 in streak → BASE (30s) backoff. ±1s drift.
		const BASE = 30 * 1000;
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + BASE - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + BASE + 1000);
	});
});

describe("processProxyResponse — 529 overload reason", () => {
	it("passes reason='upstream_529_overloaded_with_reset' on 529 with resetTime", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const response = new Response(
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			{
				status: 529,
				headers: { "content-type": "application/json" },
			},
		);

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe(
			"upstream_529_overloaded_with_reset",
		);
	});

	it("passes reason='upstream_529_overloaded_no_reset' on 529 without resetTime", async () => {
		const account = makeAccount();
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime: undefined,
		});
		const response = new Response(
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			{
				status: 529,
				headers: { "content-type": "application/json" },
			},
		);

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe(
			"upstream_529_overloaded_no_reset",
		);
	});

	it("skips cooldown but logs status code for keepalive 529 requests", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const response = new Response(
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			{
				status: 529,
				headers: { "content-type": "application/json" },
			},
		);
		const requestMeta = {
			internal: true,
			headers: new Headers({ "x-clankermux-keepalive": "true" }),
		};

		await processProxyResponse(response, account, ctx, undefined, requestMeta);

		// Keepalive requests skip cooldown marking
		expect(calls.markRateLimited).toHaveLength(0);
	});

	it("does not honor keepalive cooldown bypass from external client traffic", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const response = new Response(
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			{
				status: 529,
				headers: { "content-type": "application/json" },
			},
		);
		const requestMeta = {
			headers: new Headers({ "x-clankermux-keepalive": "true" }),
		};

		await processProxyResponse(response, account, ctx, undefined, requestMeta);

		expect(calls.markRateLimited).toHaveLength(1);
	});
});

describe("processProxyResponse — in-memory cooldown mutation", () => {
	it("sets account.rate_limited_until on 429 with resetTime", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const before = Date.now();
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		// Lever B: a server-directed reset is honored verbatim (no backoff cap) and
		// does NOT escalate the streak.
		expect(account.rate_limited_until).toBe(resetTime);
		expect(account.consecutive_rate_limits).toBe(0);
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before, // reset is in the future
		);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			resetTime + 1000,
		);
	});

	it("sets account.rate_limited_until to BASE backoff on 429 without resetTime", async () => {
		const account = makeAccount();
		const before = Date.now();
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: true,
			resetTime: undefined,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		// New behavior: first 429 in a streak applies BASE (30s) backoff.
		expect(account.rate_limited_until).not.toBeNull();
		const BASE = 30 * 1000;
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + BASE - 1000,
		);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			Date.now() + BASE + 1000,
		);
	});

	it("clears account.rate_limited_until on successful response", async () => {
		const account = makeAccount({
			rate_limited_until: Date.now() + 60_000, // previously rate-limited
		});
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: false,
		});
		const response = new Response('{"id":"msg_1"}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		// Successful response clears cooldown
		expect(account.rate_limited_until).toBeNull();
	});

	it("does not clear account.rate_limited_until when already null on success", async () => {
		const account = makeAccount(); // rate_limited_until is null by default
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: false,
		});
		const response = new Response('{"id":"msg_1"}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		// No mutation needed — already null
		expect(account.rate_limited_until).toBeNull();
	});

	it("does not honor bypass-session accounting from external client traffic", async () => {
		const account = makeAccount();
		const { ctx, calls } = makeCtx({
			isStream: false,
			rateLimited: false,
		});
		const response = new Response('{"id":"msg_1"}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});
		const requestMeta = {
			headers: new Headers({ "x-clankermux-bypass-session": "true" }),
		};

		await processProxyResponse(response, account, ctx, undefined, requestMeta);

		expect(calls.updateAccountUsage).toBe(1);
		expect(calls.manualUsageRun).toBe(0);
	});

	it("allows internal bypass-session accounting for synthetic probes", async () => {
		const account = makeAccount();
		const { ctx, calls } = makeCtx({
			isStream: false,
			rateLimited: false,
		});
		const response = new Response('{"id":"msg_1"}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});
		const requestMeta = {
			internal: true,
			headers: new Headers({ "x-clankermux-bypass-session": "true" }),
		};

		await processProxyResponse(response, account, ctx, undefined, requestMeta);

		expect(calls.updateAccountUsage).toBe(0);
		expect(calls.manualUsageRun).toBe(1);
	});
});

// Spy context for the Codex window-roll path. Captures resetAccountSession
// calls and every SQL statement run through the (synchronously executed)
// asyncWriter so tests can assert on the rate_limit_reset write.
function makeCodexCtx() {
	const calls = {
		resetAccountSession: [] as Array<{ accountId: string; now: number }>,
		runSql: [] as Array<{ sql: string; params: unknown[] }>,
	};

	const ctx = {
		provider: {
			name: "codex",
			isStreamingResponse: () => false,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			parseUsage: undefined,
			extractUsageInfo: undefined,
		},
		dbOps: {
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			resetAccountSession: async (accountId: string, now: number) => {
				calls.resetAccountSession.push({ accountId, now });
			},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async (sql: string, params: unknown[]) => {
					calls.runSql.push({ sql, params });
				},
			}),
			updateRequestUsage: async () => {},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				void job();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls };
}

function codexResponse(fiveHourResetMs: number): Response {
	// Use the PRIMARY window header (x-codex-primary-reset-at) paired with
	// x-codex-primary-window-minutes=300 (≤ 5h ⇒ maps to five_hour). Unlike the
	// legacy x-codex-5h-reset-at path, parseCodexUsageHeaders parses this value
	// with parseFloat(...) * 1000, so a FRACTIONAL epoch-seconds value preserves
	// millisecond precision in five_hour.resets_at — letting the drift test feed a
	// reset that differs from the previous one by sub-second (and stays future).
	// No 7d header → earliest reset is just the 5h value.
	return new Response('{"id":"msg_1"}', {
		status: 200,
		headers: {
			"content-type": "application/json",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": String(fiveHourResetMs / 1000),
		},
	});
}

function rateLimitResetWrites(
	runSql: Array<{ sql: string; params: unknown[] }>,
) {
	return runSql.filter((c) => c.sql.includes("rate_limit_reset"));
}

describe("processProxyResponse — Codex window-roll detection (Primary badge flap fix)", () => {
	it("does NOT reset the session or rewrite rate_limit_reset on genuine sub-second drift of a still-future window", async () => {
		// futureResetMs carries an explicit sub-second component (…+641 ms) so the
		// new reset (prev + 200 ms = …+841 ms) is a DIFFERENT millisecond value that
		// is still strictly later AND still in the future. The primary-window header
		// preserves that fractional precision (parseFloat * 1000), so prev≠new in
		// five_hour.resets_at — unlike the old whole-second header which floored both
		// to the same second and never exercised the prevResetMs<=now guard.
		const account = makeAccount({ id: "codex-drift", provider: "codex" });
		const futureResetMs = Date.now() + 4 * 60 * 60 * 1000 + 641; // future, sub-second
		usageCache.set(account.id, {
			five_hour: {
				utilization: 2,
				resets_at: new Date(futureResetMs).toISOString(),
			},
			seven_day: { utilization: 50, resets_at: null },
		});
		// Persisted reset already matches the prior future reset, so the >=1s
		// write-gate (which now compares against account.rate_limit_reset) suppresses
		// the rewrite for a 200 ms drift.
		account.rate_limit_reset = futureResetMs;

		const { ctx, calls } = makeCodexCtx();
		// Header reports the same future window shifted forward by 200 ms — a genuine
		// sub-second difference (prev ≠ new, new > prev), but the reset has NOT yet
		// arrived. isGenuineWindowRoll must reject it via the prevResetMs<=now guard.
		const newResetMs = futureResetMs + 200;
		await processProxyResponse(codexResponse(newResetMs), account, ctx);

		expect(calls.resetAccountSession).toHaveLength(0);
		expect(rateLimitResetWrites(calls.runSql)).toHaveLength(0);

		usageCache.delete(account.id);
	});

	it("resets the session AND writes rate_limit_reset on a genuine roll (prior reset already passed)", async () => {
		const account = makeAccount({ id: "codex-roll", provider: "codex" });
		// Prior 5h reset already arrived (in the past). Sub-second component carried
		// through to prove the genuine-roll path is independent of second-flooring.
		const passedResetMs = Date.now() - 60 * 1000 + 123;
		usageCache.set(account.id, {
			five_hour: {
				utilization: 98,
				resets_at: new Date(passedResetMs).toISOString(),
			},
			seven_day: { utilization: 50, resets_at: null },
		});
		// account.rate_limit_reset is null (default) so the write-gate fires.

		const { ctx, calls } = makeCodexCtx();
		// New 5h reset is the next window, well in the future.
		const nextResetMs = Date.now() + 5 * 60 * 60 * 1000 + 456;
		await processProxyResponse(codexResponse(nextResetMs), account, ctx);

		expect(calls.resetAccountSession).toHaveLength(1);
		expect(calls.resetAccountSession[0]?.accountId).toBe(account.id);

		const writes = rateLimitResetWrites(calls.runSql);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.params[0]).toBe(nextResetMs);

		usageCache.delete(account.id);
	});
});

// ---------------------------------------------------------------------------
// Part 1 (storm-affinity-hold): reliable burst marker.
//
// processProxyResponse must trip the shared Anthropic-OAuth burst marker on a
// genuine transient burst 429 (OAuth-Anthropic, status 429, NOT a hard
// account-level unified-status, NOT a keepalive replay) — so the session's NEXT
// affinity_hold requests hold their cache account instead of diverting to a
// sibling. It must NOT trip on a hard-limit 429, a 529 overload, a non-OAuth
// account, or a successful response.
//
// Finding 5 tightening: the marker predicate now matches `classify429Transient`
// exactly rather than "any OAuth-Anthropic non-hard 429". The marker is set only
// when the 429 is actually retryable per the classifier: fresh, positive
// headroom OR (stale/zero headroom AND `x-should-retry: true`). A 429 with no
// known headroom and no retry hint is a possible real per-account wall — it must
// NOT pin siblings to that account.
// ---------------------------------------------------------------------------
describe("processProxyResponse — reliable burst marker (Part 1)", () => {
	beforeEach(() => clearAnthropicBurstThrottle());
	afterEach(() => clearAnthropicBurstThrottle());

	it("sets the burst marker on an OAuth-Anthropic transient 429 with fresh headroom (classify429Transient: fresh_headroom)", async () => {
		const account = makeAccount(); // anthropic + refresh_token → OAuth-Anthropic
		// Seed fresh, positive headroom (utilization 2 → minHeadroom 98 > 0) so the
		// classifier returns `fresh_headroom`.
		usageCache.set(account.id, {
			five_hour: { utilization: 2, resets_at: null },
			seven_day: { utilization: 5, resets_at: null },
		});
		const { ctx } = makeCtx({ isStream: false, rateLimited: true });
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		expect(isAnthropicBurstThrottleActive()).toBe(false);
		await processProxyResponse(response, account, ctx);
		expect(isAnthropicBurstThrottleActive()).toBe(true);
		usageCache.delete(account.id);
	});

	it("does NOT set the marker on a 429 with no headroom and no x-should-retry hint (Finding 5)", async () => {
		// Usage stale/absent (no cache entry → getFreshCapacity null) AND no
		// `x-should-retry` header → classify429Transient: no_headroom_no_retry_hint.
		// Before Finding 5 the broad predicate WOULD have set the marker here; now it
		// must not, so a genuine per-account wall doesn't pin siblings.
		const account = makeAccount();
		const { ctx } = makeCtx({ isStream: false, rateLimited: true });
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);
		expect(isAnthropicBurstThrottleActive()).toBe(false);
	});

	it("sets the marker on a 429 with no headroom but x-should-retry:true (classify429Transient: stale_should_retry)", async () => {
		// Usage stale/absent but the upstream signalled it's worth retrying — the
		// classifier grants `stale_should_retry`, so the marker is set.
		const account = makeAccount();
		const { ctx } = makeCtx({ isStream: false, rateLimited: true });
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: {
				"content-type": "application/json",
				"x-should-retry": "true",
			},
		});

		expect(isAnthropicBurstThrottleActive()).toBe(false);
		await processProxyResponse(response, account, ctx);
		expect(isAnthropicBurstThrottleActive()).toBe(true);
	});

	it("does NOT set the marker on a hard-limit-status 429", async () => {
		const account = makeAccount();
		const { ctx } = makeCtx({ isStream: false, rateLimited: true });
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-unified-status": "rate_limited",
			},
		});

		await processProxyResponse(response, account, ctx);
		expect(isAnthropicBurstThrottleActive()).toBe(false);
	});

	it("does NOT set the marker on a 529 overload", async () => {
		const account = makeAccount();
		const { ctx } = makeCtx({ isStream: false, rateLimited: true });
		const response = new Response('{"error":"overloaded"}', {
			status: 529,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);
		expect(isAnthropicBurstThrottleActive()).toBe(false);
	});

	it("does NOT set the marker on a non-OAuth-Anthropic (console) account", async () => {
		const account = makeAccount({
			provider: "claude-console-api",
			refresh_token: "",
			access_token: null,
			api_key: "sk-ant-test",
		});
		const { ctx } = makeCtx({ isStream: false, rateLimited: true });
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);
		expect(isAnthropicBurstThrottleActive()).toBe(false);
	});

	it("does NOT set the marker on a successful response", async () => {
		const account = makeAccount();
		const { ctx } = makeCtx({ isStream: false, rateLimited: false });
		const response = new Response('{"ok":true}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);
		expect(isAnthropicBurstThrottleActive()).toBe(false);
	});

	it("does NOT set the marker on a keepalive replay 429", async () => {
		const account = makeAccount();
		// Seed fresh headroom so the 429 WOULD classify as retryable — proving the
		// keepalive guard (not a non-retryable classification) is what suppresses
		// the marker here.
		usageCache.set(account.id, {
			five_hour: { utilization: 2, resets_at: null },
			seven_day: { utilization: 5, resets_at: null },
		});
		const { ctx } = makeCtx({ isStream: false, rateLimited: true });
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});
		const requestMeta = {
			internal: true,
			headers: new Headers({ "x-clankermux-keepalive": "true" }),
		};

		await processProxyResponse(response, account, ctx, undefined, requestMeta);
		expect(isAnthropicBurstThrottleActive()).toBe(false);
		usageCache.delete(account.id);
	});
});

// ---------------------------------------------------------------------------
// Codex credits carry-forward.
//
// A credits-less Codex response (one that carries usage headers but NO
// x-codex-credits-* headers) must PRESERVE the previously-cached codexCredits
// rather than dropping it when usageCache.set overwrites the entry. The header
// absence signals a "non-credits-aware response", NOT "off credits" — so
// blanking the state would wipe the dashboard credits chip and let the
// auto-refresh overage-resume guard (shouldResumeFromOverage, which consults
// usageCache.codexCredits) resume an account that is still on paid credits. A
// response that DOES carry credits headers still wins (fresh state overwrites).
// ---------------------------------------------------------------------------
describe("processProxyResponse — Codex credits carry-forward", () => {
	function codexResponseWithCredits(
		fiveHourResetMs: number,
		creditsHeaders: Record<string, string>,
	): Response {
		return new Response('{"id":"msg_1"}', {
			status: 200,
			headers: {
				"content-type": "application/json",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(fiveHourResetMs / 1000),
				...creditsHeaders,
			},
		});
	}

	it("preserves prior codexCredits when the response carries NO x-codex-credits-* headers", async () => {
		const account = makeAccount({
			id: "codex-credits-carry",
			provider: "codex",
		});
		const futureResetMs = Date.now() + 4 * 60 * 60 * 1000;
		const seededCredits: CodexCreditsInfo = {
			hasCredits: true,
			balance: 12.5,
			unlimited: false,
			planType: "pro",
			weeklyUsedPct: 42,
		};
		usageCache.set(account.id, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(futureResetMs).toISOString(),
			},
			seven_day: { utilization: 50, resets_at: null },
			codexCredits: seededCredits,
		});

		const { ctx } = makeCodexCtx();
		// codexResponse() emits usage headers but NO x-codex-credits-* headers, so
		// parseCodexCreditsHeaders returns null. The cache entry is still
		// overwritten (fresh usage), but the prior credits must carry forward.
		await processProxyResponse(codexResponse(futureResetMs), account, ctx);

		const cached = usageCache.get(account.id) as {
			codexCredits?: CodexCreditsInfo | null;
		} | null;
		expect(cached?.codexCredits).toEqual(seededCredits);

		usageCache.delete(account.id);
	});

	it("overwrites prior codexCredits when the response DOES carry x-codex-credits-* headers", async () => {
		const account = makeAccount({
			id: "codex-credits-fresh",
			provider: "codex",
		});
		const futureResetMs = Date.now() + 4 * 60 * 60 * 1000;
		usageCache.set(account.id, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(futureResetMs).toISOString(),
			},
			seven_day: { utilization: 50, resets_at: null },
			codexCredits: {
				hasCredits: false,
				balance: null,
				unlimited: false,
				planType: "prolite",
				weeklyUsedPct: null,
			},
		});

		const { ctx } = makeCodexCtx();
		await processProxyResponse(
			codexResponseWithCredits(futureResetMs, {
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-balance": "7.25",
				"x-codex-credits-unlimited": "false",
				"x-codex-plan-type": "pro",
				"x-codex-secondary-used-percent": "88",
			}),
			account,
			ctx,
		);

		const cached = usageCache.get(account.id) as {
			codexCredits?: CodexCreditsInfo | null;
		} | null;
		expect(cached?.codexCredits).toEqual({
			hasCredits: true,
			balance: 7.25,
			unlimited: false,
			planType: "pro",
			weeklyUsedPct: 88,
		});

		usageCache.delete(account.id);
	});
});
