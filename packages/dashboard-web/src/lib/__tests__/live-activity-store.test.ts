import { describe, expect, it } from "bun:test";
import type { RequestResponse } from "@clankermux/types";
import { LiveActivityStore, PUBLISH_INTERVAL_MS } from "../live-activity-store";

const WINDOW = 180_000;
const T0 = 1_700_000_000_000;

function makeStore(now: () => number = () => T0) {
	return new LiveActivityStore(WINDOW, {}, now);
}

/** Wait past the coalescing window so a publish has definitely landed. */
const settle = () =>
	new Promise((resolve) => setTimeout(resolve, PUBLISH_INTERVAL_MS + 20));

function row(over: Partial<RequestResponse> = {}): RequestResponse {
	return {
		id: "r1",
		timestamp: new Date(T0).toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acct-1",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 100,
		failoverAttempts: 0,
		totalTokens: 100,
		project: "clankermux",
		...over,
	};
}

describe("LiveActivityStore publishing", () => {
	it("starts empty and unprimed", () => {
		const store = makeStore();
		expect(store.getSnapshot()).toMatchObject({
			events: [],
			primed: false,
			connected: false,
		});
	});

	it("coalesces a burst into a single notification", async () => {
		// One React render per request would thrash the widget under load; the
		// lanes only need to repaint a few times a second.
		const store = makeStore();
		let notifications = 0;
		store.subscribe(() => {
			notifications++;
		});

		for (let i = 0; i < 25; i++) {
			store.applyEvent({
				type: "ingress",
				id: `r${i}`,
				timestamp: T0,
				method: "POST",
				path: "/v1/messages",
				project: "clankermux",
				model: null,
			});
		}
		expect(notifications).toBe(0); // nothing published synchronously

		await settle();
		expect(notifications).toBe(1);
		expect(store.getSnapshot().events).toHaveLength(25);
		store.dispose();
	});

	it("keeps snapshot identity stable when nothing changed", async () => {
		const store = makeStore();
		store.applyHistory([row()], false);
		await settle();

		const first = store.getSnapshot();
		store.tick();
		expect(store.getSnapshot()).toBe(first);
		store.dispose();
	});

	it("orders events by arrival time regardless of delivery order", async () => {
		const store = makeStore();
		store.applyHistory(
			[
				row({ id: "late", timestamp: new Date(T0 + 5000).toISOString() }),
				row({ id: "early", timestamp: new Date(T0).toISOString() }),
			],
			false,
		);
		await settle();

		expect(store.getSnapshot().events.map((e) => e.id)).toEqual([
			"early",
			"late",
		]);
		store.dispose();
	});
});

describe("LiveActivityStore priming and the history edge", () => {
	it("primes on a connect-time snapshot even when nothing is in flight", async () => {
		const store = makeStore();
		store.applyEvent({ type: "snapshot", active: [] });
		await settle();

		expect(store.getSnapshot().primed).toBe(true);
		store.dispose();
	});

	it("records a history edge only when the backfill came back saturated", async () => {
		// A short page means the history really IS complete; hatching the left
		// edge then would claim missing data that does not exist.
		const short = makeStore();
		short.applyHistory([row()], false);
		await settle();
		expect(short.getSnapshot().historyEdge).toBeNull();
		short.dispose();

		const saturated = makeStore();
		saturated.applyHistory(
			[
				row({ id: "a", timestamp: new Date(T0 + 10).toISOString() }),
				row({ id: "b" }),
			],
			true,
		);
		await settle();
		expect(saturated.getSnapshot().historyEdge).toBe(T0);
		saturated.dispose();
	});
});

describe("LiveActivityStore outage bookkeeping", () => {
	it("remembers when the connection dropped, across the reconnect", async () => {
		// The reader needs to know WHICH stretch of the timeline is unknown
		// after the connection comes back — otherwise the gap reads as a quiet
		// period rather than as missing history.
		let now = T0;
		const store = makeStore(() => now);

		store.setConnected(true);
		await settle();
		now = T0 + 10_000;
		store.setConnected(false);
		await settle();

		expect(store.getSnapshot().disconnectedSince).toBe(T0 + 10_000);

		now = T0 + 20_000;
		store.setConnected(true);
		await settle();

		expect(store.getSnapshot().connected).toBe(true);
		expect(store.getSnapshot().disconnectedSince).toBe(T0 + 10_000);
		store.dispose();
	});

	it("forgets the outage once it scrolls out of the window", async () => {
		let now = T0;
		const store = makeStore(() => now);

		store.setConnected(true);
		store.setConnected(false);
		now = T0 + 1000;
		store.setConnected(true);
		await settle();
		expect(store.getSnapshot().disconnectedSince).toBe(T0);

		now = T0 + WINDOW + 5000;
		store.tick();
		await settle();

		expect(store.getSnapshot().disconnectedSince).toBeNull();
		store.dispose();
	});

	it("does not republish for a redundant connection-state set", async () => {
		const store = makeStore();
		store.setConnected(true);
		await settle();

		let notifications = 0;
		store.subscribe(() => {
			notifications++;
		});
		store.setConnected(true);
		await settle();

		expect(notifications).toBe(0);
		store.dispose();
	});
});

describe("LiveActivityStore housekeeping", () => {
	it("ages completed work out of the window on tick", async () => {
		let now = T0;
		const store = makeStore(() => now);
		store.applyHistory([row()], false);
		await settle();
		expect(store.getSnapshot().events).toHaveLength(1);

		now = T0 + WINDOW + 1000;
		store.tick();
		await settle();

		expect(store.getSnapshot().events).toHaveLength(0);
		store.dispose();
	});

	it("stops publishing after dispose", async () => {
		const store = makeStore();
		let notifications = 0;
		store.subscribe(() => {
			notifications++;
		});
		store.dispose();

		store.applyHistory([row()], false);
		await settle();

		expect(notifications).toBe(0);
	});
});
