import { beforeEach, describe, expect, it } from "bun:test";
import {
	IDLE_REFRESH_LEAD_MS,
	USAGE_CACHE_TTL_MS,
} from "@clankermux/providers";
import {
	CodexUsagePoller,
	type CodexUsagePollerDeps,
	type PolledCodexAccount,
} from "./codex-usage-poller";

/**
 * The poller's cadence maths delegates to the shared computePollDelay, so these
 * tests pin the POLLER's own contract: which accounts it reads, when a read is
 * skipped, how failures thread into the next delay, and how per-account state
 * lives and dies with the account list. Delay values are asserted with
 * jitter = 0, where the shared helper is deterministic:
 *   active            → activeIntervalMs
 *   idle              → min(10min, USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS)
 *   failure backoff   → activeIntervalMs * 2^failures (capped at 30min)
 */

const ACTIVE_MS = 90_000;
const IDLE_MS = Math.min(
	10 * 60_000,
	USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS,
);
const T0 = 1_700_000_000_000;

interface Harness {
	poller: CodexUsagePoller;
	accounts: PolledCodexAccount[];
	readCalls: string[];
	setNow(ms: number): void;
	now(): number;
	setObservedAt(accountId: string, observedAtMs: number | null): void;
	setReadResult(result: { success: boolean; message: string }): void;
	/**
	 * By default a successful readUsage stamps a TIMED reading at the current
	 * clock, modeling applyCodexUsageStatus. Disable to model a GET that
	 * "succeeds" without producing a timed entry (superseded by an UNTIMED
	 * reconstruction).
	 */
	setReadProducesTimedReading(value: boolean): void;
}

function makeAccount(
	overrides: Partial<PolledCodexAccount> = {},
): PolledCodexAccount {
	return {
		id: "acct-1",
		name: "Codex-1",
		access_token: "tok",
		refresh_token: "refresh",
		last_used: null,
		...overrides,
	};
}

function makeHarness(accounts: PolledCodexAccount[]): Harness {
	let nowMs = T0;
	const readCalls: string[] = [];
	const observedAt = new Map<string, number | null>();
	let readResult = { success: true, message: "ok" };
	let readProducesTimedReading = true;
	const deps: CodexUsagePollerDeps = {
		listCodexAccounts: async () => accounts,
		readUsage: async (accountId) => {
			readCalls.push(accountId);
			if (readResult.success && readProducesTimedReading) {
				observedAt.set(accountId, nowMs);
			}
			return readResult;
		},
		peekObservedAtMs: (accountId) => observedAt.get(accountId) ?? null,
		activeIntervalMs: () => ACTIVE_MS,
		now: () => nowMs,
		jitterFraction: () => 0,
	};
	return {
		poller: new CodexUsagePoller(deps),
		accounts,
		readCalls,
		setNow: (ms) => {
			nowMs = ms;
		},
		now: () => nowMs,
		setObservedAt: (accountId, ms) => {
			observedAt.set(accountId, ms);
		},
		setReadResult: (result) => {
			readResult = result;
		},
		setReadProducesTimedReading: (value) => {
			readProducesTimedReading = value;
		},
	};
}

describe("CodexUsagePoller", () => {
	let h: Harness;

	beforeEach(() => {
		h = makeHarness([makeAccount()]);
	});

	it("reads a due account with no cached reading on the first tick", async () => {
		await h.poller.tick();
		expect(h.readCalls).toEqual(["acct-1"]);
	});

	it("does not read again before the next due time", async () => {
		await h.poller.tick();
		h.setNow(T0 + IDLE_MS - 1);
		await h.poller.tick();
		expect(h.readCalls).toEqual(["acct-1"]);
	});

	it("uses the idle cadence when the account has no recent activity", async () => {
		await h.poller.tick();
		h.setNow(T0 + IDLE_MS - 1);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(1);
		h.setNow(T0 + IDLE_MS);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(2);
	});

	it("uses the active cadence when the account served a request recently", async () => {
		h.accounts[0].last_used = T0 - 60_000;
		await h.poller.tick();
		h.setNow(T0 + ACTIVE_MS - 1);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(1);
		h.setNow(T0 + ACTIVE_MS);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(2);
	});

	it("skips the network read when real traffic already produced a fresh timed reading", async () => {
		h.accounts[0].last_used = h.now() - 5_000;
		h.setObservedAt("acct-1", h.now() - 10_000);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(0);
		// The skip still reschedules: once the reading outlives the active
		// interval, the next due tick reads for real.
		h.setNow(T0 + ACTIVE_MS);
		h.accounts[0].last_used = h.now() - 5_000;
		await h.poller.tick();
		expect(h.readCalls).toEqual(["acct-1"]);
	});

	it("still reads when the cached reading is UNTIMED (post-restart payload rebuild)", async () => {
		// peekObservedAtMs = null models an entry seeded via setUntimed: present but
		// with no honest observation time. The poller's whole point is replacing it.
		h.setObservedAt("acct-1", null);
		await h.poller.tick();
		expect(h.readCalls).toEqual(["acct-1"]);
	});

	it("backs off exponentially on read failures and recovers on success", async () => {
		h.setReadResult({ success: false, message: "boom" });
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(1);
		// One failure → next attempt after ACTIVE * 2, not at the idle cadence.
		h.setNow(T0 + ACTIVE_MS * 2 - 1);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(1);
		h.setNow(T0 + ACTIVE_MS * 2);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(2);
		// Second failure → ACTIVE * 4.
		h.setNow(T0 + ACTIVE_MS * 2 + ACTIVE_MS * 4 - 1);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(2);
		h.setNow(T0 + ACTIVE_MS * 2 + ACTIVE_MS * 4);
		h.setReadResult({ success: true, message: "ok" });
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(3);
		// Success resets the streak: the next delay is the healthy idle cadence,
		// not a further-doubled backoff.
		const base = T0 + ACTIVE_MS * 2 + ACTIVE_MS * 4;
		h.setNow(base + IDLE_MS - 1);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(3);
		h.setNow(base + IDLE_MS);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(4);
	});

	it("never reads an account with no tokens", async () => {
		h.accounts[0].access_token = null;
		h.accounts[0].refresh_token = null;
		await h.poller.tick();
		h.setNow(T0 + IDLE_MS * 3);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(0);
	});

	it("prunes state for removed accounts so a re-added account is due immediately", async () => {
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(1);
		const removed = h.accounts.pop();
		if (!removed) throw new Error("test setup");
		await h.poller.tick();
		// Re-add well before the old IDLE schedule (9min) would have been due:
		// pruned state means it is treated as new and read on the next beat (the
		// clock sits past the freshness window so the read is not skipped).
		h.setNow(T0 + ACTIVE_MS + 30_000);
		h.accounts.push(removed);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(2);
	});

	it("pulls an idle-scheduled account in when traffic resumes", async () => {
		await h.poller.tick(); // schedules at idle cadence (due T0 + IDLE_MS)
		expect(h.readCalls).toHaveLength(1);
		// Traffic resumes 2 minutes in; the idle wake is still ~7 minutes out,
		// which is more than one active interval away → pull in and read now.
		h.setNow(T0 + 120_000);
		h.accounts[0].last_used = h.now() - 1_000;
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(2);
	});

	it("does not pull in when the pending wake is already near", async () => {
		h.accounts[0].last_used = T0 - 1_000;
		await h.poller.tick(); // active cadence: due T0 + ACTIVE_MS
		expect(h.readCalls).toHaveLength(1);
		h.setNow(T0 + 30_000);
		h.accounts[0].last_used = h.now() - 1_000;
		await h.poller.tick();
		// Wake is 60s out (< active * 1.2): no early read.
		expect(h.readCalls).toHaveLength(1);
	});

	it("polls each codex account independently", async () => {
		h = makeHarness([
			makeAccount(),
			makeAccount({ id: "acct-2", name: "Codex-2", last_used: T0 - 1_000 }),
		]);
		await h.poller.tick();
		expect(h.readCalls.sort()).toEqual(["acct-1", "acct-2"]);
		// acct-2 is active (90s cadence), acct-1 idle (9min cadence).
		h.setNow(T0 + ACTIVE_MS);
		h.accounts[1].last_used = h.now() - 1_000;
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(3);
		expect(h.readCalls[2]).toBe("acct-2");
	});

	it("clamps the freshness-skip threshold when the configured interval exceeds the delay cap", async () => {
		// With a configured active interval ABOVE the demand-aware delay clamp
		// (TTL - lead = 9min), the next poll is due at the CLAMP, and the reading
		// taken by the previous poll must count as stale there — otherwise every
		// poll skips and the real cadence doubles.
		const bigActive = USAGE_CACHE_TTL_MS + 5 * 60_000; // 15min, clamp = 9min
		let nowMs = T0;
		const readCalls: string[] = [];
		const accounts = [makeAccount({ last_used: T0 - 1_000 })];
		const poller = new CodexUsagePoller({
			listCodexAccounts: async () => accounts,
			readUsage: async (id) => {
				readCalls.push(id);
				return { success: true, message: "ok" };
			},
			// The previous poll's reading, aging naturally with the clock.
			peekObservedAtMs: () => (readCalls.length === 0 ? null : T0),
			activeIntervalMs: () => bigActive,
			now: () => nowMs,
			jitterFraction: () => 0,
		});
		await poller.tick();
		expect(readCalls).toHaveLength(1);
		// Next due time is the clamp (9min), where the T0 reading is 9min old:
		// older than the clamped freshness threshold → a real read, not a skip.
		nowMs = T0 + (USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS);
		accounts[0].last_used = nowMs - 1_000;
		await poller.tick();
		expect(readCalls).toHaveLength(2);
	});

	it("clears a failure streak when traffic supplies a fresh timed reading", async () => {
		h.accounts[0].last_used = T0 - 1_000;
		h.setReadResult({ success: false, message: "boom" });
		await h.poller.tick(); // failure #1 → due at ACTIVE * 2
		expect(h.readCalls).toHaveLength(1);
		// Real traffic produces a fresh TIMED reading before the backoff elapses.
		h.setNow(T0 + ACTIVE_MS * 2);
		h.accounts[0].last_used = h.now() - 1_000;
		h.setObservedAt("acct-1", h.now() - 5_000);
		await h.poller.tick(); // freshness skip resets the streak
		expect(h.readCalls).toHaveLength(1);
		// The next schedule is the healthy ACTIVE cadence, not ACTIVE * 4.
		h.setNow(T0 + ACTIVE_MS * 3);
		h.accounts[0].last_used = h.now() - 1_000;
		h.setReadResult({ success: true, message: "ok" });
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(2);
	});

	it("retries at the active cadence when a successful read leaves the cache untimed", async () => {
		// Models the coordinator's "superseded by a newer observation" success:
		// the GET succeeded but an UNTIMED reconstruction won the cache write, so
		// peekObservedAtMs stays null. The poller must not sleep the idle ~9min on
		// that outcome.
		h.setReadProducesTimedReading(false);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(1);
		h.setNow(T0 + ACTIVE_MS);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(2);
		// Once a read produces a TIMED entry, the idle cadence resumes.
		h.setReadProducesTimedReading(true);
		h.setNow(T0 + ACTIVE_MS * 2);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(3);
		h.setNow(T0 + ACTIVE_MS * 2 + IDLE_MS - 1);
		await h.poller.tick();
		expect(h.readCalls).toHaveLength(3);
	});

	it("isolates a throwing read to its own account and backs it off", async () => {
		let nowMs = T0;
		const readCalls: string[] = [];
		const accounts = [
			makeAccount({ id: "acct-throws", name: "Codex-Throws" }),
			makeAccount({ id: "acct-2", name: "Codex-2" }),
		];
		const poller = new CodexUsagePoller({
			listCodexAccounts: async () => accounts,
			readUsage: async (id) => {
				readCalls.push(id);
				if (id === "acct-throws") throw new Error("db exploded");
				return { success: true, message: "ok" };
			},
			peekObservedAtMs: () => null,
			activeIntervalMs: () => ACTIVE_MS,
			now: () => nowMs,
			jitterFraction: () => 0,
		});
		await poller.tick();
		// The throw did not starve acct-2.
		expect(readCalls).toEqual(["acct-throws", "acct-2"]);
		// The thrower is in backoff (ACTIVE * 2), not due on the next beat.
		nowMs = T0 + ACTIVE_MS * 2 - 1;
		await poller.tick();
		expect(readCalls.filter((id) => id === "acct-throws")).toHaveLength(1);
		nowMs = T0 + ACTIVE_MS * 2;
		await poller.tick();
		expect(readCalls.filter((id) => id === "acct-throws")).toHaveLength(2);
	});

	it("stops initiating reads mid-batch once stop() is called", async () => {
		let nowMs = T0;
		const readCalls: string[] = [];
		const accounts = [
			makeAccount(),
			makeAccount({ id: "acct-2", name: "Codex-2" }),
		];
		let poller: CodexUsagePoller;
		const deps: CodexUsagePollerDeps = {
			listCodexAccounts: async () => accounts,
			readUsage: async (id) => {
				readCalls.push(id);
				// stop() arrives while the FIRST account's read is in flight.
				poller.stop();
				return { success: true, message: "ok" };
			},
			peekObservedAtMs: () => null,
			activeIntervalMs: () => ACTIVE_MS,
			now: () => nowMs,
			jitterFraction: () => 0,
		};
		poller = new CodexUsagePoller(deps);
		await poller.tick();
		expect(readCalls).toEqual(["acct-1"]);
		nowMs = T0 + IDLE_MS * 2;
		await poller.tick();
		expect(readCalls).toEqual(["acct-1"]);
	});

	it("ignores overlapping ticks while one is still running", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const deps: CodexUsagePollerDeps = {
			listCodexAccounts: async () => {
				await gate;
				return [];
			},
			readUsage: async () => ({ success: true, message: "ok" }),
			peekObservedAtMs: () => null,
			activeIntervalMs: () => ACTIVE_MS,
			now: () => T0,
			jitterFraction: () => 0,
		};
		const poller = new CodexUsagePoller(deps);
		const first = poller.tick();
		const second = poller.tick(); // must resolve without waiting on the gate
		await second;
		release?.();
		await first;
	});
});
