import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { classifyUsageFetchFailure, usageCache } from "../usage-fetcher";

const EXPIRED_BODY = JSON.stringify({
	type: "error",
	error: {
		type: "permission_error",
		message:
			"OAuth authentication is currently not allowed for this organization.",
	},
});

describe("classifyUsageFetchFailure", () => {
	it("classifies a 403 permission_error as subscription_expired", () => {
		expect(classifyUsageFetchFailure(403, EXPIRED_BODY)).toBe(
			"subscription_expired",
		);
	});

	it("ignores 403s with other error types", () => {
		const body = JSON.stringify({ error: { type: "forbidden" } });
		expect(classifyUsageFetchFailure(403, body)).toBeNull();
	});

	it("ignores permission_error on non-403 statuses", () => {
		expect(classifyUsageFetchFailure(401, EXPIRED_BODY)).toBeNull();
		expect(classifyUsageFetchFailure(429, EXPIRED_BODY)).toBeNull();
	});

	it("tolerates missing or malformed bodies", () => {
		expect(classifyUsageFetchFailure(403, null)).toBeNull();
		expect(classifyUsageFetchFailure(403, "")).toBeNull();
		expect(classifyUsageFetchFailure(403, "<html>nope</html>")).toBeNull();
	});
});

function expiredResponse(): Response {
	return new Response(EXPIRED_BODY, {
		status: 403,
		statusText: "Forbidden",
		headers: { "content-type": "application/json" },
	});
}

function successResponse(): Response {
	const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	return new Response(
		JSON.stringify({
			five_hour: { utilization: 10, resets_at: future },
			seven_day: { utilization: 50, resets_at: future },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

async function settle() {
	// Let the fire-and-forget immediate fetch inside startPolling complete.
	await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("usageCache subscription-expired transitions", () => {
	const ACCOUNT = "test-subscription-expired-account";
	let fetchSpy: ReturnType<typeof spyOn> | null = null;

	afterEach(() => {
		usageCache.stopPolling(ACCOUNT);
		fetchSpy?.mockRestore();
		fetchSpy = null;
	});

	it("fires onSubscriptionExpired once per transition and onUsageRecovered on recovery", async () => {
		let mode: "expired" | "ok" = "expired";
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
			mode === "expired" ? expiredResponse() : successResponse(),
		);

		const expiredCalls: string[] = [];
		const recoveredCalls: string[] = [];
		usageCache.startPolling(
			ACCOUNT,
			"token",
			"anthropic",
			60 * 60 * 1000, // keep the next scheduled poll far away
			undefined,
			undefined,
			undefined,
			(id) => expiredCalls.push(id),
			(id) => recoveredCalls.push(id),
		);
		await settle();

		expect(expiredCalls).toEqual([ACCOUNT]);
		expect(recoveredCalls).toEqual([]);

		// A second failing fetch must NOT re-fire the callback.
		await usageCache.refreshNow(ACCOUNT);
		expect(expiredCalls).toEqual([ACCOUNT]);

		// Renewal: the next successful fetch fires onUsageRecovered.
		mode = "ok";
		await usageCache.refreshNow(ACCOUNT);
		expect(recoveredCalls).toEqual([ACCOUNT]);

		// Steady-state successes stay quiet.
		await usageCache.refreshNow(ACCOUNT);
		expect(recoveredCalls).toEqual([ACCOUNT]);
	});

	it("fires onUsageRecovered on the first success of the process (restart case)", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
			successResponse(),
		);

		const recoveredCalls: string[] = [];
		usageCache.startPolling(
			ACCOUNT,
			"token",
			"anthropic",
			60 * 60 * 1000,
			undefined,
			undefined,
			undefined,
			undefined,
			(id) => recoveredCalls.push(id),
		);
		await settle();

		// First success after process start fires so a subscription_expired
		// pause persisted before a restart can be lifted (the callback checks
		// the pause reason in the DB and no-ops otherwise).
		expect(recoveredCalls).toEqual([ACCOUNT]);

		await usageCache.refreshNow(ACCOUNT);
		expect(recoveredCalls).toEqual([ACCOUNT]);
	});
});
