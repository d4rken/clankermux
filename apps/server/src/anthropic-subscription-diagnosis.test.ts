import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { intervalManager } from "@clankermux/core";
import { makeAccount, mockFetch } from "@clankermux/test-support";
import type { Account, AccountIdentity } from "@clankermux/types";
import { usageCache } from "../../../packages/providers/src/usage-fetcher";
import {
	ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_INTERVAL_MS,
	AnthropicSubscriptionDiagnosis,
	type AnthropicSubscriptionDiagnosisDeps,
} from "./anthropic-subscription-diagnosis";
import { observeAnthropicUsage } from "./anthropic-subscription-refresh";

const NOW = 1_800_000_000_000;
const EXPIRED: AccountIdentity = {
	externalAccountId: "expired",
	email: null,
	organizationName: null,
	planTier: "claude_free",
	rateLimitTier: null,
	subscriptionStatus: "canceled",
	anthropicSubscriptionExpired: true,
};
const schedulers: AnthropicSubscriptionDiagnosis[] = [];

afterEach(() => {
	for (const scheduler of schedulers) scheduler.stop();
	schedulers.length = 0;
});

function candidate(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		id: "expired",
		provider: "anthropic",
		refresh_token: "refresh",
		access_token: "fresh",
		paused: true,
		pause_reason: "usage_permission_denied",
		identity_subscription_checked_at: null,
		...overrides,
	});
}

function harness(rows = [candidate()]) {
	const state = {
		now: NOW,
		canFetch: true,
		tokenReads: 0,
		claims: 0,
		writes: 0,
	};
	const fetched: string[] = [];
	const deps: AnthropicSubscriptionDiagnosisDeps = {
		getAccounts: async () => rows.map((row) => ({ ...row })),
		getAccount: async (id) => {
			const row = rows.find((row) => row.id === id);
			return row ? { ...row } : null;
		},
		getAccessToken: async (account) => {
			state.tokenReads++;
			return account.access_token ?? "";
		},
		canFetchProfile: () => state.canFetch,
		fetchProfile: async (token) => {
			fetched.push(token);
			return EXPIRED;
		},
		claimSubscriptionCheck: async (id, now, throttle) => {
			state.claims++;
			const row = rows.find((row) => row.id === id);
			if (!row) return false;
			if (
				row.identity_subscription_checked_at != null &&
				now - row.identity_subscription_checked_at < throttle
			)
				return false;
			row.identity_subscription_checked_at = now;
			return true;
		},
		setIdentity: async (id, identity, token) => {
			const row = rows.find((row) => row.id === id);
			if (!row || row.access_token !== token) return false;
			state.writes++;
			row.identity_profile_fetched_at = state.now;
			row.identity_subscription_status = identity.subscriptionStatus ?? null;
			if (
				identity.anthropicSubscriptionExpired &&
				row.paused &&
				row.pause_reason === "usage_permission_denied"
			)
				row.pause_reason = "subscription_expired";
			return true;
		},
		now: () => state.now,
	};
	return {
		rows,
		state,
		fetched,
		deps,
		start() {
			const scheduler = new AnthropicSubscriptionDiagnosis(deps);
			schedulers.push(scheduler);
			scheduler.start();
			return scheduler;
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("AnthropicSubscriptionDiagnosis", () => {
	it("registers independent recurring checks and defers its first check", () => {
		const h = harness();
		h.start();
		expect(h.state.tokenReads).toBe(0);
		expect(
			intervalManager
				.getIntervalInfo()
				.find((info) => info.id === "anthropic-subscription-diagnosis")
				?.intervalMs,
		).toBe(ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_INTERVAL_MS);
	});

	it("diagnoses a denied account during an inference cooldown", async () => {
		const h = harness([candidate({ rate_limited_until: NOW + 3_600_000 })]);
		const scheduler = h.start();
		await scheduler.tick();
		expect(h.fetched).toEqual(["fresh"]);
		expect(h.rows[0].pause_reason).toBe("subscription_expired");
		expect(h.rows[0].paused).toBe(true);
	});

	it("confirms expiration five minutes after a failed profile while usage remains backed off for an hour", async () => {
		const accountId = "independent-diagnosis-usage-backoff";
		const h = harness([candidate({ id: accountId })]);
		let profileAvailable = false;
		let profileReads = 0;
		h.deps.fetchProfile = async () => {
			profileReads++;
			return profileAvailable ? EXPIRED : null;
		};
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(
				async () =>
					new Response("rate limited", {
						status: 429,
						headers: { "retry-after": "3600" },
					}),
			),
		);
		try {
			usageCache.startPolling(
				accountId,
				"fresh",
				"anthropic",
				90_000,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					initialDelayMs: 3_600_000,
					onAnthropicUsageObservation: (observation) =>
						observeAnthropicUsage(observation, {
							...h.deps,
							recordUsageAccess: async () => {
								throw new Error("429 must not change usage access");
							},
						}),
				},
			);
			expect(await usageCache.refreshNow(accountId)).toBe(false);
			await usageCache.waitForAnthropicUsageObservation(accountId);
			expect(profileReads).toBe(1);
			expect(h.rows[0].pause_reason).toBe("usage_permission_denied");
			expect(usageCache.getRateLimitedUntil(accountId)).toBeGreaterThan(
				Date.now() + 3_500_000,
			);
			const scheduler = h.start();
			await scheduler.tick();
			expect(h.state.tokenReads).toBe(0);
			h.state.now += 300_000;
			profileAvailable = true;
			await scheduler.tick();
			expect(profileReads).toBe(2);
			expect(h.rows[0].pause_reason).toBe("subscription_expired");
			expect(h.rows[0].paused).toBe(true);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(usageCache.getRateLimitedUntil(accountId)).toBeGreaterThan(
				Date.now() + 3_500_000,
			);
		} finally {
			usageCache.stopPolling(accountId);
			fetchSpy.mockRestore();
		}
	});

	it("skips accounts without a pending OAuth access diagnosis", async () => {
		const h = harness([
			candidate({ id: "active", paused: false }),
			candidate({ id: "manual", pause_reason: "manual" }),
			candidate({ id: "confirmed", pause_reason: "subscription_expired" }),
			candidate({ id: "key", refresh_token: undefined }),
			candidate({ id: "codex", provider: "codex" }),
		]);
		await h.start().tick();
		expect(h.state.tokenReads).toBe(0);
		expect(h.fetched).toHaveLength(0);
	});

	it("retries failed profiles after five minutes without refreshing tokens between attempts", async () => {
		const h = harness();
		h.deps.fetchProfile = async () => null;
		const scheduler = h.start();
		await scheduler.tick();
		h.state.now += 299_999;
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(1);
		h.state.now++;
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(2);
		expect(h.state.claims).toBe(2);
	});

	it("does not refresh tokens or consume claims during profile backoff", async () => {
		const h = harness();
		h.state.canFetch = false;
		const getAccounts = h.deps.getAccounts;
		const accountReads = spyOn(h.deps, "getAccounts");
		const scheduler = h.start();
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(0);
		expect(h.state.claims).toBe(0);
		expect(accountReads).not.toHaveBeenCalled();
		accountReads.mockRestore();
		h.deps.getAccounts = getAccounts;
		h.state.canFetch = true;
		await scheduler.tick();
		expect(h.fetched).toHaveLength(1);
	});

	it("uses the normal six-hour cadence after confirming an active subscription", async () => {
		const h = harness();
		h.deps.fetchProfile = async () => ({
			...EXPIRED,
			subscriptionStatus: "active",
			anthropicSubscriptionExpired: false,
		});
		const scheduler = h.start();
		await scheduler.tick();
		h.state.now += 300_000;
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(1);
		h.state.now = NOW + 6 * 60 * 60_000;
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(2);
		expect(h.rows[0].pause_reason).toBe("usage_permission_denied");
	});

	it("keeps the five-minute cadence when a fetched profile is inconclusive", async () => {
		const h = harness();
		h.deps.fetchProfile = async () => ({
			...EXPIRED,
			subscriptionStatus: null,
			anthropicSubscriptionExpired: false,
		});
		const scheduler = h.start();
		await scheduler.tick();
		h.state.now += 300_000;
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(2);
	});

	it("paces token failures at five minutes without stamping a profile claim", async () => {
		const h = harness();
		h.deps.getAccessToken = async () => {
			h.state.tokenReads++;
			throw new Error("token unavailable");
		};
		const scheduler = h.start();
		await scheduler.tick();
		h.state.now += 299_999;
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(1);
		h.state.now++;
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(2);
		expect(h.state.claims).toBe(0);
	});

	it("does not carry failed-token cooldown across credential replacement", async () => {
		const h = harness();
		let failed = true;
		h.deps.getAccessToken = async (account) => {
			h.state.tokenReads++;
			if (failed) throw new Error("token unavailable");
			return account.access_token ?? "";
		};
		const scheduler = h.start();
		await scheduler.tick();
		failed = false;
		h.rows[0].refresh_token = "reauthenticated-refresh";
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(2);
		expect(h.rows[0].pause_reason).toBe("subscription_expired");
	});

	it("clears failed-token cooldown when an account leaves diagnosis or the scheduler stops", async () => {
		const h = harness();
		h.deps.getAccessToken = async () => {
			h.state.tokenReads++;
			throw new Error("token unavailable");
		};
		const scheduler = h.start();
		await scheduler.tick();
		h.rows[0].pause_reason = "manual";
		await scheduler.tick();
		h.rows[0].pause_reason = "usage_permission_denied";
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(2);
		scheduler.stop();
		scheduler.start();
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(3);
	});

	it("rechecks current eligibility before refreshing credentials", async () => {
		const h = harness();
		h.deps.getAccounts = async () => {
			const snapshot = h.rows.map((row) => ({ ...row }));
			h.rows[0].pause_reason = "manual";
			return snapshot;
		};
		await h.start().tick();
		expect(h.state.tokenReads).toBe(0);
	});

	it("discards a profile if the account is manually paused during the read", async () => {
		const h = harness();
		h.deps.fetchProfile = async () => {
			h.rows[0].pause_reason = "manual";
			return EXPIRED;
		};
		await h.start().tick();
		expect(h.state.writes).toBe(0);
		expect(h.rows[0].pause_reason).toBe("manual");
	});

	it("uses the fresh token and rejects a profile after reauthentication", async () => {
		const h = harness();
		h.deps.getAccessToken = async () => {
			h.rows[0].access_token = "rotated";
			return "rotated";
		};
		h.deps.fetchProfile = async (token) => {
			h.fetched.push(token);
			h.rows[0].access_token = "reauthenticated";
			return EXPIRED;
		};
		await h.start().tick();
		expect(h.fetched).toEqual(["rotated"]);
		expect(h.state.writes).toBe(0);
	});

	it("processes accounts sequentially and skips overlapping ticks", async () => {
		const h = harness([candidate(), candidate({ id: "second" })]);
		const gate = deferred<AccountIdentity | null>();
		const entered = deferred<void>();
		h.deps.fetchProfile = async () => {
			h.fetched.push("fetch");
			entered.resolve();
			return gate.promise;
		};
		const scheduler = h.start();
		const tick = scheduler.tick();
		await entered.promise;
		await scheduler.tick();
		expect(h.state.tokenReads).toBe(1);
		gate.resolve(EXPIRED);
		await tick;
		expect(h.state.tokenReads).toBe(2);
	});

	it("invalidates inflight writes on stop, including after restart", async () => {
		const h = harness();
		const gate = deferred<AccountIdentity | null>();
		const entered = deferred<void>();
		h.deps.fetchProfile = async () => {
			entered.resolve();
			return gate.promise;
		};
		const scheduler = h.start();
		const tick = scheduler.tick();
		await entered.promise;
		scheduler.stop();
		scheduler.start();
		gate.resolve(EXPIRED);
		await tick;
		expect(h.state.writes).toBe(0);
		scheduler.stop();
		await scheduler.tick();
		expect(intervalManager.has("anthropic-subscription-diagnosis")).toBe(false);
	});

	it("continues with other accounts after a token error", async () => {
		const h = harness([candidate(), candidate({ id: "second" })]);
		h.deps.getAccessToken = async (account) => {
			if (account.id === "expired") throw new Error("token unavailable");
			return "fresh";
		};
		await h.start().tick();
		expect(h.rows[1].pause_reason).toBe("subscription_expired");
	});
});
