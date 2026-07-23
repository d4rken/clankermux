import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { OAuthRefreshTokenError, TokenRefreshError } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";
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
	// The durable token write is fire-and-forget; the normal path returns a
	// resolved boolean, callers override for a never-settling/rejecting write.
	const updateTokensSpy = mock(opts.updateAccountTokens ?? (async () => true));
	const getAccountSpy = mock(opts.getAccount ?? (async () => null));
	// Mirror AsyncDbWriter.enqueue: run the job (so updateAccountTokens is
	// exercised) and swallow any resulting promise rejection, then return the
	// queue-accept boolean. The refresh code never awaits this, so a never-settling
	// job proves the write is non-blocking.
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

describe("refreshAccessTokenSafe request-path non-blocking CAS write", () => {
	it("enqueues the write NON-BLOCKING with the exchanged refresh token as the CAS arg, and returns without it settling", async () => {
		const acctId = "epoch-normal";
		// A never-settling write proves the refresh does not await the durable write.
		const neverSettles = new Promise<boolean>(() => {});
		const { ctx, updateTokensSpy, enqueueSpy } = makeContext(
			async () => ({
				accessToken: "fresh-normal",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-normal-new",
			}),
			false,
			{ updateAccountTokens: () => neverSettles },
		);

		const acct = makeAccount(acctId);
		const token = await refreshAccessTokenSafe(acct, ctx);

		// Refresh resolved with the fresh token despite the write never settling.
		expect(token).toBe("fresh-normal");
		expect(acct.access_token).toBe("fresh-normal");

		// The write was enqueued via asyncWriter with the exchanged (pre-refresh)
		// token as the 6th argument (the CAS backstop), and NOT awaited.
		expect(enqueueSpy).toHaveBeenCalledTimes(1);
		expect(updateTokensSpy).toHaveBeenCalledTimes(1);
		expect(updateTokensSpy.mock.calls[0][5]).toBe("rt-old");

		// The fresh token IS cached for coalescing (a caller with an older token reuses it).
		expect(getCoalescibleRecentRefresh(acctId, "older-token")).toEqual({
			accessToken: "fresh-normal",
			expiresAt: expect.any(Number),
		});
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
