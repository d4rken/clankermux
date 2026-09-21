import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../proxy-types";
import {
	applyRateLimitCooldown,
	completeRateLimitProbe,
	getRateLimitProbeAdmission,
	markCapacityRestoredProbePending,
	type RateLimitProbeLease,
	resetRateLimitProbeGatesForTests,
} from "../rate-limit-cooldown";

const NOW = Date.UTC(2026, 6, 9, 3, 0, 0);
const realDateNow = Date.now;

/**
 * Take the lease, asserting the account was admitted. Completion is
 * ownership-checked, so settling a probe means handing back the very token its
 * admission returned.
 */
function admit(account: Account): RateLimitProbeLease {
	const admission = getRateLimitProbeAdmission(account);
	if (admission.decision !== "admitted")
		throw new Error(`expected admitted, got ${admission.decision}`);
	return admission.lease;
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "mature-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: NOW + 3_600_000,
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
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		custom_endpoint: null,
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
	// Lever B (server-directed reset) path uses the deadline-only setter; the
	// escalating no-reset path uses markAccountRateLimited. Provide both so the
	// probe-release chokepoint is exercised regardless of which cooldown path runs.
	const markAccountRateLimited = mock(
		(_id: string, _until: number, _reason: string) => Promise.resolve(9),
	);
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

afterEach(() => {
	Date.now = realDateNow;
	resetRateLimitProbeGatesForTests();
});

describe("mature cooldown re-entry / single-flight probe", () => {
	it("does not gate ordinary accounts (below the mature streak threshold)", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 4,
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account).decision).toBe("not_required");
	});

	it("does not gate accounts still within an active cooldown window", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW + 60_000,
		});

		expect(getRateLimitProbeAdmission(account).decision).toBe("not_required");
	});

	it("does not gate mature accounts with no cooldown deadline set", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: null,
		});

		expect(getRateLimitProbeAdmission(account).decision).toBe("not_required");
	});

	it("treats the exact cooldown boundary as expired", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW,
		});

		expect(getRateLimitProbeAdmission(account).decision).toBe("admitted");
	});

	it("admits only one concurrent probe for a mature expired cooldown", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account).decision).toBe("admitted");
		// A second concurrent request selecting the same account is suppressed
		// and must fall through to the next account instead of stampeding it.
		expect(getRateLimitProbeAdmission(account).decision).toBe("suppressed");
		expect(getRateLimitProbeAdmission(account).decision).toBe("suppressed");
	});

	it("releases the probe lease when the probe succeeds", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});

		completeRateLimitProbe(account, "recovered", admit(account));
		expect(getRateLimitProbeAdmission(account).decision).toBe("admitted");
	});

	it("releases the probe lease when cooldown is reapplied via a fresh 429 (Lever B reset)", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		const { ctx } = makeCtx();

		const probeLease = admit(account);
		// Server-directed reset in the future -> Lever B path applies a fresh
		// cooldown; the probe lease must be released as part of that.
		//
		// The cooldown is deliberately SHORTER than the 2-minute lease: at expiry
		// the lease would still be live, so only a real release can admit here.
		applyRateLimitCooldown(account, { resetTime: NOW + 30_000 }, ctx, {
			probeLease,
		});
		Date.now = () => NOW + 30_001;

		expect(getRateLimitProbeAdmission(account).decision).toBe("admitted");
	});

	it("releases the probe lease when cooldown is reapplied via a no-reset 429 (escalating path)", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		const { ctx } = makeCtx();

		// Waiting this cooldown out could not tell an explicit release apart from
		// the lease lapsing: the escalating backoff is its 300s ceiling at EVERY
		// mature streak (30/60/120/240/300s on the 1..n ramp, and the gate needs
		// n >= 5), which always outlives the 2-minute lease. A capacity marker
		// gates the account independently of its deadline, so the assertion can
		// run at once, with the lease still fully live and the escalating path
		// still the thing under test.
		markCapacityRestoredProbePending(account.id);
		const probeLease = admit(account);

		// No reset time -> escalating no-reset path; still a fresh cooldown that
		// must release the probe lease.
		applyRateLimitCooldown(account, {}, ctx, { probeLease });
		expect(account.rate_limited_until).toBe(NOW + 300_000);

		// `cooldown_reapplied` retains the marker, so the account is still gated —
		// an unreleased lease would read "suppressed" here.
		expect(getRateLimitProbeAdmission(account).decision).toBe("admitted");
	});

	it("does not release the lease on a reprobe 429 (gentle in-request retry)", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		const { ctx } = makeCtx();

		expect(getRateLimitProbeAdmission(account).decision).toBe("admitted");
		// A reprobe is a bounded within-request retry of a held account and is
		// NOT a terminal outcome — it must not release the cross-request probe
		// lease. With no reset time the reprobe leaves in-memory cooldown state
		// untouched (still expired), so a concurrent request must still be
		// suppressed by the held lease rather than admitted.
		applyRateLimitCooldown(account, {}, ctx, { reprobe: true });
		expect(getRateLimitProbeAdmission(account).decision).toBe("suppressed");
	});

	it("releases an abandoned probe immediately", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});

		completeRateLimitProbe(account, "abandoned", admit(account));
		expect(getRateLimitProbeAdmission(account).decision).toBe("admitted");
	});

	it("self-heals a leaked probe after the bounded lease window expires", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account).decision).toBe("admitted");
		// Never completed, simulating a crash or unhandled path. Self-heals once
		// the lease window elapses.
		Date.now = () => NOW + 120_001;
		expect(getRateLimitProbeAdmission(account).decision).toBe("admitted");
	});

	it("evicts the oldest lease once the in-memory map hits the cap", () => {
		Date.now = () => NOW;
		const first = makeAccount({
			id: "acc-evict-me",
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		expect(getRateLimitProbeAdmission(first).decision).toBe("admitted");

		// Fill the map with distinct accounts up to the eviction cap so the
		// oldest lease (acc-evict-me) gets pruned.
		const MAX_PROBE_GATES = 10_000;
		for (let i = 0; i < MAX_PROBE_GATES; i++) {
			const acct = makeAccount({
				id: `acc-fill-${i}`,
				consecutive_rate_limits: 9,
				rate_limited_until: NOW - 1,
			});
			getRateLimitProbeAdmission(acct);
		}

		// The original account's lease was evicted, so a fresh probe is admitted
		// again instead of being suppressed.
		expect(getRateLimitProbeAdmission(first).decision).toBe("admitted");
	});
});

/**
 * Completion settles the lease the caller PROVES it holds, never whichever
 * lease the account currently has. Without that, any terminal path of any
 * request could free a probe it was never admitted for.
 */
describe("probe lease ownership", () => {
	it("a request holding no lease cannot release the live one", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		admit(account);

		// An ordinary request: it reached a terminal outcome for this account but
		// was never admitted, so it has nothing to hand back.
		completeRateLimitProbe(account, "recovered", undefined);
		expect(getRateLimitProbeAdmission(account).decision).toBe("suppressed");
	});

	it("an expired owner's 429 persists the cooldown but keeps the replacement's lease", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		const { ctx } = makeCtx();
		const expired = admit(account);

		// A's lease lapses; B is admitted under a fresh one and goes upstream.
		Date.now = () => NOW + 120_001;
		const replacement = admit(account);

		// A finally 429s. The account-level cooldown must be persisted…
		applyRateLimitCooldown(
			account,
			{ resetTime: NOW + 150_001, reason: "model_fallback_429" },
			ctx,
			{ probeLease: expired },
		);
		expect(account.rate_limited_until).toBe(NOW + 150_001);

		// …but the deadline does not protect B: it is SHORTER than B's remaining
		// lease, and B is still upstream. Admitting C here would be a second
		// concurrent probe.
		Date.now = () => NOW + 150_002;
		expect(getRateLimitProbeAdmission(account).decision).toBe("suppressed");
		// The burst hold's re-probe exemption skips the deadline, not the lease.
		expect(
			getRateLimitProbeAdmission(account, Date.now(), { reprobe: true })
				.decision,
		).toBe("suppressed");

		// B's own terminal outcome is what frees the account again.
		completeRateLimitProbe(account, "recovered", replacement);
		expect(getRateLimitProbeAdmission(account).decision).toBe("admitted");
	});

	it("an expired owner cannot delete the lease that replaced it", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		const expired = admit(account);

		// The first attempt outlives its lease (one attempt spans the stale-token
		// 401 recursion and the Codex transient hold), and the next request is
		// admitted under a fresh one.
		Date.now = () => NOW + 120_001;
		admit(account);

		// The first attempt finally reaches its terminal path.
		completeRateLimitProbe(account, "recovered", expired);
		expect(getRateLimitProbeAdmission(account).decision).toBe("suppressed");
	});
});

it("single-flights org-denial recovery from the first failure, including after the expiry sweep", () => {
	Date.now = () => NOW;
	for (const deadline of [NOW - 1, null]) {
		resetRateLimitProbeGatesForTests();
		const acc = makeAccount({
			rate_limited_reason: "org_permission_denied",
			consecutive_rate_limits: 1,
			rate_limited_until: deadline,
		});
		const lease = admit(acc);
		expect(getRateLimitProbeAdmission(acc).decision).toBe("suppressed");
		completeRateLimitProbe(acc, "abandoned", lease);
		expect(getRateLimitProbeAdmission(acc).decision).toBe("admitted");
	}
});
