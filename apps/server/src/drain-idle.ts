/**
 * Idle backstop for the SIGTERM drain.
 *
 * `Bun.Server.stop()` (graceful) is supposed to resolve once every in-flight
 * request has finished. On this deployment it sometimes does not: on the
 * 2026-08-23 19:01 restart the last real agentic stream finished 190s into the
 * drain and `stop()` still had not resolved 110s later, when the 300s shutdown
 * watchdog force-exited the process. The Caddy access log for that window shows
 * no request reaching the draining app after SIGTERM, so those 110s were spent
 * waiting on a connection with no work on it. Three of the last fifteen
 * restarts ended that way; the rest resolved on their own in 6-181s.
 *
 * This watcher polls a pending-work count and resolves once it has been
 * continuously zero for {@link DRAIN_IDLE_GRACE_MS}. It is RACED against
 * `stop()`, never substituted for it: on a normal drain `stop()` resolves first
 * and the watcher is cancelled, so fast restarts are unaffected. It only wins
 * when `stop()` is hanging with no work left to do.
 *
 * The count MUST be `server.pendingRequests + server.pendingWebSockets` —
 * Bun's own counters for work that is still worth preserving. They are
 * deliberately NARROWER than what a graceful `stop()` waits on: Bun also holds
 * it open for active HTTP connections, and an idle-but-open connection is
 * exactly what this backstop exists to override. The dashboard
 * in-flight registry (`getActiveRequests()`) is NOT a safe substitute: it
 * evicts entries at `ACTIVE_REQUEST_TTL_MS` (15 min) while a stream may legally
 * run for `STREAM_FORWARD_TOTAL_TIMEOUT_MS` (30 min), and it caps at 500
 * entries, so it can report "nothing in flight" while real work is streaming.
 * It also only learns of a request after ingress completes, which is after the
 * whole request body has been read — a slow upload accepted just before SIGTERM
 * would be invisible to it. Force-closing on either of those would sever live
 * traffic.
 */

/**
 * How long the pending count must stay continuously zero before the drain is
 * considered stuck rather than busy. Long enough to absorb a brief lull between
 * two requests on the same connection, short enough to save most of the dead
 * tail.
 */
export const DRAIN_IDLE_GRACE_MS = 15_000;

/** How often the pending count is sampled while the drain is running. */
export const DRAIN_IDLE_POLL_MS = 1_000;

export type DrainIdleOptions = {
	/**
	 * Units of work `stop()` is still draining — pass
	 * `server.pendingRequests + server.pendingWebSockets`.
	 */
	getPendingCount: () => number;
	/** Overridable for tests. */
	graceMs?: number;
	/** Overridable for tests. */
	pollMs?: number;
	/**
	 * Monotonic elapsed-time source. Defaults to `performance.now()` so a wall
	 * clock stepping forward mid-drain cannot manufacture an idle streak.
	 */
	now?: () => number;
};

export type DrainIdleWatcher = {
	/** Resolves once the pending count has been zero for the whole grace. */
	promise: Promise<void>;
	/** Stop polling. Safe to call more than once; the promise never settles. */
	cancel: () => void;
};

/**
 * Start watching for a drain that has gone idle. The returned promise resolves
 * at most once, and only on a full idle streak — it never rejects, so it is
 * safe to hand straight to `Promise.race`.
 */
export function waitForDrainIdle({
	getPendingCount,
	graceMs = DRAIN_IDLE_GRACE_MS,
	pollMs = DRAIN_IDLE_POLL_MS,
	now = () => performance.now(),
}: DrainIdleOptions): DrainIdleWatcher {
	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let idleSince: number | null = null;
	let resolvePromise: () => void = () => {};

	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});

	const schedule = () => {
		timer = setTimeout(tick, pollMs);
		// Never keep the process alive on this watcher's account — the drain it
		// observes is already the last thing running.
		timer.unref?.();
	};

	function tick(): void {
		if (cancelled) return;

		let pending: number;
		try {
			pending = getPendingCount();
		} catch {
			// Fail safe toward "still busy": mistaking an unreadable counter for
			// an empty one would sever live streams. The shutdown watchdog still
			// bounds the drain.
			pending = 1;
		}

		if (pending > 0) {
			idleSince = null;
		} else if (idleSince === null) {
			idleSince = now();
		} else if (now() - idleSince >= graceMs) {
			resolvePromise();
			return;
		}

		schedule();
	}

	schedule();

	return {
		promise,
		cancel() {
			cancelled = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
