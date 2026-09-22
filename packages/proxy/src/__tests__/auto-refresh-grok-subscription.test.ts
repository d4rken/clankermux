/**
 * The proactive half of the grok-subscription token lifecycle: the scheduler
 * selects accounts whose six-hour xAI access token is due, then hands each row
 * to the shared proactive refresher, which dispatches polymorphically to the
 * provider and owns the anchor-keyed compare-and-swap write.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";

type SchedulerInternals = {
	checkAndRefreshGrokSubscriptionTokens(): Promise<void>;
	checkGrokSubscriptionState(): Promise<void>;
};

const ROW = {
	id: "grok-sub-1",
	name: "supergrok",
	provider: "grok-subscription",
	refresh_token: "rt-old",
	access_token: "at-old",
	expires_at: 0,
	custom_endpoint: null,
};

function setup(rows: Array<typeof ROW>) {
	const queries: Array<{ sql: string; params: unknown[] }> = [];
	const db = {
		query: mock(async (sql: string, params: unknown[]) => {
			queries.push({ sql, params });
			return rows;
		}),
		run: mock(async () => {}),
		runWithChanges: mock(async () => 1),
	};
	const updateAccountTokens = mock(async () => true);
	const touchAccountSubscriptionCheck = mock(async () => {});
	const dbOps = {
		getAccount: mock(async () => ({ id: ROW.id, disabled: 0 })),
		updateAccountTokens,
		pauseAccountIfActive: mock(async () => false),
		touchAccountSubscriptionCheck,
	};
	const scheduler = new AutoRefreshScheduler(
		db as never,
		{
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
			dbOps,
		} as never,
	) as never as SchedulerInternals;
	return {
		scheduler,
		queries,
		updateAccountTokens,
		touchAccountSubscriptionCheck,
	};
}

describe("AutoRefreshScheduler — proactive grok-subscription refresh", () => {
	afterEach(() => {
		spyOn(globalThis, "fetch").mockRestore();
	});

	it("selects grok-subscription accounts whose access token is missing or due", async () => {
		const { scheduler, queries } = setup([]);

		await scheduler.checkAndRefreshGrokSubscriptionTokens();

		const select = queries.find((q) => q.sql.includes("grok-subscription"));
		expect(select).toBeDefined();
		expect(select?.sql).toContain("refresh_token IS NOT NULL");
		expect(select?.sql).toContain("access_token IS NULL");
		expect(select?.sql).toContain("expires_at <= ?");
	});

	it("persists the rotated refresh token against the token it exchanged", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					access_token: "at-new",
					refresh_token: "rt-new",
					expires_in: 21600,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const { scheduler, updateAccountTokens } = setup([ROW]);

		await scheduler.checkAndRefreshGrokSubscriptionTokens();

		expect(updateAccountTokens).toHaveBeenCalledTimes(1);
		const [id, accessToken, , refreshToken, , expectedRefreshToken] =
			updateAccountTokens.mock.calls[0] as unknown[];
		expect(id).toBe(ROW.id);
		expect(accessToken).toBe("at-new");
		expect(refreshToken).toBe("rt-new");
		// The compare-and-swap anchor is the generation this attempt spent, so a
		// concurrent rotation wins instead of being overwritten.
		expect(expectedRefreshToken).toBe("rt-old");
	});

	it("selects grok-subscription accounts with a live token whose subscription read is due", async () => {
		const { scheduler, queries } = setup([]);

		await scheduler.checkGrokSubscriptionState();

		const select = queries.find((q) => q.sql.includes("grok-subscription"));
		expect(select?.sql).toContain("disabled = 0");
		expect(select?.sql).toContain("expires_at > ?");
		expect(select?.sql).toContain("identity_subscription_checked_at IS NULL");
		expect(select?.sql).toContain("identity_subscription_checked_at <= ?");
		const [now, dueBefore] = select?.params as number[];
		expect(now - dueBefore).toBe(6 * 60 * 60 * 1000);
	});

	it("reads grok.com with the stored access token and records the attempt", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("unavailable", { status: 503 }),
		);
		const { scheduler, touchAccountSubscriptionCheck } = setup([
			{ ...ROW, access_token: "at-live", expires_at: Date.now() + 3_600_000 },
		]);

		await scheduler.checkGrokSubscriptionState();

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://grok.com/rest/subscriptions");
		expect(new Headers(init.headers).get("authorization")).toBe(
			"Bearer at-live",
		);
		expect(touchAccountSubscriptionCheck).toHaveBeenCalledTimes(1);
	});
});
