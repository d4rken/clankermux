/**
 * Unit tests for the main-thread payload-write controller.
 *
 * Everything the client owns that is timing- or transport-dependent is
 * injected — the fake fleet below stands in for real Workers and a fake clock
 * drives the retry backoff, rotation deadline and no-progress watchdog. No real
 * thread, no database. The real Worker path is covered by the cross-thread
 * integration test.
 */
import { describe, expect, test } from "bun:test";
import {
	PAYLOAD_NO_PROGRESS_FENCE_MS,
	PAYLOAD_NO_PROGRESS_UNHEALTHY_MS,
	PAYLOAD_READY_TIMEOUT_MS,
	PAYLOAD_ROTATION_DEADLINE_MS,
	type PayloadEntryInput,
	type PayloadSettlement,
	PayloadWriteClient,
	type PayloadWriteTransport,
} from "../payload-write-client";
import type {
	PayloadWriteAck,
	PayloadWriteRequest,
	PayloadWriteResponse,
	PayloadWriteRowMessage,
} from "../payload-write-worker";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class FakeClock {
	current = 1_000_000;
	private seq = 1;
	private timers = new Map<number, { fireAt: number; cb: () => void }>();

	now = (): number => this.current;

	setTimer = (cb: () => void, ms: number): unknown => {
		const id = this.seq++;
		this.timers.set(id, { fireAt: this.current + ms, cb });
		return id;
	};

	clearTimer = (handle: unknown): void => {
		this.timers.delete(handle as number);
	};

	/** Advance the clock, firing due timers in due-time order. */
	advance(ms: number): void {
		const target = this.current + ms;
		for (;;) {
			let nextId: number | null = null;
			let nextAt = Number.POSITIVE_INFINITY;
			for (const [id, timer] of this.timers) {
				if (timer.fireAt <= target && timer.fireAt < nextAt) {
					nextAt = timer.fireAt;
					nextId = id;
				}
			}
			if (nextId === null) break;
			const timer = this.timers.get(nextId);
			if (!timer) break;
			this.timers.delete(nextId);
			this.current = timer.fireAt;
			timer.cb();
		}
		this.current = target;
	}
}

class FakeWorker {
	readonly sent: PayloadWriteRequest[] = [];
	terminated = false;
	postThrows = false;
	private messageHandler: ((m: PayloadWriteResponse) => void) | null = null;
	private errorHandler: ((detail: string) => void) | null = null;

	constructor(
		readonly generation: number,
		private readonly events: string[] = [],
	) {}

	readonly transport: PayloadWriteTransport = {
		postMessage: (message) => {
			if (this.postThrows) throw new Error("postMessage failed");
			if (message.type === "write") {
				this.events.push(`write:${this.generation}:${message.id}`);
			}
			this.sent.push(message);
		},
		onMessage: (handler) => {
			this.messageHandler = handler;
		},
		onError: (handler) => {
			this.errorHandler = handler;
		},
		terminate: () => {
			if (!this.terminated) this.events.push(`terminate:${this.generation}`);
			this.terminated = true;
		},
	};

	get writes(): PayloadWriteRowMessage[] {
		return this.sent.filter(
			(m): m is PayloadWriteRowMessage => m.type === "write",
		);
	}

	get closeRequested(): boolean {
		return this.sent.some((m) => m.type === "close");
	}

	respond(message: PayloadWriteResponse): void {
		this.messageHandler?.(message);
	}

	ready(): void {
		this.respond({ type: "ready", generation: this.generation });
	}

	closed(): void {
		this.respond({ type: "closed", generation: this.generation });
	}

	die(detail = "worker died"): void {
		this.errorHandler?.(detail);
	}

	/** Ack every write this worker has received (once) with the given status. */
	ackAll(
		status: "committed" | "failed" = "committed",
		errorClass?: PayloadWriteAck["errorClass"],
		generationOverride?: number,
	): void {
		const generation = generationOverride ?? this.generation;
		const results: PayloadWriteAck[] = this.writes.map((w) => ({
			seq: w.seq,
			id: w.id,
			status,
			errorClass,
		}));
		this.sent.length = 0;
		this.respond({ type: "ack", generation, results });
	}
}

class FakeFleet {
	readonly workers: FakeWorker[] = [];
	/** Ordered log of writes and terminations across every generation. */
	readonly events: string[] = [];
	spawnThrowsOnGeneration: number | null = null;

	spawn = (generation: number): PayloadWriteTransport => {
		if (this.spawnThrowsOnGeneration === generation) {
			throw new Error("spawn failed");
		}
		const worker = new FakeWorker(generation, this.events);
		this.workers.push(worker);
		return worker.transport;
	};

	get last(): FakeWorker {
		const worker = this.workers.at(-1);
		if (!worker) throw new Error("no worker spawned");
		return worker;
	}
}

interface Harness {
	client: PayloadWriteClient;
	fleet: FakeFleet;
	clock: FakeClock;
	settlements: PayloadSettlement[];
	retentionMs: { value: number };
	/** Let the client's internal promise chain settle. */
	tick: () => Promise<void>;
	/** Publish + let the spawn/flush chain settle. */
	publish: (overrides?: Partial<PayloadEntryInput>) => Promise<boolean>;
}

function makeHarness(options: { rotationByteBudget?: number } = {}): Harness {
	const clock = new FakeClock();
	const fleet = new FakeFleet();
	const settlements: PayloadSettlement[] = [];
	const retentionMs = { value: 24 * 60 * 60 * 1000 };
	const client = new PayloadWriteClient({
		dbPath: "/tmp/does-not-exist.db",
		getRetentionMs: () => retentionMs.value,
		onSettled: (s) => settlements.push(s),
		spawn: fleet.spawn,
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		rotationByteBudget: options.rotationByteBudget,
	});

	const tick = async (): Promise<void> => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	};

	let n = 0;
	const publish = async (
		overrides: Partial<PayloadEntryInput> = {},
	): Promise<boolean> => {
		n++;
		const entry: PayloadEntryInput = {
			requestId: `req-${n}`,
			ciphertext: `payload-${n}`,
			timestamp: clock.now(),
			transportBytes: 1024,
			payloadBytes: 900,
			...overrides,
		};
		const accepted = client.publish(entry);
		await tick();
		return accepted;
	};

	return { client, fleet, clock, settlements, retentionMs, tick, publish };
}

/** Spawn + ready the first generation and clear its initial write. */
async function primed(
	options: { rotationByteBudget?: number } = {},
): Promise<Harness> {
	const h = makeHarness(options);
	await h.publish();
	h.fleet.last.ready();
	await h.tick();
	return h;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PayloadWriteClient — publish and ack", () => {
	test("buffers until the first generation is ready, then sends", async () => {
		const h = makeHarness();
		expect(await h.publish()).toBe(true);
		// Spawned but not ready: only the init message has gone out.
		expect(h.fleet.workers).toHaveLength(1);
		expect(h.fleet.last.writes).toHaveLength(0);
		expect(h.fleet.last.sent[0]?.type).toBe("init");

		h.fleet.last.ready();
		await h.tick();
		expect(h.fleet.last.writes.map((w) => w.id)).toEqual(["req-1"]);

		h.fleet.last.ackAll("committed");
		expect(h.client.getStats().unackedEntries).toBe(0);
		expect(h.client.getStats().committed).toBe(1);
		await h.client.dispose(0);
	});

	test("an entry-permanent NACK settles as a drop and is counted", async () => {
		const h = await primed();
		h.fleet.workers[0].ackAll("failed", "entry-permanent");

		expect(h.settlements).toHaveLength(1);
		expect(h.settlements[0].outcome).toBe("dropped");
		expect(h.settlements[0].errorClass).toBe("entry-permanent");
		const stats = h.client.getStats();
		expect(stats.droppedPermanent).toBe(1);
		expect(stats.unackedEntries).toBe(0);
		expect(stats.healthy).toBe(true);
		await h.client.dispose(0);
	});

	test("a stale generation's ack cannot free a replayed entry", async () => {
		const h = await primed();
		const first = h.fleet.workers[0];
		expect(first.writes).toHaveLength(1);

		// Generation dies; the entry is replayed onto the replacement.
		first.die("crash");
		h.clock.advance(300);
		await h.tick();
		h.fleet.last.ready();
		await h.tick();
		const second = h.fleet.last;
		expect(second).not.toBe(first);
		expect(second.writes.map((w) => w.id)).toEqual(["req-1"]);

		// The dead generation's late ack (generation 1) must be ignored.
		first.respond({
			type: "ack",
			generation: first.generation,
			results: [{ seq: 1, id: "req-1", status: "committed" }],
		});
		expect(h.client.getStats().unackedEntries).toBe(1);
		expect(h.client.getStats().committed).toBe(0);

		// The replacement's ack settles it.
		second.ackAll("committed");
		expect(h.client.getStats().unackedEntries).toBe(0);
		await h.client.dispose(0);
	});
});

describe("PayloadWriteClient — retry", () => {
	test("a lone SQLITE_BUSY NACK still commits with no further traffic", async () => {
		const h = await primed();
		const worker = h.fleet.workers[0];
		worker.ackAll("failed", "retryable");

		// Entry retained, no immediate resend — the retry runs on its own timer.
		expect(h.client.getStats().unackedEntries).toBe(1);
		expect(worker.writes).toHaveLength(0);

		h.clock.advance(200);
		await h.tick();
		expect(worker.writes.map((w) => w.id)).toEqual(["req-1"]);

		worker.ackAll("committed");
		const stats = h.client.getStats();
		expect(stats.committed).toBe(1);
		expect(stats.retries).toBe(1);
		expect(stats.unackedEntries).toBe(0);
		await h.client.dispose(0);
	});

	test("retry backoff grows and the entry keeps its registry slot", async () => {
		const h = await primed();
		const worker = h.fleet.workers[0];

		worker.ackAll("failed", "retryable");
		h.clock.advance(100);
		await h.tick();
		expect(worker.writes).toHaveLength(1);

		worker.ackAll("failed", "retryable");
		// Second backoff is 200ms: nothing at 150ms…
		h.clock.advance(150);
		await h.tick();
		expect(worker.writes).toHaveLength(0);
		// …resent at 200ms.
		h.clock.advance(60);
		await h.tick();
		expect(worker.writes).toHaveLength(1);
		expect(h.client.getStats().unackedEntries).toBe(1);
		await h.client.dispose(0);
	});
});

describe("PayloadWriteClient — writer-fatal", () => {
	test("retains entries, suspends admission and reports unhealthy", async () => {
		const h = await primed();
		h.fleet.workers[0].ackAll("failed", "writer-fatal");

		const stats = h.client.getStats();
		expect(stats.unackedEntries).toBe(1); // RETAINED, never dropped
		expect(stats.droppedPermanent).toBe(0);
		expect(stats.writerFatal).not.toBeNull();
		expect(stats.admissionSuspended).toBe(true);
		expect(stats.healthy).toBe(false);
		expect(h.settlements).toHaveLength(0);

		// Admission is closed for new work.
		expect(h.client.acceptsWork()).toBe(false);
		expect(await h.publish()).toBe(false);
		await h.client.dispose(0);
	});
});

describe("PayloadWriteClient — rotation", () => {
	test("prewarms, cuts over only after the close-ack, and never has two active writers", async () => {
		// 1 KiB per entry, budget 2 KiB → rotation triggers on the 2nd send.
		const h = await primed({ rotationByteBudget: 2048 });
		const first = h.fleet.workers[0];
		first.ackAll("committed");

		await h.publish();
		await h.tick();
		// Budget reached: the replacement is prewarming, the outgoing worker has
		// NOT been asked to close yet and the replacement has received no writes.
		expect(h.fleet.workers).toHaveLength(2);
		const second = h.fleet.workers[1];
		expect(second.writes).toHaveLength(0);
		expect(first.closeRequested).toBe(false);

		// The outgoing worker keeps draining what it already has…
		expect(first.writes.map((w) => w.id)).toEqual(["req-2"]);
		first.ackAll("committed");
		// …while new traffic buffers instead of reaching either worker.
		await h.publish();
		expect(second.writes).toHaveLength(0);
		expect(first.writes).toHaveLength(0);

		second.ready();
		await h.tick();
		// Replacement ready → the outgoing worker is asked to close, and only
		// after its close-ack does the replacement take over.
		expect(first.closeRequested).toBe(true);
		expect(second.writes).toHaveLength(0);

		first.closed();
		await h.tick();
		expect(first.terminated).toBe(true);
		expect(second.writes.map((w) => w.id)).toEqual(["req-3"]);
		const stats = h.client.getStats();
		expect(stats.rotations).toBe(1);
		expect(stats.activeGeneration).toBe(second.generation);
		expect(stats.liveGenerations).toBe(1);
		await h.client.dispose(0);
	});

	test("terminates an outgoing worker that misses the rotation deadline", async () => {
		// Budget 1 KiB → the very first send trips rotation.
		const h = await primed({ rotationByteBudget: 1024 });
		const first = h.fleet.workers[0];
		expect(h.fleet.workers).toHaveLength(2);
		const second = h.fleet.workers[1];

		second.ready();
		await h.tick();
		expect(first.closeRequested).toBe(true);
		expect(first.terminated).toBe(false);

		h.clock.advance(PAYLOAD_ROTATION_DEADLINE_MS + 1);
		await h.tick();
		expect(first.terminated).toBe(true);
		// The unacked entry is replayed strictly AFTER the termination, so no
		// write can race the outgoing generation.
		expect(second.writes.map((w) => w.id)).toEqual(["req-1"]);
		expect(h.fleet.events.indexOf("terminate:1")).toBeLessThan(
			h.fleet.events.indexOf("write:2:req-1"),
		);
		expect(h.client.getStats().replays).toBeGreaterThanOrEqual(1);
		await h.client.dispose(0);
	});

	test("replayed bytes charge the receiving generation's budget", async () => {
		// Budget 2 KiB, 1 KiB per entry: two unacked entries fill generation 1…
		const h = await primed({ rotationByteBudget: 2048 });
		await h.publish();
		await h.tick();
		const second = h.fleet.workers[1];
		second.ready();
		await h.tick();
		h.fleet.workers[0].closed();
		await h.tick();

		// …and replaying both onto generation 2 charges it 2 KiB, so it is
		// immediately over budget and a third generation is prewarmed.
		await h.tick();
		expect(second.writes.map((w) => w.id)).toEqual(["req-1", "req-2"]);
		expect(h.fleet.workers).toHaveLength(3);
		await h.client.dispose(0);
	});

	test("a spawn failure rolls back: the outgoing generation keeps draining", async () => {
		const h = makeHarness({ rotationByteBudget: 1024 });
		await h.publish();
		const first = h.fleet.workers[0];
		// The replacement spawn fails when rotation tries to prewarm it.
		h.fleet.spawnThrowsOnGeneration = 2;
		first.ready();
		await h.tick();

		// Rotation could not prewarm: the outgoing worker stays active and was
		// never asked to close.
		expect(first.closeRequested).toBe(false);
		expect(first.terminated).toBe(false);
		expect(h.client.getStats().activeGeneration).toBe(first.generation);
		expect(h.client.getStats().spawnFailures).toBe(1);
		expect(h.client.acceptsWork()).toBe(true);

		// It still drains its in-flight entry.
		expect(first.writes.map((w) => w.id)).toEqual(["req-1"]);
		first.ackAll("committed");
		expect(h.client.getStats().committed).toBe(1);
		await h.client.dispose(0);
	});

	test("a generation that never reports ready is treated as a spawn failure", async () => {
		const h = makeHarness();
		await h.publish();
		expect(h.fleet.workers).toHaveLength(1);

		h.clock.advance(PAYLOAD_READY_TIMEOUT_MS + 1);
		await h.tick();
		expect(h.fleet.workers[0].terminated).toBe(true);
		expect(h.client.getStats().spawnFailures).toBe(1);

		// The backoff respawn picks it up and the buffered entry is delivered.
		h.clock.advance(300);
		await h.tick();
		expect(h.fleet.workers).toHaveLength(2);
		h.fleet.last.ready();
		await h.tick();
		expect(h.fleet.last.writes.map((w) => w.id)).toEqual(["req-1"]);
		await h.client.dispose(0);
	});
});

describe("PayloadWriteClient — replay expiry", () => {
	test("does not resurrect a payload deleted by retention (commit, ack lost)", async () => {
		const h = await primed();
		h.retentionMs.value = 5_000;

		// The commit landed but the ack was lost with the worker.
		h.fleet.workers[0].die("crash after commit");
		// Respawn, and by the time the replacement is ready retention has passed.
		h.clock.advance(300);
		await h.tick();
		h.clock.advance(6_000);
		h.fleet.last.ready();
		await h.tick();

		expect(h.fleet.last.writes).toHaveLength(0); // NOT replayed
		const stats = h.client.getStats();
		expect(stats.expired).toBe(1);
		expect(stats.droppedPermanent).toBe(0);
		expect(stats.unackedEntries).toBe(0);
		expect(h.settlements.map((s) => s.outcome)).toEqual(["expired"]);
		await h.client.dispose(0);
	});

	test("replays an entry that is still inside the retention window", async () => {
		const h = await primed();
		h.retentionMs.value = 60_000;
		h.fleet.workers[0].die("crash");
		h.clock.advance(300);
		await h.tick();
		h.clock.advance(5_000);
		h.fleet.last.ready();
		await h.tick();

		expect(h.fleet.last.writes.map((w) => w.id)).toEqual(["req-1"]);
		expect(h.client.getStats().expired).toBe(0);
		await h.client.dispose(0);
	});
});

describe("PayloadWriteClient — fenced no-progress watchdog", () => {
	test("suspends admission, then fences and replays after termination", async () => {
		const h = await primed();
		const stalled = h.fleet.workers[0];
		expect(stalled.writes).toHaveLength(1);

		// Alive but never acking.
		h.clock.advance(PAYLOAD_NO_PROGRESS_UNHEALTHY_MS + 1_000);
		let stats = h.client.getStats();
		expect(stats.healthy).toBe(false);
		expect(stats.admissionSuspended).toBe(true);
		expect(
			h.client.publish({
				requestId: "blocked",
				ciphertext: "x",
				timestamp: h.clock.now(),
				transportBytes: 1,
				payloadBytes: 1,
			}),
		).toBe(false);
		expect(stalled.terminated).toBe(false); // not yet fenced

		h.clock.advance(
			PAYLOAD_NO_PROGRESS_FENCE_MS - PAYLOAD_NO_PROGRESS_UNHEALTHY_MS - 1_000,
		);
		stats = h.client.getStats();
		expect(stats.fences).toBe(1);
		expect(stalled.terminated).toBe(true);
		// Fencing terminates FIRST — no replacement exists yet, so a fenced worker
		// can never be writing the same entry as its successor.
		expect(h.fleet.workers).toHaveLength(1);

		h.clock.advance(300);
		await h.tick();
		expect(h.fleet.workers).toHaveLength(2);
		h.fleet.last.ready();
		await h.tick();
		expect(h.fleet.last.writes.map((w) => w.id)).toEqual(["req-1"]);
		expect(h.fleet.events.indexOf("terminate:1")).toBeLessThan(
			h.fleet.events.indexOf("write:2:req-1"),
		);

		// A successful ack restores health and admission.
		h.fleet.last.ackAll("committed");
		stats = h.client.getStats();
		expect(stats.healthy).toBe(true);
		expect(stats.admissionSuspended).toBe(false);
		await h.client.dispose(0);
	});

	test("an idle writer is never considered stalled", async () => {
		const h = await primed();
		h.fleet.workers[0].ackAll("committed");
		h.clock.advance(PAYLOAD_NO_PROGRESS_FENCE_MS * 3);
		await h.tick();
		const stats = h.client.getStats();
		expect(stats.fences).toBe(0);
		expect(stats.healthy).toBe(true);
		expect(stats.admissionSuspended).toBe(false);
		await h.client.dispose(0);
	});
});

describe("PayloadWriteClient — lifecycle", () => {
	test("a spawn failure at the first publish keeps the entry and retries", async () => {
		const h = makeHarness();
		h.fleet.spawnThrowsOnGeneration = 1;
		expect(await h.publish()).toBe(true);
		expect(h.fleet.workers).toHaveLength(0);
		expect(h.client.getStats().spawnFailures).toBe(1);
		// The entry is retained, not dropped, and admission stays open.
		expect(h.client.getStats().unackedEntries).toBe(1);
		expect(h.client.acceptsWork()).toBe(true);

		// Backoff respawn succeeds and delivers the buffered entry.
		h.fleet.spawnThrowsOnGeneration = null;
		h.clock.advance(300);
		await h.tick();
		h.fleet.last.ready();
		await h.tick();
		expect(h.fleet.last.writes.map((w) => w.id)).toEqual(["req-1"]);
		await h.client.dispose(0);
	});

	test("dispose before the first publish spawns nothing", async () => {
		const h = makeHarness();
		await h.client.dispose(1000);
		expect(h.fleet.workers).toHaveLength(0);
		expect(h.client.getStats().disposed).toBe(true);
		expect(h.client.acceptsWork()).toBe(false);
	});

	test("dispose flushes buffered entries, awaits the close-ack and terminates", async () => {
		const h = await primed();
		const worker = h.fleet.workers[0];
		const disposal = h.client.dispose(5_000);
		await h.tick();
		expect(worker.closeRequested).toBe(true);

		worker.ackAll("committed");
		worker.closed();
		await disposal;
		expect(worker.terminated).toBe(true);
		const stats = h.client.getStats();
		expect(stats.committed).toBe(1);
		expect(stats.unackedEntries).toBe(0);
		expect(stats.liveGenerations).toBe(0);
	});

	test("dispose terminates on its deadline and abandons what never committed", async () => {
		const h = await primed();
		const worker = h.fleet.workers[0];
		const disposal = h.client.dispose(2_000);
		await h.tick();
		h.clock.advance(2_001);
		await disposal;

		expect(worker.terminated).toBe(true);
		const stats = h.client.getStats();
		expect(stats.abandoned).toBe(1);
		expect(stats.unackedEntries).toBe(0);
		expect(h.settlements.map((s) => s.outcome)).toEqual(["abandoned"]);
	});

	test("double dispose is idempotent and shares one promise", async () => {
		const h = await primed();
		const first = h.client.dispose(0);
		const second = h.client.dispose(0);
		expect(first).toBe(second);
		await first;
		await h.client.dispose(0);
		expect(h.fleet.workers.every((w) => w.terminated)).toBe(true);
	});

	test("publishing after dispose is rejected", async () => {
		const h = await primed();
		await h.client.dispose(0);
		expect(await h.publish()).toBe(false);
	});

	test("a throwing postMessage tears the generation down and replays", async () => {
		const h = await primed();
		const first = h.fleet.workers[0];
		first.ackAll("committed");
		first.postThrows = true;

		await h.publish();
		expect(first.terminated).toBe(true);
		h.clock.advance(300);
		await h.tick();
		h.fleet.last.ready();
		await h.tick();
		expect(h.fleet.last.writes.map((w) => w.id)).toEqual(["req-2"]);
		await h.client.dispose(0);
	});
});
