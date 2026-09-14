import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseOperations } from "@clankermux/database";
import { tempDbTracker } from "@clankermux/test-support";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";
import type { ProxyContext } from "./fixtures/routing-harness";

// Test database path
const tmpDb = tempDbTracker("test-token-refresh-hierarchy");

/** The private decision this file drives directly, with its real signature. */
type SchedulerInternals = {
	shouldRefreshAccount(
		account: {
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			access_token: string | null;
			expires_at: number | null;
			rate_limit_reset: number | null;
			custom_endpoint: string | null;
		},
		now: number,
	): boolean;
};

/**
 * `shouldRefreshAccount` is private, so it is read reflectively and bound to its
 * instance rather than reached through a cast the access modifier defeats.
 */
function shouldRefreshAccountOf(
	scheduler: AutoRefreshScheduler,
): SchedulerInternals["shouldRefreshAccount"] {
	return Reflect.get(scheduler, "shouldRefreshAccount").bind(scheduler);
}

describe("Auto-Refresh Token Hierarchy", () => {
	let _db: Database;
	let dbOps: DatabaseOperations;
	let scheduler: AutoRefreshScheduler;
	let mockProxyContext: ProxyContext;

	beforeAll(async () => {
		// Own connection rather than the DatabaseFactory singleton: the
		// singleton outlives this file and other suites reset it.
		dbOps = new DatabaseOperations(tmpDb.next());
		_db = dbOps.getAdapter().getSQLiteDb();

		// Create mock proxy context
		mockProxyContext = {
			runtime: {
				port: 8080,
				clientId: "test-client-id",
			},
		} as ProxyContext;

		// Initialize scheduler
		scheduler = new AutoRefreshScheduler(dbOps.getAdapter(), mockProxyContext);
	});

	afterAll(async () => {
		try {
			await dbOps?.close();
		} finally {
			tmpDb.cleanup();
		}
	});

	describe("Window Refresh Logic", () => {
		it("should correctly identify accounts that need window refresh", () => {
			const now = Date.now();
			const oneHourAgo = now - 60 * 60 * 1000; // 1 hour ago
			const oneHourFromNow = now + 60 * 60 * 1000; // 1 hour from now

			const accountStale = {
				id: "test-stale",
				name: "stale-account",
				provider: "anthropic",
				refresh_token: "refresh-token",
				access_token: "access-token",
				expires_at: oneHourFromNow,
				rate_limit_reset: oneHourAgo, // More than 24h old (stale)
				custom_endpoint: null,
			};

			const accountCurrent = {
				id: "test-current",
				name: "current-account",
				provider: "anthropic",
				refresh_token: "refresh-token",
				access_token: "access-token",
				expires_at: oneHourFromNow,
				rate_limit_reset: oneHourFromNow, // Future time
				custom_endpoint: null,
			};

			// Access private method for testing
			const shouldRefreshAccount = shouldRefreshAccountOf(scheduler);
			const shouldRefreshStale = shouldRefreshAccount(accountStale, now);
			const shouldRefreshCurrent = shouldRefreshAccount(accountCurrent, now);

			expect(shouldRefreshStale).toBe(true); // Should refresh (stale reset time)
			expect(shouldRefreshCurrent).toBe(true); // Should refresh (first-time check regardless of reset time)
		});

		it("should handle first-time refresh correctly", () => {
			const now = Date.now();
			const oneHourFromNow = now + 60 * 60 * 1000;

			const accountFirstTime = {
				id: "test-first-time",
				name: "first-time-account",
				provider: "anthropic",
				refresh_token: "refresh-token",
				access_token: "access-token",
				expires_at: oneHourFromNow,
				rate_limit_reset: oneHourFromNow,
				custom_endpoint: null,
			};

			// Access private method for testing
			const shouldRefreshFirstTime = shouldRefreshAccountOf(scheduler)(
				accountFirstTime,
				now,
			);

			expect(shouldRefreshFirstTime).toBe(true); // Should refresh (first time)
		});
	});
});
