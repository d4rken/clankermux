import { describe, expect, it } from "bun:test";
import type { GrokSubscriptionFetchOutcome } from "@clankermux/providers/grok-subscription";
import {
	captureGrokSubscription,
	type GrokSubscriptionCaptureOps,
} from "../grok-subscription-capture";

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const ACCOUNT = { id: "grok-1", name: "Grok-me" };
const ENDS_AT = Date.UTC(2026, 9, 22, 10, 53, 30);
const STARTED_AT = Date.UTC(2026, 8, 22, 10, 53, 34);

function recordingOps(identityWritten = true) {
	const calls: Array<[string, ...unknown[]]> = [];
	const ops: GrokSubscriptionCaptureOps = {
		async setAccountIdentityFromProfile(...args) {
			calls.push(["identity", ...args]);
			return identityWritten;
		},
		async setAccountSubscriptionState(...args) {
			calls.push(["state", ...args]);
		},
		async touchAccountSubscriptionCheck(...args) {
			calls.push(["touch", ...args]);
		},
		async syncProviderRenewalAnchor(...args) {
			calls.push(["anchor", ...args]);
			return true;
		},
	};
	return { ops, calls };
}

function capture(
	outcome: GrokSubscriptionFetchOutcome,
	ops: GrokSubscriptionCaptureOps,
) {
	return captureGrokSubscription(ops, ACCOUNT, "access-token", {
		fetchSubscription: async () => outcome,
		now: () => NOW,
	});
}

describe("captureGrokSubscription", () => {
	it("writes plan, status, period and the provider renewal anchor", async () => {
		const { ops, calls } = recordingOps();
		await capture(
			{
				status: "ok",
				subscription: {
					planTier: "SuperGrok",
					subscriptionStatus: "active",
					startedAtMs: STARTED_AT,
					endsAtMs: ENDS_AT,
					willRenew: true,
					cadence: "monthly",
				},
			},
			ops,
		);
		expect(calls).toEqual([
			[
				"identity",
				ACCOUNT.id,
				{
					externalAccountId: null,
					email: null,
					organizationName: null,
					planTier: "SuperGrok",
					rateLimitTier: null,
					subscriptionStatus: "active",
					subscriptionStartedAt: STARTED_AT,
				},
				// Compare-and-swap on the token the read used, so a rotation that
				// landed meanwhile cannot receive another credential's answer.
				"access-token",
			],
			[
				"state",
				ACCOUNT.id,
				{
					endsAtMs: ENDS_AT,
					willRenew: true,
					graceEndsAtMs: null,
					checkedAtMs: NOW,
				},
			],
			[
				"anchor",
				ACCOUNT.id,
				{ endsAtMs: ENDS_AT, cadence: "monthly", graceEndsAtMs: null },
			],
		]);
	});

	it("writes nothing else when the credentials changed during the read", async () => {
		const { ops, calls } = recordingOps(false);
		await capture(
			{
				status: "ok",
				subscription: {
					planTier: "SuperGrok",
					subscriptionStatus: "active",
					startedAtMs: STARTED_AT,
					endsAtMs: ENDS_AT,
					willRenew: true,
					cadence: "monthly",
				},
			},
			ops,
		);
		expect(calls.map(([kind]) => kind)).toEqual(["identity"]);
	});

	it("records an account without a subscription and clears its period", async () => {
		const { ops, calls } = recordingOps();
		await capture({ status: "none", planTier: "Free" }, ops);
		expect(calls).toEqual([
			[
				"identity",
				ACCOUNT.id,
				expect.objectContaining({
					planTier: "Free",
					subscriptionStatus: "none",
				}),
				"access-token",
			],
			[
				"state",
				ACCOUNT.id,
				{
					endsAtMs: null,
					willRenew: null,
					graceEndsAtMs: null,
					checkedAtMs: NOW,
				},
			],
		]);
	});

	it("only advances the throttle when the read failed", async () => {
		const { ops, calls } = recordingOps();
		await capture({ status: "failed" }, ops);
		expect(calls).toEqual([["touch", ACCOUNT.id, NOW]]);
	});

	it("never throws when a write fails", async () => {
		const { ops } = recordingOps();
		ops.setAccountSubscriptionState = async () => {
			throw new Error("database is locked");
		};
		await expect(
			capture(
				{
					status: "ok",
					subscription: {
						planTier: null,
						subscriptionStatus: "active",
						startedAtMs: null,
						endsAtMs: ENDS_AT,
						willRenew: null,
						cadence: null,
					},
				},
				ops,
			),
		).resolves.toBeUndefined();
	});
});
