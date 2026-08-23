/**
 * Tests for `waitForDrainIdle` — the backstop that ends a SIGTERM drain once
 * Bun's own pending-work counters have been zero long enough that
 * `Bun.Server.stop()` is demonstrably hanging on something other than real
 * work.
 */
import { describe, expect, it } from "bun:test";
import { waitForDrainIdle } from "./drain-idle";

/** Fast constants so the suite doesn't sleep for the production 15s grace. */
const POLL_MS = 5;
const GRACE_MS = 25;

describe("waitForDrainIdle", () => {
	it("resolves once the pending count has been zero for the full grace", async () => {
		const started = Date.now();
		const watcher = waitForDrainIdle({
			getPendingCount: () => 0,
			pollMs: POLL_MS,
			graceMs: GRACE_MS,
		});
		await watcher.promise;
		// First poll observes idle, so the earliest resolve is poll + grace.
		expect(Date.now() - started).toBeGreaterThanOrEqual(GRACE_MS);
	});

	it("does not resolve while work is still pending", async () => {
		let resolved = false;
		const watcher = waitForDrainIdle({
			getPendingCount: () => 1,
			pollMs: POLL_MS,
			graceMs: GRACE_MS,
		});
		void watcher.promise.then(() => {
			resolved = true;
		});
		await Bun.sleep(GRACE_MS * 4);
		expect(resolved).toBe(false);
		watcher.cancel();
	});

	it("restarts the grace when work appears mid-streak", async () => {
		// Driven entirely off an injected clock that advances one poll per
		// sample, so the assertion is on the exact number of polls and an
		// event-loop stall cannot change the outcome.
		const BUSY_ON_CALL = 3;
		let calls = 0;
		let virtualNow = 0;
		let callsAtResolve: number | null = null;
		const watcher = waitForDrainIdle({
			getPendingCount: () => {
				calls++;
				virtualNow += POLL_MS;
				return calls === BUSY_ON_CALL ? 1 : 0;
			},
			now: () => virtualNow,
			pollMs: POLL_MS,
			graceMs: GRACE_MS,
		});
		void watcher.promise.then(() => {
			callsAtResolve = calls;
		});
		await watcher.promise;
		// Call 3 is busy, so the streak restarts at call 4 and a full grace
		// (GRACE_MS / POLL_MS = 5 polls) has to elapse from there. Had the busy
		// sample not reset the streak, this would have resolved at call 6.
		const pollsPerGrace = GRACE_MS / POLL_MS;
		expect(callsAtResolve).toBe(BUSY_ON_CALL + 1 + pollsPerGrace);
	});

	it("stops polling after cancel and never resolves", async () => {
		let polls = 0;
		let resolved = false;
		const watcher = waitForDrainIdle({
			getPendingCount: () => {
				polls++;
				return 0;
			},
			pollMs: POLL_MS,
			graceMs: GRACE_MS,
		});
		void watcher.promise.then(() => {
			resolved = true;
		});
		await Bun.sleep(POLL_MS * 2);
		watcher.cancel();
		const pollsAtCancel = polls;
		await Bun.sleep(GRACE_MS * 3);
		expect(resolved).toBe(false);
		expect(polls).toBe(pollsAtCancel);
	});

	it("cancel is idempotent", () => {
		const watcher = waitForDrainIdle({
			getPendingCount: () => 0,
			pollMs: POLL_MS,
			graceMs: GRACE_MS,
		});
		watcher.cancel();
		expect(() => {
			watcher.cancel();
		}).not.toThrow();
	});

	it("treats a throwing counter as busy rather than exiting the drain", async () => {
		// Fail-safe direction: an unreadable counter must not be mistaken for
		// "nothing in flight" and cut live streams short. The 300s watchdog
		// still bounds the drain.
		let resolved = false;
		const watcher = waitForDrainIdle({
			getPendingCount: () => {
				throw new Error("counter unavailable");
			},
			pollMs: POLL_MS,
			graceMs: GRACE_MS,
		});
		void watcher.promise.then(() => {
			resolved = true;
		});
		await Bun.sleep(GRACE_MS * 4);
		expect(resolved).toBe(false);
		watcher.cancel();
	});

	it("measures the streak on the injected clock, not the wall clock", async () => {
		// Guards the monotonic-clock choice: elapsed time comes from `now()`, so
		// a clock that never advances can never complete a grace no matter how
		// much wall time passes.
		let resolved = false;
		const watcher = waitForDrainIdle({
			getPendingCount: () => 0,
			pollMs: POLL_MS,
			graceMs: GRACE_MS,
			now: () => 1000,
		});
		void watcher.promise.then(() => {
			resolved = true;
		});
		await Bun.sleep(GRACE_MS * 4);
		expect(resolved).toBe(false);
		watcher.cancel();
	});
});

/** A promise plus the handles to settle it from elsewhere. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("waitForDrainIdle against a real Bun server mid-drain", () => {
	it("holds while a request is in flight during a graceful stop, then fires", async () => {
		// The predicate has to hold up in the exact situation it is used in: a
		// graceful stop() already pending, one request still running. The
		// handler is gated rather than timed so the request is provably in
		// flight for as long as the assertions need it to be.
		const entered = deferred();
		const release = deferred();
		const server = Bun.serve({
			port: 0,
			idleTimeout: 30,
			async fetch() {
				entered.resolve();
				await release.promise;
				return new Response("done");
			},
		});

		try {
			const inFlight = fetch(`http://127.0.0.1:${server.port}/`);
			await entered.promise;

			// Begin the graceful drain with the request still executing, which
			// is what the shutdown handler does.
			const stopped = server.stop();

			let resolvedWhileBusy = false;
			const watcher = waitForDrainIdle({
				getPendingCount: () =>
					server.pendingRequests + server.pendingWebSockets,
				pollMs: POLL_MS,
				graceMs: GRACE_MS,
			});
			void watcher.promise.then(() => {
				resolvedWhileBusy = true;
			});

			// The counters must stay readable and non-zero after stop() — this
			// is what makes them a safe force-close oracle.
			expect(server.pendingRequests).toBeGreaterThan(0);
			await Bun.sleep(GRACE_MS * 4);
			expect(resolvedWhileBusy).toBe(false);
			expect(server.pendingRequests).toBeGreaterThan(0);

			// Let the request finish; only now may the watcher fire.
			release.resolve();
			await inFlight;
			await watcher.promise;
			expect(server.pendingRequests).toBe(0);
			await stopped;
		} finally {
			release.resolve();
			await server.stop(true);
		}
	});
});
