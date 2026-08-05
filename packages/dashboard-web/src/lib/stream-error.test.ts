import { describe, expect, it } from "bun:test";
import {
	handleStreamError,
	MAX_RETRIES,
	reconnectDelayMs,
} from "./stream-error";

function fakeConnection() {
	let closed = 0;
	return {
		close: () => {
			closed++;
		},
		get closedCount() {
			return closed;
		},
	};
}

/** Minimal stand-in for the owner's tracked-connection state. */
function makeOwner(connection: { close(): void } | null) {
	let released = 0;
	return {
		current: connection,
		release: () => {
			released++;
		},
		get releasedCount() {
			return released;
		},
	};
}

describe("handleStreamError", () => {
	it("closes the errored connection, releases it, and schedules one reconnect", () => {
		const es = fakeConnection();
		const owner = makeOwner(es);
		const reconnects: Array<{ next: number; delay: number }> = [];

		const outcome = handleStreamError(es, {
			current: owner.current,
			release: owner.release,
			mounted: true,
			retryCount: 0,
			scheduleReconnect: (next, delay) => reconnects.push({ next, delay }),
		});

		expect(outcome).toBe("reconnect");
		expect(es.closedCount).toBe(1);
		expect(owner.releasedCount).toBe(1);
		expect(reconnects).toEqual([{ next: 1, delay: 1000 }]);
	});

	it("applies exponential backoff capped at 30s", () => {
		const es = fakeConnection();
		const owner = makeOwner(es);
		const delays: number[] = [];

		handleStreamError(es, {
			current: owner.current,
			release: owner.release,
			mounted: true,
			retryCount: 9,
			scheduleReconnect: (_next, delay) => delays.push(delay),
		});

		expect(delays).toEqual([30000]);
	});

	it("stale zombie error: closes the zombie but does NOT release the live connection or reconnect", () => {
		// An error can fire late for an instance already replaced during a
		// reconnect; acting on it would tear down the healthy replacement.
		const zombie = fakeConnection();
		const live = fakeConnection();
		const owner = makeOwner(live);
		const reconnects: number[] = [];

		const outcome = handleStreamError(zombie, {
			current: owner.current,
			release: owner.release,
			mounted: true,
			retryCount: 0,
			scheduleReconnect: (next) => reconnects.push(next),
		});

		expect(outcome).toBe("stale");
		expect(zombie.closedCount).toBe(1);
		expect(live.closedCount).toBe(0);
		expect(owner.releasedCount).toBe(0);
		expect(reconnects).toEqual([]);
	});

	it("no tracked connection counts as stale: close only, no reconnect", () => {
		const es = fakeConnection();
		const owner = makeOwner(null);

		const outcome = handleStreamError(es, {
			current: owner.current,
			release: owner.release,
			mounted: true,
			retryCount: 0,
			scheduleReconnect: () => {
				throw new Error("must not reconnect");
			},
		});

		expect(outcome).toBe("stale");
		expect(es.closedCount).toBe(1);
		expect(owner.releasedCount).toBe(0);
	});

	it("does not reconnect when unmounted", () => {
		const es = fakeConnection();
		const owner = makeOwner(es);

		const outcome = handleStreamError(es, {
			current: owner.current,
			release: owner.release,
			mounted: false,
			retryCount: 0,
			scheduleReconnect: () => {
				throw new Error("must not reconnect");
			},
		});

		expect(outcome).toBe("unmounted");
		expect(es.closedCount).toBe(1);
		// Released even when unmounted: the connection is dead either way.
		expect(owner.releasedCount).toBe(1);
	});

	it("gives up after MAX_RETRIES", () => {
		const es = fakeConnection();
		const owner = makeOwner(es);

		const outcome = handleStreamError(es, {
			current: owner.current,
			release: owner.release,
			mounted: true,
			retryCount: MAX_RETRIES,
			scheduleReconnect: () => {
				throw new Error("must not reconnect");
			},
		});

		expect(outcome).toBe("gave-up");
		expect(es.closedCount).toBe(1);
		expect(owner.releasedCount).toBe(1);
	});
});

describe("reconnectDelayMs", () => {
	it("doubles per attempt from 1s and caps at 30s", () => {
		expect(reconnectDelayMs(0)).toBe(1000);
		expect(reconnectDelayMs(1)).toBe(2000);
		expect(reconnectDelayMs(4)).toBe(16000);
		expect(reconnectDelayMs(20)).toBe(30000);
	});
});
