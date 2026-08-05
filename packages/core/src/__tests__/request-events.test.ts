import { beforeEach, describe, expect, it } from "bun:test";
import {
	ACTIVE_REQUEST_MAX_ENTRIES,
	ACTIVE_REQUEST_TTL_MS,
	getActiveRequests,
	hasRequestStarted,
	requestEvents,
	resetRequestEventRegistry,
} from "../request-events";

/**
 * The active-request registry is the ONLY source for requests that are in
 * flight right now: the DB row is not written until the request completes, so
 * a dashboard connecting mid-stream can learn about live work from nowhere
 * else. These tests pin the phase transitions, the settle/evict rules, and the
 * `hasRequestStarted` predicate that `handleProxy` uses to decide whether a
 * request needs a synthetic terminal.
 */

function ingress(id: string, over: Record<string, unknown> = {}) {
	requestEvents.emit("event", {
		type: "ingress",
		id,
		timestamp: 1_000,
		method: "POST",
		path: "/v1/messages",
		project: "clankermux",
		model: "claude-opus-5",
		...over,
	});
}

function start(id: string, over: Record<string, unknown> = {}) {
	requestEvents.emit("event", {
		type: "start",
		id,
		timestamp: 1_000,
		method: "POST",
		path: "/v1/messages",
		accountId: "acct-1",
		statusCode: 200,
		project: "clankermux",
		model: "claude-opus-5",
		...over,
	});
}

function summary(id: string) {
	requestEvents.emit("event", {
		type: "summary",
		// Only `id` is read by the registry; the rest of RequestResponse is
		// irrelevant to it and is exercised by the dashboard reducer tests.
		payload: { id } as never,
	});
}

function ingressEnd(id: string, statusCode = 400) {
	requestEvents.emit("event", { type: "ingress-end", id, statusCode });
}

describe("active-request registry", () => {
	beforeEach(() => {
		resetRequestEventRegistry();
	});

	it("records an ingress as a pending request carrying project and model", () => {
		ingress("req-1");

		expect(getActiveRequests()).toEqual([
			{
				id: "req-1",
				timestamp: 1_000,
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

	it("promotes pending to streaming on start and fills in the account", () => {
		ingress("req-1");
		start("req-1", { accountId: "acct-9", statusCode: 200 });

		const [entry] = getActiveRequests();
		expect(entry.phase).toBe("streaming");
		expect(entry.accountId).toBe("acct-9");
		expect(entry.statusCode).toBe(200);
		// The ingress-time timestamp is kept: it is when the client's request
		// actually arrived, which is where the mark belongs on the time axis.
		expect(entry.timestamp).toBe(1_000);
	});

	it("upserts a start with no preceding ingress", () => {
		// Internal dispatch and any path where the ingress emit was gated still
		// reaches forwardToClient, so `start` must be able to create the entry.
		start("req-solo", { timestamp: 5_000 });

		const [entry] = getActiveRequests();
		expect(entry.id).toBe("req-solo");
		expect(entry.phase).toBe("streaming");
		expect(entry.timestamp).toBe(5_000);
	});

	it("does not let a late ingress revert a streaming request to pending", () => {
		start("req-1");
		ingress("req-1");

		expect(getActiveRequests()[0].phase).toBe("streaming");
	});

	it("drops the entry on summary", () => {
		ingress("req-1");
		start("req-1");
		summary("req-1");

		expect(getActiveRequests()).toEqual([]);
	});

	it("drops the entry on ingress-end", () => {
		ingress("req-1");
		ingressEnd("req-1", 400);

		expect(getActiveRequests()).toEqual([]);
	});

	it("reports whether a request ever reached forwardToClient", () => {
		ingress("req-pending");
		ingress("req-started");
		start("req-started");

		expect(hasRequestStarted("req-pending")).toBe(false);
		expect(hasRequestStarted("req-started")).toBe(true);
		expect(hasRequestStarted("never-seen")).toBe(false);
	});

	it("keeps hasRequestStarted true after the request settles", () => {
		// handleProxy's `finally` can run AFTER a non-streaming response has
		// already been summarized. If settling erased the started-marker it
		// would emit a spurious ingress-end for a request that completed fine.
		start("req-1");
		summary("req-1");

		expect(getActiveRequests()).toEqual([]);
		expect(hasRequestStarted("req-1")).toBe(true);
	});

	it("evicts the oldest entries past the cap so a burst cannot grow unbounded", () => {
		for (let i = 0; i < ACTIVE_REQUEST_MAX_ENTRIES + 10; i++) {
			ingress(`req-${i}`, { timestamp: 1_000 + i });
		}

		const active = getActiveRequests();
		expect(active.length).toBe(ACTIVE_REQUEST_MAX_ENTRIES);
		// The ten oldest were dropped, the newest survive.
		expect(active.some((e) => e.id === "req-0")).toBe(false);
		expect(
			active.some((e) => e.id === `req-${ACTIVE_REQUEST_MAX_ENTRIES + 9}`),
		).toBe(true);
	});

	it("expires entries older than the TTL rather than pinning them forever", () => {
		// A request whose terminal never arrives (client abort mid-dispatch,
		// crash) must not sit in the registry for the life of the process and
		// keep being replayed to every new dashboard connection.
		let now = 10_000;
		const clock = () => now;
		resetRequestEventRegistry(clock);

		ingress("stale", { timestamp: now });
		now += ACTIVE_REQUEST_TTL_MS + 1;
		ingress("fresh", { timestamp: now });

		const ids = getActiveRequests().map((e) => e.id);
		expect(ids).toEqual(["fresh"]);
	});

	it("ignores a summary or ingress-end for an unknown id", () => {
		expect(() => summary("nope")).not.toThrow();
		expect(() => ingressEnd("nope")).not.toThrow();
		expect(getActiveRequests()).toEqual([]);
	});
});
