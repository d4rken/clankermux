import { describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency (mirrors the account-identity repository tests).
import "@clankermux/core";
import type { Account, AccountIdentity } from "@clankermux/types";
import {
	type AnthropicProfileBackfillDeps,
	isAnthropicProfileBackfillCandidate,
	isAnthropicSubscriptionRecaptureCandidate,
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

/** An account whose profile was captured before the subscription fields were. */
function makeRecaptureAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		identity_profile_fetched_at: 1_700_000_000_000,
		identity_subscription_started_at: null,
		...overrides,
	});
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

describe("isAnthropicSubscriptionRecaptureCandidate", () => {
	it("selects an account whose profile was fetched but holds no subscription start", () => {
		expect(
			isAnthropicSubscriptionRecaptureCandidate(makeRecaptureAccount()),
		).toBe(true);
	});

	it("skips an account that already has a subscription start", () => {
		expect(
			isAnthropicSubscriptionRecaptureCandidate(
				makeRecaptureAccount({
					identity_subscription_started_at: 1_690_000_000_000,
				}),
			),
		).toBe(false);
	});

	// A never-fetched account belongs to the other population, which has its own
	// self-clearing gate; selecting it here would fetch it twice in one pass.
	it("skips an account that has never had a profile fetch", () => {
		expect(
			isAnthropicSubscriptionRecaptureCandidate(
				makeAccount({ identity_profile_fetched_at: null }),
			),
		).toBe(false);
	});

	it("skips an api-key account, a non-anthropic provider and a dead token", () => {
		expect(
			isAnthropicSubscriptionRecaptureCandidate(
				makeRecaptureAccount({ refresh_token: "", access_token: null }),
			),
		).toBe(false);
		expect(
			isAnthropicSubscriptionRecaptureCandidate(
				makeRecaptureAccount({ provider: "codex" }),
			),
		).toBe(false);
		expect(
			isAnthropicSubscriptionRecaptureCandidate(
				makeRecaptureAccount({
					paused: true,
					pause_reason: "oauth_invalid_grant",
				}),
			),
		).toBe(false);
	});
});

describe("runAnthropicProfileBackfill — subscription re-capture", () => {
	const identityWithSubscription: AccountIdentity = {
		externalAccountId: "ext-1",
		email: "u@example.com",
		organizationName: "Org",
		planTier: "max",
		rateLimitTier: "20x",
		subscriptionStatus: "active",
		subscriptionStartedAt: 1_690_000_000_000,
	};

	function depsFor(
		accounts: Account[],
		claim: AnthropicProfileBackfillDeps["claimSubscriptionRecapture"],
	): {
		deps: AnthropicProfileBackfillDeps;
		writes: string[];
	} {
		const writes: string[] = [];
		return {
			writes,
			deps: {
				getAccounts: async () => accounts,
				fetchProfile: async () => identityWithSubscription,
				setIdentity: async (accountId) => {
					writes.push(accountId);
				},
				claimSubscriptionRecapture: claim,
				sleep: noopSleep,
				initialDelayMs: 0,
				staggerMs: 0,
			},
		};
	}

	it("re-fetches an already-stamped account when it claims the marker", async () => {
		const { deps, writes } = depsFor(
			[makeRecaptureAccount({ id: "stamped", name: "stamped" })],
			async () => true,
		);

		await runAnthropicProfileBackfill(deps);

		expect(writes).toEqual(["stamped"]);
	});

	// The gate is the marker, NOT the null subscription column: the profile of an
	// account that reports no subscription data still leaves that column null, so
	// a predicate-only gate would re-fetch it on every boot forever.
	it("never re-fetches once the marker is held, even with the column still null", async () => {
		const { deps, writes } = depsFor(
			[makeRecaptureAccount({ id: "stamped", name: "stamped" })],
			async () => false,
		);

		await runAnthropicProfileBackfill(deps);

		expect(writes).toEqual([]);
	});

	it("does not spend the claim when nothing needs re-capturing", async () => {
		let claims = 0;
		const { deps } = depsFor(
			[
				makeRecaptureAccount({
					id: "done",
					name: "done",
					identity_subscription_started_at: 1_690_000_000_000,
				}),
			],
			async () => {
				claims++;
				return true;
			},
		);

		await runAnthropicProfileBackfill(deps);

		expect(claims).toBe(0);
	});

	it("leaves the population alone when no claim dep is wired", async () => {
		const { deps, writes } = depsFor(
			[makeRecaptureAccount({ id: "stamped", name: "stamped" })],
			undefined,
		);

		await runAnthropicProfileBackfill(deps);

		expect(writes).toEqual([]);
	});

	// Fail-closed: an unavailable database must skip the population, not slip it
	// past the gate.
	it("skips re-capture when the claim throws, still covering never-fetched accounts", async () => {
		const { deps, writes } = depsFor(
			[
				makeAccount({ id: "fresh", name: "fresh" }),
				makeRecaptureAccount({ id: "stamped", name: "stamped" }),
			],
			async () => {
				throw new Error("db locked");
			},
		);

		await runAnthropicProfileBackfill(deps);

		expect(writes).toEqual(["fresh"]);
	});

	// One loop for both populations: the profile endpoint shares the usage
	// endpoint's rate-limit bucket, so the stagger has to cover every fetch.
	it("covers both populations in a single staggered pass", async () => {
		const staggers: number[] = [];
		const { deps, writes } = depsFor(
			[
				makeAccount({ id: "fresh", name: "fresh" }),
				makeRecaptureAccount({ id: "stamped", name: "stamped" }),
			],
			async () => true,
		);
		deps.staggerMs = 2_500;
		deps.sleep = async (ms: number) => {
			staggers.push(ms);
		};

		await runAnthropicProfileBackfill(deps);

		expect(writes).toEqual(["fresh", "stamped"]);
		expect(staggers).toEqual([2_500]);
	});

	// D9: the pass snapshots every account up front, then waits out an initial
	// delay before its first fetch. A token refresh during that window — routine
	// on a restart with expired credentials, where usage polling refreshes
	// credentials while the backfill sleeps — leaves the snapshot's copy stale.
	// For the never-fetched population the resulting 401 is harmless: the account
	// stays eligible next boot. For re-capture it is terminal, because the marker
	// is already claimed and the account is never selected again.
	it("D9: fetches a re-capture candidate with the stored token, not the snapshot's", async () => {
		// `stored` is the row as the database holds it. getAccounts hands out a
		// COPY, which is what a real query does, so a write landing after the
		// snapshot is invisible to anything still reading the snapshotted object.
		// getAccessToken reads `stored` live, which is the seam the fix uses.
		const stored = makeRecaptureAccount({
			id: "stamped",
			name: "stamped",
			access_token: "t-stale",
		});
		const tokensSeen: string[] = [];

		const deps: AnthropicProfileBackfillDeps = {
			getAccounts: async () => [{ ...stored }],
			getAccessToken: async () => stored.access_token,
			fetchProfile: async (token) => {
				tokensSeen.push(token);
				// Upstream 401s on the superseded token; the profile fetch contract is
				// fail-open, so that surfaces as null.
				return token === stored.access_token ? identityWithSubscription : null;
			},
			setIdentity: async () => {},
			claimSubscriptionRecapture: async () => true,
			initialDelayMs: 15_000,
			staggerMs: 0,
			// The refresh lands while the pass is waiting out its initial delay.
			sleep: async () => {
				stored.access_token = "t-fresh";
			},
		};

		await runAnthropicProfileBackfill(deps);

		expect(tokensSeen).toEqual(["t-fresh"]);
	});

	// The resolver is the only token source once it is wired: a null from it
	// (the account deleted, or its token cleared, mid-pass) skips the account
	// rather than falling back to the snapshot's copy.
	it("skips a re-capture candidate whose token resolver yields null", async () => {
		const tokensSeen: string[] = [];
		const writes: string[] = [];

		await runAnthropicProfileBackfill({
			getAccounts: async () => [
				makeRecaptureAccount({ id: "stamped", name: "stamped" }),
			],
			getAccessToken: async () => null,
			fetchProfile: async (token) => {
				tokensSeen.push(token);
				return identityWithSubscription;
			},
			setIdentity: async (accountId) => {
				writes.push(accountId);
			},
			claimSubscriptionRecapture: async () => true,
			initialDelayMs: 0,
			staggerMs: 0,
			sleep: noopSleep,
		});

		expect(tokensSeen).toEqual([]);
		expect(writes).toEqual([]);
	});
});
