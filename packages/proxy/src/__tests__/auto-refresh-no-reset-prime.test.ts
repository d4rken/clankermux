/**
 * Regression test: a successful prime that yields NO reset time must still be
 * recorded, or the account primes forever.
 *
 * shouldRefreshAccount's first branch is keyed on the PRESENCE of a
 * lastRefreshResetTime entry, and only the `rateLimitInfo.resetTime` arm of
 * sendTranslatedClaudePrime ever wrote one. A provider that answers a 200 with
 * no rate-limit headers therefore leaves the map empty, so every later cycle
 * reads as the first one and re-primes at FIVE_HOUR_PRIME_COOLDOWN_MS forever —
 * the cooldown throttles the storm but never ends it.
 *
 * Observed in production on a Z.AI account: ZaiProvider.parseRateLimit returns
 * `{ isRateLimited: false }` for anything that is not a 429, so a healthy prime
 * never carries a reset. 44 synthetic completions in 24h against an account at
 * 1% utilization, with no window to reopen.
 *
 * The scheduler's `dispatch` constructor seam is used instead of mock.module:
 * bun keeps a module mock global for the whole run, and a destructive stub here
 * leaks into every sibling proxy test.
 */
import { describe, expect, it, mock } from "bun:test";

type AccountRow = {
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

type SchedulerInternals = {
	sendTranslatedClaudePrime(account: AccountRow): Promise<boolean>;
	shouldRefreshAccount(account: AccountRow, now: number): boolean;
	lastRefreshResetTime: Map<string, number>;
};

function makeRow(overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		id: "acc-zai",
		name: "Z.AI-1",
		provider: "zai",
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 60 * 60 * 1000,
		rate_limit_reset: null,
		custom_endpoint: null,
		paused: 0,
		auto_pause_on_overage_enabled: 0,
		pause_reason: null,
		...overrides,
	};
}

/**
 * sendTranslatedClaudePrime re-reads the auto_refresh_enabled flag before
 * dispatching; everything else it issues is a write.
 */
function makeDb() {
	return {
		run: mock(async () => {}),
		runWithChanges: mock(async () => 1),
		query: mock(async () => [{ auto_refresh_enabled: 1 }]),
	};
}

/** A 200 with no rate-limit headers at all — what a healthy Z.AI prime returns. */
function makeBareOkDispatch() {
	return mock(
		async () =>
			new Response(JSON.stringify({ type: "message", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
}

async function makeScheduler(
	db: ReturnType<typeof makeDb>,
	dispatch: ReturnType<typeof makeBareOkDispatch>,
): Promise<SchedulerInternals> {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		db as never,
		{
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
		} as never,
		undefined,
		dispatch as never,
	) as never as SchedulerInternals;
}

const NOW = 1_800_000_000_000;

describe("AutoRefreshScheduler — prime that returns no reset time", () => {
	it("records the prime so the first-time branch cannot fire again", async () => {
		const db = makeDb();
		const scheduler = await makeScheduler(db, makeBareOkDispatch());
		const row = makeRow();

		expect(scheduler.lastRefreshResetTime.has(row.id)).toBe(false);
		expect(scheduler.shouldRefreshAccount(row, NOW)).toBe(true);

		await scheduler.sendTranslatedClaudePrime(row);

		expect(scheduler.lastRefreshResetTime.has(row.id)).toBe(true);
		// With an entry present and no reset on the row, the "no rate_limit_reset
		// available" skip owns the decision.
		expect(scheduler.shouldRefreshAccount(row, NOW)).toBe(false);
	});

	/**
	 * The recorded value is the column as it stood, not the wall clock. An
	 * observation that later writes a NEWER reset must still trip
	 * isNewerThanLastRefresh, which comparing against `now` would mask for any
	 * reset inside the next few minutes.
	 */
	it("records the account's current reset rather than the prime instant", async () => {
		const db = makeDb();
		const scheduler = await makeScheduler(db, makeBareOkDispatch());
		const existingReset = NOW - 5 * 60 * 1000;
		const row = makeRow({ rate_limit_reset: existingReset });

		await scheduler.sendTranslatedClaudePrime(row);

		expect(scheduler.lastRefreshResetTime.get(row.id)).toBe(existingReset);
		expect(
			scheduler.shouldRefreshAccount(
				{ ...row, rate_limit_reset: existingReset + 60_000 },
				NOW,
			),
		).toBe(true);
	});

	/**
	 * Guards the first test against a vacuous pass: the prime really did reach
	 * the dispatch seam, so "entry recorded" describes a completed prime.
	 */
	it("dispatches the prime (the recording assertion is not vacuous)", async () => {
		const db = makeDb();
		const dispatch = makeBareOkDispatch();
		const scheduler = await makeScheduler(db, dispatch);

		await scheduler.sendTranslatedClaudePrime(makeRow());

		expect(dispatch).toHaveBeenCalledTimes(1);
	});
});
