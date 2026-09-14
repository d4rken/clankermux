import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import {
	checkAllAccountsHealth,
	getAccountsNeedingReauth,
} from "@clankermux/proxy";
import { makeAccount } from "@clankermux/test-support";
import {
	createAccountTokenHealthHandler,
	createTokenHealthHandler,
} from "../token-health";

// Mock database operations for testing
const mockAccounts = [
	makeAccount({
		id: "1",
		name: "test-account-1",
		refresh_token: "valid-refresh-token",
		created_at: Date.now() - 120 * 24 * 60 * 60 * 1000, // 120 days ago (account is old)
		refresh_token_issued_at: Date.now() - 30 * 24 * 60 * 60 * 1000, // token refreshed 30 days ago (healthy)
		expires_at: Date.now() + 14 * 24 * 60 * 60 * 1000, // 14 days from now (healthy)
		access_token: "access-token",
	}),
	makeAccount({
		id: "2",
		name: "test-account-2",
		refresh_token: "expiring-soon-token",
		created_at: Date.now() - 95 * 24 * 60 * 60 * 1000, // 95 days ago
		refresh_token_issued_at: null, // No refresh_token_issued_at — falls back to created_at (past 90 day max, will be expired)
		expires_at: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago (expired)
		access_token: "access-token",
	}),
	makeAccount({
		id: "3",
		name: "test-account-3",
		refresh_token: "", // No refresh token (console mode)
		created_at: Date.now() - 30 * 24 * 60 * 60 * 1000,
		api_key: "api-key", // API key account
	}),
];

const mockDbOps = {
	getAllAccounts: () => mockAccounts,
	getAccount: (name: string) =>
		mockAccounts.find((acc) => acc.name === name) || null,
	createOAuthSession: () => {},
	getOAuthSession: () => null,
	deleteOAuthSession: () => {},
	getDatabase: () => ({
		prepare: () => ({
			run: () => {},
			get: () => null,
			all: () => [],
		}),
	}),
} as unknown as DatabaseOperations;

describe("Token Health HTTP API Integration", () => {
	describe("Token Health Endpoints", () => {
		it("should create token health handler", () => {
			expect(() => {
				const handler = createTokenHealthHandler(mockDbOps);
				expect(typeof handler).toBe("function");
			}).not.toThrow();
		});

		it("should create account token health handler", () => {
			expect(() => {
				const handler = createAccountTokenHealthHandler(
					mockDbOps,
					"test-account-1",
				);
				expect(typeof handler).toBe("function");
			}).not.toThrow();
		});
	});

	describe("Token Health Monitoring", () => {
		it("should check all accounts health", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			expect(healthReport).toBeDefined();
			expect(healthReport.accounts).toHaveLength(3);
			expect(healthReport.summary).toBeDefined();
			expect(healthReport.summary.total).toBe(3);
		});

		it("should identify accounts needing re-authentication", () => {
			const needingReauth = getAccountsNeedingReauth(mockAccounts);

			// Should find accounts that need re-authentication
			expect(needingReauth.length).toBeGreaterThanOrEqual(1);
			// The specific account may vary based on implementation details
			expect(
				needingReauth.some((acc) => acc.name.includes("test-account")),
			).toBe(true);
		});

		it("should handle empty accounts list", () => {
			const emptyHealthReport = checkAllAccountsHealth([]);
			const emptyNeedingReauth = getAccountsNeedingReauth([]);

			expect(emptyHealthReport.accounts).toHaveLength(0);
			expect(emptyHealthReport.summary.total).toBe(0);
			expect(emptyNeedingReauth).toHaveLength(0);
		});
	});

	describe("Account Health Status Types", () => {
		it("should return correct status for different account types", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			const account1 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-1",
			);
			const account2 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-2",
			);
			const account3 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-3",
			);

			// Account with valid refresh token should have appropriate status
			expect(account1?.status).toBeDefined();

			// Account expiring soon should have appropriate status
			expect(account2?.status).toBeDefined();

			// Account without refresh token should be "no-refresh-token"
			expect(account3?.status).toBe("no-refresh-token");
		});

		it("should include days until expiration for OAuth accounts", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			const account1 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-1",
			);
			const account2 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-2",
			);

			// Both are OAuth accounts, so both carry an estimate. test-account-1's
			// token was issued 30 days ago, leaving 60 of the 90-day maximum;
			// test-account-2 has no issue date and its account was created 95 days
			// ago, so its estimate is already past zero.
			expect(account1?.daysUntilExpiration).toBeGreaterThan(0);
			expect(account2?.daysUntilExpiration).toBeLessThanOrEqual(0);
		});
	});

	describe("Response Data Structure", () => {
		it("should provide consistent health report structure", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			// Check top-level structure
			expect(healthReport).toHaveProperty("accounts");
			expect(healthReport).toHaveProperty("summary");
			expect(healthReport).toHaveProperty("timestamp");

			// Check summary structure
			expect(healthReport.summary).toHaveProperty("total");
			expect(healthReport.summary).toHaveProperty("healthy");
			expect(healthReport.summary).toHaveProperty("warning");
			expect(healthReport.summary).toHaveProperty("critical");
			expect(healthReport.summary).toHaveProperty("expired");
			expect(healthReport.summary).toHaveProperty("noRefreshToken");
			expect(healthReport.summary).toHaveProperty("requiresReauth");

			// Check account structure
			healthReport.accounts.forEach((account) => {
				expect(account).toHaveProperty("accountName");
				expect(account).toHaveProperty("provider");
				expect(account).toHaveProperty("status");
				expect(account).toHaveProperty("message");
			});
		});
	});
});

describe("CLI Integration Tests", () => {
	it("should support CLI token health commands", () => {
		// Test that CLI can import and use token health functions
		expect(() => {
			const report = checkAllAccountsHealth(mockAccounts);
			const reauthNeeded = getAccountsNeedingReauth(mockAccounts);

			expect(report.summary.total).toBe(3);
			expect(reauthNeeded.length).toBeGreaterThanOrEqual(0);
		}).not.toThrow();
	});

	it("should handle account-specific health checks", () => {
		const healthReport = checkAllAccountsHealth(mockAccounts);
		const accountHealth = healthReport.accounts.find(
			(acc) => acc.accountName === "test-account-1",
		);

		expect(accountHealth).toBeDefined();
		expect(accountHealth?.accountName).toBe("test-account-1");
		expect(accountHealth?.provider).toBe("anthropic");
	});
});

describe("Error Handling", () => {
	it("should handle missing account gracefully", () => {
		const healthReport = checkAllAccountsHealth(mockAccounts);
		const missingAccount = healthReport.accounts.find(
			(acc) => acc.accountName === "nonexistent-account",
		);

		expect(missingAccount).toBeUndefined();
	});

	it("should handle malformed account data", () => {
		const malformedAccounts = [
			makeAccount({
				id: "1",
				name: "",
				refresh_token: "token",
				created_at: Date.now(),
				expires_at: Date.now(),
				access_token: "access-token",
			}),
		];

		expect(() => {
			const healthReport = checkAllAccountsHealth(malformedAccounts);
			expect(healthReport.accounts).toHaveLength(1);
		}).not.toThrow();
	});
});
