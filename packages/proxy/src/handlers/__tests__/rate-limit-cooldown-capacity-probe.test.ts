import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../proxy-types";
import {
	applyRateLimitCooldown,
	clearCapacityRestoredProbePending,
	completeRateLimitProbe,
	getRateLimitProbeAdmission,
	hasCapacityRestoredProbePending,
	markCapacityRestoredProbePending,
	resetRateLimitProbeGatesForTests,
	rollbackCapacityRestoredProbePending,
	wouldSuppressProbe,
} from "../rate-limit-cooldown";

/**
 * An account released EARLY by the usage poller becomes selectable again in one
 * step: `consecutive_rate_limits` is still 0 and the cooldown deadline is gone
 * entirely, so NEITHER half of the mature-streak gate engages. The dedicated
 * capacity-restored marker is what keeps the first wave after a release to a
 * single upstream probe.
 */

const NOW = Date.UTC(2026, 6, 25, 3, 0, 0);
const realDateNow = Date.now;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-capacity",
		name: "restored-account",
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
	const ctx = {
		dbOps: {
			markAccountRateLimited: mock(
				(_id: string, _until: number, _reason: string) => Promise.resolve(1),
			),
			markAccountRateLimitedDeadlineOnly: mock(
				(_id: string, _until: number, _reason: string) => Promise.resolve(),
			),
		} as never,
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
	} as unknown as ProxyContext;
	return { ctx };
}

/** How many of N concurrently-selected requests would reach upstream. */
function admittedOutOf(account: Account, n: number): number {
	let admitted = 0;
	for (let i = 0; i < n; i++) {
		if (getRateLimitProbeAdmission(account) === "admitted") admitted++;
	}
	return admitted;
}

afterEach(() => {
	Date.now = realDateNow;
	resetRateLimitProbeGatesForTests();
});

describe("capacity-restored single-flight marker", () => {
	it("gates an early-released account that no other condition would gate", () => {
		Date.now = () => NOW;
		// Post-clear state: streak 0, NO deadline. The mature-streak gate says
		// "not_required" for exactly this shape.
		const account = makeAccount();
		expect(getRateLimitProbeAdmission(account)).toBe("not_required");

		markCapacityRestoredProbePending(account.id);
		expect(admittedOutOf(account, 8)).toBe(1);
	});

	it("clears the marker only on a recovered probe of the MATCHING generation", () => {
		Date.now = () => NOW;
		const account = makeAccount();

		markCapacityRestoredProbePending(account.id);
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		completeRateLimitProbe(account, "recovered");
		expect(hasCapacityRestoredProbePending(account.id)).toBe(false);
		expect(getRateLimitProbeAdmission(account)).toBe("not_required");
	});

	it("a stale probe's success does NOT clear a newer restore's marker", () => {
		Date.now = () => NOW;
		const account = makeAccount();

		// Generation 1 is admitted and still in flight…
		markCapacityRestoredProbePending(account.id);
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		// …meanwhile the account is re-locked and released again (generation 2).
		markCapacityRestoredProbePending(account.id);

		// The old probe finally succeeds: it must not consume generation 2.
		completeRateLimitProbe(account, "recovered");
		expect(hasCapacityRestoredProbePending(account.id)).toBe(true);
		expect(admittedOutOf(account, 5)).toBe(1);
	});

	it("RETAINS the marker when the probe is abandoned", () => {
		Date.now = () => NOW;
		const account = makeAccount();

		markCapacityRestoredProbePending(account.id);
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		completeRateLimitProbe(account, "abandoned");

		expect(hasCapacityRestoredProbePending(account.id)).toBe(true);
		// The lease is released, so exactly one NEW probe is admitted.
		expect(admittedOutOf(account, 5)).toBe(1);
	});

	it("RETAINS the marker when the probe's 429 reapplies a cooldown that then expires", () => {
		// The R3-1 sequence end to end: the probe gets a reset-directed 429, Lever B
		// reapplies a cooldown WITHOUT escalating the streak (still 0), and that
		// deadline can be the synthesized 60s one — i.e. it expires before the next
		// 90s poll. If the reapply cleared the marker, the mature-streak gate would
		// answer "not_required" and EVERY concurrent request would reach upstream.
		Date.now = () => NOW;
		const account = makeAccount();
		const { ctx } = makeCtx();

		markCapacityRestoredProbePending(account.id);
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");

		applyRateLimitCooldown(account, { resetTime: NOW + 60_000 }, ctx);
		expect(account.consecutive_rate_limits).toBe(0);
		expect(hasCapacityRestoredProbePending(account.id)).toBe(true);

		// The reapplied cooldown expires before the next poll could re-observe.
		Date.now = () => NOW + 60_001;
		expect(admittedOutOf(account, 6)).toBe(1);
	});

	it("keeps the marker pending indefinitely while the account is never probed", () => {
		// A family gate or an open 529 breaker can legitimately delay probing. The
		// marker must NOT time-expire — expiring it would reopen fan-in exactly when
		// the account finally becomes selectable.
		Date.now = () => NOW;
		const account = makeAccount();
		markCapacityRestoredProbePending(account.id);

		Date.now = () => NOW + 24 * 60 * 60 * 1000;
		expect(hasCapacityRestoredProbePending(account.id)).toBe(true);
		expect(admittedOutOf(account, 4)).toBe(1);
	});

	it("a completion without a lease cannot mutate capacity state", () => {
		Date.now = () => NOW;
		const account = makeAccount();
		markCapacityRestoredProbePending(account.id);

		// No admission was ever taken, so this is a no-op in both maps.
		completeRateLimitProbe(account, "recovered");
		expect(hasCapacityRestoredProbePending(account.id)).toBe(true);
	});

	it("rolls back a reservation without disturbing a newer one", () => {
		Date.now = () => NOW;
		const account = makeAccount();

		const first = markCapacityRestoredProbePending(account.id);
		const _second = markCapacityRestoredProbePending(account.id);
		// A late rollback of the FIRST reservation must not drop the second's
		// marker — the second owns the slot and its clear may still commit.
		rollbackCapacityRestoredProbePending(first);
		expect(hasCapacityRestoredProbePending(account.id)).toBe(true);
		expect(admittedOutOf(account, 3)).toBe(1);
	});

	it("a rollback RESTORES the marker it displaced instead of erasing it", () => {
		// Two overlapping capacity callbacks: the older one COMMITS (no rollback),
		// the newer one fails. Deleting on that rollback would leave an unlocked
		// account with no marker — the exact fan-in hole the marker exists to close.
		Date.now = () => NOW;
		const account = makeAccount();

		markCapacityRestoredProbePending(account.id); // reservation 1 — committed
		const second = markCapacityRestoredProbePending(account.id); // reservation 2
		rollbackCapacityRestoredProbePending(second); // its CAS failed

		expect(hasCapacityRestoredProbePending(account.id)).toBe(true);
		expect(admittedOutOf(account, 5)).toBe(1);
	});

	it("a rollback of the FIRST reservation still clears when nothing preceded it", () => {
		Date.now = () => NOW;
		const account = makeAccount();
		const only = markCapacityRestoredProbePending(account.id);
		rollbackCapacityRestoredProbePending(only);
		expect(hasCapacityRestoredProbePending(account.id)).toBe(false);
	});

	it("two overlapping FAILED clears leave NO marker, whichever unwinds first", () => {
		// Both CASes fail. The older reservation unwinds first, which is a slot
		// no-op (the newer one owns it) — so without per-reservation state the
		// newer rollback would "restore" a predecessor that had itself failed,
		// leaving a marker owed for a restore that never happened. Markers never
		// expire, so a healthy account would be single-flighted forever.
		Date.now = () => NOW;
		const account = makeAccount();

		const first = markCapacityRestoredProbePending(account.id);
		const second = markCapacityRestoredProbePending(account.id);
		rollbackCapacityRestoredProbePending(first); // older finishes first
		rollbackCapacityRestoredProbePending(second);

		expect(hasCapacityRestoredProbePending(account.id)).toBe(false);
		expect(getRateLimitProbeAdmission(account)).toBe("not_required");
	});

	it("unwinds past a whole run of failed predecessors to a live one", () => {
		Date.now = () => NOW;
		const account = makeAccount();

		markCapacityRestoredProbePending(account.id); // 1: COMMITS (never rolled back)
		const second = markCapacityRestoredProbePending(account.id); // 2: fails
		const third = markCapacityRestoredProbePending(account.id); // 3: fails
		rollbackCapacityRestoredProbePending(second);
		rollbackCapacityRestoredProbePending(third);

		// Reservation 1's restore is still owed.
		expect(hasCapacityRestoredProbePending(account.id)).toBe(true);
		expect(admittedOutOf(account, 4)).toBe(1);
	});

	it("account removal drops the marker", () => {
		Date.now = () => NOW;
		const account = makeAccount();
		markCapacityRestoredProbePending(account.id);

		clearCapacityRestoredProbePending(account.id);
		expect(hasCapacityRestoredProbePending(account.id)).toBe(false);
		expect(getRateLimitProbeAdmission(account)).toBe("not_required");
	});

	it("still admits one probe when the mature-streak condition ALSO holds", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		markCapacityRestoredProbePending(account.id);

		expect(admittedOutOf(account, 5)).toBe(1);
		// A mature-streak probe that recovers also consumes the capacity marker it
		// was admitted with.
		completeRateLimitProbe(account, "recovered");
		expect(hasCapacityRestoredProbePending(account.id)).toBe(false);
	});

	it("a mature-streak probe admitted WITHOUT a marker cannot clear a later one", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");

		// The poller releases capacity while that probe is still in flight.
		markCapacityRestoredProbePending(account.id);
		completeRateLimitProbe(account, "recovered");

		expect(hasCapacityRestoredProbePending(account.id)).toBe(true);
	});
});

/**
 * `wouldSuppressProbe` is the side-effect-free mirror of
 * `getRateLimitProbeAdmission === "suppressed"`. It feeds the terminal-attempt
 * decision (forward a real upstream 529 body vs discard it), so it must mirror
 * BOTH admission arms, take no lease, and never prune.
 */
describe("wouldSuppressProbe", () => {
	it("is false for an ordinary account (neither admission arm engaged)", () => {
		Date.now = () => NOW;
		expect(wouldSuppressProbe(makeAccount())).toBe(false);
	});

	it("mirrors the CAPACITY-RESTORED arm once a probe holds the lease", () => {
		Date.now = () => NOW;
		const account = makeAccount();
		markCapacityRestoredProbePending(account.id);
		// Marker armed but nobody probing yet: the next request would be ADMITTED,
		// not suppressed.
		expect(wouldSuppressProbe(account)).toBe(false);

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		expect(wouldSuppressProbe(account)).toBe(true);

		completeRateLimitProbe(account, "recovered");
		expect(wouldSuppressProbe(account)).toBe(false);
	});

	it("mirrors the MATURE-STREAK arm once a probe holds the lease", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		expect(wouldSuppressProbe(account)).toBe(false);
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		expect(wouldSuppressProbe(account)).toBe(true);
	});

	it("does NOT suppress on an immature streak even while a stale lease lingers", () => {
		Date.now = () => NOW;
		const mature = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		expect(getRateLimitProbeAdmission(mature)).toBe("admitted");
		// Same id, but no longer a gated shape: neither arm engages, so the lingering
		// lease is irrelevant.
		expect(
			wouldSuppressProbe(
				makeAccount({ consecutive_rate_limits: 0, rate_limited_until: null }),
			),
		).toBe(false);
	});

	it("takes no lease and does not prune (calling it never changes admission)", () => {
		Date.now = () => NOW;
		const account = makeAccount();
		markCapacityRestoredProbePending(account.id);
		for (let i = 0; i < 5; i++) wouldSuppressProbe(account);
		// The single probe is still available — the predicate consumed nothing.
		expect(admittedOutOf(account, 3)).toBe(1);
	});

	it("reports false once the lease has expired, without deleting it", () => {
		Date.now = () => NOW;
		const account = makeAccount();
		markCapacityRestoredProbePending(account.id);
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		expect(wouldSuppressProbe(account)).toBe(true);
		// Past the two-minute lease.
		const later = NOW + 3 * 60 * 1000;
		expect(wouldSuppressProbe(account, later)).toBe(false);
	});
});
