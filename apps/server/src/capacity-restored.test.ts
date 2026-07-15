import { describe, expect, it } from "bun:test";
import type { Account, DatabaseOperations } from "@clankermux/database";
import {
	type CapacityRestoredLogger,
	clearRateLimitOnCapacityRestored,
} from "./capacity-restored";

const NOW = 1_750_000_000_000;
const FUTURE = NOW + 60 * 60 * 1000;
const AT = NOW - 5_000;

function makeAccount(overrides: Partial<Account>): Account {
	return {
		id: "acc-1",
		name: "Account 1",
		rate_limited_until: FUTURE,
		rate_limited_at: AT,
		rate_limited_reason: null,
		...overrides,
	} as unknown as Account;
}

interface Harness {
	dbOps: Pick<
		DatabaseOperations,
		"getAccount" | "clearRateLimitOnCapacityRestore"
	>;
	logger: CapacityRestoredLogger;
	clearCalls: Array<{
		accountId: string;
		expectedUntil: number;
		expectedAt: number | null;
	}>;
	debugMsgs: string[];
	infoMsgs: string[];
}

/** `clearReturns` simulates the atomic compare-and-clear result (row changed?). */
function makeHarness(acc: Account | null, clearReturns = true): Harness {
	const clearCalls: Array<{
		accountId: string;
		expectedUntil: number;
		expectedAt: number | null;
	}> = [];
	const debugMsgs: string[] = [];
	const infoMsgs: string[] = [];
	return {
		clearCalls,
		debugMsgs,
		infoMsgs,
		logger: {
			debug: (m) => debugMsgs.push(m),
			info: (m) => infoMsgs.push(m),
		},
		dbOps: {
			getAccount: async () => acc,
			clearRateLimitOnCapacityRestore: async (
				accountId: string,
				expectedUntil: number,
				expectedAt: number | null,
			) => {
				clearCalls.push({ accountId, expectedUntil, expectedAt });
				return clearReturns;
			},
		} as Pick<
			DatabaseOperations,
			"getAccount" | "clearRateLimitOnCapacityRestore"
		>,
	};
}

describe("clearRateLimitOnCapacityRestored", () => {
	it("atomically clears a stale future lock for a normal (non-credits) rate limit", async () => {
		const h = makeHarness(
			makeAccount({
				id: "acc-1",
				rate_limited_until: FUTURE,
				rate_limited_reason: "upstream_429_with_reset",
			}),
			true,
		);
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, "acc-1", NOW);
		// Passes the EXACT observed rate_limited_until AND rate_limited_at as the
		// compare-and-clear guard.
		expect(h.clearCalls).toEqual([
			{ accountId: "acc-1", expectedUntil: FUTURE, expectedAt: AT },
		]);
		expect(h.infoMsgs).toHaveLength(1);
	});

	it("does NOT log 'cleared' when the atomic update changed no row (concurrent floor write)", async () => {
		// TOCTOU: a concurrent request rewrote rate_limited_until / set an
		// out_of_credits floor between the read and the write → 0 rows changed.
		const h = makeHarness(
			makeAccount({
				id: "acc-1",
				rate_limited_until: FUTURE,
				rate_limited_reason: "upstream_429_with_reset",
			}),
			false,
		);
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, "acc-1", NOW);
		expect(h.clearCalls).toHaveLength(1); // attempted…
		expect(h.infoMsgs).toEqual([]); // …but not reported as cleared
	});

	it("short-circuits an out_of_credits floor without attempting the clear", async () => {
		const h = makeHarness(
			makeAccount({
				id: "acc-1",
				rate_limited_until: FUTURE,
				rate_limited_reason: "out_of_credits",
			}),
		);
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, "acc-1", NOW);
		expect(h.clearCalls).toEqual([]);
		expect(h.debugMsgs).toHaveLength(1);
	});

	it("does nothing when there is no active future lock", async () => {
		const h = makeHarness(
			makeAccount({ id: "acc-1", rate_limited_until: NOW - 1000 }),
		);
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, "acc-1", NOW);
		expect(h.clearCalls).toEqual([]);
	});

	it("does nothing when the account is missing", async () => {
		const h = makeHarness(null);
		await clearRateLimitOnCapacityRestored(h.dbOps, h.logger, "acc-1", NOW);
		expect(h.clearCalls).toEqual([]);
	});
});
