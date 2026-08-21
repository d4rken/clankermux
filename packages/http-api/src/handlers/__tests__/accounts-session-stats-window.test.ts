import { describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import type { AccountResponse } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Minimal account row — only the columns this handler path actually reads. */
function makeAccountRow(overrides: Record<string, unknown>) {
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
		codex_auto_apply_reset_credits_enabled: 0,
		codex_auto_apply_reset_on_weekly_limit_enabled: 0,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		identity_external_id: null,
		identity_email: null,
		identity_organization_name: null,
		identity_plan_tier: null,
		identity_rate_limit_tier: null,
		identity_captured_at: null,
		identity_profile_fetched_at: null,
		...overrides,
	};
}

const SESSION_STATS = {
	requests: 324,
	inputTokens: 72_200,
	cacheCreationInputTokens: 9_900_000,
	cacheReadInputTokens: 61_300_000,
	outputTokens: 283_600,
	planCostUsd: 98.15,
	apiCostUsd: 0,
};

/**
 * Captures what the handler asks `getSessionStats` for, and answers as the real
 * repository does: accounts whose `session_start` arrives null are excluded
 * outright, so the freshness gate can be asserted through the response as well
 * as through the recorded argument.
 */
function makeDbOps(accounts: ReturnType<typeof makeAccountRow>[]) {
	const seen: Array<{ id: string; session_start: number | null }> = [];
	const dbOps = {
		getAdapter: () => ({
			query: async (sql: string) =>
				sql.includes("FROM accounts") ? accounts : [],
			get: async () => null,
		}),
		getStatsRepository: () => ({
			getSessionStats: async (
				requested: Array<{ id: string; session_start: number | null }>,
			) => {
				seen.length = 0;
				seen.push(...requested);
				return new Map(
					requested
						.filter((entry) => entry.session_start !== null)
						.map((entry) => [entry.id, SESSION_STATS]),
				);
			},
			getActiveSessionCountsByAccount: async () => new Map(),
		}),
		getLatestUsageSnapshots: async () => [],
		getRecentUsageSnapshotsForAccounts: async () => [],
	} as unknown as DatabaseOperations;
	return { dbOps, seen };
}

const config = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

describe("accounts list — session stats are bounded to the open window", () => {
	it("reports stats for a session window that is still open", async () => {
		const { dbOps, seen } = makeDbOps([
			makeAccountRow({
				id: "acc-open",
				session_start: Date.now() - 60 * 60 * 1000,
				session_request_count: 324,
				session_info: "Active: 324 reqs",
			}),
		]);

		const body = (await (
			await createAccountsListHandler(dbOps, config)()
		).json()) as AccountResponse[];

		expect(seen[0]?.session_start).not.toBeNull();
		expect(body.find((a) => a.id === "acc-open")?.sessionStats).toEqual(
			SESSION_STATS,
		);
	});

	it("drops stats once the window has elapsed", async () => {
		// `session_start` is never cleared when a window closes, so without the
		// freshness bound an account idle for days keeps reporting the spend of a
		// window that ended — beside a `session_info` that already reads "-".
		const { dbOps, seen } = makeDbOps([
			makeAccountRow({
				id: "acc-elapsed",
				session_start: Date.now() - (FIVE_HOURS_MS + 60_000),
				session_request_count: 324,
				session_info: "-",
			}),
		]);

		const body = (await (
			await createAccountsListHandler(dbOps, config)()
		).json()) as AccountResponse[];

		expect(seen[0]?.session_start).toBeNull();
		expect(body.find((a) => a.id === "acc-elapsed")?.sessionStats).toBeNull();
	});

	it("treats a window exactly five hours old as closed", async () => {
		// The SQL that produces `session_info` uses a strict `<`, so the boundary
		// itself is outside the window; the stats gate has to agree or the two
		// disagree for one request at exactly 5h.
		const { dbOps, seen } = makeDbOps([
			makeAccountRow({
				id: "acc-boundary",
				session_start: Date.now() - FIVE_HOURS_MS,
				session_request_count: 324,
			}),
		]);

		const body = (await (
			await createAccountsListHandler(dbOps, config)()
		).json()) as AccountResponse[];

		expect(seen[0]?.session_start).toBeNull();
		expect(body.find((a) => a.id === "acc-boundary")?.sessionStats).toBeNull();
	});

	it("carries a null session_start through unchanged", async () => {
		const { dbOps, seen } = makeDbOps([
			makeAccountRow({ id: "acc-none", session_start: null }),
		]);

		const body = (await (
			await createAccountsListHandler(dbOps, config)()
		).json()) as AccountResponse[];

		expect(seen[0]?.session_start).toBeNull();
		expect(body.find((a) => a.id === "acc-none")?.sessionStats).toBeNull();
	});
});
