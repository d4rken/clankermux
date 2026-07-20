/**
 * Unit tests for the Codex reset-credit auto-applier:
 *  - decideResetCreditAction — the pure decision function (table-driven gates,
 *    boundary math, ordering, ledger-terminality filtering).
 *  - CodexResetCreditApplyScheduler — the two-phase tick (discovery →
 *    confirmation → claim → dispatch) with fully injected deps + a fake clock.
 *
 * All dependencies are injected through CodexResetCreditApplyDeps — no
 * mock.module (bun registers those globally and they leak into later files in
 * the suite; see codex-spend-coordinator.test.ts for the established style).
 */
import { describe, expect, it } from "bun:test";
import { PAUSE_REASON_NEEDS_REAUTH } from "@clankermux/core";
import type {
	CodexRateLimitResetCredit,
	CodexRateLimitResetCreditsCacheEntry,
} from "@clankermux/providers";
import type {
	Account,
	CodexRateLimitResetCreditConsumeRequest,
} from "@clankermux/types";
import {
	type CodexResetCreditApplyDeps,
	CodexResetCreditApplyScheduler,
	createCodexResetCreditApplyScheduler,
	decideResetCreditAction,
	RESET_CREDIT_AUTO_APPLY_LEAD_MS,
	RESET_CREDIT_WEEKLY_LIMIT_COOLDOWN_MS,
} from "../codex-reset-credit-applier";
import type { CodexResetCreditConsumeDispatchOutcome } from "../handlers/token-manager";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed fake "now" (ms). All expiry math in the tests is relative to this. */
const NOW = 1_800_000_000_000;

/** Unix-seconds expiry that is `msFromNow` in the future of NOW. */
function expirySec(msFromNow: number): number {
	return Math.floor((NOW + msFromNow) / 1000);
}

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-1",
		name: "codex-account",
		provider: "codex",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: NOW + 3600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
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
		codex_auto_apply_reset_credits_enabled: true,
		codex_auto_apply_reset_on_weekly_limit_enabled: false,
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

function makeCredit(
	overrides: Partial<CodexRateLimitResetCredit> = {},
): CodexRateLimitResetCredit {
	return {
		id: "credit-1",
		resetType: "codexRateLimits",
		status: "available",
		grantedAt: Math.floor(NOW / 1000) - 86_400,
		expiresAt: expirySec(5 * 60_000), // 5 min out — inside the 10-min lead
		title: null,
		description: null,
		...overrides,
	};
}

function decide(inputs: {
	account?: Partial<Account>;
	credits?: CodexRateLimitResetCredit[] | null;
	resolved?: ReadonlySet<string>;
	weeklyUsedPercent?: number | null;
	autoApplyCooldownAnchorAt?: number | null;
	now?: number;
}) {
	return decideResetCreditAction({
		account: makeCodexAccount(inputs.account),
		// `null` is a meaningful input (no detail list) — only default undefined.
		credits: inputs.credits === undefined ? [makeCredit()] : inputs.credits,
		terminallyResolvedCreditIds: inputs.resolved ?? new Set(),
		weeklyUsedPercent: inputs.weeklyUsedPercent ?? null,
		autoApplyCooldownAnchorAt: inputs.autoApplyCooldownAnchorAt ?? null,
		now: inputs.now ?? NOW,
	});
}

// ---------------------------------------------------------------------------
// decideResetCreditAction — gates (table-driven)
// ---------------------------------------------------------------------------

describe("decideResetCreditAction — skip gates", () => {
	const skipCases: Array<{
		label: string;
		account?: Partial<Account>;
		credits?: CodexRateLimitResetCredit[] | null;
		resolved?: ReadonlySet<string>;
		reason: string;
	}> = [
		{
			label: "toggle disabled",
			account: { codex_auto_apply_reset_credits_enabled: false },
			reason: "toggle-disabled",
		},
		{
			label: "toggle wins over provider (disabled anthropic account)",
			account: {
				codex_auto_apply_reset_credits_enabled: false,
				provider: "anthropic",
			},
			reason: "toggle-disabled",
		},
		{
			label: "non-codex provider",
			account: { provider: "anthropic" },
			reason: "not-codex",
		},
		{
			label: "needs-reauth pause",
			account: { pause_reason: PAUSE_REASON_NEEDS_REAUTH },
			reason: "needs-reauth",
		},
		{
			label: "no refresh token",
			account: { refresh_token: null },
			reason: "no-tokens",
		},
		{
			label: "null credits list",
			credits: null,
			reason: "no-credit-near-expiry",
		},
		{
			label: "empty credits list",
			credits: [],
			reason: "no-credit-near-expiry",
		},
		{
			label: "credit that never expires",
			credits: [makeCredit({ expiresAt: null })],
			reason: "no-credit-near-expiry",
		},
		{
			label: "credit far from expiry (> lead)",
			credits: [
				makeCredit({
					expiresAt: expirySec(RESET_CREDIT_AUTO_APPLY_LEAD_MS + 60_000),
				}),
			],
			reason: "no-credit-near-expiry",
		},
		{
			label: "credit already expired (past-expiry is not actionable)",
			credits: [makeCredit({ expiresAt: expirySec(-60_000) })],
			reason: "no-credit-near-expiry",
		},
		{
			label: "credit expiring exactly now (expiresAt*1000 === now)",
			credits: [makeCredit({ expiresAt: NOW / 1000 })],
			reason: "no-credit-near-expiry",
		},
		{
			label: "non-available credit near expiry",
			credits: [makeCredit({ status: "redeemed" })],
			reason: "no-credit-near-expiry",
		},
		{
			label: "all near-expiry candidates terminally resolved",
			credits: [makeCredit({ id: "c-done" })],
			resolved: new Set(["c-done"]),
			reason: "already-resolved",
		},
	];

	for (const c of skipCases) {
		it(`skips: ${c.label} → ${c.reason}`, () => {
			expect(
				decide({
					account: c.account,
					credits: c.credits,
					resolved: c.resolved,
				}),
			).toEqual({ action: "skip", reason: c.reason });
		});
	}

	it("PAUSED-but-not-reauth accounts remain eligible (pause is not a gate)", () => {
		const credit = makeCredit();
		expect(
			decide({ account: { paused: true, pause_reason: "overage" } }),
		).toEqual({
			action: "consume",
			creditId: credit.id,
			expiresAt: credit.expiresAt as number,
			cause: "expiry",
		});
	});
});

// ---------------------------------------------------------------------------
// decideResetCreditAction — boundaries + ordering
// ---------------------------------------------------------------------------

describe("decideResetCreditAction — boundaries and ordering", () => {
	it("consumes at exactly the lead-time boundary (expiry - now === lead)", () => {
		const boundary = expirySec(RESET_CREDIT_AUTO_APPLY_LEAD_MS);
		// Use a NOW aligned so seconds-truncation doesn't move us off the boundary.
		const alignedNow = boundary * 1000 - RESET_CREDIT_AUTO_APPLY_LEAD_MS;
		expect(
			decide({
				credits: [makeCredit({ expiresAt: boundary })],
				now: alignedNow,
			}),
		).toEqual({
			action: "consume",
			creditId: "credit-1",
			expiresAt: boundary,
			cause: "expiry",
		});
	});

	it("skips one millisecond beyond the lead-time boundary", () => {
		const boundary = expirySec(RESET_CREDIT_AUTO_APPLY_LEAD_MS);
		const alignedNow = boundary * 1000 - RESET_CREDIT_AUTO_APPLY_LEAD_MS - 1;
		expect(
			decide({
				credits: [makeCredit({ expiresAt: boundary })],
				now: alignedNow,
			}),
		).toEqual({ action: "skip", reason: "no-credit-near-expiry" });
	});

	it("picks the soonest-expiring near-expiry credit regardless of list order", () => {
		const later = makeCredit({
			id: "c-later",
			expiresAt: expirySec(9 * 60_000),
		});
		const sooner = makeCredit({
			id: "c-soon",
			expiresAt: expirySec(2 * 60_000),
		});
		expect(decide({ credits: [later, sooner] })).toEqual({
			action: "consume",
			creditId: "c-soon",
			expiresAt: sooner.expiresAt as number,
			cause: "expiry",
		});
	});

	it("skips terminally-resolved ids and picks the next near-expiry candidate", () => {
		const resolvedSoonest = makeCredit({
			id: "c-resolved",
			expiresAt: expirySec(2 * 60_000),
		});
		const next = makeCredit({ id: "c-next", expiresAt: expirySec(8 * 60_000) });
		expect(
			decide({
				credits: [resolvedSoonest, next],
				resolved: new Set(["c-resolved"]),
			}),
		).toEqual({
			action: "consume",
			creditId: "c-next",
			expiresAt: next.expiresAt as number,
			cause: "expiry",
		});
	});

	it("ignores a far-future credit while consuming the near-expiry one", () => {
		const near = makeCredit({ id: "c-near", expiresAt: expirySec(4 * 60_000) });
		const far = makeCredit({
			id: "c-far",
			expiresAt: expirySec(3 * 3600_000),
		});
		expect(decide({ credits: [far, near] })).toEqual({
			action: "consume",
			creditId: "c-near",
			expiresAt: near.expiresAt as number,
			cause: "expiry",
		});
	});
});

// ---------------------------------------------------------------------------
// decideResetCreditAction — weekly-limit trigger
// ---------------------------------------------------------------------------

describe("decideResetCreditAction — weekly-limit trigger", () => {
	/** Weekly-only account: weekly toggle ON, expiry toggle OFF. */
	const weeklyOnly: Partial<Account> = {
		codex_auto_apply_reset_credits_enabled: false,
		codex_auto_apply_reset_on_weekly_limit_enabled: true,
	};
	/** A credit far outside the expiry lead window — expiry trigger ignores it. */
	const farCredit = () =>
		makeCredit({ id: "c-far", expiresAt: expirySec(3 * 3600_000) });

	it("fires at exactly 100% weekly usage (cause weekly-limit)", () => {
		const credit = farCredit();
		expect(
			decide({
				account: weeklyOnly,
				credits: [credit],
				weeklyUsedPercent: 100,
			}),
		).toEqual({
			action: "consume",
			creditId: "c-far",
			expiresAt: credit.expiresAt as number,
			cause: "weekly-limit",
		});
	});

	it("fires above 100% too", () => {
		const credit = farCredit();
		expect(
			decide({
				account: weeklyOnly,
				credits: [credit],
				weeklyUsedPercent: 104.5,
			}),
		).toMatchObject({ action: "consume", cause: "weekly-limit" });
	});

	it("does NOT fire at 99.9%", () => {
		expect(
			decide({
				account: weeklyOnly,
				credits: [farCredit()],
				weeklyUsedPercent: 99.9,
			}),
		).toEqual({ action: "skip", reason: "weekly-not-exhausted" });
	});

	it("does NOT fire on null usage (fail-closed)", () => {
		expect(
			decide({
				account: weeklyOnly,
				credits: [farCredit()],
				weeklyUsedPercent: null,
			}),
		).toEqual({ action: "skip", reason: "weekly-not-exhausted" });
	});

	it("does NOT fire with the weekly toggle off even at 100%", () => {
		// Expiry toggle on (default) but the only credit is far from expiry:
		// the weekly exhaustion alone must not consume it.
		expect(decide({ credits: [farCredit()], weeklyUsedPercent: 100 })).toEqual({
			action: "skip",
			reason: "no-credit-near-expiry",
		});
	});

	it("both toggles off → toggle-disabled", () => {
		expect(
			decide({
				account: {
					codex_auto_apply_reset_credits_enabled: false,
					codex_auto_apply_reset_on_weekly_limit_enabled: false,
				},
				credits: [farCredit()],
				weeklyUsedPercent: 100,
			}),
		).toEqual({ action: "skip", reason: "toggle-disabled" });
	});

	it("cooldown suppresses a weekly fire (last success just under the window)", () => {
		expect(
			decide({
				account: weeklyOnly,
				credits: [farCredit()],
				weeklyUsedPercent: 100,
				autoApplyCooldownAnchorAt:
					NOW - RESET_CREDIT_WEEKLY_LIMIT_COOLDOWN_MS + 1,
			}),
		).toEqual({ action: "skip", reason: "cooldown" });
	});

	it("fires again at exactly the cooldown boundary (elapsed === cooldown)", () => {
		expect(
			decide({
				account: weeklyOnly,
				credits: [farCredit()],
				weeklyUsedPercent: 100,
				autoApplyCooldownAnchorAt: NOW - RESET_CREDIT_WEEKLY_LIMIT_COOLDOWN_MS,
			}),
		).toMatchObject({ action: "consume", cause: "weekly-limit" });
	});

	it("both triggers apply → cause is expiry (credit was about to be lost anyway)", () => {
		const near = makeCredit(); // 5 min out — inside the expiry lead
		expect(
			decide({
				account: { codex_auto_apply_reset_on_weekly_limit_enabled: true },
				credits: [near],
				weeklyUsedPercent: 100,
			}),
		).toEqual({
			action: "consume",
			creditId: near.id,
			expiresAt: near.expiresAt as number,
			cause: "expiry",
		});
	});

	it("weekly-only account never fires the expiry path (near-expiry credit, weekly not exhausted)", () => {
		expect(
			decide({
				account: weeklyOnly,
				credits: [makeCredit()], // inside the expiry lead window
				weeklyUsedPercent: 50,
			}),
		).toEqual({ action: "skip", reason: "weekly-not-exhausted" });
	});

	it("chooses a non-expiring credit when it is the only one available", () => {
		expect(
			decide({
				account: weeklyOnly,
				credits: [makeCredit({ id: "c-forever", expiresAt: null })],
				weeklyUsedPercent: 100,
			}),
		).toEqual({
			action: "consume",
			creditId: "c-forever",
			expiresAt: null,
			cause: "weekly-limit",
		});
	});

	it("prefers the soonest-expiring credit over a non-expiring one", () => {
		const expiring = farCredit();
		expect(
			decide({
				account: weeklyOnly,
				credits: [makeCredit({ id: "c-forever", expiresAt: null }), expiring],
				weeklyUsedPercent: 100,
			}),
		).toEqual({
			action: "consume",
			creditId: "c-far",
			expiresAt: expiring.expiresAt as number,
			cause: "weekly-limit",
		});
	});

	it("skips terminally-resolved ids on the weekly path", () => {
		const expiring = farCredit();
		expect(
			decide({
				account: weeklyOnly,
				credits: [expiring, makeCredit({ id: "c-forever", expiresAt: null })],
				resolved: new Set(["c-far"]),
				weeklyUsedPercent: 100,
			}),
		).toEqual({
			action: "consume",
			creditId: "c-forever",
			expiresAt: null,
			cause: "weekly-limit",
		});
	});

	it("all weekly candidates terminally resolved → already-resolved", () => {
		expect(
			decide({
				account: weeklyOnly,
				credits: [farCredit()],
				resolved: new Set(["c-far"]),
				weeklyUsedPercent: 100,
			}),
		).toEqual({ action: "skip", reason: "already-resolved" });
	});

	it("an already-expired credit is not weekly-eligible", () => {
		expect(
			decide({
				account: weeklyOnly,
				credits: [makeCredit({ expiresAt: expirySec(-60_000) })],
				weeklyUsedPercent: 100,
			}),
		).toEqual({ action: "skip", reason: "no-credit-available" });
	});

	it("no credits at all on the weekly path → no-credit-available", () => {
		expect(
			decide({
				account: weeklyOnly,
				credits: [],
				weeklyUsedPercent: 100,
			}),
		).toEqual({ action: "skip", reason: "no-credit-available" });
	});
});

// ---------------------------------------------------------------------------
// CodexResetCreditApplyScheduler — two-phase tick with injected deps
// ---------------------------------------------------------------------------

interface HarnessOptions {
	/** Accounts returned by listCandidateAccounts. */
	candidates?: Array<{ id: string; name: string }>;
	/** Per-call getAccount implementation (defaults to a stable codex account). */
	getAccount?: (accountId: string) => Promise<Account | null>;
	/**
	 * Credits served by getCachedCredits. Receives the number of FORCE refreshes
	 * seen so far, so a test can change the picture between discovery (0) and
	 * confirmation (1).
	 */
	credits?: (forceRefreshes: number) => CodexRateLimitResetCredit[] | null;
	resolvedIds?: Set<string>;
	/** Weekly used percent served by getWeeklyUsedPercent (default null). */
	weeklyUsedPercent?: number | null;
	/** Cooldown anchor timestamp (ms) served to the weekly cooldown gate. */
	autoApplyCooldownAnchorAt?: number | null;
	claim?: {
		id: string;
		idempotencyKey: string;
		attemptSeq: number;
		reused: boolean;
	} | null;
	dispatchImpl?: (
		accountId: string,
		request: CodexRateLimitResetCreditConsumeRequest,
	) => Promise<CodexResetCreditConsumeDispatchOutcome>;
}

function makeHarness(opts: HarnessOptions = {}) {
	const refreshCalls: Array<{ accountId: string; force: boolean }> = [];
	const claimCalls: Array<Record<string, unknown>> = [];
	const dispatchCalls: Array<{
		accountId: string;
		request: CodexRateLimitResetCreditConsumeRequest;
	}> = [];

	const forceRefreshes = () => refreshCalls.filter((c) => c.force).length;
	const creditsFn = opts.credits ?? (() => [makeCredit()]);

	const deps: CodexResetCreditApplyDeps = {
		listCandidateAccounts: async () =>
			opts.candidates ?? [{ id: "acct-1", name: "codex-account" }],
		getAccount: opts.getAccount ?? (async (id) => makeCodexAccount({ id })),
		getCachedCredits: (): CodexRateLimitResetCreditsCacheEntry | null => {
			const credits = creditsFn(forceRefreshes());
			return {
				summary: {
					availableCount: credits?.length ?? 0,
					credits,
				},
				fetchedAt: NOW,
			};
		},
		refreshCredits: async (accountId, force) => {
			refreshCalls.push({ accountId, force });
		},
		getTerminallyResolvedCreditIds: async () =>
			opts.resolvedIds ?? new Set<string>(),
		getWeeklyUsedPercent: () => opts.weeklyUsedPercent ?? null,
		getAutoApplyCooldownAnchorAt: async () =>
			opts.autoApplyCooldownAnchorAt ?? null,
		claimAutoAttempt: async (input) => {
			claimCalls.push({ ...input });
			if (opts.claim === null) return null;
			return (
				opts.claim ?? {
					id: `${input.accountId}:${input.creditId}:1`,
					idempotencyKey: `codex-reset-auto:${input.accountId}:${input.creditId}:1`,
					attemptSeq: 1,
					reused: false,
				}
			);
		},
		dispatchConsume: async (accountId, request) => {
			dispatchCalls.push({ accountId, request });
			if (opts.dispatchImpl) return opts.dispatchImpl(accountId, request);
			return {
				status: "completed",
				accountName: "codex-account",
				result: { outcome: "reset", windowsReset: 2 },
				resetMetadataRefreshed: true,
				availableResetCount: 0,
				localRateLimitStateCleared: true,
			};
		},
		now: () => NOW,
	};

	const scheduler = new CodexResetCreditApplyScheduler(deps);
	return { scheduler, refreshCalls, claimCalls, dispatchCalls };
}

describe("CodexResetCreditApplyScheduler.tick", () => {
	it("dispatches with the exact claim idempotencyKey, creditId, and autoApply row id", async () => {
		const { scheduler, refreshCalls, claimCalls, dispatchCalls } = makeHarness({
			claim: {
				id: "acct-1:credit-1:3",
				idempotencyKey: "codex-reset-auto:acct-1:credit-1:3",
				attemptSeq: 3,
				reused: false,
			},
		});

		await scheduler.tick();

		// Discovery (non-force) then confirmation (force), in that order.
		expect(refreshCalls).toEqual([
			{ accountId: "acct-1", force: false },
			{ accountId: "acct-1", force: true },
		]);
		expect(claimCalls).toEqual([
			{
				accountId: "acct-1",
				accountName: "codex-account",
				creditId: "credit-1",
				creditExpiresAt: makeCredit().expiresAt,
				cause: "expiry",
				now: NOW,
			},
		]);
		expect(dispatchCalls).toEqual([
			{
				accountId: "acct-1",
				request: {
					idempotencyKey: "codex-reset-auto:acct-1:credit-1:3",
					creditId: "credit-1",
					autoApply: { ledgerRowId: "acct-1:credit-1:3" },
				},
			},
		]);
	});

	it("discovery skip performs NO force refresh, claim, or dispatch", async () => {
		const { scheduler, refreshCalls, claimCalls, dispatchCalls } = makeHarness({
			// Far from expiry → discovery decides "no-credit-near-expiry".
			credits: () => [
				makeCredit({
					expiresAt: expirySec(RESET_CREDIT_AUTO_APPLY_LEAD_MS + 3600_000),
				}),
			],
		});

		await scheduler.tick();

		expect(refreshCalls).toEqual([{ accountId: "acct-1", force: false }]);
		expect(claimCalls).toEqual([]);
		expect(dispatchCalls).toEqual([]);
	});

	it("confirmation aborts when the toggle is flipped off between phases", async () => {
		let reads = 0;
		const { scheduler, refreshCalls, claimCalls, dispatchCalls } = makeHarness({
			getAccount: async (id) => {
				reads++;
				// First read (discovery): enabled. Second read (confirmation): off.
				return makeCodexAccount({
					id,
					codex_auto_apply_reset_credits_enabled: reads === 1,
				});
			},
		});

		await scheduler.tick();

		// Confirmation ran (force refresh happened) but nothing was claimed.
		expect(refreshCalls).toEqual([
			{ accountId: "acct-1", force: false },
			{ accountId: "acct-1", force: true },
		]);
		expect(claimCalls).toEqual([]);
		expect(dispatchCalls).toEqual([]);
	});

	it("confirmation aborts when the credit vanished after the force refresh", async () => {
		const { scheduler, claimCalls, dispatchCalls } = makeHarness({
			// Before any force refresh: one near-expiry credit. After: gone.
			credits: (forceRefreshes) => (forceRefreshes === 0 ? [makeCredit()] : []),
		});

		await scheduler.tick();

		expect(claimCalls).toEqual([]);
		expect(dispatchCalls).toEqual([]);
	});

	it("claim returning null (terminal) suppresses the dispatch", async () => {
		const { scheduler, claimCalls, dispatchCalls } = makeHarness({
			claim: null,
		});

		await scheduler.tick();

		expect(claimCalls).toHaveLength(1);
		expect(dispatchCalls).toEqual([]);
	});

	it("a dispatch throw is contained: tick resolves and the row is left pending", async () => {
		const { scheduler, dispatchCalls } = makeHarness({
			dispatchImpl: async () => {
				throw new Error("transport down");
			},
		});

		// Must not reject — the failure is logged and retried on a later tick.
		await scheduler.tick();

		expect(dispatchCalls).toHaveLength(1);
	});

	it("one bad account does not abort the others", async () => {
		const { scheduler, dispatchCalls } = makeHarness({
			candidates: [
				{ id: "acct-bad", name: "codex-bad" },
				{ id: "acct-good", name: "codex-good" },
			],
			getAccount: async (id) => {
				if (id === "acct-bad") throw new Error("db exploded");
				return makeCodexAccount({ id });
			},
		});

		await scheduler.tick();

		expect(dispatchCalls).toHaveLength(1);
		expect(dispatchCalls[0]?.accountId).toBe("acct-good");
	});

	it("skips an account that disappeared between listing and the fresh read", async () => {
		const { scheduler, claimCalls, dispatchCalls } = makeHarness({
			getAccount: async () => null,
		});

		await scheduler.tick();

		expect(claimCalls).toEqual([]);
		expect(dispatchCalls).toEqual([]);
	});

	it("handles only the FIRST near-expiry credit per account per tick", async () => {
		const first = makeCredit({ id: "c-1", expiresAt: expirySec(2 * 60_000) });
		const second = makeCredit({ id: "c-2", expiresAt: expirySec(8 * 60_000) });
		const { scheduler, dispatchCalls } = makeHarness({
			credits: () => [second, first],
		});

		await scheduler.tick();

		expect(dispatchCalls).toHaveLength(1);
		expect(dispatchCalls[0]?.request.creditId).toBe("c-1");
	});

	it("weekly-only account claims with cause weekly-limit and null creditExpiresAt for a non-expiring credit", async () => {
		const { scheduler, claimCalls, dispatchCalls } = makeHarness({
			getAccount: async (id) =>
				makeCodexAccount({
					id,
					codex_auto_apply_reset_credits_enabled: false,
					codex_auto_apply_reset_on_weekly_limit_enabled: true,
				}),
			credits: () => [makeCredit({ id: "c-forever", expiresAt: null })],
			weeklyUsedPercent: 100,
		});

		await scheduler.tick();

		expect(claimCalls).toEqual([
			{
				accountId: "acct-1",
				accountName: "codex-account",
				creditId: "c-forever",
				creditExpiresAt: null,
				cause: "weekly-limit",
				now: NOW,
			},
		]);
		expect(dispatchCalls).toHaveLength(1);
		expect(dispatchCalls[0]?.request.creditId).toBe("c-forever");
	});

	it("weekly cooldown suppresses the consume at the scheduler level", async () => {
		const { scheduler, claimCalls, dispatchCalls } = makeHarness({
			getAccount: async (id) =>
				makeCodexAccount({
					id,
					codex_auto_apply_reset_credits_enabled: false,
					codex_auto_apply_reset_on_weekly_limit_enabled: true,
				}),
			credits: () => [makeCredit({ id: "c-forever", expiresAt: null })],
			weeklyUsedPercent: 100,
			autoApplyCooldownAnchorAt:
				NOW - RESET_CREDIT_WEEKLY_LIMIT_COOLDOWN_MS + 1,
		});

		await scheduler.tick();

		expect(claimCalls).toEqual([]);
		expect(dispatchCalls).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// nothingToReset resolutions anchor the weekly cooldown (retry-storm guard)
// ---------------------------------------------------------------------------

/**
 * Stateful harness with a fake LEDGER whose claim/resolve/anchor semantics
 * mirror CodexResetCreditEventRepository (including the widened cooldown
 * anchor: nothingToReset anchors, noCredit/failed/pending do not) plus a
 * mutable clock. dispatchConsume always resolves the claimed row to
 * `nothingToReset` — the outcome behind the weekly retry-storm finding.
 */
function makeLedgerHarness(opts: {
	account?: Partial<Account>;
	credits?: CodexRateLimitResetCredit[];
	weeklyUsedPercent?: number | null;
}) {
	let nowMs = NOW;
	interface LedgerRow {
		id: string;
		creditId: string;
		attemptSeq: number;
		status: "pending" | "nothingToReset";
		resolvedAt: number | null;
	}
	const rows: LedgerRow[] = [];
	const dispatchCalls: Array<{ idempotencyKey: string; ledgerRowId: string }> =
		[];
	const credits = opts.credits ?? [makeCredit()];

	const deps: CodexResetCreditApplyDeps = {
		listCandidateAccounts: async () => [
			{ id: "acct-1", name: "codex-account" },
		],
		getAccount: async (id) => makeCodexAccount({ id, ...opts.account }),
		getCachedCredits: () => ({
			summary: { availableCount: credits.length, credits },
			fetchedAt: nowMs,
		}),
		refreshCredits: async () => {},
		// This fake ledger only ever holds pending/nothingToReset rows, and
		// neither status is terminal for automation.
		getTerminallyResolvedCreditIds: async () => new Set<string>(),
		getWeeklyUsedPercent: () => opts.weeklyUsedPercent ?? null,
		// Widened anchor semantics: nothingToReset resolutions anchor too.
		getAutoApplyCooldownAnchorAt: async () => {
			const anchors = rows.flatMap((r) =>
				r.status === "nothingToReset" && r.resolvedAt !== null
					? [r.resolvedAt]
					: [],
			);
			return anchors.length ? Math.max(...anchors) : null;
		},
		claimAutoAttempt: async (input) => {
			const latest = rows
				.filter((r) => r.creditId === input.creditId)
				.sort((a, b) => b.attemptSeq - a.attemptSeq)[0];
			if (latest?.status === "pending") {
				return {
					id: latest.id,
					idempotencyKey: `codex-reset-auto:${latest.id}`,
					attemptSeq: latest.attemptSeq,
					reused: true,
				};
			}
			// nothingToReset (or no row) → mint the next attempt with a NEW key.
			const attemptSeq = (latest?.attemptSeq ?? 0) + 1;
			const id = `${input.accountId}:${input.creditId}:${attemptSeq}`;
			rows.push({
				id,
				creditId: input.creditId,
				attemptSeq,
				status: "pending",
				resolvedAt: null,
			});
			return {
				id,
				idempotencyKey: `codex-reset-auto:${id}`,
				attemptSeq,
				reused: false,
			};
		},
		dispatchConsume: async (_accountId, request) => {
			const ledgerRowId = request.autoApply?.ledgerRowId as string;
			dispatchCalls.push({
				idempotencyKey: request.idempotencyKey,
				ledgerRowId,
			});
			const row = rows.find((r) => r.id === ledgerRowId);
			if (row) {
				row.status = "nothingToReset";
				row.resolvedAt = nowMs;
			}
			return {
				status: "completed",
				accountName: "codex-account",
				result: { outcome: "nothingToReset", windowsReset: 0 },
				resetMetadataRefreshed: true,
				availableResetCount: credits.length,
				localRateLimitStateCleared: false,
			};
		},
		now: () => nowMs,
	};

	return {
		scheduler: new CodexResetCreditApplyScheduler(deps),
		dispatchCalls,
		setNow: (t: number) => {
			nowMs = t;
		},
	};
}

describe("nothingToReset anchors the weekly cooldown (no 60s retry storm)", () => {
	const weeklyOnlyOverrides: Partial<Account> = {
		codex_auto_apply_reset_credits_enabled: false,
		codex_auto_apply_reset_on_weekly_limit_enabled: true,
	};

	it("weekly trigger: nothingToReset suppresses re-fire for the cooldown hour, then fires again", async () => {
		const { scheduler, dispatchCalls, setNow } = makeLedgerHarness({
			account: weeklyOnlyOverrides,
			credits: [makeCredit({ id: "c-forever", expiresAt: null })],
			weeklyUsedPercent: 100,
		});

		// Tick 1: weekly usage stuck at 100% → consume fires, resolves
		// nothingToReset at NOW.
		await scheduler.tick();
		expect(dispatchCalls).toHaveLength(1);
		expect(dispatchCalls[0]?.idempotencyKey).toBe(
			"codex-reset-auto:acct-1:c-forever:1",
		);

		// Tick 2 (next minute, still inside the hour): suppressed — the
		// nothingToReset resolution anchors the cooldown.
		setNow(NOW + 60_000);
		await scheduler.tick();
		expect(dispatchCalls).toHaveLength(1);

		// The suppression surfaces as the "cooldown" skip reason.
		expect(
			decideResetCreditAction({
				account: makeCodexAccount(weeklyOnlyOverrides),
				credits: [makeCredit({ id: "c-forever", expiresAt: null })],
				terminallyResolvedCreditIds: new Set(),
				weeklyUsedPercent: 100,
				autoApplyCooldownAnchorAt: NOW,
				now: NOW + 60_000,
			}),
		).toEqual({ action: "skip", reason: "cooldown" });

		// Tick 3 (past the cooldown): fires again with a NEW attempt/key.
		setNow(NOW + RESET_CREDIT_WEEKLY_LIMIT_COOLDOWN_MS + 60_000);
		await scheduler.tick();
		expect(dispatchCalls).toHaveLength(2);
		expect(dispatchCalls[1]?.idempotencyKey).toBe(
			"codex-reset-auto:acct-1:c-forever:2",
		);
	});

	it("expiry trigger: nothingToReset re-arms on the very next tick — no cooldown suppression", async () => {
		// Default account has ONLY the expiry toggle on; the credit stays inside
		// the 10-min lead window across both ticks.
		const { scheduler, dispatchCalls, setNow } = makeLedgerHarness({});

		await scheduler.tick();
		expect(dispatchCalls).toHaveLength(1);
		expect(dispatchCalls[0]?.idempotencyKey).toBe(
			"codex-reset-auto:acct-1:credit-1:1",
		);

		// Next tick, one minute later — well inside the weekly cooldown window,
		// but the EXPIRY trigger ignores the cooldown entirely.
		setNow(NOW + 60_000);
		await scheduler.tick();
		expect(dispatchCalls).toHaveLength(2);
		expect(dispatchCalls[1]?.idempotencyKey).toBe(
			"codex-reset-auto:acct-1:credit-1:2",
		);
	});
});

// ---------------------------------------------------------------------------
// createCodexResetCreditApplyScheduler — default candidate listing
// ---------------------------------------------------------------------------

describe("createCodexResetCreditApplyScheduler default listCandidateAccounts", () => {
	it("includes codex accounts with EITHER auto-apply toggle on", async () => {
		const accounts: Account[] = [
			makeCodexAccount({ id: "expiry-only", name: "expiry-only" }),
			makeCodexAccount({
				id: "weekly-only",
				name: "weekly-only",
				codex_auto_apply_reset_credits_enabled: false,
				codex_auto_apply_reset_on_weekly_limit_enabled: true,
			}),
			makeCodexAccount({
				id: "both",
				name: "both",
				codex_auto_apply_reset_on_weekly_limit_enabled: true,
			}),
			makeCodexAccount({
				id: "neither",
				name: "neither",
				codex_auto_apply_reset_credits_enabled: false,
			}),
			makeCodexAccount({
				id: "not-codex",
				name: "not-codex",
				provider: "anthropic",
				codex_auto_apply_reset_on_weekly_limit_enabled: true,
			}),
		];
		const evaluatedIds: string[] = [];
		const scheduler = createCodexResetCreditApplyScheduler({
			dbOps: {
				getAllAccounts: async () => accounts,
				// Return null so each candidate stops right after discovery — the
				// point of this test is WHO gets evaluated, not what happens next.
				getAccount: async (id) => {
					evaluatedIds.push(id);
					return null;
				},
				getTerminallyResolvedCodexResetCreditIds: async () => new Set<string>(),
				claimCodexResetCreditAutoAttempt: async () => null,
				getCodexResetCreditAutoApplyCooldownAnchorAt: async () => null,
			},
			coordinator: { refreshResetCredits: async () => undefined },
		});

		await scheduler.tick();

		expect(evaluatedIds.sort()).toEqual(["both", "expiry-only", "weekly-only"]);
	});
});
