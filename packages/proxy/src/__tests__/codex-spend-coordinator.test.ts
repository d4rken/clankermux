/**
 * Unit tests for CodexSpendCoordinator — the single authority for autonomous
 * (scheduled-prime) and manual (manual-refresh) Codex spend.
 *
 * Strategy: inject the two policy dependencies via the coordinator's optional
 * `deps` constructor param — `getValidAccessToken` and `applyCodexObservation` —
 * so we can observe the exact opts the applicator is called with and count
 * applicator calls. Injection (not `mock.module`) is deliberate: bun's
 * `mock.module` registrations are GLOBAL for the whole test process and are NOT
 * undone by `mock.restore()`/`afterEach`, so they leak into every later file in
 * the suite. Plain `mock()`/closure doubles passed as deps stay local to this
 * file. The native ping transport (`sendCodexNativePing` from @clankermux/providers)
 * runs for real (the default dep) but issues its `fetch` against a mocked
 * `globalThis.fetch`, so we also count physical requests and can force a
 * transport failure. `getProvider("codex").parseRateLimit` (also the default dep)
 * runs against the real, self-registered Codex provider.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	type CodexCreditsInfo,
	codexRateLimitResetCreditsCache,
	type UsageData,
	usageCache,
} from "@clankermux/providers";
import type {
	Account,
	CodexRateLimitResetCreditConsumeRequest,
	CodexRateLimitResetCreditConsumeResult,
} from "@clankermux/types";
import { CodexSpendCoordinator } from "../codex-spend-coordinator";
import type {
	ApplyCodexObservationOptions,
	CodexObservationResult,
} from "../handlers/codex-observation";
import type { ProxyContext } from "../handlers/proxy-types";

// ---------------------------------------------------------------------------
// Injected test doubles — plain mock()/closures, wired through the coordinator's
// `deps` param in makeCoordinator(). No mock.module: those would leak globally.
// ---------------------------------------------------------------------------

// getValidAccessToken: pluggable impl so a test can gate the token (to let a
// concurrent caller join) or force a refresh failure.
let tokenImpl: () => Promise<string> = async () => "token";
const mockGetValidAccessToken = mock((..._args: unknown[]) => tokenImpl());
const mockFetchCodexRateLimitResetCredits = mock(
	async (..._args: unknown[]) => ({
		availableCount: 2,
		credits: [],
	}),
);
let consumeImpl: (
	token: string,
	request: CodexRateLimitResetCreditConsumeRequest,
) => Promise<CodexRateLimitResetCreditConsumeResult> = async () => ({
	outcome: "reset",
	windowsReset: 2,
});
const mockConsumeCodexRateLimitResetCredit = mock(
	(token: string, request: CodexRateLimitResetCreditConsumeRequest) =>
		consumeImpl(token, request),
);

// applyCodexObservation: records the opts it was called with and returns a
// pluggable observation.
let observationResult: CodexObservationResult = makeObservation();
const applyCalls: Array<{
	account: Account;
	response: Response;
	opts: ApplyCodexObservationOptions;
}> = [];
const mockApplyCodexObservation = mock(
	(
		account: Account,
		response: Response,
		_ctx: unknown,
		opts: ApplyCodexObservationOptions,
	) => {
		applyCalls.push({ account, response, opts });
		return { ...observationResult, responseStatus: response.status };
	},
);

// ---------------------------------------------------------------------------
// fetch mock (drives the real sendCodexNativePing)
// ---------------------------------------------------------------------------

const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchImpl: (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response> = async () =>
	new Response("event: ignored\n\n", {
		status: 200,
		headers: { "x-codex-primary-reset-at": "1775000000" },
	});

const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeObservation(
	overrides: Partial<CodexObservationResult> = {},
): CodexObservationResult {
	return {
		usage: {
			five_hour: { utilization: 12, resets_at: null },
			seven_day: { utilization: 34, resets_at: null },
		},
		effectiveCredits: null,
		earliestResetMs: null,
		windowRolledOver: false,
		isRateLimited: false,
		responseStatus: 200,
		...overrides,
	};
}

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-1",
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
		auto_refresh_enabled: true,
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

function makeCtx() {
	const accounts = new Map<string, Account>();
	const getAccountCalls: string[] = [];
	const forceResetCalls: string[] = [];
	const ctx = {
		dbOps: {
			// Return a shallow COPY so a mid-flight mutation of the stored account
			// only affects a subsequent getAccount (mirrors a fresh DB re-read).
			getAccount: mock(async (id: string) => {
				getAccountCalls.push(id);
				const a = accounts.get(id);
				return a ? { ...a } : null;
			}),
			forceResetAccountRateLimit: mock(async (id: string) => {
				forceResetCalls.push(id);
				return true;
			}),
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				void job();
			},
		},
	} as unknown as ProxyContext;
	return {
		ctx,
		getAccountCalls,
		forceResetCalls,
		setAccount: (a: Account) => accounts.set(a.id, a),
		mutateAccount: (id: string, patch: Partial<Account>) => {
			const a = accounts.get(id);
			if (a) Object.assign(a, patch);
		},
	};
}

function makeCoordinator() {
	const harness = makeCtx();
	// Inject the two policy doubles via deps; sendCodexNativePing and getProvider
	// fall through to their real defaults (real transport against mocked fetch,
	// real self-registered Codex provider for parseRateLimit).
	const coordinator = new CodexSpendCoordinator(harness.ctx, {
		getValidAccessToken: mockGetValidAccessToken,
		applyCodexObservation: mockApplyCodexObservation,
		fetchCodexRateLimitResetCredits: mockFetchCodexRateLimitResetCredits,
		consumeCodexRateLimitResetCredit: mockConsumeCodexRateLimitResetCredit,
	});
	return { coordinator, ...harness };
}

// Real-path harness for the END-TO-END manual-refresh tests. Unlike
// makeCoordinator() (which injects a DOUBLE for applyCodexObservation), this
// leaves applyCodexObservation, sendCodexNativePing, and getProvider at their
// REAL defaults so the whole side-effect chain — native ping → provider
// parseRateLimit → real applyCodexObservation → the real `usageCache` singleton —
// runs for real. Only getValidAccessToken is stubbed (to skip token/network
// work). This is how we prove the credits-carry-forward bug fix end-to-end: the
// old server callback did `usageCache.set(accountId, windowOnlyData)` which
// dropped prior codexCredits; the coordinator path routes through
// applyCodexObservation, which carries them forward.
function makeRealCoordinator() {
	const accounts = new Map<string, Account>();
	const resetSessionCalls: Array<{ accountId: string; now: number }> = [];
	const runSql: Array<{ sql: string; params: unknown[] }> = [];
	const ctx = {
		dbOps: {
			getAccount: async (id: string) => {
				const a = accounts.get(id);
				return a ? { ...a } : null;
			},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			resetConsecutiveRateLimits: async () => {},
			markAccountRateLimited: async () => 1,
			markAccountRateLimitedDeadlineOnly: async () => {},
			resetAccountSession: async (accountId: string, now: number) => {
				resetSessionCalls.push({ accountId, now });
			},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async (sql: string, params: unknown[]) => {
					runSql.push({ sql, params });
				},
			}),
		},
		asyncWriter: {
			// Run synchronously so cache/session side-effects are observable in-test.
			enqueue: (job: () => void | Promise<void>) => {
				void job();
			},
		},
	} as unknown as ProxyContext;
	// Inject ONLY the token stub; applyCodexObservation/sendCodexNativePing/
	// getProvider fall through to the real defaults.
	const coordinator = new CodexSpendCoordinator(ctx, {
		getValidAccessToken: mockGetValidAccessToken,
		fetchCodexRateLimitResetCredits: mockFetchCodexRateLimitResetCredits,
	});
	return {
		coordinator,
		setAccount: (a: Account) => accounts.set(a.id, a),
		resetSessionCalls,
		runSql,
	};
}

// Track ids seeded into the real usageCache singleton so afterEach can wipe them
// (the singleton persists across files → must not leak).
const seededCacheIds = new Set<string>();
function seedId(id: string): string {
	seededCacheIds.add(id);
	return id;
}

// Build a native-ping fetch response carrying real Codex usage window headers
// (primary → five_hour, secondary → seven_day), plus optional extra headers.
function usageHeaderResponse(
	fiveHourPct: number,
	sevenDayPct: number,
	extraHeaders: Record<string, string> = {},
	status = 200,
): Response {
	const fiveHourResetSec = Math.floor((Date.now() + 4 * 3600_000) / 1000);
	const sevenDayResetSec = Math.floor((Date.now() + 6 * 24 * 3600_000) / 1000);
	return new Response("event: ignored\n\n", {
		status,
		headers: {
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-used-percent": String(fiveHourPct),
			"x-codex-primary-reset-at": String(fiveHourResetSec),
			"x-codex-secondary-window-minutes": String(7 * 24 * 60),
			"x-codex-secondary-used-percent": String(sevenDayPct),
			"x-codex-secondary-reset-at": String(sevenDayResetSec),
			...extraHeaders,
		},
	});
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------

beforeEach(() => {
	fetchCalls.length = 0;
	applyCalls.length = 0;
	mockApplyCodexObservation.mockClear();
	mockGetValidAccessToken.mockClear();
	mockFetchCodexRateLimitResetCredits.mockClear();
	mockConsumeCodexRateLimitResetCredit.mockClear();
	codexRateLimitResetCreditsCache.clear();
	tokenImpl = async () => "token";
	consumeImpl = async () => ({ outcome: "reset", windowsReset: 2 });
	observationResult = makeObservation();
	fetchImpl = async () =>
		new Response("event: ignored\n\n", {
			status: 200,
			headers: { "x-codex-primary-reset-at": "1775000000" },
		});
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		fetchCalls.push({ url: String(input), init: init ?? {} });
		return fetchImpl(input, init);
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	// Wipe any real-usageCache entries seeded by the end-to-end tests so the
	// shared singleton doesn't leak state into later files.
	for (const id of seededCacheIds) usageCache.delete(id);
	seededCacheIds.clear();
	codexRateLimitResetCreditsCache.clear();
});

// ---------------------------------------------------------------------------
// Earned reset-credit consumption. All transports are injected doubles: these
// tests can never redeem a real reset.
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.consumeResetCredit", () => {
	it("consumes once, clears local limits, and refreshes reset metadata", async () => {
		const { coordinator, setAccount, forceResetCalls } = makeCoordinator();
		const id = seedId("consume-reset");
		setAccount(makeCodexAccount({ id, name: "codex-reset" }));
		usageCache.set(id, {
			five_hour: { utilization: 100, resets_at: null },
			seven_day: { utilization: 100, resets_at: null },
		});

		const outcome = await coordinator.consumeResetCredit(id, {
			idempotencyKey: "redeem-123",
			creditId: "credit-456",
		});

		expect(mockConsumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(1);
		expect(mockConsumeCodexRateLimitResetCredit).toHaveBeenCalledWith("token", {
			idempotencyKey: "redeem-123",
			creditId: "credit-456",
		});
		expect(forceResetCalls).toEqual([id]);
		expect(usageCache.get(id)).toBeNull();
		expect(mockFetchCodexRateLimitResetCredits).toHaveBeenCalledWith("token");
		expect(
			codexRateLimitResetCreditsCache.get(id)?.summary.availableCount,
		).toBe(2);
		expect(outcome).toEqual({
			status: "completed",
			accountName: "codex-reset",
			result: { outcome: "reset", windowsReset: 2 },
			resetMetadataRefreshed: true,
			availableResetCount: 2,
			localRateLimitStateCleared: true,
		});
	});

	it("treats noCredit as a completed business outcome without clearing local limits", async () => {
		const { coordinator, setAccount, forceResetCalls } = makeCoordinator();
		const id = seedId("consume-none");
		setAccount(makeCodexAccount({ id, name: "codex-none" }));
		usageCache.set(id, {
			five_hour: { utilization: 50, resets_at: null },
			seven_day: { utilization: 60, resets_at: null },
		});
		consumeImpl = async () => ({ outcome: "noCredit", windowsReset: 0 });

		const outcome = await coordinator.consumeResetCredit(id, {
			idempotencyKey: "redeem-none",
		});

		expect(outcome.status).toBe("completed");
		if (outcome.status === "completed") {
			expect(outcome.result.outcome).toBe("noCredit");
			expect(outcome.localRateLimitStateCleared).toBe(false);
		}
		expect(forceResetCalls).toEqual([]);
		expect(usageCache.get(id)).not.toBeNull();
	});

	it("returns an ambiguous transport failure without clearing state or inventing an outcome", async () => {
		const { coordinator, setAccount, forceResetCalls } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "consume-failure", name: "codex-fail" }));
		consumeImpl = async () => {
			throw new Error("upstream timed out");
		};

		const outcome = await coordinator.consumeResetCredit("consume-failure", {
			idempotencyKey: "redeem-retry-me",
		});

		expect(outcome).toEqual({
			status: "failed",
			message:
				"Failed to consume a reset credit for 'codex-fail': upstream timed out",
		});
		expect(forceResetCalls).toEqual([]);
		expect(mockFetchCodexRateLimitResetCredits).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Per-cause gate
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.observe — per-cause gate", () => {
	it("rejects a scheduled prime when auto-refresh is off (no fetch, no applicator)", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: false }));

		const result = await coordinator.observe("a", "scheduled-prime");

		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toContain("auto-refresh disabled");
		}
		expect(fetchCalls.length).toBe(0);
		expect(mockApplyCodexObservation).not.toHaveBeenCalled();
	});

	it("lets a manual refresh proceed even when auto-refresh is off", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: false }));

		const result = await coordinator.observe("a", "manual-refresh");

		expect(result.status).toBe("completed");
		expect(fetchCalls.length).toBe(1);
		expect(mockApplyCodexObservation).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Validation → skipped
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.observe — validation", () => {
	it("skips when the account is missing", async () => {
		const { coordinator } = makeCoordinator();
		const result = await coordinator.observe("ghost", "manual-refresh");
		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toContain("not found");
		}
		expect(fetchCalls.length).toBe(0);
	});

	it("skips a non-codex account", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", provider: "anthropic" }));
		const result = await coordinator.observe("a", "manual-refresh");
		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toContain("is not a Codex account");
		}
		expect(fetchCalls.length).toBe(0);
	});

	it("skips an account with no tokens", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(
			makeCodexAccount({ id: "a", access_token: null, refresh_token: null }),
		);
		const result = await coordinator.observe("a", "manual-refresh");
		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toContain("has no tokens");
		}
		expect(fetchCalls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Concurrency + in-flight lifecycle
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.observe — concurrency", () => {
	it("concurrent scheduled+manual share ONE native fetch and ONE applicator call", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "x", auto_refresh_enabled: true }));

		// Gate the token so the manual caller joins before the ping fires.
		let release: () => void = () => {};
		tokenImpl = () =>
			new Promise<string>((resolve) => {
				release = () => resolve("token");
			});

		const p1 = coordinator.observe("x", "scheduled-prime");
		const p2 = coordinator.observe("x", "manual-refresh");
		await flush();
		release();
		const [r1, r2] = await Promise.all([p1, p2]);

		expect(fetchCalls.length).toBe(1);
		expect(mockApplyCodexObservation).toHaveBeenCalledTimes(1);
		expect(mockGetValidAccessToken).toHaveBeenCalledTimes(1);
		// Scheduled wins the accounting tie: counted once as count-only.
		expect(applyCalls[0]?.opts.requestAccounting).toBe("count-only");
		expect(r1.status).toBe("completed");
		expect(r2.status).toBe("completed");
		// All joiners observe the SAME shared result object.
		expect(r1).toBe(r2);
	});

	it("distinct account ids run independently (two fetches, two applicator calls)", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));
		setAccount(
			makeCodexAccount({
				id: "b",
				name: "codex-b",
				auto_refresh_enabled: true,
			}),
		);

		const [ra, rb] = await Promise.all([
			coordinator.observe("a", "scheduled-prime"),
			coordinator.observe("b", "scheduled-prime"),
		]);

		expect(ra.status).toBe("completed");
		expect(rb.status).toBe("completed");
		expect(fetchCalls.length).toBe(2);
		expect(mockApplyCodexObservation).toHaveBeenCalledTimes(2);
	});

	it("clears the in-flight entry after success so a later call issues a fresh spend", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));

		const r1 = await coordinator.observe("a", "scheduled-prime");
		const r2 = await coordinator.observe("a", "scheduled-prime");

		expect(r1.status).toBe("completed");
		expect(r2.status).toBe("completed");
		// Not shared (sequential): each issued its own physical request.
		expect(fetchCalls.length).toBe(2);
		expect(mockApplyCodexObservation).toHaveBeenCalledTimes(2);
	});

	it("clears the in-flight entry after a transport error so a later call retries", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));

		fetchImpl = async () => {
			throw new Error("network down");
		};
		const r1 = await coordinator.observe("a", "manual-refresh");
		expect(r1.status).toBe("failed");

		// Next call succeeds — proving the entry was cleared, not stuck.
		fetchImpl = async () => new Response("event: ignored\n\n", { status: 200 });
		const r2 = await coordinator.observe("a", "manual-refresh");
		expect(r2.status).toBe("completed");
		expect(fetchCalls.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.observe — accounting", () => {
	it("scheduled-only spend is counted (count-only)", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));

		await coordinator.observe("a", "scheduled-prime");

		expect(applyCalls[0]?.opts.requestAccounting).toBe("count-only");
		expect(applyCalls[0]?.opts.source).toBe("scheduled-prime");
	});

	it("manual-only spend is NOT counted (none)", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));

		await coordinator.observe("a", "manual-refresh");

		expect(applyCalls[0]?.opts.requestAccounting).toBe("none");
		expect(applyCalls[0]?.opts.source).toBe("manual-refresh");
	});
});

// ---------------------------------------------------------------------------
// Rate-limit action (success must NOT apply a cooldown)
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.observe — rate-limit action", () => {
	it("uses skip on a successful response (no cooldown on a healthy account)", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));

		await coordinator.observe("a", "manual-refresh");

		expect(applyCalls[0]?.opts.rateLimitAction.kind).toBe("skip");
		expect(applyCalls[0]?.opts.successRecovery).toBe("scheduled-prime");
	});

	it("uses apply on a 429 (applicator owns the cooldown)", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));
		fetchImpl = async () =>
			new Response("rate limited", {
				status: 429,
				headers: { "x-codex-primary-reset-at": "1775000000" },
			});

		const result = await coordinator.observe("a", "manual-refresh");

		expect(result.status).toBe("completed");
		if (result.status === "completed") {
			expect(result.responseStatus).toBe(429);
			expect(result.responseOk).toBe(false);
		}
		expect(applyCalls[0]?.opts.rateLimitAction.kind).toBe("apply");
	});
});

// ---------------------------------------------------------------------------
// Failure paths — no translated fallback
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.observe — failures", () => {
	it("returns failed on a token refresh error without any fetch or applicator", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));
		tokenImpl = async () => {
			throw new Error("invalid_grant");
		};

		const result = await coordinator.observe("a", "manual-refresh");

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toContain("Could not refresh access token");
		}
		expect(fetchCalls.length).toBe(0);
		expect(mockApplyCodexObservation).not.toHaveBeenCalled();
	});

	it("returns failed on a native transport error and does NOT fall back to a translated request", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));
		fetchImpl = async () => {
			throw new Error("network down");
		};

		const result = await coordinator.observe("a", "manual-refresh");

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toContain("Codex request failed");
		}
		// Exactly one native attempt; no applicator, no second (translated) request.
		expect(fetchCalls.length).toBe(1);
		expect(mockApplyCodexObservation).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Last-moment scheduled gate
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.observe — last-moment scheduled gate", () => {
	it("suppresses a scheduled-only prime when auto-refresh is disabled during the token refresh", async () => {
		const { coordinator, setAccount, mutateAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));

		// Gate the token; flip auto-refresh OFF while the refresh is in flight.
		let release: () => void = () => {};
		tokenImpl = () =>
			new Promise<string>((resolve) => {
				release = () => resolve("token");
			});

		const p = coordinator.observe("a", "scheduled-prime");
		await flush();
		mutateAccount("a", { auto_refresh_enabled: false });
		release();
		const result = await p;

		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toContain("auto-refresh disabled");
		}
		// Suppressed BEFORE the ping — no spend.
		expect(fetchCalls.length).toBe(0);
		expect(mockApplyCodexObservation).not.toHaveBeenCalled();
	});

	it("a joined manual cause authorizes the spend even if auto-refresh was disabled mid-refresh", async () => {
		const { coordinator, setAccount, mutateAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));

		let release: () => void = () => {};
		tokenImpl = () =>
			new Promise<string>((resolve) => {
				release = () => resolve("token");
			});

		const pScheduled = coordinator.observe("a", "scheduled-prime");
		const pManual = coordinator.observe("a", "manual-refresh");
		await flush();
		mutateAccount("a", { auto_refresh_enabled: false });
		release();
		const [rScheduled, rManual] = await Promise.all([pScheduled, pManual]);

		// Manual consent authorized the single shared request.
		expect(rScheduled.status).toBe("completed");
		expect(rManual.status).toBe("completed");
		expect(fetchCalls.length).toBe(1);
		expect(mockApplyCodexObservation).toHaveBeenCalledTimes(1);
		// Scheduled still won the accounting tie.
		expect(applyCalls[0]?.opts.requestAccounting).toBe("count-only");
	});
});

// ---------------------------------------------------------------------------
// Read-only earned reset metadata
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.refreshResetCredits", () => {
	it("stores a normalized reset summary without issuing a model request", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "reset-a" }));

		const outcome = await coordinator.refreshResetCredits("reset-a", true);

		expect(outcome.success).toBe(true);
		expect(mockFetchCodexRateLimitResetCredits).toHaveBeenCalledWith("token");
		expect(fetchCalls).toHaveLength(0);
		expect(
			codexRateLimitResetCreditsCache.get("reset-a")?.summary.availableCount,
		).toBe(2);
	});

	it("uses the fresh cache for a background refresh", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "reset-b" }));
		codexRateLimitResetCreditsCache.set("reset-b", {
			availableCount: 1,
			credits: [],
		});

		const outcome = await coordinator.refreshResetCredits("reset-b");

		expect(outcome.success).toBe(true);
		expect(mockFetchCodexRateLimitResetCredits).not.toHaveBeenCalled();
		expect(mockGetValidAccessToken).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// refreshManual — CodexUsageRefreshOutcome mapping
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.refreshManual", () => {
	it("maps a successful non-rate-limited refresh to a success outcome", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", name: "codex-x" }));
		observationResult = makeObservation({ isRateLimited: false });

		const outcome = await coordinator.refreshManual("a");

		expect(outcome).toEqual({
			success: true,
			message: "Usage refreshed for 'codex-x' (5h: 12%, 7d: 34%).",
		});
		expect(mockFetchCodexRateLimitResetCredits).toHaveBeenCalledTimes(1);
	});

	it("maps a rate-limited refresh to a success outcome that does not celebrate", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", name: "codex-x" }));
		observationResult = makeObservation({ isRateLimited: true });
		fetchImpl = async () =>
			new Response("rate limited", {
				status: 429,
				headers: { "x-codex-primary-reset-at": "1775000000" },
			});

		const outcome = await coordinator.refreshManual("a");

		expect(outcome.success).toBe(true);
		expect(outcome.message).toBe(
			"Usage refreshed for 'codex-x' — account is rate limited (5h: 12%, 7d: 34%).",
		);
		// A manual 429 still applies a cooldown (the applicator owns it): the
		// coordinator must pass rateLimitAction=apply so the account is cooled.
		expect(applyCalls[0]?.opts.rateLimitAction.kind).toBe("apply");
	});

	it("allows a manual refresh even when auto_refresh_enabled is 0 (explicit operator consent)", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(
			makeCodexAccount({
				id: "a",
				name: "codex-x",
				auto_refresh_enabled: false,
			}),
		);
		observationResult = makeObservation({ isRateLimited: false });

		const outcome = await coordinator.refreshManual("a");

		// manual-refresh cause ignores auto_refresh_enabled → the spend proceeds.
		expect(outcome).toEqual({
			success: true,
			message: "Usage refreshed for 'codex-x' (5h: 12%, 7d: 34%).",
		});
		expect(fetchCalls.length).toBe(1);
		expect(mockApplyCodexObservation).toHaveBeenCalledTimes(1);
		expect(applyCalls[0]?.opts.source).toBe("manual-refresh");
	});

	it("maps a response with no usage headers to a failure outcome carrying the status", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", name: "codex-x" }));
		observationResult = makeObservation({ usage: null });
		fetchImpl = async () => new Response("", { status: 502 });

		const outcome = await coordinator.refreshManual("a");

		expect(outcome).toEqual({
			success: false,
			message: "Codex returned no usage headers (status 502) for 'codex-x'",
		});
	});

	it("maps a non-codex account to a failure outcome", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(
			makeCodexAccount({ id: "a", name: "codex-x", provider: "anthropic" }),
		);

		const outcome = await coordinator.refreshManual("a");

		expect(outcome).toEqual({
			success: false,
			message: "Account 'codex-x' is not a Codex account",
		});
	});

	it("maps a token refresh failure to a failure outcome", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", name: "codex-x" }));
		tokenImpl = async () => {
			throw new Error("invalid_grant");
		};

		const outcome = await coordinator.refreshManual("a");

		expect(outcome.success).toBe(false);
		expect(outcome.message).toContain(
			"Could not refresh access token for 'codex-x'",
		);
	});
});

// ---------------------------------------------------------------------------
// refreshManual — END-TO-END through the REAL applyCodexObservation + usageCache.
// These prove the manual "Refresh usage" path preserves prior codexCredits (the
// bug the old server callback introduced by overwriting the cache with
// window-only data), and that fresh credits/window-rolls are still applied.
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.refreshManual — credits carry-forward (end-to-end)", () => {
	it("PRESERVES prior codexCredits when the manual native ping has NO credits headers", async () => {
		const { coordinator, setAccount } = makeRealCoordinator();
		const id = seedId("cf-carry");
		setAccount(makeCodexAccount({ id, name: "codex-cf" }));

		// Seed the cache with learned credits and null resets (so no window roll).
		const seeded: CodexCreditsInfo = {
			hasCredits: true,
			balance: 12.5,
			unlimited: false,
			planType: "pro",
			weeklyUsedPct: 42,
		};
		usageCache.set(id, {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 50, resets_at: null },
			codexCredits: seeded,
		});

		// Native ping returns fresh usage windows but NO x-codex-credits-* headers.
		fetchImpl = async () => usageHeaderResponse(20, 40);

		const outcome = await coordinator.refreshManual(id);

		expect(outcome).toEqual({
			success: true,
			message: "Usage refreshed for 'codex-cf' (5h: 20%, 7d: 40%).",
		});
		const cached = usageCache.get(id) as UsageData | null;
		// Bug fixed: prior credits survive the manual refresh…
		expect(cached?.codexCredits).toEqual(seeded);
		// …while the window utilizations were genuinely refreshed (not the seed).
		expect(cached?.five_hour.utilization).toBe(20);
		expect(cached?.seven_day.utilization).toBe(40);
	});

	it("REPLACES codexCredits when the manual native ping DOES carry credits headers", async () => {
		const { coordinator, setAccount } = makeRealCoordinator();
		const id = seedId("cf-fresh");
		setAccount(makeCodexAccount({ id, name: "codex-cf" }));

		usageCache.set(id, {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 50, resets_at: null },
			codexCredits: {
				hasCredits: false,
				balance: null,
				unlimited: false,
				planType: "prolite",
				weeklyUsedPct: null,
			},
		});

		fetchImpl = async () =>
			usageHeaderResponse(20, 88, {
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-balance": "7.25",
				"x-codex-credits-unlimited": "false",
				"x-codex-plan-type": "pro",
				"x-codex-secondary-used-percent": "88",
			});

		const outcome = await coordinator.refreshManual(id);

		expect(outcome.success).toBe(true);
		const cached = usageCache.get(id) as UsageData | null;
		expect(cached?.codexCredits).toEqual({
			hasCredits: true,
			balance: 7.25,
			unlimited: false,
			planType: "pro",
			weeklyUsedPct: 88,
		});
	});

	it("resets the session on a genuine 5h window roll during a manual refresh", async () => {
		const { coordinator, setAccount, resetSessionCalls } =
			makeRealCoordinator();
		const id = seedId("cf-roll");
		setAccount(makeCodexAccount({ id, name: "codex-cf" }));

		// Seed a prior 5h reset that has already ARRIVED so the incoming later
		// reset is a genuine roll (not sub-second forward drift).
		const passedResetMs = Date.now() - 60_000;
		usageCache.set(id, {
			five_hour: {
				utilization: 98,
				resets_at: new Date(passedResetMs).toISOString(),
			},
			seven_day: { utilization: 50, resets_at: null },
		});

		fetchImpl = async () => usageHeaderResponse(3, 40);

		const outcome = await coordinator.refreshManual(id);

		expect(outcome.success).toBe(true);
		expect(resetSessionCalls).toHaveLength(1);
		expect(resetSessionCalls[0]?.accountId).toBe(id);
	});
});
