import { afterEach, describe, expect, it } from "bun:test";
import {
	type CodexCreditsInfo,
	type RateLimitInfo,
	usageCache,
} from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import {
	type ApplyCodexObservationOptions,
	applyCodexObservation,
} from "../codex-observation";
import type { ProxyContext } from "../proxy-types";

// Minimal Codex account fixture. Only the fields applyCodexObservation reads
// matter; the rest exist to satisfy the type checker.
function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-1",
		name: "codex-account",
		provider: "codex",
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

// Spy ctx capturing every DB-facing side-effect applyCodexObservation performs.
function makeCtx() {
	const calls = {
		updateAccountUsage: [] as string[],
		runSql: [] as Array<{ sql: string; params: unknown[] }>,
		resetAccountSession: [] as Array<{ accountId: string; now: number }>,
		markRateLimited: [] as Array<{
			accountId: string;
			until: number;
			reason: string;
			deadlineOnly?: boolean;
		}>,
		rateLimitMeta: [] as Array<{
			accountId: string;
			status: string;
			resetTime: number | null;
			remaining: number | undefined;
		}>,
		resetConsecutive: [] as string[],
		enqueueCount: 0,
	};
	let persistedCounter = 0;

	const ctx = {
		dbOps: {
			updateAccountUsage: (accountId: string) => {
				calls.updateAccountUsage.push(accountId);
			},
			updateAccountRateLimitMeta: (
				accountId: string,
				status: string,
				resetTime: number | null,
				remaining: number | undefined,
			) => {
				calls.rateLimitMeta.push({ accountId, status, resetTime, remaining });
			},
			markAccountRateLimited: async (
				accountId: string,
				until: number,
				reason: string,
			) => {
				calls.markRateLimited.push({ accountId, until, reason });
				persistedCounter += 1;
				return persistedCounter;
			},
			markAccountRateLimitedDeadlineOnly: async (
				accountId: string,
				until: number,
				reason: string,
			) => {
				calls.markRateLimited.push({
					accountId,
					until,
					reason,
					deadlineOnly: true,
				});
			},
			resetConsecutiveRateLimits: async (accountId: string) => {
				calls.resetConsecutive.push(accountId);
				persistedCounter = 0;
			},
			resetAccountSession: async (accountId: string, now: number) => {
				calls.resetAccountSession.push({ accountId, now });
			},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async (sql: string, params: unknown[]) => {
					calls.runSql.push({ sql, params });
				},
			}),
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				calls.enqueueCount++;
				// Run synchronously so mutations are observable in-test.
				void job();
			},
		},
	} as unknown as Pick<ProxyContext, "asyncWriter" | "dbOps">;

	return { ctx, calls };
}

function rl(overrides: Partial<RateLimitInfo> = {}): RateLimitInfo {
	return { isRateLimited: false, ...overrides };
}

function baseOpts(
	overrides: Partial<ApplyCodexObservationOptions> = {},
): ApplyCodexObservationOptions {
	return {
		source: "real-traffic",
		rateLimitInfo: rl(),
		requestAccounting: "none",
		rateLimitAction: { kind: "skip" },
		successRecovery: "standard",
		...overrides,
	};
}

// A Codex 200 response with a primary 5h window header. Uses fractional
// epoch-seconds so reset precision survives (parseFloat * 1000). No 7d header.
function codexResponse(
	fiveHourResetMs: number,
	extraHeaders: Record<string, string> = {},
	status = 200,
): Response {
	return new Response('{"id":"msg_1"}', {
		status,
		headers: {
			"content-type": "application/json",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": String(fiveHourResetMs / 1000),
			...extraHeaders,
		},
	});
}

// A response with 5h primary + 7d secondary windows.
function codexResponseWithBothWindows(
	fiveHourResetMs: number,
	sevenDayResetMs: number,
): Response {
	return new Response('{"id":"msg_1"}', {
		status: 200,
		headers: {
			"content-type": "application/json",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": String(fiveHourResetMs / 1000),
			"x-codex-secondary-window-minutes": String(7 * 24 * 60),
			"x-codex-secondary-reset-at": String(sevenDayResetMs / 1000),
		},
	});
}

function rateLimitResetWrites(
	runSql: Array<{ sql: string; params: unknown[] }>,
) {
	return runSql.filter((c) => c.sql.includes("rate_limit_reset"));
}

const cleanupIds = new Set<string>();
function track(id: string): string {
	cleanupIds.add(id);
	return id;
}
afterEach(() => {
	for (const id of cleanupIds) usageCache.delete(id);
	cleanupIds.clear();
});

describe("applyCodexObservation — request accounting", () => {
	it("'session' calls updateAccountUsage exactly once and no manual UPDATE", () => {
		const account = makeCodexAccount({ id: track("acct-session") });
		const { ctx, calls } = makeCtx();
		const resetMs = Date.now() + 4 * 60 * 60 * 1000;

		applyCodexObservation(
			account,
			codexResponse(resetMs),
			ctx,
			baseOpts({ requestAccounting: "session" }),
		);

		expect(calls.updateAccountUsage).toEqual([account.id]);
		// No count-only manual accounting UPDATE.
		expect(
			calls.runSql.filter((c) => c.sql.includes("request_count + 1")),
		).toHaveLength(0);
	});

	it("'count-only' runs the manual increment UPDATE and does NOT call updateAccountUsage", () => {
		const account = makeCodexAccount({ id: track("acct-count") });
		const { ctx, calls } = makeCtx();
		const resetMs = Date.now() + 4 * 60 * 60 * 1000;

		applyCodexObservation(
			account,
			codexResponse(resetMs),
			ctx,
			baseOpts({ requestAccounting: "count-only" }),
		);

		expect(calls.updateAccountUsage).toHaveLength(0);
		const countWrites = calls.runSql.filter(
			(c) =>
				c.sql.includes("request_count + 1") &&
				c.sql.includes("total_requests + 1"),
		);
		expect(countWrites).toHaveLength(1);
		expect(countWrites[0]?.params[1]).toBe(account.id);
	});

	it("'none' performs no accounting at all", () => {
		const account = makeCodexAccount({ id: track("acct-none") });
		const { ctx, calls } = makeCtx();
		const resetMs = Date.now() + 4 * 60 * 60 * 1000;

		applyCodexObservation(
			account,
			codexResponse(resetMs),
			ctx,
			baseOpts({ requestAccounting: "none" }),
		);

		expect(calls.updateAccountUsage).toHaveLength(0);
		expect(
			calls.runSql.filter((c) => c.sql.includes("request_count + 1")),
		).toHaveLength(0);
	});
});

describe("applyCodexObservation — credits carry-forward", () => {
	it("carries prior codexCredits forward when the response has NO credits headers", () => {
		const account = makeCodexAccount({ id: track("acct-credits-carry") });
		const resetMs = Date.now() + 4 * 60 * 60 * 1000;
		const seeded: CodexCreditsInfo = {
			hasCredits: true,
			balance: 12.5,
			unlimited: false,
			planType: "pro",
			weeklyUsedPct: 42,
		};
		usageCache.set(account.id, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(resetMs).toISOString(),
			},
			seven_day: { utilization: 50, resets_at: null },
			codexCredits: seeded,
		});

		const { ctx } = makeCtx();
		const result = applyCodexObservation(
			account,
			codexResponse(resetMs),
			ctx,
			baseOpts(),
		);

		const cached = usageCache.get(account.id) as {
			codexCredits?: CodexCreditsInfo | null;
		} | null;
		expect(cached?.codexCredits).toEqual(seeded);
		expect(result.effectiveCredits).toEqual(seeded);
	});

	it("replaces codexCredits when the response DOES carry credits headers", () => {
		const account = makeCodexAccount({ id: track("acct-credits-fresh") });
		const resetMs = Date.now() + 4 * 60 * 60 * 1000;
		usageCache.set(account.id, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(resetMs).toISOString(),
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

		const { ctx } = makeCtx();
		const result = applyCodexObservation(
			account,
			codexResponse(resetMs, {
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-balance": "7.25",
				"x-codex-credits-unlimited": "false",
				"x-codex-plan-type": "pro",
				"x-codex-secondary-used-percent": "88",
			}),
			ctx,
			baseOpts(),
		);

		const expected: CodexCreditsInfo = {
			hasCredits: true,
			balance: 7.25,
			unlimited: false,
			planType: "pro",
			weeklyUsedPct: 88,
		};
		const cached = usageCache.get(account.id) as {
			codexCredits?: CodexCreditsInfo | null;
		} | null;
		expect(cached?.codexCredits).toEqual(expected);
		expect(result.effectiveCredits).toEqual(expected);
	});
});

describe("applyCodexObservation — usage cache overwrite gating", () => {
	it("does NOT overwrite the cache when the response carries no usage windows", () => {
		const account = makeCodexAccount({ id: track("acct-no-usage") });
		const seeded = {
			five_hour: { utilization: 33, resets_at: null },
			seven_day: { utilization: 44, resets_at: null },
		};
		usageCache.set(account.id, { ...seeded });

		const { ctx } = makeCtx();
		// Plain JSON response, no x-codex-* usage headers → parseCodexUsageHeaders
		// returns null → cache untouched.
		const result = applyCodexObservation(
			account,
			new Response('{"id":"x"}', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
			ctx,
			baseOpts(),
		);

		expect(usageCache.get(account.id)).toEqual(seeded);
		expect(result.usage).toBeNull();
	});
});

describe("applyCodexObservation — earliest reset persistence", () => {
	it("persists min(5h, 7d) reset and compares against account.rate_limit_reset", () => {
		const account = makeCodexAccount({ id: track("acct-earliest") });
		const fiveHourMs = Date.now() + 5 * 60 * 60 * 1000 + 111;
		const sevenDayMs = Date.now() + 2 * 60 * 60 * 1000 + 222; // sooner than 5h here
		const { ctx, calls } = makeCtx();

		const result = applyCodexObservation(
			account,
			codexResponseWithBothWindows(fiveHourMs, sevenDayMs),
			ctx,
			baseOpts(),
		);

		const writes = rateLimitResetWrites(calls.runSql);
		expect(writes).toHaveLength(1);
		// Earliest of the two windows is persisted.
		expect(writes[0]?.params[0]).toBe(sevenDayMs);
		expect(result.earliestResetMs).toBe(sevenDayMs);
	});

	it("retries the reset write when account.rate_limit_reset is stale/unwritten (compares against DB value, not cache)", () => {
		// account.rate_limit_reset is null (never persisted) even though the cache
		// already holds a matching entry — the write must still fire so a prior
		// failed async write is retried.
		const account = makeCodexAccount({ id: track("acct-retry") });
		const fiveHourMs = Date.now() + 5 * 60 * 60 * 1000;
		usageCache.set(account.id, {
			five_hour: {
				utilization: 5,
				resets_at: new Date(fiveHourMs).toISOString(),
			},
			seven_day: { utilization: 5, resets_at: null },
		});

		const { ctx, calls } = makeCtx();
		applyCodexObservation(account, codexResponse(fiveHourMs), ctx, baseOpts());

		expect(rateLimitResetWrites(calls.runSql)).toHaveLength(1);
	});

	it("sub-second forward drift of a still-future window → no reset write AND no session reset", () => {
		const account = makeCodexAccount({ id: track("acct-drift") });
		const futureResetMs = Date.now() + 4 * 60 * 60 * 1000 + 641;
		usageCache.set(account.id, {
			five_hour: {
				utilization: 2,
				resets_at: new Date(futureResetMs).toISOString(),
			},
			seven_day: { utilization: 50, resets_at: null },
		});
		// Persisted value already matches → >=1s write-gate suppresses a 200ms drift.
		account.rate_limit_reset = futureResetMs;

		const { ctx, calls } = makeCtx();
		const result = applyCodexObservation(
			account,
			codexResponse(futureResetMs + 200),
			ctx,
			baseOpts(),
		);

		expect(rateLimitResetWrites(calls.runSql)).toHaveLength(0);
		expect(calls.resetAccountSession).toHaveLength(0);
		expect(result.windowRolledOver).toBe(false);
	});
});

describe("applyCodexObservation — genuine window roll", () => {
	it("resets the session exactly once and writes rate_limit_reset on a genuine roll", () => {
		const account = makeCodexAccount({ id: track("acct-roll") });
		const passedResetMs = Date.now() - 60 * 1000 + 123; // prior reset already arrived
		usageCache.set(account.id, {
			five_hour: {
				utilization: 98,
				resets_at: new Date(passedResetMs).toISOString(),
			},
			seven_day: { utilization: 50, resets_at: null },
		});
		// account.rate_limit_reset null → write gate fires.

		const { ctx, calls } = makeCtx();
		const nextResetMs = Date.now() + 5 * 60 * 60 * 1000 + 456;
		const result = applyCodexObservation(
			account,
			codexResponse(nextResetMs),
			ctx,
			baseOpts(),
		);

		expect(result.windowRolledOver).toBe(true);
		expect(calls.resetAccountSession).toHaveLength(1);
		expect(calls.resetAccountSession[0]?.accountId).toBe(account.id);
		const writes = rateLimitResetWrites(calls.runSql);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.params[0]).toBe(nextResetMs);
	});
});

describe("applyCodexObservation — cooldown application", () => {
	it("429 with apply action: applies cooldown once and defaults utilization to 100", () => {
		const account = makeCodexAccount({ id: track("acct-429") });
		const resetMs = Date.now() + 30 * 60 * 1000;
		const { ctx, calls } = makeCtx();

		const result = applyCodexObservation(
			account,
			// Primary window header present (meaningful) but no used-percent → 100 on 429.
			codexResponse(resetMs, {}, 429),
			ctx,
			baseOpts({
				rateLimitInfo: rl({ isRateLimited: true, resetTime: resetMs }),
				requestAccounting: "none",
				rateLimitAction: {
					kind: "apply",
					reason: "model_fallback_429",
					cooldownUntil: resetMs,
				},
			}),
		);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("model_fallback_429");
		expect(result.isRateLimited).toBe(true);

		const cached = usageCache.get(account.id) as {
			five_hour?: { utilization: number };
		} | null;
		expect(cached?.five_hour?.utilization).toBe(100);
	});

	it("skip action: no cooldown is applied even on a 429", () => {
		const account = makeCodexAccount({ id: track("acct-429-skip") });
		const resetMs = Date.now() + 30 * 60 * 1000;
		const { ctx, calls } = makeCtx();

		applyCodexObservation(
			account,
			codexResponse(resetMs, {}, 429),
			ctx,
			baseOpts({
				rateLimitInfo: rl({ isRateLimited: true, resetTime: resetMs }),
				rateLimitAction: { kind: "skip" },
			}),
		);

		expect(calls.markRateLimited).toHaveLength(0);
	});

	it("persists the unified rate-limit status from the passed rateLimitInfo (no reparse)", () => {
		const account = makeCodexAccount({ id: track("acct-meta") });
		const resetMs = Date.now() + 30 * 60 * 1000;
		const { ctx, calls } = makeCtx();

		applyCodexObservation(
			account,
			codexResponse(resetMs, {}, 429),
			ctx,
			baseOpts({
				rateLimitInfo: rl({
					isRateLimited: true,
					resetTime: resetMs,
					statusHeader: "rate_limited",
					remaining: 0,
				}),
				rateLimitAction: { kind: "apply", reason: "model_fallback_429" },
			}),
		);

		expect(calls.rateLimitMeta).toHaveLength(1);
		expect(calls.rateLimitMeta[0]).toEqual({
			accountId: account.id,
			status: "rate_limited",
			resetTime: resetMs,
			remaining: 0,
		});
	});
});

describe("applyCodexObservation — success recovery", () => {
	it("real-traffic source does NOT clear cooldown (owned by processProxyResponse)", () => {
		const account = makeCodexAccount({
			id: track("acct-rt-recovery"),
			rate_limited_until: Date.now() + 60_000,
		});
		const { ctx, calls } = makeCtx();
		const resetMs = Date.now() + 4 * 60 * 60 * 1000;

		applyCodexObservation(
			account,
			codexResponse(resetMs),
			ctx,
			baseOpts({ source: "real-traffic" }),
		);

		// Recovery is NOT performed on the real-traffic path.
		expect(account.rate_limited_until).not.toBeNull();
		expect(
			calls.runSql.filter((c) => c.sql.includes("rate_limited_until = NULL")),
		).toHaveLength(0);
	});

	it("non-real-traffic source clears rate_limited_until on a successful response", () => {
		const account = makeCodexAccount({
			id: track("acct-prime-recovery"),
			rate_limited_until: Date.now() + 60_000,
		});
		const { ctx, calls } = makeCtx();
		const resetMs = Date.now() + 4 * 60 * 60 * 1000;

		applyCodexObservation(
			account,
			codexResponse(resetMs),
			ctx,
			baseOpts({ source: "scheduled-prime" }),
		);

		expect(account.rate_limited_until).toBeNull();
		expect(
			calls.runSql.filter((c) => c.sql.includes("rate_limited_until = NULL")),
		).toHaveLength(1);
	});
});

describe("applyCodexObservation — body safety", () => {
	it("leaves the response body readable/untouched after the call", async () => {
		const account = makeCodexAccount({ id: track("acct-body") });
		const resetMs = Date.now() + 4 * 60 * 60 * 1000;
		const { ctx } = makeCtx();
		const response = codexResponse(resetMs);

		applyCodexObservation(account, response, ctx, baseOpts());

		expect(response.bodyUsed).toBe(false);
		const text = await response.text();
		expect(text).toBe('{"id":"msg_1"}');
	});
});
