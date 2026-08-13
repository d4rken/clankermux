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

	it("does NOT let a stale DB row clobber fresher in-memory tokens (issued_at / expiry guards)", async () => {
		// A request-path refresh just rotated the tokens in memory, but its DB
		// persist has not landed (or failed). The poller's pre-poll sync must not
		// overwrite the fresher in-memory credentials with the stale DB row —
		// that would guarantee a replay of the consumed refresh token.
		const account = makeAccount({
			access_token: "mem-fresh-access",
			refresh_token: "mem-rotated-refresh",
			expires_at: 5_000,
			refresh_token_issued_at: 1_000,
		} as Partial<Account>);
		const { proxyContext } = makeProxyContext({
			id: account.id,
			access_token: "db-stale-access",
			refresh_token: "db-consumed-refresh",
			expires_at: 4_000,
			refresh_token_issued_at: 500,
		});
		const getValidAccessToken = mock(() => Promise.resolve("ok"));

		const tokenProvider = createUsagePollingTokenProvider(
			account,
			proxyContext,
			{ getValidAccessToken },
		);
		await tokenProvider();

		expect(account.access_token).toBe("mem-fresh-access");
		expect(account.expires_at).toBe(5_000);
		expect(account.refresh_token).toBe("mem-rotated-refresh");
		expect(account.refresh_token_issued_at).toBe(1_000);
	});

	it("adopts a re-auth's newer credentials from the DB (issued_at newer than memory)", async () => {
		const account = makeAccount({
			access_token: "mem-old-access",
			refresh_token: "mem-old-refresh",
			expires_at: 4_000,
			refresh_token_issued_at: 500,
		} as Partial<Account>);
		const { proxyContext } = makeProxyContext({
			id: account.id,
			access_token: "db-reauth-access",
			refresh_token: "db-reauth-refresh",
			expires_at: 9_000,
			refresh_token_issued_at: 2_000,
		});
		const getValidAccessToken = mock(() => Promise.resolve("ok"));

		const tokenProvider = createUsagePollingTokenProvider(
			account,
			proxyContext,
			{ getValidAccessToken },
		);
		await tokenProvider();

		expect(account.access_token).toBe("db-reauth-access");
		expect(account.expires_at).toBe(9_000);
		expect(account.refresh_token).toBe("db-reauth-refresh");
		expect(account.refresh_token_issued_at).toBe(2_000);
	});

	it("adopts a newer-generation access token even when its expiry is SHORTER than the stale one", async () => {
		// A re-auth's access token can expire sooner than a stale pre-re-auth
		// token (different lifetimes); the newer generation must still win — the
		// pre-re-auth token may be revoked.
		const account = makeAccount({
			access_token: "mem-pre-reauth-access",
			refresh_token: "mem-pre-reauth-refresh",
			expires_at: 9_000,
			refresh_token_issued_at: 500,
		} as Partial<Account>);
		const { proxyContext } = makeProxyContext({
			id: account.id,
			access_token: "db-reauth-access",
			refresh_token: "db-reauth-refresh",
			expires_at: 8_000,
			refresh_token_issued_at: 2_000,
		});
		const getValidAccessToken = mock(() => Promise.resolve("ok"));

		const tokenProvider = createUsagePollingTokenProvider(
			account,
			proxyContext,
			{ getValidAccessToken },
		);
		await tokenProvider();

		expect(account.access_token).toBe("db-reauth-access");
		expect(account.expires_at).toBe(8_000);
		expect(account.refresh_token).toBe("db-reauth-refresh");
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
