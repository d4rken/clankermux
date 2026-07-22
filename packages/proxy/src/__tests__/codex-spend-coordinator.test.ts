/**
 * Unit tests for CodexSpendCoordinator — the authority for autonomous
 * (scheduled-prime) Codex SPEND and the manual free-GET usage READ.
 *
 * Strategy: inject the policy dependencies via the coordinator's optional `deps`
 * constructor param — `getValidAccessToken`, `applyCodexObservation` (header
 * path), and `fetchCodexUsageStatus` + `applyCodexUsageStatus` + a
 * `readChatgptAccountId` stub (the free-GET read path) — so we can observe the
 * exact opts each applicator is called with and count calls. Injection (not
 * `mock.module`) is deliberate: bun's
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
	type CodexUsageStatus,
	codexRateLimitResetCreditsCache,
	type FetchCodexUsageStatusArgs,
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
	ApplyCodexUsageStatusOptions,
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

// fetchCodexUsageStatus (the FREE GET): records the args it was called with and
// returns a pluggable CodexUsageStatus. Injected so a test can force ok/failure
// without any network and assert the fresh token + chatgpt account id flow.
let usageStatusResult: CodexUsageStatus = makeUsageStatus();
const fetchStatusCalls: FetchCodexUsageStatusArgs[] = [];
const mockFetchCodexUsageStatus = mock(
	async (args: FetchCodexUsageStatusArgs) => {
		fetchStatusCalls.push(args);
		return usageStatusResult;
	},
);

// applyCodexUsageStatus (the JSON applicator): records the opts it was called with
// and returns a pluggable observation (reuses observationResult so isRateLimited
// drives the message wording).
const applyStatusCalls: Array<{
	account: Account;
	status: CodexUsageStatus;
	opts: ApplyCodexUsageStatusOptions;
}> = [];
const mockApplyCodexUsageStatus = mock(
	(
		account: Account,
		status: CodexUsageStatus,
		_ctx: unknown,
		opts: ApplyCodexUsageStatusOptions,
	) => {
		applyStatusCalls.push({ account, status, opts });
		return { ...observationResult, responseStatus: status.status ?? 200 };
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

function makeUsageStatus(
	overrides: Partial<CodexUsageStatus> = {},
): CodexUsageStatus {
	return {
		usage: {
			five_hour: { utilization: 12, resets_at: null },
			seven_day: { utilization: 34, resets_at: null },
		},
		allowed: true,
		limitReached: false,
		rateLimitReachedType: null,
		resetCreditsAvailableCount: null,
		ok: true,
		status: 200,
		...overrides,
	};
}

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

function makeCtx() {
	const accounts = new Map<string, Account>();
	const getAccountCalls: string[] = [];
	const forceResetCalls: string[] = [];
	const resolveLedgerCalls: Array<{
		id: string;
		status: string;
		windowsReset: number | null;
		errorMessage: string | null;
	}> = [];
	const manualLedgerEvents: Array<Record<string, unknown>> = [];
	// Toggle: when true, every ledger write throws (proves writes never break
	// the consume flow).
	const ledgerFailure = { throwOnWrite: false };
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
			resolveCodexResetCreditAttempt: mock(
				async (
					id: string,
					status: string,
					windowsReset: number | null,
					errorMessage: string | null,
				) => {
					if (ledgerFailure.throwOnWrite) throw new Error("ledger down");
					resolveLedgerCalls.push({ id, status, windowsReset, errorMessage });
				},
			),
			recordManualCodexResetCreditEvent: mock(
				async (input: Record<string, unknown>) => {
					if (ledgerFailure.throwOnWrite) throw new Error("ledger down");
					manualLedgerEvents.push({ ...input });
				},
			),
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
		resolveLedgerCalls,
		manualLedgerEvents,
		ledgerFailure,
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
		applyCodexUsageStatus: mockApplyCodexUsageStatus,
		fetchCodexUsageStatus: mockFetchCodexUsageStatus,
		readChatgptAccountId: () => "acct-123",
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

// Build a `GET /wham/usage` JSON fetch response (primary → five_hour, secondary
// → seven_day) for the REAL fetchCodexUsageStatus in the end-to-end read tests.
function whamUsageResponse(
	fiveHourPct: number,
	sevenDayPct: number,
	opts: {
		allowed?: boolean;
		limitReached?: boolean;
		credits?: {
			has_credits: boolean;
			balance?: number | string;
			unlimited?: boolean;
		};
		planType?: string | null;
		status?: number;
	} = {},
): Response {
	const fiveHourResetSec = Math.floor((Date.now() + 4 * 3600_000) / 1000);
	const sevenDayResetSec = Math.floor((Date.now() + 6 * 24 * 3600_000) / 1000);
	const body: Record<string, unknown> = {
		plan_type: opts.planType ?? null,
		rate_limit: {
			allowed: opts.allowed ?? true,
			limit_reached: opts.limitReached ?? false,
			primary_window: {
				used_percent: fiveHourPct,
				limit_window_seconds: 5 * 60 * 60,
				reset_at: fiveHourResetSec,
			},
			secondary_window: {
				used_percent: sevenDayPct,
				limit_window_seconds: 7 * 24 * 60 * 60,
				reset_at: sevenDayResetSec,
			},
		},
	};
	if (opts.credits) body.credits = opts.credits;
	return new Response(JSON.stringify(body), {
		status: opts.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------

beforeEach(() => {
	fetchCalls.length = 0;
	applyCalls.length = 0;
	fetchStatusCalls.length = 0;
	applyStatusCalls.length = 0;
	mockApplyCodexObservation.mockClear();
	mockApplyCodexUsageStatus.mockClear();
	mockFetchCodexUsageStatus.mockClear();
	mockGetValidAccessToken.mockClear();
	mockFetchCodexRateLimitResetCredits.mockClear();
	mockConsumeCodexRateLimitResetCredit.mockClear();
	codexRateLimitResetCreditsCache.clear();
	tokenImpl = async () => "token";
	consumeImpl = async () => ({ outcome: "reset", windowsReset: 2 });
	observationResult = makeObservation();
	usageStatusResult = makeUsageStatus();
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
// consumeResetCredit — reset-credit ledger writes (auto resolve vs manual event)
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.consumeResetCredit — ledger", () => {
	const businessOutcomes = [
		{ outcome: "reset", windowsReset: 2 },
		{ outcome: "nothingToReset", windowsReset: 0 },
		{ outcome: "noCredit", windowsReset: 0 },
		{ outcome: "alreadyRedeemed", windowsReset: 1 },
	] as const;

	for (const business of businessOutcomes) {
		it(`auto path resolves the claimed ledger row with outcome '${business.outcome}'`, async () => {
			const {
				coordinator,
				setAccount,
				resolveLedgerCalls,
				manualLedgerEvents,
			} = makeCoordinator();
			const id = seedId(`ledger-auto-${business.outcome}`);
			setAccount(makeCodexAccount({ id, name: "codex-ledger" }));
			consumeImpl = async () => ({ ...business });

			const outcome = await coordinator.consumeResetCredit(id, {
				idempotencyKey: `codex-reset-auto:${id}:credit-1:1`,
				creditId: "credit-1",
				autoApply: { ledgerRowId: `${id}:credit-1:1` },
			});

			expect(outcome.status).toBe("completed");
			expect(resolveLedgerCalls).toEqual([
				{
					id: `${id}:credit-1:1`,
					status: business.outcome,
					windowsReset: business.windowsReset,
					errorMessage: null,
				},
			]);
			// Auto attempts never double-book a manual event.
			expect(manualLedgerEvents).toEqual([]);
		});
	}

	it("manual path records a manual ledger event with the business outcome", async () => {
		const { coordinator, setAccount, resolveLedgerCalls, manualLedgerEvents } =
			makeCoordinator();
		const id = seedId("ledger-manual");
		setAccount(makeCodexAccount({ id, name: "codex-manual" }));
		consumeImpl = async () => ({ outcome: "reset", windowsReset: 3 });

		const outcome = await coordinator.consumeResetCredit(id, {
			idempotencyKey: "manual-key-1",
			creditId: "credit-9",
		});

		expect(outcome.status).toBe("completed");
		expect(resolveLedgerCalls).toEqual([]);
		expect(manualLedgerEvents).toEqual([
			{
				accountId: id,
				accountName: "codex-manual",
				creditId: "credit-9",
				idempotencyKey: "manual-key-1",
				status: "reset",
				windowsReset: 3,
				errorMessage: null,
			},
		]);
	});

	it("manual path records creditId null when the request omits it", async () => {
		const { coordinator, setAccount, manualLedgerEvents } = makeCoordinator();
		const id = seedId("ledger-manual-nocredit");
		setAccount(makeCodexAccount({ id, name: "codex-manual" }));
		consumeImpl = async () => ({ outcome: "noCredit", windowsReset: 0 });

		await coordinator.consumeResetCredit(id, {
			idempotencyKey: "manual-key-2",
		});

		expect(manualLedgerEvents).toEqual([
			{
				accountId: id,
				accountName: "codex-manual",
				creditId: null,
				idempotencyKey: "manual-key-2",
				status: "noCredit",
				windowsReset: 0,
				errorMessage: null,
			},
		]);
	});

	it("a failed AUTO dispatch leaves the pending row untouched (same-key retry)", async () => {
		const { coordinator, setAccount, resolveLedgerCalls, manualLedgerEvents } =
			makeCoordinator();
		const id = seedId("ledger-auto-fail");
		setAccount(makeCodexAccount({ id, name: "codex-fail" }));
		consumeImpl = async () => {
			throw new Error("upstream timed out");
		};

		const outcome = await coordinator.consumeResetCredit(id, {
			idempotencyKey: `codex-reset-auto:${id}:credit-1:1`,
			creditId: "credit-1",
			autoApply: { ledgerRowId: `${id}:credit-1:1` },
		});

		expect(outcome.status).toBe("failed");
		// The pending auto row must NOT be resolved (nor a manual event booked):
		// the next tick retries with the same idempotency key.
		expect(resolveLedgerCalls).toEqual([]);
		expect(manualLedgerEvents).toEqual([]);
	});

	it("a failed MANUAL dispatch records a manual 'failed' event with the message", async () => {
		const { coordinator, setAccount, resolveLedgerCalls, manualLedgerEvents } =
			makeCoordinator();
		const id = seedId("ledger-manual-fail");
		setAccount(makeCodexAccount({ id, name: "codex-fail" }));
		consumeImpl = async () => {
			throw new Error("upstream timed out");
		};

		const outcome = await coordinator.consumeResetCredit(id, {
			idempotencyKey: "manual-key-3",
			creditId: "credit-1",
		});

		expect(outcome.status).toBe("failed");
		expect(resolveLedgerCalls).toEqual([]);
		expect(manualLedgerEvents).toEqual([
			{
				accountId: id,
				accountName: "codex-fail",
				creditId: "credit-1",
				idempotencyKey: "manual-key-3",
				status: "failed",
				windowsReset: null,
				errorMessage:
					"Failed to consume a reset credit for 'codex-fail': upstream timed out",
			},
		]);
	});

	it("a MANUAL validation failure (non-codex account) records a manual 'failed' event", async () => {
		const { coordinator, setAccount, manualLedgerEvents } = makeCoordinator();
		const id = seedId("ledger-manual-validation");
		setAccount(
			makeCodexAccount({ id, name: "not-codex", provider: "anthropic" }),
		);

		const outcome = await coordinator.consumeResetCredit(id, {
			idempotencyKey: "manual-key-4",
		});

		expect(outcome.status).toBe("failed");
		expect(manualLedgerEvents).toHaveLength(1);
		expect(manualLedgerEvents[0]).toMatchObject({
			accountId: id,
			accountName: "not-codex",
			status: "failed",
			windowsReset: null,
		});
	});

	it("a ledger-write throw does not break the AUTO consume result", async () => {
		const { coordinator, setAccount, ledgerFailure } = makeCoordinator();
		const id = seedId("ledger-throw-auto");
		setAccount(makeCodexAccount({ id, name: "codex-ledger-down" }));
		ledgerFailure.throwOnWrite = true;
		consumeImpl = async () => ({ outcome: "reset", windowsReset: 2 });

		const outcome = await coordinator.consumeResetCredit(id, {
			idempotencyKey: `codex-reset-auto:${id}:credit-1:1`,
			creditId: "credit-1",
			autoApply: { ledgerRowId: `${id}:credit-1:1` },
		});

		expect(outcome.status).toBe("completed");
		if (outcome.status === "completed") {
			expect(outcome.result).toEqual({ outcome: "reset", windowsReset: 2 });
		}
	});

	it("a ledger-write throw does not break the MANUAL consume result", async () => {
		const { coordinator, setAccount, ledgerFailure } = makeCoordinator();
		const id = seedId("ledger-throw-manual");
		setAccount(makeCodexAccount({ id, name: "codex-ledger-down" }));
		ledgerFailure.throwOnWrite = true;
		consumeImpl = async () => ({ outcome: "noCredit", windowsReset: 0 });

		const outcome = await coordinator.consumeResetCredit(id, {
			idempotencyKey: "manual-key-5",
		});

		expect(outcome.status).toBe("completed");
		if (outcome.status === "completed") {
			expect(outcome.result.outcome).toBe("noCredit");
		}
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

describe("CodexSpendCoordinator.refreshManual — GET-only (zero-cost)", () => {
	it("reads the FREE GET and never issues a native ping", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", name: "codex-x" }));
		usageStatusResult = makeUsageStatus();

		const outcome = await coordinator.refreshManual("a");

		expect(outcome).toEqual({
			success: true,
			message: "Usage refreshed for 'codex-x' (5h: 12%, 7d: 34%).",
		});
		// The free GET ran; the JSON applicator ran with `none` accounting.
		expect(mockFetchCodexUsageStatus).toHaveBeenCalledTimes(1);
		expect(mockApplyCodexUsageStatus).toHaveBeenCalledTimes(1);
		expect(applyStatusCalls[0]?.opts.requestAccounting).toBe("none");
		// The fresh token + chatgpt account id were passed to the GET.
		expect(fetchStatusCalls[0]?.accessToken).toBe("token");
		expect(fetchStatusCalls[0]?.chatgptAccountId).toBe("acct-123");
		// Absolutely NO native ping (no global fetch) and no header applicator.
		expect(fetchCalls.length).toBe(0);
		expect(mockApplyCodexObservation).not.toHaveBeenCalled();
		// The separate reset-credit GET still ran (kept separate).
		expect(mockFetchCodexRateLimitResetCredits).toHaveBeenCalledTimes(1);
	});

	it("does not celebrate an exhausted (rate-limited) account", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", name: "codex-x" }));
		observationResult = makeObservation({ isRateLimited: true });
		usageStatusResult = makeUsageStatus({ allowed: false, limitReached: true });

		const outcome = await coordinator.refreshManual("a");

		expect(outcome.success).toBe(true);
		expect(outcome.message).toBe(
			"Usage refreshed for 'codex-x' — account is rate limited (5h: 12%, 7d: 34%).",
		);
		expect(fetchCalls.length).toBe(0);
	});

	it("proceeds even when auto_refresh_enabled is 0 (a free read is always allowed)", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(
			makeCodexAccount({
				id: "a",
				name: "codex-x",
				auto_refresh_enabled: false,
			}),
		);

		const outcome = await coordinator.refreshManual("a");

		expect(outcome).toEqual({
			success: true,
			message: "Usage refreshed for 'codex-x' (5h: 12%, 7d: 34%).",
		});
		expect(mockFetchCodexUsageStatus).toHaveBeenCalledTimes(1);
		expect(fetchCalls.length).toBe(0);
	});

	it("on a GET failure keeps the prior cache, applies nothing, and sends NO ping", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		const id = seedId("get-fail");
		setAccount(makeCodexAccount({ id, name: "codex-x" }));
		const prior: UsageData = {
			five_hour: { utilization: 55, resets_at: null },
			seven_day: { utilization: 66, resets_at: null },
		};
		usageCache.set(id, prior);
		usageStatusResult = makeUsageStatus({
			ok: false,
			status: 500,
			usage: null,
		});

		const outcome = await coordinator.refreshManual(id);

		expect(outcome.success).toBe(false);
		expect(outcome.message).toContain("Codex usage read failed for 'codex-x'");
		// No applicator call, no native ping, and the prior cache is untouched.
		expect(mockApplyCodexUsageStatus).not.toHaveBeenCalled();
		expect(fetchCalls.length).toBe(0);
		expect(usageCache.get(id)).toEqual(prior);
	});

	it("on a network throw (status null) keeps the cache and sends NO ping", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", name: "codex-x" }));
		usageStatusResult = makeUsageStatus({
			ok: false,
			status: null,
			usage: null,
		});

		const outcome = await coordinator.refreshManual("a");

		expect(outcome.success).toBe(false);
		expect(outcome.message).toContain("(status network error)");
		expect(fetchCalls.length).toBe(0);
		expect(mockApplyCodexObservation).not.toHaveBeenCalled();
	});

	it("maps a non-codex account to a failure outcome without a read", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(
			makeCodexAccount({ id: "a", name: "codex-x", provider: "anthropic" }),
		);

		const outcome = await coordinator.refreshManual("a");

		expect(outcome).toEqual({
			success: false,
			message: "Account 'codex-x' is not a Codex account",
		});
		expect(mockFetchCodexUsageStatus).not.toHaveBeenCalled();
	});

	it("maps a token refresh failure to a failure outcome without a read or ping", async () => {
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
		expect(mockFetchCodexUsageStatus).not.toHaveBeenCalled();
		expect(fetchCalls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// readUsageStatus in-flight dedup + isolation from the spend dedup
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.readUsageStatus — in-flight isolation", () => {
	it("a concurrent read and scheduled prime do NOT join (separate in-flight maps)", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));

		const [read, spend] = await Promise.all([
			coordinator.readUsageStatus("a"),
			coordinator.observe("a", "scheduled-prime"),
		]);

		expect(read.success).toBe(true);
		expect(spend.status).toBe("completed");
		// The read used the FREE GET; the spend issued its OWN native ping. Neither
		// suppressed nor joined the other.
		expect(mockFetchCodexUsageStatus).toHaveBeenCalledTimes(1);
		expect(mockApplyCodexUsageStatus).toHaveBeenCalledTimes(1);
		expect(fetchCalls.length).toBe(1); // exactly one native ping (the spend)
		expect(mockApplyCodexObservation).toHaveBeenCalledTimes(1);
	});

	it("concurrent reads for the same account share ONE free GET", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", name: "codex-x" }));

		// Gate the token so the second read joins before the GET fires.
		let release: () => void = () => {};
		tokenImpl = () =>
			new Promise<string>((resolve) => {
				release = () => resolve("token");
			});

		const p1 = coordinator.readUsageStatus("a");
		const p2 = coordinator.readUsageStatus("a");
		await flush();
		release();
		const [r1, r2] = await Promise.all([p1, p2]);

		// Both joiners observe the SAME shared result and only ONE GET was issued.
		expect(r1).toBe(r2);
		expect(mockFetchCodexUsageStatus).toHaveBeenCalledTimes(1);
		expect(mockGetValidAccessToken).toHaveBeenCalledTimes(1);
	});

	it("clears the read in-flight entry after settling so a later read re-issues", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a" }));

		await coordinator.readUsageStatus("a");
		await coordinator.readUsageStatus("a");

		expect(mockFetchCodexUsageStatus).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// Scheduled priming still SPENDS via the native ping (unchanged by 1b)
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.observe — scheduled prime still spends", () => {
	it("scheduled-prime issues the native ping and never uses the free GET", async () => {
		const { coordinator, setAccount } = makeCoordinator();
		setAccount(makeCodexAccount({ id: "a", auto_refresh_enabled: true }));

		const result = await coordinator.observe("a", "scheduled-prime");

		expect(result.status).toBe("completed");
		// The native ping fired (real sendCodexNativePing → one global fetch) and
		// the header applicator ran — priming is unchanged.
		expect(fetchCalls.length).toBe(1);
		expect(mockApplyCodexObservation).toHaveBeenCalledTimes(1);
		// The free GET was NOT substituted for priming.
		expect(mockFetchCodexUsageStatus).not.toHaveBeenCalled();
		expect(mockApplyCodexUsageStatus).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// refreshManual — END-TO-END through the REAL applyCodexObservation + usageCache.
// These prove the manual "Refresh usage" path preserves prior codexCredits (the
// bug the old server callback introduced by overwriting the cache with
// window-only data), and that fresh credits/window-rolls are still applied.
// ---------------------------------------------------------------------------

describe("CodexSpendCoordinator.refreshManual — free-GET application (end-to-end)", () => {
	it("PRESERVES prior codexCredits when the free GET carries NO credits object", async () => {
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

		// Free GET returns fresh usage windows but NO `credits` object.
		fetchImpl = async () => whamUsageResponse(20, 40);

		const outcome = await coordinator.refreshManual(id);

		expect(outcome).toEqual({
			success: true,
			message: "Usage refreshed for 'codex-cf' (5h: 20%, 7d: 40%).",
		});
		const cached = usageCache.get(id) as UsageData | null;
		// Prior credits survive the free refresh…
		expect(cached?.codexCredits).toEqual(seeded);
		// …while the window utilizations were genuinely refreshed (not the seed).
		expect(cached?.five_hour.utilization).toBe(20);
		expect(cached?.seven_day.utilization).toBe(40);
	});

	it("REPLACES codexCredits when the free GET DOES carry a credits object", async () => {
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
			whamUsageResponse(20, 88, {
				credits: { has_credits: true, balance: 7.25, unlimited: false },
				planType: "pro",
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

	it("resets the session on a genuine 5h window roll during a free refresh", async () => {
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

		fetchImpl = async () => whamUsageResponse(3, 40);

		const outcome = await coordinator.refreshManual(id);

		expect(outcome.success).toBe(true);
		expect(resetSessionCalls).toHaveLength(1);
		expect(resetSessionCalls[0]?.accountId).toBe(id);
	});

	it("CRITICAL GUARD: a 200 for an EXHAUSTED account updates windows but does NOT clear rate_limited_until", async () => {
		const { coordinator, setAccount, runSql } = makeRealCoordinator();
		const id = seedId("exhausted-200");
		setAccount(
			makeCodexAccount({
				id,
				name: "codex-x",
				rate_limited_until: Date.now() + 3600_000,
				rate_limited_at: Date.now(),
			}),
		);

		fetchImpl = async () =>
			whamUsageResponse(100, 90, { allowed: false, limitReached: true });

		const outcome = await coordinator.refreshManual(id);

		expect(outcome.success).toBe(true);
		expect(outcome.message).toContain("rate limited");
		// Windows WERE observed/cached…
		const cached = usageCache.get(id) as UsageData | null;
		expect(cached?.five_hour.utilization).toBe(100);
		// …but the lock was NOT cleared: no rate_limited_until = NULL write ran.
		expect(
			runSql.some((c) => c.sql.includes("rate_limited_until = NULL")),
		).toBe(false);
	});

	it("clears rate_limited_until on a genuinely-recovered (allowed) 200", async () => {
		const { coordinator, setAccount, runSql } = makeRealCoordinator();
		const id = seedId("recovered-200");
		setAccount(
			makeCodexAccount({
				id,
				name: "codex-x",
				rate_limited_until: Date.now() + 3600_000,
				rate_limited_at: null,
			}),
		);

		fetchImpl = async () =>
			whamUsageResponse(20, 40, { allowed: true, limitReached: false });

		const outcome = await coordinator.refreshManual(id);

		expect(outcome.success).toBe(true);
		expect(
			runSql.some((c) => c.sql.includes("rate_limited_until = NULL")),
		).toBe(true);
	});
});
