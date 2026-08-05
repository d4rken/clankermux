/**
 * Unit tests for the per-request recovery-hold factory (`recovery-holds.ts`).
 *
 * These exercise the factory DIRECTLY — the state contract it now owns, which
 * `handleProxy` previously kept as enclosing `let`s:
 *
 *  - the burst give-up bookkeeping (written on give-up, NOT on the open-breaker
 *    skip, and surviving a client abort that lands after the write);
 *  - `noteBurstAttempt`, the one external bookkeeping writer;
 *  - the suppression-sink SPLIT: a hold-wake probe suppression must never reach
 *    the public `overloadSuppressedAttempts` array (it would falsely trip the
 *    suppressed-only 529 terminal), while `noteOverloadSuppression` — the only
 *    public appender — does;
 *  - `burstHeldId` as a CONSTRUCTION-TIME snapshot.
 *
 * `attemptThroughProbeGate` is injected, so every upstream attempt inside the
 * holds is stubbed at handleProxy's own chokepoint — no fetch, no provider
 * registry.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { createAdmissionGates } from "../admission-gates";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext, RequestBodyContext } from "../handlers";
import {
	clearAnthropicBurstThrottle,
	resetHoldSlots,
} from "../handlers/burst-cooldown";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
} from "../provider-overload-cooldown";
import {
	createRecoveryHolds,
	type RecoveryHolds,
	type RecoveryHoldsDeps,
} from "../recovery-holds";

const MODEL = "claude-sonnet-4-5";

/** Unique per test so no singleton state leaks between cases. */
let idCounter = 0;
function uniqueId(prefix: string): string {
	idCounter++;
	return `${prefix}-${idCounter}`;
}

/**
 * Deterministic burst-hold timing: the forward-dated clock makes any cooldown
 * read as already elapsed, jitter is zeroed and the budget capped, so a hold
 * runs its probes with no wall-clock sleep.
 */
const HOLD_TIMING_OVERRIDE = {
	now: () => Date.now() + 10 * 60 * 1000,
	jitterMs: 0,
	maxHoldMs: 2_000,
};

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account",
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
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

function makeMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: uniqueId("req"),
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		...overrides,
	} as RequestMeta;
}

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => {
				const now = Date.now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= now),
				);
			},
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(
				async (id: string) => accounts.find((a) => a.id === id) ?? null,
			),
			getActiveComboForFamily: mock(async () => null),
			getApiKeyPin: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => false,
		} as never,
		provider: { name: "anthropic" } as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(async () => {}) } as never,
		requestRecorder: { recordSynthetic: mock(() => {}) } as never,
	} as unknown as ProxyContext;
}

/** Outcome of one injected probe-gate call, keyed by the account attempted. */
type GateStub = (account: Account) => {
	response: Response | null;
	suppressed: boolean;
};

interface Harness {
	holds: RecoveryHolds;
	requestMeta: RequestMeta;
	controller: AbortController;
	/** Accounts handed to the injected probe gate, in order. */
	gated: string[];
}

function makeHolds(
	accounts: Account[],
	gateStub: GateStub,
	metaOverrides: Partial<RequestMeta> = {},
): Harness {
	const controller = new AbortController();
	const requestMeta = makeMeta(metaOverrides);
	const gated: string[] = [];
	const ctx = makeContext(accounts);
	const gates = createAdmissionGates({
		requestMeta,
		initialComboInfo: null,
		effectiveRequestModel: MODEL,
		gateTokenEstimate: 100,
		isSyntheticProbeRequest: false,
		config: ctx.config,
	});

	const deps: RecoveryHoldsDeps = {
		req: new Request("https://proxy.local/v1/messages", {
			method: "POST",
			signal: controller.signal,
		}),
		url: new URL("https://proxy.local/v1/messages"),
		ctx,
		apiKeyId: null,
		apiKeyName: null,
		requestMeta,
		requestBodyContext: {} as unknown as RequestBodyContext,
		finalBodyBuffer: null,
		finalCreateBodyStream: () => undefined,
		effectiveRequestModel: MODEL,
		gates,
		bumpIdleTimeout: () => {},
		burstHoldTimingOverride: HOLD_TIMING_OVERRIDE,
		logFinalOrderOnce: () => {},
		attemptThroughProbeGate: async (account) => {
			gated.push(account.id);
			return gateStub(account);
		},
	};

	return { holds: createRecoveryHolds(deps), requestMeta, controller, gated };
}

/** Every upstream attempt fails over (null) — the "still throttled" shape. */
const alwaysThrottled: GateStub = () => ({ response: null, suppressed: false });
/** Every upstream attempt is refused by the single-flight recovery-probe gate. */
const alwaysSuppressed: GateStub = () => ({ response: null, suppressed: true });

function resetSingletons(): void {
	cacheBodyStore.setEnabled(false);
	clearProviderOverloadCooldown();
	clearAnthropicBurstThrottle();
	resetHoldSlots();
	resetOverloadHoldSlots();
	resetRateLimitProbeGatesForTests();
}

describe("createRecoveryHolds", () => {
	beforeEach(() => {
		resetSingletons();
	});

	afterEach(() => {
		resetSingletons();
	});

	describe("burst give-up bookkeeping", () => {
		it("sets all three fields when the hold gives up", async () => {
			const held = makeAccount({ id: uniqueId("held"), name: "Cache" });
			const { holds } = makeHolds([held], alwaysThrottled);

			expect(holds.burstAttemptedAccountId).toBeNull();
			expect(holds.burstHoldDeclined).toBe(false);
			expect(holds.burstHeldAccountForGiveUp).toBeNull();

			const outcome = await holds.runBurstHold(held, "stale_should_retry");

			expect(outcome).toEqual({ kind: "gave-up" });
			expect(holds.burstHoldDeclined).toBe(true);
			expect(holds.burstHeldAccountForGiveUp).toBe(held);
			expect(holds.burstAttemptedAccountId).toBe(held.id);
		});

		it("sets NONE of them when an open breaker skips the hold", async () => {
			const held = makeAccount({ id: uniqueId("held"), name: "Cache" });
			applyProviderOverloadCooldown("anthropic", Date.now() + 60_000, MODEL);
			const { holds, gated } = makeHolds([held], alwaysThrottled);

			const outcome = await holds.runBurstHold(held, "fresh_headroom");

			// Same "gave-up" verdict, but nothing was attempted …
			expect(outcome).toEqual({ kind: "gave-up" });
			expect(gated).toEqual([]);
			// … so the give-up bookkeeping must stay untouched: it is what drives the
			// constructed burst-retry 429, and no burst attempt ever happened.
			expect(holds.burstHoldDeclined).toBe(false);
			expect(holds.burstHeldAccountForGiveUp).toBeNull();
			expect(holds.burstAttemptedAccountId).toBeNull();
		});

		it("keeps the fields set when the client aborts after the give-up write", async () => {
			const held = makeAccount({ id: uniqueId("held"), name: "Cache" });
			let harness: Harness | null = null;
			// Abort mid-hold, from inside the probe: the give-up write happens BEFORE
			// runBurstHold's client-abort check, so both must be observable.
			harness = makeHolds([held], () => {
				harness?.controller.abort();
				return { response: null, suppressed: false };
			});
			const { holds } = harness;

			const outcome = await holds.runBurstHold(held, "stale_should_retry");

			expect(outcome).toEqual({ kind: "aborted" });
			expect(holds.burstHoldDeclined).toBe(true);
			expect(holds.burstHeldAccountForGiveUp).toBe(held);
			expect(holds.burstAttemptedAccountId).toBe(held.id);
		});

		it("records the attempted account id through noteBurstAttempt", () => {
			const held = makeAccount({ id: uniqueId("held") });
			const { holds } = makeHolds([held], alwaysThrottled);

			expect(holds.burstAttemptedAccountId).toBeNull();
			holds.noteBurstAttempt(held.id);

			// The external writer sets ONLY the attempted id — it is a double-attempt
			// guard, not a give-up.
			expect(holds.burstAttemptedAccountId).toBe(held.id);
			expect(holds.burstHoldDeclined).toBe(false);
			expect(holds.burstHeldAccountForGiveUp).toBeNull();
		});
	});

	describe("overload-suppression sink split", () => {
		it("keeps hold-wake probe suppressions OUT of overloadSuppressedAttempts, and appends only via noteOverloadSuppression", async () => {
			// One eligible account on a very short cooldown, so the hold's first pass
			// has a deadline to wait out and then re-attempts it. The injected gate
			// suppresses that attempt — a hold-wake suppression.
			const account = makeAccount({
				id: uniqueId("sib"),
				name: "Sibling",
				rate_limited_until: Date.now() + 20,
			});
			usageCache.delete(account.id);
			const { holds, gated } = makeHolds([account], alwaysSuppressed);

			const held = await holds.holdForNonCodexRecovery(1_000, "Test hold");

			// The hold ran and its wake attempt WAS suppressed …
			expect(held).toBeNull();
			expect(gated).toContain(account.id);
			// … yet nothing reached the public sink. A hold-wake suppression that
			// leaked into it would falsely trip the suppressed-only 529 terminal.
			expect(holds.overloadSuppressedAttempts).toHaveLength(0);

			// The ONE public appender does append, with the outcome's own deadline.
			const until = Date.now() + 5_000;
			holds.noteOverloadSuppression(account, {
				kind: "overload_suppressed",
				until,
			});
			expect(holds.overloadSuppressedAttempts).toHaveLength(1);
			expect(holds.overloadSuppressedAttempts[0]).toEqual({ account, until });
		});

		it("ignores non-suppression outcomes", () => {
			const account = makeAccount({ id: uniqueId("sib") });
			const { holds } = makeHolds([account], alwaysThrottled);

			holds.noteOverloadSuppression(account, { kind: "overload_529" });
			holds.noteOverloadSuppression(account, { kind: "network_error" });

			expect(holds.overloadSuppressedAttempts).toHaveLength(0);
		});
	});

	describe("burstHeldId", () => {
		it("mirrors routing.heldAccountId, and is null for a Codex-CLI request", () => {
			const account = makeAccount({ id: uniqueId("held") });
			const routing = {
				strategy: "session",
				decision: "affinity_hold",
				heldAccountId: account.id,
			} as unknown as RequestMeta["routing"];

			const mirrored = makeHolds([account], alwaysThrottled, { routing });
			expect(mirrored.holds.burstHeldId).toBe(account.id);

			// excludeOfficialAnthropic ⇒ the burst hold (OAuth-Anthropic only) must be
			// disabled outright, or it could serve a Claude account that selection
			// deliberately excluded.
			const excluded = makeHolds([account], alwaysThrottled, {
				routing,
				excludeOfficialAnthropic: true,
			});
			expect(excluded.holds.burstHeldId).toBeNull();
		});

		it("is a CONSTRUCTION-TIME snapshot, not a live read", () => {
			const account = makeAccount({ id: uniqueId("held") });
			const { holds, requestMeta } = makeHolds([account], alwaysThrottled, {
				routing: {
					strategy: "session",
					decision: "affinity_hold",
					heldAccountId: account.id,
				} as unknown as RequestMeta["routing"],
			});
			expect(holds.burstHeldId).toBe(account.id);

			// A hold wake re-runs selection, which rewrites routing metadata — the
			// held id the request entered with must NOT move underneath it.
			if (requestMeta.routing) {
				requestMeta.routing.heldAccountId = "someone-else";
			}
			requestMeta.excludeOfficialAnthropic = true;

			expect(holds.burstHeldId).toBe(account.id);
		});
	});
});
