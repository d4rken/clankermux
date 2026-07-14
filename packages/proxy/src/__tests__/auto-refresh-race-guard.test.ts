/**
 * Regression test: query-to-dispatch race in AutoRefreshScheduler.
 *
 * checkAndRefresh() SELECTs a batch of auto_refresh_enabled=1 accounts, then
 * awaits sendTranslatedClaudePrime(row) per anthropic/zai account (and, once per
 * cycle, for the weekly-dormant prime). Each sendTranslatedClaudePrime awaits a
 * network dispatch, so an operator can toggle auto_refresh_enabled OFF in the
 * dashboard between the batch SELECT and a given account's dispatch.
 * sendTranslatedClaudePrime re-reads the CURRENT flag at the very top and MUST
 * skip the probe — no upstream dispatch, real quota preserved — when it is now 0
 * (or the row was deleted mid-pass).
 *
 * The single guard covers BOTH callers (the 5h refresh loop and the
 * weekly-dormant prime) because both route through sendTranslatedClaudePrime.
 *
 * Strategy: mock.module("../dispatch") so we can observe whether the scheduler
 * dispatched, then call sendTranslatedClaudePrime directly (private, reached via
 * cast) with a mock db whose re-check query returns 0 / 1 / [] per scenario.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Module mock — declared before importing the scheduler so bun's resolution
// picks up the mocked dispatchProxyRequest.
// ---------------------------------------------------------------------------

const dispatchCalls: Array<{ req: Request; url: URL }> = [];
let nextDispatchStatus = 500;
const mockDispatchProxyRequest = mock(async (req: Request, url: URL) => {
	dispatchCalls.push({ req, url });
	return new Response("", { status: nextDispatchStatus });
});

mock.module("../dispatch", () => ({
	dispatchProxyRequest: mockDispatchProxyRequest,
}));

// Import AFTER mock.module so the scheduler binds the mocked dispatch.
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FlagRow = { auto_refresh_enabled: number };

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

/**
 * Mock db whose `query` always returns the given re-check rows. When
 * sendTranslatedClaudePrime is called directly the ONLY query it issues is the
 * mid-pass auto_refresh_enabled re-read, so this cleanly drives the guard branch.
 */
function makeDb(recheckRows: FlagRow[]) {
	const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
	return {
		query: mock(async (sql: string, params: unknown[]) => {
			queryCalls.push({ sql, params });
			return recheckRows;
		}),
		run: mock(async () => {}),
		runWithChanges: mock(async () => 1),
		queryCalls,
	};
}

function makeProxyContext() {
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
	};
}

type SchedulerInternals = AutoRefreshScheduler & {
	sendTranslatedClaudePrime(row: AccountRow): Promise<boolean>;
};

function makeScheduler(db: ReturnType<typeof makeDb>): SchedulerInternals {
	return new AutoRefreshScheduler(
		db as never,
		makeProxyContext() as never,
	) as never as SchedulerInternals;
}

function makeRow(overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		id: "acc-1",
		name: "backup",
		provider: "anthropic",
		refresh_token: "rt",
		access_token: "at",
		expires_at: null,
		rate_limit_reset: null,
		custom_endpoint: null,
		paused: 0,
		auto_pause_on_overage_enabled: 0,
		pause_reason: null,
		...overrides,
	};
}

beforeEach(() => {
	dispatchCalls.length = 0;
	mockDispatchProxyRequest.mockClear();
	nextDispatchStatus = 500;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AutoRefreshScheduler — query-to-dispatch race guard", () => {
	it("skips dispatch and returns false when auto_refresh_enabled flipped to 0 since selection", async () => {
		const db = makeDb([{ auto_refresh_enabled: 0 }]);
		const scheduler = makeScheduler(db);

		const result = await scheduler.sendTranslatedClaudePrime(makeRow());

		expect(result).toBe(false);
		// No probe was dispatched — real quota preserved.
		expect(dispatchCalls.length).toBe(0);
		expect(mockDispatchProxyRequest).not.toHaveBeenCalled();

		// It re-read the CURRENT flag keyed by this account's id.
		const recheck = db.queryCalls.find((c) =>
			c.sql.includes("auto_refresh_enabled"),
		);
		expect(recheck).toBeDefined();
		expect(recheck?.params).toEqual(["acc-1"]);
	});

	it("skips dispatch and returns false when the account row is gone (deleted mid-pass)", async () => {
		const db = makeDb([]); // no row for this id
		const scheduler = makeScheduler(db);

		const result = await scheduler.sendTranslatedClaudePrime(makeRow());

		expect(result).toBe(false);
		expect(mockDispatchProxyRequest).not.toHaveBeenCalled();
	});

	it("proceeds to dispatch when the re-read flag is still 1", async () => {
		const db = makeDb([{ auto_refresh_enabled: 1 }]);
		const scheduler = makeScheduler(db);

		// Dispatch stub returns 500, so the method ultimately takes the failure
		// path and returns false — but the point under test is that it DISPATCHED
		// (the guard let a still-enabled account through), unlike the cases above.
		await scheduler.sendTranslatedClaudePrime(makeRow());

		expect(mockDispatchProxyRequest).toHaveBeenCalled();
		expect(dispatchCalls.length).toBeGreaterThanOrEqual(1);
	});
});
