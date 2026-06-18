import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sessionCacheStore } from "@clankermux/proxy";
import { createAccountRemoveHandler } from "../accounts";

/**
 * Verifies the account-remove handler evicts the removed account's warm
 * session-cache slots (Fix A: deleted accounts' keepalive slots must not linger).
 *
 * Uses the REAL handler and the REAL sessionCacheStore singleton with a minimal
 * in-memory DB adapter so the lookup-before-delete ordering is exercised end to
 * end: the handler resolves the account id BEFORE removeAccount() deletes the
 * row, then calls sessionCacheStore.evictAccount(id).
 */

const ACCOUNT_NAME = "to-remove";
const ACCOUNT_ID = "acc-remove-1";
const OTHER_ID = "acc-keep-1";

/** Tiny in-memory accounts table backing the DatabaseOperations shape used. */
function makeDbOps(): {
	dbOps: unknown;
	rows: Map<string, { id: string; name: string }>;
} {
	const rows = new Map<string, { id: string; name: string }>();
	rows.set(ACCOUNT_NAME, { id: ACCOUNT_ID, name: ACCOUNT_NAME });

	const adapter = {
		get: async <T>(sql: string, params: unknown[]): Promise<T | null> => {
			// Only the "SELECT id FROM accounts WHERE name = ?" lookup is exercised.
			if (sql.includes("FROM accounts WHERE name")) {
				const row = rows.get(params[0] as string);
				return (row ? ({ id: row.id } as unknown as T) : null) ?? null;
			}
			return null;
		},
		runWithChanges: async (sql: string, params: unknown[]): Promise<number> => {
			if (sql.startsWith("DELETE FROM accounts WHERE name")) {
				const existed = rows.delete(params[0] as string);
				return existed ? 1 : 0;
			}
			return 0;
		},
	};

	const dbOps = {
		getAdapter: () => adapter,
	};

	return { dbOps, rows };
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
		const handler = createAccountRemoveHandler(
			dbOps as Parameters<typeof createAccountRemoveHandler>[0],
		);

		const req = new Request("http://internal/api/accounts", {
			method: "DELETE",
			body: JSON.stringify({ confirm: ACCOUNT_NAME }),
		});
		const res = await handler(req, ACCOUNT_NAME);
		expect(res.status).toBe(200);

		// The removed account's slots are gone; the other account's slot remains.
		const remaining = sessionCacheStore.getAllSlots();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.accountId).toBe(OTHER_ID);
	});
});
