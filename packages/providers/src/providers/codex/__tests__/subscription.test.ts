import { describe, expect, it } from "bun:test";
import {
	CODEX_SUBSCRIPTION_ENDPOINT,
	fetchCodexSubscription,
	parseCodexSubscription,
	renewalCadenceFromBillingPeriod,
} from "../subscription";

/** 2026-04-10T10:00:00Z and 2026-10-03T10:00:00Z, in whole seconds. */
const ACTIVE_START_SECONDS = 1_775_815_200;
const ACTIVE_UNTIL_SECONDS = 1_791_367_200;

function healthyBody() {
	return {
		plan_type: "plus",
		active_start: ACTIVE_START_SECONDS,
		active_until: ACTIVE_UNTIL_SECONDS,
		billing_period: "monthly",
		will_renew: true,
		is_delinquent: false,
		became_delinquent_timestamp: null,
		grace_period_end_timestamp: null,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const stubFetch = (response: Response): typeof fetch =>
	(async () => response) as unknown as typeof fetch;

describe("parseCodexSubscription", () => {
	it("reads the whole period on the happy path", () => {
		const subscription = parseCodexSubscription(healthyBody(), 200);

		expect(subscription.ok).toBe(true);
		expect(subscription.unsupported).toBe(false);
		expect(subscription.planType).toBe("plus");
		expect(subscription.activeStartMs).toBe(ACTIVE_START_SECONDS * 1000);
		expect(subscription.activeUntilMs).toBe(ACTIVE_UNTIL_SECONDS * 1000);
		expect(subscription.billingPeriod).toBe("monthly");
		expect(subscription.willRenew).toBe(true);
		expect(subscription.isDelinquent).toBe(false);
		expect(subscription.graceEndsAtMs).toBeNull();
	});

	it("accepts the delinquency timestamps quoted as strings", () => {
		// Observed on a delinquent account — exactly the case where these two
		// fields carry information, so a strict integer parse would blank the
		// result precisely when it matters.
		const subscription = parseCodexSubscription(
			{
				...healthyBody(),
				is_delinquent: true,
				became_delinquent_timestamp: String(ACTIVE_START_SECONDS),
				grace_period_end_timestamp: String(ACTIVE_UNTIL_SECONDS),
			},
			200,
		);

		expect(subscription.isDelinquent).toBe(true);
		expect(subscription.becameDelinquentAtMs).toBe(ACTIVE_START_SECONDS * 1000);
		expect(subscription.graceEndsAtMs).toBe(ACTIVE_UNTIL_SECONDS * 1000);
	});

	it("reports an unreported renewal intent as null, not false", () => {
		const { will_renew, ...withoutRenew } = healthyBody();
		expect(parseCodexSubscription(withoutRenew, 200).willRenew).toBeNull();
		expect(
			parseCodexSubscription({ ...healthyBody(), will_renew: "yes" }, 200)
				.willRenew,
		).toBeNull();
	});

	it("fails on a body carrying neither plan_type nor active_until", () => {
		// What the endpoint answers — with HTTP 200 — when account_id is missing.
		const subscription = parseCodexSubscription(
			{ detail: "Missing account_id" },
			200,
		);

		expect(subscription.ok).toBe(false);
		expect(subscription.status).toBe(200);
		expect(subscription.planType).toBeNull();
	});

	it("accepts a body with only one of the two anchors", () => {
		expect(parseCodexSubscription({ plan_type: "team" }, 200).ok).toBe(true);
		expect(
			parseCodexSubscription({ active_until: ACTIVE_UNTIL_SECONDS }, 200).ok,
		).toBe(true);
	});

	it("treats zero and unparseable timestamps as absent", () => {
		const subscription = parseCodexSubscription(
			{
				plan_type: "plus",
				active_start: 0,
				active_until: "not-a-number",
				grace_period_end_timestamp: -5,
			},
			200,
		);

		expect(subscription.ok).toBe(true);
		expect(subscription.activeStartMs).toBeNull();
		expect(subscription.activeUntilMs).toBeNull();
		expect(subscription.graceEndsAtMs).toBeNull();
	});

	it("fails on a non-object body", () => {
		expect(parseCodexSubscription(null, 200).ok).toBe(false);
		expect(parseCodexSubscription("plus", 200).ok).toBe(false);
		expect(parseCodexSubscription([healthyBody()], 200).ok).toBe(false);
	});

	it("D1: parses an RFC3339 active_until as that instant", () => {
		const subscription = parseCodexSubscription(
			{ plan_type: "plus", active_until: "2026-09-04T10:22:17Z" },
			200,
		);

		expect(subscription.ok).toBe(true);
		expect(subscription.activeUntilMs).toBe(Date.parse("2026-09-04T10:22:17Z"));
	});
});

describe("renewalCadenceFromBillingPeriod", () => {
	it("maps the reported periods", () => {
		expect(renewalCadenceFromBillingPeriod("monthly")).toBe("monthly");
		expect(renewalCadenceFromBillingPeriod("Month")).toBe("monthly");
		expect(renewalCadenceFromBillingPeriod("annual")).toBe("yearly");
		expect(renewalCadenceFromBillingPeriod(" Yearly ")).toBe("yearly");
	});

	it("reports an unrecognised or absent period as unstated", () => {
		expect(renewalCadenceFromBillingPeriod("fortnightly")).toBeNull();
		expect(renewalCadenceFromBillingPeriod(null)).toBeNull();
		expect(renewalCadenceFromBillingPeriod("")).toBeNull();
	});
});

describe("fetchCodexSubscription", () => {
	it("sends the account id as a query parameter and the CLI identity", async () => {
		let seenUrl = "";
		let seenHeaders = new Headers();
		const fetchImpl = (async (input: string, init: RequestInit) => {
			seenUrl = String(input);
			seenHeaders = new Headers(init.headers);
			return jsonResponse(healthyBody());
		}) as unknown as typeof fetch;

		const subscription = await fetchCodexSubscription({
			accessToken: "token",
			chatgptAccountId: "acct-uuid",
			fetchImpl,
		});

		expect(seenUrl).toBe(`${CODEX_SUBSCRIPTION_ENDPOINT}?account_id=acct-uuid`);
		expect(seenHeaders.get("ChatGPT-Account-Id")).toBe("acct-uuid");
		expect(seenHeaders.get("originator")).toBeNull();
		expect(seenHeaders.get("User-Agent")).toStartWith("codex_exec/");
		expect(subscription.ok).toBe(true);
	});

	it("never issues the request without an account id", async () => {
		let called = false;
		const fetchImpl = (async () => {
			called = true;
			return jsonResponse(healthyBody());
		}) as unknown as typeof fetch;

		const subscription = await fetchCodexSubscription({
			accessToken: "token",
			chatgptAccountId: "  ",
			fetchImpl,
		});

		// Without the id the endpoint answers 200 with a detail body — a negative
		// answer wearing a success status.
		expect(called).toBe(false);
		expect(subscription.ok).toBe(false);
		expect(subscription.status).toBeNull();
	});

	it("reports a 404 as unsupported rather than as an error", async () => {
		const subscription = await fetchCodexSubscription({
			accessToken: "token",
			chatgptAccountId: "acct-uuid",
			fetchImpl: stubFetch(jsonResponse({ detail: "Not found" }, 404)),
		});

		expect(subscription.ok).toBe(false);
		expect(subscription.unsupported).toBe(true);
		expect(subscription.status).toBe(404);
	});

	it("fails clean on a rejected status", async () => {
		const subscription = await fetchCodexSubscription({
			accessToken: "token",
			chatgptAccountId: "acct-uuid",
			fetchImpl: stubFetch(jsonResponse({ detail: "nope" }, 403)),
		});

		expect(subscription.ok).toBe(false);
		expect(subscription.unsupported).toBe(false);
		expect(subscription.status).toBe(403);
	});

	it("fails clean on a non-JSON body", async () => {
		const subscription = await fetchCodexSubscription({
			accessToken: "token",
			chatgptAccountId: "acct-uuid",
			fetchImpl: stubFetch(new Response("<html/>", { status: 200 })),
		});

		expect(subscription.ok).toBe(false);
		expect(subscription.status).toBe(200);
	});

	it("fails clean on a network throw instead of propagating it", async () => {
		const fetchImpl = (async () => {
			throw new Error("connection reset");
		}) as unknown as typeof fetch;

		const subscription = await fetchCodexSubscription({
			accessToken: "token",
			chatgptAccountId: "acct-uuid",
			fetchImpl,
		});

		expect(subscription.ok).toBe(false);
		expect(subscription.status).toBeNull();
	});

	it("rejects an empty access token", async () => {
		await expect(
			fetchCodexSubscription({
				accessToken: "",
				chatgptAccountId: "acct-uuid",
				fetchImpl: stubFetch(jsonResponse(healthyBody())),
			}),
		).rejects.toThrow("non-empty access token");
	});
});
