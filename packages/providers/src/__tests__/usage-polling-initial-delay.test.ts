/**
 * Startup stagger vs on-demand refresh — the poller-registration window.
 *
 * The server staggers Anthropic usage polling by 5s per account at startup so
 * the pollers don't 429 the shared /oauth/usage bucket in one burst. That
 * stagger used to defer the whole `startPolling` call — including installing
 * the account's token provider — which made `refreshNow` a silent no-op for
 * the first `index * 5s` after every restart. A 429 arriving in that window
 * found the usage cache empty AND unrefreshable, so every evidence rung of the
 * 429 ladder failed open and a family-scoped 429 got an account-wide cooldown
 * (Claude-Backup-2, 2026-08-02: locked 14.4h by a fable-weekly 429 four
 * seconds after a deploy restart).
 *
 * The contract under test: `PollingPolicy.initialDelayMs` defers only the
 * FIRST FETCH; registration is synchronous, so `refreshNow` works from t=0.
 *
 * Idioms follow usage-poll-generation-isolation.test.ts: the real usageCache
 * singleton, a stubbed global fetch (no Anthropic endpoint is ever contacted),
 * real short timers, per-test unique account ids.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { usageCache } from "../usage-fetcher";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// One hour: the armed poll loop must never actually tick inside a test.
const HOUR = 60 * 60 * 1000;

function healthyResponse(): Response {
	const future = new Date(Date.now() + HOUR).toISOString();
	return new Response(
		JSON.stringify({
			five_hour: { utilization: 10, resets_at: future },
			seven_day: { utilization: 20, resets_at: future },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** Whitebox view of the private scheduling bookkeeping. */
function hasArmedTimer(accountId: string): boolean {
	return (
		usageCache as unknown as { pollTimeouts: Map<string, unknown> }
	).pollTimeouts.has(accountId);
}

describe("UsageCache — initialDelayMs defers the first fetch, not registration", () => {
	let fetchSpy: ReturnType<typeof spyOn> | null = null;
	const cleanups: string[] = [];

	function track(accountId: string): string {
		cleanups.push(accountId);
		return accountId;
	}

	afterEach(() => {
		for (const id of cleanups.splice(0)) {
			usageCache.stopPolling(id);
			usageCache.delete(id);
		}
		fetchSpy?.mockRestore();
		fetchSpy = null;
	});

	it("refreshNow performs a real fetch during the initial-delay window", async () => {
		// The incident property: a 429 landing seconds after a restart triggers
		// the ladder's pre-rung refreshNow, which must be able to fetch evidence
		// even though the account's first scheduled poll has not happened yet.
		const ACCOUNT = track("initial-delay-refresh-now");
		let served = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			served++;
			return healthyResponse();
		});

		usageCache.startPolling(
			ACCOUNT,
			"token-1",
			"anthropic",
			HOUR,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ initialDelayMs: 60_000 },
		);
		await wait(20);
		// Nothing fetched yet — the first scheduled poll is still a minute away.
		expect(served).toBe(0);
		expect(usageCache.get(ACCOUNT)).toBeNull();

		// But the poller is REGISTERED, so the on-demand path works right now.
		expect(await usageCache.refreshNow(ACCOUNT)).toBe(true);
		expect(served).toBe(1);
		expect(usageCache.get(ACCOUNT)).not.toBeNull();
	});

	it("the deferred first fetch fires after the delay and arms the poll loop", async () => {
		const ACCOUNT = track("initial-delay-first-fetch");
		let served = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			served++;
			return healthyResponse();
		});

		usageCache.startPolling(
			ACCOUNT,
			"token-1",
			"anthropic",
			HOUR,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ initialDelayMs: 100 },
		);
		await wait(20);
		expect(served).toBe(0);

		await wait(150);
		expect(served).toBe(1);
		expect(usageCache.get(ACCOUNT)).not.toBeNull();
		// The ordinary poll loop took over (next tick armed on the base cadence).
		expect(hasArmedTimer(ACCOUNT)).toBe(true);
	});

	it("stopPolling during the delay cancels the deferred first fetch", async () => {
		const ACCOUNT = track("initial-delay-stop");
		let served = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			served++;
			return healthyResponse();
		});

		usageCache.startPolling(
			ACCOUNT,
			"token-1",
			"anthropic",
			HOUR,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ initialDelayMs: 50 },
		);
		usageCache.stopPolling(ACCOUNT);

		await wait(120);
		expect(served).toBe(0);
		expect(hasArmedTimer(ACCOUNT)).toBe(false);
	});

	it("a replacement startPolling during the delay supersedes the deferred first fetch", async () => {
		const ACCOUNT = track("initial-delay-replace");
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
			healthyResponse(),
		);
		let gen1TokenCalls = 0;
		let gen2TokenCalls = 0;

		usageCache.startPolling(
			ACCOUNT,
			async () => {
				gen1TokenCalls++;
				return "token-1";
			},
			"anthropic",
			HOUR,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ initialDelayMs: 60 },
		);
		await wait(10);
		// Reauth-style replacement while the first fetch is still pending.
		usageCache.startPolling(
			ACCOUNT,
			async () => {
				gen2TokenCalls++;
				return "token-2";
			},
			"anthropic",
			HOUR,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ initialDelayMs: 40 },
		);

		await wait(150);
		// Only the replacement generation ever fetched.
		expect(gen1TokenCalls).toBe(0);
		expect(gen2TokenCalls).toBe(1);
		expect(usageCache.get(ACCOUNT)).not.toBeNull();
	});

	it("no initialDelayMs → the first fetch stays immediate (add-account priming path)", async () => {
		const ACCOUNT = track("initial-delay-absent");
		let served = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			served++;
			return healthyResponse();
		});

		usageCache.startPolling(ACCOUNT, "token-1", "anthropic", HOUR);
		await wait(30);
		expect(served).toBe(1);
		expect(usageCache.get(ACCOUNT)).not.toBeNull();
	});

	it("noteActivity during the delay neither hastens nor displaces the deferred first fetch", async () => {
		// Traffic on the account during the boot window must not bypass the
		// stagger: the deferred timer is marked isIdle:false, and noteActivity's
		// idle re-arm only touches idle timers.
		const ACCOUNT = track("initial-delay-note-activity");
		let served = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			served++;
			return healthyResponse();
		});

		usageCache.startPolling(
			ACCOUNT,
			"token-1",
			"anthropic",
			HOUR,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ demandAware: true, initialDelayMs: 100 },
		);
		await wait(10);
		usageCache.noteActivity(ACCOUNT);
		await wait(30);
		// No early fetch: the stagger stands.
		expect(served).toBe(0);
		expect(hasArmedTimer(ACCOUNT)).toBe(true);
		// The deferred first fetch still fires exactly once, on schedule.
		await wait(150);
		expect(served).toBe(1);
		expect(usageCache.get(ACCOUNT)).not.toBeNull();
	});

	it("an on-demand refresh inside the window does not displace the deferred first fetch", async () => {
		// A healthy refreshNow must leave the scheduled first poll armed: if it
		// could cancel it and the refresh path ever failed to re-arm, a boot-time
		// 429 would permanently silence the account's polling.
		const ACCOUNT = track("initial-delay-refresh-then-first");
		let served = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			served++;
			return healthyResponse();
		});

		usageCache.startPolling(
			ACCOUNT,
			"token-1",
			"anthropic",
			HOUR,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ initialDelayMs: 100 },
		);
		await wait(10);
		expect(await usageCache.refreshNow(ACCOUNT)).toBe(true);
		expect(served).toBe(1);
		// The deferred first fetch still fires and hands over to the poll loop.
		await wait(180);
		expect(served).toBe(2);
		expect(hasArmedTimer(ACCOUNT)).toBe(true);
	});
});
