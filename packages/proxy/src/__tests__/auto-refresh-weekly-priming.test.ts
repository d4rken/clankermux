/**
 * Tests for AutoRefreshScheduler WEEKLY-DORMANT priming.
 *
 * Beyond the 5-hour reset reason, the scheduler also primes at most ONE account
 * per cycle whose WEEKLY (seven_day) usage window is dormant while its 5h window
 * is still active. This covers a low-traffic anthropic-OAuth backup whose weekly
 * window has reset (or never started) but whose 5h window is still running, so
 * the old 5h-keyed priming never touched it.
 *
 * These tests exercise the decision methods directly (isWeeklyDormant,
 * selectWeeklyPrimeCandidate) — they do NOT call checkAndRefresh (which runs
 * unrelated token-refresh / peak-hours queries against the mock db). Weekly state
 * is seeded with the real usageCache.set(...) and cleaned up with
 * usageCache.delete(...) (or restored spies) after each test.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { toEpochMs, type UsageData, usageCache } from "@clankermux/providers";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

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

type WeeklyRow = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	custom_endpoint: string | null;
	paused: number;
	auto_pause_on_overage_enabled: number;
	pause_reason: string | null;
};

/** Private-method surface we reach into for these unit tests. */
type SchedulerInternals = AutoRefreshScheduler & {
	isWeeklyDormant(accountId: string, now: number): boolean;
	selectWeeklyPrimeCandidate(
		candidates: WeeklyRow[],
		fiveHourDueIds: Set<string>,
		now: number,
	): WeeklyRow | null;
	lastWeeklyPrimeTime: Map<string, number>;
	WEEKLY_PRIME_COOLDOWN_MS: number;
	WEEKLY_CACHE_MAX_AGE_MS: number;
};

async function makeScheduler(): Promise<SchedulerInternals> {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		makeDb() as never,
		makeProxyContext() as never,
	) as never as SchedulerInternals;
}

/** A fresh anthropic-OAuth row with the given id/name. */
function makeRow(overrides: Partial<WeeklyRow> = {}): WeeklyRow {
	return {
		id: "acc-1",
		name: "backup",
		provider: "anthropic",
		refresh_token: "rt",
		access_token: "at",
		expires_at: null,
		// 5h window still active (reset in the future) → NOT 5h-due.
		rate_limit_reset: Date.now() + 4 * 60 * 60 * 1000,
		custom_endpoint: null,
		paused: 0,
		auto_pause_on_overage_enabled: 0,
		pause_reason: null,
		...overrides,
	};
}

/**
 * Seed usageCache with a usage datum carrying the given seven_day window.
 *
 * utilization is widened to `number | null` here (the public UsageWindow type is
 * `number`) so tests can exercise the anomalous "null reset + util null" runtime
 * shape that isWeeklyDormant must classify as NOT dormant.
 */
function seedWeekly(
	accountId: string,
	seven_day: { utilization: number | null; resets_at: string | null },
): void {
	const data = {
		five_hour: { utilization: 0, resets_at: null },
		seven_day,
	} as unknown as UsageData;
	usageCache.set(accountId, data);
}

// Track ids we seed so we can clean up deterministically.
const seededIds = new Set<string>();
function track(id: string): string {
	seededIds.add(id);
	return id;
}

afterEach(() => {
	for (const id of seededIds) usageCache.delete(id);
	seededIds.clear();
	mock.restore();
});

// ── toEpochMs sanity ────────────────────────────────────────────────────────

describe("toEpochMs", () => {
	it("parses ISO strings, epoch numbers, and rejects junk", () => {
		expect(toEpochMs(null)).toBeNull();
		expect(toEpochMs(undefined)).toBeNull();
		expect(toEpochMs("not-a-date")).toBeNull();
		expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
		const iso = "2030-01-01T00:00:00.000Z";
		expect(toEpochMs(iso)).toBe(new Date(iso).getTime());
	});
});

// ── isWeeklyDormant ───────────────────────────────────────────────────────────

describe("AutoRefreshScheduler — isWeeklyDormant", () => {
	it("treats a fresh resets_at=null + utilization=0 weekly window as dormant (not started)", async () => {
		const scheduler = await makeScheduler();
		const id = track("w-null");
		const now = Date.now();
		seedWeekly(id, { utilization: 0, resets_at: null });
		expect(scheduler.isWeeklyDormant(id, now)).toBe(true);
	});

	it("does NOT treat resets_at=null + utilization=null as dormant (no reset data → unknown)", async () => {
		const scheduler = await makeScheduler();
		const id = track("w-null-utilnull");
		const now = Date.now();
		seedWeekly(id, { utilization: null, resets_at: null });
		expect(scheduler.isWeeklyDormant(id, now)).toBe(false);
	});

	it("does NOT treat resets_at=null + utilization>0 as dormant (no reset data → unknown)", async () => {
		const scheduler = await makeScheduler();
		const id = track("w-null-util5");
		const now = Date.now();
		seedWeekly(id, { utilization: 5, resets_at: null });
		expect(scheduler.isWeeklyDormant(id, now)).toBe(false);
	});

	it("treats an already-reset (past) weekly window as dormant", async () => {
		const scheduler = await makeScheduler();
		const id = track("w-past");
		const now = Date.now();
		seedWeekly(id, {
			utilization: 0,
			resets_at: new Date(now - 60_000).toISOString(),
		});
		expect(scheduler.isWeeklyDormant(id, now)).toBe(true);
	});

	it("does NOT treat a future weekly reset as dormant", async () => {
		const scheduler = await makeScheduler();
		const id = track("w-future");
		const now = Date.now();
		seedWeekly(id, {
			utilization: 30,
			resets_at: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
		});
		expect(scheduler.isWeeklyDormant(id, now)).toBe(false);
	});

	it("returns false when there is no cache entry", async () => {
		const scheduler = await makeScheduler();
		const now = Date.now();
		expect(scheduler.isWeeklyDormant("no-such-account", now)).toBe(false);
	});

	it("returns false when the cache entry is stale (age > WEEKLY_CACHE_MAX_AGE_MS)", async () => {
		const scheduler = await makeScheduler();
		const id = track("w-stale");
		const now = Date.now();
		seedWeekly(id, { utilization: 0, resets_at: null });
		// Force getAge to report an age beyond the freshness ceiling.
		spyOn(usageCache, "getAge").mockReturnValue(
			scheduler.WEEKLY_CACHE_MAX_AGE_MS + 1,
		);
		expect(scheduler.isWeeklyDormant(id, now)).toBe(false);
	});

	it("returns false when getAge reports null (no fresh datum)", async () => {
		const scheduler = await makeScheduler();
		const id = track("w-nullage");
		const now = Date.now();
		seedWeekly(id, { utilization: 0, resets_at: null });
		spyOn(usageCache, "getAge").mockReturnValue(null);
		expect(scheduler.isWeeklyDormant(id, now)).toBe(false);
	});

	it("returns false for an unparseable resets_at (unknown → skip)", async () => {
		const scheduler = await makeScheduler();
		const id = track("w-junk");
		const now = Date.now();
		seedWeekly(id, { utilization: 0, resets_at: "not-a-date" });
		expect(scheduler.isWeeklyDormant(id, now)).toBe(false);
	});

	it("returns false when the datum carries no seven_day window", async () => {
		const scheduler = await makeScheduler();
		const id = track("w-noseven");
		const now = Date.now();
		// Set a datum without a seven_day field.
		usageCache.set(id, {
			five_hour: { utilization: 0, resets_at: null },
		} as unknown as UsageData);
		expect(scheduler.isWeeklyDormant(id, now)).toBe(false);
	});
});

// ── selectWeeklyPrimeCandidate ────────────────────────────────────────────────

describe("AutoRefreshScheduler — selectWeeklyPrimeCandidate", () => {
	it("returns a 5h-active anthropic-OAuth account with a fresh dormant weekly window", async () => {
		const scheduler = await makeScheduler();
		const id = track("acc-fresh");
		const now = Date.now();
		seedWeekly(id, { utilization: 0, resets_at: null });
		const row = makeRow({ id, name: "fresh-backup" });

		const picked = scheduler.selectWeeklyPrimeCandidate([row], new Set(), now);
		expect(picked?.id).toBe(id);
	});

	it("returns an account whose weekly resets_at is in the past", async () => {
		const scheduler = await makeScheduler();
		const id = track("acc-expired");
		const now = Date.now();
		seedWeekly(id, {
			utilization: 0,
			resets_at: new Date(now - 5 * 60_000).toISOString(),
		});
		const row = makeRow({ id, name: "expired-weekly" });

		const picked = scheduler.selectWeeklyPrimeCandidate([row], new Set(), now);
		expect(picked?.id).toBe(id);
	});

	it("does NOT return an account whose weekly resets_at is in the future", async () => {
		const scheduler = await makeScheduler();
		const id = track("acc-futureweekly");
		const now = Date.now();
		seedWeekly(id, {
			utilization: 40,
			resets_at: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString(),
		});
		const row = makeRow({ id });

		expect(
			scheduler.selectWeeklyPrimeCandidate([row], new Set(), now),
		).toBeNull();
	});

	it("does NOT return an account with no usageCache entry", async () => {
		const scheduler = await makeScheduler();
		const now = Date.now();
		const row = makeRow({ id: "acc-nocache" });
		expect(
			scheduler.selectWeeklyPrimeCandidate([row], new Set(), now),
		).toBeNull();
	});

	it("does NOT return an account whose cache is stale (getAge spy)", async () => {
		const scheduler = await makeScheduler();
		const id = track("acc-stale");
		const now = Date.now();
		seedWeekly(id, { utilization: 0, resets_at: null });
		spyOn(usageCache, "getAge").mockReturnValue(
			scheduler.WEEKLY_CACHE_MAX_AGE_MS + 1,
		);
		const row = makeRow({ id });
		expect(
			scheduler.selectWeeklyPrimeCandidate([row], new Set(), now),
		).toBeNull();
	});

	it("does NOT return an account with an invalid resets_at string", async () => {
		const scheduler = await makeScheduler();
		const id = track("acc-junk");
		const now = Date.now();
		seedWeekly(id, { utilization: 0, resets_at: "not-a-date" });
		const row = makeRow({ id });
		expect(
			scheduler.selectWeeklyPrimeCandidate([row], new Set(), now),
		).toBeNull();
	});

	it("skips an account still within WEEKLY_PRIME_COOLDOWN_MS", async () => {
		const scheduler = await makeScheduler();
		const id = track("acc-cooldown");
		const now = Date.now();
		seedWeekly(id, { utilization: 0, resets_at: null });
		// Primed 1 minute ago — inside the 15-minute cooldown.
		scheduler.lastWeeklyPrimeTime.set(id, now - 60_000);
		const row = makeRow({ id });
		expect(
			scheduler.selectWeeklyPrimeCandidate([row], new Set(), now),
		).toBeNull();

		// After the cooldown elapses, it becomes eligible again.
		const later = now + scheduler.WEEKLY_PRIME_COOLDOWN_MS + 1;
		expect(
			scheduler.selectWeeklyPrimeCandidate([row], new Set(), later)?.id,
		).toBe(id);
	});

	it("caps at exactly ONE candidate per cycle; when BOTH never-primed, tie-breaks by id (lowest wins)", async () => {
		const scheduler = await makeScheduler();
		const now = Date.now();
		const idB = track("bbb-account");
		const idA = track("aaa-account");
		seedWeekly(idA, { utilization: 0, resets_at: null });
		seedWeekly(idB, { utilization: 0, resets_at: null });
		// Pass them out of id order to prove the deterministic sort. Neither has a
		// lastWeeklyPrimeTime, so both sort to 0 and the id tie-break decides.
		const rows = [makeRow({ id: idB }), makeRow({ id: idA })];

		const picked = scheduler.selectWeeklyPrimeCandidate(rows, new Set(), now);
		// Lowest id wins the tie-break.
		expect(picked?.id).toBe(idA);
	});

	it("is FAIR: prefers the least-recently-primed account over a lower id that was primed recently", async () => {
		const scheduler = await makeScheduler();
		const now = Date.now();
		// Lower id was primed recently (but cooldown has elapsed); higher id never
		// primed. Oldest-prime-first must pick the higher id, NOT the lower id —
		// otherwise the lowest id would starve the others (it would keep being
		// re-primed every cooldown before they are ever chosen).
		const idLow = track("aaa-low");
		const idHigh = track("zzz-high");
		seedWeekly(idLow, { utilization: 0, resets_at: null });
		seedWeekly(idHigh, { utilization: 0, resets_at: null });
		// Low id primed just outside the cooldown → eligible again, but recent.
		scheduler.lastWeeklyPrimeTime.set(
			idLow,
			now - scheduler.WEEKLY_PRIME_COOLDOWN_MS - 1,
		);
		// High id never primed (absent → treated as 0 → sorts first).
		const rows = [makeRow({ id: idLow }), makeRow({ id: idHigh })];

		const picked = scheduler.selectWeeklyPrimeCandidate(rows, new Set(), now);
		expect(picked?.id).toBe(idHigh);
	});

	it("excludes an account already in fiveHourDueIds (5h reason wins, even if its send fails)", async () => {
		const scheduler = await makeScheduler();
		const id = track("acc-5hdue");
		const now = Date.now();
		seedWeekly(id, { utilization: 0, resets_at: null });
		const row = makeRow({ id });

		// id is in the pre-send fiveHourDueIds snapshot → never primed as weekly.
		expect(
			scheduler.selectWeeklyPrimeCandidate([row], new Set([id]), now),
		).toBeNull();
	});

	it("excludes anthropic accounts with no refresh_token and non-anthropic providers", async () => {
		const scheduler = await makeScheduler();
		const now = Date.now();

		const noTokenId = track("acc-notoken");
		seedWeekly(noTokenId, { utilization: 0, resets_at: null });
		const noToken = makeRow({ id: noTokenId, refresh_token: "" });

		const codexId = track("acc-codex");
		seedWeekly(codexId, { utilization: 0, resets_at: null });
		const codex = makeRow({ id: codexId, provider: "codex" });

		expect(
			scheduler.selectWeeklyPrimeCandidate([noToken, codex], new Set(), now),
		).toBeNull();
	});
});
