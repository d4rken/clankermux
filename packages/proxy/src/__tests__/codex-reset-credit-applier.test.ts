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
import { afterEach, describe, expect, it } from "bun:test";
import { PAUSE_REASON_NEEDS_REAUTH } from "@clankermux/core";
import type { CodexResetCreditEventRow } from "@clankermux/database";
import {
	type CodexRateLimitResetCredit,
	type CodexRateLimitResetCreditsCacheEntry,
	USAGE_CACHE_TTL_MS,
	type UsageData,
	usageCache,
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

/** Weekly-only account: weekly toggle ON, expiry toggle OFF. */
const weeklyOnly: Partial<Account> = {
	codex_auto_apply_reset_credits_enabled: false,
	codex_auto_apply_reset_on_weekly_limit_enabled: true,
};

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

function pendingAttempt(
	overrides: Partial<CodexResetCreditEventRow> = {},
): CodexResetCreditEventRow {
	return {
		id: "acct-1:credit-1:1",
		account_id: "acct-1",
		account_name: "codex-account",
		credit_id: "credit-1",
		trigger: "auto",
		cause: "weekly-limit",
		attempt_seq: 1,
		idempotency_key: "codex-reset-auto:acct-1:credit-1:1",
		status: "pending",
		windows_reset: null,
		error_message: null,
		credit_expires_at: null,
		created_at: NOW - 60_000,
		resolved_at: null,
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

	// A restored weekly window only helps an account the auto-resume guard will
	// un-pause afterwards. Every other pause keeps the account out of routing,
	// so a credit spent on it buys nothing.
	for (const pauseReason of [
		"manual",
		null,
		"failure_threshold",
		"subscription_expired",
		"some-future-reason",
	]) {
		it(`skips a pause that a weekly reset cannot lift (reason ${pauseReason})`, () => {
			expect(
				decide({
					account: { ...weeklyOnly, paused: true, pause_reason: pauseReason },
					credits: [farCredit()],
					weeklyUsedPercent: 100,
				}),
			).toEqual({ action: "skip", reason: "paused" });
		});
	}

	for (const pauseReason of ["overage", null]) {
		it(`fires on an auto-resumable overage pause (reason ${pauseReason})`, () => {
			const credit = farCredit();
			expect(
				decide({
					account: {
						...weeklyOnly,
						paused: true,
						pause_reason: pauseReason,
						auto_pause_on_overage_enabled: true,
					},
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
	}

	// The toggle alone is not enough: the reason has to be one auto-resume
	// clears, or the account stays paused after the reset regardless.
	for (const pauseReason of [
		"manual",
		"failure_threshold",
		"subscription_expired",
	]) {
		it(`skips a ${pauseReason} pause even with auto-resume on`, () => {
			expect(
				decide({
					account: {
						...weeklyOnly,
						paused: true,
						pause_reason: pauseReason,
						auto_pause_on_overage_enabled: true,
					},
					credits: [farCredit()],
					weeklyUsedPercent: 100,
				}),
			).toEqual({ action: "skip", reason: "paused" });
		});
	}

	it("skips an overage pause once auto-resume has been switched off", () => {
		expect(
			decide({
				account: {
					...weeklyOnly,
					paused: true,
					pause_reason: "overage",
					auto_pause_on_overage_enabled: false,
				},
				credits: [farCredit()],
				weeklyUsedPercent: 100,
			}),
		).toEqual({ action: "skip", reason: "paused" });
	});

	it("the pause gate stays out of the expiry trigger", () => {
		const credit = makeCredit();
		expect(
			decide({
				account: {
					codex_auto_apply_reset_credits_enabled: true,
					codex_auto_apply_reset_on_weekly_limit_enabled: true,
					paused: true,
					pause_reason: "failure_threshold",
				},
				credits: [credit],
				weeklyUsedPercent: 100,
			}),
		).toEqual({
			action: "consume",
			creditId: credit.id,
			expiresAt: credit.expiresAt as number,
			cause: "expiry",
		});
	});
});

// ---------------------------------------------------------------------------
// CodexResetCreditApplyScheduler — two-phase tick with injected deps
// ---------------------------------------------------------------------------

interface HarnessOptions {
	getPendingAttempt?: () => Promise<CodexResetCreditEventRow | null>;
	refreshResult?: (force: boolean) => boolean;
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
	hasOtherAvailableCodexAccount?: (accountId: string) => Promise<boolean>;
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
		getPendingAttempt: opts.getPendingAttempt ?? (async () => null),
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
			return opts.refreshResult?.(force) ?? true;
		},
		getTerminallyResolvedCreditIds: async () =>
			opts.resolvedIds ?? new Set<string>(),
		getWeeklyUsedPercent: () => opts.weeklyUsedPercent ?? null,
		hasOtherAvailableCodexAccount:
			opts.hasOtherAvailableCodexAccount ?? (async () => false),
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
	it("recovers the original credit and key after a lost response and scheduler restart", async () => {
		let pending: CodexResetCreditEventRow | null = null;
		const sent: CodexRateLimitResetCreditConsumeRequest[] = [];
		const opts: HarnessOptions = {
			getAccount: async () => makeCodexAccount(weeklyOnly),
			getPendingAttempt: async () => pending,
			weeklyUsedPercent: 100,
			credits: () =>
				pending
					? [makeCredit({ id: "credit-2", expiresAt: null })]
					: [makeCredit({ expiresAt: null })],
			dispatchImpl: async (_id, request) => {
				sent.push(request);
				pending = pendingAttempt();
				return {
					status: "failed",
					message: "Upstream applied reset but response was lost",
				};
			},
		};
		await makeHarness(opts).scheduler.tick();
		const restarted = makeHarness(opts);
		await restarted.scheduler.tick();
		expect(sent.map((r) => r.creditId)).toEqual(["credit-1", "credit-1"]);
		expect(sent[1]?.idempotencyKey).toBe(sent[0]?.idempotencyKey);
		expect(restarted.claimCalls).toHaveLength(0);
	});

	it("reconciles a pending attempt even after usage recovered and the credit expired", async () => {
		const pending = pendingAttempt({ credit_expires_at: expirySec(-60_000) });
		const h = makeHarness({
			getAccount: async () => makeCodexAccount(weeklyOnly),
			getPendingAttempt: async () => pending,
			credits: () => [],
			weeklyUsedPercent: 0,
			hasOtherAvailableCodexAccount: async () => true,
		});
		await h.scheduler.tick();
		expect(h.dispatchCalls[0]?.request.idempotencyKey).toBe(
			pending.idempotency_key,
		);
		expect(h.claimCalls).toHaveLength(0);
	});

	it("leaves an uncertain attempt pending when confirmation fails", async () => {
		const h = makeHarness({
			getPendingAttempt: async () => pendingAttempt(),
			refreshResult: () => false,
		});
		await h.scheduler.tick();
		expect(h.dispatchCalls).toHaveLength(0);
		expect(h.claimCalls).toHaveLength(0);
	});

	it("does not redeem using cached metadata after a failed forced refresh", async () => {
		const h = makeHarness({ refreshResult: (force) => !force });
		await h.scheduler.tick();
		expect(h.refreshCalls.map((r) => r.force)).toEqual([false, true]);
		expect(h.claimCalls).toHaveLength(0);
		expect(h.dispatchCalls).toHaveLength(0);
	});

	for (const pauseReason of [
		"manual",
		null,
		"failure_threshold",
		"subscription_expired",
	]) {
		it(`conserves weekly resets on a paused account with reason ${pauseReason}`, async () => {
			const h = makeHarness({
				getAccount: async () =>
					makeCodexAccount({
						...weeklyOnly,
						paused: true,
						pause_reason: pauseReason,
					}),
				weeklyUsedPercent: 100,
			});
			await h.scheduler.tick();
			expect(h.dispatchCalls).toHaveLength(0);
		});
	}

	it("restores weekly quota for an overage pause that auto-resume will lift", async () => {
		const h = makeHarness({
			getAccount: async () =>
				makeCodexAccount({
					...weeklyOnly,
					paused: true,
					pause_reason: "overage",
					auto_pause_on_overage_enabled: true,
				}),
			weeklyUsedPercent: 100,
		});
		await h.scheduler.tick();
		expect(h.dispatchCalls).toHaveLength(1);
	});

	it("does not retry a pending weekly attempt on an account paused by the failure threshold", async () => {
		const h = makeHarness({
			getAccount: async () =>
				makeCodexAccount({
					...weeklyOnly,
					paused: true,
					pause_reason: "failure_threshold",
				}),
			getPendingAttempt: async () => pendingAttempt(),
			weeklyUsedPercent: 100,
		});
		await h.scheduler.tick();
		expect(h.dispatchCalls).toHaveLength(0);
	});

	it("retries a pending weekly attempt on an auto-resumable overage pause", async () => {
		const h = makeHarness({
			getAccount: async () =>
				makeCodexAccount({
					...weeklyOnly,
					paused: true,
					pause_reason: "overage",
					auto_pause_on_overage_enabled: true,
				}),
			getPendingAttempt: async () => pendingAttempt(),
			weeklyUsedPercent: 100,
		});
		await h.scheduler.tick();
		expect(h.dispatchCalls).toHaveLength(1);
		expect(h.dispatchCalls[0].request.idempotencyKey).toBe(
			"codex-reset-auto:acct-1:credit-1:1",
		);
	});

	it("honors a manual pause applied between discovery and confirmation", async () => {
		let reads = 0;
		const h = makeHarness({
			getAccount: async () =>
				makeCodexAccount({
					...weeklyOnly,
					paused: ++reads > 1,
					pause_reason: "manual",
				}),
			weeklyUsedPercent: 100,
		});
		await h.scheduler.tick();
		expect(h.claimCalls).toHaveLength(0);
	});

	it("does not retry a non-expiring weekly attempt on a manually paused account", async () => {
		const h = makeHarness({
			getAccount: async () =>
				makeCodexAccount({
					...weeklyOnly,
					paused: true,
					pause_reason: "manual",
				}),
			getPendingAttempt: async () => pendingAttempt(),
			weeklyUsedPercent: 100,
		});
		await h.scheduler.tick();
		expect(h.dispatchCalls).toHaveLength(0);
	});

	it("keeps expiry protection active when a manual pause defers an older weekly attempt", async () => {
		const h = makeHarness({
			getAccount: async () =>
				makeCodexAccount({
					paused: true,
					pause_reason: "manual",
					codex_auto_apply_reset_on_weekly_limit_enabled: true,
				}),
			getPendingAttempt: async () =>
				pendingAttempt({ credit_id: "old-non-expiring" }),
		});
		await h.scheduler.tick();
		expect(h.dispatchCalls[0]?.request.creditId).toBe("credit-1");
		expect(h.claimCalls[0]?.cause).toBe("expiry");
	});

	it("does not retry a weekly attempt after its toggle was disabled", async () => {
		const h = makeHarness({
			getPendingAttempt: async () => pendingAttempt(),
			credits: () => [makeCredit({ expiresAt: null })],
		});
		await h.scheduler.tick();
		expect(h.dispatchCalls).toHaveLength(0);
	});

	it("conserves a weekly reset until the other account becomes unavailable", async () => {
		let otherAvailable = true;
		const h = makeHarness({
			getAccount: async () => makeCodexAccount(weeklyOnly),
			weeklyUsedPercent: 100,
			credits: () => [makeCredit({ expiresAt: null })],
			hasOtherAvailableCodexAccount: async () => otherAvailable,
		});
		await h.scheduler.tick();
		expect(h.claimCalls).toHaveLength(0);
		expect(h.dispatchCalls).toHaveLength(0);
		expect(h.refreshCalls).toHaveLength(1);

		otherAvailable = false;
		await h.scheduler.tick();
		expect(h.dispatchCalls).toHaveLength(1);
	});

	it("aborts weekly redemption if another account recovers before confirmation", async () => {
		let poolReads = 0;
		const h = makeHarness({
			getAccount: async () => makeCodexAccount(weeklyOnly),
			weeklyUsedPercent: 100,
			hasOtherAvailableCodexAccount: async () => ++poolReads > 1,
		});
		await h.scheduler.tick();
		expect(poolReads).toBe(2);
		expect(h.claimCalls).toHaveLength(0);
		expect(h.dispatchCalls).toHaveLength(0);
	});

	it("keeps expiry redemption independent of pool availability and pool read failures", async () => {
		const h = makeHarness({
			getAccount: async () =>
				makeCodexAccount({
					paused: true,
					pause_reason: "manual",
					codex_auto_apply_reset_on_weekly_limit_enabled: true,
				}),
			weeklyUsedPercent: 100,
			hasOtherAvailableCodexAccount: async () => {
				throw new Error("Expiry must not read pool availability");
			},
		});
		await h.scheduler.tick();
		expect(h.dispatchCalls).toHaveLength(1);
		expect(h.claimCalls[0]?.cause).toBe("expiry");
	});

	it("conserves weekly resets when the pool availability read fails", async () => {
		const h = makeHarness({
			getAccount: async () => makeCodexAccount(weeklyOnly),
			weeklyUsedPercent: 100,
			hasOtherAvailableCodexAccount: async () => {
				throw new Error("Pool read unavailable");
			},
		});
		await h.scheduler.tick();
		expect(h.claimCalls).toHaveLength(0);
		expect(h.dispatchCalls).toHaveLength(0);
	});

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
		refreshCredits: async () => true,
		getPendingAttempt: async () => null,
		// This fake ledger only ever holds pending/nothingToReset rows, and
		// neither status is terminal for automation.
		getTerminallyResolvedCreditIds: async () => new Set<string>(),
		getWeeklyUsedPercent: () => opts.weeklyUsedPercent ?? null,
		hasOtherAvailableCodexAccount: async () => false,
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
				getActiveApiKeys: async () => [],
				getPendingCodexResetCreditAttempt: async () => null,
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
			coordinator: {
				refreshResetCredits: async () => ({ success: true }),
				readUsageStatus: async () => ({ success: false }),
			},
		});

		await scheduler.tick();

		expect(evaluatedIds.sort()).toEqual(["both", "expiry-only", "weekly-only"]);
	});
});

describe("weekly reset conservation with the production pool check", () => {
	const targetId = "reset-pool-target";
	const otherId = "reset-pool-other";
	const usage = (weekly = 20, session = 10): UsageData => ({
		five_hour: {
			utilization: session,
			resets_at: new Date(NOW + 3600_000).toISOString(),
		},
		seven_day: {
			utilization: weekly,
			resets_at: new Date(NOW + 86_400_000).toISOString(),
		},
	});

	afterEach(() => {
		usageCache.delete(targetId);
		usageCache.delete(otherId);
	});

	function poolHarness(
		accounts: Account[],
		options: {
			pins?: Array<string | null>;
			now?: () => number;
			readUsage?: (id: string) => Promise<{ success: boolean }>;
			refreshCredits?: () => Promise<{ success: boolean }>;
			cooldownAnchor?: (id: string) => Promise<number | null>;
		} = {},
	) {
		const consumed: string[] = [];
		const usageReads: string[] = [];
		const scheduler = createCodexResetCreditApplyScheduler({
			dbOps: {
				getAllAccounts: async () => accounts,
				getActiveApiKeys: async () =>
					(options.pins ?? []).map((pinnedAccountId, index) => ({
						id: `key-${index}`,
						name: `key-${index}`,
						hashedKey: "test",
						prefixLast8: "test",
						createdAt: NOW,
						lastUsed: NOW,
						usageCount: 1,
						isActive: true,
						pinnedAccountId,
						pinnedProviders: null,
					})),
				getPendingCodexResetCreditAttempt: async () => null,
				getAccount: async (id) => accounts.find((a) => a.id === id) ?? null,
				getTerminallyResolvedCodexResetCreditIds: async () => new Set(),
				getCodexResetCreditAutoApplyCooldownAnchorAt:
					options.cooldownAnchor ?? (async () => null),
				claimCodexResetCreditAutoAttempt: async ({ accountId }) => ({
					id: accountId,
					idempotencyKey: accountId,
					attemptSeq: 1,
					reused: false,
				}),
			},
			coordinator: {
				refreshResetCredits:
					options.refreshCredits ?? (async () => ({ success: true })),
				readUsageStatus: async (id) => {
					usageReads.push(id);
					if (options.readUsage) return options.readUsage(id);
					usageCache.set(id, usage());
					return { success: true };
				},
			},
			overrides: {
				now: options.now ?? (() => NOW),
				getCachedCredits: () => ({
					summary: {
						availableCount: 1,
						credits: [makeCredit({ expiresAt: null })],
					},
					fetchedAt: NOW,
				}),
				dispatchConsume: async (accountId) => {
					consumed.push(accountId);
					// Match the coordinator's successful reset cleanup: the next
					// candidate must see the restored account, even before polling.
					const account = accounts.find((a) => a.id === accountId);
					if (account) account.rate_limited_until = null;
					usageCache.delete(accountId);
					return {
						status: "completed",
						accountName: accountId,
						result: { outcome: "reset", windowsReset: 2 },
						resetMetadataRefreshed: true,
						availableResetCount: 0,
						localRateLimitStateCleared: true,
					};
				},
			},
		});
		return { scheduler, consumed, usageReads };
	}

	function twoAccounts(): Account[] {
		usageCache.set(targetId, usage(100));
		return [
			makeCodexAccount({ id: targetId, ...weeklyOnly }),
			makeCodexAccount({
				id: otherId,
				codex_auto_apply_reset_credits_enabled: false,
			}),
		];
	}

	it("does not count an account the target's pinned API key cannot use", async () => {
		const accounts = twoAccounts();
		usageCache.set(otherId, usage());
		const h = poolHarness(accounts, { pins: [targetId, null] });
		await h.scheduler.tick();
		expect(h.consumed).toEqual([targetId]);
	});

	it("a key pinned elsewhere does not disable conservation for the target", async () => {
		const accounts = twoAccounts();
		usageCache.set(otherId, usage());
		const h = poolHarness(accounts, { pins: [otherId, null] });
		await h.scheduler.tick();
		expect(h.consumed).toEqual([]);
	});

	it("forces a free usage read before trusting an alternative with unknown usage", async () => {
		const h = poolHarness(twoAccounts());
		await h.scheduler.tick();
		expect(h.usageReads).toEqual([otherId]);
		expect(h.consumed).toEqual([]);
	});

	it("redeems when refreshing stale usage confirms the alternative is exhausted", async () => {
		const h = poolHarness(twoAccounts(), {
			readUsage: async (id) => {
				usageCache.set(id, usage(100));
				return { success: true };
			},
		});
		await h.scheduler.tick();
		expect(h.usageReads).toEqual([otherId]);
		expect(h.consumed).toEqual([targetId]);
	});

	for (const failure of [
		"failure-result",
		"throw",
		"success-without-data",
	] as const) {
		it(`unknown usage does not block indefinitely after ${failure}`, async () => {
			const h = poolHarness(twoAccounts(), {
				readUsage: async () => {
					if (failure === "throw") throw new Error("Usage unavailable");
					return { success: failure === "success-without-data" };
				},
			});
			await h.scheduler.tick();
			expect(h.usageReads).toEqual([otherId]); // Confirmation does not hammer it again.
			expect(h.consumed).toEqual([targetId]);
		});
	}

	it("rechecks eligibility when the usage read pauses the alternative for reauth", async () => {
		const accounts = twoAccounts();
		const h = poolHarness(accounts, {
			readUsage: async (id) => {
				accounts[1].paused = true;
				accounts[1].pause_reason = PAUSE_REASON_NEEDS_REAUTH;
				usageCache.set(id, usage());
				return { success: true };
			},
		});
		await h.scheduler.tick();
		expect(h.consumed).toEqual([targetId]);
	});

	it("gives a just-restored account one tick for usage to catch up, then retries unknown usage", async () => {
		let now = NOW;
		const h = poolHarness(twoAccounts(), {
			now: () => now,
			readUsage: async () => ({ success: false }),
			cooldownAnchor: async (id) => (id === otherId ? NOW : null),
		});
		await h.scheduler.tick();
		expect(h.consumed).toEqual([]);
		now += 60_000;
		await h.scheduler.tick();
		expect(h.usageReads).toEqual([otherId, otherId]);
		expect(h.consumed).toEqual([targetId]);
	});

	it("preserves the coordinator's failed confirmation result despite cached credits", async () => {
		const h = poolHarness(twoAccounts().slice(0, 1), {
			refreshCredits: async () => ({ success: false }),
		});
		await h.scheduler.tick();
		expect(h.consumed).toEqual([]);
	});

	const cases: Array<{
		label: string;
		other?: Partial<Account>;
		usage?: UsageData;
		ageMs?: number;
		consume: boolean;
	}> = [
		{
			label: "another account has quota with reset automation disabled",
			usage: usage(),
			consume: false,
		},
		{ label: "another account has unknown usage", consume: false },
		{
			label: "another account has stale exhausted usage",
			usage: usage(100),
			ageMs: USAGE_CACHE_TTL_MS + 1,
			consume: false,
		},
		{
			label: "the other account's exhausted window has elapsed",
			usage: {
				...usage(100),
				seven_day: {
					utilization: 100,
					resets_at: new Date(NOW - 1).toISOString(),
				},
			},
			consume: false,
		},
		{
			label: "the other account is paused",
			other: { paused: true, pause_reason: "manual" },
			usage: usage(),
			consume: true,
		},
		{
			label: "the other account is rate limited",
			other: { rate_limited_until: NOW + 60_000 },
			usage: usage(),
			consume: true,
		},
		{
			label: "the other account needs reauthentication",
			other: { pause_reason: PAUSE_REASON_NEEDS_REAUTH },
			usage: usage(),
			consume: true,
		},
		{
			label: "the other account has no credentials",
			other: { refresh_token: null, access_token: null },
			usage: usage(),
			consume: true,
		},
		{
			label: "the other account has only an expired access token",
			other: { refresh_token: null, expires_at: NOW - 1 },
			usage: usage(),
			consume: true,
		},
		{
			label: "the other account can refresh its expired access token",
			other: { expires_at: NOW - 1 },
			usage: usage(),
			consume: false,
		},
		{
			label: "only a different provider has quota",
			other: { provider: "anthropic" },
			usage: usage(),
			consume: true,
		},
		{
			label: "the other account's weekly quota is exhausted",
			usage: usage(100),
			consume: true,
		},
		{
			label: "the other account's five-hour quota is exhausted",
			usage: usage(20, 100),
			consume: true,
		},
	];
	for (const c of cases) {
		it(`${c.consume ? "redeems" : "conserves"} when ${c.label}`, async () => {
			const target = makeCodexAccount({ id: targetId, ...weeklyOnly });
			const other = makeCodexAccount({
				id: otherId,
				codex_auto_apply_reset_credits_enabled: false,
				...c.other,
			});
			usageCache.set(targetId, usage(100));
			if (c.usage)
				usageCache.setWithAgeForTests(otherId, c.usage, c.ageMs ?? 0);
			const h = poolHarness([target, other]);
			await h.scheduler.tick();
			expect(h.consumed).toEqual(c.consume ? [targetId] : []);
		});
	}

	it("redeems in a single-account pool", async () => {
		usageCache.set(targetId, usage(100));
		const h = poolHarness([makeCodexAccount({ id: targetId, ...weeklyOnly })]);
		await h.scheduler.tick();
		expect(h.consumed).toEqual([targetId]);
	});

	it("restores one exhausted account and conserves the other account's reset", async () => {
		const accounts = [targetId, otherId].map((id) => {
			usageCache.set(id, usage(100));
			return makeCodexAccount({
				id,
				...weeklyOnly,
				rate_limited_until: NOW + 60_000,
			});
		});
		const h = poolHarness(accounts);
		await h.scheduler.tick();
		expect(h.consumed).toEqual([targetId]);
		await h.scheduler.tick();
		expect(h.consumed).toEqual([targetId]);
	});
});
