import { describe, expect, it } from "bun:test";
import type { Account, DatabaseOperations } from "@clankermux/database";
import type { CapacityRestoredEvidence } from "@clankermux/providers";
import {
	clearCapacityRestoredProbePending,
	hasCapacityRestoredProbePending,
	markCapacityRestoredProbePending,
	rollbackCapacityRestoredProbePending,
} from "@clankermux/proxy";
import { RATE_LIMIT_REASONS } from "@clankermux/types";
import {
	type CapacityRestoredLogger,
	type CapacityRestoredProbeMarker,
	clearRateLimitOnCapacityRestored,
} from "./capacity-restored";

const NOW = 1_750_000_000_000;
const FUTURE = NOW + 60 * 60 * 1000;
/** The cooldown was written 5s ago… */
const AT = NOW - 5_000;
/** …and the poll that produced the evidence started 1s ago, i.e. AFTER it. */
const FETCH_STARTED_AT = NOW - 1_000;

function evidence(
	overrides: Partial<CapacityRestoredEvidence> = {},
): CapacityRestoredEvidence {
	return {
		accountId: "acc-1",
		utilization: 40,
		extraUsageUtilization: null,
		fetchStartedAt: FETCH_STARTED_AT,
		...overrides,
	};
}

function makeAccount(overrides: Partial<Account>): Account {
	return {
		id: "acc-1",
		name: "Account 1",
		rate_limited_until: FUTURE,
		rate_limited_at: AT,
		rate_limited_reason: "weekly_exhausted_429",
		...overrides,
	} as unknown as Account;
}

interface ClearCall {
	accountId: string;
	expectedUntil: number;
	expectedAt: number | null;
	expectedReason: string;
	fetchStartedAt: number;
}

interface Harness {
	dbOps: Pick<
		DatabaseOperations,
		"getAccount" | "clearRateLimitOnCapacityRestore"
	>;
	logger: CapacityRestoredLogger;
	clearCalls: ClearCall[];
	debugMsgs: string[];
	infoMsgs: string[];
	marker: CapacityRestoredProbeMarker;
	/** Marker call trace: "mark:<gen>" / "rollback:<gen>", in order. */
	markerCalls: string[];
	/** Generations currently reserved (mark minus matching rollback). */
	pending: Set<number>;
}

/**
 * `clear` simulates the atomic compare-and-clear (row changed? / throw). A
 * function so a test can change the answer between successive polls.
 */
function makeHarness(
	account: Account | null | (() => Account | null),
	clear: boolean | (() => boolean) = true,
): Harness {
	const clearCalls: ClearCall[] = [];
	const debugMsgs: string[] = [];
	const infoMsgs: string[] = [];
	const markerCalls: string[] = [];
	const pending = new Set<number>();
	let generation = 0;
	const getAccount = typeof account === "function" ? account : () => account;
	const clearResult = typeof clear === "function" ? clear : () => clear;
	return {
		clearCalls,
		debugMsgs,
		infoMsgs,
		markerCalls,
		pending,
		marker: {
			markPending: () => {
				generation += 1;
				markerCalls.push(`mark:${generation}`);
				pending.add(generation);
				return generation;
			},
			rollbackPending: (_accountId, gen) => {
				markerCalls.push(`rollback:${gen}`);
				pending.delete(gen);
			},
		},
		logger: {
			debug: (m) => debugMsgs.push(m),
			info: (m) => infoMsgs.push(m),
		},
		dbOps: {
			getAccount: async () => getAccount(),
			clearRateLimitOnCapacityRestore: async (
				accountId: string,
				expectedUntil: number,
				expectedAt: number | null,
				expectedReason: string,
				fetchStartedAt: number,
			) => {
				clearCalls.push({
					accountId,
					expectedUntil,
					expectedAt,
					expectedReason,
					fetchStartedAt,
				});
				return clearResult();
			},
		} as Pick<
			DatabaseOperations,
			"getAccount" | "clearRateLimitOnCapacityRestore"
		>,
	};
}

const skipToken = (msgs: string[]) =>
	msgs.map((m) => m.split("capacity_restored_skip ")[1]?.split(" ")[0]);

describe("clearRateLimitOnCapacityRestored — eligibility", () => {
	it("clears a quota-derived weekly lock, pinning the full observation", async () => {
		const h = makeHarness(makeAccount({}));
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);

		expect(h.clearCalls).toEqual([
			{
				accountId: "acc-1",
				expectedUntil: FUTURE,
				expectedAt: AT,
				expectedReason: "weekly_exhausted_429",
				fetchStartedAt: FETCH_STARTED_AT,
			},
		]);
		expect(h.infoMsgs).toHaveLength(1);
		expect(h.infoMsgs[0]).toContain("capacity_restored_clear");
		expect(h.infoMsgs[0]).toContain("reason=weekly_exhausted_429");
		expect(h.infoMsgs[0]).toContain("utilization=40%");
		expect(h.infoMsgs[0]).toContain("cooldown_remaining=60m");
		// The single-flight marker is reserved BEFORE the CAS and kept on success,
		// so no request can slip through between the commit and the arming.
		expect(h.markerCalls).toEqual(["mark:1"]);
		expect([...h.pending]).toEqual([1]);
	});

	it("clears a quota-derived session lock", async () => {
		const h = makeHarness(
			makeAccount({ rate_limited_reason: "session_exhausted_429" }),
		);
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);
		expect(h.clearCalls).toHaveLength(1);
		expect(h.clearCalls[0].expectedReason).toBe("session_exhausted_429");
	});

	it("refuses EVERY non-quota-derived reason, plus null and an unknown string", async () => {
		const ineligible = [
			...RATE_LIMIT_REASONS.filter(
				(r) => r !== "weekly_exhausted_429" && r !== "session_exhausted_429",
			),
			null,
			undefined,
			"something_new_429",
		];
		for (const reason of ineligible) {
			const h = makeHarness(
				makeAccount({ rate_limited_reason: reason as never }),
			);
			await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);
			expect(h.clearCalls).toEqual([]);
			expect(skipToken(h.debugMsgs)).toEqual(["ineligible_reason"]);
		}
	});

	it("fails CLOSED when rate_limited_at is missing", async () => {
		for (const at of [null, undefined]) {
			const h = makeHarness(makeAccount({ rate_limited_at: at as never }));
			await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);
			expect(h.clearCalls).toEqual([]);
			expect(skipToken(h.debugMsgs)).toEqual(["missing_rate_limited_at"]);
		}
	});

	it("refuses a cooldown written AFTER the poll started, and at the exact boundary", async () => {
		for (const at of [FETCH_STARTED_AT, FETCH_STARTED_AT + 1]) {
			const h = makeHarness(makeAccount({ rate_limited_at: at }));
			await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);
			expect(h.clearCalls).toEqual([]);
			expect(skipToken(h.debugMsgs)).toEqual(["cooldown_newer_than_evidence"]);
		}
	});

	it("logs cas_mismatch when the atomic update changed no row", async () => {
		const h = makeHarness(makeAccount({}), false);
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);
		expect(h.clearCalls).toHaveLength(1); // attempted…
		expect(h.infoMsgs).toEqual([]); // …but not reported as cleared
		expect(skipToken(h.debugMsgs)).toEqual(["cas_mismatch"]);
		// A failed CAS rolls the reservation back — the account never became
		// selectable, so it must not owe a probe.
		expect(h.markerCalls).toEqual(["mark:1", "rollback:1"]);
		expect([...h.pending]).toEqual([]);
	});

	it("rolls the reservation back when the CAS throws", async () => {
		const h = makeHarness(makeAccount({}), () => {
			throw new Error("database is locked");
		});
		await expect(
			clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
			),
		).rejects.toThrow("database is locked");
		expect(h.markerCalls).toEqual(["mark:1", "rollback:1"]);
		expect([...h.pending]).toEqual([]);
	});

	it("never reserves a marker for a rejected clear", async () => {
		for (const account of [
			makeAccount({ rate_limited_reason: "upstream_429_with_reset" }),
			makeAccount({ rate_limited_at: null as never }),
			makeAccount({ rate_limited_at: NOW - 100 }),
			makeAccount({ rate_limited_until: NOW - 1 }),
		]) {
			const h = makeHarness(account);
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
			);
			expect(h.markerCalls).toEqual([]);
		}
	});

	it("does nothing (and logs nothing) when there is no active future lock", async () => {
		for (const until of [null, NOW - 1000, NOW]) {
			const h = makeHarness(
				makeAccount({ rate_limited_until: until as never }),
			);
			await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);
			expect(h.clearCalls).toEqual([]);
			// The normal state of a healthy account — never logged per poll.
			expect(h.debugMsgs).toEqual([]);
			expect(h.infoMsgs).toEqual([]);
		}
	});

	it("does nothing when the account is missing", async () => {
		const h = makeHarness(null);
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);
		expect(h.clearCalls).toEqual([]);
		expect(h.debugMsgs).toEqual([]);
	});
});

describe("clearRateLimitOnCapacityRestored — level-triggered recovery", () => {
	it("a healthy poll BEFORE the lock is a no-op; steady healthy polls then clear it", async () => {
		// The round-1 failure mode: an account locked while its windows sat well
		// below 100 never produces a `100 → <100` crossing, so edge detection would
		// never fire. Level-triggering only needs the account to keep reading
		// healthy.
		let account: Account | null = makeAccount({
			rate_limited_until: null as never,
		});
		const h = makeHarness(() => account);

		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);
		expect(h.clearCalls).toEqual([]);

		// The lock lands (asynchronously, after the first callback already ran).
		account = makeAccount({});
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);
		expect(h.clearCalls).toHaveLength(1);
		expect(h.infoMsgs).toHaveLength(1);
	});

	it("retries on the next poll after a DB failure", async () => {
		let fail = true;
		const h = makeHarness(makeAccount({}), () => {
			if (fail) throw new Error("database is locked");
			return true;
		});

		await expect(
			clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW),
		).rejects.toThrow("database is locked");
		expect(h.infoMsgs).toEqual([]);

		fail = false;
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);
		expect(h.infoMsgs).toHaveLength(1);
	});

	it("a cooldown written mid-poll is skipped by THAT sample and cleared by the NEXT one", async () => {
		const h = makeHarness(makeAccount({ rate_limited_at: NOW - 500 }));
		// Evidence from a poll that started before the cooldown was written.
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence(), h.marker, NOW);
		expect(h.clearCalls).toEqual([]);
		expect(skipToken(h.debugMsgs)).toEqual(["cooldown_newer_than_evidence"]);

		// The next poll starts after the cooldown exists → the same lock clears.
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence({ fetchStartedAt: NOW - 100 }),
			h.marker,
			NOW,
		);
		expect(h.clearCalls).toHaveLength(1);
	});

	it("arms the REAL single-flight marker BEFORE the CAS commits (controlled race)", async () => {
		// The window this ordering closes: the DB row is already updated (the
		// account is unlocked and selectable) but no marker exists yet, so nothing
		// gates the fan-in. Observe the real marker from INSIDE the CAS.
		const realMarker = {
			markPending: markCapacityRestoredProbePending,
			rollbackPending: rollbackCapacityRestoredProbePending,
		};
		let armedDuringCas = false;
		const h = makeHarness(makeAccount({ id: "acc-race" }), () => {
			armedDuringCas = hasCapacityRestoredProbePending("acc-race");
			return true;
		});
		try {
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence({ accountId: "acc-race" }),
				realMarker,
				NOW,
			);
			expect(armedDuringCas).toBe(true);
			expect(hasCapacityRestoredProbePending("acc-race")).toBe(true);
		} finally {
			clearCapacityRestoredProbePending("acc-race");
		}
	});

	it("rolls the REAL marker back when the CAS refuses", async () => {
		const realMarker = {
			markPending: markCapacityRestoredProbePending,
			rollbackPending: rollbackCapacityRestoredProbePending,
		};
		const h = makeHarness(makeAccount({ id: "acc-race-2" }), false);
		try {
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence({ accountId: "acc-race-2" }),
				realMarker,
				NOW,
			);
			expect(hasCapacityRestoredProbePending("acc-race-2")).toBe(false);
		} finally {
			clearCapacityRestoredProbePending("acc-race-2");
		}
	});

	it("clears at utilization 99 and while extra_usage is still spent", async () => {
		const h = makeHarness(makeAccount({}));
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence({ utilization: 99, extraUsageUtilization: 100 }),
			h.marker,
			NOW,
		);
		expect(h.clearCalls).toHaveLength(1);
		expect(h.infoMsgs[0]).toContain("extra_usage=100");
	});
});
