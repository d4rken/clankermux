import { describe, expect, it } from "bun:test";
import "@clankermux/core";
import type { AnthropicUsageObservation } from "@clankermux/providers";
import { makeAccount } from "@clankermux/test-support";
import type { AccountIdentity } from "@clankermux/types";
import {
	ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_RETRY_MS,
	ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS,
	type AnthropicUsageObservationDeps,
	observeAnthropicUsage,
} from "./anthropic-subscription-refresh";

function fixture() {
	let now = 1_800_000_000_000;
	let current = true;
	const row = makeAccount({
		id: "expiry",
		access_token: "token",
		refresh_token: "refresh",
		identity_subscription_checked_at: now - 120_000,
	});
	let identity: AccountIdentity | null = {
		externalAccountId: "id",
		email: null,
		organizationName: null,
		planTier: "free",
		rateLimitTier: null,
		subscriptionStatus: "canceled",
		anthropicSubscriptionExpired: true,
	};
	const events: string[] = [];
	let waitProfile: Promise<void> = Promise.resolve();
	const deps: AnthropicUsageObservationDeps = {
		getAccount: async () => ({ ...row }),
		now: () => now,
		recordUsageAccess: async (_id, token, denied) => {
			if (token !== row.access_token) return false;
			events.push(denied ? "denied" : "success");
			if (denied && !row.paused) {
				row.paused = true;
				row.pause_reason = "usage_permission_denied";
				return true;
			}
			if (
				!denied &&
				(row.pause_reason === "usage_permission_denied" ||
					row.pause_reason === "subscription_expired")
			) {
				row.paused = false;
				row.pause_reason = null;
				return true;
			}
			return false;
		},
		claimSubscriptionCheck: async (_id, stamp, throttle) => {
			if (
				row.identity_subscription_checked_at != null &&
				stamp - row.identity_subscription_checked_at < throttle
			)
				return false;
			row.identity_subscription_checked_at = stamp;
			return true;
		},
		fetchProfile: async () => {
			events.push("profile");
			await waitProfile;
			return identity;
		},
		setIdentity: async (_id, data, token) => {
			if (row.access_token !== token) return false;
			events.push("identity");
			if (
				data.anthropicSubscriptionExpired &&
				row.pause_reason === "usage_permission_denied"
			)
				row.pause_reason = "subscription_expired";
			return true;
		},
	};
	const observation = (
		outcome: AnthropicUsageObservation["outcome"] = "permission_denied",
		firstPermissionDenial = true,
	): AnthropicUsageObservation => ({
		accountId: row.id,
		accessToken: "token",
		outcome,
		firstPermissionDenial,
		isCurrent: () => current,
	});
	return {
		row,
		events,
		deps,
		observation,
		advance: (ms: number) => {
			now += ms;
		},
		replace: () => {
			current = false;
		},
		profile: (value: AccountIdentity | null) => {
			identity = value;
		},
		blockProfile: (p: Promise<void>) => {
			waitProfile = p;
		},
	};
}

describe("Anthropic usage diagnosis", () => {
	it("pauses first, bypasses the six-hour interval, and awaits confirmed diagnosis", async () => {
		const f = fixture();
		await observeAnthropicUsage(f.observation(), f.deps);
		expect(f.events).toEqual(["denied", "profile", "identity"]);
		expect(f.row.pause_reason).toBe("subscription_expired");
	});
	it("keeps generic denial when the profile fails", async () => {
		const f = fixture();
		f.profile(null);
		await observeAnthropicUsage(f.observation(), f.deps);
		expect(f.row.pause_reason).toBe("usage_permission_denied");
	});
	it("keeps denial unconfirmed for an active profile", async () => {
		const f = fixture();
		f.profile({
			externalAccountId: "id",
			email: null,
			organizationName: null,
			planTier: "max",
			rateLimitTier: null,
			subscriptionStatus: "active",
		});
		await observeAnthropicUsage(f.observation(), f.deps);
		expect(f.row.pause_reason).toBe("usage_permission_denied");
	});
	it("throttles manual rechecks and retries unresolved diagnoses after five minutes", async () => {
		const f = fixture();
		f.profile(null);
		await observeAnthropicUsage(f.observation(), f.deps);
		f.advance(30_000);
		await observeAnthropicUsage(f.observation(), f.deps);
		f.advance(31_000);
		await observeAnthropicUsage(
			f.observation("permission_denied", false),
			f.deps,
		);
		expect(f.events.filter((e) => e === "profile")).toHaveLength(1);
		await observeAnthropicUsage(f.observation(), f.deps);
		expect(f.events.filter((e) => e === "profile")).toHaveLength(2);
		f.advance(ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_RETRY_MS);
		await observeAnthropicUsage(
			f.observation("permission_denied", false),
			f.deps,
		);
		expect(f.events.filter((e) => e === "profile")).toHaveLength(3);
		f.advance(ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS);
		await observeAnthropicUsage(
			f.observation("permission_denied", false),
			f.deps,
		);
		expect(f.events.filter((e) => e === "profile")).toHaveLength(4);
	});
	it("does not consume a profile check while the profile endpoint backoff is active", async () => {
		const f = fixture();
		const before = f.row.identity_subscription_checked_at;
		f.deps.canFetchProfile = () => false;
		await observeAnthropicUsage(f.observation(), f.deps);
		expect(f.row.identity_subscription_checked_at).toBe(before);
		expect(f.events).toEqual(["denied"]);
		f.advance(ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_RETRY_MS);
		f.deps.canFetchProfile = () => true;
		await observeAnthropicUsage(
			f.observation("permission_denied", false),
			f.deps,
		);
		expect(f.row.pause_reason).toBe("subscription_expired");
	});
	it("diagnoses an existing denial when usage is unavailable without recording recovery", async () => {
		const f = fixture();
		f.row.paused = true;
		f.row.pause_reason = "usage_permission_denied";
		f.advance(ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_RETRY_MS);
		await observeAnthropicUsage(f.observation("unavailable", false), f.deps);
		expect(f.events).toEqual(["profile", "identity"]);
		expect(f.row.paused).toBe(true);
		expect(f.row.pause_reason).toBe("subscription_expired");
	});
	it.each([
		null,
		"manual",
		"oauth_invalid_grant",
		"subscription_expired",
	])("does not diagnose or change %s pauses based on unavailable usage", async (reason) => {
		const f = fixture();
		f.row.paused = reason !== null;
		f.row.pause_reason = reason;
		f.advance(ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS);
		await observeAnthropicUsage(f.observation("unavailable", false), f.deps);
		expect(f.events).toEqual([]);
		expect(f.row.pause_reason).toBe(reason);
	});
	it("keeps the denial when the independent profile check fails or is backed off", async () => {
		const f = fixture();
		f.row.paused = true;
		f.row.pause_reason = "usage_permission_denied";
		f.advance(ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_RETRY_MS);
		f.deps.canFetchProfile = () => false;
		await observeAnthropicUsage(f.observation("unavailable", false), f.deps);
		expect(f.events).toEqual([]);
		f.deps.canFetchProfile = () => true;
		f.profile(null);
		await observeAnthropicUsage(f.observation("unavailable", false), f.deps);
		expect(f.events).toEqual(["profile"]);
		expect(f.row.pause_reason).toBe("usage_permission_denied");
	});
	it("uses the routine cadence after a successful active-subscription diagnosis", async () => {
		const f = fixture();
		f.row.paused = true;
		f.row.pause_reason = "usage_permission_denied";
		f.row.identity_subscription_status = "active";
		f.row.identity_profile_fetched_at = f.row.identity_subscription_checked_at!;
		f.advance(ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_RETRY_MS);
		await observeAnthropicUsage(f.observation("unavailable", false), f.deps);
		expect(f.events).toEqual([]);
		f.advance(ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS);
		await observeAnthropicUsage(f.observation("unavailable", false), f.deps);
		expect(f.events).toEqual(["profile", "identity"]);
	});
	it("retries after five minutes when active profile evidence predates the latest attempt", async () => {
		const f = fixture();
		f.row.paused = true;
		f.row.pause_reason = "usage_permission_denied";
		f.row.identity_subscription_status = "active";
		f.row.identity_profile_fetched_at =
			f.row.identity_subscription_checked_at! - 1;
		f.advance(ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_RETRY_MS);
		await observeAnthropicUsage(f.observation("unavailable", false), f.deps);
		expect(f.events).toEqual(["profile", "identity"]);
	});
	it("recovers automatic expiry pauses on successful usage without needing profile evidence", async () => {
		const f = fixture();
		f.row.paused = true;
		f.row.pause_reason = "subscription_expired";
		await observeAnthropicUsage(f.observation("success", false), f.deps);
		expect(f.row.paused).toBe(false);
		expect(f.events).toEqual(["success", "profile", "identity"]);
	});
	it("preserves manual pauses on denial and recovery", async () => {
		const f = fixture();
		f.row.paused = true;
		f.row.pause_reason = "manual";
		await observeAnthropicUsage(f.observation(), f.deps);
		await observeAnthropicUsage(f.observation("success", false), f.deps);
		expect(f.row.pause_reason).toBe("manual");
	});
	it("does not pause healthy usage based only on expired profile metadata", async () => {
		const f = fixture();
		f.advance(ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS);
		await observeAnthropicUsage(f.observation("success", false), f.deps);
		expect(f.events).toEqual(["success", "profile", "identity"]);
		expect(f.row.paused).toBe(false);
	});
	it("discards a profile after replacement and awaits its settlement", async () => {
		const f = fixture();
		let release!: () => void;
		f.blockProfile(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		let settled = false;
		const pending = observeAnthropicUsage(f.observation(), f.deps).then(() => {
			settled = true;
		});
		for (let i = 0; i < 10 && !f.events.includes("profile"); i++)
			await Promise.resolve();
		expect(settled).toBe(false);
		f.replace();
		release();
		await pending;
		expect(f.events).toEqual(["denied", "profile"]);
	});
	it("does not start stale observation effects", async () => {
		const f = fixture();
		f.replace();
		await observeAnthropicUsage(f.observation(), f.deps);
		expect(f.events).toEqual([]);
	});
});
