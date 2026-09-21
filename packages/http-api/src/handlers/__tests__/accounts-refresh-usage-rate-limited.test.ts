import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import {
	AccountRepository,
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
} from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import { createAccountRefreshUsageHandler } from "../accounts";

let db: Database;
let repo: AccountRepository;
let dbOps: DatabaseOperations;
const req = () =>
	new Request("http://localhost/api/accounts/acct/refresh-usage", {
		method: "POST",
	});

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	const adapter = new BunSqlAdapter(db);
	repo = new AccountRepository(adapter);
	db.run(
		"INSERT INTO accounts (id, name, created_at, provider, access_token, refresh_token, paused, pause_reason) VALUES ('acct', 'Acct', 1, 'anthropic', 'tok', 'refresh', 1, 'subscription_expired')",
	);
	dbOps = {
		getAccount: (id: string) => repo.findById(id),
		getAdapter: () => adapter,
	} as unknown as DatabaseOperations;
});

afterEach(() => {
	db.close();
});

it("defers the recheck while the usage endpoint's own retry-after is still running", async () => {
	const until = Date.now() + 20 * 60_000;
	const rateLimitedUntil = spyOn(
		usageCache,
		"getRateLimitedUntil",
	).mockReturnValue(until);
	const refreshNow = spyOn(usageCache, "refreshNow").mockResolvedValue(false);
	try {
		const response = await createAccountRefreshUsageHandler(dbOps)(
			req(),
			"acct",
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			success: boolean;
			message: string;
			pollingRestarted: boolean;
			cacheRefreshed: boolean;
			usageRateLimitedUntil: number;
		};
		expect(body.success).toBe(false);
		expect(body.pollingRestarted).toBe(false);
		expect(body.cacheRefreshed).toBe(false);
		expect(body.usageRateLimitedUntil).toBe(until);
		expect(body.message).toContain("20m");
		// The point of deferring: the request is never sent, so the poller keeps
		// the deadline and the failure streak that produced it.
		expect(refreshNow).not.toHaveBeenCalled();
	} finally {
		rateLimitedUntil.mockRestore();
		refreshNow.mockRestore();
	}
});

it("refreshes as usual when no retry-after is outstanding", async () => {
	const rateLimitedUntil = spyOn(
		usageCache,
		"getRateLimitedUntil",
	).mockReturnValue(null);
	const refreshNow = spyOn(usageCache, "refreshNow").mockResolvedValue(true);
	try {
		const response = await createAccountRefreshUsageHandler(dbOps)(
			req(),
			"acct",
		);
		const body = (await response.json()) as {
			success: boolean;
			usageRateLimitedUntil?: number;
		};
		expect(body.success).toBe(true);
		expect(body.usageRateLimitedUntil).toBeUndefined();
		expect(refreshNow).toHaveBeenCalled();
	} finally {
		rateLimitedUntil.mockRestore();
		refreshNow.mockRestore();
	}
});
