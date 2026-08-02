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
): Harness {
	const clearCalls: ClearCall[] = [];
	const debugMsgs: string[] = [];
	const infoMsgs: string[] = [];
	const warnMsgs: string[] = [];
	const warned = new Map<string, string>();
	const markerCalls: string[] = [];
	const pending = new Set<number>();
	let generation = 0;
	const getAccount = typeof account === "function" ? account : () => account;
	const clearResult = typeof clear === "function" ? clear : () => clear;
	return {
		clearCalls,
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
