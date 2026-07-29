import type { Disposable } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type {
	PayloadSettlement,
	PayloadWriterFactory,
	PayloadWriterLike,
} from "./payload-write-client";

const logger = new Logger("async-db-writer");

type DbJob = () => void | Promise<void>;

type MetadataJob = {
	requestId?: string;
	enqueuedAt: number;
	run: () => Promise<void> | void;
};

/**
 * Hard ceiling for a single stored payload. Encryption's base64 layer expands
 * the plaintext envelope by ~1/3, so the reserved estimate and the real
 * transport size differ; this bounds the reconciliation, keeps one pathological
 * request from monopolising the 100 MiB budget, and stays well above the
 * largest realistic envelope.
 */
export const MAX_PAYLOAD_ENTRY_BYTES = 16 * 1024 * 1024;

/**
 * Bound on how long dispose() waits for the payload worker to flush and
 * close-ack. Deliberately far below the server's 300 s forced-exit watchdog so
 * a wedged writer can never be the reason a restart hangs.
 */
export const PAYLOAD_FLUSH_DEADLINE_MS = 15_000;

/**
 * A reserved slice of the payload budget.
 *
 * Payload capacity is reserved BEFORE the metadata job is enqueued, so we never
 * serialize and encrypt an envelope only to discover there is no room for it.
 * Every path must either release the token or transfer it via
 * {@link AsyncDbWriter.enqueuePayload}: metadata-enqueue rejection, serialization
 * failure, encryption failure, a failed saveRequest, client disposal, worker
 * spawn failure and a throwing publish all release; a successful publication
 * transfers ownership of the bytes to the writer's in-flight accounting, which
 * is released when the worker reports a terminal outcome.
 *
 * `release()` is idempotent, so a caller may release defensively on every path.
 */
export interface PayloadReservation {
	readonly reservedBytes: number;
	release(): void;
}

export interface PayloadEnqueueInput {
	requestId: string;
	/** Stored form — ciphertext when encryption is on, plaintext JSON otherwise. */
	ciphertext: string;
	/** Epoch ms for `request_payloads.timestamp`. */
	timestamp: number;
	/** Plaintext envelope size, reported through health only. */
	payloadBytes: number;
}

export interface AsyncWriterHealth {
	healthy: boolean;
	failureCount: number;
	recentDrops: number;
	queuedJobs: number;
	metadataQueuedJobs: number;
	/** Payload slots reserved but not yet published. */
	payloadQueuedJobs: number;
	/** Payloads published to the worker and not yet acked. */
	payloadInFlightJobs: number;
	/** Reserved + in-flight transport bytes — what the budget is charged for. */
	payloadBytesPending: number;
	payloadReservedBytes: number;
	payloadInFlightBytes: number;
	/** Original (plaintext) bytes of the in-flight payloads. */
	payloadInFlightOriginalBytes: number;
	oldestMetadataAgeMs: number;
	/** Age of the oldest UNACKNOWLEDGED payload, ms. */
	oldestPayloadAgeMs: number;
	metadataDropped: number;
	payloadDropped: number;
	payloadDroppedBytes: number;
	payloadCommitted: number;
	payloadExpired: number;
	payloadAbandoned: number;
	payloadWriterHealthy: boolean;
	payloadWriterSuspended: boolean;
	payloadWriterFatal: string | null;
}

/**
 * Should the 30 s health line be emitted?
 *
 * Pending payload bytes, unacked payloads and an unhealthy writer are each
 * load-bearing on their own: with the writes off-thread the queues can be empty
 * while the worker still holds unacked work (or is suspended outright), which
 * the old `queuedJobs > 0 || recentDrops > 0` condition silently hid — exactly
 * the state an operator most needs to see.
 */
export function shouldLogAsyncWriterHealth(
	health: AsyncWriterHealth,
	recentDrops: number,
): boolean {
	return (
		health.queuedJobs > 0 ||
		recentDrops > 0 ||
		health.payloadBytesPending > 0 ||
		health.payloadInFlightJobs > 0 ||
		!health.payloadWriterHealthy
	);
}

export interface AsyncDbWriterOptions {
	/**
	 * Factory for the off-thread payload writer. Injected lazily and owned
	 * solely by this AsyncDbWriter — the worker is spawned on the FIRST
	 * publication, so an instance that never stores payloads never spawns one.
	 * When absent, payload publication is rejected (and counted) instead of
	 * falling back to a main-thread write.
	 */
	createPayloadWriter?: PayloadWriterFactory;
}

class ReservationToken implements PayloadReservation {
	private settled = false;

	constructor(
		readonly reservedBytes: number,
		private readonly onSettle: (bytes: number) => void,
	) {}

	/** Consume the token exactly once; returns false if it was already settled. */
	consume(): boolean {
		if (this.settled) return false;
		this.settled = true;
		this.onSettle(this.reservedBytes);
		return true;
	}

	release(): void {
		this.consume();
	}
}

export class AsyncDbWriter implements Disposable {
	private metadataQueue: MetadataJob[] = [];
	// Tracks the currently-executing tick. dispose() and re-entrant callers
	// await this so a tick that has already shift()-ed its last job (queue
	// empty) but is still inside its job's `finally` is not abandoned.
	private runningPromise: Promise<void> | null = null;
	private intervalId: Timer | null = null;
	private healthInterval: Timer | null = null;

	private readonly METADATA_QUEUE_CAP = 2000;
	private readonly PAYLOAD_QUEUE_HARD_CAP = 1000;
	private readonly PAYLOAD_BYTES_CAP = 100 * 1024 * 1024;

	// Dual budget: cap by both job count and wall-clock so a few slow jobs cannot
	// monopolize the tick and so a queue of trivial jobs cannot starve the event
	// loop. The 100ms setInterval restart resumes drain after we yield.
	private readonly MAX_JOBS_PER_TICK = 50;
	private readonly MAX_DRAIN_MS_PER_TICK = 250;

	// Max time the drain may run *contiguously* before handing control back to
	// the event loop with a real macrotask yield mid-tick. `await job.run()`
	// resolves through microtasks only (bun:sqlite is synchronous), so without
	// this a single tick draining many jobs back-to-back blocks HTTP serving and
	// the event-loop monitor for its whole duration — up to MAX_DRAIN_MS_PER_TICK,
	// which equals the monitor's 250ms WARN threshold, so a full-drain tick trips
	// it. Kept well under that threshold. Only long drains ever yield; a normal
	// sub-50ms tick is unchanged, so light load pays nothing.
	private readonly YIELD_INTERVAL_MS = 50;

	private readonly createPayloadWriter?: PayloadWriterFactory;
	private payloadWriter: PayloadWriterLike | null = null;
	private payloadWriterUnavailableLogged = false;

	/** Reserved but not yet published. */
	private payloadReservedBytes = 0;
	private payloadReservedCount = 0;
	/** Published to the worker, not yet acked. */
	private payloadInFlightBytes = 0;
	private payloadInFlightOriginalBytes = 0;
	private payloadInFlightCount = 0;

	private metadataDropped = 0;
	private payloadDropped = 0;
	private payloadDroppedBytes = 0;
	private payloadCommitted = 0;
	private payloadExpired = 0;
	private payloadAbandoned = 0;
	private droppedJobsSinceLastLog = 0;
	private payloadDroppedSinceLastLog = 0;
	private lastIntervalDrops = 0;

	private disposed = false;

	constructor(options: AsyncDbWriterOptions = {}) {
		this.createPayloadWriter = options.createPayloadWriter;
		this.intervalId = setInterval(() => void this.processQueue(), 100);
		this.healthInterval = setInterval(() => {
			const recentDrops =
				this.droppedJobsSinceLastLog + this.payloadDroppedSinceLastLog;
			this.droppedJobsSinceLastLog = 0;
			this.payloadDroppedSinceLastLog = 0;
			this.lastIntervalDrops = recentDrops;
			const h = this.getHealth();
			if (shouldLogAsyncWriterHealth(h, recentDrops)) {
				logger.warn(
					`AsyncDbWriter health: metadataQueued=${h.metadataQueuedJobs}, payloadReserved=${h.payloadQueuedJobs}, payloadInFlight=${h.payloadInFlightJobs}, payloadBytesPending=${h.payloadBytesPending}, oldestMetadataAgeMs=${h.oldestMetadataAgeMs}, oldestPayloadAgeMs=${h.oldestPayloadAgeMs}, metadataDropped=${h.metadataDropped}, payloadDropped=${h.payloadDropped}, payloadDroppedBytes=${h.payloadDroppedBytes}, payloadCommitted=${h.payloadCommitted}, payloadExpired=${h.payloadExpired}, writerHealthy=${h.payloadWriterHealthy}, writerFatal=${h.payloadWriterFatal ?? "none"}, droppedThisInterval=${recentDrops}`,
				);
			}
		}, 30000);
	}

	/**
	 * Enqueue a metadata job. Returns `true` when the job was accepted onto the
	 * queue, `false` when it was dropped because the metadata queue is at
	 * `METADATA_QUEUE_CAP`. Callers that need to know a request-row write was lost
	 * (e.g. the RequestRecorder) can count or log the drop instead of assuming the
	 * row persisted.
	 */
	enqueue(job: DbJob): boolean {
		if (this.metadataQueue.length >= this.METADATA_QUEUE_CAP) {
			this.metadataDropped++;
			this.droppedJobsSinceLastLog++;
			if (this.metadataDropped % 100 === 1) {
				logger.warn(
					`Metadata queue at capacity (${this.METADATA_QUEUE_CAP}), dropping jobs. Total dropped: ${this.metadataDropped}`,
				);
			}
			return false;
		}

		this.metadataQueue.push({
			enqueuedAt: performance.now(),
			run: job,
		});
		void this.processQueue();
		return true;
	}

	// -----------------------------------------------------------------------
	// Payload admission
	// -----------------------------------------------------------------------

	/**
	 * Cheap, lock-free advisory probe: would a payload of this size fit right
	 * now? The real admission decision is made by {@link reservePayload}.
	 */
	canAcceptPayload(estimatedBytes: number): boolean {
		if (this.disposed) return false;
		if (estimatedBytes > MAX_PAYLOAD_ENTRY_BYTES) return false;
		if (this.payloadJobCount() >= this.PAYLOAD_QUEUE_HARD_CAP) return false;
		if (this.payloadBytesPending() + estimatedBytes > this.PAYLOAD_BYTES_CAP) {
			return false;
		}
		if (this.payloadWriter && !this.payloadWriter.acceptsWork()) return false;
		return true;
	}

	/**
	 * Reserve payload capacity BEFORE the metadata job is enqueued. Returns null
	 * when there is no room (or the writer is suspended); the caller counts that
	 * through {@link recordPayloadDrop} exactly as before.
	 */
	reservePayload(estimatedBytes: number): PayloadReservation | null {
		if (!this.canAcceptPayload(estimatedBytes)) return null;
		this.payloadReservedBytes += estimatedBytes;
		this.payloadReservedCount++;
		return new ReservationToken(estimatedBytes, (bytes) => {
			this.payloadReservedBytes -= bytes;
			this.payloadReservedCount--;
		});
	}

	/**
	 * Record a payload drop that did not go through {@link enqueuePayload} — i.e.
	 * a caller whose reservation was refused, or which released it before
	 * publication. Without this the drop counters miss every such reject, leaving
	 * `getHealth().payloadDropped` blind under sustained backpressure and
	 * suppressing the 30s health log line.
	 */
	recordPayloadDrop(bytes: number): void {
		this.payloadDropped++;
		this.payloadDroppedBytes += bytes;
		this.payloadDroppedSinceLastLog++;
		if (this.payloadDropped % 100 === 1) {
			logger.warn(
				`Payload dropped (bytes=${bytes}, reserved=${this.payloadReservedCount}, inFlight=${this.payloadInFlightCount}, bytesPending=${this.payloadBytesPending()}). Total dropped: ${this.payloadDropped}`,
			);
		}
	}

	/**
	 * Publish a payload to the off-thread writer, consuming `reservation`.
	 *
	 * The reservation is reconciled against the EXACT stored byte count here (the
	 * estimate was taken before serialization and encryption), re-checked against
	 * the per-entry maximum and the total budget, and — on success — its bytes
	 * are transferred to the in-flight accounting, released only when the worker
	 * reports a terminal outcome. Every rejection path releases the reservation
	 * and counts a drop, so no caller can leak budget.
	 */
	enqueuePayload(
		reservation: PayloadReservation,
		entry: PayloadEnqueueInput,
	): boolean {
		const token = reservation as ReservationToken;
		if (!token.consume()) return false;

		const transportBytes = Buffer.byteLength(entry.ciphertext);

		if (transportBytes > MAX_PAYLOAD_ENTRY_BYTES) {
			logger.warn(
				`Payload for ${entry.requestId} exceeds the per-entry maximum (${transportBytes} > ${MAX_PAYLOAD_ENTRY_BYTES}) — dropping`,
			);
			this.recordPayloadDrop(transportBytes);
			return false;
		}
		if (
			this.disposed ||
			this.payloadInFlightCount >= this.PAYLOAD_QUEUE_HARD_CAP ||
			this.payloadBytesPending() + transportBytes > this.PAYLOAD_BYTES_CAP
		) {
			this.recordPayloadDrop(transportBytes);
			return false;
		}

		const writer = this.ensurePayloadWriter();
		if (!writer) {
			this.recordPayloadDrop(transportBytes);
			return false;
		}

		// Ownership transfer: the bytes now belong to the in-flight accounting.
		this.payloadInFlightBytes += transportBytes;
		this.payloadInFlightOriginalBytes += entry.payloadBytes;
		this.payloadInFlightCount++;

		let published = false;
		try {
			// publishReserved, not publish: this entry's admission decision was made
			// when its capacity was reserved. A writer that has since suspended
			// admission (no-progress watchdog or writer-fatal) must RETAIN it, not
			// hand it back as an ordinary drop.
			published = writer.publishReserved({
				requestId: entry.requestId,
				ciphertext: entry.ciphertext,
				timestamp: entry.timestamp,
				transportBytes,
				payloadBytes: entry.payloadBytes,
			});
		} catch (err) {
			logger.error(`Payload publish threw for ${entry.requestId}:`, err);
			published = false;
		}

		if (!published) {
			this.payloadInFlightBytes -= transportBytes;
			this.payloadInFlightOriginalBytes -= entry.payloadBytes;
			this.payloadInFlightCount--;
			this.recordPayloadDrop(transportBytes);
			return false;
		}
		return true;
	}

	private ensurePayloadWriter(): PayloadWriterLike | null {
		if (this.payloadWriter) return this.payloadWriter;
		if (!this.createPayloadWriter) {
			if (!this.payloadWriterUnavailableLogged) {
				this.payloadWriterUnavailableLogged = true;
				logger.warn(
					"No payload writer configured — payload writes are dropped (payloads are never written on the main thread)",
				);
			}
			return null;
		}
		this.payloadWriter = this.createPayloadWriter({
			onSettled: (settlement) => this.onPayloadSettled(settlement),
		});
		return this.payloadWriter;
	}

	private onPayloadSettled(settlement: PayloadSettlement): void {
		this.payloadInFlightBytes -= settlement.transportBytes;
		this.payloadInFlightOriginalBytes -= settlement.payloadBytes;
		this.payloadInFlightCount--;

		switch (settlement.outcome) {
			case "committed":
				this.payloadCommitted++;
				break;
			case "dropped":
				// entry-permanent: attributable to the row (e.g. its request row was
				// deleted by retention before the replay landed).
				this.recordPayloadDrop(settlement.transportBytes);
				break;
			case "expired":
				this.payloadExpired++;
				break;
			case "abandoned":
				// Never committed, but not a capacity drop either — counted apart so
				// shutdown losses cannot masquerade as backpressure.
				this.payloadAbandoned++;
				break;
		}
	}

	private payloadBytesPending(): number {
		return this.payloadReservedBytes + this.payloadInFlightBytes;
	}

	private payloadJobCount(): number {
		return this.payloadReservedCount + this.payloadInFlightCount;
	}

	// -----------------------------------------------------------------------
	// Metadata drain
	// -----------------------------------------------------------------------

	private async runJobWithWatchdog(job: MetadataJob): Promise<void> {
		const t0 = performance.now();
		const watchdog = setTimeout(() => {
			logger.warn(
				`DB job stuck: kind=metadata requestId=${job.requestId ?? "n/a"} elapsed_ms=${Math.round(performance.now() - t0)}`,
			);
		}, 5000);
		try {
			await job.run();
		} catch (err) {
			logger.error(
				`DB job failed: kind=metadata requestId=${job.requestId ?? "n/a"}`,
				err,
			);
		} finally {
			clearTimeout(watchdog);
			const dur = performance.now() - t0;
			if (dur > 1000) {
				logger.warn(
					`Slow DB job: kind=metadata dur_ms=${Math.round(dur)} requestId=${job.requestId ?? "n/a"}`,
				);
			}
		}
	}

	private async processQueue(): Promise<void> {
		// Coalesce concurrent invocations onto the in-flight tick so callers can
		// observe its completion. Without this dispose() can return while a
		// shift()-ed job is mid-execution (queue length 0, finally not yet run).
		if (this.runningPromise) {
			return this.runningPromise;
		}
		if (this.metadataQueue.length === 0) {
			return;
		}

		this.runningPromise = this.runTick();
		try {
			await this.runningPromise;
		} finally {
			this.runningPromise = null;
		}
	}

	private async runTick(): Promise<void> {
		const start = performance.now();
		let jobsProcessed = 0;
		let lastYieldAt = start;

		while (
			this.metadataQueue.length > 0 &&
			jobsProcessed < this.MAX_JOBS_PER_TICK &&
			performance.now() - start < this.MAX_DRAIN_MS_PER_TICK
		) {
			// If we've been draining contiguously for YIELD_INTERVAL_MS, yield to
			// a real macrotask so pending HTTP I/O and timers (incl. the event-loop
			// monitor tick) run before the next job — otherwise the microtask-only
			// `await job.run()` chain blocks the loop for the whole tick. Only long
			// drains reach this; a normal short tick never yields.
			if (performance.now() - lastYieldAt >= this.YIELD_INTERVAL_MS) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				lastYieldAt = performance.now();
			}

			const job = this.metadataQueue.shift();
			if (!job) break;
			await this.runJobWithWatchdog(job);
			jobsProcessed++;
		}

		if (jobsProcessed > 0) {
			logger.debug(`Processed ${jobsProcessed} database jobs`);
		}
	}

	getHealth(): AsyncWriterHealth {
		const now = performance.now();
		const oldestMetadataAgeMs =
			this.metadataQueue.length > 0
				? Math.round(now - this.metadataQueue[0].enqueuedAt)
				: 0;
		const writerStats = this.payloadWriter?.getStats() ?? null;
		const writerHealthy = writerStats ? writerStats.healthy : true;
		const bytesPending = this.payloadBytesPending();
		return {
			healthy:
				this.metadataQueue.length < this.METADATA_QUEUE_CAP * 0.8 &&
				this.payloadJobCount() < this.PAYLOAD_QUEUE_HARD_CAP * 0.8 &&
				bytesPending < this.PAYLOAD_BYTES_CAP * 0.8 &&
				writerHealthy &&
				this.lastIntervalDrops === 0,
			failureCount: this.metadataDropped + this.payloadDropped,
			recentDrops: this.lastIntervalDrops,
			queuedJobs: this.metadataQueue.length + this.payloadJobCount(),
			metadataQueuedJobs: this.metadataQueue.length,
			payloadQueuedJobs: this.payloadReservedCount,
			payloadInFlightJobs: this.payloadInFlightCount,
			payloadBytesPending: bytesPending,
			payloadReservedBytes: this.payloadReservedBytes,
			payloadInFlightBytes: this.payloadInFlightBytes,
			payloadInFlightOriginalBytes: this.payloadInFlightOriginalBytes,
			oldestMetadataAgeMs,
			oldestPayloadAgeMs: writerStats?.oldestUnackedAgeMs ?? 0,
			metadataDropped: this.metadataDropped,
			payloadDropped: this.payloadDropped,
			payloadDroppedBytes: this.payloadDroppedBytes,
			payloadCommitted: this.payloadCommitted,
			payloadExpired: this.payloadExpired,
			payloadAbandoned: this.payloadAbandoned,
			payloadWriterHealthy: writerHealthy,
			payloadWriterSuspended: writerStats?.admissionSuspended ?? false,
			payloadWriterFatal: writerStats?.writerFatal ?? null,
		};
	}

	async dispose(): Promise<void> {
		logger.info("Flushing async DB writer queue...");

		// Stop admission (and, through it, rotation) before draining.
		this.disposed = true;

		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.healthInterval) {
			clearInterval(this.healthInterval);
			this.healthInterval = null;
		}

		// Drain the metadata queue to completion. processQueue is budgeted
		// per-tick; call it in a loop until the queue is empty AND no in-flight
		// tick is still running (the latter covers the race where the last job
		// has been shift()-ed off but its `finally` has not yet executed).
		while (this.metadataQueue.length > 0 || this.runningPromise) {
			await this.processQueue();
		}

		// Then let the worker flush its batches and close-ack, bounded; every
		// generation is terminated in the client's `finally`.
		if (this.payloadWriter) {
			await this.payloadWriter.dispose(PAYLOAD_FLUSH_DEADLINE_MS);
		}

		const h = this.getHealth();
		logger.info("Async DB writer queue flushed", {
			remainingMetadataJobs: h.metadataQueuedJobs,
			payloadBytesPending: h.payloadBytesPending,
			payloadCommitted: h.payloadCommitted,
			metadataDropped: h.metadataDropped,
			payloadDropped: h.payloadDropped,
			payloadDroppedBytes: h.payloadDroppedBytes,
			payloadExpired: h.payloadExpired,
			payloadAbandoned: h.payloadAbandoned,
		});
	}
}
