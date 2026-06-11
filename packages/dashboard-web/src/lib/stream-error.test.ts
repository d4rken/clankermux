import { describe, expect, it } from "bun:test";
import { handleStreamError, MAX_RETRIES } from "./stream-error";

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

function makePool(connection: { close(): void }) {
	const heartbeat = setInterval(() => {}, 60_000);
	const pool = new Map<
		string,
		{ connection: { close(): void }; heartbeat: ReturnType<typeof setInterval> }
	>();
	pool.set("key", { connection, heartbeat });
	return { pool, heartbeat };
}

describe("handleStreamError", () => {
	it("closes the errored connection, removes the pool entry, and schedules one reconnect", () => {
		const es = fakeConnection();
		const { pool, heartbeat } = makePool(es);
		const reconnects: Array<{ next: number; delay: number }> = [];

		const outcome = handleStreamError(es, pool, "key", {
			mounted: true,
			retryCount: 0,
			scheduleReconnect: (next, delay) => reconnects.push({ next, delay }),
		});

		expect(outcome).toBe("reconnect");
		expect(es.closedCount).toBe(1);
		expect(pool.has("key")).toBe(false);
		expect(reconnects).toEqual([{ next: 1, delay: 1000 }]);
		clearInterval(heartbeat);
	});

	it("applies exponential backoff capped at 30s", () => {
		const es = fakeConnection();
		const { pool, heartbeat } = makePool(es);
		const delays: number[] = [];

		handleStreamError(es, pool, "key", {
			mounted: true,
			retryCount: 9,
			scheduleReconnect: (_next, delay) => delays.push(delay),
		});

		expect(delays).toEqual([30000]);
		clearInterval(heartbeat);
	});

	it("stale zombie error: closes the zombie but does NOT touch the pool or reconnect", () => {
		const zombie = fakeConnection();
		const live = fakeConnection();
		const { pool, heartbeat } = makePool(live);
		const reconnects: number[] = [];

		const outcome = handleStreamError(zombie, pool, "key", {
			mounted: true,
			retryCount: 0,
			scheduleReconnect: (next) => reconnects.push(next),
		});

		expect(outcome).toBe("stale");
		expect(zombie.closedCount).toBe(1);
		expect(live.closedCount).toBe(0);
		// Live pool entry untouched
		expect(pool.get("key")?.connection).toBe(live);
		expect(reconnects).toEqual([]);
		clearInterval(heartbeat);
	});

	it("missing pool entry counts as stale: close only, no reconnect", () => {
		const es = fakeConnection();
		const pool = new Map<
			string,
			{
				connection: { close(): void };
				heartbeat: ReturnType<typeof setInterval>;
			}
		>();

		const outcome = handleStreamError(es, pool, "key", {
			mounted: true,
			retryCount: 0,
			scheduleReconnect: () => {
				throw new Error("must not reconnect");
			},
		});

		expect(outcome).toBe("stale");
		expect(es.closedCount).toBe(1);
	});

	it("does not reconnect when unmounted", () => {
		const es = fakeConnection();
		const { pool, heartbeat } = makePool(es);

		const outcome = handleStreamError(es, pool, "key", {
			mounted: false,
			retryCount: 0,
			scheduleReconnect: () => {
				throw new Error("must not reconnect");
			},
		});

		expect(outcome).toBe("unmounted");
		expect(es.closedCount).toBe(1);
		expect(pool.has("key")).toBe(false);
		clearInterval(heartbeat);
	});

	it("gives up after MAX_RETRIES", () => {
		const es = fakeConnection();
		const { pool, heartbeat } = makePool(es);

		const outcome = handleStreamError(es, pool, "key", {
			mounted: true,
			retryCount: MAX_RETRIES,
			scheduleReconnect: () => {
				throw new Error("must not reconnect");
			},
		});

		expect(outcome).toBe("gave-up");
		expect(es.closedCount).toBe(1);
		expect(pool.has("key")).toBe(false);
		clearInterval(heartbeat);
	});
});
