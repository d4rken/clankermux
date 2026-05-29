import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import {
	ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	isProviderOverloaded,
} from "@clankermux/proxy";
import type { AccountResponse } from "@clankermux/types";
import {
	createAccountForceResetRateLimitHandler,
	createAccountsListHandler,
} from "../accounts";

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
		}),
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

	it("force reset clears the shared provider overload cooldown", async () => {
		applyProviderOverloadCooldown("anthropic", Date.now() + 60_000);
		expect(isProviderOverloaded("anthropic")).toBe(true);
		expect(isProviderOverloaded("claude-console-api")).toBe(true);

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
