/**
 * Tests for the per-account FIVE-HOUR prime cooldown.
 *
 * `fiveHourDue` fires whenever the account's `rate_limit_reset` has arrived and
 * shouldRefreshAccount sees a new window. That is level-triggered on a value the
 * prime ITSELF rewrites, so a provider that reports an already-elapsed reset puts
 * the scheduler in a closed loop: prime → persist reset ≈ now → next cycle sees
 * "reset has passed" → prime. Measured in production on an idle Codex account:
 * 764 primes and 843 session resets in 12.7h, one per 60s scheduler tick,
 * indefinitely.
 *
 * The fix mirrors what the WEEKLY path already does for the same "reset arrived
 * and the window is idle" state (isWeeklyDormant + WEEKLY_PRIME_COOLDOWN_MS): a
 * per-account minimum gap between 5h primes. It cannot suppress a legitimate
 * prime — a 5h window cannot roll twice inside the cooldown, so in the healthy
 * case the last prime is hours old and the gate is already open.
 *
 * These exercise the decision method directly (fiveHourDue), matching the
 * convention in auto-refresh-weekly-priming.test.ts — checkAndRefresh runs
 * unrelated token-refresh / peak-hours queries against the mock db.
 */
import { describe, expect, it, mock } from "bun:test";
import { USAGE_CACHE_TTL_MS } from "@clankermux/providers";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

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

type Row = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	custom_endpoint: string | null;
};

type SchedulerInternals = AutoRefreshScheduler & {
	fiveHourDue(account: Row, now: number): boolean;
	primeAccount(account: Row): Promise<boolean>;
	lastRefreshResetTime: Map<string, number>;
	lastFiveHourPrimeTime: Map<string, number>;
	FIVE_HOUR_PRIME_COOLDOWN_MS: number;
};

/** Minimal coordinator fake: `observe` resolves to the given canned result. */
function makeCoordinator(status: "skipped" | "completed" | "failed") {
	return {
		observe: mock(async () => ({
			status,
			reason: "test",
			responseOk: true,
			responseStatus: 200,
			accountName: "codex-main",
			observation: {
				usage: null,
				effectiveCredits: null,
				earliestResetMs: null,
				windowRolledOver: false,
				isRateLimited: false,
				responseStatus: 200,
			},
		})),
	};
}

async function makeScheduler(
	coordinator?: ReturnType<typeof makeCoordinator>,
): Promise<SchedulerInternals> {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		makeDb() as never,
		makeProxyContext() as never,
		coordinator as never,
	) as never as SchedulerInternals;
}

function makeRow(overrides: Partial<Row> = {}): Row {
	return {
		id: "acc-1",
		name: "codex-main",
		provider: "codex",
		refresh_token: "rt",
		access_token: "at",
		expires_at: null,
		rate_limit_reset: null,
		custom_endpoint: null,
		...overrides,
	};
}

const NOW = 1_800_000_000_000;

describe("AutoRefreshScheduler — five-hour prime cooldown", () => {
	it("is due when the reset has arrived and no prime has been recorded", async () => {
		const scheduler = await makeScheduler();
		const row = makeRow({ rate_limit_reset: NOW - 60_000 });
		scheduler.lastRefreshResetTime.set(row.id, NOW - 60_000);

		expect(scheduler.fiveHourDue(row, NOW)).toBe(true);
	});

	/**
	 * The production loop, reproduced: the previous prime persisted a reset that
	 * was ALREADY in the past, so one tick later the has-passed branch is true
	 * again. Without the cooldown this returns true every 60s forever.
	 */
	it("is NOT due one tick after a prime that returned an already-elapsed reset", async () => {
		const scheduler = await makeScheduler();
		const row = makeRow({ rate_limit_reset: NOW - 1_000 });
		scheduler.lastRefreshResetTime.set(row.id, NOW - 1_000);
		scheduler.lastFiveHourPrimeTime.set(row.id, NOW - 1_000);

		expect(scheduler.fiveHourDue(row, NOW)).toBe(false);
	});

	it("stays undue for every tick inside the cooldown", async () => {
		const scheduler = await makeScheduler();
		const primedAt = NOW;
		scheduler.lastFiveHourPrimeTime.set("acc-1", primedAt);

		// One scheduler tick per minute across the whole cooldown window.
		for (
			let t = primedAt + 60_000;
			t < primedAt + scheduler.FIVE_HOUR_PRIME_COOLDOWN_MS;
			t += 60_000
		) {
			const row = makeRow({ rate_limit_reset: t - 1_000 });
			scheduler.lastRefreshResetTime.set(row.id, t - 1_000);
			expect(scheduler.fiveHourDue(row, t)).toBe(false);
		}
	});

	/**
	 * The cooldown throttles the degenerate case rather than silencing it: an idle
	 * Codex account is NOT covered by the UsageFetcher poller (that poller only
	 * registers anthropic accounts with real traffic), so the slow prime remains
	 * its usage-freshness heartbeat.
	 */
	it("is due again once the cooldown has elapsed", async () => {
		const scheduler = await makeScheduler();
		const primedAt = NOW;
		scheduler.lastFiveHourPrimeTime.set("acc-1", primedAt);

		const later = primedAt + scheduler.FIVE_HOUR_PRIME_COOLDOWN_MS;
		const row = makeRow({ rate_limit_reset: later - 1_000 });
		scheduler.lastRefreshResetTime.set(row.id, later - 1_000);

		expect(scheduler.fiveHourDue(row, later)).toBe(true);
	});

	/**
	 * The healthy path must be untouched: a real 5h window cannot roll twice
	 * inside the cooldown, so by the time the next reset arrives the last prime is
	 * hours old.
	 */
	it("does not delay a genuine window arrival five hours after the last prime", async () => {
		const scheduler = await makeScheduler();
		const primedAt = NOW;
		scheduler.lastFiveHourPrimeTime.set("acc-1", primedAt);
		// The prime learned a reset 5h out; the scheduler sits idle until it lands.
		const nextReset = primedAt + 5 * 60 * 60 * 1000;
		scheduler.lastRefreshResetTime.set("acc-1", nextReset);

		const row = makeRow({ rate_limit_reset: nextReset });
		expect(scheduler.fiveHourDue(row, nextReset - 1)).toBe(false);
		expect(scheduler.fiveHourDue(row, nextReset)).toBe(true);
	});

	/**
	 * Same storm, different trigger: an account whose prime never yields a reset
	 * at all leaves lastRefreshResetTime unset, so shouldRefreshAccount's
	 * first-time branch returns true on every single cycle. The cooldown is keyed
	 * on the prime, not on the reset value, so it covers this too.
	 */
	it("throttles a first-time prime that never produced a reset", async () => {
		const scheduler = await makeScheduler();
		const row = makeRow({ rate_limit_reset: null });

		expect(scheduler.fiveHourDue(row, NOW)).toBe(true);

		scheduler.lastFiveHourPrimeTime.set(row.id, NOW);
		expect(scheduler.fiveHourDue(row, NOW + 60_000)).toBe(false);
		expect(
			scheduler.fiveHourDue(row, NOW + scheduler.FIVE_HOUR_PRIME_COOLDOWN_MS),
		).toBe(true);
	});

	/**
	 * Load-bearing coupling, not a coincidence of values.
	 *
	 * The codex observation reads its previous usage entry through the EVICTING
	 * usageCache.get(). If two consecutive scheduled primes were further apart
	 * than USAGE_CACHE_TTL_MS, that read returns null and two separate things
	 * break: the credits carry-forward that keeps an overage-paused account
	 * paused (a lost carry-forward reads as "no longer on credits" and RESUMES the
	 * account into paid-credit spend), and the previous-reset baseline that
	 * window-roll detection needs.
	 *
	 * Before the cooldown existed the 60s loop kept that entry warm by accident.
	 * This asserts the margin that replaces the accident.
	 */
	it("keeps the prime cadence strictly inside the usage-cache TTL", async () => {
		const scheduler = await makeScheduler();

		expect(scheduler.FIVE_HOUR_PRIME_COOLDOWN_MS).toBeLessThan(
			USAGE_CACHE_TTL_MS,
		);
		// Enough headroom for a scheduler tick plus the prime's own round trip.
		expect(
			USAGE_CACHE_TTL_MS - scheduler.FIVE_HOUR_PRIME_COOLDOWN_MS,
		).toBeGreaterThanOrEqual(2 * 60 * 1000);
	});

	/**
	 * The cooldown throttles REQUESTS, so it must only start when one was made.
	 * A coordinator `skipped` means nothing reached the provider (no tokens,
	 * auto-refresh switched off, account deleted); starting a cooldown for that
	 * would delay the first real prime after the cause is fixed.
	 */
	it("reports a codex 'skipped' prime as not attempted", async () => {
		const scheduler = await makeScheduler(makeCoordinator("skipped"));

		expect(await scheduler.primeAccount(makeRow())).toBe(false);
	});

	it("reports a codex prime that reached the provider as attempted", async () => {
		const scheduler = await makeScheduler(makeCoordinator("completed"));

		expect(await scheduler.primeAccount(makeRow())).toBe(true);
	});

	/**
	 * A FAILED prime is still an attempt — it is exactly the case the cooldown
	 * exists for, and the weekly path treats failure the same way.
	 */
	it("reports a failed codex prime as attempted", async () => {
		const scheduler = await makeScheduler(makeCoordinator("failed"));

		expect(await scheduler.primeAccount(makeRow())).toBe(true);
	});
});
