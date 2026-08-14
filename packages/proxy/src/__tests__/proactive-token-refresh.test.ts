import { afterEach, describe, expect, it, mock } from "bun:test";
import { OAuthRefreshTokenError } from "@clankermux/core";
import type { Account, AccountIdentity } from "@clankermux/types";
import {
	clearAllPendingRotationsForTests,
	flushPendingRotation,
	getPendingRotation,
	type PendingRotationWriter,
	recordPendingRotation,
} from "../handlers/pending-rotation-registry";
import { recordRecentRefresh } from "../handlers/token-manager";
import {
	type ProactiveRefreshRow,
	refreshProactiveAccountToken,
} from "../proactive-token-refresh";

/**
 * The proactive Qwen/Codex token refreshers share one per-row core. These tests
 * drive that core directly (both provider labels) because the two scheduler
 * loops around it are now nothing but a query and a `for`.
 *
 * The registry is module-level state shared with the request path, so every test
 * uses a UNIQUE account id and the map is cleared after each.
 */

const HOUR_MS = 60 * 60 * 1000;

interface RefreshResult {
	accessToken: string;
	expiresAt: number;
	refreshToken?: string;
	identity?: AccountIdentity | null;
}

function makeRow(id: string): ProactiveRefreshRow {
	return {
		id,
		name: `acct-${id}`,
		provider: "qwen",
		refresh_token: "rt-row",
		access_token: "at-stale",
		expires_at: Date.now() - 1_000,
		custom_endpoint: null,
	};
}

function makeContext(
	refreshToken: (account: Account, clientId: string) => Promise<RefreshResult>,
	opts: {
		updateAccountTokens?: (...args: unknown[]) => Promise<boolean>;
		getAccount?: (accountId: string) => Promise<Account | null>;
		pauseResult?: boolean;
	} = {},
) {
	const refreshTokenSpy = mock(refreshToken);
	const updateTokensSpy = mock(opts.updateAccountTokens ?? (async () => true));
	const getAccountSpy = mock(opts.getAccount ?? (async () => null));
	const pauseSpy = mock(async () => opts.pauseResult ?? false);
	const proxyContext = {
		refreshInFlight: new Map<string, Promise<string>>(),
		runtime: { clientId: "test-client" },
		dbOps: {
			getAccount: getAccountSpy,
			updateAccountTokens: updateTokensSpy,
			pauseAccountIfActive: pauseSpy,
		},
	};
	return {
		proxyContext,
		provider: { refreshToken: refreshTokenSpy },
		refreshTokenSpy,
		updateTokensSpy,
		getAccountSpy,
		pauseSpy,
	};
}

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

afterEach(() => {
	clearAllPendingRotationsForTests();
});

for (const providerLabel of ["Qwen", "Codex"] as const) {
	describe(`proactive ${providerLabel} token refresh`, () => {
		const idPrefix = providerLabel.toLowerCase();

		function run(
			row: ProactiveRefreshRow,
			ctx: ReturnType<typeof makeContext>,
		) {
			return refreshProactiveAccountToken({
				row,
				provider: ctx.provider as never,
				providerLabel,
				proxyContext: ctx.proxyContext as never,
			});
		}

		for (const [label, updateAccountTokens] of [
			["persisted", async () => true],
			["superseded", async () => false],
			[
				"failed",
				async () => {
					throw new Error("disk I/O error");
				},
			],
		] as const) {
			it(`skips the row when a pending rotation flush reports "${label}"`, async () => {
				const acctId = `${idPrefix}-flush-${label}`;
				seedPending(acctId, {
					accessToken: "at-pending",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-pending",
					attemptedRefreshToken: "rt-anchor",
				});
				const ctx = makeContext(
					async () => ({
						accessToken: "should-not-run",
						expiresAt: Date.now() + HOUR_MS,
						refreshToken: "rt-should-not",
					}),
					{ updateAccountTokens },
				);

				const outcome = await run(makeRow(acctId), ctx);

				expect(outcome).toEqual({
					status: "skipped",
					reason: "pending-rotation",
				});
				// The row's refresh token was either just consumed, just replaced, or
				// is outranked by the entry — replaying it can trip provider reuse
				// detection.
				expect(ctx.refreshTokenSpy).not.toHaveBeenCalled();
			});
		}

		it("skips a row whose refresh is already in flight", async () => {
			const acctId = `${idPrefix}-in-flight`;
			const ctx = makeContext(async () => ({
				accessToken: "should-not-run",
				expiresAt: Date.now() + HOUR_MS,
			}));
			ctx.proxyContext.refreshInFlight.set(acctId, Promise.resolve("other"));

			const outcome = await run(makeRow(acctId), ctx);

			expect(outcome).toEqual({ status: "skipped", reason: "in-flight" });
			expect(ctx.refreshTokenSpy).not.toHaveBeenCalled();
		});

		it("checks the in-flight refresh BEFORE flushing (never races that refresh's own persist)", async () => {
			const acctId = `${idPrefix}-in-flight-pending`;
			seedPending(acctId, {
				accessToken: "at-pending",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-pending",
				attemptedRefreshToken: "rt-anchor",
			});
			const ctx = makeContext(async () => ({
				accessToken: "should-not-run",
				expiresAt: Date.now() + HOUR_MS,
			}));
			ctx.proxyContext.refreshInFlight.set(acctId, Promise.resolve("other"));

			const outcome = await run(makeRow(acctId), ctx);

			// The in-flight refresh owns this account's next anchor-keyed write; a
			// flush fired underneath it would race that write.
			expect(outcome).toEqual({ status: "skipped", reason: "in-flight" });
			expect(ctx.updateTokensSpy).not.toHaveBeenCalled();
			expect(ctx.refreshTokenSpy).not.toHaveBeenCalled();
			expect(getPendingRotation(acctId)).toBeDefined();
		});

		it("skips a row whose token a concurrent refresh just produced (coalesce)", async () => {
			const acctId = `${idPrefix}-coalesced`;
			const ctx = makeContext(async () => ({
				accessToken: "should-not-run",
				expiresAt: Date.now() + HOUR_MS,
			}));
			recordRecentRefresh(acctId, "at-just-minted", Date.now() + HOUR_MS);

			const outcome = await run(makeRow(acctId), ctx);

			expect(outcome).toEqual({ status: "skipped", reason: "coalesced" });
			expect(ctx.refreshTokenSpy).not.toHaveBeenCalled();
		});

		it("persists a rotation and reports the minted token", async () => {
			const acctId = `${idPrefix}-persisted`;
			const ctx = makeContext(async () => ({
				accessToken: "at-minted",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-minted",
			}));

			const outcome = await run(makeRow(acctId), ctx);

			expect(outcome).toEqual({
				status: "refreshed",
				accessToken: "at-minted",
			});
			expect(ctx.updateTokensSpy.mock.calls[0][3]).toBe("rt-minted");
			// CAS on the token this attempt exchanged (nothing pending).
			expect(ctx.updateTokensSpy.mock.calls[0][5]).toBe("rt-row");
			expect(ctx.proxyContext.refreshInFlight.has(acctId)).toBe(false);
		});

		it("writes the row's own refresh token back when the provider rotates none", async () => {
			const acctId = `${idPrefix}-no-rotation`;
			const ctx = makeContext(async () => ({
				accessToken: "at-minted",
				expiresAt: Date.now() + HOUR_MS,
			}));

			await run(makeRow(acctId), ctx);

			// Qwen's refresh echoes rather than rotates: the write must not blank the
			// column.
			expect(ctx.updateTokensSpy.mock.calls[0][3]).toBe("rt-row");
		});

		it("records the rotation and still reports the minted token when the persist THROWS", async () => {
			const acctId = `${idPrefix}-persist-throws`;
			const ctx = makeContext(
				async () => ({
					accessToken: "at-unpersisted",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-unpersisted",
				}),
				{
					updateAccountTokens: async () => {
						throw new Error("disk I/O error");
					},
				},
			);

			const outcome = await run(makeRow(acctId), ctx);

			// A completed rotation whose write failed is NOT a refresh failure — the
			// old classification counted it as one and hid the durable loss.
			expect(outcome).toEqual({
				status: "refreshed",
				accessToken: "at-unpersisted",
			});
			const entry = getPendingRotation(acctId);
			expect(entry?.accessToken).toBe("at-unpersisted");
			expect(entry?.refreshToken).toBe("rt-unpersisted");
			expect(entry?.attemptedRefreshToken).toBe("rt-row");
		});

		it("carries a concurrently-recorded pending rotation into its own persist", async () => {
			const acctId = `${idPrefix}-carry-forward`;
			const ctx = makeContext(async () => {
				// A request-path refresh rotated and lost its persist while this
				// exchange was in flight.
				seedPending(acctId, {
					accessToken: "at-pending",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-pending",
					attemptedRefreshToken: "rt-anchor",
				});
				return {
					accessToken: "at-minted",
					expiresAt: Date.now() + HOUR_MS,
				};
			});

			const outcome = await run(makeRow(acctId), ctx);

			expect(outcome).toEqual({
				status: "refreshed",
				accessToken: "at-minted",
			});
			// The pending token rides along…
			expect(ctx.updateTokensSpy.mock.calls[0][3]).toBe("rt-pending");
			// …and the CAS names what the row actually holds.
			expect(ctx.updateTokensSpy.mock.calls[0][5]).toBe("rt-anchor");
			// The entry is settled by this write.
			expect(getPendingRotation(acctId)).toBeUndefined();
		});

		it("serves a surviving newer pending rotation on a CAS miss instead of re-reading the row", async () => {
			const acctId = `${idPrefix}-cas-miss-survivor`;
			const ctx = makeContext(
				async () => ({
					accessToken: "at-losing",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-losing",
				}),
				{
					updateAccountTokens: async () => {
						seedPending(acctId, {
							accessToken: "at-survivor",
							expiresAt: Date.now() + HOUR_MS,
							refreshToken: "rt-survivor",
							attemptedRefreshToken: "rt-row",
						});
						return false;
					},
				},
			);

			const outcome = await run(makeRow(acctId), ctx);

			expect(outcome).toEqual({
				status: "refreshed",
				accessToken: "at-survivor",
			});
			expect(ctx.getAccountSpy).not.toHaveBeenCalled();
		});

		it("adopts the authoritative row on a CAS miss with nothing pending", async () => {
			const acctId = `${idPrefix}-cas-miss-adopt`;
			const ctx = makeContext(
				async () => ({
					accessToken: "at-losing",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-losing",
				}),
				{
					updateAccountTokens: async () => false,
					getAccount: async () =>
						({
							id: acctId,
							access_token: "at-authoritative",
							expires_at: Date.now() + 2 * HOUR_MS,
							refresh_token: "rt-authoritative",
							refresh_token_issued_at: 777,
						}) as Account,
				},
			);

			const outcome = await run(makeRow(acctId), ctx);

			expect(outcome).toEqual({
				status: "refreshed",
				accessToken: "at-authoritative",
			});
		});

		it("re-anchors and retries the persist when its CAS missed because OUR OWN pending rotation landed", async () => {
			const acctId = `${idPrefix}-cas-miss-self-flush`;
			let releasePersist: (v: boolean) => void = () => {};
			const persistGate = new Promise<boolean>((res) => {
				releasePersist = res;
			});
			let persistCalls = 0;
			const ctx = makeContext(
				async () => {
					// A request-path refresh rotated A → B and lost its persist while
					// this exchange was in flight; this attempt exchanged B and minted C.
					seedPending(acctId, {
						accessToken: "at-pending",
						expiresAt: Date.now() + HOUR_MS,
						refreshToken: "B",
						attemptedRefreshToken: "A",
					});
					return {
						accessToken: "at-minted-C",
						expiresAt: Date.now() + HOUR_MS,
						refreshToken: "C",
					};
				},
				{
					updateAccountTokens: async () => {
						persistCalls += 1;
						return persistCalls === 1 ? persistGate : true;
					},
					getAccount: async () =>
						({
							id: acctId,
							access_token: "at-row-B",
							expires_at: Date.now() + 2 * HOUR_MS,
							refresh_token: "B",
							refresh_token_issued_at: 555,
						}) as Account,
				},
			);

			const outcomeP = run(makeRow(acctId), ctx);
			await Bun.sleep(5);
			// The background retry lands the pending rotation (A → B) and drops the
			// entry while our own persist is still unsettled…
			const flushed = await flushPendingRotation(acctId, {
				updateAccountTokens: async () => true,
			} as PendingRotationWriter);
			expect(flushed.outcome).toBe("persisted");
			// …so our CAS on A misses.
			releasePersist(false);

			const outcome = await outcomeP;

			// B was consumed by THIS exchange: adopting it would discard the minted C
			// and pause a healthy account on the next replay of B.
			expect(outcome).toEqual({
				status: "refreshed",
				accessToken: "at-minted-C",
			});
			expect(persistCalls).toBe(2);
			// The retry names what the row actually holds now…
			expect(ctx.updateTokensSpy.mock.calls[1][5]).toBe("B");
			// …and still writes the minted generation.
			expect(ctx.updateTokensSpy.mock.calls[1][3]).toBe("C");
		});

		it("does NOT pause on an invalid_grant that replayed a stale generation", async () => {
			const acctId = `${idPrefix}-benign-invalid-grant`;
			const ctx = makeContext(async () => {
				seedPending(acctId, {
					accessToken: "at-live",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-live",
					attemptedRefreshToken: "rt-row",
				});
				throw new OAuthRefreshTokenError(acctId, "refresh rejected");
			}, {});

			const outcome = await run(makeRow(acctId), ctx);

			expect(outcome.status).toBe("failed");
			expect(ctx.pauseSpy).not.toHaveBeenCalled();
			// The live rotation is untouched — it still needs to be persisted.
			expect(getPendingRotation(acctId)).toBeDefined();
		});

		it("pauses on the ANCHOR (and drops the entry) when the PENDING token itself is rejected", async () => {
			const acctId = `${idPrefix}-dead-generation`;
			const ctx = makeContext(
				async () => {
					seedPending(acctId, {
						accessToken: "at-pending",
						expiresAt: Date.now() + HOUR_MS,
						// The pending generation IS what this attempt exchanged.
						refreshToken: "rt-row",
						attemptedRefreshToken: "rt-anchor",
					});
					throw new OAuthRefreshTokenError(acctId, "refresh rejected");
				},
				{ pauseResult: true },
			);

			const outcome = await run(makeRow(acctId), ctx);

			expect(outcome.status).toBe("failed");
			expect(getPendingRotation(acctId)).toBeUndefined();
			expect(ctx.pauseSpy).toHaveBeenCalledTimes(1);
			expect(ctx.pauseSpy.mock.calls[0][2]).toBe("rt-anchor");
		});

		it("pauses when the rejected token IS the pending generation even though the entry carries no refresh token", async () => {
			const acctId = `${idPrefix}-echoed-dead-generation`;
			const ctx = makeContext(
				async () => {
					// An echo/non-rotating refresh (Qwen) records an entry with NO
					// refresh token: the live generation is then the ANCHOR itself —
					// exactly the token this attempt exchanged and had rejected.
					seedPending(acctId, {
						accessToken: "at-live",
						expiresAt: Date.now() + HOUR_MS,
						refreshToken: undefined,
						attemptedRefreshToken: "rt-row",
					});
					throw new OAuthRefreshTokenError(acctId, "refresh rejected");
				},
				{ pauseResult: true },
			);

			const outcome = await run(makeRow(acctId), ctx);

			expect(outcome.status).toBe("failed");
			// A revoked grant must pause; `refreshToken === undefined` must not make
			// it look like a benign stale replay forever.
			expect(ctx.pauseSpy).toHaveBeenCalledTimes(1);
			expect(ctx.pauseSpy.mock.calls[0][2]).toBe("rt-row");
			expect(getPendingRotation(acctId)).toBeUndefined();
		});

		it("pauses on the exchanged token for an invalid_grant with nothing pending", async () => {
			const acctId = `${idPrefix}-plain-invalid-grant`;
			const ctx = makeContext(
				async () => {
					throw new OAuthRefreshTokenError(acctId, "refresh rejected");
				},
				{ pauseResult: true },
			);

			const outcome = await run(makeRow(acctId), ctx);

			expect(outcome.status).toBe("failed");
			expect(ctx.pauseSpy).toHaveBeenCalledTimes(1);
			expect(ctx.pauseSpy.mock.calls[0][2]).toBe("rt-row");
			expect(ctx.proxyContext.refreshInFlight.has(acctId)).toBe(false);
		});
	});
}
