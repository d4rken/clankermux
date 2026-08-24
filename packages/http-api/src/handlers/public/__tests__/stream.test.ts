/**
 * The public request stream.
 *
 * Three behaviours are copied deliberately from the internal dashboard lane and
 * each is asserted on its own, because each has a different failure:
 *
 *  - SUBSCRIBE-THEN-SNAPSHOT. Reversing it loses any request that settles in
 *    between, and the client holds that request as pending until its
 *    lost-timeout. A test that only checked "a snapshot arrives" would pass
 *    against the broken order, so the ORDERING itself is what is asserted.
 *  - The snapshot is sent unconditionally, empty included: its arrival is the
 *    device's only signal that replay finished, and an empty one is what
 *    retracts rows a reconnecting device still holds.
 *  - The `server-shutdown` event name, which is how the device tells a clean
 *    restart from a network failure and skips its backoff.
 *
 * Plus the property this whole surface exists for: the internal event
 * discriminator never reaches the wire.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	type RequestEvt,
	requestEvents,
	resetRequestEventRegistry,
} from "@clankermux/core";
import { closeAllSseStreams } from "../../../sse-registry";
import {
	createPublicStreamHandler,
	PUBLIC_STREAM_MAX_CONNECTIONS,
	PUBLIC_STREAM_MAX_QUEUED_FRAMES,
	publicStreamConnectionCount,
	toPublicStreamEvent,
} from "../stream";
import { assertInstantsAreIso } from "./wire-contract";

/** Publish on the internal bus, exactly as the proxy does. */
function emit(evt: RequestEvt): void {
	requestEvents.emit("event", evt);
}

/** Read SSE frames until `count` `data:` lines have arrived (or the stream ends). */
async function readFrames(res: Response, count: number): Promise<string[]> {
	const reader = res.body?.getReader();
	if (!reader) throw new Error("no body");
	const decoder = new TextDecoder();
	const frames: string[] = [];
	let buffer = "";
	while (frames.length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let index = buffer.indexOf("\n\n");
		while (index !== -1) {
			frames.push(buffer.slice(0, index));
			buffer = buffer.slice(index + 2);
			if (frames.length >= count) break;
			index = buffer.indexOf("\n\n");
		}
	}
	await reader.cancel().catch(() => {});
	return frames;
}

function dataOf(frame: string): Record<string, unknown> | null {
	const line = frame.split("\n").find((l) => l.startsWith("data: "));
	if (!line) return null;
	const body = line.slice(6);
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

afterEach(() => {
	// Closing the streams detaches their listeners; the module's own registry
	// listener must survive, so `removeAllListeners` is deliberately not used.
	closeAllSseStreams();
	resetRequestEventRegistry();
});

describe("connect handshake", () => {
	it("sends the snapshot unconditionally, even when nothing is in flight", async () => {
		const res = createPublicStreamHandler(60_000)(
			new Request("http://localhost/public/v1/stream"),
		);
		const frames = await readFrames(res, 2);
		expect(frames[0]).toContain("event: connected");
		const snapshot = dataOf(frames[1] ?? "");
		expect(snapshot?.type).toBe("active.snapshot");
		// An EMPTY snapshot is meaningful: it retracts rows the device still
		// holds from before a reconnect.
		expect(snapshot?.active).toEqual([]);
	});

	it("carries the schema on the snapshot so a device can pin the contract", async () => {
		const res = createPublicStreamHandler(60_000)(
			new Request("http://localhost/public/v1/stream"),
		);
		const frames = await readFrames(res, 2);
		expect(dataOf(frames[1] ?? "")?.schema).toBe("clankermux.public.stream.v1");
	});

	it("SUBSCRIBES BEFORE it builds the snapshot", async () => {
		// The whole point. Both orders produce a snapshot frame, so a test that
		// only checked "a snapshot arrives" passes against the broken one. What
		// distinguishes them is whether the listener was already attached at the
		// moment the replay was READ — with the reverse order a request that
		// settles in that window is in neither the snapshot nor the stream, and
		// the client holds it as pending until its lost-timeout.
		const before = requestEvents.listenerCount("event");
		let listenersWhenReplayRead = -1;

		const res = createPublicStreamHandler(60_000, Date.now, () => {
			listenersWhenReplayRead = requestEvents.listenerCount("event");
			return [];
		})(new Request("http://localhost/public/v1/stream"));
		const frames = await readFrames(res, 2);

		expect(dataOf(frames[1] ?? "")?.type).toBe("active.snapshot");
		expect(listenersWhenReplayRead).toBe(before + 1);
	});

	it("replays what is in flight at connect time", async () => {
		emit({
			type: "ingress",
			id: "req-live",
			timestamp: 1_700_000_000_000,
			method: "POST",
			path: "/v1/messages",
			project: "clankermux",
			model: "claude-opus-5",
		});
		const res = createPublicStreamHandler(60_000)(
			new Request("http://localhost/public/v1/stream"),
		);
		const frames = await readFrames(res, 2);
		const snapshot = dataOf(frames[1] ?? "");
		expect(snapshot?.type).toBe("active.snapshot");
		expect(snapshot?.active).toEqual([
			{
				id: "req-live",
				startedAt: "2023-11-14T22:13:20.000Z",
				method: "POST",
				path: "/v1/messages",
				project: "clankermux",
				model: "claude-opus-5",
				phase: "pending",
				accountId: null,
				statusCode: null,
			},
		]);
	});
});

describe("the surface is unauthenticated, so it bounds itself", () => {
	function connect(handler: (req: Request) => Response): Response {
		return handler(new Request("http://localhost/public/v1/stream"));
	}

	it("refuses past the connection cap with 503 and Retry-After", async () => {
		// Every connection is a listener the proxy's own request traffic is
		// fanned out to, so the connection count multiplies the cost of ordinary
		// AI requests. Nothing else limits it: setMaxListeners only moves a
		// warning threshold.
		expect(publicStreamConnectionCount()).toBe(0);
		const handler = createPublicStreamHandler(60_000);
		const open: Response[] = [];
		for (let i = 0; i < PUBLIC_STREAM_MAX_CONNECTIONS; i++) {
			const res = connect(handler);
			expect(res.status).toBe(200);
			open.push(res);
		}
		expect(publicStreamConnectionCount()).toBe(PUBLIC_STREAM_MAX_CONNECTIONS);

		const refused = connect(handler);
		expect(refused.status).toBe(503);
		expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
		// A refused connection must not have installed anything.
		expect(publicStreamConnectionCount()).toBe(PUBLIC_STREAM_MAX_CONNECTIONS);

		// Teardown frees exactly one slot per connection. A double decrement here
		// would raise the effective cap for the life of the process.
		closeAllSseStreams();
		expect(publicStreamConnectionCount()).toBe(0);
		for (const res of open) {
			await res.body?.cancel().catch(() => {});
		}
		expect(publicStreamConnectionCount()).toBe(0);

		expect(connect(handler).status).toBe(200);
	});

	it("frees the slot and the listener when the client aborts", async () => {
		// An abort is how these connections normally END: the widget's device
		// sleeps, the tab closes, the panel restarts. If the slot leaked here the
		// 32-connection cap would become a permanent 503 on this lane after a day
		// of ordinary reconnects — the resource bound turning into the outage.
		const before = requestEvents.listenerCount("event");
		const aborter = new AbortController();
		const res = createPublicStreamHandler(60_000)(
			new Request("http://localhost/public/v1/stream", {
				signal: aborter.signal,
			}),
		);
		expect(publicStreamConnectionCount()).toBe(1);
		expect(requestEvents.listenerCount("event")).toBe(before + 1);

		aborter.abort();

		expect(publicStreamConnectionCount()).toBe(0);
		expect(requestEvents.listenerCount("event")).toBe(before);
		await res.body?.cancel().catch(() => {});
	});

	it("frees them EXACTLY ONCE when an aborted connection is also cancelled", async () => {
		// Every teardown path can run for the same connection, and they routinely
		// do: the body is cancelled and the request aborts. Releasing a slot twice
		// raises the effective cap for the life of the process; removing a listener
		// twice reaches into somebody else's connection. A second connection stays
		// open throughout so either would show.
		const before = requestEvents.listenerCount("event");
		const handler = createPublicStreamHandler(60_000);
		const aborter = new AbortController();
		const doomed = handler(
			new Request("http://localhost/public/v1/stream", {
				signal: aborter.signal,
			}),
		);
		const survivor = handler(new Request("http://localhost/public/v1/stream"));
		expect(publicStreamConnectionCount()).toBe(2);
		expect(requestEvents.listenerCount("event")).toBe(before + 2);

		// First teardown: the consumer goes away.
		await doomed.body?.cancel().catch(() => {});
		expect(publicStreamConnectionCount()).toBe(1);
		expect(requestEvents.listenerCount("event")).toBe(before + 1);

		// Second teardown for the SAME connection, arriving after it is gone.
		aborter.abort();
		expect(publicStreamConnectionCount()).toBe(1);
		expect(requestEvents.listenerCount("event")).toBe(before + 1);

		closeAllSseStreams();
		await survivor.body?.cancel().catch(() => {});
		expect(publicStreamConnectionCount()).toBe(0);
		expect(requestEvents.listenerCount("event")).toBe(before);
	});

	it("drops a consumer that has stopped reading", async () => {
		const before = requestEvents.listenerCount("event");
		const res = connect(createPublicStreamHandler(60_000));
		expect(requestEvents.listenerCount("event")).toBe(before + 1);
		expect(publicStreamConnectionCount()).toBe(1);

		// Nobody reads this stream. Frames accumulate on OUR heap, and every
		// proxied request adds one more.
		for (let i = 0; i < PUBLIC_STREAM_MAX_QUEUED_FRAMES * 2; i++) {
			emit({
				type: "ingress",
				id: `req-${i}`,
				timestamp: 1_700_000_000_000 + i,
				method: "POST",
				path: "/v1/messages",
				project: null,
				model: null,
			});
		}

		expect(requestEvents.listenerCount("event")).toBe(before);
		expect(publicStreamConnectionCount()).toBe(0);

		// The connection is finished, not merely detached: its body ends.
		const reader = res.body?.getReader();
		if (!reader) throw new Error("no body");
		let done = false;
		while (!done) {
			done = (await reader.read()).done;
		}
	});
});

describe("shutdown", () => {
	it("names the farewell event server-shutdown so the device skips its backoff", async () => {
		const res = createPublicStreamHandler(60_000)(
			new Request("http://localhost/public/v1/stream"),
		);
		const reader = res.body?.getReader();
		if (!reader) throw new Error("no body");
		const decoder = new TextDecoder();
		// Drain the handshake.
		await reader.read();
		closeAllSseStreams();
		let text = "";
		while (!text.includes("server-shutdown")) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		expect(text).toContain("event: server-shutdown");
		await reader.cancel().catch(() => {});
	});
});

describe("event translation", () => {
	it("never forwards the internal discriminator", () => {
		const internalTypes = [
			"snapshot",
			"ingress",
			"ingress-end",
			"start",
			"summary",
		];
		const mapped = [
			toPublicStreamEvent({ type: "snapshot", active: [] }, 0),
			toPublicStreamEvent(
				{
					type: "ingress",
					id: "a",
					timestamp: 1,
					method: "GET",
					path: "/p",
					project: null,
					model: null,
				},
				0,
			),
			toPublicStreamEvent({ type: "ingress-end", id: "a", statusCode: 400 }, 0),
			toPublicStreamEvent(
				{
					type: "start",
					id: "a",
					timestamp: 1,
					method: "GET",
					path: "/p",
					accountId: "acct",
					statusCode: 200,
					project: null,
					model: null,
				},
				0,
			),
		];
		for (const event of mapped) {
			expect(event).not.toBeNull();
			expect(internalTypes).not.toContain(event?.type ?? "");
		}
	});

	it("maps each internal event to its public name", () => {
		expect(toPublicStreamEvent({ type: "snapshot", active: [] }, 0)?.type).toBe(
			"active.snapshot",
		);
		expect(
			toPublicStreamEvent(
				{
					type: "ingress",
					id: "a",
					timestamp: 1,
					method: "GET",
					path: "/p",
					project: null,
					model: null,
				},
				0,
			)?.type,
		).toBe("request.opened");
		expect(
			toPublicStreamEvent({ type: "ingress-end", id: "a", statusCode: null }, 0)
				?.type,
		).toBe("request.dropped");
		expect(
			toPublicStreamEvent(
				{
					type: "start",
					id: "a",
					timestamp: 1,
					method: "GET",
					path: "/p",
					accountId: null,
					statusCode: 200,
					project: null,
					model: null,
				},
				0,
			)?.type,
		).toBe("request.upstream");
	});

	it("drops an event this surface does not carry rather than forwarding it raw", () => {
		expect(
			toPublicStreamEvent(
				// biome-ignore lint/suspicious/noExplicitAny: modelling a future bus event
				{ type: "something-new", secret: "leak" } as any,
				0,
			),
		).toBeNull();
	});

	it("does NOT give the discriminator an `other` member", () => {
		// The `other` convention on this surface is for DESCRIPTIVE enums, where
		// an unrecognized value still has to be rendered. A discriminator is not
		// one: an `other` event would be a record with no fields a client could
		// read. An event we do not carry is simply not emitted, and a client
		// ignores what it does not recognize.
		const unknown = toPublicStreamEvent(
			// biome-ignore lint/suspicious/noExplicitAny: modelling a future bus event
			{ type: "something-new" } as any,
			0,
		);
		expect(unknown).toBeNull();
		expect(JSON.stringify(unknown)).not.toContain("other");
	});

	it("emits every instant as an ISO string and no duration as one", () => {
		const events = [
			toPublicStreamEvent(
				{
					type: "snapshot",
					active: [
						{
							id: "a",
							timestamp: 1_700_000_000_000,
							method: "GET",
							path: "/p",
							project: null,
							model: null,
							phase: "pending",
							accountId: null,
							statusCode: null,
						},
					],
				},
				1_700_000_000_000,
			),
			toPublicStreamEvent(
				{
					type: "ingress",
					id: "a",
					timestamp: 1_700_000_000_000,
					method: "GET",
					path: "/p",
					project: null,
					model: null,
				},
				0,
			),
			toPublicStreamEvent(
				{
					type: "start",
					id: "a",
					timestamp: 1_700_000_000_000,
					method: "GET",
					path: "/p",
					accountId: null,
					statusCode: 200,
					project: null,
					model: null,
				},
				0,
			),
			toPublicStreamEvent(
				{
					type: "summary",
					payload: {
						id: "a",
						timestamp: new Date(1_700_000_000_000).toISOString(),
						method: "GET",
						path: "/p",
						accountUsed: null,
						statusCode: 200,
						success: true,
						errorMessage: null,
						responseTimeMs: 1_234,
						failoverAttempts: 0,
					},
				},
				0,
			),
		];
		for (const event of events) {
			assertInstantsAreIso(event);
		}
		// `responseTimeMs` is a DURATION and stays a number.
		const done = events[3] as { responseTimeMs?: unknown } | null;
		expect(typeof done?.responseTimeMs).toBe("number");
	});

	it("keeps project and model — full DATA parity with the internal lane", () => {
		const event = toPublicStreamEvent(
			{
				type: "ingress",
				id: "a",
				timestamp: 5,
				method: "POST",
				path: "/v1/messages",
				project: "clankermux",
				model: "claude-opus-5",
			},
			0,
		);
		expect(event).toEqual({
			type: "request.opened",
			id: "a",
			at: "1970-01-01T00:00:00.005Z",
			method: "POST",
			path: "/v1/messages",
			project: "clankermux",
			model: "claude-opus-5",
		});
	});

	it("uses accountId on every event that names an account", () => {
		const start = toPublicStreamEvent(
			{
				type: "start",
				id: "a",
				timestamp: 1,
				method: "GET",
				path: "/p",
				accountId: "acct-1",
				statusCode: 200,
				project: null,
				model: null,
			},
			0,
		);
		const done = toPublicStreamEvent(
			{
				type: "summary",
				payload: {
					id: "a",
					timestamp: new Date(1).toISOString(),
					method: "GET",
					path: "/p",
					accountUsed: "acct-1",
					statusCode: 200,
					success: true,
					errorMessage: null,
					responseTimeMs: 1,
					failoverAttempts: 0,
				},
			},
			0,
		);
		expect(start && "accountId" in start).toBe(true);
		expect(done && "accountId" in done).toBe(true);
		expect(JSON.stringify(done)).not.toContain("accountUsed");
	});
});

describe("live events reach the wire", () => {
	it("forwards an event emitted after connect", async () => {
		const res = createPublicStreamHandler(60_000)(
			new Request("http://localhost/public/v1/stream"),
		);
		const reader = res.body?.getReader();
		if (!reader) throw new Error("no body");
		const decoder = new TextDecoder();
		// connected + snapshot
		await reader.read();

		emit({
			type: "ingress",
			id: "req-later",
			timestamp: 1_700_000_000_001,
			method: "POST",
			path: "/v1/messages",
			project: null,
			model: null,
		});

		let text = "";
		while (!text.includes("request.opened")) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		expect(text).toContain("req-later");
		await reader.cancel().catch(() => {});
	});
});
