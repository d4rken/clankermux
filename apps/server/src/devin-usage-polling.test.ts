import { describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import { startDevinUsagePolling } from "./devin-usage-polling";

/**
 * The subscription writes every db literal below has to supply. They are
 * exercised on their own in "Devin polled subscription period"; elsewhere they
 * are noise.
 */
const subscriptionWrites = {
	setAccountSubscriptionState: async () => {},
	syncProviderRenewalAnchor: async () => false,
};

describe("Devin usage polling setup", () => {
	it("uses current persisted credentials each poll, including for paused accounts", async () => {
		const account = {
			id: "devin",
			provider: "devin",
			api_key: "old",
			custom_endpoint: null,
			paused: true,
		} as Account;
		let current: Account | null = { ...account, api_key: "new" };
		const startPolling = mock((..._args: unknown[]) => {});
		expect(
			startDevinUsagePolling(
				account,
				{
					getAccount: async () => current,
					setAccountIdentityFromProfile: async () => {},
					...subscriptionWrites,
				},
				90_000,
				{ startPolling },
			),
		).toBe(true);
		const tokenProvider = startPolling.mock
			.calls[0]?.[1] as unknown as () => Promise<string>;
		expect(await tokenProvider()).toBe("new");
		current = { ...account, api_key: "newer" };
		expect(await tokenProvider()).toBe("newer");
		current = null;
		await expect(tokenProvider()).rejects.toThrow("unavailable");
	});
	it("rejects an old poller's endpoint after an account changes", async () => {
		const account = {
			id: "devin",
			provider: "devin",
			api_key: "old",
			custom_endpoint: "https://first.example",
		} as Account;
		const startPolling = mock((..._args: unknown[]) => {});
		startDevinUsagePolling(
			account,
			{
				setAccountIdentityFromProfile: async () => {},
				...subscriptionWrites,
				getAccount: async () => ({
					...account,
					api_key: "new",
					custom_endpoint: "https://second.example",
				}),
			},
			90_000,
			{ startPolling },
		);
		const tokenProvider = startPolling.mock
			.calls[0]?.[1] as unknown as () => Promise<string>;
		await expect(tokenProvider()).rejects.toThrow("endpoint changed");
	});
	it("does not start without a session token", () => {
		const startPolling = mock((..._args: unknown[]) => {});
		const account = {
			id: "devin",
			provider: "devin",
			api_key: null,
		} as Account;
		expect(
			startDevinUsagePolling(
				account,
				{
					getAccount: async () => account,
					setAccountIdentityFromProfile: async () => {},
					...subscriptionWrites,
				},
				90_000,
				{ startPolling },
			),
		).toBe(false);
		expect(startPolling).not.toHaveBeenCalled();
	});
});

describe("Devin polled identity", () => {
	const account = {
		id: "legacy-devin",
		provider: "devin",
		api_key: "session",
		custom_endpoint: null,
	} as Account;
	const usage = {
		kind: "devin",
		email: "free@example.test",
		accountId: "external-devin",
		planName: "Free",
	} as import("@clankermux/types").DevinUsageData;
	function setup(
		current: () => Promise<Account | null>,
		persist: (
			id: string,
			identity: import("@clankermux/types").AccountIdentity,
		) => Promise<void>,
	) {
		const startPolling = mock((..._args: unknown[]) => {});
		startDevinUsagePolling(
			account,
			{
				getAccount: current,
				setAccountIdentityFromProfile: persist,
				...subscriptionWrites,
			},
			90_000,
			{ startPolling },
		);
		return (
			startPolling.mock.calls[0]?.[11] as {
				onMetadata: (
					data: import("@clankermux/types").DevinUsageData,
					token: string,
					isCurrent: () => boolean,
				) => Promise<void>;
			}
		).onMetadata;
	}
	it("persists legacy identity from metadata without an extra account RPC", async () => {
		const persist = mock(async () => {});
		await setup(async () => account, persist)(usage, "session", () => true);
		expect(persist).toHaveBeenCalledWith("legacy-devin", {
			email: "free@example.test",
			externalAccountId: "external-devin",
			planTier: "Free",
			organizationName: null,
			rateLimitTier: null,
		});
	});
	it("skips unchanged identity and never clears fields omitted by metadata", async () => {
		const persist = mock(async () => {});
		const existing = {
			...account,
			identity_profile_fetched_at: 123,
			identity_email: "free@example.test",
			identity_external_id: "external-devin",
			identity_plan_tier: "Free",
		};
		const observer = setup(async () => existing, persist);
		await observer(usage, "session", () => true);
		await observer(
			{ ...usage, email: null, accountId: null, planName: null },
			"session",
			() => true,
		);
		expect(persist).not.toHaveBeenCalled();
	});

	it("persists organization-only changes and skips repeated or absent organization evidence", async () => {
		const persist = mock(async () => {});
		const current = {
			...account,
			identity_profile_fetched_at: 123,
			identity_email: "free@example.test",
			identity_external_id: "external-devin",
			identity_plan_tier: "Free",
			identity_organization_name: "Old Team",
		};
		const observer = setup(async () => current, persist);
		await observer(
			{ ...usage, organizationName: "New Team" },
			"session",
			() => true,
		);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist).toHaveBeenCalledWith(
			account.id,
			expect.objectContaining({
				organizationName: "New Team",
				rateLimitTier: null,
			}),
		);
		current.identity_organization_name = "New Team";
		await observer(
			{ ...usage, organizationName: "New Team" },
			"session",
			() => true,
		);
		await observer(usage, "session", () => true);
		expect(persist).toHaveBeenCalledTimes(1);
	});
	it("rejects metadata from superseded credentials, endpoints, or poll generations", async () => {
		for (const changed of [
			{ ...account, api_key: "new-session" },
			{ ...account, custom_endpoint: "https://new.example" },
			null,
		]) {
			const persist = mock(async () => {});
			await setup(async () => changed, persist)(usage, "session", () => true);
			expect(persist).not.toHaveBeenCalled();
		}
		let live = true;
		const persist = mock(async () => {});
		const observer = setup(async () => {
			live = false;
			return account;
		}, persist);
		await observer(usage, "session", () => live);
		expect(persist).not.toHaveBeenCalled();
	});
	it("keeps metadata usable when durable identity persistence fails", async () => {
		const observer = setup(
			async () => account,
			async () => {
				throw new Error("database busy");
			},
		);
		await expect(
			observer(usage, "session", () => true),
		).resolves.toBeUndefined();
	});
	it("does not make Devin eligible for the Anthropic profile backfill", async () => {
		const { isAnthropicProfileBackfillCandidate } = await import(
			"./anthropic-profile-backfill"
		);
		expect(
			isAnthropicProfileBackfillCandidate({
				...account,
				access_token: "present",
				refresh_token: "present",
				identity_profile_fetched_at: null,
			}),
		).toBe(false);
	});
});

describe("Devin polled subscription period", () => {
	const account = {
		id: "devin-sub",
		provider: "devin",
		api_key: "session",
		custom_endpoint: null,
	} as Account;
	/** 2026-10-03 12:00 local. */
	const PLAN_END = new Date(2026, 9, 3, 12, 0).getTime();

	function setup(current: Account) {
		const startPolling = mock((..._args: unknown[]) => {});
		const setAccountSubscriptionState = mock(async () => {});
		const syncProviderRenewalAnchor = mock(async () => true);
		startDevinUsagePolling(
			account,
			{
				getAccount: async () => current,
				setAccountIdentityFromProfile: async () => {},
				setAccountSubscriptionState,
				syncProviderRenewalAnchor,
			},
			90_000,
			{ startPolling },
		);
		const callbacks = startPolling.mock
			.calls[0]?.[11] as import("@clankermux/providers").DevinPollingCallbacks;
		return {
			onMetadata: callbacks.onMetadata,
			setAccountSubscriptionState,
			syncProviderRenewalAnchor,
		};
	}

	const usage = (
		overrides: Partial<import("@clankermux/types").DevinUsageData> = {},
	) =>
		({
			kind: "devin",
			email: "seat@example.test",
			accountId: "external-devin",
			planName: "Team",
			planEndMs: PLAN_END,
			gracePeriodEndMs: null,
			...overrides,
		}) as import("@clankermux/types").DevinUsageData;

	it("persists the period on a poll where the identity is unchanged", async () => {
		// The rollover case: email, external id, plan tier and organization are
		// all identical, which is exactly what the identity write short-circuits
		// on. The period write has to happen before that return.
		const current = {
			...account,
			identity_profile_fetched_at: 123,
			identity_email: "seat@example.test",
			identity_external_id: "external-devin",
			identity_plan_tier: "Team",
		};
		const harness = setup(current);

		await harness.onMetadata?.(usage(), "session", () => true);

		expect(harness.setAccountSubscriptionState).toHaveBeenCalledWith(
			account.id,
			{
				endsAtMs: PLAN_END,
				willRenew: null,
				graceEndsAtMs: null,
				checkedAtMs: expect.any(Number),
			},
		);
		expect(harness.syncProviderRenewalAnchor).toHaveBeenCalledWith(account.id, {
			endsAtMs: PLAN_END,
			cadence: null,
			graceEndsAtMs: null,
		});
	});

	it("passes a running grace period through to both writes", async () => {
		const graceEnd = PLAN_END + 3 * 86_400_000;
		const harness = setup(account);

		await harness.onMetadata?.(
			usage({ gracePeriodStatus: "active", gracePeriodEndMs: graceEnd }),
			"session",
			() => true,
		);

		expect(harness.setAccountSubscriptionState).toHaveBeenCalledWith(
			account.id,
			expect.objectContaining({ graceEndsAtMs: graceEnd }),
		);
		expect(harness.syncProviderRenewalAnchor).toHaveBeenCalledWith(
			account.id,
			expect.objectContaining({ graceEndsAtMs: graceEnd }),
		);
	});

	it("still records the attempt when the account reports no plan end", async () => {
		const harness = setup(account);

		await harness.onMetadata?.(
			usage({ planEndMs: null }),
			"session",
			() => true,
		);

		expect(harness.setAccountSubscriptionState).toHaveBeenCalledWith(
			account.id,
			expect.objectContaining({ endsAtMs: null }),
		);
	});

	it("rejects a period from superseded credentials", async () => {
		const harness = setup({ ...account, api_key: "replacement" });

		await harness.onMetadata?.(usage(), "session", () => true);

		expect(harness.setAccountSubscriptionState).not.toHaveBeenCalled();
	});

	it("keeps the poll usable when the period write fails", async () => {
		const startPolling = mock((..._args: unknown[]) => {});
		startDevinUsagePolling(
			account,
			{
				getAccount: async () => account,
				setAccountIdentityFromProfile: async () => {},
				setAccountSubscriptionState: async () => {
					throw new Error("database busy");
				},
				syncProviderRenewalAnchor: async () => false,
			},
			90_000,
			{ startPolling },
		);
		const callbacks = startPolling.mock
			.calls[0]?.[11] as import("@clankermux/providers").DevinPollingCallbacks;

		await expect(
			callbacks.onMetadata?.(usage(), "session", () => true),
		).resolves.toBeUndefined();
	});
});

describe("Devin polling effects", () => {
	const account = {
		id: "effects",
		provider: "devin",
		api_key: "session",
		custom_endpoint: null,
	} as Account;
	it("replaces fabricated session expiry from the credential's finite exp claim or clears it", async () => {
		for (const payload of [{ exp: 1_900_000_000 }, {}]) {
			const token = `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
			const current = { ...account, api_key: token, expires_at: 9_999_999 };
			const startPolling = mock((..._args: unknown[]) => {});
			const updateDevinSessionExpiry = mock(async () => true);
			startDevinUsagePolling(
				current,
				{
					getAccount: async () => current,
					setAccountIdentityFromProfile: async () => {},
					...subscriptionWrites,
					updateDevinSessionExpiry,
				},
				90_000,
				{ startPolling },
			);
			const callbacks = startPolling.mock
				.calls[0]?.[11] as import("@clankermux/providers").DevinPollingCallbacks;
			await callbacks.onMetadata?.(
				{ kind: "devin" } as import("@clankermux/types").DevinUsageData,
				token,
				() => true,
			);
			expect(updateDevinSessionExpiry).toHaveBeenCalledWith(
				current.id,
				token,
				null,
				"exp" in payload ? 1_900_000_000_000 : null,
			);
		}
	});
	it("runs quota automation for unchanged or missing identity without extra metadata reads", async () => {
		const startPolling = mock((..._args: unknown[]) => {});
		const onQuotaMetadata = mock(async () => {});
		const current = {
			...account,
			identity_email: "known@example.test",
			identity_profile_fetched_at: 123,
		};
		startDevinUsagePolling(
			account,
			{
				getAccount: async () => current,
				setAccountIdentityFromProfile: async () => {},
				...subscriptionWrites,
			},
			90_000,
			{ startPolling },
			{ onQuotaMetadata },
		);
		const callbacks = startPolling.mock
			.calls[0]?.[11] as import("@clankermux/providers").DevinPollingCallbacks;
		for (const email of ["known@example.test", null])
			await callbacks.onMetadata?.(
				{ kind: "devin", email } as import("@clankermux/types").DevinUsageData,
				"session",
				() => true,
			);
		expect(onQuotaMetadata).toHaveBeenCalledTimes(2);
	});
	it("guards authentication side effects against replaced credentials or generations", async () => {
		const startPolling = mock((..._args: unknown[]) => {});
		const onAuthenticationFailure = mock(async () => {});
		let current = account;
		startDevinUsagePolling(
			account,
			{
				getAccount: async () => current,
				setAccountIdentityFromProfile: async () => {},
				...subscriptionWrites,
			},
			90_000,
			{ startPolling },
			{ onAuthenticationFailure },
		);
		const callbacks = startPolling.mock
			.calls[0]?.[11] as import("@clankermux/providers").DevinPollingCallbacks;
		await callbacks.onAuthenticationFailure?.("session", () => true);
		expect(onAuthenticationFailure).toHaveBeenCalledWith(account);
		current = { ...account, api_key: "replacement" };
		await callbacks.onAuthenticationFailure?.("session", () => true);
		current = account;
		await callbacks.onAuthenticationFailure?.("session", () => false);
		expect(onAuthenticationFailure).toHaveBeenCalledTimes(1);
	});
});
