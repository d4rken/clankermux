/**
 * Deferred client-abort mirror — the Bun-segfault workaround that made the
 * v2026.7.50 body-disposal work re-landable.
 *
 * v2026.7.50 threaded `req.signal` into every upstream fetch and hold
 * (`AbortSignal.any` composites, `abortableSleep`, `makeProxyRequest`). That
 * is semantically right — a client disconnect must tear the attempt down — but
 * it moved real work INTO Bun's native `RequestContext.onAbort` frame: the
 * socket-close dispatch now synchronously ran listener chains that cancelled
 * native fetches and tore down streams. Within ~80 minutes of deploying,
 * Bun 1.3.14 began segfaulting in exactly that frame
 * (`RequestContext.onAbort` → `uWS onClose`, addresses 0x9600000008 / 0x0) —
 * 10 crashes in one day against zero in the journal before, on the latest
 * released Bun with no matching upstream fix. See the
 * project memory `project_bun_onabort_segfault_revert`.
 *
 * The mirror removes the NEWLY-INTRODUCED work from that native frame: the
 * only listener the proxy core itself attaches to `req.signal` has a body of
 * exactly one `setTimeout(0)`. The actual abort propagation — fetch
 * cancellation, hold wake-ups, stream teardown — runs one macrotask later, on
 * a plain event-loop tick with no uWS dispatch on the stack. `setTimeout`,
 * deliberately NOT `queueMicrotask`: microtasks drain before the native
 * dispatch that invoked the JS callback fully unwinds (the crash stack shows
 * the segfault while `us_internal_dispatch_ready_poll` is still on the
 * stack), so only a fresh task actually leaves the frame.
 *
 * Honest scope: work that PREDATES the crashing merge still runs in that
 * dispatch and is out of this module's hands — Bun itself cancels the
 * response stream being served (which propagates through stream-analytics'
 * `cancel()` chain), the inbound body reader is coupled to the native request
 * lifecycle, and the openai-responses adapter's synthetic Request reuses the
 * native signal. Those paths existed through months of panic-free operation;
 * what changed in v2026.7.50 — and what this module takes back out of the
 * frame — is the synchronous fan-out from `req.signal` into upstream fetch
 * cancellation. That correlation is the workaround's basis, not a proof; the
 * validation is the live crash monitor staying quiet.
 *
 * Semantics preserved:
 *  - Synchronous `req.signal.aborted` CHECKS everywhere stay on the native
 *    signal — reads register nothing and cost nothing, so disconnect
 *    detection at loop tops is as immediate as before.
 *  - An already-aborted source returns the source itself: no listener would
 *    ever run in an onAbort frame (it already fired), and callers see the
 *    identical aborted state without a one-tick lag.
 *  - The one-macrotask lag on the CANCELLATION path is invisible at these
 *    timescales: it delays tearing down an upstream request for a client that
 *    is already gone by ~0-1ms.
 *
 * One mirror per request via a WeakMap keyed on the native signal, so N call
 * sites share one listener and the map never outlives its requests.
 */

const mirrors = new WeakMap<AbortSignal, AbortSignal>();

/**
 * The cancellation-path stand-in for `req.signal`: same abort semantics,
 * deferred by one macrotask so no downstream teardown runs inside Bun's
 * native onAbort dispatch.
 */
export function deferredClientSignal(req: Request): AbortSignal {
	const source = req.signal;
	if (source.aborted) return source;
	let mirror = mirrors.get(source);
	if (!mirror) {
		const controller = new AbortController();
		source.addEventListener(
			"abort",
			() => {
				// The ENTIRE body of the only listener the proxy puts on the native
				// signal: schedule, return. Nothing else may run in this frame.
				setTimeout(() => controller.abort(source.reason), 0);
			},
			{ once: true },
		);
		mirror = controller.signal;
		mirrors.set(source, mirror);
	}
	return mirror;
}
