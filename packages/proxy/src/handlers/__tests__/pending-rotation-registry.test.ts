import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
import type { AccountIdentity } from "@clankermux/types";
import {
	clearAllPendingRotationsForTests,
	clearPendingRotation,
	clearPendingRotationIfCurrent,
	flushPendingRotation,
	getPendingRotation,
	getPendingRotationAnchor,
	isPendingRotationRetryArmedForTests,
	MAX_PENDING_ROTATIONS,
	type PendingRotationWriter,
	recordPendingRotation,
	resolvePendingAfterPersist,
	setPendingRotationRetryIntervalForTests,
} from "../pending-rotation-registry";

/**
 * The pending-rotation registry holds provider-committed refresh-token rotations
 * whose DB persist THREW. The provider has already invalidated the old token, so
 * the row holds a consumed one: the entry is the only live copy of that
 * generation until a later flush lands it.
 *
 * The ANCHOR (`attemptedRefreshToken`) is what the DB is believed to still hold,
 * and every flush CASes on it. These tests pin the anchor rules (compression,
 * rebase, boundary) because a wrong anchor either silently no-ops the write
 * (rotation lost) or overwrites a newer writer's credentials.
 */

const HOUR_MS = 60 * 60 * 1000;

function makeIdentity(email: string): AccountIdentity {
	return {
		externalAccountId: null,
		email,
		organizationName: null,
		planTier: null,
		rateLimitTier: null,
	};
}

function makeWriter(
	impl: PendingRotationWriter["updateAccountTokens"] = async () => true,
): {
	dbOps: PendingRotationWriter;
	updateTokensSpy: ReturnType<typeof mock>;
} {
	const updateTokensSpy = mock(impl);
	return {
		dbOps: { updateAccountTokens: updateTokensSpy } as PendingRotationWriter,
		updateTokensSpy,
	};
}

afterEach(() => {
	clearAllPendingRotationsForTests();
});

describe("pending-rotation registry recording", () => {
	it("records a rotation and exposes it plus its anchor", () => {
		const { dbOps } = makeWriter();
		recordPendingRotation(
			"rec-1",
			{
				accessToken: "at-1",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-new",
				identity: null,
				attemptedRefreshToken: "rt-anchor",
			},
			dbOps,
		);

		const entry = getPendingRotation("rec-1");
		expect(entry?.accessToken).toBe("at-1");
		expect(entry?.refreshToken).toBe("rt-new");
		expect(entry?.attemptedRefreshToken).toBe("rt-anchor");
		expect(entry?.recordedAt).toBeGreaterThan(0);
		expect(getPendingRotationAnchor("rec-1")).toBe("rt-anchor");
	});

	it("returns undefined for an account with no pending rotation", () => {
		expect(getPendingRotation("rec-absent")).toBeUndefined();
		expect(getPendingRotationAnchor("rec-absent")).toBeUndefined();
	});

	it("clears a pending rotation unconditionally (reauth completion)", () => {
		const { dbOps } = makeWriter();
		recordPendingRotation(
			"rec-clear",
			{
				accessToken: "at",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt",
				identity: null,
				attemptedRefreshToken: "rt-anchor",
			},
			dbOps,
		);
		clearPendingRotation("rec-clear");
		expect(getPendingRotation("rec-clear")).toBeUndefined();
	});

	it("only clears an entry that is still the CURRENT one (identity guard)", () => {
		const { dbOps } = makeWriter();
		recordPendingRotation(
			"rec-guard",
			{
				accessToken: "at-1",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-1",
				identity: null,
				attemptedRefreshToken: "rt-anchor",
			},
			dbOps,
		);
		const stale = getPendingRotation("rec-guard");
		expect(stale).toBeDefined();

		// A newer rotation replaces the entry object…
		recordPendingRotation(
			"rec-guard",
			{
				accessToken: "at-2",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-2",
				identity: null,
				attemptedRefreshToken: "rt-2-exchanged",
			},
			dbOps,
		);
		// …so a clear keyed on the OLD snapshot must not drop it.
		clearPendingRotationIfCurrent("rec-guard", stale as never);
		expect(getPendingRotation("rec-guard")?.accessToken).toBe("at-2");
	});

	it("compresses chained rotations onto the ORIGINAL anchor and recordedAt, preserving a captured identity", async () => {
		const { dbOps } = makeWriter();
		recordPendingRotation(
			"rec-chain",
			{
				accessToken: "at-1",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-2",
				identity: makeIdentity("first@example.com"),
				attemptedRefreshToken: "rt-1",
			},
			dbOps,
		);
		const firstRecordedAt = getPendingRotation("rec-chain")?.recordedAt;
		await Bun.sleep(2);

		// A second failed persist: the provider rotated rt-2 → rt-3, but the DB
		// never moved (that is why the entry still exists), so rt-1 stays the
		// anchor and the original recordedAt stays the FIFO position.
		recordPendingRotation(
			"rec-chain",
			{
				accessToken: "at-2",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-3",
				identity: null,
				attemptedRefreshToken: "rt-2",
			},
			dbOps,
		);

		const entry = getPendingRotation("rec-chain");
		expect(entry?.accessToken).toBe("at-2");
		expect(entry?.refreshToken).toBe("rt-3");
		expect(entry?.attemptedRefreshToken).toBe("rt-1");
		expect(entry?.recordedAt).toBe(firstRecordedAt as number);
		// A null identity on the newer rotation must not erase the captured one.
		expect(entry?.identity?.email).toBe("first@example.com");
	});

	it("skips (loudly) a rotation whose anchor is not a non-empty string", () => {
		const errorSpy = spyOn(Logger.prototype, "error");
		try {
			const { dbOps } = makeWriter();
			recordPendingRotation(
				"rec-empty-anchor",
				{
					accessToken: "at",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt",
					identity: null,
					attemptedRefreshToken: "",
				},
				dbOps,
			);

			// An empty anchor is unflushable: the repo CAS treats "" as a literal
			// match and null as an UNCONDITIONAL write, so such an entry could only
			// ever no-op or clobber.
			expect(getPendingRotation("rec-empty-anchor")).toBeUndefined();
			expect(
				errorSpy.mock.calls.some(
					(args) =>
						typeof args[0] === "string" &&
						args[0].includes("rec-empty-anchor") &&
						args[0].includes("anchor"),
				),
			).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("evicts the OLDEST entry (FIFO) at the cap and logs the durable loss", () => {
		const errorSpy = spyOn(Logger.prototype, "error");
		try {
			const { dbOps } = makeWriter();
			for (let i = 0; i < MAX_PENDING_ROTATIONS; i++) {
				recordPendingRotation(
					`rec-cap-${i}`,
					{
						accessToken: `at-${i}`,
						expiresAt: Date.now() + HOUR_MS,
						refreshToken: `rt-${i}`,
						identity: null,
						attemptedRefreshToken: `anchor-${i}`,
					},
					dbOps,
				);
			}
			expect(getPendingRotation("rec-cap-0")).toBeDefined();

			recordPendingRotation(
				"rec-cap-overflow",
				{
					accessToken: "at-overflow",
					expiresAt: Date.now() + HOUR_MS,
					refreshToken: "rt-overflow",
					identity: null,
					attemptedRefreshToken: "anchor-overflow",
				},
				dbOps,
			);

			expect(getPendingRotation("rec-cap-0")).toBeUndefined();
			expect(getPendingRotation("rec-cap-overflow")).toBeDefined();
			expect(
				errorSpy.mock.calls.some(
					(args) =>
						typeof args[0] === "string" &&
						args[0].includes("rec-cap-0") &&
						args[0].includes("lost"),
				),
			).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe("pending-rotation registry flush", () => {
	it("CASes on the ANCHOR, drops the entry and returns the flushed snapshot", async () => {
		const { dbOps, updateTokensSpy } = makeWriter();
		const identity = makeIdentity("flush@example.com");
		const expiresAt = Date.now() + HOUR_MS;
		recordPendingRotation(
			"flush-ok",
			{
				accessToken: "at-pending",
				expiresAt,
				refreshToken: "rt-pending",
				identity,
				attemptedRefreshToken: "rt-anchor",
			},
			dbOps,
		);

		const { outcome, entry } = await flushPendingRotation("flush-ok", dbOps);

		expect(outcome).toBe("persisted");
		expect(entry?.accessToken).toBe("at-pending");
		expect(updateTokensSpy).toHaveBeenCalledTimes(1);
		expect(updateTokensSpy.mock.calls[0]).toEqual([
			"flush-ok",
			"at-pending",
			expiresAt,
			"rt-pending",
			identity,
			"rt-anchor",
			// The entry carried no deadline, so the flush asserts none — the
			// repository then keeps or clears the stored one based on whether
			// "rt-pending" is actually a rotation.
			{ refreshTokenExpiresAt: null },
		]);
		expect(getPendingRotation("flush-ok")).toBeUndefined();
	});

	it("reports 'none' and touches the DB not at all when nothing is pending", async () => {
		const { dbOps, updateTokensSpy } = makeWriter();
		const { outcome, entry } = await flushPendingRotation("flush-none", dbOps);
		expect(outcome).toBe("none");
		expect(entry).toBeUndefined();
		expect(updateTokensSpy).not.toHaveBeenCalled();
	});

	it("drops the entry on a CAS miss (the DB moved past the anchor)", async () => {
		const { dbOps } = makeWriter(async () => false);
		recordPendingRotation(
			"flush-superseded",
			{
				accessToken: "at-pending",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-pending",
				identity: null,
				attemptedRefreshToken: "rt-anchor",
			},
			dbOps,
		);

		const { outcome } = await flushPendingRotation("flush-superseded", dbOps);
		expect(outcome).toBe("superseded");
		expect(getPendingRotation("flush-superseded")).toBeUndefined();
	});

	it("KEEPS the entry when the flush write throws again", async () => {
		const { dbOps } = makeWriter(async () => {
			throw new Error("disk I/O error");
		});
		recordPendingRotation(
			"flush-failed",
			{
				accessToken: "at-pending",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-pending",
				identity: null,
				attemptedRefreshToken: "rt-anchor",
			},
			dbOps,
		);

		const { outcome, entry } = await flushPendingRotation(
			"flush-failed",
			dbOps,
		);
		expect(outcome).toBe("failed");
		expect(entry?.accessToken).toBe("at-pending");
		expect(getPendingRotation("flush-failed")?.accessToken).toBe("at-pending");
	});

	it("keeps a rotation recorded DURING the flush and rebases its anchor onto the token the flush wrote", async () => {
		let releasePersist: (v: boolean) => void = () => {};
		const persistGate = new Promise<boolean>((res) => {
			releasePersist = res;
		});
		const { dbOps } = makeWriter(() => persistGate);
		recordPendingRotation(
			"flush-survivor",
			{
				accessToken: "at-1",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-2",
				identity: null,
				attemptedRefreshToken: "rt-1",
			},
			dbOps,
		);

		const flushP = flushPendingRotation("flush-survivor", dbOps);
		await Bun.sleep(5);
		// A newer rotation lands while the flush write is unsettled. Anchor
		// compression gives it the ORIGINAL anchor (rt-1) — which the flush is
		// about to consume.
		recordPendingRotation(
			"flush-survivor",
			{
				accessToken: "at-2",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-3",
				identity: null,
				attemptedRefreshToken: "rt-2",
			},
			dbOps,
		);
		releasePersist(true);

		const { outcome } = await flushP;
		expect(outcome).toBe("persisted");
		const survivor = getPendingRotation("flush-survivor");
		// The survivor is NOT dropped by the flush's identity-guarded delete…
		expect(survivor?.accessToken).toBe("at-2");
		// …and its anchor now names what the DB actually holds after the flush.
		expect(survivor?.attemptedRefreshToken).toBe("rt-2");
	});

	it("keeps the rebased survivor when a concurrent flush holding its PRE-rebase snapshot reports a CAS miss", async () => {
		const makeGate = () => {
			let release: (v: boolean) => void = () => {};
			const promise = new Promise<boolean>((res) => {
				release = res;
			});
			return { promise, release: (v: boolean) => release(v) };
		};
		const gateA = makeGate();
		const gateB = makeGate();
		let calls = 0;
		const { dbOps } = makeWriter(() => {
			calls += 1;
			return calls === 1 ? gateA.promise : gateB.promise;
		});

		recordPendingRotation(
			"rebase-identity",
			{
				accessToken: "at-1",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-2",
				identity: null,
				attemptedRefreshToken: "rt-1",
			},
			dbOps,
		);
		const flushA = flushPendingRotation("rebase-identity", dbOps);
		await Bun.sleep(5);
		// A newer rotation lands mid-flush; anchor compression keeps rt-1.
		recordPendingRotation(
			"rebase-identity",
			{
				accessToken: "at-2",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-3",
				identity: null,
				attemptedRefreshToken: "rt-2",
			},
			dbOps,
		);
		// A second flush (the background sweep) picks that entry up and submits the
		// OLD anchor it still carries.
		const flushB = flushPendingRotation("rebase-identity", dbOps);
		await Bun.sleep(5);

		// Flush A lands and rebases the survivor onto rt-2…
		gateA.release(true);
		expect((await flushA).outcome).toBe("persisted");
		// …so flush B's CAS on rt-1 now misses.
		gateB.release(false);
		expect((await flushB).outcome).toBe("superseded");

		// Flush B's snapshot describes the PRE-rebase entry, so its identity-guarded
		// delete must not take the rebased survivor with it.
		const survivor = getPendingRotation("rebase-identity");
		expect(survivor?.accessToken).toBe("at-2");
		expect(survivor?.attemptedRefreshToken).toBe("rt-2");
	});
});

describe("resolvePendingAfterPersist", () => {
	it("drops the entry the caller's own persist landed", () => {
		const { dbOps } = makeWriter();
		recordPendingRotation(
			"resolve-drop",
			{
				accessToken: "at",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-new",
				identity: null,
				attemptedRefreshToken: "rt-anchor",
			},
			dbOps,
		);
		const snapshot = getPendingRotation("resolve-drop");

		resolvePendingAfterPersist("resolve-drop", snapshot as never, "rt-new");
		expect(getPendingRotation("resolve-drop")).toBeUndefined();
	});

	it("rebases a SURVIVING newer entry onto the token the caller actually wrote", () => {
		const { dbOps } = makeWriter();
		recordPendingRotation(
			"resolve-rebase",
			{
				accessToken: "at-1",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-2",
				identity: null,
				attemptedRefreshToken: "rt-1",
			},
			dbOps,
		);
		const snapshot = getPendingRotation("resolve-rebase");
		recordPendingRotation(
			"resolve-rebase",
			{
				accessToken: "at-2",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-3",
				identity: null,
				attemptedRefreshToken: "rt-2",
			},
			dbOps,
		);

		// The caller's persist wrote rt-9 (its own effective refresh token), which
		// may differ from the snapshot's — the rebase must follow the WRITTEN token.
		resolvePendingAfterPersist("resolve-rebase", snapshot as never, "rt-9");

		const survivor = getPendingRotation("resolve-rebase");
		expect(survivor?.accessToken).toBe("at-2");
		expect(survivor?.attemptedRefreshToken).toBe("rt-9");
	});

	it("leaves a survivor's anchor alone when the persist wrote no refresh token", () => {
		const { dbOps } = makeWriter();
		recordPendingRotation(
			"resolve-no-rt",
			{
				accessToken: "at-1",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: undefined,
				identity: null,
				attemptedRefreshToken: "rt-1",
			},
			dbOps,
		);
		const snapshot = getPendingRotation("resolve-no-rt");
		recordPendingRotation(
			"resolve-no-rt",
			{
				accessToken: "at-2",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-2",
				identity: null,
				attemptedRefreshToken: "rt-1",
			},
			dbOps,
		);

		resolvePendingAfterPersist("resolve-no-rt", snapshot as never, undefined);

		// The DB still holds rt-1, so the survivor must keep CASing on it.
		expect(getPendingRotation("resolve-no-rt")?.attemptedRefreshToken).toBe(
			"rt-1",
		);
	});
});

describe("pending-rotation background flush retry", () => {
	afterEach(() => {
		setPendingRotationRetryIntervalForTests(null);
	});

	it("retries the DB write on its own and disarms once the registry empties", async () => {
		let allowPersist = false;
		const { dbOps, updateTokensSpy } = makeWriter(async () => {
			if (!allowPersist) throw new Error("disk I/O error");
			return true;
		});
		setPendingRotationRetryIntervalForTests(5);

		recordPendingRotation(
			"retry-1",
			{
				accessToken: "at-retry",
				expiresAt: Date.now() + HOUR_MS,
				refreshToken: "rt-retry",
				identity: null,
				attemptedRefreshToken: "rt-anchor",
			},
			dbOps,
		);
		expect(isPendingRotationRetryArmedForTests()).toBe(true);

		// The registry retries without any caller touching it…
		await Bun.sleep(30);
		expect(updateTokensSpy.mock.calls.length).toBeGreaterThan(0);
		expect(getPendingRotation("retry-1")).toBeDefined();

		// …and once the DB accepts the write, the entry and the timer both go away.
		allowPersist = true;
		await Bun.sleep(30);
		expect(getPendingRotation("retry-1")).toBeUndefined();
		expect(isPendingRotationRetryArmedForTests()).toBe(false);

		const callsAfterDisarm = updateTokensSpy.mock.calls.length;
		await Bun.sleep(30);
		expect(updateTokensSpy.mock.calls.length).toBe(callsAfterDisarm);
	});
});
