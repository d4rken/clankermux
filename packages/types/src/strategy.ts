import type { Account } from "./account";
import type { RequestMeta } from "./api";

export enum StrategyName {
	Session = "session",
	LeastUsed = "least-used",
}

export interface CapacitySignal {
	/** min(100 - utilization) across present HARD windows (excludes extra_usage). */
	minHeadroom: number;
	/** min(100 - utilization) of the 5h session window; 100 if no session window present. */
	sessionHeadroom: number;
	/** earliest FUTURE reset (ms) across present hard windows; null if none have a reset time. */
	soonestResetMs: number | null;
	/** max utilization across hard windows + extra_usage (used for NEAR_LIMIT ordering). */
	bindingUtilization: number;
	/** soonest reset (ms) among WEEKLY windows {seven_day, seven_day_oauth_apps}; null if none. HARVEST deadline. */
	weeklyResetMs: number | null;
	/**
	 * Reset (ms) of the MOST-CONSTRAINED weekly window — the one whose headroom
	 * equals `weeklyHeadroom` (max utilization). null when that window has no known
	 * reset. Distinct from `weeklyResetMs` (earliest across ALL weekly windows,
	 * used for HARVEST ranking): the reservation gate's harvest-yield must track the
	 * binding window's reset, not an unrelated sooner-resetting window's.
	 */
	bindingWeeklyResetMs: number | null;
	/** min(100 - util) over weekly windows; 100 if none present. HARVEST tie-break. */
	weeklyHeadroom: number;
	/**
	 * Reset (ms) of the 5h session window; null when absent or unknown. Explicit
	 * for the same reason `sessionHeadroom` is: `soonestResetMs` is a min() across
	 * all hard windows and loses WHICH window it came from, so the session's own
	 * reset is NOT recoverable from the aggregate.
	 */
	sessionResetMs: number | null;
	/**
	 * extra_usage utilization, or null when absent. Explicit because it is a
	 * RESETLESS constraint: it is folded into `bindingUtilization` but has no
	 * reset, so an account it binds never self-recovers. Not recoverable from
	 * the aggregate.
	 */
	extraUsageUtilization: number | null;
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

// Load balancing strategy interface
export interface LoadBalancingStrategy {
	/**
	 * Return a filtered & ordered list of candidate accounts.
	 * Accounts that are rate-limited should be filtered out.
	 * The first account in the list should be tried first.
	 */
	select(accounts: Account[], meta: RequestMeta): Account[];

	/**
	 * Side-effect-free preview: the filtered & ordered accounts a fresh,
	 * no-affinity request would consider, BEFORE proxy-level gates (provider
	 * overload, usage throttling, context-window, burst). MUST NOT mutate
	 * routing state. `peek` returns peekRanked()[0]?.id ?? null.
	 */
	peekRanked(accounts: Account[]): Account[];

	/**
	 * Side-effect-free preview: return the ID of the account that would
	 * be picked first by select() given the current state, or null if
	 * no account is available. MUST NOT mutate any state (no DB writes,
	 * no resumeAccount, no resetSession, no internal counters).
	 */
	peek(accounts: Account[]): string | null;

	/**
	 * Optional initialization method to inject dependencies
	 * Used for strategies that need access to a StrategyStore
	 */
	initialize?(store: StrategyStore): void;

	/**
	 * Optional: clear all session-affinity pins pointing at the given account,
	 * so its stuck sessions re-pick on their next request. Returns the number
	 * of pins removed. Strategies without affinity (e.g. LeastUsed) omit this.
	 */
	clearAffinityForAccount?(accountId: string): number;
}
