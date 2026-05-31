import type { Account } from "./account";

export enum StrategyName {
	Session = "session",
	LeastUsed = "least-used",
}

export interface CapacitySignal {
	/** min(100 - utilization) across present HARD windows (excludes extra_usage). */
	minHeadroom: number;
	/** earliest FUTURE reset (ms) across present hard windows; null if none have a reset time. */
	soonestResetMs: number | null;
	/** max utilization across hard windows + extra_usage (used for NEAR_LIMIT ordering). */
	bindingUtilization: number;
}

/**
 * Interface for strategy-specific database operations
 * Allows strategies to interact with the database without direct SQL access
 */
export interface StrategyStore {
	/**
	 * Reset session for an account
	 * Updates session_start and session_request_count
	 */
	resetAccountSession(accountId: string, timestamp: number): void;

	/**
	 * Get all accounts (optional method for strategies that need full account list)
	 */
	getAllAccounts?(): Account[] | Promise<Account[]>;

	/**
	 * Update account request count
	 */
	updateAccountRequestCount?(accountId: string, count: number): void;

	/**
	 * Get account by ID
	 */
	getAccount?(accountId: string): Account | null | Promise<Account | null>;

	/**
	 * Pause an account
	 */
	pauseAccount?(accountId: string): void;

	/**
	 * Resume a paused account
	 */
	resumeAccount?(accountId: string): void;

	/**
	 * Get the representative utilization (0–100) for an account based on its
	 * most-constrained usage window. Returns null when no usage data is available.
	 */
	getAccountUtilization?(accountId: string, provider: string): number | null;

	/**
	 * Get a fresh capacity signal for an account, or null when no fresh usage
	 * data is available. Used by capacity-aware routing.
	 */
	getAccountCapacity?(
		accountId: string,
		provider: string,
		now: number,
	): CapacitySignal | null;
}
