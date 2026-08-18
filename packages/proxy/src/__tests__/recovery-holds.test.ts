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
import { logBus } from "@clankermux/logger";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { createAdmissionGates } from "../admission-gates";
import { cacheBodyStore } from "../cache-body-store";
import {
	type ProxyContext,
	type RequestBodyContext,
	setComboSlotInfo,
} from "../handlers";
import {
	clearAnthropicBurstThrottle,
	resetHoldSlots,
} from "../handlers/burst-cooldown";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import {
	resetOverloadHoldSlots,
	setOverloadHoldBudgetOverrideForTests,
} from "../overload-hold";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	completeProviderOverloadProbe,
	type OverloadProbeToken,
	tryAcquireProviderOverloadProbe,
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

/**
 * `now` is the clock the strategy stub reads. It defaults to the wall clock;
 * a test driving a hold through {@link fakeHoldClock} passes that clock's
 * `now`, so re-selection inside the hold sees exactly the time the hold does
 * (every selection path funnels through `ctx.strategy.select`).
 */
function makeContext(
	accounts: Account[],
	now: () => number = Date.now,
): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => {
				const nowMs = now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= nowMs),
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

/** All three fields required, so a test can read the clock it installed. */
interface HoldClock {
	now: () => number;
	jitterMs: number;
	sleep: (ms: number, signal: AbortSignal) => Promise<boolean>;
}

/**
 * Fake clock for the non-Codex hold's deterministic-timing seam: `sleep`
 * advances `now` synchronously instead of waiting, and jitter is zeroed. The
 * hold's budget, its cooldown reads and its waits are then decided entirely by
 * the test — a preempted CI worker can no longer let a candidate's cooldown
 * window lapse before the hold's first deadline read. Every cooldown a test
 * sets for such a hold must be expressed against THIS clock, never Date.now().
 */
function fakeHoldClock(): HoldClock {
	let now = Date.now();
	return {
		now: () => now,
		jitterMs: 0,
		sleep: async (ms: number, signal: AbortSignal) => {
			if (signal.aborted) return false;
			now += Math.max(0, ms);
			return true;
		},
	};
}

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
	holdClock?: HoldClock,
): Harness {
	const controller = new AbortController();
	const requestMeta = makeMeta(metaOverrides);
	const gated: string[] = [];
	const ctx = makeContext(accounts, holdClock?.now);
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
		...(holdClock ? { nonCodexHoldTimingOverride: holdClock } : {}),
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
	setOverloadHoldBudgetOverrideForTests(null);
}

const HAIKU = "claude-haiku-4-5";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Trip a bucket and let it lapse into half-open. The wait is REAL: the breaker
 * runs on the wall clock throughout (and `applyProviderOverloadCooldown`
 * replaces an already-past deadline with a fresh 60s one), so a fake clock
 * cannot move a bucket into half-open. It is not a race either way — this runs
 * before a hold's clock is created, and over-sleeping only lapses the deadline
 * further.
 */
async function tripToHalfOpen(model?: string): Promise<void> {
	applyProviderOverloadCooldown("anthropic", Date.now() + 5, model ?? null);
	await sleep(15);
}

/** Take the half-open bucket's single-flight probe as an external holder. */
function leaseProbeExternally(model?: string): OverloadProbeToken {
	const admission = tryAcquireProviderOverloadProbe("anthropic", model ?? null);
	if (!admission.admitted || !admission.token) {
		throw new Error("expected an admitted probe with a token");
	}
	return admission.token;
}

/**
 * How far ahead of a hold's fake clock {@link cooledCandidate} parks a
 * candidate: the hold has a deadline to wait out, sleeps it away instantly and
 * then re-attempts. Any positive value works — nothing here is wall-clock.
 */
const COOLDOWN_MS = 500;

/**
 * A candidate for the non-Codex hold: cooled until `until`, so the hold has a
 * deadline to wait out and then re-attempts it. `until` MUST come from the
 * test's {@link fakeHoldClock}, never from `Date.now()` — an absolute
 * wall-clock window can lapse before the hold's first deadline read whenever
 * CI preempts the worker, and the hold then exits without attempting anything.
 * `target` gives the account a model mapping that sends THIS request's model
 * somewhere else.
 */
function cooledCandidate(id: string, until: number, target?: string): Account {
	return makeAccount({
		id,
		name: id,
		...(target ? { model_mappings: JSON.stringify({ [MODEL]: target }) } : {}),
		rate_limited_until: until,
	});
}

/** Collect INFO log lines emitted while `run` executes. */
async function captureInfoLines<T>(
	run: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
	const lines: string[] = [];
	const listener = (event: { level: string; msg: string }): void => {
		if (event.level === "INFO") lines.push(event.msg);
	};
	logBus.on("log", listener);
	try {
		return { result: await run(), lines };
	} finally {
		logBus.off("log", listener);
	}
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

	describe("overload-suppressed candidates are skipped before the attempt", () => {
		it("skips a candidate whose bucket has an in-flight probe, entering NO attempt", async () => {
			// Everything an attempt costs — the ~0.5–1.5MB staged body copy, the
			// token validate/refresh, the body transform + parse — happens INSIDE
			// proxyWithAccount, which is only reachable through the injected probe
			// gate. An empty `gated` is therefore the observable "nothing was paid".
			await tripToHalfOpen(MODEL);
			const token = leaseProbeExternally(MODEL);
			const clock = fakeHoldClock();
			const account = cooledCandidate(
				uniqueId("sib"),
				clock.now() + COOLDOWN_MS,
			);
			usageCache.delete(account.id);
			const { holds, gated } = makeHolds([account], alwaysThrottled, {}, clock);

			const held = await holds.holdForNonCodexRecovery(3_000, "Test hold");

			expect(held).toBeNull();
			expect(gated).toEqual([]);
			completeProviderOverloadProbe(token, "abandoned");
		});

		it("does NOT suppress an account whose mapped model belongs to a different, healthy family", async () => {
			// The account maps this Sonnet request to Haiku, so the Sonnet bucket's
			// in-flight probe says nothing about it. Inspecting the request's
			// LOGICAL model would sideline a perfectly healthy account for the whole
			// hold budget.
			await tripToHalfOpen(MODEL);
			const token = leaseProbeExternally(MODEL);
			const clock = fakeHoldClock();
			const account = cooledCandidate(
				uniqueId("mapped"),
				clock.now() + COOLDOWN_MS,
				HAIKU,
			);
			usageCache.delete(account.id);
			const { holds, gated } = makeHolds([account], alwaysThrottled, {}, clock);

			await holds.holdForNonCodexRecovery(3_000, "Test hold");

			expect(gated).toEqual([account.id]);
			completeProviderOverloadProbe(token, "abandoned");
		});

		it("re-inspects per candidate, so a probe completing mid-round is not a stale skip", async () => {
			// A sticky per-sweep outcome set would carry the FIRST candidate's
			// "probe-active" verdict onto the third one, which by then is probeable
			// again.
			await tripToHalfOpen(HAIKU);
			const token = leaseProbeExternally(HAIKU);
			const clock = fakeHoldClock();
			const cooledUntil = clock.now() + COOLDOWN_MS;
			const first = cooledCandidate(uniqueId("haiku-a"), cooledUntil, HAIKU);
			const middle = cooledCandidate(uniqueId("sonnet"), cooledUntil);
			const last = cooledCandidate(uniqueId("haiku-b"), cooledUntil, HAIKU);
			for (const a of [first, middle, last]) usageCache.delete(a.id);

			const { holds, gated } = makeHolds(
				[first, middle, last],
				(account: Account) => {
					// The middle candidate's attempt is where the in-flight Haiku probe
					// reports back.
					if (account.id === middle.id) {
						completeProviderOverloadProbe(token, "recovered");
					}
					return { response: null, suppressed: false };
				},
				{},
				clock,
			);

			await holds.holdForNonCodexRecovery(3_000, "Test hold");

			// First round: `first` was skipped (probe in flight) while `last` was
			// attempted — the same bucket had recovered by the time IT was
			// inspected. (A later poll re-attempts `first` too, which is exactly the
			// point: the skip was never sticky.)
			expect(gated.slice(0, 2)).toEqual([middle.id, last.id]);
		});

		it("does not collapse a different family under a half-open provider-wide bucket", async () => {
			// getOverloadHoldSlotKey would map BOTH accounts to the provider-wide
			// key. A dedup keyed on it would suppress the Sonnet account off the
			// Haiku account's verdict, although its own buckets are probeable.
			// The Haiku family bucket is half-open WITH a probe in flight …
			await tripToHalfOpen(HAIKU);
			const token = leaseProbeExternally(HAIKU);
			// … and a provider-wide bucket then lingers half-open with NO probe of
			// its own, which is what collapses both accounts onto one slot key.
			await tripToHalfOpen();
			const clock = fakeHoldClock();
			const cooledUntil = clock.now() + COOLDOWN_MS;
			const haikuAccount = cooledCandidate(
				uniqueId("haiku"),
				cooledUntil,
				HAIKU,
			);
			const sonnetAccount = cooledCandidate(uniqueId("sonnet"), cooledUntil);
			for (const a of [haikuAccount, sonnetAccount]) usageCache.delete(a.id);

			const { holds, gated } = makeHolds(
				[haikuAccount, sonnetAccount],
				alwaysThrottled,
				{},
				clock,
			);

			await holds.holdForNonCodexRecovery(3_000, "Test hold");

			expect(gated).toEqual([sonnetAccount.id]);
			completeProviderOverloadProbe(token, "abandoned");
		});

		it("attempts a candidate whose combo slot override changed after the gates were built", async () => {
			// The gates' combo snapshot is DELIBERATELY frozen at construction, while
			// the attempt resolves the slot override fresh — a hold wake re-runs
			// selection, which re-populates the slot info. Inspecting the frozen
			// snapshot would read the Sonnet bucket (half-open, probe in flight) and
			// suppress this account on every ~1.5s round for the whole hold budget,
			// although the attempt sends Haiku, whose bucket is healthy.
			await tripToHalfOpen(MODEL);
			const token = leaseProbeExternally(MODEL);
			const clock = fakeHoldClock();
			const account = cooledCandidate(
				uniqueId("combo"),
				clock.now() + COOLDOWN_MS,
			);
			usageCache.delete(account.id);
			const { holds, requestMeta, gated } = makeHolds(
				[account],
				alwaysThrottled,
				{ comboName: "combo-a" },
				clock,
			);
			// What the wake's re-selection would write: the slot now points at Haiku,
			// which the construction-time snapshot never saw.
			setComboSlotInfo(requestMeta, {
				comboName: "combo-a",
				slots: [{ accountId: account.id, modelOverride: HAIKU }],
			});

			await holds.holdForNonCodexRecovery(3_000, "Test hold");

			expect(gated).toEqual([account.id]);
			completeProviderOverloadProbe(token, "abandoned");
		});

		it("emits exactly one INFO hold-exit summary per overload hold", async () => {
			// Short budget: one round, then the poll interval exceeds what is left.
			setOverloadHoldBudgetOverrideForTests(300);
			const account = makeAccount({ id: uniqueId("sib"), name: "Sibling" });
			usageCache.delete(account.id);
			await tripToHalfOpen(MODEL);
			const token = leaseProbeExternally(MODEL);
			const { holds } = makeHolds([account], alwaysThrottled);

			const { result, lines } = await captureInfoLines(() =>
				holds.holdForOverloadRecovery([
					{ account, until: Date.now() + 60_000 },
				]),
			);

			expect(result).toBeNull();
			const summaries = lines.filter((l) =>
				l.startsWith("Overload hold exited"),
			);
			expect(summaries).toHaveLength(1);
			expect(summaries[0]).toContain("1 round");
			expect(summaries[0]).toContain("1 suppressed");
			completeProviderOverloadProbe(token, "abandoned");
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
