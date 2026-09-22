import { describe, expect, it } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import {
	fetchGrokSubscription,
	GROK_SUBSCRIPTIONS_ENDPOINT,
	parseGrokSubscriptions,
} from "../subscription";

/** One `subscriptions[]` entry, shaped like the live 2026-09-23 response. */
function entry(patch: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		stripe: {
			subscriptionId: "sub_test",
			currentPeriodEnd: "2026-10-22T10:53:30Z",
			cancelAtPeriodEnd: false,
			subscriptionType: "MONTHLY",
		},
		xaiUserId: "user-1",
		tier: "SUBSCRIPTION_TIER_GROK_PRO",
		status: "SUBSCRIPTION_STATUS_ACTIVE",
		createTime: "2026-09-22T10:53:34.679705Z",
		billingInterval: "BILLING_INTERVAL_MONTHLY",
		billingPeriodEnd: "2026-10-22T10:53:30Z",
		cancelAtPeriodEnd: false,
		...patch,
	};
}

function body(
	subscriptions: unknown[],
	display: string | null = "SuperGrok",
): Record<string, unknown> {
	return {
		subscriptions,
		...(display === null
			? {}
			: {
					dominantPlan: {
						plan: "supergrok",
						surfaceNames: { SURFACE_DISPLAY: display },
					},
				}),
	};
}

describe("parseGrokSubscriptions", () => {
	it("reads plan, status, period end, renewal intent and cadence", () => {
		expect(parseGrokSubscriptions(body([entry()]))).toEqual({
			status: "ok",
			subscription: {
				planTier: "SuperGrok",
				subscriptionStatus: "active",
				startedAtMs: Date.parse("2026-09-22T10:53:34.679705Z"),
				endsAtMs: Date.parse("2026-10-22T10:53:30Z"),
				willRenew: true,
				cadence: "monthly",
			},
		});
	});

	it("reports a subscription set to cancel as not renewing", () => {
		const outcome = parseGrokSubscriptions(
			body([entry({ cancelAtPeriodEnd: true })]),
		);
		expect(outcome.status === "ok" && outcome.subscription.willRenew).toBe(
			false,
		);
	});

	it("reports a subscription that has already ended as not renewing", () => {
		const outcome = parseGrokSubscriptions(
			body([entry({ status: "SUBSCRIPTION_STATUS_CANCELED" })]),
		);
		expect(outcome).toMatchObject({
			status: "ok",
			subscription: { subscriptionStatus: "canceled", willRenew: false },
		});
	});

	it("prefers the active subscription over an older ended one", () => {
		const ended = entry({
			status: "SUBSCRIPTION_STATUS_CANCELED",
			billingPeriodEnd: "2026-12-01T00:00:00Z",
		});
		const outcome = parseGrokSubscriptions(body([ended, entry()]));
		expect(outcome).toMatchObject({
			status: "ok",
			subscription: {
				subscriptionStatus: "active",
				endsAtMs: Date.parse("2026-10-22T10:53:30Z"),
			},
		});
	});

	it("falls back to the Stripe period end and renewal flag", () => {
		const outcome = parseGrokSubscriptions(
			body([
				entry({
					billingPeriodEnd: undefined,
					cancelAtPeriodEnd: undefined,
					stripe: {
						currentPeriodEnd: "2026-11-01T00:00:00Z",
						cancelAtPeriodEnd: true,
					},
				}),
			]),
		);
		expect(outcome).toMatchObject({
			status: "ok",
			subscription: {
				endsAtMs: Date.parse("2026-11-01T00:00:00Z"),
				willRenew: false,
			},
		});
	});

	it("maps a yearly interval and leaves an unknown one unstated", () => {
		const yearly = parseGrokSubscriptions(
			body([entry({ billingInterval: "BILLING_INTERVAL_YEARLY" })]),
		);
		expect(yearly.status === "ok" && yearly.subscription.cadence).toBe(
			"yearly",
		);
		const unknown = parseGrokSubscriptions(
			body([entry({ billingInterval: "BILLING_INTERVAL_WEEKLY" })]),
		);
		expect(unknown.status === "ok" && unknown.subscription.cadence).toBeNull();
	});

	it("keeps an absent renewal flag unknown on an active subscription", () => {
		const outcome = parseGrokSubscriptions(
			body([
				entry({
					cancelAtPeriodEnd: undefined,
					stripe: { subscriptionId: "x" },
				}),
			]),
		);
		expect(
			outcome.status === "ok" && outcome.subscription.willRenew,
		).toBeNull();
	});

	it("answers `none` with the plan when the account has no subscription", () => {
		expect(parseGrokSubscriptions(body([], "Free"))).toEqual({
			status: "none",
			planTier: "Free",
		});
	});

	it.each([
		["a non-object body", 42],
		["a null body", null],
		["no subscriptions array", { dominantPlan: {} }],
		["a subscriptions field that is not an array", { subscriptions: {} }],
		["only entries that are not objects", { subscriptions: ["x", 1] }],
	])("fails on %s", (_label, value) => {
		expect(parseGrokSubscriptions(value)).toEqual({ status: "failed" });
	});
});

describe("fetchGrokSubscription", () => {
	it("dials grok.com with the bearer and parses the answer", async () => {
		const calls: Array<{ url: string; auth: string | null }> = [];
		const fetchImpl = mockFetch(async (input, init) => {
			calls.push({
				url: String(input),
				auth: new Headers(init?.headers).get("authorization"),
			});
			return Response.json(body([entry()]));
		});
		const outcome = await fetchGrokSubscription("tok", { fetchImpl });
		expect(calls).toEqual([
			{ url: GROK_SUBSCRIPTIONS_ENDPOINT, auth: "Bearer tok" },
		]);
		expect(outcome.status).toBe("ok");
	});

	it("fails on a non-2xx response", async () => {
		const fetchImpl = mockFetch(
			async () => new Response("denied", { status: 401 }),
		);
		expect(await fetchGrokSubscription("tok", { fetchImpl })).toEqual({
			status: "failed",
		});
	});

	it("fails on a body that is not JSON", async () => {
		const fetchImpl = mockFetch(async () => new Response("<html>"));
		expect(await fetchGrokSubscription("tok", { fetchImpl })).toEqual({
			status: "failed",
		});
	});

	it("degrades a transport error to a failure rather than throwing", async () => {
		const fetchImpl = mockFetch(async () => {
			throw new Error("socket hang up");
		});
		expect(await fetchGrokSubscription("tok", { fetchImpl })).toEqual({
			status: "failed",
		});
	});

	it("fails without dialling anything when the token is blank", async () => {
		let dialled = false;
		const fetchImpl = mockFetch(async () => {
			dialled = true;
			return Response.json(body([entry()]));
		});
		expect(await fetchGrokSubscription("  ", { fetchImpl })).toEqual({
			status: "failed",
		});
		expect(dialled).toBe(false);
	});
});
