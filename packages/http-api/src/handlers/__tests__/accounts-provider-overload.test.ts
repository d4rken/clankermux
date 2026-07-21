import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import {
	ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	completeProviderOverloadProbe,
	getProviderOverloadSnapshot,
	isProviderOverloaded,
	tryAcquireProviderOverloadProbe,
} from "@clankermux/proxy";
import type {
	Account,
	AccountResponse,
	LoadBalancingStrategy,
} from "@clankermux/types";
import {
	createAccountForceResetRateLimitHandler,
	createAccountsListHandler,
} from "../accounts";

// Strategy stub that ranks accounts in the order given and never mutates state.
function rankingStrategy(order: string[]): LoadBalancingStrategy {
	return {
		select: () => {
			throw new Error("select() must not be called by the badge");
		},
		peekRanked: (accounts: Account[]) =>
			order
				.map((id) => accounts.find((a) => a.id === id))
				.filter((a): a is Account => a != null),
		peek: (accounts: Account[]) => {
			const ranked = order
				.map((id) => accounts.find((a) => a.id === id))
				.filter((a): a is Account => a != null);
			return ranked[0]?.id ?? null;
		},
	};
}

interface AccountRow {
	id: string;
	name: string;
	provider: string | null;
	request_count: number;
	total_requests: number;
	last_used: number | null;
	created_at: number;
	expires_at: number | null;
	rate_limited_until: number | null;
	rate_limited_reason: string | null;
	rate_limited_at: number | null;
	rate_limit_reset: number | null;
	rate_limit_status: string | null;
	rate_limit_remaining: number | null;
	session_start: number | null;
	session_request_count: number;
	refresh_token: string;
	access_token: string | null;
	paused: 0 | 1;
	priority: number;
	token_valid: 0 | 1;
	rate_limited: 0 | 1;
	session_info: string | null;
	auto_fallback_enabled: 0 | 1;
	auto_refresh_enabled: 0 | 1;
	auto_pause_on_overage_enabled: 0 | 1;
	peak_hours_pause_enabled: 0 | 1;
	custom_endpoint: string | null;
	model_mappings: string | null;
	model_fallbacks: string | null;
	billing_type: string | null;
	pause_reason: string | null;
}

function makeAccountRow(overrides: Partial<AccountRow>): AccountRow {
	return {
		id: "acc-1",
		name: "Account 1",
		provider: "anthropic",
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		expires_at: Date.now() + 60_000,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		session_start: null,
		session_request_count: 0,
		refresh_token: "refresh-token",
		access_token: "access-token",
		paused: 0,
		priority: 0,
		token_valid: 1,
		rate_limited: 0,
		session_info: "-",
		auto_fallback_enabled: 0,
		auto_refresh_enabled: 0,
		auto_pause_on_overage_enabled: 0,
		peak_hours_pause_enabled: 0,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		...overrides,
	};
}

function makeDbOps(
	accounts: AccountRow[],
	options: {
		forceResetAccountRateLimit?: (accountId: string) => Promise<boolean>;
	} = {},
): DatabaseOperations {
	return {
		getAdapter: () => ({
			query: async (sql: string) => {
				if (sql.includes("FROM accounts")) {
					return accounts;
				}
				return [];
			},
			get: async (_sql: string, params?: unknown[]) => {
				const accountId = Array.isArray(params) ? params[0] : undefined;
				return accounts.find((account) => account.id === accountId) ?? null;
			},
		}),
		getStatsRepository: () => ({
			getSessionStats: async () => new Map(),
			getActiveSessionCountsByAccount: async () => new Map(),
		}),
		getLatestUsageSnapshots: async () => [],
		forceResetAccountRateLimit:
			options.forceResetAccountRateLimit ?? (async () => true),
	} as unknown as DatabaseOperations;
}

const config = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

describe("accounts list provider overload state", () => {
	beforeEach(() => {
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		clearProviderOverloadCooldown();
	});

	it("surfaces active official Anthropic upstream cooldowns on affected accounts", async () => {
		const overloadedUntil = applyProviderOverloadCooldown(
			"anthropic",
			Date.now() + 60_000,
		);
		const handler = createAccountsListHandler(
			makeDbOps([
				makeAccountRow({
					id: "anthropic-oauth",
					name: "Anthropic OAuth",
					provider: "anthropic",
				}),
				makeAccountRow({
					id: "claude-console",
					name: "Claude Console",
					provider: "claude-console-api",
				}),
				makeAccountRow({
					id: "codex",
					name: "Codex",
					provider: "codex",
				}),
			]),
			config,
		);

		const response = await handler();
		const body = (await response.json()) as AccountResponse[];

		expect(response.status).toBe(200);
		expect(body).toHaveLength(3);

		const anthropic = body.find((account) => account.id === "anthropic-oauth");
		const consoleApi = body.find((account) => account.id === "claude-console");
		const codex = body.find((account) => account.id === "codex");

		expect(anthropic?.providerOverloadKey).toBe(
			ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
		);
		expect(consoleApi?.providerOverloadKey).toBe(
			ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
		);
		expect(anthropic?.providerOverloadedUntil).toBe(overloadedUntil);
		expect(consoleApi?.providerOverloadedUntil).toBe(overloadedUntil);
		expect(codex?.providerOverloadKey).toBeNull();
		expect(codex?.providerOverloadedUntil).toBeNull();
	});

	it("surfaces family-scoped breaker buckets in providerOverload", async () => {
		const now = Date.now();
		const haikuUntil = applyProviderOverloadCooldown(
			"anthropic",
			now + 60_000,
			"claude-haiku-4-5",
		);
		const wideUntil = applyProviderOverloadCooldown("anthropic", now + 120_000);

		const handler = createAccountsListHandler(
			makeDbOps([
				makeAccountRow({
					id: "anthropic-oauth",
					name: "Anthropic OAuth",
					provider: "anthropic",
				}),
				makeAccountRow({
					id: "codex",
					name: "Codex",
					provider: "codex",
				}),
			]),
			config,
		);

		const response = await handler();
		const body = (await response.json()) as AccountResponse[];
		const anthropic = body.find((account) => account.id === "anthropic-oauth");
		const codex = body.find((account) => account.id === "codex");

		expect(anthropic?.providerOverload).toHaveLength(2);
		expect(anthropic?.providerOverload).toEqual(
			expect.arrayContaining([
				{
					family: "haiku",
					state: "open",
					until: haikuUntil,
					probeActive: false,
				},
				{ family: null, state: "open", until: wideUntil, probeActive: false },
			]),
		);
		// The legacy scalar stays the max across ALL buckets (source-compatible).
		expect(anthropic?.providerOverloadedUntil).toBe(wideUntil);
		// A fully-closed provider carries no bucket list.
		expect(codex?.providerOverload).toBeNull();
	});

	it("reports half-open buckets with an active probe", async () => {
		const originalDateNow = Date.now;
		let now = originalDateNow();
		Date.now = () => now;
		try {
			const until = applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			now = until + 1; // cooldown elapsed → bucket is half-open
			const admission = tryAcquireProviderOverloadProbe(
				"anthropic",
				"claude-haiku-4-5",
				now,
			);
			expect(admission.admitted).toBe(true);

			const handler = createAccountsListHandler(
				makeDbOps([
					makeAccountRow({
						id: "anthropic-oauth",
						name: "Anthropic OAuth",
						provider: "anthropic",
					}),
				]),
				config,
			);
			const response = await handler();
			const body = (await response.json()) as AccountResponse[];
			const anthropic = body.find(
				(account) => account.id === "anthropic-oauth",
			);

			expect(anthropic?.providerOverload).toEqual([
				{ family: "haiku", state: "half-open", until: null, probeActive: true },
			]);
			// Half-open buckets never block routing, so the legacy scalar is null.
			expect(anthropic?.providerOverloadedUntil).toBeNull();

			if (admission.admitted) {
				completeProviderOverloadProbe(admission.token, "abandoned");
			}
		} finally {
			Date.now = originalDateNow;
		}
	});

	it("moves the Primary badge to Codex when Anthropic is provider-overloaded", async () => {
		applyProviderOverloadCooldown("anthropic", Date.now() + 60_000);

		const handler = createAccountsListHandler(
			makeDbOps([
				makeAccountRow({
					id: "anthropic-oauth",
					name: "Anthropic OAuth",
					provider: "anthropic",
				}),
				makeAccountRow({
					id: "codex",
					name: "Codex",
					provider: "codex",
				}),
			]),
			config,
			// Strategy ranks Anthropic first; the overload gate must skip it and
			// the badge fall through to Codex.
			() => rankingStrategy(["anthropic-oauth", "codex"]),
		);

		const response = await handler();
		const body = (await response.json()) as AccountResponse[];

		expect(response.status).toBe(200);

		const anthropic = body.find((account) => account.id === "anthropic-oauth");
		const codex = body.find((account) => account.id === "codex");

		expect(anthropic?.isPrimary).toBe(false);
		expect(codex?.isPrimary).toBe(true);
	});

	it("force reset clears every breaker bucket of the provider (family + provider-wide)", async () => {
		applyProviderOverloadCooldown("anthropic", Date.now() + 60_000);
		applyProviderOverloadCooldown(
			"anthropic",
			Date.now() + 60_000,
			"claude-haiku-4-5",
		);
		applyProviderOverloadCooldown(
			"anthropic",
			Date.now() + 60_000,
			"claude-sonnet-4-5",
		);
		expect(isProviderOverloaded("anthropic")).toBe(true);
		expect(isProviderOverloaded("claude-console-api")).toBe(true);
		expect(getProviderOverloadSnapshot("anthropic")).toHaveLength(3);

		const resetCalls: string[] = [];
		const handler = createAccountForceResetRateLimitHandler(
			makeDbOps(
				[
					makeAccountRow({
						id: "anthropic-oauth",
						name: "Anthropic OAuth",
						provider: "anthropic",
						access_token: null,
					}),
				],
				{
					forceResetAccountRateLimit: async (accountId) => {
						resetCalls.push(accountId);
						return true;
					},
				},
			),
		);

		const response = await handler({} as Request, "anthropic-oauth");
		const body = (await response.json()) as { usagePollTriggered: boolean };

		expect(response.status).toBe(200);
		expect(resetCalls).toEqual(["anthropic-oauth"]);
		expect(body.usagePollTriggered).toBe(false);
		expect(isProviderOverloaded("anthropic")).toBe(false);
		expect(isProviderOverloaded("claude-console-api")).toBe(false);
		expect(
			isProviderOverloaded("anthropic", Date.now(), "claude-haiku-4-5"),
		).toBe(false);
		expect(getProviderOverloadSnapshot("anthropic")).toHaveLength(0);
	});

	it("does not clear provider overload when the async reset fails", async () => {
		applyProviderOverloadCooldown("anthropic", Date.now() + 60_000);
		const handler = createAccountForceResetRateLimitHandler(
			makeDbOps(
				[
					makeAccountRow({
						id: "anthropic-oauth",
						name: "Anthropic OAuth",
						provider: "anthropic",
						access_token: null,
					}),
				],
				{ forceResetAccountRateLimit: async () => false },
			),
		);

		const originalConsoleError = console.error;
		console.error = () => {};
		let response: Response;
		try {
			response = await handler({} as Request, "anthropic-oauth");
		} finally {
			console.error = originalConsoleError;
		}

		expect(response.status).toBe(500);
		expect(isProviderOverloaded("anthropic")).toBe(true);
		expect(isProviderOverloaded("claude-console-api")).toBe(true);
	});
});
