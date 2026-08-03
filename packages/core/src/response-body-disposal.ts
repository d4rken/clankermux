/**
 * Response-body disposal primitives.
 *
 * Two DIFFERENT kinds of abandoned body need two DIFFERENT treatments, and
 * using the wrong one costs memory (or hangs):
 *
 *   - A NATIVE `fetch()` body must be DRAINED. At Bun 1.3.x a fetch Response
 *     body that is neither read to EOF nor cancelled keeps its socket and its
 *     ~512 KB native read buffer committed indefinitely; cancelling alone does
 *     not reliably return the native allocation, whereas reading to EOF does.
 *     Use {@link discardUpstreamBody}.
 *
 *   - A `clone()` / tee BRANCH must be CANCELLED, never drained. Draining a
 *     branch forces the tee to keep pulling bytes FOR that branch and buffer
 *     them for the twin — measured on Bun 1.3.14, draining a tee branch retains
 *     ~2.7x what cancelling it does. Use {@link discardTeeBranch}.
 *
 * Both functions return `void` and run their work as an internally-guarded
 * fire-and-forget task. That is deliberate: disposal happens on failover /
 * retry / error paths where the caller must move on to the next candidate
 * IMMEDIATELY, and awaiting the disposal would serialise the very failover this
 * exists to keep fast. A `void` return also makes an accidental `await` at a
 * call site harmless (it resolves instantly) rather than silently blocking.
 *
 * This module is a dependency-free leaf on purpose:
 *   - It lives in `@clankermux/core` because BOTH `@clankermux/proxy` and
 *     `@clankermux/providers` need it and `core` is the only runtime package
 *     both depend on (proxy depends on providers, so a proxy-local home would
 *     be a package cycle).
 *   - It is published as the `@clankermux/core/response-body-disposal` subpath
 *     and is deliberately NOT re-exported from `packages/core/src/index.ts`.
 *     That barrel is curated and `@clankermux/core` is a dependency of
 *     `dashboard-web`, whose bundle is a systemd `ExecStartPre` — anything
 *     added to the barrel reaches the browser bundle. `./renewal` is the
 *     precedent.
 *   - It therefore uses UNIVERSAL Web APIs only (`Response`, `ReadableStream`,
 *     `getReader`, `cancel`). No `node:` imports, no Bun-specific globals.
 */

/**
 * Wall-clock ceiling for a single drain. A stalled or infinite upstream stream
 * must never pin its reader and network connection while later candidates are
 * being tried: `makeProxyRequest` clears its own request timeout as soon as the
 * response HEADERS arrive, so nothing else bounds the body. On expiry the drain
 * gives up and falls back to a best-effort `cancel()`.
 */
const DRAIN_TIME_BUDGET_MS = 5_000;

/**
 * Byte ceiling for a single drain. Everything we discard is an error body or an
 * abandoned attempt, which is kilobytes in practice; this only exists so a
 * pathological (or hostile) multi-gigabyte body cannot be read to EOF just to
 * release it. On expiry the drain gives up and falls back to `cancel()`.
 */
const DRAIN_BYTE_BUDGET = 8 * 1024 * 1024;

/**
 * Release a NATIVE `fetch()` response body that will never be forwarded.
 *
 * Drains the body to EOF (bounded by {@link DRAIN_TIME_BUDGET_MS} and
 * {@link DRAIN_BYTE_BUDGET}) so Bun returns the socket and the ~512 KB native
 * read buffer, then cancels whatever is left. Never uses `arrayBuffer()`: that
 * would materialise the whole body on the heap to throw it away.
 *
 * Fire-and-forget by design (see the module comment). Safe to call with any
 * `Response`/`null`/`undefined` and safe to call twice: a `null` or already
 * locked body is skipped (locked means some other reader already owns it — it
 * will be drained or was cloned), and every error is swallowed because a body
 * that is already cancelled or errored has nothing left to release.
 */
export function discardUpstreamBody(
	response: Response | null | undefined,
): void {
	const body = response?.body;
	if (!body || body.locked) return;
	void drainToRelease(body);
}

async function drainToRelease(body: ReadableStream<Uint8Array>): Promise<void> {
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = body.getReader();
	} catch {
		// Locked between the guard above and here — someone else owns it now.
		return;
	}

	// `expired` is flipped by the deadline timer, which ALSO cancels the reader
	// so a hung `read()` resolves instead of hanging the drain forever. The
	// timer is always cleared in the `finally`, so it can never outlive the
	// drain (no unref needed, and nothing Node-specific is required).
	let expired = false;
	const deadline = setTimeout(() => {
		expired = true;
		reader.cancel().catch(() => {});
	}, DRAIN_TIME_BUDGET_MS);

	try {
		let drained = 0;
		while (!expired && drained < DRAIN_BYTE_BUDGET) {
			const { value, done } = await reader.read();
			if (done) return;
			drained += value?.byteLength ?? 0;
		}
	} catch {
		// Stream errored or was cancelled mid-drain — nothing left to release.
	} finally {
		clearTimeout(deadline);
		// No-op after a clean EOF; the real release when a budget expired.
		reader.cancel().catch(() => {});
	}
}

/**
 * Release a `clone()` / tee BRANCH that will never be read.
 *
 * Cancels — deliberately does NOT drain (see the module comment: draining a
 * branch makes the tee buffer for the twin).
 *
 * Never awaited, and callers must not await it either. `await
 * branch.body.cancel()` with the twin still unread does not settle (measured:
 * >3 s, no resolution) and that is spec-correct: WHATWG `ReadableStreamTee`
 * settles its `cancelPromise` only once BOTH branches have cancelled, and the
 * twin here is the live response someone else is actively reading.
 *
 * Safe with any `Response`/`null`/`undefined`; skips a null/locked body and
 * swallows the harmless error from an already-cancelled one.
 */
export function discardTeeBranch(response: Response | null | undefined): void {
	const body = response?.body;
	if (!body || body.locked) return;
	try {
		body.cancel().catch(() => {});
	} catch {
		// Body became locked/disturbed between the guard and the call.
	}
}
