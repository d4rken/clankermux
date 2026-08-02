import { describe, expect, it } from "bun:test";
import { deferredClientSignal } from "../deferred-client-signal";
import { abortableSleep } from "../transparent-retry";

const tick = () => new Promise((r) => setTimeout(r, 0));

function abortableRequest(): {
	req: Request;
	abort: (reason?: unknown) => void;
} {
	const controller = new AbortController();
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body: "{}",
		signal: controller.signal,
	});
	return { req, abort: (reason?: unknown) => controller.abort(reason) };
}

describe("deferredClientSignal", () => {
	it("does NOT abort synchronously with the source — only on a later macrotask", async () => {
		const { req, abort } = abortableRequest();
		const mirror = deferredClientSignal(req);
		expect(mirror.aborted).toBe(false);

		abort();
		// The native signal flips immediately; the mirror must NOT have — that
		// synchronous window is exactly the onAbort frame the workaround empties.
		expect(req.signal.aborted).toBe(true);
		expect(mirror.aborted).toBe(false);

		await tick();
		expect(mirror.aborted).toBe(true);
	});

	it("propagates the abort reason", async () => {
		const { req, abort } = abortableRequest();
		const mirror = deferredClientSignal(req);
		const reason = new Error("client went away");
		abort(reason);
		await tick();
		expect(mirror.aborted).toBe(true);
		expect(mirror.reason).toBe(reason);
	});

	it("returns the source itself when it is already aborted (no lag, no listener)", () => {
		const { req, abort } = abortableRequest();
		abort();
		const mirror = deferredClientSignal(req);
		expect(mirror).toBe(req.signal);
		expect(mirror.aborted).toBe(true);
	});

	it("returns ONE shared mirror per request across call sites", () => {
		const { req } = abortableRequest();
		expect(deferredClientSignal(req)).toBe(deferredClientSignal(req));
	});

	it("mirrors are independent across requests", async () => {
		const a = abortableRequest();
		const b = abortableRequest();
		const mirrorA = deferredClientSignal(a.req);
		const mirrorB = deferredClientSignal(b.req);
		a.abort();
		await tick();
		expect(mirrorA.aborted).toBe(true);
		expect(mirrorB.aborted).toBe(false);
	});

	it("defers past the ENTIRE microtask queue — a macrotask, not queueMicrotask", async () => {
		// The workaround is only real if propagation happens on a fresh TASK:
		// microtasks drain before the native dispatch unwinds, so a regression to
		// queueMicrotask would put the teardown right back in the crashing frame.
		const { req, abort } = abortableRequest();
		const mirror = deferredClientSignal(req);
		abort();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(mirror.aborted).toBe(false); // survived the microtask queue
		await tick();
		expect(mirror.aborted).toBe(true);
	});

	it("wakes an AbortSignal.any composite via the deferred path", async () => {
		const { req, abort } = abortableRequest();
		const other = new AbortController();
		const composite = AbortSignal.any([
			deferredClientSignal(req),
			other.signal,
		]);
		let woke = false;
		composite.addEventListener("abort", () => {
			woke = true;
		});
		abort();
		expect(woke).toBe(false); // not in the source's abort frame
		await tick();
		expect(woke).toBe(true);
	});

	it("releases a real abortableSleep promptly through the deferred path", async () => {
		const { req, abort } = abortableRequest();
		const sleep = abortableSleep(60_000, deferredClientSignal(req));
		abort();
		// The mirror's one-task lag must not turn into waiting out the hold: the
		// sleep resolves false (aborted) right after the deferral tick.
		const completed = await sleep;
		expect(completed).toBe(false);
	});

	it("a call during the deferral window takes the already-aborted shortcut; the earlier mirror still fires", async () => {
		// After the native signal aborts, NEW call sites get the source itself
		// (aborted immediately — the shortcut, no listener, no lag), while a
		// mirror handed out earlier still fires on its deferred tick. Both
		// consumers converge on "aborted"; neither can end up with a
		// never-aborting signal.
		const { req, abort } = abortableRequest();
		const before = deferredClientSignal(req);
		abort();
		const during = deferredClientSignal(req);
		expect(during).toBe(req.signal);
		expect(during.aborted).toBe(true);
		expect(before.aborted).toBe(false); // still inside the deferral window
		await tick();
		expect(before.aborted).toBe(true);
	});
});
