import { describe, expect, it } from "bun:test";
import { holdBeforeCodexRetry } from "../codex-transient-hold";

/**
 * The wait helper only. It sits between an abandoned upstream body and a retry
 * of the same account, so a hold that outlives a client disconnect, or that
 * leaves its abort listener behind on a long-lived request signal, costs a
 * pinned connection for every held request.
 */

/**
 * Counts abort listeners currently registered on `signal`, accounting for
 * `{ once: true }` registrations (removed by the dispatch rather than by an
 * explicit `removeEventListener`).
 */
function trackAbortListeners(signal: AbortSignal): () => number {
	let live = 0;
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	const wrappers = new Map<EventListener, EventListener>();
	signal.addEventListener = ((
		type: string,
		listener: EventListener,
		options?: AddEventListenerOptions,
	) => {
		if (type !== "abort") return add(type, listener, options);
		live++;
		const wrapped: EventListener = (event) => {
			if (options?.once) live--;
			listener(event);
		};
		wrappers.set(listener, wrapped);
		return add(type, wrapped, options);
	}) as typeof signal.addEventListener;
	signal.removeEventListener = ((
		type: string,
		listener: EventListener,
		options?: EventListenerOptions,
	) => {
		const wrapped = wrappers.get(listener);
		if (type !== "abort" || !wrapped) return remove(type, listener, options);
		wrappers.delete(listener);
		live--;
		return remove(type, wrapped, options);
	}) as typeof signal.removeEventListener;
	return () => live;
}

describe("holdBeforeCodexRetry", () => {
	it("resolves after the requested duration", async () => {
		const started = Date.now();
		await holdBeforeCodexRetry(40, new AbortController().signal);
		expect(Date.now() - started).toBeGreaterThanOrEqual(35);
	});

	it("resolves immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const started = Date.now();
		await holdBeforeCodexRetry(30_000, controller.signal);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it("resolves when the signal aborts mid-wait", async () => {
		const controller = new AbortController();
		const started = Date.now();
		setTimeout(() => controller.abort(), 20);
		await holdBeforeCodexRetry(30_000, controller.signal);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it("leaves no abort listener behind on either exit", async () => {
		const completed = new AbortController();
		const liveAfterCompletion = trackAbortListeners(completed.signal);
		await holdBeforeCodexRetry(20, completed.signal);
		expect(liveAfterCompletion()).toBe(0);

		const aborted = new AbortController();
		const liveAfterAbort = trackAbortListeners(aborted.signal);
		setTimeout(() => aborted.abort(), 10);
		await holdBeforeCodexRetry(30_000, aborted.signal);
		expect(liveAfterAbort()).toBe(0);
	});
});
