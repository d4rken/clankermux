import { describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency (mirrors the account-identity repository tests).
import "@clankermux/core";
import { makeAccount } from "@clankermux/test-support";
import type { Account, AccountIdentity } from "@clankermux/types";
import {
	ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS,
	type AnthropicSubscriptionRefreshDeps,
	isAnthropicSubscriptionRefreshDue,
	refreshAnthropicSubscription,
	withAnthropicSubscriptionRefresh,
} from "./anthropic-subscription-refresh";

const NOW = 1_800_000_000_000;

const ACTIVE: AccountIdentity = {
	externalAccountId: "ext-1",
	email: "u@example.com",
	organizationName: "Org",
	planTier: "max",
	rateLimitTier: "20x",
	subscriptionStatus: "active",
	subscriptionStartedAt: 1_690_000_000_000,
};

const CANCELED: AccountIdentity = { ...ACTIVE, subscriptionStatus: "canceled" };

/**
 * A stand-in for the account row plus the two writes the refresh performs, so a
 * test can assert what the row looks like AFTER a read the way the database
 * would hold it — including the columns the refresh must never touch.
 */
function fakeStore(account: Account) {
	const row: Account = { ...account };
	const fetches: string[] = [];
	return {
		row,
		fetches,
		deps(
			fetchProfile: (accessToken: string) => Promise<AccountIdentity | null>,
			now: () => number = () => NOW,
		): AnthropicSubscriptionRefreshDeps {
			return {
				getAccount: async () => row,
				fetchProfile: (accessToken) => {
					fetches.push(accessToken);
					return fetchProfile(accessToken);
				},
				setIdentity: async (_accountId, identity) => {
					// COALESCE merge, like the real identity write.
					row.identity_subscription_status =
						identity.subscriptionStatus ?? row.identity_subscription_status;
					row.identity_subscription_started_at =
						identity.subscriptionStartedAt ??
						row.identity_subscription_started_at;
				},
				touchSubscriptionCheck: async (_accountId, checkedAtMs) => {
					row.identity_subscription_checked_at = checkedAtMs;
				},
				now,
			};
		},
	};
}

describe("isAnthropicSubscriptionRefreshDue", () => {
	it("is due when the subscription has never been checked", () => {
		expect(
			isAnthropicSubscriptionRefreshDue(
				makeAccount({ identity_subscription_checked_at: null }),
				NOW,
			),
		).toBe(true);
	});

	it("is due once the last check is older than the throttle", () => {
		expect(
			isAnthropicSubscriptionRefreshDue(
				makeAccount({
					identity_subscription_checked_at:
						NOW - ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS - 1,
				}),
				NOW,
			),
		).toBe(true);
	});

	it("is not due inside the throttle window", () => {
		expect(
			isAnthropicSubscriptionRefreshDue(
				makeAccount({
					identity_subscription_checked_at:
						NOW - ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS + 1,
				}),
				NOW,
			),
		).toBe(false);
	});

	it("skips a Claude console API-key account (no OAuth refresh token)", () => {
		expect(
			isAnthropicSubscriptionRefreshDue(
				makeAccount({ provider: "claude-console-api", refresh_token: "" }),
				NOW,
			),
		).toBe(false);
	});

	it("skips every non-Anthropic provider", () => {
		for (const provider of ["codex", "devin", "zai", "claude-console-api"]) {
			expect(
				isAnthropicSubscriptionRefreshDue(makeAccount({ provider }), NOW),
			).toBe(false);
		}
	});
});

describe("refreshAnthropicSubscription", () => {
	it("reads and persists when the subscription has never been checked", async () => {
		const store = fakeStore(
			makeAccount({ identity_subscription_checked_at: null }),
		);

		await refreshAnthropicSubscription(
			"acc-1",
			"t-live",
			store.deps(async () => ACTIVE),
		);

		expect(store.fetches).toEqual(["t-live"]);
		expect(store.row.identity_subscription_status).toBe("active");
		expect(store.row.identity_subscription_checked_at).toBe(NOW);
	});

	it("issues no read inside the throttle window", async () => {
		const store = fakeStore(
			makeAccount({ identity_subscription_checked_at: NOW - 60_000 }),
		);

		await refreshAnthropicSubscription(
			"acc-1",
			"t-live",
			store.deps(async () => ACTIVE),
		);

		expect(store.fetches).toEqual([]);
		expect(store.row.identity_subscription_checked_at).toBe(NOW - 60_000);
	});

	it("persists a status transition (active → canceled)", async () => {
		const store = fakeStore(
			makeAccount({
				identity_subscription_status: "active",
				identity_subscription_checked_at:
					NOW - ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS,
			}),
		);

		await refreshAnthropicSubscription(
			"acc-1",
			"t-live",
			store.deps(async () => CANCELED),
		);

		expect(store.row.identity_subscription_status).toBe("canceled");
	});

	// Without this a failing account is re-read on every 90s poll tick, which is
	// the load the throttle exists to prevent.
	it("advances the throttle on a fetch that fails open (null)", async () => {
		const store = fakeStore(
			makeAccount({
				identity_subscription_status: "active",
				identity_subscription_checked_at: null,
			}),
		);

		await refreshAnthropicSubscription(
			"acc-1",
			"t-live",
			store.deps(async () => null),
		);

		expect(store.row.identity_subscription_checked_at).toBe(NOW);
		// A failed read states nothing, so it must not erase what a previous one saw.
		expect(store.row.identity_subscription_status).toBe("active");
	});

	it("advances the throttle when the fetch throws", async () => {
		const store = fakeStore(
			makeAccount({ identity_subscription_checked_at: null }),
		);

		await refreshAnthropicSubscription(
			"acc-1",
			"t-live",
			store.deps(async () => {
				throw new Error("network down");
			}),
		);

		expect(store.row.identity_subscription_checked_at).toBe(NOW);
	});

	it("leaves pause state untouched when the read fails", async () => {
		const store = fakeStore(
			makeAccount({
				paused: true,
				pause_reason: "overage",
				identity_subscription_checked_at: null,
			}),
		);

		await refreshAnthropicSubscription(
			"acc-1",
			"t-live",
			store.deps(async () => {
				throw new Error("network down");
			}),
		);

		expect(store.row.paused).toBe(true);
		expect(store.row.pause_reason).toBe("overage");
	});

	it("never reads a non-Anthropic account, nor stamps its throttle", async () => {
		const store = fakeStore(
			makeAccount({
				provider: "codex",
				identity_subscription_checked_at: null,
			}),
		);

		await refreshAnthropicSubscription(
			"acc-1",
			"t-live",
			store.deps(async () => ACTIVE),
		);

		expect(store.fetches).toEqual([]);
		expect(store.row.identity_subscription_checked_at).toBeNull();
	});

	it("skips an account that no longer exists", async () => {
		const fetches: string[] = [];

		await refreshAnthropicSubscription("gone", "t-live", {
			getAccount: async () => null,
			fetchProfile: async (token) => {
				fetches.push(token);
				return ACTIVE;
			},
			setIdentity: async () => {},
			touchSubscriptionCheck: async () => {},
			now: () => NOW,
		});

		expect(fetches).toEqual([]);
	});

	it("never rejects, so it can be detached from the poll", async () => {
		await expect(
			refreshAnthropicSubscription("acc-1", "t-live", {
				getAccount: async () => {
					throw new Error("database busy");
				},
				fetchProfile: async () => ACTIVE,
				setIdentity: async () => {},
				touchSubscriptionCheck: async () => {},
				now: () => NOW,
			}),
		).resolves.toBeUndefined();
	});
});

describe("withAnthropicSubscriptionRefresh", () => {
	it("reads with the token this invocation resolved, not the stored copy", async () => {
		// The row holds a token that a refresh has already superseded — exactly
		// the staleness a snapshot-captured token reintroduces.
		const store = fakeStore(
			makeAccount({
				access_token: "t-stale",
				identity_subscription_checked_at: null,
			}),
		);
		const reads: Array<Promise<void>> = [];
		const provider = withAnthropicSubscriptionRefresh(
			"acc-1",
			async () => "t-fresh",
			{
				...store.deps(async () => ACTIVE),
				detach: (read) => {
					reads.push(read);
				},
			},
		);

		expect(await provider()).toBe("t-fresh");
		await Promise.all(reads);

		expect(store.fetches).toEqual(["t-fresh"]);
	});

	it("resolves each read's token afresh across the throttle boundary", async () => {
		const store = fakeStore(
			makeAccount({ identity_subscription_checked_at: null }),
		);
		const tokens = ["t-first", "t-second"];
		let now = NOW;
		const reads: Array<Promise<void>> = [];
		const provider = withAnthropicSubscriptionRefresh(
			"acc-1",
			async () => tokens.shift() ?? "exhausted",
			{
				...store.deps(
					async () => ACTIVE,
					() => now,
				),
				detach: (read) => {
					reads.push(read);
				},
			},
		);

		await provider();
		now = NOW + ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS;
		await provider();
		await Promise.all(reads);

		expect(store.fetches).toEqual(["t-first", "t-second"]);
	});

	it("returns the token without waiting for the read to settle", async () => {
		const store = fakeStore(
			makeAccount({ identity_subscription_checked_at: null }),
		);
		const provider = withAnthropicSubscriptionRefresh(
			"acc-1",
			async () => "t-live",
			{
				// A read that never settles must not hold up the poll that resolved
				// this token.
				...store.deps(() => new Promise<AccountIdentity | null>(() => {})),
			},
		);

		expect(await provider()).toBe("t-live");
	});

	it("still returns the token when the read throws", async () => {
		const store = fakeStore(
			makeAccount({ identity_subscription_checked_at: null }),
		);
		const reads: Array<Promise<void>> = [];
		const provider = withAnthropicSubscriptionRefresh(
			"acc-1",
			async () => "t-live",
			{
				...store.deps(async () => {
					throw new Error("network down");
				}),
				detach: (read) => {
					reads.push(read);
				},
			},
		);

		expect(await provider()).toBe("t-live");
		await Promise.all(reads);
	});

	it("propagates a token-resolution failure untouched, and issues no read", async () => {
		const store = fakeStore(
			makeAccount({ identity_subscription_checked_at: null }),
		);
		const provider = withAnthropicSubscriptionRefresh(
			"acc-1",
			async () => {
				throw new Error("refresh rejected");
			},
			store.deps(async () => ACTIVE),
		);

		// The poller's own onTokenRefreshFailure handling depends on seeing this.
		await expect(provider()).rejects.toThrow("refresh rejected");
		expect(store.fetches).toEqual([]);
	});
});
