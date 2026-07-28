import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	codexRateLimitResetCreditsCache,
	usageCache,
} from "@clankermux/providers";
import {
	clearCapacityRestoredProbePending,
	hasCapacityRestoredProbePending,
	markCapacityRestoredProbePending,
	sessionCacheStore,
} from "@clankermux/proxy";
import { createAccountRemoveHandler } from "../accounts";

/**
 * `DELETE /api/accounts/:id` is genuinely id-keyed, and the removal evicts the
 * removed account's in-memory state.
 *
 * The router has always named the segment `accountId` and the documented
 * contract has always been `:id`, but the handler treated it as a NAME all the
 * way down to `DELETE FROM accounts WHERE name = ?`. Any consumer following the
 * contract got a silent 404, and two accounts sharing a name would both have
 * been deleted.
 *
 * These use the REAL handler and the REAL sessionCacheStore singleton with a
 * minimal in-memory accounts table, so the resolve-by-id-before-delete ordering
 * is exercised end to end.
 */

const ACCOUNT_NAME = "to-remove";
const ACCOUNT_ID = "acc-remove-1";
const OTHER_ID = "acc-keep-1";

type Row = { id: string; name: string };

/** Tiny in-memory accounts table backing the DatabaseOperations shape used. */
function makeDbOps(seed: Row[] = [{ id: ACCOUNT_ID, name: ACCOUNT_NAME }]): {
	dbOps: unknown;
	rows: Map<string, Row>;
} {
	const rows = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));

	const adapter = {
		get: async <T>(sql: string, params: unknown[]): Promise<T | null> => {
			// The handler resolves the row by PRIMARY KEY.
			if (sql.includes("FROM accounts WHERE id")) {
				const row = rows.get(params[0] as string);
				return row ? ({ name: row.name } as unknown as T) : null;
			}
			return null;
		},
		runWithChanges: async (sql: string, params: unknown[]): Promise<number> => {
			if (sql.startsWith("DELETE FROM accounts WHERE id")) {
				return rows.delete(params[0] as string) ? 1 : 0;
			}
			// A name-keyed delete must never be issued again.
			throw new Error(`unexpected write: ${sql}`);
		},
	};

	return { dbOps: { getAdapter: () => adapter }, rows };
}

function makeHandler(dbOps: unknown) {
	return createAccountRemoveHandler(
		dbOps as Parameters<typeof createAccountRemoveHandler>[0],
	);
}

function deleteRequest(confirm: string): Request {
	return new Request("http://internal/api/accounts", {
		method: "DELETE",
		body: JSON.stringify({ confirm }),
	});
}

function seedSlot(accountId: string, sessionKey: string): void {
	sessionCacheStore.register({
		accountId,
		sessionKey,
		body: new TextEncoder().encode('{"model":"claude-opus-4-5","messages":[]}')
			.buffer,
		headers: new Headers({ "content-type": "application/json" }),
		path: "/v1/messages",
		model: "claude-opus-4-5",
		cacheReadTokens: 150_000,
		cacheCreationTokens: 0,
	});
}

describe("createAccountRemoveHandler — id-keyed removal", () => {
	it("deletes ONLY the targeted id when two accounts share a name", async () => {
		const { dbOps, rows } = makeDbOps([
			{ id: "dup-a", name: "duplicate" },
			{ id: "dup-b", name: "duplicate" },
		]);
		const res = await makeHandler(dbOps)(deleteRequest("duplicate"), "dup-a");
		expect(res.status).toBe(200);

		expect(rows.has("dup-a")).toBe(false);
		expect(rows.has("dup-b")).toBe(true);
	});

	it("404s for an unknown id — there is no name fallback", async () => {
		const { dbOps, rows } = makeDbOps();
		// The NAME, passed where the id belongs: exactly what the old handler
		// accepted, and what a name fallback would keep accepting.
		const res = await makeHandler(dbOps)(
			deleteRequest(ACCOUNT_NAME),
			ACCOUNT_NAME,
		);
		expect(res.status).toBe(404);
		expect(rows.has(ACCOUNT_ID)).toBe(true);
	});

	it("still requires the typed NAME as the confirmation string", async () => {
		const { dbOps, rows } = makeDbOps();
		const wrong = await makeHandler(dbOps)(
			deleteRequest(ACCOUNT_ID),
			ACCOUNT_ID,
		);
		expect(wrong.status).toBe(400);
		expect(rows.has(ACCOUNT_ID)).toBe(true);

		const right = await makeHandler(dbOps)(
			deleteRequest(ACCOUNT_NAME),
			ACCOUNT_ID,
		);
		expect(right.status).toBe(200);
		expect(rows.has(ACCOUNT_ID)).toBe(false);
	});
});

describe("createAccountRemoveHandler — session-cache eviction", () => {
	beforeEach(() => {
		sessionCacheStore.setEnabled(true);
		sessionCacheStore.setMinTokens(100_000);
		sessionCacheStore.clear();
	});

	afterEach(() => {
		sessionCacheStore.clear();
		sessionCacheStore.setEnabled(false);
	});

	it("evicts the removed account's warm slots and leaves other accounts' slots intact", async () => {
		seedSlot(ACCOUNT_ID, "session-a");
		seedSlot(ACCOUNT_ID, "session-b");
		seedSlot(OTHER_ID, "session-c");
		expect(sessionCacheStore.getSize()).toBe(3);

		const { dbOps } = makeDbOps();
		const res = await makeHandler(dbOps)(
			deleteRequest(ACCOUNT_NAME),
			ACCOUNT_ID,
		);
		expect(res.status).toBe(200);

		// The removed account's slots are gone; the other account's slot remains.
		const remaining = sessionCacheStore.getAllSlots();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.accountId).toBe(OTHER_ID);
	});

	it("evicts only the TARGETED id's state — in EVERY store — when two accounts share a name", async () => {
		// The eviction used to resolve one id from a name; with a collision it could
		// have evicted a surviving account's warm state. All FOUR stores the
		// handler touches are seeded and asserted: checking only the session cache
		// would let a later mis-keying of the others pass unnoticed.
		seedSlot("dup-a", "session-a");
		seedSlot("dup-b", "session-b");
		usageCache.set("dup-a", { five_hour: { utilization: 10 } } as never);
		usageCache.set("dup-b", { five_hour: { utilization: 20 } } as never);
		codexRateLimitResetCreditsCache.set("dup-a", {
			availableCount: 1,
			credits: null,
		});
		codexRateLimitResetCreditsCache.set("dup-b", {
			availableCount: 2,
			credits: null,
		});
		markCapacityRestoredProbePending("dup-a");
		markCapacityRestoredProbePending("dup-b");

		try {
			const { dbOps } = makeDbOps([
				{ id: "dup-a", name: "duplicate" },
				{ id: "dup-b", name: "duplicate" },
			]);

			expect(
				(await makeHandler(dbOps)(deleteRequest("duplicate"), "dup-a")).status,
			).toBe(200);

			const remaining = sessionCacheStore.getAllSlots();
			expect(remaining).toHaveLength(1);
			expect(remaining[0]?.accountId).toBe("dup-b");

			expect(usageCache.peek("dup-a")).toBeNull();
			expect(usageCache.peek("dup-b")).not.toBeNull();

			expect(codexRateLimitResetCreditsCache.get("dup-a")).toBeNull();
			expect(
				codexRateLimitResetCreditsCache.get("dup-b")?.summary.availableCount,
			).toBe(2);

			expect(hasCapacityRestoredProbePending("dup-a")).toBe(false);
			expect(hasCapacityRestoredProbePending("dup-b")).toBe(true);
		} finally {
			usageCache.delete("dup-a");
			usageCache.delete("dup-b");
			codexRateLimitResetCreditsCache.delete("dup-a");
			codexRateLimitResetCreditsCache.delete("dup-b");
			clearCapacityRestoredProbePending("dup-a");
			clearCapacityRestoredProbePending("dup-b");
		}
	});

	it("drops an owed capacity-restored probe marker for the removed account", async () => {
		// The marker is deliberately never time-expired, so removal is the only way
		// it can be dropped without a successful probe (or a restart).
		markCapacityRestoredProbePending(ACCOUNT_ID);
		markCapacityRestoredProbePending(OTHER_ID);
		try {
			const { dbOps } = makeDbOps();
			expect(
				(await makeHandler(dbOps)(deleteRequest(ACCOUNT_NAME), ACCOUNT_ID))
					.status,
			).toBe(200);

			expect(hasCapacityRestoredProbePending(ACCOUNT_ID)).toBe(false);
			expect(hasCapacityRestoredProbePending(OTHER_ID)).toBe(true);
		} finally {
			clearCapacityRestoredProbePending(ACCOUNT_ID);
			clearCapacityRestoredProbePending(OTHER_ID);
		}
	});
});
