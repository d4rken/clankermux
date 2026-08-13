import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { OAuthRefreshTokenError, TokenRefreshError } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";
import {
	clearAllPendingRotationsForTests,
	getPendingRotation,
	type PendingRotationWriter,
	recordPendingRotation,
} from "../pending-rotation-registry";
import type { ProxyContext } from "../proxy-types";
import {
	getCoalescibleRecentRefresh,
	recordRecentRefresh,
	refreshAccessTokenSafe,
} from "../token-manager";

/**
 * Token-refresh single-flight coalescing + catch-block log gating.
 *
 * OAuth providers ROTATE refresh tokens: a successful refresh returns a NEW
 * refresh token and immediately invalidates the OLD one. Two refresh triggers
 * firing ~1-2s apart (e.g. AutoRefreshScheduler + an on-demand request) each
 * hold their own stale `account` snapshot; the first wins and rotates, the
 * second races with the now-invalidated old token and fails invalid_grant.
 *
 * These tests call `refreshAccessTokenSafe` directly with a mocked provider
 * (via `ctx.provider`, since `getProvider("mock-provider")` returns undefined).
 * Module-level maps (recentRefreshes/refreshFailures/backoff) persist across
 * tests in a run, so every test uses a UNIQUE account id.
 */

interface RefreshResult {
	accessToken: string;
	expiresAt: number;
	refreshToken?: string;
}

function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: `acct-${id}`,
		provider: "mock-provider",
		access_token: "stale-token",
		expires_at: Date.now() - 1000, // already expired → normally would refresh
		refresh_token: "rt-old",
		last_used: null,
		...overrides,
	} as Account;
}

function makeContext(
	refreshToken: (account: Account, clientId: string) => Promise<RefreshResult>,
	pauseResult = false,
	opts: {
		updateAccountTokens?: (...args: unknown[]) => Promise<boolean>;
		getAccount?: (accountId: string) => Promise<Account | null>;
	} = {},
): {
	ctx: ProxyContext;
	refreshTokenSpy: ReturnType<typeof mock>;
	pauseSpy: ReturnType<typeof mock>;
	updateTokensSpy: ReturnType<typeof mock>;
	getAccountSpy: ReturnType<typeof mock>;
	enqueueSpy: ReturnType<typeof mock>;
} {
	const refreshTokenSpy = mock(refreshToken);
	const pauseSpy = mock(async () => pauseResult);
	// The durable token write is AWAITED inside the refresh promise; the normal
	// path returns a resolved true (persisted). Callers override with false (CAS
	// loss), a rejection (write failure), or a gated promise (settlement order).
	const updateTokensSpy = mock(opts.updateAccountTokens ?? (async () => true));
	const getAccountSpy = mock(opts.getAccount ?? (async () => null));
	// The refresh path must NOT route the token write through the async writer
	// (a droppable queue); tests assert this spy is never called.
	const enqueueSpy = mock((job: () => void | Promise<void>) => {
		const r = job();
		if (r && typeof (r as Promise<void>).catch === "function") {
			(r as Promise<void>).catch(() => {});
		}
		return true;
	});
	const ctx = {
		refreshInFlight: new Map<string, Promise<string>>(),
		runtime: { clientId: "test-client" } as never,
		asyncWriter: { enqueue: enqueueSpy } as never,
		dbOps: {
			getAccount: getAccountSpy,
			updateAccountTokens: updateTokensSpy,
			pauseAccountIfActive: pauseSpy,
		} as never,
		provider: { refreshToken: refreshTokenSpy } as never,
	} as ProxyContext;
	return {
		ctx,
		refreshTokenSpy,
		pauseSpy,
		updateTokensSpy,
		getAccountSpy,
		enqueueSpy,
	};
}

const HOUR_MS = 60 * 60 * 1000;

// The pending-rotation registry is module-level state shared with every other
// test in this file; a leftover entry would change the next test's flush outcome.
afterEach(() => {
	clearAllPendingRotationsForTests();
});

describe("refreshAccessTokenSafe single-flight coalescing", () => {
	it("reuses a very-recent successful refresh instead of racing a second rotation", async () => {
		const { ctx, refreshTokenSpy } = makeContext(async () => ({
			accessToken: "fresh-1",
			expiresAt: Date.now() + HOUR_MS,
			refreshToken: "rt-new",
		}));

		// First caller: performs the real refresh and populates the coalesce cache.
		const first = await refreshAccessTokenSafe(makeAccount("coalesce-1"), ctx);
		expect(first).toBe("fresh-1");
		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);

		// Second caller within the window, still holding a STALE snapshot (old
		// refresh token). Must reuse the cached token, NOT fire a second rotation.
		const staleSnapshot = makeAccount("coalesce-1");
		const second = await refreshAccessTokenSafe(staleSnapshot, ctx);
		expect(second).toBe("fresh-1");
		// Provider was called exactly once across both callers.
		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
		// The stale caller's in-memory snapshot was updated with the fresh token.
		expect(staleSnapshot.access_token).toBe("fresh-1");
		expect(staleSnapshot.expires_at).toBeGreaterThan(Date.now());
	});

	it("does NOT coalesce when the caller's current token equals the cached one (forces a real refresh)", () => {
		// A caller whose CURRENT access token IS the cached fresh token was almost
		// certainly just rejected upstream while holding that exact token — reusing
		// it would serve the failing token straight back. The guard must decline.
		recordRecentRefresh("f3-guard", "same-token", Date.now() + HOUR_MS);
		// Same token as cached → not coalescible.
		expect(getCoalescibleRecentRefresh("f3-guard", "same-token")).toBeNull();
		// A different (older) token → coalescible.
		expect(getCoalescibleRecentRefresh("f3-guard", "older-token")).toEqual({
			accessToken: "same-token",
			expiresAt: expect.any(Number),
		});
	});

	it("forces a real refresh when the caller already holds the cached token (integration)", async () => {
		let call = 0;
		const { ctx, refreshTokenSpy } = makeContext(async () => {
			call += 1;
			return {
				accessToken: call === 1 ? "fresh-1" : "fresh-2",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: `rt-${call}`,
			};
		});

		// First caller populates the coalesce cache with "fresh-1".
		const first = await refreshAccessTokenSafe(
			makeAccount("f3-integration"),
			ctx,
		);
		expect(first).toBe("fresh-1");
		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);

		// Second caller ALREADY holds "fresh-1" (its own token was rejected upstream).
		// Coalesce must be skipped so a genuine rotation runs → "fresh-2".
		const second = await refreshAccessTokenSafe(
			makeAccount("f3-integration", { access_token: "fresh-1" }),
			ctx,
		);
		expect(second).toBe("fresh-2");
		expect(refreshTokenSpy).toHaveBeenCalledTimes(2);
	});

	it("refreshes again when the cached token lacks comfortable headroom", async () => {
		let call = 0;
		const { ctx, refreshTokenSpy } = makeContext(async () => {
			call += 1;
			return call === 1
				? {
						// Below RECENT_REFRESH_MIN_HEADROOM_MS (60s) → not reusable.
						accessToken: "fresh-A",
						expiresAt: Date.now() + 30_000,
						refreshToken: "rt-A",
					}
				: {
						accessToken: "fresh-B",
						expiresAt: Date.now() + HOUR_MS,
						refreshToken: "rt-B",
					};
		});

		const first = await refreshAccessTokenSafe(makeAccount("headroom-1"), ctx);
		expect(first).toBe("fresh-A");
		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);

		// Cached token is within the coalesce WINDOW but its remaining validity is
		// under the headroom floor → coalesce is skipped and a fresh refresh runs.
		const second = await refreshAccessTokenSafe(makeAccount("headroom-1"), ctx);
		expect(second).toBe("fresh-B");
		expect(refreshTokenSpy).toHaveBeenCalledTimes(2);
	});
});

describe("refreshAccessTokenSafe catch-block log gating", () => {
	let errorSpy: ReturnType<typeof spyOn>;
	let infoSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		errorSpy?.mockRestore();
		infoSpy?.mockRestore();
	});

	const REFRESH_FAILED_MSG = "Token refresh failed for account";
	const SUPERSEDED_MSG = "was not newly flagged for reauth";

	function errorCallsMatching(substr: string): number {
		return errorSpy.mock.calls.filter(
			(args) => typeof args[0] === "string" && args[0].includes(substr),
		).length;
	}
	function infoCallsMatching(substr: string): number {
		return infoSpy.mock.calls.filter(
			(args) => typeof args[0] === "string" && args[0].includes(substr),
		).length;
	}

	it("logs quietly (INFO, no ERROR) for an invalid_grant whose account is NOT newly paused (race loser)", async () => {
		errorSpy = spyOn(Logger.prototype, "error");
		infoSpy = spyOn(Logger.prototype, "info");
		// invalid_grant error, but pause guard returns false → stored refresh token
		// already rotated by a concurrent refresh: a benign race loser.
		const { ctx, pauseSpy } = makeContext(async () => {
			throw new OAuthRefreshTokenError("race-loser", "refresh rejected");
		}, false);

		let thrown: unknown;
		try {
			await refreshAccessTokenSafe(makeAccount("race-loser"), ctx);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(TokenRefreshError);
		expect((thrown as TokenRefreshError).isInvalidGrant).toBe(true);
		// pause was attempted with the failing refresh token as the guard.
		expect(pauseSpy).toHaveBeenCalledTimes(1);
		expect(pauseSpy.mock.calls[0][2]).toBe("rt-old");
		// No alarming error log for this benign race; a quiet info instead.
		expect(errorCallsMatching(REFRESH_FAILED_MSG)).toBe(0);
		expect(infoCallsMatching(SUPERSEDED_MSG)).toBe(1);
	});

	it("does NOT double-log an error when the account IS newly paused (pause helper already logged)", async () => {
		errorSpy = spyOn(Logger.prototype, "error");
		infoSpy = spyOn(Logger.prototype, "info");
		const { ctx, pauseSpy } = makeContext(async () => {
			throw new OAuthRefreshTokenError("paused-acct", "refresh rejected");
		}, true);

		let thrown: unknown;
		try {
			await refreshAccessTokenSafe(makeAccount("paused-acct"), ctx);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(TokenRefreshError);
		expect((thrown as TokenRefreshError).isInvalidGrant).toBe(true);
		expect(pauseSpy).toHaveBeenCalledTimes(1);
		// The catch block itself must not emit the generic "refresh failed" error;
		// pauseAccountForReauthIfInvalidGrant owns the single PAUSED error log.
		expect(errorCallsMatching(REFRESH_FAILED_MSG)).toBe(0);
		// And it is NOT logged as a benign race either.
		expect(infoCallsMatching(SUPERSEDED_MSG)).toBe(0);
	});

	it("logs an ERROR for a non-auth transient failure (network/5xx)", async () => {
		errorSpy = spyOn(Logger.prototype, "error");
		infoSpy = spyOn(Logger.prototype, "info");
		const { ctx, pauseSpy } = makeContext(async () => {
			throw new Error("503 Service Unavailable");
		}, false);

		let thrown: unknown;
		try {
			await refreshAccessTokenSafe(makeAccount("transient-fail"), ctx);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(TokenRefreshError);
		expect((thrown as TokenRefreshError).isInvalidGrant).toBe(false);
		// Non-invalid-grant → pause helper no-ops (returns false without calling DB).
		expect(pauseSpy).not.toHaveBeenCalled();
		// Prior visibility preserved: an error IS logged.
		expect(errorCallsMatching(REFRESH_FAILED_MSG)).toBe(1);
		expect(infoCallsMatching(SUPERSEDED_MSG)).toBe(0);
	});
});

describe("refreshAccessTokenSafe awaited CAS persist", () => {
	it("AWAITS the durable write (the refresh does not resolve until the persist settles) with the exchanged refresh token as the CAS arg", async () => {
		const acctId = "awaited-persist";
		let resolvePersist: (v: boolean) => void = () => {};
		const persistGate = new Promise<boolean>((res) => {
			resolvePersist = res;
		});
		const { ctx, updateTokensSpy, enqueueSpy } = makeContext(
			async () => ({
				accessToken: "fresh-awaited",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-awaited-new",
			}),
			false,
			{ updateAccountTokens: () => persistGate },
		);

		const acct = makeAccount(acctId);
		let settled = false;
		const refreshP = refreshAccessTokenSafe(acct, ctx).then((t) => {
			settled = true;
			return t;
		});

		// Give the provider refresh and the persist call time to run; the refresh
		// must remain pending while the durable write is unsettled.
		await Bun.sleep(10);
		expect(updateTokensSpy).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);

		resolvePersist(true);
		expect(await refreshP).toBe("fresh-awaited");
		expect(acct.access_token).toBe("fresh-awaited");
		// The exchanged (pre-refresh) token is the 6th argument (the CAS backstop).
		expect(updateTokensSpy.mock.calls[0][5]).toBe("rt-old");
		// Direct awaited write — never routed through the droppable async writer.
		expect(enqueueSpy).not.toHaveBeenCalled();

		// The fresh token IS cached for coalescing (a caller with an older token reuses it).
		expect(getCoalescibleRecentRefresh(acctId, "older-token")).toEqual({
			accessToken: "fresh-awaited",
			expiresAt: expect.any(Number),
		});
	});

	it("adopts the authoritative DB credentials when the persist CAS loses (a concurrent rotation/re-auth won)", async () => {
		const acctId = "cas-loss-adopt";
		const dbExpiry = Date.now() + 2 * HOUR_MS;
		let getAccountCalls = 0;
		const { ctx, refreshTokenSpy } = makeContext(
			async () => ({
				accessToken: "fresh-losing",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-losing",
			}),
			false,
			{
				// CAS loss: the stored refresh token changed underneath.
				updateAccountTokens: async () => false,
				getAccount: async () => {
					getAccountCalls += 1;
					// First read is the pre-refresh adoption check — return null so the
					// refresh actually fires. Second read is the post-CAS-loss re-read —
					// return the winner's (authoritative) credentials.
					if (getAccountCalls === 1) return null;
					return {
						id: acctId,
						access_token: "db-winner-access",
						expires_at: dbExpiry,
						refresh_token: "rt-winner",
						refresh_token_issued_at: 777,
					} as Account;
				},
			},
		);

		const acct = makeAccount(acctId);
		const token = await refreshAccessTokenSafe(acct, ctx);

		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
		// The caller gets the WINNER's token, not the losing just-minted one — the
		// winning rotation/re-auth may have invalidated the loser's session family.
		expect(token).toBe("db-winner-access");
		expect(acct.access_token).toBe("db-winner-access");
		expect(acct.expires_at).toBe(dbExpiry);
		expect(acct.refresh_token).toBe("rt-winner");
		expect(acct.refresh_token_issued_at).toBe(777);
		// The losing token must NOT be cached for coalescing.
		expect(getCoalescibleRecentRefresh(acctId, "older-token")).toBeNull();
	});

	it("serves the minted token when the persist CAS loses and no servable authoritative row exists", async () => {
		const acctId = "cas-loss-fallback";
		const { ctx } = makeContext(
			async () => ({
				accessToken: "fresh-minted",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-minted",
			}),
			false,
			{
				updateAccountTokens: async () => false,
				getAccount: async () => null,
			},
		);

		const acct = makeAccount(acctId);
		const token = await refreshAccessTokenSafe(acct, ctx);

		// Last resort: the minted token still works for THIS caller.
		expect(token).toBe("fresh-minted");
		expect(acct.access_token).toBe("fresh-minted");
		// But it is not advertised to other callers via the coalesce cache.
		expect(getCoalescibleRecentRefresh(acctId, "older-token")).toBeNull();
	});

	it("still serves AND caches the minted token when the persist write THROWS (loss is loud, not silent)", async () => {
		const acctId = "persist-throws";
		const errorSpy = spyOn(Logger.prototype, "error");
		try {
			const { ctx } = makeContext(
				async () => ({
					accessToken: "fresh-unpersisted",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-unpersisted",
				}),
				false,
				{
					updateAccountTokens: async () => {
						throw new Error("disk I/O error");
					},
				},
			);

			const acct = makeAccount(acctId);
			const token = await refreshAccessTokenSafe(acct, ctx);

			// The refresh itself succeeded; the caller is served the minted token.
			expect(token).toBe("fresh-unpersisted");
			expect(acct.access_token).toBe("fresh-unpersisted");
			// The write failure is reported loudly.
			expect(
				errorSpy.mock.calls.some(
					(args) =>
						typeof args[0] === "string" &&
						args[0].includes("Failed to persist refreshed tokens"),
				),
			).toBe(true);
			// The token IS cached: while the DB row is stale, the coalesce cache is
			// the only thing masking a doomed second rotation.
			expect(getCoalescibleRecentRefresh(acctId, "older-token")).toEqual({
				accessToken: "fresh-unpersisted",
				expiresAt: expect.any(Number),
			});
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe("refreshAccessTokenSafe review-hardening regressions", () => {
	it("stamps the in-memory refresh_token_issued_at BEFORE the persist (a later re-auth can never look older)", async () => {
		const acctId = "stamp-before-persist";
		let resolvePersist: (v: boolean) => void = () => {};
		const persistGate = new Promise<boolean>((res) => {
			resolvePersist = res;
		});
		const { ctx } = makeContext(
			async () => ({
				accessToken: "fresh-stamp",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-stamp",
			}),
			false,
			{ updateAccountTokens: () => persistGate },
		);

		const acct = makeAccount(acctId);
		const refreshP = refreshAccessTokenSafe(acct, ctx);
		// Hold the persist open long enough that a stamp taken AFTER it would be
		// measurably later than this reference point.
		await Bun.sleep(15);
		const beforePersistSettled = Date.now();
		resolvePersist(true);
		await refreshP;

		expect(acct.refresh_token_issued_at).not.toBeNull();
		// A re-auth landing while the persist was in flight would stamp its row
		// at ~beforePersistSettled; our in-memory stamp must not exceed it, or
		// the staleness guards would reject the re-auth's newer token as older.
		expect(acct.refresh_token_issued_at as number).toBeLessThanOrEqual(
			beforePersistSettled,
		);
	});

	it("pauses against the EXCHANGED refresh token even when the shared account object was mutated mid-refresh", async () => {
		const { ctx, pauseSpy } = makeContext(async (account) => {
			// Simulate a concurrent writer (e.g. the usage poller's pre-poll sync)
			// installing a newer token on the shared object while this refresh's
			// network call is in flight.
			account.refresh_token = "rt-hijacked-newer";
			throw new OAuthRefreshTokenError("pause-key", "refresh rejected");
		}, false);

		let thrown: unknown;
		try {
			await refreshAccessTokenSafe(makeAccount("pause-key"), ctx);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(TokenRefreshError);
		expect(pauseSpy).toHaveBeenCalledTimes(1);
		// The pause CAS must target the token this attempt actually exchanged —
		// pausing against the newer token would match and pause the healthy row.
		expect(pauseSpy.mock.calls[0][2]).toBe("rt-old");
	});

	it("adopts the winner's refresh token on CAS loss even when its access token is not servable (losing generation never installed)", async () => {
		const acctId = "cas-loss-unservable";
		let getAccountCalls = 0;
		const { ctx } = makeContext(
			async () => ({
				accessToken: "fresh-losing2",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-losing2",
			}),
			false,
			{
				updateAccountTokens: async () => false,
				getAccount: async () => {
					getAccountCalls += 1;
					if (getAccountCalls === 1) return null; // pre-refresh adoption check
					return {
						id: acctId,
						// Winner's access token already expired → not servable…
						access_token: "db-winner-expired",
						expires_at: Date.now() - 1_000,
						// …but its refresh token is still the authority.
						refresh_token: "rt-winner2",
						refresh_token_issued_at: 4_242,
					} as Account;
				},
			},
		);

		const acct = makeAccount(acctId);
		const token = await refreshAccessTokenSafe(acct, ctx);

		// Minted ACCESS token served as last resort for this caller…
		expect(token).toBe("fresh-losing2");
		expect(acct.access_token).toBe("fresh-losing2");
		// …but the REFRESH generation in memory is the winner's, with the
		// winner's stamp — never the losing "rt-losing2" with a fresh stamp.
		expect(acct.refresh_token).toBe("rt-winner2");
		expect(acct.refresh_token_issued_at).toBe(4_242);
		expect(getCoalescibleRecentRefresh(acctId, "older-token")).toBeNull();
	});

	it("syncs a joiner's full snapshot from the DB when the winner's persist CAS lost (no coalesce entry)", async () => {
		const acctId = "superseded-joiner-sync";
		const dbExpiry = Date.now() + 2 * HOUR_MS;
		let getAccountCalls = 0;
		let resolveRefresh: (r: RefreshResult) => void = () => {};
		const refreshGate = new Promise<RefreshResult>((res) => {
			resolveRefresh = res;
		});
		const { ctx, refreshTokenSpy } = makeContext(() => refreshGate, false, {
			updateAccountTokens: async () => false, // CAS loss
			getAccount: async () => {
				getAccountCalls += 1;
				// First two reads are the winner's and joiner's pre-refresh adoption
				// checks; later reads (post-CAS-loss adopt + joiner sync) see the
				// authoritative winner row.
				if (getAccountCalls <= 2) return null;
				return {
					id: acctId,
					access_token: "db-winner-access",
					expires_at: dbExpiry,
					refresh_token: "rt-winner",
					refresh_token_issued_at: 999,
				} as Account;
			},
		});

		const winner = makeAccount(acctId);
		const joiner = makeAccount(acctId);
		const winnerP = refreshAccessTokenSafe(winner, ctx);
		const joinerP = refreshAccessTokenSafe(joiner, ctx);

		// Let both callers pass their pre-refresh re-reads and settle into
		// create/join before resolving the provider refresh.
		await Bun.sleep(10);
		resolveRefresh({
			accessToken: "fresh-losing-join",
			expiresAt: Date.now() + HOUR_MS,
			refreshToken: "rt-losing-join",
		});

		const [winnerToken, joinerToken] = await Promise.all([winnerP, joinerP]);
		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
		// Both callers receive the authoritative token…
		expect(winnerToken).toBe("db-winner-access");
		expect(joinerToken).toBe("db-winner-access");
		// …and the JOINER's own snapshot is fully synced from the DB row, not
		// left holding the consumed pre-refresh tokens.
		expect(joiner.access_token).toBe("db-winner-access");
		expect(joiner.refresh_token).toBe("rt-winner");
		expect(joiner.refresh_token_issued_at).toBe(999);
	});

	it("consumes a refresh that completed entirely inside the pre-refresh re-read window (coalesce re-check)", async () => {
		const acctId = "coalesce-after-reread";
		const { ctx, refreshTokenSpy } = makeContext(
			async () => ({
				accessToken: "should-not-rotate",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-should-not",
			}),
			false,
			{
				getAccount: async () => {
					// While this caller is blocked in the re-read, another refresh
					// starts, succeeds, caches its result, and unregisters.
					recordRecentRefresh(
						acctId,
						"cached-mid-reread",
						Date.now() + HOUR_MS,
					);
					return null;
				},
			},
		);

		const acct = makeAccount(acctId);
		const token = await refreshAccessTokenSafe(acct, ctx);

		// The cached result is consumed instead of exchanging the (now consumed)
		// refresh token a second time.
		expect(token).toBe("cached-mid-reread");
		expect(acct.access_token).toBe("cached-mid-reread");
		expect(refreshTokenSpy).not.toHaveBeenCalled();
	});
});

describe("refreshAccessTokenSafe pre-refresh DB adoption", () => {
	it("adopts a strictly-fresher valid access token from the DB and skips the refresh entirely", async () => {
		const acctId = "adopt-fresher-access";
		const dbExpiry = Date.now() + 2 * HOUR_MS;
		const { ctx, refreshTokenSpy } = makeContext(
			async () => ({
				accessToken: "should-not-run",
				expiresAt: Date.now() + HOUR_MS,
			}),
			false,
			{
				getAccount: async () =>
					({
						id: acctId,
						access_token: "db-fresh-access",
						expires_at: dbExpiry,
						refresh_token: "rt-db",
						refresh_token_issued_at: 555,
					}) as Account,
			},
		);

		const acct = makeAccount(acctId);
		const token = await refreshAccessTokenSafe(acct, ctx);

		expect(token).toBe("db-fresh-access");
		expect(refreshTokenSpy).not.toHaveBeenCalled();
		expect(acct.access_token).toBe("db-fresh-access");
		expect(acct.expires_at).toBe(dbExpiry);
		expect(acct.refresh_token).toBe("rt-db");
	});

	it("does NOT adopt a DB access token whose expiry is not strictly newer (a delayed read is not 'fresher')", async () => {
		const acctId = "adopt-equal-expiry";
		const sharedExpiry = Date.now() + HOUR_MS;
		const { ctx, refreshTokenSpy } = makeContext(
			async () => ({
				accessToken: "fresh-real",
				expiresAt: Date.now() + 2 * HOUR_MS,
				refreshToken: "rt-real",
			}),
			false,
			{
				getAccount: async () =>
					({
						id: acctId,
						access_token: "db-same-generation",
						expires_at: sharedExpiry,
						refresh_token: "rt-old",
						refresh_token_issued_at: null,
					}) as Account,
			},
		);

		// The caller holds a token of the SAME generation (equal expiry) that was
		// just rejected upstream — adopting it would serve a failing token back.
		const acct = makeAccount(acctId, {
			access_token: "rejected-token",
			expires_at: sharedExpiry,
		});
		const token = await refreshAccessTokenSafe(acct, ctx);

		expect(token).toBe("fresh-real");
		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
	});

	it("adopts a rotated refresh token from the DB before refreshing (never replays a consumed token)", async () => {
		const acctId = "adopt-rotated-rt";
		let refreshTokenAtCall: string | null = null;
		const { ctx, refreshTokenSpy, updateTokensSpy } = makeContext(
			async (account) => {
				refreshTokenAtCall = account.refresh_token;
				return {
					accessToken: "fresh-after-adopt",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-next",
				};
			},
			false,
			{
				getAccount: async () =>
					({
						id: acctId,
						// No servable access token → the refresh must still run…
						access_token: null,
						expires_at: null,
						// …but with the LIVE rotated refresh token, not the stale snapshot's.
						refresh_token: "rt-rotated",
						refresh_token_issued_at: 999,
					}) as Account,
			},
		);

		const acct = makeAccount(acctId); // snapshot holds stale "rt-old"
		const token = await refreshAccessTokenSafe(acct, ctx);

		expect(token).toBe("fresh-after-adopt");
		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
		expect(refreshTokenAtCall).toBe("rt-rotated");
		// The CAS arg follows the adopted token too.
		expect(updateTokensSpy.mock.calls[0][5]).toBe("rt-rotated");
	});

	it("adopts a differing DB access token at EQUAL expiry when its refresh generation is strictly newer", async () => {
		const acctId = "adopt-equal-expiry-newer-gen";
		const sharedExpiry = Date.now() + HOUR_MS;
		const { ctx, refreshTokenSpy } = makeContext(
			async () => ({
				accessToken: "should-not-run",
				expiresAt: Date.now() + HOUR_MS,
			}),
			false,
			{
				getAccount: async () =>
					({
						id: acctId,
						access_token: "db-newer-generation",
						// Equal (possibly rounded) expiry — but a strictly newer
						// issued_at proves a newer credential generation, so this is NOT
						// a delayed read of the caller's own rejected token.
						expires_at: sharedExpiry,
						refresh_token: "rt-newer-gen",
						refresh_token_issued_at: 2_000,
					}) as Account,
			},
		);

		const acct = makeAccount(acctId, {
			access_token: "rejected-old-gen",
			expires_at: sharedExpiry,
			refresh_token_issued_at: 1_000,
		} as Partial<Account>);
		const token = await refreshAccessTokenSafe(acct, ctx);

		expect(token).toBe("db-newer-generation");
		expect(refreshTokenSpy).not.toHaveBeenCalled();
		expect(acct.refresh_token).toBe("rt-newer-gen");
	});

	it("returns the ADOPTED token to a joiner when the authority moved on after the winner resolved", async () => {
		const acctId = "joiner-adopted-fresher";
		const dbExpiry = Date.now() + 2 * HOUR_MS;
		let getAccountCalls = 0;
		let resolveRefresh: (r: RefreshResult) => void = () => {};
		const refreshGate = new Promise<RefreshResult>((res) => {
			resolveRefresh = res;
		});
		const { ctx } = makeContext(() => refreshGate, false, {
			updateAccountTokens: async () => false, // winner's CAS loses
			getAccount: async () => {
				getAccountCalls += 1;
				// Calls 1+2: the two pre-refresh adoption checks → null.
				if (getAccountCalls <= 2) return null;
				// Call 3: winner's post-CAS-loss adoption → first authority.
				if (getAccountCalls === 3) {
					return {
						id: acctId,
						access_token: "authority-v1",
						expires_at: dbExpiry,
						refresh_token: "rt-auth-v1",
						refresh_token_issued_at: 100,
					} as Account;
				}
				// Call 4+: joiner's sync — a re-auth landed meanwhile.
				return {
					id: acctId,
					access_token: "authority-v2",
					expires_at: dbExpiry,
					refresh_token: "rt-auth-v2",
					refresh_token_issued_at: 200,
				} as Account;
			},
		});

		const winner = makeAccount(acctId);
		const joiner = makeAccount(acctId);
		const winnerP = refreshAccessTokenSafe(winner, ctx);
		const joinerP = refreshAccessTokenSafe(joiner, ctx);
		await Bun.sleep(10);
		resolveRefresh({
			accessToken: "fresh-losing-v",
			expiresAt: Date.now() + HOUR_MS,
			refreshToken: "rt-losing-v",
		});

		const [winnerToken, joinerToken] = await Promise.all([winnerP, joinerP]);
		expect(winnerToken).toBe("authority-v1");
		// The joiner's sync saw the NEWER authority — it must return that token,
		// never one older than the account state it just installed.
		expect(joinerToken).toBe("authority-v2");
		expect(joiner.access_token).toBe("authority-v2");
		expect(joiner.refresh_token).toBe("rt-auth-v2");
	});

	it("adopts a differing stamped DB access token at equal expiry when the snapshot is UNSTAMPED (defers to the DB)", async () => {
		const acctId = "adopt-equal-expiry-unstamped";
		const sharedExpiry = Date.now() + HOUR_MS;
		const { ctx, refreshTokenSpy } = makeContext(
			async () => ({
				accessToken: "should-not-run",
				expiresAt: Date.now() + HOUR_MS,
			}),
			false,
			{
				getAccount: async () =>
					({
						id: acctId,
						access_token: "db-stamped-token",
						expires_at: sharedExpiry,
						refresh_token: "rt-stamped",
						refresh_token_issued_at: 2_000,
					}) as Account,
			},
		);

		// Unstamped snapshot (e.g. scheduler-built) with a differing token at
		// equal expiry: per policy it defers to the stamped DB row.
		const acct = makeAccount(acctId, {
			access_token: "unstamped-old-token",
			expires_at: sharedExpiry,
		});
		const token = await refreshAccessTokenSafe(acct, ctx);

		expect(token).toBe("db-stamped-token");
		expect(refreshTokenSpy).not.toHaveBeenCalled();
	});

	it("nulls a joiner's expiry when handed a token of unknown expiry (unservable-authority corner)", async () => {
		const acctId = "joiner-unknown-expiry";
		let getAccountCalls = 0;
		let resolveRefresh: (r: RefreshResult) => void = () => {};
		const refreshGate = new Promise<RefreshResult>((res) => {
			resolveRefresh = res;
		});
		const { ctx } = makeContext(() => refreshGate, false, {
			updateAccountTokens: async () => false, // winner's CAS loses
			getAccount: async () => {
				getAccountCalls += 1;
				if (getAccountCalls <= 2) return null; // pre-refresh checks
				// Authority row readable but its access token is NOT servable.
				return {
					id: acctId,
					access_token: "db-winner-expired",
					expires_at: Date.now() - 1_000,
					refresh_token: "rt-winner3",
					refresh_token_issued_at: 4_243,
				} as Account;
			},
		});

		const winner = makeAccount(acctId);
		// A 401-rejected joiner can hold a FAR-FUTURE expiry for its rejected
		// token — that horizon must not be inherited by the minted token.
		const joiner = makeAccount(acctId, {
			access_token: "rejected-far-future",
			expires_at: Date.now() + 5 * HOUR_MS,
		});
		const winnerP = refreshAccessTokenSafe(winner, ctx);
		const joinerP = refreshAccessTokenSafe(joiner, ctx);
		await Bun.sleep(10);
		resolveRefresh({
			accessToken: "fresh-minted3",
			expiresAt: Date.now() + HOUR_MS,
			refreshToken: "rt-minted3",
		});

		const [winnerToken, joinerToken] = await Promise.all([winnerP, joinerP]);
		expect(winnerToken).toBe("fresh-minted3");
		expect(joinerToken).toBe("fresh-minted3");
		// The joiner's snapshot matches the returned token, with expiry UNKNOWN
		// (null → refresh before next use), never the rejected token's horizon.
		expect(joiner.access_token).toBe("fresh-minted3");
		expect(joiner.expires_at).toBeNull();
		// And the authoritative refresh generation was still adopted.
		expect(joiner.refresh_token).toBe("rt-winner3");
	});

	it("does NOT adopt a DB refresh token that is OLDER than the in-memory one (issued_at guard)", async () => {
		const acctId = "adopt-stale-rt-guard";
		let refreshTokenAtCall: string | null = null;
		const { ctx } = makeContext(
			async (account) => {
				refreshTokenAtCall = account.refresh_token;
				return {
					accessToken: "fresh-guarded",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-next",
				};
			},
			false,
			{
				getAccount: async () =>
					({
						id: acctId,
						access_token: null,
						expires_at: null,
						refresh_token: "rt-ancient",
						refresh_token_issued_at: 500,
					}) as Account,
			},
		);

		// The in-memory snapshot carries a NEWER rotation than the DB row (e.g. a
		// persist that has not landed yet) — the stale DB token must not win.
		const acct = makeAccount(acctId, {
			refresh_token_issued_at: 1_000,
		} as Partial<Account>);
		const token = await refreshAccessTokenSafe(acct, ctx);

		expect(token).toBe("fresh-guarded");
		expect(refreshTokenAtCall).toBe("rt-old");
	});
});

describe("refreshAccessTokenSafe backoff after a benign race loser", () => {
	it("does not poison backoff: a benign invalid_grant loser clears its failure record so the next refresh is not rejected", async () => {
		let call = 0;
		// First attempt: invalid_grant, but pause returns false (stored refresh token
		// already rotated by a concurrent refresh) → benign race loser. Second
		// attempt must be free to run a real refresh (no ServiceUnavailable backoff).
		const { ctx, refreshTokenSpy } = makeContext(async () => {
			call += 1;
			if (call === 1) {
				throw new OAuthRefreshTokenError(
					"race-loser-backoff",
					"refresh rejected",
				);
			}
			return {
				accessToken: "fresh-recover",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-recover",
			};
		}, false);

		// First (benign) failure.
		let firstErr: unknown;
		try {
			await refreshAccessTokenSafe(makeAccount("race-loser-backoff"), ctx);
		} catch (err) {
			firstErr = err;
		}
		expect(firstErr).toBeInstanceOf(TokenRefreshError);
		expect((firstErr as TokenRefreshError).isInvalidGrant).toBe(true);

		// Second refresh, immediately after: the cleared failure record means we are
		// NOT in backoff, so a real refresh runs and succeeds (no ServiceUnavailable).
		const second = await refreshAccessTokenSafe(
			makeAccount("race-loser-backoff"),
			ctx,
		);
		expect(second).toBe("fresh-recover");
		expect(refreshTokenSpy).toHaveBeenCalledTimes(2);
	});
});

describe("refreshAccessTokenSafe pending-rotation registry", () => {
	/** A pending entry as the registry would hold it after a thrown persist. */
	function seedPending(
		accountId: string,
		entry: {
			accessToken: string;
			expiresAt: number;
			refreshToken?: string;
			attemptedRefreshToken: string;
		},
	): void {
		recordPendingRotation(accountId, { identity: null, ...entry }, {
			updateAccountTokens: async () => true,
		} as PendingRotationWriter);
	}

	it("records the rotation (anchored on the exchanged token) when the persist THROWS", async () => {
		const acctId = "pending-record";
		const { ctx } = makeContext(
			async () => ({
				accessToken: "fresh-unpersisted",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-rotated",
			}),
			false,
			{
				updateAccountTokens: async () => {
					throw new Error("disk I/O error");
				},
			},
		);

		const token = await refreshAccessTokenSafe(makeAccount(acctId), ctx);
		expect(token).toBe("fresh-unpersisted");

		const entry = getPendingRotation(acctId);
		expect(entry?.accessToken).toBe("fresh-unpersisted");
		expect(entry?.refreshToken).toBe("rt-rotated");
		// Anchored on the token the DB still holds — the one this attempt exchanged.
		expect(entry?.attemptedRefreshToken).toBe("rt-old");
		// The serve+cache behaviour of the failed-persist path is unchanged.
		expect(getCoalescibleRecentRefresh(acctId, "older-token")).toEqual({
			accessToken: "fresh-unpersisted",
			expiresAt: expect.any(Number),
		});
	});

	it("flushes the pending rotation on the next refresh and serves it without calling the provider or re-reading the row", async () => {
		const acctId = "pending-flush-persisted";
		const pendingExpiry = Date.now() + HOUR_MS;
		seedPending(acctId, {
			accessToken: "at-pending",
			expiresAt: pendingExpiry,
			refreshToken: "rt-pending",
			attemptedRefreshToken: "rt-anchor",
		});
		const { ctx, refreshTokenSpy, getAccountSpy, updateTokensSpy } =
			makeContext(
				async () => ({
					accessToken: "should-not-run",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-should-not",
				}),
				false,
				{ updateAccountTokens: async () => true },
			);

		const acct = makeAccount(acctId);
		const token = await refreshAccessTokenSafe(acct, ctx);

		expect(token).toBe("at-pending");
		expect(refreshTokenSpy).not.toHaveBeenCalled();
		// The flush IS the read: the row it just wrote can only repeat what the
		// entry already says.
		expect(getAccountSpy).not.toHaveBeenCalled();
		// The flush CASes on the anchor, not on the caller's in-memory token.
		expect(updateTokensSpy.mock.calls[0][5]).toBe("rt-anchor");
		expect(acct.access_token).toBe("at-pending");
		expect(acct.refresh_token).toBe("rt-pending");
		expect(getPendingRotation(acctId)).toBeUndefined();
	});

	it("serves the pending access token when the flush fails again (the registry outranks the stale row)", async () => {
		const acctId = "pending-flush-failed";
		seedPending(acctId, {
			accessToken: "at-pending-live",
			expiresAt: Date.now() + HOUR_MS,
			refreshToken: "rt-pending",
			attemptedRefreshToken: "rt-anchor",
		});
		const { ctx, refreshTokenSpy, getAccountSpy } = makeContext(
			async () => ({
				accessToken: "should-not-run",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-should-not",
			}),
			false,
			{
				updateAccountTokens: async () => {
					throw new Error("disk I/O error");
				},
				getAccount: async () =>
					({
						id: acctId,
						access_token: "db-stale-access",
						expires_at: Date.now() + 2 * HOUR_MS,
						refresh_token: "rt-anchor",
						refresh_token_issued_at: 1,
					}) as Account,
			},
		);

		const acct = makeAccount(acctId);
		const token = await refreshAccessTokenSafe(acct, ctx);

		// The row's "fresher" access token belongs to a consumed generation — the
		// pending one is what the provider actually issued last.
		expect(token).toBe("at-pending-live");
		expect(refreshTokenSpy).not.toHaveBeenCalled();
		expect(getAccountSpy).not.toHaveBeenCalled();
		expect(acct.refresh_token).toBe("rt-pending");
		// Still pending: the write has not landed.
		expect(getPendingRotation(acctId)).toBeDefined();
	});

	it("refreshes with the PENDING refresh token and CASes on the ORIGINAL anchor when the pending access token is expired", async () => {
		const acctId = "pending-expired-access";
		seedPending(acctId, {
			accessToken: "at-pending-expired",
			expiresAt: Date.now() - 1_000,
			refreshToken: "rt-pending",
			attemptedRefreshToken: "rt-anchor",
		});
		let persistCalls = 0;
		let refreshTokenAtCall: string | null = null;
		const { ctx, updateTokensSpy } = makeContext(
			async (account) => {
				refreshTokenAtCall = account.refresh_token;
				return {
					accessToken: "fresh-after-pending",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-next",
				};
			},
			false,
			{
				updateAccountTokens: async () => {
					persistCalls += 1;
					// Call 1 is the flush attempt (still broken); call 2 is this
					// refresh's own persist.
					if (persistCalls === 1) throw new Error("disk I/O error");
					return true;
				},
			},
		);

		const token = await refreshAccessTokenSafe(makeAccount(acctId), ctx);

		expect(token).toBe("fresh-after-pending");
		// The live generation is exchanged — never the consumed token in the row.
		expect(refreshTokenAtCall).toBe("rt-pending");
		// …and the write still targets the row as it actually is: anchored on the
		// token the DB holds, NOT on the token this attempt exchanged.
		expect(updateTokensSpy.mock.calls[1][5]).toBe("rt-anchor");
		expect(getPendingRotation(acctId)).toBeUndefined();
	});

	it("persists the PENDING refresh token when the chained refresh returns no new one", async () => {
		const acctId = "pending-carry-forward";
		seedPending(acctId, {
			accessToken: "at-pending-expired",
			expiresAt: Date.now() - 1_000,
			refreshToken: "rt-pending",
			attemptedRefreshToken: "rt-anchor",
		});
		let persistCalls = 0;
		const { ctx, updateTokensSpy } = makeContext(
			async () => ({
				// Provider issued no new refresh token this cycle.
				accessToken: "fresh-no-rotation",
				expiresAt: Date.now() + HOUR_MS,
			}),
			false,
			{
				updateAccountTokens: async () => {
					persistCalls += 1;
					if (persistCalls === 1) throw new Error("disk I/O error");
					return true;
				},
			},
		);

		const acct = makeAccount(acctId);
		const token = await refreshAccessTokenSafe(acct, ctx);

		expect(token).toBe("fresh-no-rotation");
		// The pending token must ride along into the row, or this write would
		// leave the consumed one there forever.
		expect(updateTokensSpy.mock.calls[1][3]).toBe("rt-pending");
		expect(acct.refresh_token).toBe("rt-pending");
	});

	it("installs a SURVIVING newer pending rotation on a CAS miss instead of the DB row", async () => {
		const acctId = "pending-cas-miss-survivor";
		const survivorExpiry = Date.now() + HOUR_MS;
		const { ctx, getAccountSpy } = makeContext(
			async () => ({
				accessToken: "fresh-losing",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-losing",
			}),
			false,
			{
				updateAccountTokens: async () => {
					// A concurrent refresh rotated and lost its own persist while this
					// write was in flight; its rotation is the newest live generation.
					seedPending(acctId, {
						accessToken: "at-survivor",
						expiresAt: survivorExpiry,
						refreshToken: "rt-survivor",
						attemptedRefreshToken: "rt-old",
					});
					return false;
				},
				getAccount: async () => null,
			},
		);

		const acct = makeAccount(acctId);
		const token = await refreshAccessTokenSafe(acct, ctx);

		expect(token).toBe("at-survivor");
		expect(acct.access_token).toBe("at-survivor");
		expect(acct.expires_at).toBe(survivorExpiry);
		expect(acct.refresh_token).toBe("rt-survivor");
		// Only the pre-refresh re-read ran: the registry outranks the row, so the
		// post-CAS-loss authoritative re-read was skipped.
		expect(getAccountSpy).toHaveBeenCalledTimes(1);
	});

	it("does NOT pause on an invalid_grant that replayed a stale generation while a rotation awaits persist", async () => {
		const acctId = "pending-benign-invalid-grant";
		const infoSpy = spyOn(Logger.prototype, "info");
		try {
			const { ctx, pauseSpy } = makeContext(async () => {
				// A concurrent refresh rotated (and lost its persist) while this
				// attempt's exchange was in flight — the token it held is simply an
				// older generation, not a revoked grant.
				seedPending(acctId, {
					accessToken: "at-live",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-live",
					attemptedRefreshToken: "rt-old",
				});
				throw new OAuthRefreshTokenError(acctId, "refresh rejected");
			}, true);

			let thrown: unknown;
			try {
				await refreshAccessTokenSafe(makeAccount(acctId), ctx);
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(TokenRefreshError);
			// The account is healthy — pausing it would take a live account out of
			// rotation for a token that was already superseded.
			expect(pauseSpy).not.toHaveBeenCalled();
			expect(getPendingRotation(acctId)).toBeDefined();
			expect(
				infoSpy.mock.calls.some(
					(args) =>
						typeof args[0] === "string" &&
						args[0].includes("stale refresh-token generation"),
				),
			).toBe(true);
		} finally {
			infoSpy.mockRestore();
		}
	});

	it("pauses on the ANCHOR (and drops the entry) when the PENDING token itself is rejected", async () => {
		const acctId = "pending-dead-generation";
		seedPending(acctId, {
			accessToken: "at-pending-expired",
			expiresAt: Date.now() - 1_000,
			refreshToken: "rt-pending",
			attemptedRefreshToken: "rt-anchor",
		});
		const { ctx, pauseSpy } = makeContext(
			async () => {
				throw new OAuthRefreshTokenError(acctId, "refresh rejected");
			},
			true,
			{
				updateAccountTokens: async () => {
					throw new Error("disk I/O error");
				},
			},
		);

		let thrown: unknown;
		try {
			await refreshAccessTokenSafe(makeAccount(acctId), ctx);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(TokenRefreshError);
		// The pending generation is dead, so it must not be retried…
		expect(getPendingRotation(acctId)).toBeUndefined();
		// …and the pause CAS is keyed on what the ROW holds (the anchor), or it
		// would miss and leave a dead account in rotation.
		expect(pauseSpy).toHaveBeenCalledTimes(1);
		expect(pauseSpy.mock.calls[0][2]).toBe("rt-anchor");
	});
});

describe("refreshAccessTokenSafe join syncs the joiner's account (Finding C)", () => {
	it("updates a joining caller's own account snapshot to the winner's fresh token", async () => {
		let resolveRefresh: (r: RefreshResult) => void = () => {};
		const refreshGate = new Promise<RefreshResult>((res) => {
			resolveRefresh = res;
		});
		const { ctx, refreshTokenSpy } = makeContext(() => refreshGate);

		const winner = makeAccount("join-1");
		// Same account id, but the joiner holds its OWN stale snapshot.
		const joiner = makeAccount("join-1");

		// Winner initiates — registers refreshInFlight synchronously.
		const winnerP = refreshAccessTokenSafe(winner, ctx);
		// Joiner arrives while the refresh is in flight → joins the same promise.
		const joinerP = refreshAccessTokenSafe(joiner, ctx);

		// Let the winner's provider refresh complete.
		resolveRefresh({
			accessToken: "fresh-join",
			expiresAt: Date.now() + HOUR_MS,
			refreshToken: "rt-join",
		});

		const [winnerToken, joinerToken] = await Promise.all([winnerP, joinerP]);
		expect(winnerToken).toBe("fresh-join");
		expect(joinerToken).toBe("fresh-join");
		// Provider ran exactly once — the joiner reused the in-flight promise.
		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
		// The joiner's OWN account object was synced to the fresh token so the
		// 401-retry path (which re-derives from account.access_token) uses it.
		expect(joiner.access_token).toBe("fresh-join");
		expect(joiner.expires_at).toBeGreaterThan(Date.now());
	});
});
