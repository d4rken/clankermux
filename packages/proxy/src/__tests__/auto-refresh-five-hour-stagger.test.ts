/**
 * Tests for AutoRefreshScheduler 5-HOUR WINDOW PHASE STAGGERING.
 *
 * The 5h prime reason is level-triggered on `rate_limit_reset <= now`, so an
 * account is re-primed the moment its window resets and the new window opens
 * right there. Primes run sequentially over one tick's due batch, so accounts
 * whose windows reset in the same tick get re-opened seconds apart and then
 * reset together again 5h later — the clustering is self-reinforcing. Measured
 * on the live pool: two clusters ten and twenty minutes wide, i.e. four
 * accounts producing two distinct phases.
 *
 * The fix assigns each account a slot offset of `index * (5h / N)` against a
 * fixed epoch and holds an IDLE account's prime until its slot comes round.
 * The hold is one-shot in effect rather than in code: once the window opens at
 * the slot it resets at slot+5h, and the ordinary prime-at-reset path carries
 * the phase forward from there. Not exactly, though — the phase is a bounded
 * sawtooth. Each cycle opens the window a little later than the slot (dispatch
 * lag, then tick granularity in observing the reset), the lateness carries
 * forward, and once it exceeds the grace the account waits for the slot to come
 * round and lands exactly back on it. See STAGGER_SLOT_GRACE_MS.
 *
 * Two invariants this file pins that are easy to break:
 *
 *  - The hold NEVER changes 5h OWNERSHIP. It filters `accountsToRefresh`, not
 *    `fiveHourDue`, exactly like the existing prime cooldown. The weekly pass
 *    defers to ownership, so moving the check into `fiveHourDue` would let the
 *    weekly reason prime a stagger-held account on the next cycle and defeat
 *    the whole mechanism.
 *  - Only IDLE windows are held. Traffic opens windows too, and on this pool it
 *    opens most of them; an account whose window traffic already started has
 *    its phase set by traffic and must not be held.
 *
 * These tests exercise the decision methods directly — they do NOT call
 * checkAndRefresh (which runs unrelated token-refresh / peak-hours queries
 * against the mock db). Usage state is seeded with the real usageCache and
 * cleaned up after each test.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { type UsageData, usageCache } from "@clankermux/providers";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDb() {
	return {
		run: mock(async () => {}),
		query: mock(async () => []),
	};
}

function makeProxyContext() {
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
	};
}

type StaggerRow = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	session_start: number | null;
	custom_endpoint: string | null;
};

/** Private-method surface we reach into for these unit tests. */
type SchedulerInternals = AutoRefreshScheduler & {
	isFiveHourIdle(accountId: string, now: number): boolean;
	staggerSlotOffsetMs(accountId: string, cohort: string[]): number | null;
	staggerDefersPrime(
		account: StaggerRow,
		now: number,
		cohort: string[],
	): boolean;
	fiveHourDue(account: StaggerRow, now: number): boolean;
	lastRefreshResetTime: Map<string, number>;
	STAGGER_SLOT_GRACE_MS: number;
	WEEKLY_CACHE_MAX_AGE_MS: number;
};

async function makeScheduler(): Promise<SchedulerInternals> {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		makeDb() as never,
		makeProxyContext() as never,
	) as never as SchedulerInternals;
}

function makeRow(overrides: Partial<StaggerRow> = {}): StaggerRow {
	return {
		id: "acc-1",
		name: "backup",
		provider: "anthropic",
		refresh_token: "rt",
		access_token: "at",
		expires_at: null,
		rate_limit_reset: null,
		session_start: null,
		custom_endpoint: null,
		...overrides,
	};
}

const seeded: string[] = [];

/**
 * Seed usageCache with a datum carrying the given five_hour window.
 * `five_hour: null` models a provider with no rolling 5h window at all (Codex
 * retired its own); `undefined` models a payload that omits the key.
 */
function seedFiveHour(
	accountId: string,
	five_hour: { utilization: number | null; resets_at: string | null } | null,
) {
	usageCache.set(accountId, { five_hour } as unknown as UsageData);
	seeded.push(accountId);
}

afterEach(() => {
	for (const id of seeded.splice(0)) usageCache.delete(id);
	// Restore the getAge spies the freshness tests install — a leaked spy would
	// silently change every later test's idleness verdict.
	mock.restore();
});

// ── isFiveHourIdle ────────────────────────────────────────────────────────────

describe("isFiveHourIdle", () => {
	it("is false with no cached usage datum — absence is not evidence of idleness", async () => {
		const s = await makeScheduler();
		expect(s.isFiveHourIdle("never-seen", Date.now())).toBe(false);
	});

	it("is false when the window key is absent or explicitly null", async () => {
		const s = await makeScheduler();
		const now = Date.now();

		seedFiveHour("acc-null", null);
		expect(s.isFiveHourIdle("acc-null", now)).toBe(false);

		usageCache.set("acc-missing", {} as unknown as UsageData);
		seeded.push("acc-missing");
		expect(s.isFiveHourIdle("acc-missing", now)).toBe(false);
	});

	it("is TRUE for an idle-but-real window: utilization 0 with a null reset", async () => {
		// Anthropic emits {utilization:0, resets_at:null} for a real 5h window
		// that has not been started yet. That is precisely the account a stagger
		// can steer, so this case must read as idle.
		const s = await makeScheduler();
		seedFiveHour("acc-idle", { utilization: 0, resets_at: null });
		expect(s.isFiveHourIdle("acc-idle", Date.now())).toBe(true);
	});

	it("is false for a null reset with non-zero utilization — that is 'no reset data', not 'not started'", async () => {
		const s = await makeScheduler();
		seedFiveHour("acc-used", { utilization: 12, resets_at: null });
		expect(s.isFiveHourIdle("acc-used", Date.now())).toBe(false);
	});

	it("is false for a null reset with null utilization — no evidence either way", async () => {
		const s = await makeScheduler();
		seedFiveHour("acc-unknown", { utilization: null, resets_at: null });
		expect(s.isFiveHourIdle("acc-unknown", Date.now())).toBe(false);
	});

	it("is true once a parseable reset has already passed", async () => {
		const s = await makeScheduler();
		const now = Date.now();
		seedFiveHour("acc-past", {
			utilization: 40,
			resets_at: new Date(now - 60_000).toISOString(),
		});
		expect(s.isFiveHourIdle("acc-past", now)).toBe(true);
	});

	it("is false while a reset is still in the future — traffic owns this window", async () => {
		const s = await makeScheduler();
		const now = Date.now();
		seedFiveHour("acc-live", {
			utilization: 40,
			resets_at: new Date(now + 60 * 60_000).toISOString(),
		});
		expect(s.isFiveHourIdle("acc-live", now)).toBe(false);
	});

	it("is false for an unparseable reset — unknown must not be read as idle", async () => {
		const s = await makeScheduler();
		seedFiveHour("acc-garbage", {
			utilization: 0,
			resets_at: "not-a-timestamp",
		});
		expect(s.isFiveHourIdle("acc-garbage", Date.now())).toBe(false);
	});

	it("is false when the cached datum is older than the freshness ceiling", async () => {
		const s = await makeScheduler();
		seedFiveHour("acc-stale", { utilization: 0, resets_at: null });
		spyOn(usageCache, "getAge").mockReturnValue(s.WEEKLY_CACHE_MAX_AGE_MS + 1);
		expect(s.isFiveHourIdle("acc-stale", Date.now())).toBe(false);
	});

	it("is false when getAge reports null (no fresh datum)", async () => {
		const s = await makeScheduler();
		seedFiveHour("acc-nullage", { utilization: 0, resets_at: null });
		spyOn(usageCache, "getAge").mockReturnValue(null);
		expect(s.isFiveHourIdle("acc-nullage", Date.now())).toBe(false);
	});
});

// ── slot assignment ───────────────────────────────────────────────────────────

describe("staggerSlotOffsetMs", () => {
	it("spreads the cohort evenly across the window by sorted id", async () => {
		const s = await makeScheduler();
		const cohort = ["d", "b", "a", "c"];
		// Sorted: a,b,c,d → offsets 0, 1.25h, 2.5h, 3.75h.
		expect(s.staggerSlotOffsetMs("a", cohort)).toBe(0);
		expect(s.staggerSlotOffsetMs("b", cohort)).toBe(FIVE_HOURS_MS / 4);
		expect(s.staggerSlotOffsetMs("c", cohort)).toBe(FIVE_HOURS_MS / 2);
		expect(s.staggerSlotOffsetMs("d", cohort)).toBe((FIVE_HOURS_MS * 3) / 4);
	});

	it("is order-independent — the same cohort in any order gives the same slots", async () => {
		const s = await makeScheduler();
		const one = s.staggerSlotOffsetMs("c", ["a", "b", "c", "d"]);
		const two = s.staggerSlotOffsetMs("c", ["d", "c", "b", "a"]);
		expect(one).toBe(two as number);
	});

	it("returns null for an account outside the cohort", async () => {
		const s = await makeScheduler();
		expect(s.staggerSlotOffsetMs("z", ["a", "b"])).toBeNull();
	});

	it("returns null for a cohort of one — there is nothing to stagger against", async () => {
		const s = await makeScheduler();
		expect(s.staggerSlotOffsetMs("a", ["a"])).toBeNull();
	});

	it("ignores duplicate ids when sizing the cohort", async () => {
		const s = await makeScheduler();
		expect(s.staggerSlotOffsetMs("b", ["a", "b", "a", "b"])).toBe(
			FIVE_HOURS_MS / 2,
		);
	});
});

// ── the hold decision ─────────────────────────────────────────────────────────

describe("staggerDefersPrime", () => {
	const cohort = ["acc-1", "acc-2"]; // slots 0 and 2.5h

	/** A `now` whose phase within the 5h cycle is exactly `offsetMs`. */
	function nowAtSlot(offsetMs: number, plusMs = 0): number {
		const base = Math.floor(Date.now() / FIVE_HOURS_MS) * FIVE_HOURS_MS;
		return base + offsetMs + plusMs;
	}

	async function idleScheduler(): Promise<SchedulerInternals> {
		const s = await makeScheduler();
		seedFiveHour("acc-1", { utilization: 0, resets_at: null });
		// Previously primed — the never-primed exemption must not apply.
		s.lastRefreshResetTime.set("acc-1", 1);
		return s;
	}

	it("defers an idle, previously-primed account outside its slot", async () => {
		const s = await idleScheduler();
		// acc-1's slot is offset 0; sit halfway through the cycle instead.
		const now = nowAtSlot(FIVE_HOURS_MS / 2);
		expect(s.staggerDefersPrime(makeRow(), now, cohort)).toBe(true);
	});

	it("releases the prime once the slot arrives", async () => {
		const s = await idleScheduler();
		const now = nowAtSlot(0);
		expect(s.staggerDefersPrime(makeRow(), now, cohort)).toBe(false);
	});

	it("releases anywhere inside the grace window, so a slow tick cannot skip a slot", async () => {
		const s = await idleScheduler();
		const now = nowAtSlot(0, s.STAGGER_SLOT_GRACE_MS - 1_000);
		expect(s.staggerDefersPrime(makeRow(), now, cohort)).toBe(false);
	});

	it("defers again once the grace window has passed", async () => {
		const s = await idleScheduler();
		const now = nowAtSlot(0, s.STAGGER_SLOT_GRACE_MS + 60_000);
		expect(s.staggerDefersPrime(makeRow(), now, cohort)).toBe(true);
	});

	it("never defers a non-anthropic account — only Anthropic still has a rolling 5h window", async () => {
		const s = await idleScheduler();
		const now = nowAtSlot(FIVE_HOURS_MS / 2);
		const codex = makeRow({ provider: "codex" });
		expect(s.staggerDefersPrime(codex, now, cohort)).toBe(false);
	});

	it("keeps deferring across a restart, when only the in-memory prime record is gone", async () => {
		// The regression this guards: `lastRefreshResetTime` is process-local and
		// empty after every restart. If emptiness alone meant "never primed", a
		// restart would exempt the whole pool, prime it in one batch and re-cluster
		// the exact phases this mechanism exists to spread — and this checkout
		// rebuilds and restarts in place, so that is a routine event, not a rare
		// one. A persisted rate_limit_reset is the evidence that survives.
		const s = await makeScheduler();
		seedFiveHour("acc-1", { utilization: 0, resets_at: null });
		expect(s.lastRefreshResetTime.has("acc-1")).toBe(false);
		const now = nowAtSlot(FIVE_HOURS_MS / 2);
		const restarted = makeRow({
			rate_limit_reset: now - 60_000,
			session_start: now - 6 * 60 * 60_000,
		});
		expect(s.staggerDefersPrime(restarted, now, cohort)).toBe(true);
	});

	it("keeps deferring an established account whose reset column is null", async () => {
		// The narrower version of the restart hole. response-processor persists a
		// null rate_limit_reset whenever a unified status carries no reset header,
		// so "no in-memory record AND null reset" still matches an ESTABLISHED
		// account after a restart. session_start is the discriminator: it is null
		// only for an account that has never had a session at all.
		const s = await makeScheduler();
		seedFiveHour("acc-1", { utilization: 0, resets_at: null });
		const now = nowAtSlot(FIVE_HOURS_MS / 2);
		const established = makeRow({
			rate_limit_reset: null,
			session_start: now - 6 * 60 * 60_000,
		});
		expect(s.staggerDefersPrime(established, now, cohort)).toBe(true);
	});

	it("treats the grace endpoint as past the slot — the release interval is half-open", async () => {
		const s = await idleScheduler();
		const now = nowAtSlot(0, s.STAGGER_SLOT_GRACE_MS);
		expect(s.staggerDefersPrime(makeRow(), now, cohort)).toBe(true);
	});

	it("never defers a never-primed account — onboarding must not be slowed", async () => {
		// A fresh account needs two primes before it promotes out of the UNKNOWN
		// routing bucket; holding its first one for up to 5h would strand it.
		const s = await makeScheduler();
		seedFiveHour("acc-1", { utilization: 0, resets_at: null });
		const now = nowAtSlot(FIVE_HOURS_MS / 2);
		expect(s.lastRefreshResetTime.has("acc-1")).toBe(false);
		expect(s.staggerDefersPrime(makeRow(), now, cohort)).toBe(false);
	});

	it("never defers when the window is not idle — traffic owns the phase", async () => {
		const s = await makeScheduler();
		s.lastRefreshResetTime.set("acc-1", 1);
		// acc-1's slot is offset 0, so this `now` is well outside it and the only
		// thing that can release the hold is the not-idle verdict. The reset must
		// be derived from that same `now` rather than from Date.now(): nowAtSlot
		// can land hours either side of real time, and mixing the two frames makes
		// the test's outcome depend on the time of day it runs.
		const now = nowAtSlot(FIVE_HOURS_MS / 2);
		seedFiveHour("acc-1", {
			utilization: 30,
			resets_at: new Date(now + 60 * 60_000).toISOString(),
		});
		expect(s.staggerDefersPrime(makeRow(), now, cohort)).toBe(false);
	});

	it("never defers a lone account", async () => {
		const s = await idleScheduler();
		const now = nowAtSlot(FIVE_HOURS_MS / 2);
		expect(s.staggerDefersPrime(makeRow(), now, ["acc-1"])).toBe(false);
	});

	it("never defers an account missing from the cohort", async () => {
		const s = await idleScheduler();
		const now = nowAtSlot(FIVE_HOURS_MS / 2);
		expect(s.staggerDefersPrime(makeRow(), now, ["acc-9", "acc-8"])).toBe(
			false,
		);
	});

	it("leaves 5h OWNERSHIP intact for a deferred account", async () => {
		// The weekly pass defers to the 5h reason's ownership set. If the hold
		// leaked into fiveHourDue, a held account would fall out of that set and
		// the weekly reason would prime it on the next cycle, defeating the hold.
		const s = await idleScheduler();
		const now = nowAtSlot(FIVE_HOURS_MS / 2);
		const row = makeRow({ rate_limit_reset: now - 1000, session_start: 1 });
		expect(s.staggerDefersPrime(row, now, cohort)).toBe(true);
		expect(s.fiveHourDue(row, now)).toBe(true);
	});
});
