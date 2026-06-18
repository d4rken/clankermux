/**
 * Tests for CacheKeepaliveScheduler (unified cache-warming path).
 *
 * Strategy:
 *   1. mock.module("@clankermux/core") intercepts registerHeartbeat so we
 *      can capture the registered callback and trigger sendKeepalives() without
 *      waiting for real timers.
 *   2. mock.module("../dispatch") intercepts dispatchProxyRequest so we can
 *      verify the scheduler dispatches the replay request through the in-process
 *      proxy pipeline (and assert on the synthetic Request it constructs).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Config } from "@clankermux/config";
import type { ProxyContext } from "../proxy";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the scheduler so that bun's
// module resolution picks up the mock.
// ---------------------------------------------------------------------------

type HeartbeatOpts = {
	id: string;
	callback: () => void | Promise<void>;
	seconds?: number;
	description?: string;
};

// Stores the last registered heartbeat callback so tests can trigger it.
let capturedCallback: (() => void | Promise<void>) | null = null;
let capturedSeconds: number | null = null;
let capturedId: string | null = null;
const mockUnregister = mock(() => {});
const mockRegisterHeartbeat = mock((opts: HeartbeatOpts) => {
	capturedCallback = opts.callback;
	capturedSeconds = opts.seconds ?? 30;
	capturedId = opts.id;
	return mockUnregister;
});

mock.module("@clankermux/core", () => ({
	registerHeartbeat: mockRegisterHeartbeat,
	registerCleanup: mock(() => () => {}),
	registerUIRefresh: mock(() => () => {}),
	intervalManager: {
		register: mock(() => () => {}),
		unregister: mock(() => {}),
	},
}));

// Captures the synthetic Requests the scheduler builds so tests can assert on
// the URL, headers, and body passed to dispatchProxyRequest.
const capturedDispatchCalls: Array<{ req: Request; url: URL }> = [];
const mockDispatchProxyRequest = mock(async (req: Request, url: URL) => {
	capturedDispatchCalls.push({ req, url });
	return new Response("", { status: 200 });
});

mock.module("../dispatch", () => ({
	dispatchProxyRequest: mockDispatchProxyRequest,
}));

import { KEEPALIVE_REFRESH_MS, MAX_KEEPALIVE_FAILURES } from "../bridge-policy";
import { cacheBodyStore } from "../cache-body-store";
// Import AFTER mock.module so the scheduler gets the mocked registerHeartbeat
// and dispatchProxyRequest.
import {
	CacheKeepaliveScheduler,
	extractCacheCreationTokens,
} from "../cache-keepalive-scheduler";
import { sessionCacheStore } from "../session-cache-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ProxyContext — scheduler only reads runtime.port. */
function makeProxyContext(port = 8081): ProxyContext {
	return { runtime: { port } } as unknown as ProxyContext;
}

type ConfigChangeListener = (evt: { key: string; newValue: unknown }) => void;

/**
 * Minimal Config mock with a simple event emitter for "change", driving the new
 * cache-warming getters (enabled + min tokens).
 */
function makeConfig(
	initialEnabled: boolean,
	initialMinTokens = 100_000,
): {
	config: Config;
	fireEnabledChange: (next: boolean) => void;
	fireMinTokensChange: (next: number) => void;
} {
	let enabled = initialEnabled;
	let minTokens = initialMinTokens;
	const listeners: ConfigChangeListener[] = [];

	const config = {
		getCacheWarmingEnabled: () => enabled,
		getCacheWarmingMinTokens: () => minTokens,
		on: (event: string, cb: ConfigChangeListener) => {
			if (event === "change") listeners.push(cb);
		},
		off: (event: string, cb: ConfigChangeListener) => {
			if (event === "change") {
				const idx = listeners.indexOf(cb);
				if (idx !== -1) listeners.splice(idx, 1);
			}
		},
	} as unknown as Config;

	const fireEnabledChange = (next: boolean) => {
		enabled = next;
		for (const l of listeners) {
			l({ key: "cache_warming_enabled", newValue: next });
		}
	};
	const fireMinTokensChange = (next: number) => {
		minTokens = next;
		for (const l of listeners) {
			l({ key: "cache_warming_min_tokens", newValue: next });
		}
	};

	return { config, fireEnabledChange, fireMinTokensChange };
}

/**
 * Register a session slot for (accountId, sessionKey) and backdate its
 * lastActivityTs so it clears the idle (KEEPALIVE_REFRESH_MS) threshold and is
 * immediately eligible. Uses a premium Anthropic model (claude-opus-4-5) with
 * cachedTokens above the 100k default min-token threshold.
 */
function seedSessionEntry(
	accountId: string,
	sessionKey: string,
	opts: { cachedTokens?: number; path?: string; bodyText?: string } = {},
): void {
	const {
		cachedTokens = 150_000,
		path = "/v1/messages",
		bodyText = '{"model":"claude-opus-4-5","messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"sys","cache_control":{"type":"ephemeral"}}]}',
	} = opts;
	const bodyBuffer = new TextEncoder().encode(bodyText).buffer;
	sessionCacheStore.register({
		accountId,
		sessionKey,
		body: bodyBuffer,
		headers: new Headers({ "content-type": "application/json" }),
		path,
		model: "claude-opus-4-5",
		cacheReadTokens: cachedTokens,
		cacheCreationTokens: 0,
	});
	// Backdate lastActivityTs past the idle threshold so the slot is due now.
	const slot = sessionCacheStore
		.getAllSlots()
		.find((s) => s.accountId === accountId && s.sessionKey === sessionKey);
	if (slot) {
		(slot as { lastActivityTs: number }).lastActivityTs =
			Date.now() - (KEEPALIVE_REFRESH_MS + 60_000);
	}
}

// ---------------------------------------------------------------------------
// Test lifecycle helpers
// ---------------------------------------------------------------------------

function resetMocks(): void {
	mockRegisterHeartbeat.mockClear();
	mockUnregister.mockClear();
	mockDispatchProxyRequest.mockClear();
	// Restore the default 200/empty-body implementation so a persistent
	// mockImplementation set by one test doesn't leak into the next.
	mockDispatchProxyRequest.mockImplementation(
		async (req: Request, url: URL) => {
			capturedDispatchCalls.push({ req, url });
			return new Response("", { status: 200 });
		},
	);
	capturedCallback = null;
	capturedSeconds = null;
	capturedId = null;
	capturedDispatchCalls.length = 0;
}

function resetStore(): void {
	cacheBodyStore.setEnabled(false);
	sessionCacheStore.setEnabled(false);
	sessionCacheStore.clear();
	sessionCacheStore.setMinTokens(100_000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CacheKeepaliveScheduler", () => {
	beforeEach(() => {
		resetMocks();
		resetStore();
	});

	afterEach(() => {
		resetStore();
	});

	// -------------------------------------------------------------------------
	// start() behaviour
	// -------------------------------------------------------------------------

	describe("start()", () => {
		it("disabled — does NOT register a heartbeat and leaves the stores disabled", () => {
			const { config } = makeConfig(false);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);

			scheduler.start();

			expect(mockRegisterHeartbeat).not.toHaveBeenCalled();
			// Seeding should be a no-op when the session store is disabled.
			seedSessionEntry("acc-off", "session-off");
			expect(sessionCacheStore.getSize()).toBe(0);
		});

		it("enabled — registers heartbeat with a 60s tick and enables stores", () => {
			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);

			scheduler.start();

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);
			expect(capturedSeconds).toBe(60);
			expect(capturedId).toBe("cache-keepalive-scheduler");

			// Session store must be enabled — seeding should work.
			seedSessionEntry("acc-on", "session-on");
			expect(sessionCacheStore.getSize()).toBe(1);

			scheduler.stop();
		});

		it("propagates the configured min-token threshold to the session store", () => {
			const { config } = makeConfig(true, 200_000);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);

			scheduler.start();

			// 150k cached tokens are below the 200k threshold → not stored.
			seedSessionEntry("acc-min", "session-min", { cachedTokens: 150_000 });
			expect(sessionCacheStore.getSize()).toBe(0);

			scheduler.stop();
		});
	});

	// -------------------------------------------------------------------------
	// stop()
	// -------------------------------------------------------------------------

	describe("stop()", () => {
		it("calls the unregister function returned by registerHeartbeat", () => {
			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);

			scheduler.start();
			expect(mockUnregister).not.toHaveBeenCalled();

			scheduler.stop();
			expect(mockUnregister).toHaveBeenCalledTimes(1);
		});

		it("stop() when disabled (no interval registered) does not throw", () => {
			const { config } = makeConfig(false);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			expect(() => scheduler.stop()).not.toThrow();
			expect(mockUnregister).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// Config change events
	// -------------------------------------------------------------------------

	describe("config 'change' events", () => {
		it("disable — unregisters the interval and disables the stores", () => {
			const { config, fireEnabledChange } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

			fireEnabledChange(false);

			expect(mockUnregister).toHaveBeenCalledTimes(1);
			// No new interval registered.
			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);
			// Session store disabled.
			seedSessionEntry("acc-disabled", "session-disabled");
			expect(sessionCacheStore.getSize()).toBe(0);

			scheduler.stop();
		});

		it("enable after disabled — registers a new interval and enables stores", () => {
			const { config, fireEnabledChange } = makeConfig(false);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			expect(mockRegisterHeartbeat).not.toHaveBeenCalled();

			fireEnabledChange(true);

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);
			expect(capturedSeconds).toBe(60);

			seedSessionEntry("acc-enabled", "session-enabled");
			expect(sessionCacheStore.getSize()).toBe(1);

			scheduler.stop();
		});

		it("same enabled value — does NOT restart (no-op)", () => {
			const { config, fireEnabledChange } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

			fireEnabledChange(true);

			expect(mockUnregister).not.toHaveBeenCalled();
			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});

		it("min-token change propagates to the session store", () => {
			const { config, fireMinTokensChange } = makeConfig(true, 100_000);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			// 150k clears the initial 100k threshold.
			seedSessionEntry("acc-a", "session-a", { cachedTokens: 150_000 });
			expect(sessionCacheStore.getSize()).toBe(1);

			// Raise the threshold to 200k → a new 150k session no longer qualifies.
			fireMinTokensChange(200_000);
			seedSessionEntry("acc-b", "session-b", { cachedTokens: 150_000 });
			// acc-b not stored; acc-a still present.
			expect(
				sessionCacheStore.getAllSlots().find((s) => s.accountId === "acc-b"),
			).toBeUndefined();

			scheduler.stop();
		});

		it("unrelated config key change is ignored", () => {
			let listener: ConfigChangeListener | null = null;
			const config = {
				getCacheWarmingEnabled: () => true,
				getCacheWarmingMinTokens: () => 100_000,
				on: (_event: string, cb: ConfigChangeListener) => {
					listener = cb;
				},
				off: () => {},
			} as unknown as Config;

			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

			listener?.({ key: "some_other_key", newValue: 99 });

			expect(mockUnregister).not.toHaveBeenCalled();
			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});
	});

	// -------------------------------------------------------------------------
	// sendKeepalives() — triggered via captured heartbeat callback
	// -------------------------------------------------------------------------

	describe("sendKeepalives() (triggered via heartbeat callback)", () => {
		// The bridge dispatch adds a <=1s real-time decorrelation jitter between
		// sends. Stub setTimeout so the jitter resolves immediately.
		const realSetTimeout = globalThis.setTimeout;
		beforeEach(() => {
			// biome-ignore lint/suspicious/noExplicitAny: minimal timer stub for tests
			(globalThis as any).setTimeout = ((fn: () => void) => {
				fn();
				return 0 as unknown as ReturnType<typeof setTimeout>;
				// biome-ignore lint/suspicious/noExplicitAny: minimal timer stub for tests
			}) as any;
		});
		afterEach(() => {
			globalThis.setTimeout = realSetTimeout;
		});

		it("with no eligible sessions — dispatchProxyRequest is NOT called", async () => {
			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			await capturedCallback?.();

			expect(mockDispatchProxyRequest).not.toHaveBeenCalled();

			scheduler.stop();
		});

		it("dispatches an eligible session force-routed to its account with max_tokens=1", async () => {
			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedSessionEntry("acc-sess", "session-1");

			await capturedCallback?.();

			expect(mockDispatchProxyRequest).toHaveBeenCalledTimes(1);
			const { req, url } = capturedDispatchCalls[0];
			expect(url.pathname).toBe("/v1/messages");
			expect(req.method).toBe("POST");
			expect(req.headers.get("x-clankermux-account-id")).toBe("acc-sess");
			expect(req.headers.get("x-clankermux-bypass-session")).toBe("true");
			expect(req.headers.get("x-clankermux-keepalive")).toBe("true");
			expect(req.headers.get("content-type")).toBe("application/json");

			const decoded = JSON.parse(await req.text());
			expect(decoded.max_tokens).toBe(1);

			scheduler.stop();
		});

		it("cache_creation_input_tokens:0 records a hit (small spend, stays eligible after refresh)", async () => {
			mockDispatchProxyRequest.mockImplementationOnce(
				async (req: Request, url: URL) => {
					capturedDispatchCalls.push({ req, url });
					return new Response('{"usage":{"cache_creation_input_tokens":0}}', {
						status: 200,
					});
				},
			);

			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedSessionEntry("acc-hit", "session-hit");

			await capturedCallback?.();

			const slot = sessionCacheStore
				.getAllSlots()
				.find((s) => s.sessionKey === "session-hit");
			expect(slot).toBeDefined();
			// A hit charges only the small read cost — well under budget.
			expect(slot?.spentUsd).toBeGreaterThan(0);
			expect(slot?.spentUsd).toBeLessThan(slot?.budgetUsd ?? 0);
			expect(slot?.lastKeepaliveTs).not.toBeNull();
			// After its refresh window elapses again, it is eligible once more.
			const future =
				(slot?.lastKeepaliveTs ?? 0) + KEEPALIVE_REFRESH_MS + 1_000;
			expect(sessionCacheStore.getEligibleSessions(future)).toHaveLength(1);

			scheduler.stop();
		});

		it("cache_creation_input_tokens > 0 records a miss (spend jumps, drops out)", async () => {
			mockDispatchProxyRequest.mockImplementationOnce(
				async (req: Request, url: URL) => {
					capturedDispatchCalls.push({ req, url });
					return new Response(
						'{"usage":{"cache_creation_input_tokens":5000}}',
						{ status: 200 },
					);
				},
			);

			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedSessionEntry("acc-miss", "session-miss");

			await capturedCallback?.();
			expect(mockDispatchProxyRequest).toHaveBeenCalledTimes(1);

			const slot = sessionCacheStore
				.getAllSlots()
				.find((s) => s.sessionKey === "session-miss");
			// A miss charges ~the whole budget → spentUsd >= budgetUsd → ineligible.
			expect(slot?.spentUsd).toBeGreaterThanOrEqual(slot?.budgetUsd ?? 0);
			const future = Date.now() + KEEPALIVE_REFRESH_MS + 1_000;
			expect(sessionCacheStore.getEligibleSessions(future)).toHaveLength(0);

			scheduler.stop();
		});

		it("non-ok response charges no spend but records a failure (backoff)", async () => {
			mockDispatchProxyRequest.mockImplementationOnce(
				async (req: Request, url: URL) => {
					capturedDispatchCalls.push({ req, url });
					return new Response("rate limited", { status: 429 });
				},
			);

			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedSessionEntry("acc-429", "session-429");

			await capturedCallback?.();

			const slot = sessionCacheStore
				.getAllSlots()
				.find((s) => s.sessionKey === "session-429");
			// Non-ok is not charged against the budget...
			expect(slot?.spentUsd).toBe(0);
			// ...but IS a failed keepalive: backed off (lastKeepaliveTs set) and counted.
			expect(slot?.lastKeepaliveTs).not.toBeNull();
			expect(slot?.keepaliveFailures).toBe(1);

			scheduler.stop();
		});

		it("a slot is evicted after MAX consecutive non-ok responses across ticks", async () => {
			mockDispatchProxyRequest.mockImplementation(
				async (req: Request, url: URL) => {
					capturedDispatchCalls.push({ req, url });
					return new Response("gone", { status: 500 });
				},
			);

			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedSessionEntry("acc-zombie", "session-zombie");

			// Each tick: re-backdate so the slot is due again, then fire.
			for (let i = 0; i < MAX_KEEPALIVE_FAILURES; i++) {
				const slot = sessionCacheStore
					.getAllSlots()
					.find((s) => s.sessionKey === "session-zombie");
				if (slot) {
					(slot as { lastKeepaliveTs: number }).lastKeepaliveTs =
						Date.now() - (KEEPALIVE_REFRESH_MS + 60_000);
					(slot as { lastActivityTs: number }).lastActivityTs =
						Date.now() - (KEEPALIVE_REFRESH_MS + 60_000);
				}
				await capturedCallback?.();
			}

			// After MAX consecutive non-ok keepalives the zombie slot is gone.
			expect(
				sessionCacheStore
					.getAllSlots()
					.find((s) => s.sessionKey === "session-zombie"),
			).toBeUndefined();

			scheduler.stop();
		});

		it("dispatch throws — error does not propagate and records a failure", async () => {
			mockDispatchProxyRequest.mockImplementationOnce(async () => {
				throw new Error("synthetic-dispatch-failure");
			});

			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedSessionEntry("acc-conn-error", "session-conn-error");

			await expect(capturedCallback?.()).resolves.toBeUndefined();
			expect(mockDispatchProxyRequest).toHaveBeenCalledTimes(1);

			// A thrown dispatch is a failed keepalive: backed off and counted.
			const slot = sessionCacheStore
				.getAllSlots()
				.find((s) => s.sessionKey === "session-conn-error");
			expect(slot?.keepaliveFailures).toBe(1);
			expect(slot?.lastKeepaliveTs).not.toBeNull();
			expect(slot?.spentUsd).toBe(0);

			scheduler.stop();
		});

		it("caps dispatches at MAX_BRIDGE_KEEPALIVES_PER_TICK, highest-priority first", async () => {
			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			// 25 eligible sessions; priority scales with cachedTokens so we can
			// assert the highest-priority ones are the ones dispatched.
			for (let i = 0; i < 25; i++) {
				seedSessionEntry("acc-cap", `session-${i}`, {
					cachedTokens: 100_000 + i * 10_000,
				});
			}

			await capturedCallback?.();

			// Only the cap (20) dispatched this tick.
			expect(mockDispatchProxyRequest).toHaveBeenCalledTimes(20);

			// The lowest-priority 5 (i=0..4) were deferred → spentUsd still 0.
			for (let i = 0; i < 5; i++) {
				const slot = sessionCacheStore
					.getAllSlots()
					.find((s) => s.sessionKey === `session-${i}`);
				expect(slot?.spentUsd).toBe(0);
			}
			// The top-priority session was dispatched.
			const top = sessionCacheStore
				.getAllSlots()
				.find((s) => s.sessionKey === "session-24");
			expect(top?.spentUsd).toBeGreaterThan(0);

			scheduler.stop();
		});

		it("dispatches more sessions than KEEPALIVE_CONCURRENCY via chunked concurrency, recording each result", async () => {
			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			// 10 eligible sessions — well above KEEPALIVE_CONCURRENCY (4) but under
			// the per-tick cap (20). All should be dispatched (drained across ~3
			// chunks) and each should record a result (default 200/empty body => hit,
			// which charges a small spend).
			const count = 10;
			for (let i = 0; i < count; i++) {
				seedSessionEntry("acc-conc", `session-${i}`, {
					cachedTokens: 150_000,
				});
			}

			await capturedCallback?.();

			// Every eligible session was dispatched (chunked concurrency drains the
			// whole capped batch, not just the first chunk).
			expect(mockDispatchProxyRequest).toHaveBeenCalledTimes(count);

			// Each session recorded a hit/miss result (spend charged).
			for (let i = 0; i < count; i++) {
				const slot = sessionCacheStore
					.getAllSlots()
					.find((s) => s.sessionKey === `session-${i}`);
				expect(slot?.spentUsd).toBeGreaterThan(0);
			}

			scheduler.stop();
		});

		it("does not dispatch sessions that are not idle long enough", async () => {
			const { config } = makeConfig(true);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			// Fresh lastActivityTs (register stamps Date.now()) → not yet due.
			sessionCacheStore.register({
				accountId: "acc-fresh",
				sessionKey: "session-fresh",
				body: new TextEncoder().encode("{}").buffer,
				headers: new Headers(),
				path: "/v1/messages",
				model: "claude-opus-4-5",
				cacheReadTokens: 150_000,
				cacheCreationTokens: 0,
			});

			await capturedCallback?.();

			expect(mockDispatchProxyRequest).not.toHaveBeenCalled();

			scheduler.stop();
		});
	});
});

// ---------------------------------------------------------------------------
// extractCacheCreationTokens — JSON envelope vs SSE stream vs absent
// ---------------------------------------------------------------------------

describe("extractCacheCreationTokens", () => {
	it("parses the field from a JSON envelope body", () => {
		expect(
			extractCacheCreationTokens(
				'{"usage":{"cache_creation_input_tokens":1234,"cache_read_input_tokens":9}}',
			),
		).toBe(1234);
	});

	it("parses the field from an SSE message_start data line", () => {
		const sse =
			'event: message_start\ndata: {"type":"message_start","message":{"usage":{"cache_creation_input_tokens":0,"cache_read_input_tokens":50000}}}\n\n';
		expect(extractCacheCreationTokens(sse)).toBe(0);
	});

	it("tolerates whitespace around the colon", () => {
		expect(
			extractCacheCreationTokens('"cache_creation_input_tokens" : 42'),
		).toBe(42);
	});

	it("returns null when the field is absent (e.g. an error body)", () => {
		expect(
			extractCacheCreationTokens('{"error":{"message":"boom"}}'),
		).toBeNull();
		expect(extractCacheCreationTokens("")).toBeNull();
	});

	it("returns the FIRST match when multiple are present", () => {
		expect(
			extractCacheCreationTokens(
				'"cache_creation_input_tokens":7 ... "cache_creation_input_tokens":99',
			),
		).toBe(7);
	});
});
