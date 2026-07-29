/**
 * Tests for AsyncDbWriter:
 *  - Metadata queue (enqueue path, cap, drain budget, dispose flush)
 *  - Payload reservation tokens: admission, idempotent release, exact-size
 *    reconciliation, per-entry maximum, ownership transfer on publish
 *  - Queued (reserved) vs in-flight (unacked) accounting and the health line
 *  - Writer-fatal / unhealthy surfacing through getHealth()
 *  - dispose() ordering: drain metadata, then flush the payload worker
 *
 * The payload writer itself is injected as a fake — AsyncDbWriter never writes
 * a payload on the main thread, so there is nothing to exercise with a real DB
 * here (see payload-write-client / cross-thread integration tests for that).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	AsyncDbWriter,
	type AsyncWriterHealth,
	MAX_PAYLOAD_ENTRY_BYTES,
	type PayloadReservation,
	shouldLogAsyncWriterHealth,
} from "../async-writer";
import type {
	PayloadEntryInput,
	PayloadSettlement,
	PayloadWriterLike,
	PayloadWriterStats,
} from "../payload-write-client";

const ONE_MB = 1024 * 1024;
const TEN_MB = 10 * ONE_MB;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Manually-controlled async gate — release() lets all awaiters proceed. */
function makeGate(): { wait: () => Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait: () => promise, release };
}

class FakeWriter implements PayloadWriterLike {
	published: PayloadEntryInput[] = [];
	accept = true;
	publishResult = true;
	publishThrows = false;
	disposed = 0;
	lastDisposeDeadline: number | undefined;
	stats: PayloadWriterStats = {
		unackedEntries: 0,
		unackedTransportBytes: 0,
		unackedPayloadBytes: 0,
		oldestUnackedAgeMs: 0,
		committed: 0,
		droppedPermanent: 0,
		expired: 0,
		abandoned: 0,
		retries: 0,
		replays: 0,
		rotations: 0,
		spawnFailures: 0,
		fences: 0,
		activeGeneration: 1,
		liveGenerations: 1,
		healthy: true,
		admissionSuspended: false,
		writerFatal: null,
		disposed: false,
	};

	constructor(readonly onSettled: (s: PayloadSettlement) => void) {}

	publish(entry: PayloadEntryInput): boolean {
		if (!this.accept) return false;
		return this.publishReserved(entry);
	}

	/** Mirrors the real client: only a disposed writer refuses a reservation. */
	publishReserved(entry: PayloadEntryInput): boolean {
		if (this.publishThrows) throw new Error("publish exploded");
		if (!this.publishResult) return false;
		this.published.push(entry);
		this.stats.unackedEntries++;
		return true;
	}

	acceptsWork(): boolean {
		return this.accept;
	}

	getStats(): PayloadWriterStats {
		return this.stats;
	}

	async dispose(deadlineMs?: number): Promise<void> {
		this.disposed++;
		this.lastDisposeDeadline = deadlineMs;
	}

	/** Settle the nth published entry with the given outcome. */
	settle(index: number, outcome: PayloadSettlement["outcome"]): void {
		const entry = this.published[index];
		this.stats.unackedEntries--;
		this.onSettled({
			requestId: entry.requestId,
			transportBytes: entry.transportBytes,
			payloadBytes: entry.payloadBytes,
			outcome,
		});
	}
}

function makeWriter(): { writer: AsyncDbWriter; fake: () => FakeWriter } {
	let fake: FakeWriter | null = null;
	const writer = new AsyncDbWriter({
		createPayloadWriter: (hooks) => {
			fake = new FakeWriter(hooks.onSettled);
			return fake;
		},
	});
	return {
		writer,
		fake: () => {
			if (!fake) throw new Error("payload writer was never created");
			return fake;
		},
	};
}

function publish(
	writer: AsyncDbWriter,
	reservation: PayloadReservation,
	id: string,
	ciphertext: string,
): boolean {
	return writer.enqueuePayload(reservation, {
		requestId: id,
		ciphertext,
		timestamp: Date.now(),
		payloadBytes: ciphertext.length,
	});
}

describe("AsyncDbWriter", () => {
	let writer: AsyncDbWriter | null = null;
	let releaseGate: (() => void) | null = null;

	afterEach(async () => {
		if (releaseGate) {
			releaseGate();
			releaseGate = null;
		}
		if (writer) {
			try {
				await writer.dispose();
			} catch {
				// ignore cleanup failures
			}
			writer = null;
		}
	});

	test("enqueue() runs the job and drains the queue", async () => {
		writer = new AsyncDbWriter();
		let counter = 0;
		writer.enqueue(() => {
			counter++;
		});

		await sleep(200);

		expect(counter).toBe(1);
		expect(writer.getHealth().queuedJobs).toBe(0);
	});

	test("metadata cap drops excess (METADATA_QUEUE_CAP = 2000)", async () => {
		writer = new AsyncDbWriter();

		const gate = makeGate();
		releaseGate = gate.release;

		writer.enqueue(async () => {
			await gate.wait();
		});
		for (let i = 1; i < 2100; i++) {
			writer.enqueue(() => {});
		}

		const h = writer.getHealth();
		expect(h.metadataQueuedJobs).toBeLessThanOrEqual(2000);
		expect(h.metadataDropped).toBeGreaterThanOrEqual(99);
	});

	test("no payload writer is spawned for an instance that never publishes", async () => {
		const harness = makeWriter();
		writer = harness.writer;
		writer.enqueue(() => {});
		await sleep(150);
		expect(() => harness.fake()).toThrow();
	});

	test("reservePayload admits up to the byte cap, then refuses", () => {
		const harness = makeWriter();
		writer = harness.writer;

		const held: PayloadReservation[] = [];
		for (let i = 0; i < 10; i++) {
			const reservation = writer.reservePayload(TEN_MB);
			expect(reservation).not.toBeNull();
			if (reservation) held.push(reservation);
		}
		// 100 MiB reserved: the next one has nowhere to go.
		expect(writer.reservePayload(TEN_MB)).toBeNull();
		expect(writer.canAcceptPayload(TEN_MB)).toBe(false);

		const h = writer.getHealth();
		expect(h.payloadQueuedJobs).toBe(10);
		expect(h.payloadBytesPending).toBe(100 * ONE_MB);

		// Releasing frees the budget again.
		held[0].release();
		expect(writer.canAcceptPayload(TEN_MB)).toBe(true);
		for (const reservation of held) reservation.release();
		expect(writer.getHealth().payloadBytesPending).toBe(0);
	});

	test("release() is idempotent", () => {
		const harness = makeWriter();
		writer = harness.writer;
		const reservation = writer.reservePayload(ONE_MB);
		if (!reservation) throw new Error("expected a reservation");

		reservation.release();
		reservation.release();
		reservation.release();
		expect(writer.getHealth().payloadBytesPending).toBe(0);
		expect(writer.getHealth().payloadQueuedJobs).toBe(0);
	});

	test("publishing transfers the reservation to in-flight accounting", () => {
		const harness = makeWriter();
		writer = harness.writer;
		// Estimate is deliberately wrong — the exact ciphertext size is what
		// gets charged (base64 expands the plaintext by ~1/3).
		const reservation = writer.reservePayload(300);
		if (!reservation) throw new Error("expected a reservation");
		const ciphertext = "e".repeat(400);
		expect(publish(writer, reservation, "req-1", ciphertext)).toBe(true);

		const h = writer.getHealth();
		expect(h.payloadQueuedJobs).toBe(0); // no longer reserved
		expect(h.payloadInFlightJobs).toBe(1);
		expect(h.payloadInFlightBytes).toBe(400); // exact, not the estimate
		expect(h.payloadBytesPending).toBe(400);
		expect(harness.fake().published[0].transportBytes).toBe(400);

		// A terminal outcome releases the in-flight bytes.
		harness.fake().settle(0, "committed");
		const after = writer.getHealth();
		expect(after.payloadInFlightJobs).toBe(0);
		expect(after.payloadInFlightBytes).toBe(0);
		expect(after.payloadCommitted).toBe(1);
	});

	test("a second publish on the same reservation is rejected", () => {
		const harness = makeWriter();
		writer = harness.writer;
		const reservation = writer.reservePayload(100);
		if (!reservation) throw new Error("expected a reservation");
		expect(publish(writer, reservation, "req-1", "abc")).toBe(true);
		expect(publish(writer, reservation, "req-1", "abc")).toBe(false);
		expect(harness.fake().published).toHaveLength(1);
	});

	test("an over-maximum payload is dropped and the reservation released", () => {
		const harness = makeWriter();
		writer = harness.writer;
		const reservation = writer.reservePayload(1000);
		if (!reservation) throw new Error("expected a reservation");
		const huge = "x".repeat(MAX_PAYLOAD_ENTRY_BYTES + 1);
		expect(publish(writer, reservation, "req-big", huge)).toBe(false);

		const h = writer.getHealth();
		expect(h.payloadBytesPending).toBe(0);
		expect(h.payloadDropped).toBe(1);
		expect(h.payloadDroppedBytes).toBe(MAX_PAYLOAD_ENTRY_BYTES + 1);
	});

	test("a refused publish releases the bytes and counts the drop", () => {
		const harness = makeWriter();
		writer = harness.writer;
		// Force the writer to exist, then make it refuse.
		const first = writer.reservePayload(10);
		if (!first) throw new Error("expected a reservation");
		publish(writer, first, "req-1", "abc");
		harness.fake().publishResult = false;

		const second = writer.reservePayload(10);
		if (!second) throw new Error("expected a reservation");
		expect(publish(writer, second, "req-2", "defg")).toBe(false);

		const h = writer.getHealth();
		expect(h.payloadInFlightJobs).toBe(1); // only the first
		expect(h.payloadDropped).toBe(1);
		expect(h.payloadDroppedBytes).toBe(4);
	});

	test("a throwing publish is contained and released", () => {
		const harness = makeWriter();
		writer = harness.writer;
		const first = writer.reservePayload(10);
		if (!first) throw new Error("expected a reservation");
		publish(writer, first, "req-1", "abc");
		harness.fake().publishThrows = true;

		const second = writer.reservePayload(10);
		if (!second) throw new Error("expected a reservation");
		expect(publish(writer, second, "req-2", "de")).toBe(false);
		expect(writer.getHealth().payloadInFlightBytes).toBe(3);
		expect(writer.getHealth().payloadDropped).toBe(1);
	});

	test("with no payload writer configured, publication is rejected and counted", () => {
		writer = new AsyncDbWriter();
		const reservation = writer.reservePayload(100);
		if (!reservation) throw new Error("expected a reservation");
		expect(publish(writer, reservation, "req-1", "abc")).toBe(false);
		expect(writer.getHealth().payloadDropped).toBe(1);
		expect(writer.getHealth().payloadBytesPending).toBe(0);
	});

	test("recordPayloadDrop increments the health counters", () => {
		writer = new AsyncDbWriter();

		const before = writer.getHealth();
		expect(before.payloadDropped).toBe(0);
		expect(before.payloadDroppedBytes).toBe(0);

		writer.recordPayloadDrop(1234);
		writer.recordPayloadDrop(5678);

		const after = writer.getHealth();
		expect(after.payloadDropped).toBe(2);
		expect(after.payloadDroppedBytes).toBe(1234 + 5678);
	});

	test("settlement outcomes are counted apart from each other", () => {
		const harness = makeWriter();
		writer = harness.writer;
		for (const [i, outcome] of (
			["committed", "dropped", "expired", "abandoned"] as const
		).entries()) {
			const reservation = writer.reservePayload(10);
			if (!reservation) throw new Error("expected a reservation");
			publish(writer, reservation, `req-${i}`, "abcd");
			harness.fake().settle(i, outcome);
		}

		const h = writer.getHealth();
		expect(h.payloadCommitted).toBe(1);
		expect(h.payloadDropped).toBe(1); // entry-permanent only
		expect(h.payloadExpired).toBe(1);
		expect(h.payloadAbandoned).toBe(1);
		expect(h.payloadInFlightJobs).toBe(0);
		expect(h.payloadBytesPending).toBe(0);
	});

	test("writer suspension and fatal state surface through getHealth/admission", () => {
		const harness = makeWriter();
		writer = harness.writer;
		const reservation = writer.reservePayload(10);
		if (!reservation) throw new Error("expected a reservation");
		publish(writer, reservation, "req-1", "abc");

		const fake = harness.fake();
		fake.accept = false;
		fake.stats = {
			...fake.stats,
			healthy: false,
			admissionSuspended: true,
			writerFatal: "SQLITE_FULL: database or disk is full",
			oldestUnackedAgeMs: 4321,
		};

		const h = writer.getHealth();
		expect(h.healthy).toBe(false);
		expect(h.payloadWriterHealthy).toBe(false);
		expect(h.payloadWriterSuspended).toBe(true);
		expect(h.payloadWriterFatal).toContain("SQLITE_FULL");
		expect(h.oldestPayloadAgeMs).toBe(4321);

		// Admission is closed while the writer refuses work.
		expect(writer.canAcceptPayload(10)).toBe(false);
		expect(writer.reservePayload(10)).toBeNull();
	});

	test("a reservation taken before suspension still publishes, not drops", () => {
		const harness = makeWriter();
		writer = harness.writer;
		// Force the writer to exist, then reserve while admission is still open.
		const first = writer.reservePayload(10);
		if (!first) throw new Error("expected a reservation");
		publish(writer, first, "req-1", "abc");
		const second = writer.reservePayload(10);
		if (!second) throw new Error("expected a reservation");

		// The writer suspends admission (no-progress watchdog / writer-fatal)
		// after the reservation was taken.
		harness.fake().accept = false;

		expect(publish(writer, second, "req-2", "defg")).toBe(true);
		const h = writer.getHealth();
		expect(h.payloadDropped).toBe(0);
		expect(h.payloadInFlightJobs).toBe(2);
		expect(harness.fake().published.map((p) => p.requestId)).toEqual([
			"req-1",
			"req-2",
		]);
		// Fresh admission stays closed.
		expect(writer.reservePayload(10)).toBeNull();
	});

	test("dispose drains metadata, then flushes the payload worker with a bounded deadline", async () => {
		const harness = makeWriter();
		writer = harness.writer;

		let counter = 0;
		for (let i = 0; i < 50; i++) {
			writer.enqueue(() => {
				counter++;
			});
		}
		const reservation = writer.reservePayload(10);
		if (!reservation) throw new Error("expected a reservation");
		publish(writer, reservation, "req-1", "abc");
		const fake = harness.fake();

		await writer.dispose();
		const disposed = writer;
		writer = null;

		expect(counter).toBe(50);
		expect(fake.disposed).toBe(1);
		expect(fake.lastDisposeDeadline).toBeGreaterThan(0);
		expect(fake.lastDisposeDeadline).toBeLessThan(300_000);
		expect(disposed.getHealth().metadataQueuedJobs).toBe(0);
		// Admission is closed once disposed.
		expect(disposed.reservePayload(10)).toBeNull();
	});

	test("dispose awaits an in-flight metadata tick even after the queue is empty", async () => {
		writer = new AsyncDbWriter();

		let finished = false;
		writer.enqueue(async () => {
			await sleep(150);
			finished = true;
		});

		await sleep(120);
		await writer.dispose();
		writer = null;

		expect(finished).toBe(true);
	});

	test("MAX_JOBS_PER_TICK budget is honored (~50 jobs / 100 ms tick)", async () => {
		writer = new AsyncDbWriter();

		let ran = 0;
		for (let i = 0; i < 200; i++) {
			writer.enqueue(() => {
				ran++;
			});
		}

		await sleep(120);

		expect(ran).toBeGreaterThanOrEqual(40);
		expect(ran).toBeLessThan(200);
		expect(writer.getHealth().metadataQueuedJobs).toBeGreaterThan(0);
	});
});

describe("AsyncDbWriter — 30s health log condition", () => {
	function health(
		overrides: Partial<AsyncWriterHealth> = {},
	): AsyncWriterHealth {
		return {
			healthy: true,
			failureCount: 0,
			recentDrops: 0,
			queuedJobs: 0,
			metadataQueuedJobs: 0,
			payloadQueuedJobs: 0,
			payloadInFlightJobs: 0,
			payloadBytesPending: 0,
			payloadReservedBytes: 0,
			payloadInFlightBytes: 0,
			payloadInFlightOriginalBytes: 0,
			oldestMetadataAgeMs: 0,
			oldestPayloadAgeMs: 0,
			metadataDropped: 0,
			payloadDropped: 0,
			payloadDroppedBytes: 0,
			payloadCommitted: 0,
			payloadExpired: 0,
			payloadAbandoned: 0,
			payloadWriterHealthy: true,
			payloadWriterSuspended: false,
			payloadWriterFatal: null,
			...overrides,
		};
	}

	test("stays quiet when everything is idle", () => {
		expect(shouldLogAsyncWriterHealth(health(), 0)).toBe(false);
	});

	test("fires on nonzero pending bytes even with empty queues", () => {
		// The pre-worker condition only looked at queuedJobs/recentDrops, so this
		// exact state — bytes outstanding, queues empty — logged nothing.
		expect(
			shouldLogAsyncWriterHealth(
				health({ payloadBytesPending: 4096, queuedJobs: 0 }),
				0,
			),
		).toBe(true);
	});

	test("fires on unacked payloads and on an unhealthy writer", () => {
		expect(
			shouldLogAsyncWriterHealth(health({ payloadInFlightJobs: 1 }), 0),
		).toBe(true);
		expect(
			shouldLogAsyncWriterHealth(health({ payloadWriterHealthy: false }), 0),
		).toBe(true);
	});

	test("still fires on queued jobs and recent drops", () => {
		expect(shouldLogAsyncWriterHealth(health({ queuedJobs: 3 }), 0)).toBe(true);
		expect(shouldLogAsyncWriterHealth(health(), 2)).toBe(true);
	});
});
