import { describe, expect, it } from "bun:test";
import type { Account, DatabaseOperations } from "@clankermux/database";
import { isAutoUnpauseCandidate } from "@clankermux/load-balancer";
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
	isStaleRecordedReset,
	RESET_MATCH_TOLERANCE_MS,
} from "./capacity-restored";

const NOW = 1_750_000_000_000;
const FUTURE = NOW + 60 * 60 * 1000;
/** The cooldown was written 5s ago… */
const AT = NOW - 5_000;
/** …and the poll that produced the evidence started 1s ago, i.e. AFTER it. */
const FETCH_STARTED_AT = NOW - 1_000;
/**
 * A SPENT window the provider reported in this poll whose reset does NOT
 * correspond to FUTURE, so a recorded reset of FUTURE reads as stale by
 * default (nothing spent owns it).
 */
const REPORTED_WINDOW = {
	resetMs: FUTURE + 2 * 60 * 60 * 1000,
	utilization: 100,
};

function evidence(
	overrides: Partial<CapacityRestoredEvidence> = {},
): CapacityRestoredEvidence {
	return {
		accountId: "acc-1",
		utilization: 40,
		extraUsageUtilization: null,
		fetchStartedAt: FETCH_STARTED_AT,
		observedWindows: [REPORTED_WINDOW],
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

interface StampCall {
	accountId: string;
	expectedReset: number;
	observedAt: number;
}

interface Harness {
	dbOps: Pick<
		DatabaseOperations,
		| "getAccount"
		| "clearRateLimitOnCapacityRestore"
		| "stampObservedRateLimitReset"
	>;
	/** Args of every stampObservedRateLimitReset call, in order. */
	stampCalls: StampCall[];
	logger: CapacityRestoredLogger;
	clearCalls: ClearCall[];
	debugMsgs: string[];
	infoMsgs: string[];
	warnMsgs: string[];
	/** Fresh per-harness contradiction-warn dedupe map (never the module default). */
	warned: Map<string, string>;
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
	stamp: boolean | (() => boolean) = true,
): Harness {
	const clearCalls: ClearCall[] = [];
	const stampCalls: StampCall[] = [];
	const debugMsgs: string[] = [];
	const infoMsgs: string[] = [];
	const warnMsgs: string[] = [];
	const warned = new Map<string, string>();
	const markerCalls: string[] = [];
	const pending = new Set<number>();
	let generation = 0;
	const getAccount = typeof account === "function" ? account : () => account;
	const clearResult = typeof clear === "function" ? clear : () => clear;
	const stampResult = typeof stamp === "function" ? stamp : () => stamp;
	return {
		clearCalls,
		stampCalls,
		debugMsgs,
		infoMsgs,
		warnMsgs,
		warned,
		markerCalls,
		pending,
		marker: {
			markPending: (accountId) => {
				generation += 1;
				markerCalls.push(`mark:${generation}`);
				pending.add(generation);
				return { accountId, generation, previous: null, rolledBack: false };
			},
			rollbackPending: (reservation) => {
				markerCalls.push(`rollback:${reservation.generation}`);
				pending.delete(reservation.generation);
			},
		},
		logger: {
			debug: (m) => debugMsgs.push(m),
			info: (m) => infoMsgs.push(m),
			warn: (m) => warnMsgs.push(m),
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
			stampObservedRateLimitReset: async (
				accountId: string,
				expectedReset: number,
				observedAt: number,
			) => {
				stampCalls.push({ accountId, expectedReset, observedAt });
				return stampResult();
			},
		} as Pick<
			DatabaseOperations,
			| "getAccount"
			| "clearRateLimitOnCapacityRestore"
			| "stampObservedRateLimitReset"
		>,
	};
}

const skipToken = (msgs: string[]) =>
	msgs.map((m) => m.split("capacity_restored_skip ")[1]?.split(" ")[0]);

describe("clearRateLimitOnCapacityRestored — eligibility", () => {
	it("clears a quota-derived weekly lock, pinning the full observation", async () => {
		const h = makeHarness(makeAccount({}));
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);

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
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
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
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
				h.warned,
			);
			expect(h.clearCalls).toEqual([]);
			// The refusal is never silent: the greppable token lands at DEBUG, or
			// at WARN when the long-lock contradiction alarm elevates it (60m
			// remaining here — above the alarm threshold — so everything except
			// the intentional out_of_credits billing floor elevates).
			expect(skipToken([...h.debugMsgs, ...h.warnMsgs])).toEqual([
				"ineligible_reason",
			]);
			if (reason === "out_of_credits") {
				expect(h.warnMsgs).toEqual([]);
			} else {
				expect(h.debugMsgs).toEqual([]);
				expect(h.warnMsgs).toHaveLength(1);
			}
		}
	});

	it("fails CLOSED when rate_limited_at is missing", async () => {
		for (const at of [null, undefined]) {
			const h = makeHarness(makeAccount({ rate_limited_at: at as never }));
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
			);
			expect(h.clearCalls).toEqual([]);
			expect(skipToken(h.debugMsgs)).toEqual(["missing_rate_limited_at"]);
		}
	});

	it("refuses a cooldown written AFTER the poll started, and at the exact boundary", async () => {
		for (const at of [FETCH_STARTED_AT, FETCH_STARTED_AT + 1]) {
			const h = makeHarness(makeAccount({ rate_limited_at: at }));
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
			);
			expect(h.clearCalls).toEqual([]);
			expect(skipToken(h.debugMsgs)).toEqual(["cooldown_newer_than_evidence"]);
		}
	});

	it("logs cas_mismatch when the atomic update changed no row", async () => {
		const h = makeHarness(makeAccount({}), false);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
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
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
			);
			expect(h.clearCalls).toEqual([]);
			// The normal state of a healthy account — never logged per poll.
			expect(h.debugMsgs).toEqual([]);
			expect(h.infoMsgs).toEqual([]);
		}
	});

	it("does nothing when the account is missing", async () => {
		const h = makeHarness(null);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
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

		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
		expect(h.clearCalls).toEqual([]);

		// The lock lands (asynchronously, after the first callback already ran).
		account = makeAccount({});
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
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
			clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
			),
		).rejects.toThrow("database is locked");
		expect(h.infoMsgs).toEqual([]);

		fail = false;
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
		expect(h.infoMsgs).toHaveLength(1);
	});

	it("a cooldown written mid-poll is skipped by THAT sample and cleared by the NEXT one", async () => {
		const h = makeHarness(makeAccount({ rate_limited_at: NOW - 500 }));
		// Evidence from a poll that started before the cooldown was written.
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
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

	it("an OVERLAPPING failed clear cannot erase the marker a successful one just committed", async () => {
		// The capacity callback is fire-and-forget, so two can overlap. Reserve 1 →
		// reserve 2 → CAS 1 SUCCEEDS → CAS 2 fails. If rollback DELETED instead of
		// restoring, the account would be unlocked with no marker at all — and with
		// the streak still 0, nothing else gates the fan-in.
		const realMarker = {
			markPending: markCapacityRestoredProbePending,
			rollbackPending: rollbackCapacityRestoredProbePending,
		};
		const ID = "acc-overlap";
		// Gate both CAS calls so their completion order is controlled.
		let releaseFirst: (() => void) | null = null;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let call = 0;
		const dbOps = {
			getAccount: async () => makeAccount({ id: ID }),
			clearRateLimitOnCapacityRestore: async () => {
				call += 1;
				if (call === 1) {
					await firstGate;
					return true; // the older clear COMMITS
				}
				return false; // the newer clear is refused
			},
		} as unknown as Parameters<typeof clearRateLimitOnCapacityRestored>[0];
		const logger: CapacityRestoredLogger = { debug: () => {}, info: () => {} };

		try {
			const first = clearRateLimitOnCapacityRestored(
				dbOps,
				logger,
				evidence({ accountId: ID }),
				realMarker,
				NOW,
			);
			// Second callback reserves on top of the first while it is still in
			// flight, then fails and rolls back.
			const second = clearRateLimitOnCapacityRestored(
				dbOps,
				logger,
				evidence({ accountId: ID }),
				realMarker,
				NOW,
			);
			await second;
			releaseFirst?.();
			await first;

			expect(hasCapacityRestoredProbePending(ID)).toBe(true);
		} finally {
			clearCapacityRestoredProbePending(ID);
		}
	});

	it("a failed clear cannot erase a marker RETAINED from an earlier restore", async () => {
		// e.g. a marker kept across `cooldown_reapplied`: a later reservation whose
		// CAS refuses must restore it, not delete it.
		const realMarker = {
			markPending: markCapacityRestoredProbePending,
			rollbackPending: rollbackCapacityRestoredProbePending,
		};
		const ID = "acc-retained";
		markCapacityRestoredProbePending(ID); // the retained marker
		try {
			const h = makeHarness(makeAccount({ id: ID }), false);
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence({ accountId: ID }),
				realMarker,
				NOW,
			);
			expect(hasCapacityRestoredProbePending(ID)).toBe(true);
		} finally {
			clearCapacityRestoredProbePending(ID);
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

describe("clearRateLimitOnCapacityRestored — lock-contradiction alarm", () => {
	// The Backup-2 incident shape (2026-08-02): a fable-scoped 429 misclassified
	// four seconds after a restart wrote an account-wide model_fallback_429 lock
	// until the weekly reset (~14h). Two seconds later polling observed weekly
	// headroom — and could only say so at DEBUG. These tests pin the WARN that
	// makes the contradiction visible, and its guards: it must never fire for
	// the intentional out_of_credits billing floor, never for short locks that
	// legitimate transient cooldowns produce (burst ≤90s, 429-backoff and 529
	// caps at 5min), and never twice for the same lock.
	const LONG_LOCK = NOW + 14 * 60 * 60 * 1000; // ~the incident's remaining time
	const SHORT_LOCK = NOW + 5 * 60 * 1000; // the legitimate cooldown ceiling

	it("warns ONCE per lock for a long non-releasable lock contradicted by headroom", async () => {
		const h = makeHarness(
			makeAccount({
				rate_limited_reason: "model_fallback_429",
				rate_limited_until: LONG_LOCK,
			}),
		);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence({ utilization: 95 }),
			h.marker,
			NOW,
			h.warned,
		);
		expect(h.clearCalls).toEqual([]);
		expect(h.markerCalls).toEqual([]);
		expect(h.warnMsgs).toHaveLength(1);
		expect(h.warnMsgs[0]).toContain("capacity_restored_skip ineligible_reason");
		expect(h.warnMsgs[0]).toContain("lock_contradiction");
		expect(h.warnMsgs[0]).toContain("reason=model_fallback_429");
		expect(h.warnMsgs[0]).toContain("utilization=95%");
		expect(h.warnMsgs[0]).toContain("remaining=840m");

		// The poller is level-triggered (~90s): the same lock must not WARN again.
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence({ utilization: 95 }),
			h.marker,
			NOW,
			h.warned,
		);
		expect(h.warnMsgs).toHaveLength(1);
		expect(skipToken(h.debugMsgs)).toEqual(["ineligible_reason"]);
	});

	it("warns again when a DIFFERENT lock replaces the warned one", async () => {
		let until = LONG_LOCK;
		const h = makeHarness(() =>
			makeAccount({
				rate_limited_reason: "model_fallback_429",
				rate_limited_until: until,
			}),
		);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
			h.warned,
		);
		until = LONG_LOCK + 60_000; // a new cooldown write → new lock identity
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
			h.warned,
		);
		expect(h.warnMsgs).toHaveLength(2);
	});

	it("re-arms after the lock clears: the same signature warns again on a fresh lock", async () => {
		let account: ReturnType<typeof makeAccount> | null = makeAccount({
			rate_limited_reason: "model_fallback_429",
			rate_limited_until: LONG_LOCK,
		});
		const h = makeHarness(() => account);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
			h.warned,
		);
		expect(h.warnMsgs).toHaveLength(1);
		// Lock expires/clears: the healthy poll prunes the dedupe entry…
		account = makeAccount({
			rate_limited_reason: null as never,
			rate_limited_until: null as never,
		});
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
			h.warned,
		);
		expect(h.warned.size).toBe(0);
		// …so an identical future lock is a new incident, not a deduped repeat.
		account = makeAccount({
			rate_limited_reason: "model_fallback_429",
			rate_limited_until: LONG_LOCK,
		});
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
			h.warned,
		);
		expect(h.warnMsgs).toHaveLength(2);
	});

	it("caps the dedupe map at 64 entries, evicting the oldest", async () => {
		const h = makeHarness(
			makeAccount({
				rate_limited_reason: "model_fallback_429",
				rate_limited_until: LONG_LOCK,
			}),
		);
		for (let i = 0; i < 64; i++) h.warned.set(`old-acc-${i}`, "sig");
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
			h.warned,
		);
		expect(h.warnMsgs).toHaveLength(1);
		expect(h.warned.size).toBe(64);
		expect(h.warned.has("old-acc-0")).toBe(false); // oldest evicted
		expect(h.warned.has("acc-1")).toBe(true); // newest kept
	});

	it("stays at DEBUG for the intentional out_of_credits billing floor", async () => {
		const h = makeHarness(
			makeAccount({
				rate_limited_reason: "out_of_credits",
				rate_limited_until: LONG_LOCK,
			}),
		);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
			h.warned,
		);
		expect(h.warnMsgs).toEqual([]);
		expect(skipToken(h.debugMsgs)).toEqual(["ineligible_reason"]);
	});

	it("stays at DEBUG at and below the legitimate-cooldown ceiling", async () => {
		for (const until of [SHORT_LOCK, NOW + 30 * 60 * 1000]) {
			const h = makeHarness(
				makeAccount({
					rate_limited_reason: "upstream_429_with_reset",
					rate_limited_until: until,
				}),
			);
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
				h.warned,
			);
			expect(h.warnMsgs).toEqual([]);
			expect(skipToken(h.debugMsgs)).toEqual(["ineligible_reason"]);
		}
	});
});

describe("isStaleRecordedReset", () => {
	const R = 1_800_000_000_000;
	const spent = (resetMs: number) => ({ resetMs, utilization: 100 });

	it("is fresh only while a SPENT window matches within the tolerance", () => {
		expect(isStaleRecordedReset(R, [spent(R)])).toBe(false);
		expect(isStaleRecordedReset(R, [spent(R - RESET_MATCH_TOLERANCE_MS)])).toBe(
			false,
		);
		expect(isStaleRecordedReset(R, [spent(R + RESET_MATCH_TOLERANCE_MS)])).toBe(
			false,
		);
		expect(
			isStaleRecordedReset(R, [spent(R + RESET_MATCH_TOLERANCE_MS + 1)]),
		).toBe(true);
		expect(
			isStaleRecordedReset(R, [spent(R - RESET_MATCH_TOLERANCE_MS - 1)]),
		).toBe(true);
		// One owning match among many non-matches is still a match.
		expect(
			isStaleRecordedReset(R, [
				spent(R + 999_999),
				spent(R - 474),
				spent(R + 999_999),
			]),
		).toBe(false);
	});

	it("a matching window that DRAINED no longer owns the deadline (gift reset)", () => {
		// The documented gift signature: percentage drops, resets_at stays put.
		expect(isStaleRecordedReset(R, [{ resetMs: R, utilization: 0 }])).toBe(
			true,
		);
		expect(isStaleRecordedReset(R, [{ resetMs: R, utilization: 99.9 }])).toBe(
			true,
		);
		// …but a spent window with the same reset still holds, even beside a
		// drained one (two windows can share a boundary).
		expect(
			isStaleRecordedReset(R, [
				{ resetMs: R, utilization: 0 },
				{ resetMs: R + 200, utilization: 100 },
			]),
		).toBe(false);
	});

	it("unknown utilization on a matching window counts as spent (hold)", () => {
		expect(isStaleRecordedReset(R, [{ resetMs: R, utilization: null }])).toBe(
			false,
		);
	});

	it("an empty list is stale: no spent window can own a deadline it does not report", () => {
		expect(isStaleRecordedReset(R, [])).toBe(true);
	});

	it("tolerates the measured header-vs-payload rounding (≤474ms live, 1s cap)", () => {
		// Header resets are whole seconds; payload resets carry ms. Values seen on
		// 2026-09-03 across every live account.
		const header = 1788678000000;
		for (const drift of [238, -474, -74, 452, 265, 0]) {
			expect(isStaleRecordedReset(header, [spent(header - drift)])).toBe(false);
		}
	});
});

describe("clearRateLimitOnCapacityRestored — stranded paused account", () => {
	/** No active lock, so the handler takes the stamp path rather than the clear path. */
	function stranded(overrides: Partial<Account> = {}): Account {
		return makeAccount({
			rate_limited_until: null,
			rate_limited_at: null,
			rate_limited_reason: null,
			paused: true,
			pause_reason: "overage",
			auto_fallback_enabled: true,
			provider: "anthropic",
			rate_limit_reset: FUTURE,
			...overrides,
		} as Partial<Account>);
	}

	it("stamps the observation instant over a stale future reset", async () => {
		const h = makeHarness(stranded());
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);

		expect(h.stampCalls).toEqual([
			{
				accountId: "acc-1",
				expectedReset: FUTURE,
				observedAt: FETCH_STARTED_AT,
			},
		]);
		// The lock path must not run: there is no cooldown to compare-and-clear,
		// and no probe generation should be reserved for a stamp.
		expect(h.clearCalls).toEqual([]);
		expect(h.markerCalls).toEqual([]);
		expect(h.infoMsgs).toHaveLength(1);
		expect(h.infoMsgs[0]).toContain("capacity_restored_stamp_reset");
		expect(h.infoMsgs[0]).toContain("pause_reason=overage");
	});

	it("the value the handler writes satisfies the auto-unpause gate after its skew buffer, not before", async () => {
		// Composition with the gate this whole change exists to open: drive the
		// handler, take the value it actually chose to write, and feed THAT into
		// isAutoUnpauseCandidate. Before the stamp the account is the deadlock.
		expect(isAutoUnpauseCandidate(stranded(), NOW)).toBe(false);

		const h = makeHarness(stranded());
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
		expect(h.stampCalls).toHaveLength(1);
		const written = h.stampCalls[0].observedAt;
		const afterStamp = stranded({
			rate_limit_reset: written,
		} as Partial<Account>);
		expect(isAutoUnpauseCandidate(afterStamp, written + 999)).toBe(false);
		expect(isAutoUnpauseCandidate(afterStamp, written + 1_001)).toBe(true);
	});

	it("leaves a CORRECT future reset alone: it matches a reported window", async () => {
		// Claude-1, 2026-09-03: fable weekly 100% (reset days out), account-wide
		// 78%. The recorded reset is the scoped claim's and is right. Account-wide
		// headroom fires the evidence every poll; the stamp must not follow.
		const scopedReset = FUTURE;
		const h = makeHarness(stranded());
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence({
				utilization: 78,
				observedWindows: [
					{ resetMs: NOW + 5 * 60 * 60 * 1000, utilization: 13 },
					{ resetMs: NOW + 3 * 24 * 60 * 60 * 1000, utilization: 78 },
					{ resetMs: scopedReset + 238, utilization: 100 },
				],
			}),
			h.marker,
			NOW,
		);
		expect(h.stampCalls).toEqual([]);
		// The normal state for such an account on every poll: silent, like the
		// healthy no-lock return.
		expect(h.infoMsgs).toEqual([]);
		expect(h.debugMsgs).toEqual([]);
	});

	it("stamps on a gift reset: the matching window drained in place", async () => {
		// Same reset as recorded, but the window is at 0% now. Holding until the
		// old deadline would idle a usable account for days.
		const h = makeHarness(stranded());
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence({
				utilization: 0,
				observedWindows: [{ resetMs: FUTURE + 300, utilization: 0 }],
			}),
			h.marker,
			NOW,
		);
		expect(h.stampCalls).toHaveLength(1);
	});

	it("stamps on a payload that reports no resets at all (every window idle)", async () => {
		// A paused account gets no traffic, so after an out-of-band reset every
		// window it owns is idle, and idle windows can report resets_at: null.
		// Failing closed here would recreate the deadlock.
		const h = makeHarness(stranded());
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence({ utilization: 0, observedWindows: [] }),
			h.marker,
			NOW,
		);
		expect(h.stampCalls).toHaveLength(1);
	});

	it("stamps for the other self-healing reason and for an absent one", async () => {
		for (const pause_reason of ["rate_limit_window", null, ""]) {
			const h = makeHarness(stranded({ pause_reason } as Partial<Account>));
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
			);
			expect(h.stampCalls).toHaveLength(1);
		}
	});

	it("refuses a durable pause reason", async () => {
		for (const pause_reason of [
			"manual",
			"failure_threshold",
			"oauth_invalid_grant",
			"subscription_expired",
		]) {
			const h = makeHarness(stranded({ pause_reason } as Partial<Account>));
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
			);
			expect(h.stampCalls).toEqual([]);
		}
	});

	it("refuses when nothing would ever auto-unpause the account anyway", async () => {
		// The gate also requires auto-fallback and a window-reset provider; a
		// stamp there would only log a promise that cannot be kept.
		for (const overrides of [
			{ auto_fallback_enabled: false },
			{ provider: "openai" },
			{ provider: "kilo" },
		]) {
			const h = makeHarness(stranded(overrides as Partial<Account>));
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
			);
			expect(h.stampCalls).toEqual([]);
		}
	});

	it("leaves an UNPAUSED account alone — it still gets traffic to fix itself", async () => {
		const h = makeHarness(stranded({ paused: false } as Partial<Account>));
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
		expect(h.stampCalls).toEqual([]);
	});

	it("never moves a reset that is already at or before the observation", async () => {
		for (const rate_limit_reset of [
			FETCH_STARTED_AT - 1,
			FETCH_STARTED_AT,
			null,
		]) {
			const h = makeHarness(
				stranded({ rate_limit_reset } as unknown as Partial<Account>),
			);
			await clearRateLimitOnCapacityRestored(
				h.dbOps,
				h.logger,
				evidence(),
				h.marker,
				NOW,
			);
			expect(h.stampCalls).toEqual([]);
		}
	});

	it("the boundary is the poll's start, not the handler's now", async () => {
		// A reset that fell between the poll starting and the handler running is
		// still in the future RELATIVE TO THE OBSERVATION, so it is stamped; a
		// `now`-based comparison would wrongly skip it.
		const h = makeHarness(
			stranded({ rate_limit_reset: NOW - 500 } as Partial<Account>),
		);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
		expect(h.stampCalls).toEqual([
			{
				accountId: "acc-1",
				expectedReset: NOW - 500,
				observedAt: FETCH_STARTED_AT,
			},
		]);
	});

	it("logs a debug token, not an info line, when the CAS misses", async () => {
		const h = makeHarness(stranded(), true, false);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
		expect(h.stampCalls).toHaveLength(1);
		expect(h.infoMsgs).toEqual([]);
		expect(skipToken(h.debugMsgs)).toContain("stale_reset_cas_mismatch");
	});

	it("after clearing a lock on a paused account, also corrects a stale reset", async () => {
		// Lock path + paused: the clear leaves rate_limit_reset alone, so the
		// account is still stranded once the lock is gone. Clear first, then stamp.
		const h = makeHarness(
			makeAccount({
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				provider: "anthropic",
				rate_limit_reset: FUTURE,
			} as Partial<Account>),
		);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
		expect(h.clearCalls).toHaveLength(1);
		expect(h.stampCalls).toEqual([
			{
				accountId: "acc-1",
				expectedReset: FUTURE,
				observedAt: FETCH_STARTED_AT,
			},
		]);
		expect(
			h.infoMsgs.map((m) => m.match(/capacity_restored_\w+/)?.[0]),
		).toEqual(["capacity_restored_clear", "capacity_restored_stamp_reset"]);
	});

	it("does not stamp when the lock clear itself was refused", async () => {
		const h = makeHarness(
			makeAccount({
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				provider: "anthropic",
				rate_limit_reset: FUTURE,
			} as Partial<Account>),
			false,
		);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence(),
			h.marker,
			NOW,
		);
		expect(h.clearCalls).toHaveLength(1);
		expect(h.stampCalls).toEqual([]);
	});
});
