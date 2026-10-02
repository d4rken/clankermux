import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import { tempDbTracker } from "@clankermux/test-support";
import type {
	Account,
	AccountResponse,
	AnthropicUsageData,
	LoadBalancingStrategy,
} from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

/**
 * A Codex subscription that will not renew paces its weekly window to the
 * subscription end, and the account list reports that end, applies it to the
 * throttle status, and hands it to the Primary preview. Against a real database
 * so the row projection is what is under test.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const temp = tempDbTracker("accounts-subscription-budget-end");

const throttlingConfig = {
	getUsageThrottlingFiveHourEnabled: () => true,
	getUsageThrottlingWeeklyEnabled: () => true,
} as unknown as Config;

/** Ranks `order` first-to-last, using the candidate objects it was handed. */
function rankingStrategy(order: string[]): LoadBalancingStrategy {
	const rank = (accounts: Account[]) =>
		order
			.map((id) => accounts.find((account) => account.id === id))
			.filter((account): account is Account => account !== undefined);
	return {
		select: () => {
			throw new Error("the list must not call select()");
		},
		peekRanked: rank,
		peek: (accounts: Account[]) => rank(accounts)[0]?.id ?? null,
	} as unknown as LoadBalancingStrategy;
}

describe("account list: non-renewing subscription end", () => {
	let db: DatabaseOperations;
	let endsAt: number;
	const ids = ["codex-ending", "codex-renewing", "codex-unknown", "claude-1"];

	beforeEach(async () => {
		db = new DatabaseOperations(temp.next());
		const now = Date.now();
		endsAt = now + 12 * HOUR_MS;
		for (const [id, provider, willRenew] of [
			["codex-ending", "codex", 0],
			["codex-renewing", "codex", 1],
			["codex-unknown", "codex", null],
			["claude-1", "anthropic", 0],
		] as const)
			await db
				.getAdapter()
				.run(
					"INSERT INTO accounts (id, name, provider, created_at, refresh_token, identity_subscription_will_renew, identity_subscription_ends_at) VALUES (?, ?, ?, ?, '', ?, ?)",
					[id, id, provider, now, willRenew, endsAt],
				);
		// The weekly window opened 2 days ago and resets in 5; 50% used is ahead
		// of the 7-day pace (~28.6%) but behind a pace ending in 12 h (80%).
		const usage = {
			five_hour: {
				utilization: 0,
				resets_at: new Date(now + 4 * HOUR_MS).toISOString(),
			},
			seven_day: {
				utilization: 50,
				resets_at: new Date(now + 5 * DAY_MS).toISOString(),
			},
		} as AnthropicUsageData;
		usageCache.set("codex-ending", usage);
		usageCache.set("codex-renewing", usage);
	});

	afterEach(async () => {
		for (const id of ids) usageCache.delete(id);
		await db.dispose();
		temp.cleanup();
	});

	const list = async (order: string[]) =>
		Object.fromEntries(
			(
				(await (
					await createAccountsListHandler(db, throttlingConfig, () =>
						rankingStrategy(order),
					)()
				).json()) as AccountResponse[]
			).map((account) => [account.id, account]),
		);

	it("reports the end only for a Codex subscription reported as not renewing", async () => {
		const accounts = await list(ids);
		expect(accounts["codex-ending"]?.subscriptionBudgetEndMs).toBe(endsAt);
		expect(accounts["codex-renewing"]?.subscriptionBudgetEndMs).toBeNull();
		expect(accounts["codex-unknown"]?.subscriptionBudgetEndMs).toBeNull();
		expect(accounts["claude-1"]?.subscriptionBudgetEndMs).toBeNull();
	});

	it("paces the throttle status to the end", async () => {
		const accounts = await list(ids);
		expect(accounts["codex-renewing"]?.usageThrottledUntil).not.toBeNull();
		expect(accounts["codex-ending"]?.usageThrottledUntil).toBeNull();
	});

	it("gives the Primary preview the end", async () => {
		// Ranked first, the renewing account is throttled on the 7-day pace; the
		// ending one is not, so it becomes Primary only if the preview sees the end.
		const accounts = await list(["codex-renewing", "codex-ending"]);
		expect(accounts["codex-renewing"]?.isPrimary).toBe(false);
		expect(accounts["codex-ending"]?.isPrimary).toBe(true);
	});
});
