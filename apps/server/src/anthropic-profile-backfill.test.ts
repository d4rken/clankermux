import { describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency (mirrors the account-identity repository tests).
import "@clankermux/core";
import type { Account, AccountIdentity } from "@clankermux/types";
import {
	type AnthropicProfileBackfillDeps,
	isAnthropicProfileBackfillCandidate,
	runAnthropicProfileBackfill,
} from "./anthropic-profile-backfill";

/**
 * Build an Account with only the fields the backfill reads; every other field is
 * a benign default. Cast to Account — the routine never touches the rest.
 */
function makeAccount(overrides: Partial<Account>): Account {
	return {
		id: "acc",
		name: "acc",
		provider: "anthropic",
		refresh_token: "refresh",
		access_token: "access",
		identity_profile_fetched_at: null,
		identity_subscription_started_at: null,
		pause_reason: null,
		...overrides,
	} as Account;
}

const noopSleep = async (): Promise<void> => {};

describe("isAnthropicProfileBackfillCandidate", () => {
	it("selects an anthropic OAuth account with a null profile-fetch timestamp", () => {
		expect(isAnthropicProfileBackfillCandidate(makeAccount({}))).toBe(true);
	});

	it("skips an api-key account (no refresh/access token)", () => {
		expect(
			isAnthropicProfileBackfillCandidate(
				makeAccount({ refresh_token: "", access_token: null }),
			),
		).toBe(false);
	});

	it("skips an account that already has a profile fetch timestamp", () => {
		expect(
			isAnthropicProfileBackfillCandidate(
				makeAccount({ identity_profile_fetched_at: 1_700_000_000_000 }),
			),
		).toBe(false);
	});

	it("skips an account paused for a dead/invalid refresh token", () => {
		expect(
			isAnthropicProfileBackfillCandidate(
				makeAccount({ paused: true, pause_reason: "oauth_invalid_grant" }),
			),
		).toBe(false);
	});

	it("skips a non-anthropic provider", () => {
		expect(
			isAnthropicProfileBackfillCandidate(makeAccount({ provider: "codex" })),
		).toBe(false);
	});

	it("still selects an account paused for a NON-dead-token reason (e.g. overage)", () => {
		expect(
			isAnthropicProfileBackfillCandidate(
				makeAccount({ paused: true, pause_reason: "overage" }),
			),
		).toBe(true);
	});
});

describe("runAnthropicProfileBackfill", () => {
	function collectingDeps(
		accounts: Account[],
		fetchProfile: AnthropicProfileBackfillDeps["fetchProfile"],
	): {
		deps: AnthropicProfileBackfillDeps;
		writes: Array<{ accountId: string; identity: AccountIdentity }>;
	} {
		const writes: Array<{ accountId: string; identity: AccountIdentity }> = [];
		const deps: AnthropicProfileBackfillDeps = {
			getAccounts: async () => accounts,
			fetchProfile,
			setIdentity: async (accountId, identity) => {
				writes.push({ accountId, identity });
			},
			// No real timers in tests.
			sleep: noopSleep,
			initialDelayMs: 0,
			staggerMs: 0,
		};
		return { deps, writes };
	}

	const sampleIdentity: AccountIdentity = {
		externalAccountId: "ext-1",
		email: "u@example.com",
		organizationName: "Org",
		planTier: "max",
		rateLimitTier: "20x",
	};

	it("writes identity for a candidate when the profile fetch returns data", async () => {
		const { deps, writes } = collectingDeps(
			[makeAccount({ id: "a1", name: "a1" })],
			async () => sampleIdentity,
		);

		await runAnthropicProfileBackfill(deps);

		expect(writes).toHaveLength(1);
		expect(writes[0].accountId).toBe("a1");
		expect(writes[0].identity).toEqual(sampleIdentity);
	});

	it("does NOT write (leaves the account eligible) when the fetch returns null", async () => {
		const { deps, writes } = collectingDeps(
			[makeAccount({ id: "a1", name: "a1" })],
			async () => null,
		);

		await runAnthropicProfileBackfill(deps);

		expect(writes).toHaveLength(0);
	});

	it("only fetches candidates — api-key / already-fetched / dead-token are skipped", async () => {
		const fetched: string[] = [];
		const accounts = [
			makeAccount({ id: "ok", name: "ok" }),
			makeAccount({
				id: "apikey",
				name: "apikey",
				refresh_token: "",
				access_token: null,
			}),
			makeAccount({
				id: "done",
				name: "done",
				identity_profile_fetched_at: 123,
			}),
			makeAccount({
				id: "dead",
				name: "dead",
				paused: true,
				pause_reason: "oauth_invalid_grant",
			}),
		];
		const { deps, writes } = collectingDeps(accounts, async (token) => {
			fetched.push(token);
			return sampleIdentity;
		});

		await runAnthropicProfileBackfill(deps);

		// Only the single eligible account was fetched + written.
		expect(fetched).toHaveLength(1);
		expect(writes.map((w) => w.accountId)).toEqual(["ok"]);
	});

	it("is crash-safe: a throwing fetch for one account never aborts the run", async () => {
		const accounts = [
			makeAccount({ id: "boom", name: "boom", access_token: "t-boom" }),
			makeAccount({ id: "good", name: "good", access_token: "t-good" }),
		];
		const { deps, writes } = collectingDeps(accounts, async (token) => {
			if (token === "t-boom") throw new Error("network down");
			return sampleIdentity;
		});

		// Must resolve (never reject) despite the thrown error.
		await runAnthropicProfileBackfill(deps);

		// The healthy account was still processed.
		expect(writes.map((w) => w.accountId)).toEqual(["good"]);
	});
});

describe("runAnthropicProfileBackfill — live token resolution", () => {
	const identity: AccountIdentity = {
		externalAccountId: "ext-1",
		email: "u@example.com",
		organizationName: "Org",
		planTier: "max",
		rateLimitTier: "20x",
	};

	// The pass snapshots every account up front, then waits out an initial delay
	// before its first fetch. A token refresh during that window — routine on a
	// restart with expired credentials, where usage polling refreshes credentials
	// while the backfill sleeps — leaves the snapshot's copy stale, and the
	// resulting 401 costs the account its fill until the next restart.
	it("fetches with the stored token, not the snapshot's", async () => {
		// `stored` is the row as the database holds it. getAccounts hands out a
		// COPY, which is what a real query does, so a write landing after the
		// snapshot is invisible to anything still reading the snapshotted object.
		// getAccessToken reads `stored` live, which is the seam the fix uses.
		const stored = makeAccount({
			id: "fresh",
			name: "fresh",
			access_token: "t-stale",
		});
		const tokensSeen: string[] = [];

		await runAnthropicProfileBackfill({
			getAccounts: async () => [{ ...stored }],
			getAccessToken: async () => stored.access_token,
			fetchProfile: async (token) => {
				tokensSeen.push(token);
				// Upstream 401s on the superseded token; the profile fetch contract is
				// fail-open, so that surfaces as null.
				return token === stored.access_token ? identity : null;
			},
			setIdentity: async () => {},
			initialDelayMs: 15_000,
			staggerMs: 0,
			// The refresh lands while the pass is waiting out its initial delay.
			sleep: async () => {
				stored.access_token = "t-fresh";
			},
		});

		expect(tokensSeen).toEqual(["t-fresh"]);
	});

	// The resolver is the only token source once it is wired: a null from it
	// (the account deleted, or its token cleared, mid-pass) skips the account
	// rather than falling back to the snapshot's copy.
	it("skips a candidate whose token resolver yields null", async () => {
		const tokensSeen: string[] = [];
		const writes: string[] = [];

		await runAnthropicProfileBackfill({
			getAccounts: async () => [makeAccount({ id: "fresh", name: "fresh" })],
			getAccessToken: async () => null,
			fetchProfile: async (token) => {
				tokensSeen.push(token);
				return identity;
			},
			setIdentity: async (accountId) => {
				writes.push(accountId);
			},
			initialDelayMs: 0,
			staggerMs: 0,
			sleep: noopSleep,
		});

		expect(tokensSeen).toEqual([]);
		expect(writes).toEqual([]);
	});
});
