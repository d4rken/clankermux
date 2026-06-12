/**
 * Tests for `createUsagePollingTokenProvider` — the token provider used by the
 * 90s usage-polling loop. The provider must NEVER touch paused state
 * (no resumeAccount/pauseAccount dance): the token refresh path doesn't check
 * paused state, and the old dance rewrote `pause_reason` to 'manual' on every
 * poll cycle, breaking auto-resume for overage/rate_limit_window pauses.
 */
import { describe, expect, it, mock } from "bun:test";
import type { ProxyContext } from "@clankermux/proxy";
import type { Account } from "@clankermux/types";
import { createUsagePollingTokenProvider } from "./usage-polling-token-provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		access_token: "stale-access",
		refresh_token: "stale-refresh",
		expires_at: 1_000,
		paused: true,
		...overrides,
	} as Account;
}

interface FakeDbOps {
	getAccount: ReturnType<typeof mock>;
	resumeAccount: ReturnType<typeof mock>;
	pauseAccount: ReturnType<typeof mock>;
}

function makeProxyContext(dbRow: Partial<Account> | null): {
	proxyContext: ProxyContext;
	dbOps: FakeDbOps;
} {
	const dbOps: FakeDbOps = {
		getAccount: mock(() => Promise.resolve(dbRow)),
		resumeAccount: mock(() => {}),
		pauseAccount: mock(() => {}),
	};
	return {
		proxyContext: { dbOps } as unknown as ProxyContext,
		dbOps,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createUsagePollingTokenProvider", () => {
	it("never pauses/resumes a paused account and returns the token", async () => {
		const account = makeAccount({
			paused: true,
			pause_reason: "overage",
		} as Partial<Account>);
		const { proxyContext, dbOps } = makeProxyContext({
			...account,
			access_token: "fresh-access",
		});
		const getValidAccessToken = mock(() => Promise.resolve("the-token"));

		const tokenProvider = createUsagePollingTokenProvider(
			account,
			proxyContext,
			{ getValidAccessToken },
		);
		const token = await tokenProvider();

		expect(token).toBe("the-token");
		expect(dbOps.resumeAccount).not.toHaveBeenCalled();
		expect(dbOps.pauseAccount).not.toHaveBeenCalled();
		// In-memory paused state stays untouched too
		expect(account.paused).toBe(true);
	});

	it("syncs token fields from the DB row into the in-memory account before refreshing", async () => {
		const account = makeAccount({
			access_token: "stale-access",
			refresh_token: "stale-refresh",
			expires_at: 1_000,
		});
		const { proxyContext } = makeProxyContext({
			id: account.id,
			access_token: "db-access",
			refresh_token: "db-refresh",
			expires_at: 2_000,
		});
		let tokensAtCall: {
			access: string | null | undefined;
			refresh: string | null | undefined;
			expires: number | null | undefined;
		} | null = null;
		const getValidAccessToken = mock((acct: Account) => {
			tokensAtCall = {
				access: acct.access_token,
				refresh: acct.refresh_token,
				expires: acct.expires_at,
			};
			return Promise.resolve("ok");
		});

		const tokenProvider = createUsagePollingTokenProvider(
			account,
			proxyContext,
			{ getValidAccessToken },
		);
		await tokenProvider();

		expect(account.access_token).toBe("db-access");
		expect(account.refresh_token).toBe("db-refresh");
		expect(account.expires_at).toBe(2_000);
		// The sync happened BEFORE the token getter ran
		expect(tokensAtCall).toEqual({
			access: "db-access",
			refresh: "db-refresh",
			expires: 2_000,
		});
	});

	it("still calls the token getter when getAccount returns null (no sync)", async () => {
		const account = makeAccount({ access_token: "keep-me" });
		const { proxyContext, dbOps } = makeProxyContext(null);
		const getValidAccessToken = mock(() => Promise.resolve("token-anyway"));

		const tokenProvider = createUsagePollingTokenProvider(
			account,
			proxyContext,
			{ getValidAccessToken },
		);
		const token = await tokenProvider();

		expect(token).toBe("token-anyway");
		expect(account.access_token).toBe("keep-me");
		expect(getValidAccessToken).toHaveBeenCalledTimes(1);
		expect(dbOps.resumeAccount).not.toHaveBeenCalled();
		expect(dbOps.pauseAccount).not.toHaveBeenCalled();
	});

	it("propagates token getter errors without any pause/resume calls", async () => {
		const account = makeAccount({ paused: true });
		const { proxyContext, dbOps } = makeProxyContext({ ...account });
		const getValidAccessToken = mock(() =>
			Promise.reject(new Error("refresh failed")),
		);

		const tokenProvider = createUsagePollingTokenProvider(
			account,
			proxyContext,
			{ getValidAccessToken },
		);

		await expect(tokenProvider()).rejects.toThrow("refresh failed");
		expect(dbOps.resumeAccount).not.toHaveBeenCalled();
		expect(dbOps.pauseAccount).not.toHaveBeenCalled();
		expect(account.paused).toBe(true);
	});
});
