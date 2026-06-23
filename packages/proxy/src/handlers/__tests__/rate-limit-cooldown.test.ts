import { describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../proxy-types";
import { applyRateLimitCooldown } from "../rate-limit-cooldown";

const FIVE_MIN_MS = 5 * 60 * 1000;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-cooldown",
		name: "cooldown-test",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
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

function makeCtx() {
	// markAccountRateLimited returns the persisted consecutive counter.
	const markAccountRateLimited = mock(
		(_id: string, _until: number, _reason: string) => Promise.resolve(1),
	);
	// Deadline-only setter is non-incrementing and returns void.
	const markAccountRateLimitedDeadlineOnly = mock(
		(_id: string, _until: number, _reason: string) => Promise.resolve(),
	);
	const ctx = {
		dbOps: {
			markAccountRateLimited,
			markAccountRateLimitedDeadlineOnly,
		} as never,
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
	} as unknown as ProxyContext;
	return { ctx, markAccountRateLimited, markAccountRateLimitedDeadlineOnly };
}

describe("applyRateLimitCooldown — floorUntil", () => {
	it("raises the cooldown to floorUntil when it exceeds the backoff cap", () => {
		const { ctx, markAccountRateLimited } = makeCtx();
		const account = makeAccount();
		const now = Date.now();
		const floorUntil = now + 3_600_000; // 1 hour

		applyRateLimitCooldown(
			account,
			{ floorUntil, reason: "out_of_credits" },
			ctx,
		);

		// The first-hit backoff is ~30s; floorUntil must win.
		expect(account.rate_limited_until).not.toBeNull();
		const until = account.rate_limited_until as number;
		expect(Math.abs(until - floorUntil)).toBeLessThan(2000);
		expect(until).toBeGreaterThan(now + FIVE_MIN_MS);
		expect(account.rate_limited_reason).toBeNull(); // reason is persisted via DB, not on the account here
		// DB write carried the long cooldown + reason.
		expect(markAccountRateLimited).toHaveBeenCalledTimes(1);
		const [, untilArg, reasonArg] = markAccountRateLimited.mock.calls[0];
		expect(Math.abs((untilArg as number) - floorUntil)).toBeLessThan(2000);
		expect(reasonArg).toBe("out_of_credits");
	});

	it("without floorUntil, the first 429 yields the ~30s backoff cooldown (unchanged)", () => {
		const { ctx } = makeCtx();
		const account = makeAccount();
		const now = Date.now();

		applyRateLimitCooldown(account, {}, ctx);

		const until = account.rate_limited_until as number;
		expect(until).toBeGreaterThan(now);
		expect(until).toBeLessThan(now + FIVE_MIN_MS);
	});

	it("a floorUntil smaller than the computed cooldown does NOT lower it", () => {
		const { ctx } = makeCtx();
		const account = makeAccount();
		const now = Date.now();
		// A floor in the near past / smaller than the ~30s backoff.
		const floorUntil = now + 1000;

		applyRateLimitCooldown(account, { floorUntil }, ctx);

		const until = account.rate_limited_until as number;
		// Backoff (~30s) must still win since it's larger than the 1s floor.
		expect(until).toBeGreaterThan(floorUntil);
		expect(until).toBeGreaterThan(now + 20_000);
	});

	it("out-of-credits floorUntil still escalates the streak (incrementing DB write)", () => {
		const { ctx, markAccountRateLimited, markAccountRateLimitedDeadlineOnly } =
			makeCtx();
		const account = makeAccount({ consecutive_rate_limits: 3 });
		const now = Date.now();
		const floorUntil = now + 3_600_000; // 1 hour, out-of-credits depletion

		applyRateLimitCooldown(
			account,
			{ floorUntil, reason: "out_of_credits" },
			ctx,
		);

		// Streak escalated (in-memory pre-write estimate is +1).
		expect(account.consecutive_rate_limits).toBeGreaterThan(3);
		// Escalating DB write used; deadline-only setter NOT used.
		expect(markAccountRateLimited).toHaveBeenCalledTimes(1);
		expect(markAccountRateLimitedDeadlineOnly).not.toHaveBeenCalled();
	});
});

describe("applyRateLimitCooldown — Lever B (server-directed reset, no escalation)", () => {
	it("a 429 WITH resetTime honors the reset and does NOT escalate the streak", () => {
		const { ctx, markAccountRateLimited, markAccountRateLimitedDeadlineOnly } =
			makeCtx();
		const account = makeAccount({ consecutive_rate_limits: 4 });
		const now = Date.now();
		const resetTime = now + 7 * 60 * 1000; // 7 min — beyond the backoff cap

		applyRateLimitCooldown(account, { resetTime }, ctx);

		// Honors the server-provided reset exactly (no min(resetTime, backoff)).
		expect(account.rate_limited_until).toBe(resetTime);
		// rate_limited_at refreshed for the stability-window reset logic.
		expect(account.rate_limited_at).not.toBeNull();
		const at = account.rate_limited_at as number;
		expect(Math.abs(at - now)).toBeLessThan(2000);
		// Streak counter is left untouched — this is the whole point of Lever B.
		expect(account.consecutive_rate_limits).toBe(4);

		// Deadline-only DB write used; the incrementing one is NOT.
		expect(markAccountRateLimitedDeadlineOnly).toHaveBeenCalledTimes(1);
		expect(markAccountRateLimited).not.toHaveBeenCalled();
		const [, untilArg, reasonArg] =
			markAccountRateLimitedDeadlineOnly.mock.calls[0];
		expect(untilArg).toBe(resetTime);
		expect(reasonArg).toBe("upstream_429_with_reset");
	});

	it("a 429 WITHOUT resetTime still escalates the streak and uses backoff", () => {
		const { ctx, markAccountRateLimited, markAccountRateLimitedDeadlineOnly } =
			makeCtx();
		const account = makeAccount({ consecutive_rate_limits: 4 });
		const now = Date.now();

		applyRateLimitCooldown(account, {}, ctx);

		// Backoff-derived cooldown (no server reset).
		const until = account.rate_limited_until as number;
		expect(until).toBeGreaterThan(now);
		// Streak escalated (in-memory pre-write estimate +1).
		expect(account.consecutive_rate_limits).toBe(5);
		// Incrementing DB write used; deadline-only NOT used.
		expect(markAccountRateLimited).toHaveBeenCalledTimes(1);
		expect(markAccountRateLimitedDeadlineOnly).not.toHaveBeenCalled();
	});

	it("a resetTime in the past is treated as no-reset (escalates via backoff)", () => {
		const { ctx, markAccountRateLimited, markAccountRateLimitedDeadlineOnly } =
			makeCtx();
		const account = makeAccount({ consecutive_rate_limits: 1 });
		const now = Date.now();
		const resetTime = now - 1000; // already elapsed

		applyRateLimitCooldown(account, { resetTime }, ctx);

		// Falls through to the escalating path (resetTime <= now).
		expect(account.consecutive_rate_limits).toBe(2);
		expect(markAccountRateLimited).toHaveBeenCalledTimes(1);
		expect(markAccountRateLimitedDeadlineOnly).not.toHaveBeenCalled();
	});
});
