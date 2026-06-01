import { beforeEach, describe, expect, it } from "bun:test";
import { SessionStrategy } from "@clankermux/load-balancer";
import type {
	Account,
	CapacitySignal,
	RequestMeta,
	StrategyStore,
} from "@clankermux/types";

// ---------------------------------------------------------------------------
// Shared Account factory — keeps every test focused on the fields that
// actually differ. Gemini review flagged the previous inline-everything
// style as verbose and hard to maintain.
// ---------------------------------------------------------------------------
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "test-account",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "test",
		access_token: "test",
		expires_at: Date.now() + 3600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

// Mock StrategyStore for testing
class MockStrategyStore implements StrategyStore {
	resetCalls: Array<{ accountId: string; timestamp: number }> = [];
	resumeCalls: string[] = [];
	utilizationMap: Map<string, number | null> = new Map();
	capacityMap: Map<string, CapacitySignal | null> = new Map();

	resetAccountSession(accountId: string, timestamp: number): void {
		this.resetCalls.push({ accountId, timestamp });
	}

	resumeAccount(accountId: string): void {
		this.resumeCalls.push(accountId);
	}

	getAccountUtilization(accountId: string, _provider: string): number | null {
		if (!this.utilizationMap.has(accountId)) return null;
		return this.utilizationMap.get(accountId) ?? null;
	}

	setUtilization(accountId: string, value: number | null): void {
		this.utilizationMap.set(accountId, value);
	}

	getAccountCapacity(
		accountId: string,
		_provider: string,
		_now: number,
	): CapacitySignal | null {
		return this.capacityMap.get(accountId) ?? null;
	}

	setCapacity(accountId: string, signal: CapacitySignal | null): void {
		this.capacityMap.set(accountId, signal);
	}

	// Helper methods for testing
	clear(): void {
		this.resetCalls = [];
		this.resumeCalls = [];
		this.utilizationMap.clear();
		this.capacityMap.clear();
	}

	getResetCall(
		accountId: string,
	): { accountId: string; timestamp: number } | undefined {
		return this.resetCalls.find((call) => call.accountId === accountId);
	}

	hasResumeCall(accountId: string): boolean {
		return this.resumeCalls.includes(accountId);
	}
}

describe("SessionStrategy", () => {
	let strategy: SessionStrategy;
	let mockStore: MockStrategyStore;
	let meta: RequestMeta;

	beforeEach(() => {
		strategy = new SessionStrategy(5 * 60 * 60 * 1000); // 5 hour default duration
		mockStore = new MockStrategyStore();
		strategy.initialize(mockStore);

		meta = {
			id: "test-request",
			headers: new Headers(),
			path: "/v1/messages",
			method: "POST",
			timestamp: Date.now(),
		};
	});

	beforeEach(() => {
		mockStore.clear();
	});

	it("should reset session when rate limit window has reset", () => {
		const sessionStart = Date.now() - 2 * 60 * 60 * 1000;
		const account = makeAccount({
			id: "test-account-1",
			name: "test-account-1",
			session_start: sessionStart,
			session_request_count: 5,
			rate_limit_reset: Date.now() - 2000, // Reset 2s ago (expired, with 1s buffer)
		});

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(sessionStart);

		expect(account.session_start).toBeGreaterThan(sessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should work normally for non-Anthropic providers without session duration tracking", () => {
		const account = makeAccount({
			id: "test-account-2",
			name: "test-account-2",
			provider: "zai",
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			session_start: Date.now() - 2 * 60 * 60 * 1000,
			session_request_count: 5,
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should work normally when rate_limit_reset is in the future", () => {
		const account = makeAccount({
			id: "test-account-3",
			name: "test-account-3",
			session_start: Date.now() - 2 * 60 * 60 * 1000,
			session_request_count: 5,
			rate_limit_reset: Date.now() + 10000, // 10s in the future
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should reset session when both fixed duration and rate limit have expired for Anthropic accounts", () => {
		const sessionStart = Date.now() - 6 * 60 * 60 * 1000;
		const account = makeAccount({
			id: "test-account-4",
			name: "test-account-4",
			session_start: sessionStart, // 6h ago (beyond 5h limit)
			session_request_count: 10,
			rate_limit_reset: Date.now() - 2000, // expired
		});

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(sessionStart);

		expect(account.session_start).toBeGreaterThan(sessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should reset session when fixed duration expired for Anthropic accounts", () => {
		const sessionStart = Date.now() - 6 * 60 * 60 * 1000;
		const account = makeAccount({
			id: "test-account-5-anthropic",
			name: "test-account-5-anthropic",
			session_start: sessionStart, // beyond 5h
			session_request_count: 10,
		});

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(sessionStart);

		expect(account.session_start).toBeGreaterThan(sessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should reset session when fixed duration expired for zai accounts (zai has session tracking)", () => {
		const sessionStart = Date.now() - 6 * 60 * 60 * 1000;
		const account = makeAccount({
			id: "test-account-6-non-anthropic",
			name: "test-account-6-non-anthropic",
			provider: "zai",
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			session_start: sessionStart,
			session_request_count: 10,
		});

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// zai has requiresSessionTracking: true, so fixed-duration expiry triggers a reset
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);

		expect(account.session_start).toBeGreaterThan(sessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should work normally when rate_limit_reset is explicitly null", () => {
		const account = makeAccount({
			id: "test-account-5",
			name: "test-account-5",
			session_start: Date.now() - 2 * 60 * 60 * 1000,
			session_request_count: 5,
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should not reset session when rate_limit_reset equals current time (boundary condition)", () => {
		const now = Date.now();
		const account = makeAccount({
			id: "test-account-boundary",
			name: "test-account-boundary",
			created_at: now,
			expires_at: now + 3600_000,
			session_start: now - 2 * 60 * 60 * 1000,
			session_request_count: 5,
			rate_limit_reset: now, // boundary
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should reset session when rate_limit_reset is just less than now - 1000 (boundary condition)", () => {
		const now = Date.now();
		const sessionStart = now - 2 * 60 * 60 * 1000;
		const account = makeAccount({
			id: "test-account-boundary-just-expired",
			name: "test-account-boundary-just-expired",
			created_at: now,
			expires_at: now + 3600_000,
			session_start: sessionStart,
			session_request_count: 5,
			rate_limit_reset: now - 1001, // 1001ms ago
		});

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(sessionStart);

		expect(account.session_start).toBeGreaterThan(sessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should handle multiple accounts with different rate limit reset scenarios", () => {
		const now = Date.now();

		const account1 = makeAccount({
			id: "test-account-1-reset",
			name: "test-account-1-reset",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limit_reset: now - 2000, // expired → triggers reset
			priority: 0,
		});

		const account2 = makeAccount({
			id: "test-account-2-no-reset",
			name: "test-account-2-no-reset",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limit_reset: now, // equal to now → does NOT trigger
			priority: 1,
		});

		const account3 = makeAccount({
			id: "test-account-3-future-reset",
			name: "test-account-3-future-reset",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limit_reset: now + 5000, // future → does NOT trigger
			priority: 2,
		});

		const result = strategy.select([account2, account3, account1], meta);

		expect(result[0]).toBe(account1);
		expect(result).toHaveLength(3);

		const resetCall1 = mockStore.getResetCall(account1.id);
		const resetCall2 = mockStore.getResetCall(account2.id);
		const resetCall3 = mockStore.getResetCall(account3.id);

		expect(resetCall1).toBeDefined();
		expect(resetCall2).toBeUndefined();
		expect(resetCall3).toBeUndefined();

		expect(account1.session_start).toBeGreaterThanOrEqual(now);
		expect(account1.session_request_count).toBe(0);
		expect(account2.session_start).toBe(null);
		expect(account2.session_request_count).toBe(0);
		expect(account3.session_start).toBe(null);
		expect(account3.session_request_count).toBe(0);
	});

	it("should handle auto-fallback with multiple accounts at boundary conditions", () => {
		const now = Date.now();

		const account1 = makeAccount({
			id: "test-account-auto-fallback-reset",
			name: "test-account-auto-fallback-reset",
			created_at: now,
			expires_at: now + 3600_000,
			paused: true,
			rate_limit_reset: now - 2000, // expired
			priority: 0,
			auto_fallback_enabled: true,
		});

		const account2 = makeAccount({
			id: "test-account-no-auto-fallback",
			name: "test-account-no-auto-fallback",
			created_at: now,
			expires_at: now + 3600_000,
			paused: true,
			rate_limit_reset: now, // NOT expired
			priority: 1,
			auto_fallback_enabled: true,
		});

		const result = strategy.select([account2, account1], meta);

		expect(result[0]).toBe(account1);
		expect(result).toHaveLength(1);

		expect(account1.paused).toBe(false);
		expect(mockStore.hasResumeCall(account1.id)).toBe(true);
		expect(account2.paused).toBe(true);
	});

	it("pins auto-fallback affinity to the account that actually serves the request", () => {
		const now = Date.now();
		const projectMeta: RequestMeta = {
			...meta,
			project: "auto-fallback-project",
		};
		const higherPriorityAvailable = makeAccount({
			id: "higher-priority-available",
			name: "higher-priority-available",
			priority: 0,
		});
		const lowerPriorityFallback = makeAccount({
			id: "lower-priority-fallback",
			name: "lower-priority-fallback",
			priority: 1,
			auto_fallback_enabled: true,
			rate_limit_reset: now - 60_000,
		});

		const first = strategy.select(
			[higherPriorityAvailable, lowerPriorityFallback],
			projectMeta,
		);
		const second = strategy.select(
			[higherPriorityAvailable, lowerPriorityFallback],
			projectMeta,
		);

		expect(first[0]).toBe(higherPriorityAvailable);
		expect(second[0]).toBe(higherPriorityAvailable);
		expect(projectMeta.routing?.selectedAccountId).toBe(
			"higher-priority-available",
		);
	});

	// Updated for affinity-first: the dedicated "auto_fallback" decision/early
	// return was removed. A recovered auto-fallback account is now unpaused as a
	// side-effect and re-enters the normal pool; for an UNPINNED request the
	// fresh-pick path (priority_utilization) still routes to the best available
	// account, so utilization tie-breaking continues to favor the low-util one —
	// only the decision label changes from "auto_fallback" to
	// "priority_utilization".
	it("uses utilization tie-breaking after an auto-fallback account recovers", () => {
		const now = Date.now();
		const fallbackHighUtil = makeAccount({
			id: "fallback-high-util",
			name: "fallback-high-util",
			priority: 0,
			auto_fallback_enabled: true,
			rate_limit_reset: now - 60_000,
		});
		const lowUtil = makeAccount({
			id: "low-util",
			name: "low-util",
			priority: 0,
		});

		mockStore.setUtilization(fallbackHighUtil.id, 90);
		mockStore.setUtilization(lowUtil.id, 10);

		const result = strategy.select([fallbackHighUtil, lowUtil], meta);

		expect(result[0]).toBe(lowUtil);
		expect(result[1]).toBe(fallbackHighUtil);
		expect(meta.routing?.decision).toBe("priority_utilization");
		expect(meta.routing?.selectedAccountId).toBe("low-util");
	});

	it("peek uses utilization tie-breaking when auto-fallback would trigger", () => {
		const now = Date.now();
		const fallbackHighUtil = makeAccount({
			id: "fallback-high-util",
			name: "fallback-high-util",
			priority: 0,
			auto_fallback_enabled: true,
			rate_limit_reset: now - 60_000,
		});
		const lowUtil = makeAccount({
			id: "low-util",
			name: "low-util",
			priority: 0,
		});

		mockStore.setUtilization(fallbackHighUtil.id, 90);
		mockStore.setUtilization(lowUtil.id, 10);

		expect(strategy.peek([fallbackHighUtil, lowUtil])).toBe("low-util");
	});

	it("does not honor bypass-session from external client traffic", () => {
		const projectMeta: RequestMeta = {
			...meta,
			project: "external-bypass-project",
			headers: new Headers({ "x-clankermux-bypass-session": "true" }),
		};
		const accountA = makeAccount({
			id: "external-bypass-a",
			name: "external-bypass-a",
		});
		const accountB = makeAccount({
			id: "external-bypass-b",
			name: "external-bypass-b",
		});

		mockStore.setUtilization(accountA.id, 10);
		mockStore.setUtilization(accountB.id, 80);
		expect(strategy.select([accountA, accountB], projectMeta)[0]).toBe(
			accountA,
		);

		mockStore.setUtilization(accountA.id, 80);
		mockStore.setUtilization(accountB.id, 10);
		expect(strategy.select([accountA, accountB], projectMeta)[0]).toBe(
			accountA,
		);
		expect(projectMeta.routing?.decision).toBe("affinity_hit");
	});

	it("should handle unknown providers gracefully", () => {
		const account = makeAccount({
			id: "test-account-unknown",
			name: "test-account-unknown",
			provider: "unknown-provider",
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			session_start: Date.now() - 2 * 60 * 60 * 1000,
			session_request_count: 5,
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should not reset session for Claude console API accounts (pay-as-you-go, no session tracking)", () => {
		const account = makeAccount({
			id: "test-account-console-api",
			name: "test-account-console-api",
			provider: "claude-console-api",
			api_key: "test-api-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			session_start: Date.now() - 6 * 60 * 60 * 1000, // beyond 5h
			session_request_count: 10,
			rate_limit_reset: Date.now() - 1000, // expired, but should be ignored for console API
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	// -------------------------------------------------------------------------
	// Issue #115 — SessionStrategy must yield to live rate-limit state.
	//
	// Before the fix, hasActiveSession() only consulted session_start, so a
	// throttled active-session account would still be considered "active" for
	// the entire 5h Anthropic session window. Combined with #114 (streaming
	// failover bypass), this meant a primary account could be silently
	// throttled and the load-balancer would keep selecting it until either
	// the session expired (5h) or the rate limit window did.
	//
	// These tests assert the new behavior: a currently-rate-limited account
	// has no usable session, but its session_start is preserved so we resume
	// the cached session naturally once the rate-limit window elapses.
	// -------------------------------------------------------------------------

	it("issue #115: yields session affinity when active account is currently rate-limited", () => {
		const now = Date.now();

		const throttled = makeAccount({
			id: "throttled",
			name: "throttled",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limited_until: now + 30 * 60 * 1000, // 30min from now
			session_start: now - 30 * 60 * 1000, // active 30min session
			session_request_count: 50,
		});

		const healthy = makeAccount({
			id: "healthy",
			name: "healthy",
			created_at: now,
			expires_at: now + 3600_000,
		});

		const result = strategy.select([throttled, healthy], meta);

		expect(result[0]).toBe(healthy);
		expect(result.find((a) => a.id === throttled.id)).toBeUndefined();

		// session_start preserved for prompt-cache continuity
		expect(throttled.session_start).toBe(now - 30 * 60 * 1000);
		expect(throttled.session_request_count).toBe(50);
	});

	it("issue #115: resumes the original active session after rate-limit window elapses", () => {
		const now = Date.now();

		const recovered = makeAccount({
			id: "recovered",
			name: "recovered",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limited_until: now - 1000, // elapsed 1s ago
			session_start: now - 60 * 60 * 1000, // 1h into a 5h session
			session_request_count: 25,
		});

		const result = strategy.select([recovered], meta);

		expect(result[0]).toBe(recovered);

		// No reset — original session continues for prompt-cache warmth
		const resetCall = mockStore.getResetCall(recovered.id);
		expect(resetCall).toBeUndefined();
		expect(recovered.session_start).toBe(now - 60 * 60 * 1000);
		expect(recovered.session_request_count).toBe(25);
	});

	it("issue #115: throttled active account does not block lower-priority sibling", () => {
		const now = Date.now();

		const throttledHighPriority = makeAccount({
			id: "high-pri-throttled",
			name: "high-pri-throttled",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limited_until: now + 30 * 60 * 1000,
			session_start: now - 10 * 60 * 1000,
			session_request_count: 5,
			priority: 0,
		});

		const lowerPriority = makeAccount({
			id: "lower-pri-healthy",
			name: "lower-pri-healthy",
			created_at: now,
			expires_at: now + 3600_000,
			priority: 1,
		});

		const result = strategy.select(
			[throttledHighPriority, lowerPriority],
			meta,
		);

		expect(result[0]).toBe(lowerPriority);
	});

	// -------------------------------------------------------------------------
	// Usage-balanced tiebreaking within same-priority accounts
	//
	// When multiple accounts share the same priority value, new sessions should
	// start on the account with the most remaining capacity (lowest utilization).
	// -------------------------------------------------------------------------

	describe("usage-balanced tiebreaking for same-priority accounts", () => {
		it("selects account with lower utilization when priorities are equal", () => {
			const now = Date.now();

			const highUtil = makeAccount({
				id: "high-util",
				name: "high-util",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			const lowUtil = makeAccount({
				id: "low-util",
				name: "low-util",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			mockStore.setUtilization("high-util", 80);
			mockStore.setUtilization("low-util", 20);

			const result = strategy.select([highUtil, lowUtil], meta);

			// low-util has more headroom → should be selected first
			expect(result[0]).toBe(lowUtil);
			expect(result[1]).toBe(highUtil);
		});

		it("sorts null-utilization accounts first (treated as 0%, fresh account)", () => {
			const now = Date.now();

			const withData = makeAccount({
				id: "with-data",
				name: "with-data",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			const noData = makeAccount({
				id: "no-data",
				name: "no-data",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			mockStore.setUtilization("with-data", 50);
			// no-data has no entry in utilizationMap → returns null → treated as 0

			const result = strategy.select([withData, noData], meta);

			// noData treated as 0% → selected first; withData (50%) sorts after
			expect(result[0]).toBe(noData);
			expect(result[1]).toBe(withData);
		});

		it("should treat null utilization as 0 (fresh account)", () => {
			const now = Date.now();

			const accountA = makeAccount({
				id: "account-a-50pct",
				name: "account-a-50pct",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			const accountB = makeAccount({
				id: "account-b-null",
				name: "account-b-null",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			mockStore.setUtilization("account-a-50pct", 50);
			// account-b-null has no utilization data at all → null → treated as 0

			const result = strategy.select([accountA, accountB], meta);

			// account-b-null (null=0%) has more headroom than account-a-50pct (50%) → selected first
			expect(result[0]).toBe(accountB);
			expect(result[1]).toBe(accountA);
		});

		it("does not panic when both accounts have no utilization data", () => {
			const now = Date.now();

			const a = makeAccount({
				id: "account-a",
				name: "account-a",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			const b = makeAccount({
				id: "account-b",
				name: "account-b",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			// Neither account has utilization data

			const result = strategy.select([a, b], meta);

			// Both accounts are returned — order is stable (0 vs 0 → no swap)
			expect(result).toHaveLength(2);
			expect(result).toContain(a);
			expect(result).toContain(b);
		});

		it("priority still wins over utilization for different-priority accounts", () => {
			const now = Date.now();

			// Higher priority (lower number) but higher utilization
			const highPriorityHighUtil = makeAccount({
				id: "high-pri-high-util",
				name: "high-pri-high-util",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			// Lower priority (higher number) but lower utilization
			const lowPriorityLowUtil = makeAccount({
				id: "low-pri-low-util",
				name: "low-pri-low-util",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 1,
			});

			mockStore.setUtilization("high-pri-high-util", 90);
			mockStore.setUtilization("low-pri-low-util", 10);

			const result = strategy.select(
				[lowPriorityLowUtil, highPriorityHighUtil],
				meta,
			);

			// Priority 0 wins even though it has higher utilization
			expect(result[0]).toBe(highPriorityHighUtil);
			expect(result[1]).toBe(lowPriorityLowUtil);
		});
	});

	describe("cache affinity", () => {
		it("continues a project's account even when another account has the newest global session", () => {
			const now = Date.now();
			const projectMeta: RequestMeta = {
				...meta,
				project: "example-project",
			};

			const projectAccount = makeAccount({
				id: "project-account",
				name: "project-account",
				created_at: now,
				expires_at: now + 3600_000,
				session_start: now - 10 * 60 * 1000,
				session_request_count: 10,
				priority: 0,
			});
			const newerGlobalSession = makeAccount({
				id: "newer-global-session",
				name: "newer-global-session",
				created_at: now,
				expires_at: now + 3600_000,
				session_start: now - 60_000,
				session_request_count: 2,
				priority: 0,
			});

			// First request establishes the project affinity.
			expect(
				strategy.select([projectAccount, newerGlobalSession], projectMeta)[0],
			).toBe(projectAccount);

			// A later request from another project made this account the newest
			// global session. The original project must still route to the account
			// that warmed its prompt cache.
			newerGlobalSession.session_start = now;

			const result = strategy.select(
				[projectAccount, newerGlobalSession],
				projectMeta,
			);

			expect(result[0]).toBe(projectAccount);
			expect(projectMeta.routing?.decision).toBe("affinity_hit");
			expect(projectMeta.routing?.affinityScope).toBe("project");
		});

		it("uses explicit Claude session affinity before project affinity", () => {
			const now = Date.now();
			const sharedProject = "shared-project";
			const sessionOneMeta: RequestMeta = {
				...meta,
				id: "session-one",
				affinityKey: "claude-session-one",
				affinityScope: "claude_session",
				project: sharedProject,
			};
			const sessionTwoMeta: RequestMeta = {
				...meta,
				id: "session-two",
				affinityKey: "claude-session-two",
				affinityScope: "claude_session",
				project: sharedProject,
			};

			const accountA = makeAccount({
				id: "account-a",
				name: "account-a",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});
			const accountB = makeAccount({
				id: "account-b",
				name: "account-b",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			mockStore.setUtilization("account-a", 10);
			mockStore.setUtilization("account-b", 80);
			expect(strategy.select([accountA, accountB], sessionOneMeta)[0]).toBe(
				accountA,
			);

			mockStore.setUtilization("account-a", 80);
			mockStore.setUtilization("account-b", 10);
			expect(strategy.select([accountA, accountB], sessionTwoMeta)[0]).toBe(
				accountB,
			);

			accountB.session_start = now;
			expect(strategy.select([accountA, accountB], sessionOneMeta)[0]).toBe(
				accountA,
			);
			expect(sessionOneMeta.routing?.affinityScope).toBe("claude_session");
			expect(sessionOneMeta.routing?.affinityKey).toBe(
				"claude_session:claude-session-one",
			);
		});

		it("uses Codex thread affinity before project affinity", () => {
			const now = Date.now();
			const codexMeta: RequestMeta = {
				...meta,
				affinityKey: "codex-thread-one",
				affinityScope: "codex_thread",
				project: "shared-project",
			};
			const accountA = makeAccount({
				id: "codex-a",
				name: "codex-a",
				provider: "codex",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});
			const accountB = makeAccount({
				id: "codex-b",
				name: "codex-b",
				provider: "codex",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			mockStore.setUtilization("codex-a", 10);
			mockStore.setUtilization("codex-b", 80);
			expect(strategy.select([accountA, accountB], codexMeta)[0]).toBe(
				accountA,
			);

			accountB.session_start = now;
			expect(strategy.select([accountA, accountB], codexMeta)[0]).toBe(
				accountA,
			);
			expect(codexMeta.routing?.affinityScope).toBe("codex_thread");
			expect(codexMeta.routing?.affinityKey).toBe(
				"codex_thread:codex-thread-one",
			);
		});

		it("assigns a new project by priority/utilization instead of inheriting an unrelated active session", () => {
			const now = Date.now();
			const projectMeta: RequestMeta = {
				...meta,
				project: "new-project",
			};

			const unrelatedActive = makeAccount({
				id: "unrelated-active",
				name: "unrelated-active",
				created_at: now,
				expires_at: now + 3600_000,
				session_start: now - 60_000,
				session_request_count: 20,
				priority: 0,
			});
			const lowerUtil = makeAccount({
				id: "lower-util",
				name: "lower-util",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});

			mockStore.setUtilization("unrelated-active", 80);
			mockStore.setUtilization("lower-util", 10);

			const result = strategy.select([unrelatedActive, lowerUtil], projectMeta);

			expect(result[0]).toBe(lowerUtil);
		});

		it("reassigns project affinity on a long (5h) rate-limit exhaustion and does not snap back", () => {
			const now = Date.now();
			const projectMeta: RequestMeta = {
				...meta,
				project: "exhausted-project",
			};

			const affined = makeAccount({
				id: "affined",
				name: "affined",
				created_at: now,
				expires_at: now + 3600_000,
				session_start: now - 60_000,
				session_request_count: 4,
			});
			const healthy = makeAccount({
				id: "healthy-after-affinity",
				name: "healthy-after-affinity",
				created_at: now,
				expires_at: now + 3600_000,
			});

			expect(strategy.select([affined, healthy], projectMeta)[0]).toBe(affined);

			// Real 5h usage-window exhaustion — account parked for hours.
			affined.rate_limited_until = now + 5 * 60 * 60 * 1000;
			affined.rate_limited_reason = "upstream_429_with_reset";
			const result = strategy.select([affined, healthy], projectMeta);

			expect(result[0]).toBe(healthy);
			expect(result).not.toContain(affined);

			// The cooldown lifts, but affinity was permanently reassigned to
			// healthy — the project must NOT snap back to the exhausted account.
			affined.rate_limited_until = null;
			affined.rate_limited_reason = null;
			expect(strategy.select([affined, healthy], projectMeta)[0]).toBe(healthy);
		});

		it("holds project affinity through a short 429 cooldown and snaps back on recovery", () => {
			const now = Date.now();
			const projectMeta: RequestMeta = {
				...meta,
				project: "throttled-project",
			};

			const affined = makeAccount({
				id: "affined",
				name: "affined",
				created_at: now,
				expires_at: now + 3600_000,
				session_start: now - 60_000,
				session_request_count: 4,
			});
			const healthy = makeAccount({
				id: "healthy-after-affinity",
				name: "healthy-after-affinity",
				created_at: now,
				expires_at: now + 3600_000,
			});

			expect(strategy.select([affined, healthy], projectMeta)[0]).toBe(affined);

			// Short per-minute throttle — resolves in seconds; switching wastes
			// the warmed prompt cache. Serve elsewhere this request but hold the
			// affinity slot.
			affined.rate_limited_until = now + 60_000;
			affined.rate_limited_reason = "upstream_429_no_reset_probe_cooldown";
			expect(strategy.select([affined, healthy], projectMeta)[0]).toBe(healthy);
			expect(projectMeta.routing?.decision).toBe("affinity_hold");

			// Cooldown lifts → the project snaps back to its warmed account.
			affined.rate_limited_until = null;
			affined.rate_limited_reason = null;
			expect(strategy.select([affined, healthy], projectMeta)[0]).toBe(affined);
		});

		it("holds project affinity through a 529 overload regardless of cooldown length", () => {
			const now = Date.now();
			const projectMeta: RequestMeta = {
				...meta,
				project: "overloaded-project",
			};

			const affined = makeAccount({
				id: "affined",
				name: "affined",
				created_at: now,
				expires_at: now + 3600_000,
				session_start: now - 60_000,
				session_request_count: 4,
			});
			const healthy = makeAccount({
				id: "healthy-after-affinity",
				name: "healthy-after-affinity",
				created_at: now,
				expires_at: now + 3600_000,
			});

			expect(strategy.select([affined, healthy], projectMeta)[0]).toBe(affined);

			// 529 overloaded is server-wide; switching to another account of the
			// same provider doesn't help. Hold affinity even though the cooldown
			// (30 min) exceeds the reassign threshold.
			affined.rate_limited_until = now + 30 * 60 * 1000;
			affined.rate_limited_reason = "upstream_529_overloaded_with_reset";
			expect(strategy.select([affined, healthy], projectMeta)[0]).toBe(healthy);
			expect(projectMeta.routing?.decision).toBe("affinity_hold");

			// Overload clears → snap back to the warmed account.
			affined.rate_limited_until = null;
			affined.rate_limited_reason = null;
			expect(strategy.select([affined, healthy], projectMeta)[0]).toBe(affined);
		});

		it("keeps affinity for non-session-tracking providers until TTL expiry", () => {
			const projectMeta: RequestMeta = {
				...meta,
				project: "openai-compatible-project",
			};
			const accountA = makeAccount({
				id: "openai-compatible-a",
				name: "openai-compatible-a",
				provider: "openai-compatible",
				api_key: "test-key",
				refresh_token: "",
				access_token: null,
				expires_at: null,
			});
			const accountB = makeAccount({
				id: "openai-compatible-b",
				name: "openai-compatible-b",
				provider: "openai-compatible",
				api_key: "test-key",
				refresh_token: "",
				access_token: null,
				expires_at: null,
			});

			mockStore.setUtilization(accountA.id, 10);
			mockStore.setUtilization(accountB.id, 80);
			expect(strategy.select([accountA, accountB], projectMeta)[0]).toBe(
				accountA,
			);

			mockStore.setUtilization(accountA.id, 80);
			mockStore.setUtilization(accountB.id, 10);
			expect(strategy.select([accountA, accountB], projectMeta)[0]).toBe(
				accountA,
			);
			expect(projectMeta.routing?.decision).toBe("affinity_hit");
		});

		// Updated for affinity-first: priority no longer beats stickiness. A pinned
		// session that is still available keeps its account even after a
		// higher-priority account becomes available — the pin is immune to priority
		// edits (the inverse of the pre-affinity-first reassignment behavior).
		it("keeps a pinned account even when a higher-priority account becomes available", () => {
			const now = Date.now();
			const projectMeta: RequestMeta = {
				...meta,
				project: "priority-project",
			};
			const lowerPriorityAffined = makeAccount({
				id: "lower-priority-affined",
				name: "lower-priority-affined",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 1,
			});
			const higherPriorityLater = makeAccount({
				id: "higher-priority-later",
				name: "higher-priority-later",
				created_at: now,
				expires_at: now + 3600_000,
				paused: true,
				pause_reason: "manual",
				priority: 0,
			});

			expect(
				strategy.select(
					[lowerPriorityAffined, higherPriorityLater],
					projectMeta,
				)[0],
			).toBe(lowerPriorityAffined);

			higherPriorityLater.paused = false;
			higherPriorityLater.pause_reason = null;
			const result = strategy.select(
				[lowerPriorityAffined, higherPriorityLater],
				projectMeta,
			);

			// Pin stays on the lower-priority account; the higher-priority account
			// is only the FEFO-ordered fallback tail.
			expect(result[0]).toBe(lowerPriorityAffined);
			expect(result[1]).toBe(higherPriorityLater);
			expect(projectMeta.routing?.decision).toBe("affinity_hit");
		});

		// -------------------------------------------------------------------------
		// Feature 1 — affinity-first selection. A pinned session keeps its account
		// whenever that account is available: immune to BOTH priority edits and
		// auto-fallback (rate-limit recovery). Priority/FEFO govern only new picks.
		// -------------------------------------------------------------------------

		it("pinned session is immune to a higher-priority account being available", () => {
			const now = Date.now();
			const projectMeta: RequestMeta = {
				...meta,
				project: "pinned-priority-project",
			};

			// A is lower priority (1); pin lands on A first because B is unavailable.
			const accountA = makeAccount({
				id: "pinned-A",
				name: "pinned-A",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 1,
			});
			// B is higher priority (0) but starts unavailable so A wins the first pick.
			const accountB = makeAccount({
				id: "higher-priority-B",
				name: "higher-priority-B",
				created_at: now,
				expires_at: now + 3600_000,
				paused: true,
				pause_reason: "manual",
				priority: 0,
			});

			// First select establishes the affinity pin on A.
			expect(strategy.select([accountA, accountB], projectMeta)[0]).toBe(
				accountA,
			);

			// B (higher priority) becomes available. Pre-affinity-first this would
			// have reassigned to B; now the pin stays on A.
			accountB.paused = false;
			accountB.pause_reason = null;
			const result = strategy.select([accountA, accountB], projectMeta);

			expect(result[0]).toBe(accountA);
			expect(projectMeta.routing?.decision).toBe("affinity_hit");
			// B is only the FEFO-ordered fallback tail.
			expect(result[1]).toBe(accountB);
		});

		it("pinned session is immune to auto-fallback re-routing", () => {
			const now = Date.now();
			const projectMeta: RequestMeta = {
				...meta,
				project: "pinned-autofallback-project",
			};

			// Pinned account A — plain, always available.
			const accountA = makeAccount({
				id: "pinned-affinity-A",
				name: "pinned-affinity-A",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
			});
			// B is an auto_fallback_enabled account that has just recovered
			// (rate_limit_reset in the past). Before affinity-first, the auto-fallback
			// early-return would re-route to B; now the pin on A must survive.
			const accountB = makeAccount({
				id: "recovered-fallback-B",
				name: "recovered-fallback-B",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
				auto_fallback_enabled: true,
				rate_limit_reset: now - 60_000,
			});

			// First select pins A (B is recovered but A wins on equal priority via
			// least-recently-picked / stable order; we then assert the pin).
			expect(strategy.select([accountA, accountB], projectMeta)[0]).toBe(
				accountA,
			);

			const result = strategy.select([accountA, accountB], projectMeta);
			expect(result[0]).toBe(accountA);
			expect(projectMeta.routing?.decision).toBe("affinity_hit");
		});

		it("auto-unpause side-effect still runs for a new/unpinned session", () => {
			const now = Date.now();
			// An auto_fallback_enabled account paused for "overage" whose window has
			// elapsed must be unpaused as a side-effect of select() and become
			// selectable — even though the dedicated auto_fallback early-return is gone.
			const recovered = makeAccount({
				id: "recovered-overage",
				name: "recovered-overage",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: now - 60_000,
			});

			// New/unpinned request (no project/affinity key).
			const result = strategy.select([recovered], meta);

			// The unpause side-effect ran...
			expect(mockStore.hasResumeCall(recovered.id)).toBe(true);
			expect(recovered.paused).toBe(false);
			// ...and the recovered account is selectable.
			expect(result[0]).toBe(recovered);
		});

		it("failover still works when the pinned account becomes unavailable", () => {
			const now = Date.now();
			const projectMeta: RequestMeta = {
				...meta,
				project: "failover-project",
			};

			const affined = makeAccount({
				id: "failover-affined",
				name: "failover-affined",
				created_at: now,
				expires_at: now + 3600_000,
				session_start: now - 60_000,
				session_request_count: 4,
			});
			const healthy = makeAccount({
				id: "failover-healthy",
				name: "failover-healthy",
				created_at: now,
				expires_at: now + 3600_000,
			});

			// Pin lands on affined.
			expect(strategy.select([affined, healthy], projectMeta)[0]).toBe(affined);

			// affined goes durably unavailable (long 5h exhaustion) — the pin must
			// NOT stick to the unavailable account; failover serves healthy instead.
			affined.rate_limited_until = now + 5 * 60 * 60 * 1000;
			affined.rate_limited_reason = "upstream_429_with_reset";
			const result = strategy.select([affined, healthy], projectMeta);

			expect(result[0]).toBe(healthy);
			expect(result).not.toContain(affined);
		});

		it("peek matches select primary for the higher-priority-pinned case", () => {
			const now = Date.now();
			const projectMeta: RequestMeta = {
				...meta,
				project: "peek-parity-project",
			};

			// A is lower priority (1) but is the one we want pinned/active.
			const accountA = makeAccount({
				id: "peek-pinned-A",
				name: "peek-pinned-A",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 1,
			});
			// B is higher priority (0); start it unavailable so the first pick (and
			// the Anthropic active session) lands on A.
			const accountB = makeAccount({
				id: "peek-higher-B",
				name: "peek-higher-B",
				created_at: now,
				expires_at: now + 3600_000,
				paused: true,
				pause_reason: "manual",
				priority: 0,
			});

			// First select pins A and starts A's Anthropic session (session_start set
			// via resetSessionIfExpired). B is unavailable so it can't win.
			const first = strategy.select([accountA, accountB], projectMeta);
			expect(first[0]).toBe(accountA);

			// B (higher priority) becomes available.
			accountB.paused = false;
			accountB.pause_reason = null;

			// select stays on A via affinity_hit (immune to B's higher priority).
			const second = strategy.select([accountA, accountB], projectMeta);
			expect(second[0]).toBe(accountA);
			expect(projectMeta.routing?.decision).toBe("affinity_hit");

			// peek has no affinity, but it honors the active-session window without
			// the removed higher-priority override: A is the active session and is
			// available, so peek returns A — matching select()'s primary.
			expect(strategy.peek([accountA, accountB])).toBe(accountA.id);
		});

		it("partitions affinity by authenticated API key identity", () => {
			const now = Date.now();
			const apiKeyOneMeta: RequestMeta = {
				...meta,
				id: "api-key-one",
				project: "shared-project",
				affinityPartition: "api_key:key-one",
			};
			const apiKeyTwoMeta: RequestMeta = {
				...meta,
				id: "api-key-two",
				project: "shared-project",
				affinityPartition: "api_key:key-two",
			};
			const accountA = makeAccount({
				id: "partition-a",
				name: "partition-a",
				created_at: now,
				expires_at: now + 3600_000,
			});
			const accountB = makeAccount({
				id: "partition-b",
				name: "partition-b",
				created_at: now,
				expires_at: now + 3600_000,
			});

			mockStore.setUtilization(accountA.id, 10);
			mockStore.setUtilization(accountB.id, 80);
			expect(strategy.select([accountA, accountB], apiKeyOneMeta)[0]).toBe(
				accountA,
			);

			mockStore.setUtilization(accountA.id, 80);
			mockStore.setUtilization(accountB.id, 10);
			expect(strategy.select([accountA, accountB], apiKeyTwoMeta)[0]).toBe(
				accountB,
			);

			expect(strategy.select([accountA, accountB], apiKeyOneMeta)[0]).toBe(
				accountA,
			);
			expect(apiKeyOneMeta.routing?.affinityKey).toBe(
				"partition:api_key:key-one:project:shared-project",
			);
		});

		it("auto-unpauses a lower-priority pinned candidate even when a higher-priority account is available first", () => {
			// Regression for the auto-unpause early-break: the loop must run the
			// unpause side-effect on EVERY eligible fallback candidate, not just up
			// to the first available one. Here the pinned account (B, priority 1)
			// sorts AFTER an available higher-priority account (A, priority 0). With
			// the old `if (getCachedAvailability(candidate)) break;`, the loop stops
			// at A and never unpauses B; resolveAffinity then sees B as unavailable
			// and wrongly fails the session off its pinned account.
			const now = Date.now();
			const projectMeta: RequestMeta = {
				...meta,
				project: "autounpause-pinned-project",
			};

			// A — higher priority (0). Also an eligible auto-fallback candidate
			// (window reset elapsed) so it appears in the priority-sorted candidate
			// list AHEAD of B. A is never paused, so it is always available — which
			// is exactly what tripped the old early-break.
			const accountA = makeAccount({
				id: "available-higher-A",
				name: "available-higher-A",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 0,
				auto_fallback_enabled: true,
				rate_limit_reset: now - 60_000,
			});
			// B — lower priority (1). We pin the session to B first (while A is
			// unavailable), then pause B for "overage" with an elapsed
			// rate_limit_reset window so it becomes an auto-unpause fallback
			// candidate that sorts AFTER A.
			const accountB = makeAccount({
				id: "pinned-lower-B",
				name: "pinned-lower-B",
				created_at: now,
				expires_at: now + 3600_000,
				priority: 1,
				auto_fallback_enabled: true,
			});

			// First select: A is temporarily unavailable (manual pause) so the pin
			// lands on B and starts B's session window.
			accountA.paused = true;
			accountA.pause_reason = "manual";
			expect(strategy.select([accountA, accountB], projectMeta)[0]).toBe(
				accountB,
			);

			// A becomes available again; B is paused for "overage" with an elapsed
			// reset window (eligible for auto-unpause, sorts AFTER A on priority).
			// A sorts FIRST in the fallback-candidate list and is already available,
			// so the old early-break would stop the loop at A and never reach B.
			accountA.paused = false;
			accountA.pause_reason = null;
			accountB.paused = true;
			accountB.pause_reason = "overage";
			accountB.rate_limit_reset = now - 60_000;

			const result = strategy.select([accountA, accountB], projectMeta);

			// (a) B was auto-unpaused despite A being available and sorting first.
			expect(mockStore.hasResumeCall(accountB.id)).toBe(true);
			expect(accountB.paused).toBe(false);
			// (b) The session stays on its pinned account B — NOT moved to A.
			expect(result[0]).toBe(accountB);
			expect(projectMeta.routing?.decision).toBe("affinity_hit");
		});

		it("caps stored affinity entries", () => {
			const account = makeAccount({
				id: "cap-account",
				name: "cap-account",
			});

			for (let i = 0; i < 10_001; i++) {
				strategy.select([account], {
					...meta,
					id: `request-${i}`,
					project: `project-${i}`,
				});
			}

			const affinityByKey = (
				strategy as unknown as {
					affinityByKey: Map<string, unknown>;
				}
			).affinityByKey;
			expect(affinityByKey.size).toBeLessThanOrEqual(10_000);
		});
	});

	describe("peek auto-unpause parity with select", () => {
		// These mirror the auto-unpause path inside select(): a paused
		// auto-fallback account with safe pause_reason and an elapsed
		// rate_limit_reset window must surface as the would-be Primary
		// in peek() too, otherwise the dashboard flags the wrong account.
		it("returns the paused-but-auto-unpausable account that select() picks", () => {
			const past = Date.now() - 60_000;
			const paused = makeAccount({
				id: "p0-paused",
				priority: 0,
				paused: true,
				pause_reason: null,
				auto_fallback_enabled: true,
				rate_limit_reset: past,
			});
			const ready = makeAccount({ id: "p1-ready", priority: 1 });

			expect(strategy.peek([paused, ready])).toBe("p0-paused");
			// And select() agrees.
			const selected = strategy.select([paused, ready], meta);
			expect(selected[0]?.id).toBe("p0-paused");
		});

		it("does NOT consider manually-paused accounts", () => {
			const past = Date.now() - 60_000;
			const paused = makeAccount({
				id: "p0-manual",
				priority: 0,
				paused: true,
				pause_reason: "manual",
				auto_fallback_enabled: true,
				rate_limit_reset: past,
			});
			const ready = makeAccount({ id: "p1-ready", priority: 1 });
			expect(strategy.peek([paused, ready])).toBe("p1-ready");
		});

		it("peek does not mutate paused state or call resumeAccount", () => {
			const past = Date.now() - 60_000;
			const paused = makeAccount({
				id: "p0",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: past,
			});
			strategy.peek([paused]);
			expect(paused.paused).toBe(true);
			expect(mockStore.resumeCalls).toEqual([]);
		});
	});
});

// ---------------------------------------------------------------------------
// FEFO (first-expire-first-out) capacity-aware tie-breaking.
//
// Within a priority tier, sortAvailableAccounts buckets accounts as
// HARVEST (0) > UNKNOWN (1) > NEAR_LIMIT (2). HARVEST accounts are ordered by
// soonest WEEKLY reset (FEFO on the seven_day window — where unused budget is
// truly lost), then by most weekly headroom, then least-recently picked. The
// 5-hour window is only the NEAR_LIMIT safety gate, never the ranking basis.
// Capacity signals are supplied through MockStrategyStore.setCapacity.
// These accounts use a non-session provider (openai) so session stickiness
// never short-circuits the capacity comparator.
// ---------------------------------------------------------------------------
describe("SessionStrategy — FEFO capacity-aware tie-breaking", () => {
	let strategy: SessionStrategy;
	let mockStore: MockStrategyStore;
	const NOW = Date.now();

	function makeMeta(): RequestMeta {
		return {
			id: "fefo-request",
			headers: new Headers(),
			path: "/v1/messages",
			method: "POST",
			timestamp: NOW,
		};
	}

	// Non-session provider so no active-session path interferes with the
	// capacity comparator (Anthropic would create sticky sessions). openrouter
	// is a known, non-session-tracking provider — avoids the "unknown provider"
	// warning while still skipping session stickiness.
	function makeCapAccount(
		id: string,
		overrides: Partial<Account> = {},
	): Account {
		return makeAccount({ id, name: id, provider: "openrouter", ...overrides });
	}

	// HARVEST ranking is now driven by the WEEKLY window's reset, not the 5h.
	// `weeklyResetMs` is the FEFO deadline; the 5h `soonestResetMs` is kept as a
	// realistic (always-sooner) value that must NOT influence ranking. By default
	// weekly headroom mirrors minHeadroom (the common single-binding-window case).
	function harvest(
		minHeadroom: number,
		weeklyResetMs: number | null,
		bindingUtilization = 100 - minHeadroom,
		weeklyHeadroom = minHeadroom,
		soonestResetMs: number | null = 60_000, // 5h-ish, sooner than any weekly reset
	): CapacitySignal {
		return {
			minHeadroom,
			soonestResetMs,
			bindingUtilization,
			weeklyResetMs,
			weeklyHeadroom,
		};
	}

	beforeEach(() => {
		strategy = new SessionStrategy(5 * 60 * 60 * 1000);
		mockStore = new MockStrategyStore();
		strategy.initialize(mockStore);
	});

	it("HARVEST: equal headroom, picks the nearer weekly-reset account first (FEFO)", () => {
		const nearReset = makeCapAccount("near-reset");
		const farReset = makeCapAccount("far-reset");
		// Same headroom → weekly reset deadline decides; nearer weekly reset first.
		mockStore.setCapacity(nearReset.id, harvest(40, 30 * 60_000));
		mockStore.setCapacity(farReset.id, harvest(40, 4 * 60 * 60_000));

		const meta = makeMeta();
		const result = strategy.select([farReset, nearReset], meta);
		expect(result[0].id).toBe(nearReset.id);
		expect(meta.routing?.selectedAccountId).toBe(nearReset.id);
	});

	it("NEAR_LIMIT (low headroom) sorts after HARVEST even if HARVEST resets later", () => {
		const harvestLate = makeCapAccount("harvest-late");
		const nearLimit = makeCapAccount("near-limit");
		// HARVEST account resets much later than the near-limit account, but the
		// near-limit bucket still loses — buckets dominate FEFO ordering.
		mockStore.setCapacity(harvestLate.id, harvest(40, 4 * 60 * 60_000));
		mockStore.setCapacity(nearLimit.id, harvest(2, 60_000)); // minHeadroom < 5

		const result = strategy.select([nearLimit, harvestLate], makeMeta());
		expect(result[0].id).toBe(harvestLate.id);
		expect(result[1].id).toBe(nearLimit.id);
	});

	it("high bindingUtilization (>95) is NEAR_LIMIT even with healthy headroom", () => {
		const harvestAcct = makeCapAccount("harvest-ok");
		const binding = makeCapAccount("binding-high");
		mockStore.setCapacity(harvestAcct.id, harvest(40, 60 * 60_000));
		// Healthy minHeadroom on the hard windows, but extra_usage pushes the
		// binding utilization above 95 → NEAR_LIMIT bucket. A present weekly
		// window (would-be HARVEST) must not rescue it from the safety gate.
		mockStore.setCapacity(binding.id, {
			minHeadroom: 40,
			soonestResetMs: 60_000,
			bindingUtilization: 98,
			weeklyResetMs: 30 * 60_000,
			weeklyHeadroom: 40,
		});

		const result = strategy.select([binding, harvestAcct], makeMeta());
		expect(result[0].id).toBe(harvestAcct.id);
		expect(result[1].id).toBe(binding.id);
	});

	it("weeklyResetMs null with healthy headroom is UNKNOWN (between HARVEST and NEAR_LIMIT)", () => {
		const harvestAcct = makeCapAccount("harvest");
		const noDeadline = makeCapAccount("no-deadline");
		const nearLimit = makeCapAccount("near-limit");
		mockStore.setCapacity(harvestAcct.id, harvest(40, 60 * 60_000));
		// Known utilization, healthy headroom, but no WEEKLY deadline → UNKNOWN.
		mockStore.setCapacity(noDeadline.id, harvest(40, null));
		mockStore.setCapacity(nearLimit.id, harvest(1, 60_000)); // NEAR_LIMIT

		const result = strategy.select(
			[nearLimit, noDeadline, harvestAcct],
			makeMeta(),
		);
		expect(result.map((a) => a.id)).toEqual([
			harvestAcct.id,
			noDeadline.id,
			nearLimit.id,
		]);
	});

	it("bucket order overall: HARVEST > UNKNOWN > NEAR_LIMIT", () => {
		const harvestAcct = makeCapAccount("h");
		const unknownAcct = makeCapAccount("u"); // no capacity signal → UNKNOWN
		const nearLimit = makeCapAccount("n");
		mockStore.setCapacity(harvestAcct.id, harvest(50, 2 * 60 * 60_000));
		// unknownAcct: deliberately no setCapacity → getAccountCapacity returns null.
		mockStore.setCapacity(nearLimit.id, harvest(3, 60_000));

		const result = strategy.select(
			[nearLimit, unknownAcct, harvestAcct],
			makeMeta(),
		);
		expect(result.map((a) => a.id)).toEqual([
			harvestAcct.id,
			unknownAcct.id,
			nearLimit.id,
		]);
	});

	it("recent-pick rotation: two equivalent HARVEST accounts alternate across selects", () => {
		const a = makeCapAccount("rot-a");
		const b = makeCapAccount("rot-b");
		// Identical capacity → weekly reset + weekly headroom ties → seq
		// (least-recently-picked) breaks it.
		const sig = harvest(40, 60 * 60_000);
		mockStore.setCapacity(a.id, { ...sig });
		mockStore.setCapacity(b.id, { ...sig });

		const first = strategy.select([a, b], makeMeta())[0].id;
		const second = strategy.select([a, b], makeMeta())[0].id;
		expect(first).not.toBe(second);
		expect(new Set([first, second])).toEqual(new Set([a.id, b.id]));
	});

	it("peek/select parity: HARVEST set and all-UNKNOWN set agree", () => {
		// HARVEST set.
		const near = makeCapAccount("p-near");
		const far = makeCapAccount("p-far");
		mockStore.setCapacity(near.id, harvest(40, 20 * 60_000));
		mockStore.setCapacity(far.id, harvest(40, 3 * 60 * 60_000));
		const harvestAccts = [far, near];
		expect(strategy.peek(harvestAccts)).toBe(
			strategy.select(harvestAccts, makeMeta())[0].id,
		);

		// All-UNKNOWN set (no capacity signals; utilization differentiates).
		mockStore.clear();
		const u1 = makeCapAccount("u1");
		const u2 = makeCapAccount("u2");
		mockStore.setUtilization(u1.id, 70);
		mockStore.setUtilization(u2.id, 20);
		const unknownAccts = [u1, u2];
		expect(strategy.peek(unknownAccts)).toBe(
			strategy.select(unknownAccts, makeMeta())[0].id,
		);
	});

	it("priority dominates capacity: priority-0 NEAR_LIMIT beats priority-1 HARVEST", () => {
		const nearLimitTop = makeCapAccount("near-top", { priority: 0 });
		const harvestLow = makeCapAccount("harvest-low", { priority: 1 });
		mockStore.setCapacity(nearLimitTop.id, harvest(1, 60_000)); // NEAR_LIMIT
		mockStore.setCapacity(harvestLow.id, harvest(50, 2 * 60 * 60_000)); // HARVEST

		const result = strategy.select([harvestLow, nearLimitTop], makeMeta());
		expect(result[0].id).toBe(nearLimitTop.id);
	});

	// Reported-bug regression: ranking must follow the WEEKLY reset, NOT the 5h.
	// Account A has tons of weekly headroom and a distant weekly reset, but a
	// SOONER 5-hour reset. Account B's weekly quota is half-spent and resets
	// within the day. Old behavior ranked A first (5h soonest); the fix ranks B
	// first because its weekly budget expires soonest — the operator's intent.
	it("ranks the soon-expiring weekly account first even when the other's 5h resets sooner", () => {
		const a = makeCapAccount("weekly-far-5h-soon");
		const b = makeCapAccount("weekly-soon");
		// A: weekly 98% free, weekly resets in 6 days, but 5h resets in just 3h.
		//    args: minHeadroom, weeklyResetMs, binding, weeklyHeadroom, soonestResetMs(5h)
		mockStore.setCapacity(
			a.id,
			harvest(90, 6 * 24 * 60 * 60_000, 10, 98, 3 * 60 * 60_000),
		);
		// B: weekly 47% free, weekly resets in 9h; its 5h is far (no influence).
		mockStore.setCapacity(
			b.id,
			harvest(47, 9 * 60 * 60_000, 53, 47, 50 * 60 * 60_000),
		);

		const meta = makeMeta();
		const result = strategy.select([a, b], meta);
		// B wins on the weekly reset despite A's 5h resetting much sooner.
		expect(result[0].id).toBe(b.id);
		expect(result[1].id).toBe(a.id);
		expect(meta.routing?.selectedAccountId).toBe(b.id);
	});

	it("peek matches select on the weekly-reset bug-regression scenario", () => {
		const a = makeCapAccount("peek-weekly-far");
		const b = makeCapAccount("peek-weekly-soon");
		mockStore.setCapacity(
			a.id,
			harvest(90, 6 * 24 * 60 * 60_000, 10, 98, 3 * 60 * 60_000),
		);
		mockStore.setCapacity(
			b.id,
			harvest(47, 9 * 60 * 60_000, 53, 47, 50 * 60 * 60_000),
		);
		const accts = [a, b];
		expect(strategy.peek(accts)).toBe(b.id);
		expect(strategy.peek(accts)).toBe(strategy.select(accts, makeMeta())[0].id);
	});

	// R5: an account with no weekly window (only 5h) is UNKNOWN, never HARVEST.
	// Even with a healthy minHeadroom and a near 5h reset, it must NOT rank ahead
	// of a real weekly-HARVEST account — the 5h reset is not a harvest deadline.
	it("no-weekly account is UNKNOWN and does not outrank a real weekly-HARVEST account", () => {
		const weekly = makeCapAccount("weekly-harvest");
		const noWeekly = makeCapAccount("no-weekly");
		// weekly-HARVEST: weekly resets in 8h, healthy headroom.
		mockStore.setCapacity(weekly.id, harvest(40, 8 * 60 * 60_000));
		// no-weekly: healthy minHeadroom, a near 5h reset, but weeklyResetMs null.
		mockStore.setCapacity(noWeekly.id, harvest(60, null, 40, 100, 30 * 60_000));

		const result = strategy.select([noWeekly, weekly], makeMeta());
		// HARVEST (0) beats UNKNOWN (1) — the no-weekly account serves second.
		expect(result[0].id).toBe(weekly.id);
		expect(result[1].id).toBe(noWeekly.id);
	});

	it("weekly tie → higher weeklyHeadroom wins, then seq rotation", () => {
		const more = makeCapAccount("more-weekly-headroom");
		const less = makeCapAccount("less-weekly-headroom");
		// Identical weekly reset; `more` has more weekly headroom to harvest.
		// args: minHeadroom, weeklyResetMs, binding, weeklyHeadroom
		mockStore.setCapacity(more.id, harvest(40, 2 * 60 * 60_000, 60, 70));
		mockStore.setCapacity(less.id, harvest(40, 2 * 60 * 60_000, 60, 30));

		expect(strategy.select([less, more], makeMeta())[0].id).toBe(more.id);

		// Full tie (same reset AND same weekly headroom) → seq alternation.
		const t1 = makeCapAccount("tie-1");
		const t2 = makeCapAccount("tie-2");
		const sig = harvest(40, 2 * 60 * 60_000, 60, 50);
		mockStore.setCapacity(t1.id, { ...sig });
		mockStore.setCapacity(t2.id, { ...sig });
		const first = strategy.select([t1, t2], makeMeta())[0].id;
		const second = strategy.select([t1, t2], makeMeta())[0].id;
		expect(first).not.toBe(second);
	});

	// 5h safety preserved: a low minHeadroom (driven by the 5-hour window) forces
	// NEAR_LIMIT regardless of how soon/healthy the weekly window looks.
	it("NEAR_LIMIT still triggered by low minHeadroom even with a healthy weekly window", () => {
		const safe = makeCapAccount("weekly-safe");
		const fiveHourTight = makeCapAccount("5h-tight");
		mockStore.setCapacity(safe.id, harvest(40, 5 * 60 * 60_000));
		// minHeadroom <= EPS (5h nearly exhausted) but the weekly window is wide
		// open and resets soon — must still bucket NEAR_LIMIT (safety gate).
		mockStore.setCapacity(
			fiveHourTight.id,
			harvest(3, 30 * 60_000, 97, 80, 30 * 60_000),
		);

		const result = strategy.select([fiveHourTight, safe], makeMeta());
		expect(result[0].id).toBe(safe.id);
		expect(result[1].id).toBe(fiveHourTight.id);
	});
});

// ---------------------------------------------------------------------------
// Pinning survives FEFO.
//
// Once a project is pinned to an account (cache affinity), capacity signals
// must NOT pull the request to a different account — the warmed prompt cache is
// worth more than harvesting a soon-to-reset sibling. This is the invariant that
// keeps FEFO from thrashing established sessions: FEFO only orders the *fallback
// tail*, never overrides the sticky primary.
//
// Uses a non-session provider (openai-compatible) so the only stickiness in play
// is cache affinity — there is no Anthropic session window to muddy the test.
// ---------------------------------------------------------------------------
describe("SessionStrategy — pinning survives FEFO", () => {
	let strategy: SessionStrategy;
	let mockStore: MockStrategyStore;

	function projectMeta(): RequestMeta {
		return {
			id: "pin-request",
			headers: new Headers(),
			path: "/v1/messages",
			method: "POST",
			timestamp: Date.now(),
			project: "pinned-project",
		};
	}

	// Non-session provider: affinity is the only stickiness, capacity comparator
	// is never short-circuited by an active Anthropic session.
	function makeAcct(id: string, overrides: Partial<Account> = {}): Account {
		return makeAccount({
			id,
			name: id,
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			priority: 0,
			...overrides,
		});
	}

	// Like the FEFO helper: the second arg is the WEEKLY reset that drives HARVEST
	// ranking. A null weekly reset → UNKNOWN bucket. The 5h reset is a fixed,
	// always-sooner value that must not influence ordering.
	function cap(
		minHeadroom: number,
		weeklyResetMs: number | null,
		bindingUtilization = 100 - minHeadroom,
		weeklyHeadroom = minHeadroom,
		soonestResetMs: number | null = 60_000,
	): CapacitySignal {
		return {
			minHeadroom,
			soonestResetMs,
			bindingUtilization,
			weeklyResetMs,
			weeklyHeadroom,
		};
	}

	beforeEach(() => {
		strategy = new SessionStrategy(5 * 60 * 60 * 1000);
		mockStore = new MockStrategyStore();
		strategy.initialize(mockStore);
	});

	it("a pinned account keeps the request even when FEFO would prefer a sibling", () => {
		const a = makeAcct("acct-A");
		const b = makeAcct("acct-B");
		const c = makeAcct("acct-C");

		// First select establishes the pin on A by making it the FEFO winner
		// (HARVEST, soonest reset). Same priority for all three.
		mockStore.setCapacity(a.id, cap(40, 10 * 60_000)); // reset soonest → wins FEFO
		mockStore.setCapacity(b.id, cap(40, 60 * 60_000));
		mockStore.setCapacity(c.id, cap(40, 90 * 60_000));

		const meta = projectMeta();
		expect(strategy.select([a, b, c], meta)[0].id).toBe(a.id);
		expect(meta.routing?.decision).toBe("affinity_miss");

		// Now flip the capacity signals so a FRESH FEFO pick would NOT choose A:
		//  - A becomes UNKNOWN (no reset deadline) — the worst harvestable bucket.
		//  - B and C become healthy HARVEST accounts with near resets.
		// FEFO alone would now rank B (nearest reset) first, A last.
		mockStore.setCapacity(a.id, cap(40, null)); // UNKNOWN
		mockStore.setCapacity(b.id, cap(50, 15 * 60_000)); // HARVEST, sooner reset
		mockStore.setCapacity(c.id, cap(45, 45 * 60_000)); // HARVEST, later reset

		const second = projectMeta();
		const result = strategy.select([a, b, c], second);

		// Pin wins: A is served first despite worse capacity signals.
		expect(result[0].id).toBe(a.id);
		expect(second.routing?.decision).toBe("affinity_hit");

		// The non-sticky fallback tail is FEFO-ordered: nearer-reset B before
		// later-reset C.
		expect(result.slice(1).map((x) => x.id)).toEqual([b.id, c.id]);
	});

	it("affinity_hold keeps the pin: substitute is served without re-pointing affinity", () => {
		const now = Date.now();
		const a = makeAcct("hold-A");
		const b = makeAcct("hold-B");

		// Pin A on the first select (best FEFO signal).
		mockStore.setCapacity(a.id, cap(40, 10 * 60_000));
		mockStore.setCapacity(b.id, cap(40, 60 * 60_000));
		expect(strategy.select([a, b], projectMeta())[0].id).toBe(a.id);

		// A hits a short, transient throttle — hold the pin, serve from B this
		// request WITHOUT reassigning the affinity slot.
		a.rate_limited_until = now + 60_000;
		a.rate_limited_reason = "upstream_429_no_reset_probe_cooldown";
		const held = projectMeta();
		expect(strategy.select([a, b], held)[0].id).toBe(b.id);
		expect(held.routing?.decision).toBe("affinity_hold");

		// Throttle lifts → the project snaps back to its warmed account A,
		// proving the hold did not re-point affinity to B.
		a.rate_limited_until = null;
		a.rate_limited_reason = null;
		const recovered = projectMeta();
		expect(strategy.select([a, b], recovered)[0].id).toBe(a.id);
		expect(recovered.routing?.decision).toBe("affinity_hit");
	});
});

// ---------------------------------------------------------------------------
// clearAffinityForAccount — the manual "Reset session stickiness" lever.
// Removes every affinity pin pointing at a given account so its sessions
// re-pick on their next request, leaving pins for other accounts untouched.
// Uses a non-session provider (openai-compatible) so affinity is the only
// stickiness in play (no Anthropic session window).
// ---------------------------------------------------------------------------
describe("SessionStrategy — clearAffinityForAccount", () => {
	let strategy: SessionStrategy;
	let mockStore: MockStrategyStore;

	function makeAcct(id: string): Account {
		return makeAccount({
			id,
			name: id,
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			priority: 0,
		});
	}

	function metaForProject(project: string): RequestMeta {
		return {
			id: `req-${project}`,
			headers: new Headers(),
			path: "/v1/messages",
			method: "POST",
			timestamp: Date.now(),
			project,
		};
	}

	beforeEach(() => {
		strategy = new SessionStrategy(5 * 60 * 60 * 1000);
		mockStore = new MockStrategyStore();
		strategy.initialize(mockStore);
	});

	it("clears pins pointing at the target account and returns the count", () => {
		const a = makeAcct("acct-A");
		const b = makeAcct("acct-B");

		// Two projects pin to A (lower utilization → FEFO winner), one pins to B.
		mockStore.setUtilization(a.id, 10);
		mockStore.setUtilization(b.id, 80);
		const projectOne = metaForProject("project-one");
		const projectTwo = metaForProject("project-two");
		expect(strategy.select([a, b], projectOne)[0].id).toBe(a.id);
		expect(strategy.select([a, b], projectTwo)[0].id).toBe(a.id);

		// A third project pins to B (now the FEFO winner).
		mockStore.setUtilization(a.id, 80);
		mockStore.setUtilization(b.id, 10);
		const projectThree = metaForProject("project-three");
		expect(strategy.select([a, b], projectThree)[0].id).toBe(b.id);

		// Clear A's pins: both project-one and project-two pins removed.
		expect(strategy.clearAffinityForAccount(a.id)).toBe(2);

		// project-three (pinned to B) is untouched — it still continues on B
		// even though A now has lower utilization (would-be FEFO winner).
		mockStore.setUtilization(a.id, 10);
		mockStore.setUtilization(b.id, 80);
		const projectThreeAgain = metaForProject("project-three");
		expect(strategy.select([a, b], projectThreeAgain)[0].id).toBe(b.id);
		expect(projectThreeAgain.routing?.decision).toBe("affinity_hit");

		// project-one had its pin cleared → it re-picks fresh (FEFO winner A).
		const projectOneAgain = metaForProject("project-one");
		expect(strategy.select([a, b], projectOneAgain)[0].id).toBe(a.id);
		expect(projectOneAgain.routing?.decision).toBe("affinity_miss");
	});

	it("returns 0 when no pins point at the account", () => {
		const a = makeAcct("acct-A");
		const b = makeAcct("acct-B");

		mockStore.setUtilization(a.id, 10);
		mockStore.setUtilization(b.id, 80);
		// Pin a project to A.
		expect(strategy.select([a, b], metaForProject("only-project"))[0].id).toBe(
			a.id,
		);

		// No project ever pinned to B → clearing B removes nothing.
		expect(strategy.clearAffinityForAccount(b.id)).toBe(0);

		// A's pin survives — the project still continues on A.
		const again = metaForProject("only-project");
		expect(strategy.select([a, b], again)[0].id).toBe(a.id);
		expect(again.routing?.decision).toBe("affinity_hit");
	});
});
