import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	type CapacityRestoredEvidence,
	shouldReportCapacityRestored,
	usageCache,
} from "../usage-fetcher";

/**
 * The poller REPORTS capacity evidence; it no longer decides whether a cooldown
 * may be cleared (the listener knows the cooldown's reason and age, the poller
 * does not). The report is LEVEL-triggered: emitted on every successful poll
 * that sees account-wide headroom, so nothing is lost when the crossing itself
 * was never observed (an account locked while its weekly sat at 40% never
 * produces a 100 → <100 transition) or when a clear is refused.
 */
describe("shouldReportCapacityRestored", () => {
	it("reports genuine account-wide headroom", () => {
		expect(shouldReportCapacityRestored(40)).toBe(true);
		expect(shouldReportCapacityRestored(0)).toBe(true);
		expect(shouldReportCapacityRestored(99)).toBe(true);
		expect(shouldReportCapacityRestored(99.9)).toBe(true);
	});

	it("does NOT report a spent window", () => {
		expect(shouldReportCapacityRestored(100)).toBe(false);
		expect(shouldReportCapacityRestored(140)).toBe(false);
	});

	it("does NOT report null — no evidence is not evidence of headroom", () => {
		// A limits[]-only payload once collapsed to 0 here, read as "plenty of
		// headroom", and falsely cleared a cooldown.
		expect(shouldReportCapacityRestored(null)).toBe(false);
	});
});

function usageResponse(body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function healthyBody() {
	return {
		five_hour: { utilization: 10, resets_at: future() },
		seven_day: { utilization: 42, resets_at: future() },
	};
}

async function settle(ms = 20) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("usageCache capacity-restored reporting (level-triggered)", () => {
	const ACCOUNT = "test-capacity-restored-account";
	let fetchSpy: ReturnType<typeof spyOn> | null = null;

	afterEach(() => {
		usageCache.stopPolling(ACCOUNT);
		usageCache.delete(ACCOUNT);
		fetchSpy?.mockRestore();
		fetchSpy = null;
	});

	function startPolling(
		onCapacityRestored: (e: CapacityRestoredEvidence) => void,
	) {
		usageCache.startPolling(
			ACCOUNT,
			"token",
			"anthropic",
			60 * 60 * 1000, // keep the next scheduled poll far away
			undefined,
			undefined,
			onCapacityRestored,
		);
	}

	it("reports on EVERY healthy poll, without any prior usage-endpoint 429", async () => {
		// The old gate only fired when the USAGE endpoint itself had 429'd, which
		// is why the path was dead for two months.
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
			usageResponse(healthyBody()),
		);
		const calls: CapacityRestoredEvidence[] = [];
		startPolling((e) => calls.push(e));
		await settle();

		expect(calls).toHaveLength(1);
		expect(calls[0].accountId).toBe(ACCOUNT);
		expect(calls[0].utilization).toBe(42);
		expect(calls[0].extraUsageUtilization).toBeNull();
		expect(calls[0].observedWindows.map((w) => w.utilization)).toEqual([
			10, 42,
		]);
		expect(calls[0].observedWindows.every((w) => w.resetMs > Date.now())).toBe(
			true,
		);

		// Steady-state healthy polls keep reporting — this is what heals a refused
		// or missed clear.
		await usageCache.refreshNow(ACCOUNT);
		await usageCache.refreshNow(ACCOUNT);
		expect(calls).toHaveLength(3);
	});

	it("carries EVERY reported window reset, scoped and elapsed included", async () => {
		// The listener tells a stale recorded reset from a correct one by whether
		// it matches ANY window the provider reports — a spent per-family weekly
		// (not part of the account-wide representative) must be in the list, or
		// its correct future reset would read as stale and get stamped away.
		const fiveHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const weekly = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
		const fable = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
		const elapsed = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
			usageResponse({
				five_hour: { utilization: 10, resets_at: fiveHour },
				seven_day: { utilization: 78, resets_at: weekly },
				limits: [
					{
						kind: "weekly_scoped",
						group: "weekly",
						percent: 100,
						resets_at: fable,
						scope: { model: { id: "fable", display_name: "Fable" } },
						is_active: true,
					},
					{
						kind: "weekly_scoped",
						group: "weekly",
						percent: 0,
						resets_at: elapsed,
						scope: { model: { id: "opus", display_name: "Opus" } },
						is_active: false,
					},
				],
			}),
		);
		const calls: CapacityRestoredEvidence[] = [];
		startPolling((e) => calls.push(e));
		await settle();

		expect(calls).toHaveLength(1);
		// Account-wide is 78% — a spent scoped weekly does not stop the report…
		expect(calls[0].utilization).toBe(78);
		// …but the window IS reported, spent, so the listener can see it still
		// owns its reset. The elapsed one is reported too (idle, drained).
		const byReset = new Map(
			calls[0].observedWindows.map((w) => [w.resetMs, w.utilization]),
		);
		expect(byReset).toEqual(
			new Map([
				[Date.parse(fiveHour), 10],
				[Date.parse(weekly), 78],
				[Date.parse(fable), 100],
				[Date.parse(elapsed), 0],
			]),
		);
	});

	it("reports fetchStartedAt from BEFORE the request, not after it", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			await settle(30);
			return usageResponse(healthyBody());
		});
		const calls: CapacityRestoredEvidence[] = [];
		const before = Date.now();
		startPolling((e) => calls.push(e));
		await settle(120);
		const after = Date.now();

		expect(calls).toHaveLength(1);
		expect(calls[0].fetchStartedAt).toBeGreaterThanOrEqual(before);
		// The response completed at least 30ms later; the reported boundary is the
		// START of the request, so it must be well before completion.
		expect(calls[0].fetchStartedAt).toBeLessThanOrEqual(after - 25);
	});

	it("reports (not vetoes) a spent extra_usage window — overage is the floor's business", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
			usageResponse({
				...healthyBody(),
				extra_usage: { utilization: 100, resets_at: future() },
			}),
		);
		const calls: CapacityRestoredEvidence[] = [];
		startPolling((e) => calls.push(e));
		await settle();

		expect(calls).toHaveLength(1);
		expect(calls[0].extraUsageUtilization).toBe(100);
	});

	it("does NOT report while the 5h session window is still spent (the representative covers both)", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
			usageResponse({
				five_hour: { utilization: 100, resets_at: future() },
				seven_day: { utilization: 10, resets_at: future() },
			}),
		);
		const calls: CapacityRestoredEvidence[] = [];
		startPolling((e) => calls.push(e));
		await settle();

		expect(calls).toEqual([]);
	});

	it("does NOT report when the OAuth-apps weekly window is still spent", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
			usageResponse({
				...healthyBody(),
				seven_day_oauth_apps: { utilization: 100, resets_at: future() },
			}),
		);
		const calls: CapacityRestoredEvidence[] = [];
		startPolling((e) => calls.push(e));
		await settle();

		expect(calls).toEqual([]);
	});

	it("does NOT report for a payload with no account-level evidence (null, never 0)", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
			usageResponse({
				limits: [
					{
						kind: "weekly_scoped",
						percent: 5,
						resets_at: future(),
						scope: { model: { display_name: "Claude Opus 4.8" } },
					},
				],
			}),
		);
		const calls: CapacityRestoredEvidence[] = [];
		startPolling((e) => calls.push(e));
		await settle();

		expect(calls).toEqual([]);
	});

	it("a superseded in-flight fetch neither caches nor invokes the callback", async () => {
		let release: (() => void) | null = null;
		let served = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			served++;
			if (served === 1) {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return usageResponse(healthyBody());
		});

		const genOneCalls: CapacityRestoredEvidence[] = [];
		startPolling((e) => genOneCalls.push(e));
		await settle(10); // generation 1's fetch is parked in flight

		// Replacement (reauth): a NEW generation supersedes the in-flight fetch.
		usageCache.stopPolling(ACCOUNT);
		const genTwoCalls: CapacityRestoredEvidence[] = [];
		startPolling((e) => genTwoCalls.push(e));
		await settle(20);

		// Generation 2 issued and applied its OWN fetch rather than reusing
		// generation 1's in-flight promise.
		expect(served).toBe(2);
		expect(genTwoCalls).toHaveLength(1);

		// Now let generation 1's stale fetch finish: it must apply nothing.
		release?.();
		await settle(20);
		expect(genOneCalls).toEqual([]);
	});

	it("a superseded generation's token-provider rejection cannot halt the live poller", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
			usageResponse(healthyBody()),
		);
		let releaseToken: (() => void) | null = null;
		const slowFailingProvider = async () => {
			await new Promise<void>((resolve) => {
				releaseToken = resolve;
			});
			throw new Error("dead refresh token");
		};
		const haltCalls: string[] = [];

		usageCache.startPolling(
			ACCOUNT,
			slowFailingProvider,
			"anthropic",
			60 * 60 * 1000,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			async (id) => {
				haltCalls.push(id);
				return true; // would stop polling
			},
		);
		await settle(10);

		// Replacement generation with a working token.
		usageCache.stopPolling(ACCOUNT);
		const calls: CapacityRestoredEvidence[] = [];
		startPolling((e) => calls.push(e));
		await settle(20);

		// Release generation 1's rejection AFTER the replacement.
		releaseToken?.();
		await settle(20);

		expect(haltCalls).toEqual([]);
		// Generation 2 is untouched and still polling healthily.
		expect(calls).toHaveLength(1);
		expect(await usageCache.refreshNow(ACCOUNT)).toBe(true);
	});
});
