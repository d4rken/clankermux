import { Logger } from "@clankermux/logger";
import { EMBEDDED_PAYLOAD_WRITE_WORKER_CODE } from "./inline-payload-write-worker";
import type {
	PayloadWriteAck,
	PayloadWriteErrorClass,
	PayloadWriteRequest,
	PayloadWriteResponse,
} from "./payload-write-worker";

const log = new Logger("payload-write-client");

/**
 * Main-thread controller for the off-thread `request_payloads` writer.
 *
 * Responsibilities, all of which exist because the worker connection is
 * genuinely concurrent with the main connection:
 *
 *  - **Rotation.** Exactly ONE active writer at a time, retired once it has been
 *    handed {@link PAYLOAD_ROTATION_BYTE_BUDGET} of published bytes. Bun 1.3.14
 *    never reclaims the native backing stores of structured-clone postMessage
 *    payloads for as long as the receiving worker lives (Bun #5709); terminating
 *    the generation is what frees them. Rotation prewarms the replacement to
 *    `ready` and only activates it once the outgoing worker close-acks (or hits
 *    {@link PAYLOAD_ROTATION_DEADLINE_MS} and is terminated), so two writers are
 *    never active at once.
 *  - **Durability.** Entries stay in the unacked registry until the worker acks
 *    a COMMIT. Rotation, a crash or a fence replays them to the next generation.
 *    Payloads are NEVER written on the main thread, and a replay only ever
 *    happens after the previous generation was terminated or close-acked, so an
 *    ack timeout can never produce a concurrent write. The insert is an upsert,
 *    so replaying an entry whose ack was lost is idempotent.
 *  - **Replay expiry.** An entry whose payload timestamp has fallen outside the
 *    payload-retention window is dropped instead of replayed — otherwise
 *    commit → lost ack → retention delete → replay would resurrect a row the
 *    cleanup worker had already removed.
 *  - **Fenced no-progress watchdog.** A worker that is alive but stops acking
 *    first suspends admission and reports unhealthy, then gets FENCED
 *    (terminated) — and only then is its work replayed.
 */

// ---------------------------------------------------------------------------
// Named constants
// ---------------------------------------------------------------------------

/** Published bytes after which the active generation is retired (Bun #5709). */
export const PAYLOAD_ROTATION_BYTE_BUDGET = 256 * 1024 * 1024;

/** How long a retiring generation may take to close-ack before termination. */
export const PAYLOAD_ROTATION_DEADLINE_MS = 10_000;

/** How long a freshly spawned generation may take to post `ready`. */
export const PAYLOAD_READY_TIMEOUT_MS = 10_000;

/** No-progress bound after which admission stops and health goes unhealthy. */
export const PAYLOAD_NO_PROGRESS_UNHEALTHY_MS = 30_000;

/** No-progress bound after which the generation is fenced (terminated). */
export const PAYLOAD_NO_PROGRESS_FENCE_MS = 60_000;

/** Cadence of the no-progress watchdog. */
export const PAYLOAD_WATCHDOG_INTERVAL_MS = 1_000;

/** First delay of the per-entry retry backoff after a `retryable` NACK. */
export const PAYLOAD_RETRY_BASE_MS = 100;

/** Ceiling of the per-entry retry backoff. */
export const PAYLOAD_RETRY_MAX_MS = 5_000;

/** First delay of the respawn backoff after a spawn failure or a fence. */
export const PAYLOAD_RESPAWN_BASE_MS = 250;

/** Ceiling of the respawn backoff. */
export const PAYLOAD_RESPAWN_MAX_MS = 30_000;

/** Default bound for {@link PayloadWriteClient.dispose}. */
export const PAYLOAD_DISPOSE_DEADLINE_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimerHandle = unknown;

/** Transport to one worker generation. Injectable so tests need no real thread. */
export interface PayloadWriteTransport {
	postMessage(message: PayloadWriteRequest): void;
	onMessage(handler: (message: PayloadWriteResponse) => void): void;
	/** Worker `error`/`close` events — i.e. the generation died unexpectedly. */
	onError(handler: (detail: string) => void): void;
	terminate(): void;
}

export type PayloadWriteTransportFactory = (
	generation: number,
) => PayloadWriteTransport;

export interface PayloadEntryInput {
	requestId: string;
	/** Stored form (ciphertext or plaintext JSON) as handed to the worker. */
	ciphertext: string;
	/** Epoch ms stored in `request_payloads.timestamp`; the retention basis. */
	timestamp: number;
	/** Byte size of `ciphertext` — what crosses the postMessage boundary. */
	transportBytes: number;
	/** Byte size of the plaintext envelope, for reporting only. */
	payloadBytes: number;
}

export type PayloadSettlementOutcome =
	| "committed"
	/** `entry-permanent` NACK — attributable to the row, counted as a drop. */
	| "dropped"
	/** Fell outside the retention window before it could be replayed. */
	| "expired"
	/** Still unacked when the client was disposed. */
	| "abandoned";

export interface PayloadSettlement {
	requestId: string;
	transportBytes: number;
	payloadBytes: number;
	outcome: PayloadSettlementOutcome;
	errorClass?: PayloadWriteErrorClass;
	detail?: string;
}

export interface PayloadWriterStats {
	/** Entries published but not yet settled. */
	unackedEntries: number;
	/** Transport (ciphertext) bytes of unacked entries. */
	unackedTransportBytes: number;
	/** Original (plaintext envelope) bytes of unacked entries. */
	unackedPayloadBytes: number;
	/** Age of the oldest UNACKNOWLEDGED entry, ms. */
	oldestUnackedAgeMs: number;
	committed: number;
	droppedPermanent: number;
	expired: number;
	abandoned: number;
	retries: number;
	replays: number;
	rotations: number;
	spawnFailures: number;
	fences: number;
	activeGeneration: number | null;
	liveGenerations: number;
	healthy: boolean;
	admissionSuspended: boolean;
	writerFatal: string | null;
	disposed: boolean;
}

export interface PayloadWriteClientOptions {
	dbPath: string;
	busyTimeoutMs?: number;
	/** Current payload-retention window, ms. Read fresh on every expiry check. */
	getRetentionMs: () => number;
	onSettled?: (settlement: PayloadSettlement) => void;
	/** Transport factory; defaults to a real Bun Worker. */
	spawn?: PayloadWriteTransportFactory;
	now?: () => number;
	setTimer?: (cb: () => void, ms: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
	/** Override for tests; defaults to {@link PAYLOAD_ROTATION_BYTE_BUDGET}. */
	rotationByteBudget?: number;
}

/** The surface AsyncDbWriter depends on — kept narrow so it is trivial to fake. */
export interface PayloadWriterLike {
	publish(entry: PayloadEntryInput): boolean;
	acceptsWork(): boolean;
	getStats(): PayloadWriterStats;
	dispose(deadlineMs?: number): Promise<void>;
}

export type PayloadWriterFactory = (hooks: {
	onSettled: (settlement: PayloadSettlement) => void;
}) => PayloadWriterLike;

// ---------------------------------------------------------------------------
// Real worker transport
// ---------------------------------------------------------------------------

/**
 * Spawn a real payload-write Worker. Mirrors the established
 * base64 → Blob → `new Worker(url, { smol: true })` pattern used by the
 * maintenance workers, with the on-disk source as the dev/test fallback.
 *
 * Each spawn's Blob object URL is revoked exactly once — without that, every
 * rotation would leak one URL (and its blob) for the process lifetime. It is
 * NOT revoked straight after `new Worker(url)`: Bun resolves the URL while the
 * worker thread boots, and revoking synchronously makes the spawn fail with
 * "Blob URL is missing". Revoking on the worker's first message (proof that its
 * code loaded) or on termination (whichever comes first) is both safe and
 * leak-free.
 */
export function createWorkerTransport(): PayloadWriteTransport {
	let worker: Worker;
	let objectUrl: string | null = null;
	if (EMBEDDED_PAYLOAD_WRITE_WORKER_CODE) {
		const code = Buffer.from(
			EMBEDDED_PAYLOAD_WRITE_WORKER_CODE,
			"base64",
		).toString("utf8");
		objectUrl = URL.createObjectURL(
			new Blob([code], { type: "text/javascript" }),
		);
		try {
			worker = new Worker(objectUrl, { smol: true });
		} catch (err) {
			// No worker exists to revoke the URL later, so revoke it here — a
			// throwing constructor would otherwise leak the blob for the process
			// lifetime, once per failed spawn.
			URL.revokeObjectURL(objectUrl);
			objectUrl = null;
			throw err;
		}
	} else {
		worker = new Worker(
			new URL("./payload-write-worker.ts", import.meta.url).href,
			{ smol: true },
		);
	}

	const revokeOnce = (): void => {
		if (objectUrl === null) return;
		URL.revokeObjectURL(objectUrl);
		objectUrl = null;
	};

	return {
		postMessage(message) {
			worker.postMessage(message);
		},
		onMessage(handler) {
			worker.onmessage = (event: MessageEvent<PayloadWriteResponse>) => {
				revokeOnce();
				handler(event.data);
			};
		},
		onError(handler) {
			worker.onerror = (event: ErrorEvent) => {
				revokeOnce();
				handler(event.message || "payload writer worker error");
			};
			worker.addEventListener("close", () => {
				revokeOnce();
				handler("payload writer worker closed");
			});
		},
		terminate() {
			revokeOnce();
			worker.terminate();
		},
	};
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type EntryState = "buffered" | "sent" | "retry_wait";

interface RegistryEntry extends PayloadEntryInput {
	seq: number;
	state: EntryState;
	/** Generation the entry was last sent to; null while buffered. */
	generation: number | null;
	attempts: number;
	/** True once the entry has been handed to any generation. */
	everSent: boolean;
	/**
	 * When the entry entered the registry. Immutable — retries, replays and
	 * cross-generation handovers must NOT reset it, or an entry stuck for hours
	 * would report an age of milliseconds.
	 */
	publishedAt: number;
	/** When the entry was last handed to a generation; watchdog progress basis. */
	sentAt: number;
	retryTimer: TimerHandle | null;
}

type GenerationStatus = "starting" | "ready" | "closing" | "dead";

interface GenerationState {
	id: number;
	transport: PayloadWriteTransport;
	status: GenerationStatus;
	publishedBytes: number;
	onReady:
		| ((
				ok: boolean,
				detail?: string,
				errorClass?: PayloadWriteErrorClass,
		  ) => void)
		| null;
	onClosed: (() => void) | null;
	readyTimer: TimerHandle | null;
	closeTimer: TimerHandle | null;
}

export class PayloadWriteClient implements PayloadWriterLike {
	private readonly options: PayloadWriteClientOptions;
	private readonly now: () => number;
	private readonly setTimer: (cb: () => void, ms: number) => TimerHandle;
	private readonly clearTimer: (handle: TimerHandle) => void;
	private readonly spawnTransport: PayloadWriteTransportFactory;
	private readonly rotationByteBudget: number;

	/** Insertion-ordered: iteration replays in original publish order. */
	private readonly unacked = new Map<number, RegistryEntry>();
	private readonly generations = new Map<number, GenerationState>();

	private nextSeq = 1;
	private nextGeneration = 1;
	private active: GenerationState | null = null;
	private spawning = false;
	/** The in-flight spawn chain (spawn → activate → flush), for dispose. */
	private spawnInFlight: Promise<unknown> | null = null;
	private rotating = false;
	/** The in-flight rotation (prewarm → close → cut over), for dispose. */
	private rotationInFlight: Promise<void> | null = null;
	private disposed = false;
	private disposePromise: Promise<void> | null = null;

	private respawnAttempts = 0;
	private respawnTimer: TimerHandle | null = null;
	private watchdogTimer: TimerHandle | null = null;
	private lastAckAt: number;

	private admissionSuspended = false;
	private watchdogUnhealthy = false;
	private writerFatal: string | null = null;

	private committed = 0;
	private droppedPermanent = 0;
	private expired = 0;
	private abandoned = 0;
	private retries = 0;
	private replays = 0;
	private rotations = 0;
	private spawnFailures = 0;
	private fences = 0;

	constructor(options: PayloadWriteClientOptions) {
		this.options = options;
		this.now = options.now ?? (() => Date.now());
		this.setTimer =
			options.setTimer ?? ((cb, ms) => setTimeout(cb, ms) as TimerHandle);
		this.clearTimer =
			options.clearTimer ??
			((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.spawnTransport = options.spawn ?? (() => createWorkerTransport());
		this.rotationByteBudget =
			options.rotationByteBudget ?? PAYLOAD_ROTATION_BYTE_BUDGET;
		this.lastAckAt = this.now();
	}

	// -- admission ----------------------------------------------------------

	acceptsWork(): boolean {
		return (
			!this.disposed && !this.admissionSuspended && this.writerFatal === null
		);
	}

	publish(entry: PayloadEntryInput): boolean {
		if (!this.acceptsWork()) return false;

		const registryEntry: RegistryEntry = {
			...entry,
			seq: this.nextSeq++,
			state: "buffered",
			generation: null,
			attempts: 0,
			everSent: false,
			publishedAt: this.now(),
			sentAt: this.now(),
			retryTimer: null,
		};
		this.unacked.set(registryEntry.seq, registryEntry);
		this.startWatchdog();
		this.ensureActiveGeneration();
		this.trySend(registryEntry);
		return true;
	}

	// -- stats ---------------------------------------------------------------

	getStats(): PayloadWriterStats {
		let transportBytes = 0;
		let payloadBytes = 0;
		// Age is measured from PUBLICATION, not from the last send: retries and
		// replays reset `sentAt`, which would make a long-stuck entry look fresh.
		let oldestPublishedAt: number | null = null;
		for (const entry of this.unacked.values()) {
			transportBytes += entry.transportBytes;
			payloadBytes += entry.payloadBytes;
			if (oldestPublishedAt === null || entry.publishedAt < oldestPublishedAt) {
				oldestPublishedAt = entry.publishedAt;
			}
		}
		return {
			unackedEntries: this.unacked.size,
			unackedTransportBytes: transportBytes,
			unackedPayloadBytes: payloadBytes,
			oldestUnackedAgeMs:
				oldestPublishedAt === null
					? 0
					: Math.max(0, Math.round(this.now() - oldestPublishedAt)),
			committed: this.committed,
			droppedPermanent: this.droppedPermanent,
			expired: this.expired,
			abandoned: this.abandoned,
			retries: this.retries,
			replays: this.replays,
			rotations: this.rotations,
			spawnFailures: this.spawnFailures,
			fences: this.fences,
			activeGeneration: this.active?.id ?? null,
			liveGenerations: this.generations.size,
			healthy:
				!this.watchdogUnhealthy && this.writerFatal === null && !this.disposed,
			admissionSuspended: this.admissionSuspended,
			writerFatal: this.writerFatal,
			disposed: this.disposed,
		};
	}

	// -- sending -------------------------------------------------------------

	private trySend(entry: RegistryEntry): void {
		if (this.disposed || this.writerFatal !== null) return;
		const generation = this.active;
		if (!generation || generation.status !== "ready" || this.rotating) {
			entry.state = "buffered";
			return;
		}

		entry.state = "sent";
		entry.generation = generation.id;
		entry.sentAt = this.now();
		entry.attempts++;
		entry.everSent = true;

		try {
			generation.transport.postMessage({
				type: "write",
				generation: generation.id,
				seq: entry.seq,
				id: entry.requestId,
				ciphertext: entry.ciphertext,
				timestamp: entry.timestamp,
			});
		} catch (err) {
			// A throwing postMessage means the generation is unusable. Keep the
			// entry (buffered) and tear the generation down; the backoff respawn
			// replays it even if no further traffic arrives.
			entry.state = "buffered";
			entry.generation = null;
			this.onGenerationDied(
				generation,
				`postMessage failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		// Replayed bytes charge the RECEIVING generation's budget — that is the
		// worker whose native buffers they actually pin.
		generation.publishedBytes += entry.transportBytes;
		this.maybeRotate();
	}

	/** Send everything that is not currently in flight on the active generation. */
	private flushBuffered(): void {
		if (this.disposed || this.writerFatal !== null) return;
		const generation = this.active;
		if (!generation || generation.status !== "ready" || this.rotating) return;

		for (const entry of [...this.unacked.values()]) {
			if (entry.state === "sent" && entry.generation === generation.id)
				continue;
			if (entry.state === "retry_wait") continue;
			if (this.dropIfExpired(entry)) continue;
			this.sendOrReplay(entry);
		}
	}

	/**
	 * Send an entry, counting it as a replay when it had already been handed to
	 * a generation that is now gone. Retry resends are counted separately (see
	 * `scheduleRetry`), so nothing is double-counted.
	 */
	private sendOrReplay(entry: RegistryEntry): void {
		if (entry.everSent) this.replays++;
		this.trySend(entry);
	}

	/**
	 * Replay every entry that is not in flight on the CURRENT generation. Only
	 * ever called after the previous generation was close-acked or terminated,
	 * which is what makes "replay" incapable of racing a live write.
	 */
	private replayToActive(): void {
		for (const entry of [...this.unacked.values()]) {
			if (entry.state === "sent" && entry.generation === this.active?.id) {
				continue;
			}
			if (entry.retryTimer !== null) {
				this.clearTimer(entry.retryTimer);
				entry.retryTimer = null;
			}
			if (this.dropIfExpired(entry)) continue;
			entry.state = "buffered";
			entry.generation = null;
			this.sendOrReplay(entry);
		}
	}

	/**
	 * Retention guard: a payload older than the retention window may already
	 * have been deleted by the cleanup worker after a commit whose ack was lost.
	 * Replaying it would resurrect a deleted row, so drop it instead — counted
	 * as `expired`, separately from failures.
	 */
	private dropIfExpired(entry: RegistryEntry): boolean {
		const retentionMs = this.options.getRetentionMs();
		if (!Number.isFinite(retentionMs) || retentionMs <= 0) return false;
		if (this.now() - entry.timestamp <= retentionMs) return false;
		this.expired++;
		this.settle(entry, "expired");
		return true;
	}

	private settle(
		entry: RegistryEntry,
		outcome: PayloadSettlementOutcome,
		errorClass?: PayloadWriteErrorClass,
		detail?: string,
	): void {
		if (entry.retryTimer !== null) {
			this.clearTimer(entry.retryTimer);
			entry.retryTimer = null;
		}
		this.unacked.delete(entry.seq);
		this.options.onSettled?.({
			requestId: entry.requestId,
			transportBytes: entry.transportBytes,
			payloadBytes: entry.payloadBytes,
			outcome,
			errorClass,
			detail,
		});
	}

	// -- generation lifecycle -------------------------------------------------

	private ensureActiveGeneration(): void {
		if (this.disposed || this.writerFatal !== null) return;
		if (this.active || this.spawning || this.rotating) return;
		if (this.respawnTimer !== null) return;
		const chain = this.spawnGeneration().then((generation) => {
			if (!generation) return;
			this.active = generation;
			this.flushBuffered();
		});
		this.spawnInFlight = chain;
		void chain.finally(() => {
			if (this.spawnInFlight === chain) this.spawnInFlight = null;
		});
	}

	private spawnGeneration(): Promise<GenerationState | null> {
		this.spawning = true;
		return new Promise<GenerationState | null>((resolve) => {
			const id = this.nextGeneration++;
			let transport: PayloadWriteTransport;
			try {
				transport = this.spawnTransport(id);
			} catch (err) {
				this.spawning = false;
				this.onSpawnFailure(
					`spawn threw: ${err instanceof Error ? err.message : String(err)}`,
				);
				resolve(null);
				return;
			}

			const generation: GenerationState = {
				id,
				transport,
				status: "starting",
				publishedBytes: 0,
				onReady: null,
				onClosed: null,
				readyTimer: null,
				closeTimer: null,
			};
			this.generations.set(id, generation);

			let finished = false;
			const finish = (
				ok: boolean,
				detail?: string,
				errorClass?: PayloadWriteErrorClass,
			): void => {
				if (finished) return;
				finished = true;
				if (generation.readyTimer !== null) {
					this.clearTimer(generation.readyTimer);
					generation.readyTimer = null;
				}
				this.spawning = false;
				if (ok) {
					this.respawnAttempts = 0;
					resolve(generation);
					return;
				}
				this.killGeneration(generation, detail ?? "spawn failed");
				if (errorClass === "writer-fatal") {
					// The database itself is unusable (cannot open, read-only, full,
					// corrupt). Every generation would fail identically, so latch
					// instead of respawning: admission closes, health goes unhealthy
					// and pending entries are retained.
					this.onWriterFatal(detail ?? "payload writer init failed");
				} else {
					this.onSpawnFailure(detail ?? "spawn failed");
				}
				resolve(null);
			};

			generation.onReady = finish;
			transport.onMessage((message) => this.handleMessage(generation, message));
			transport.onError((detail) => {
				if (!finished) {
					finish(false, detail);
					return;
				}
				this.onGenerationDied(generation, detail);
			});

			generation.readyTimer = this.setTimer(() => {
				generation.readyTimer = null;
				finish(false, "payload writer did not report ready in time");
			}, PAYLOAD_READY_TIMEOUT_MS);

			try {
				transport.postMessage({
					type: "init",
					generation: id,
					dbPath: this.options.dbPath,
					busyTimeoutMs: this.options.busyTimeoutMs,
				});
			} catch (err) {
				finish(
					false,
					`init postMessage failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		});
	}

	private onSpawnFailure(detail: string): void {
		this.spawnFailures++;
		log.warn(`Payload writer spawn failed: ${detail}`);
		this.scheduleRespawn();
	}

	private scheduleRespawn(): void {
		if (this.disposed || this.writerFatal !== null) return;
		if (this.respawnTimer !== null) return;
		const delay = Math.min(
			PAYLOAD_RESPAWN_MAX_MS,
			PAYLOAD_RESPAWN_BASE_MS * 2 ** this.respawnAttempts,
		);
		this.respawnAttempts++;
		this.respawnTimer = this.setTimer(() => {
			this.respawnTimer = null;
			// A rotation whose replacement spawn failed rolled back to the outgoing
			// generation, so there IS an active generation — but it is over its byte
			// budget and must still be retired. Retry the rotation from the backoff
			// timer; ensureActiveGeneration would simply no-op here.
			const active = this.active;
			if (active && active.publishedBytes >= this.rotationByteBudget) {
				this.maybeRotate();
				return;
			}
			this.ensureActiveGeneration();
		}, delay);
	}

	/** Terminate a generation and forget it. Never touches registry entries. */
	private killGeneration(generation: GenerationState, reason: string): void {
		if (generation.status === "dead") return;
		generation.status = "dead";
		if (generation.readyTimer !== null) {
			this.clearTimer(generation.readyTimer);
			generation.readyTimer = null;
		}
		if (generation.closeTimer !== null) {
			this.clearTimer(generation.closeTimer);
			generation.closeTimer = null;
		}
		try {
			generation.transport.terminate();
		} catch {
			// Terminating an already-dead worker is not an error worth surfacing.
		}
		this.generations.delete(generation.id);
		if (this.active === generation) this.active = null;
		log.debug(
			`Payload writer generation ${generation.id} terminated: ${reason}`,
		);
	}

	private onGenerationDied(generation: GenerationState, detail: string): void {
		const wasActive = this.active === generation;
		this.killGeneration(generation, detail);
		if (this.disposed || !wasActive) return;
		log.warn(`Payload writer generation ${generation.id} died: ${detail}`);
		// Its unacked entries are replayed by the replacement — the generation is
		// already terminated, so no write can still be in flight for them.
		this.scheduleRespawn();
	}

	// -- messages -------------------------------------------------------------

	private handleMessage(
		generation: GenerationState,
		message: PayloadWriteResponse,
	): void {
		switch (message.type) {
			case "ready":
				if (generation.status === "starting") {
					generation.status = "ready";
					generation.onReady?.(true);
					generation.onReady = null;
				}
				return;
			case "error":
				generation.onReady?.(false, message.detail, message.errorClass);
				generation.onReady = null;
				return;
			case "closed":
				// Do NOT mark the generation dead here — `killGeneration` (called
				// by the close waiter) is what actually terminates the thread, and
				// it no-ops on an already-dead generation.
				generation.onClosed?.();
				generation.onClosed = null;
				return;
			case "ack":
				this.handleAck(generation, message.generation, message.results);
				return;
		}
	}

	private handleAck(
		generation: GenerationState,
		ackGeneration: number,
		results: PayloadWriteAck[],
	): void {
		this.lastAckAt = this.now();
		if (this.watchdogUnhealthy) {
			// Progress resumed — clear the no-progress suspension. A writer-fatal
			// suspension is sticky and is NOT cleared here.
			this.watchdogUnhealthy = false;
			if (this.writerFatal === null) this.admissionSuspended = false;
		}

		for (const result of results) {
			const entry = this.unacked.get(result.seq);
			if (!entry) continue;
			// Generation-tagged: a stale generation's ack must never free an entry
			// that has already been replayed onto a newer generation.
			if (
				entry.generation !== ackGeneration ||
				ackGeneration !== generation.id
			) {
				continue;
			}

			if (result.status === "committed") {
				this.committed++;
				this.settle(entry, "committed");
				continue;
			}

			switch (result.errorClass) {
				case "retryable":
					this.scheduleRetry(entry, result.detail);
					break;
				case "writer-fatal":
					this.onWriterFatal(result.detail ?? "unclassified writer failure");
					// Entry is RETAINED (state reset so a future generation replays it).
					entry.state = "buffered";
					entry.generation = null;
					break;
				default:
					this.droppedPermanent++;
					this.settle(entry, "dropped", result.errorClass, result.detail);
					break;
			}
		}
	}

	private scheduleRetry(entry: RegistryEntry, detail?: string): void {
		this.retries++;
		entry.state = "retry_wait";
		entry.generation = null;
		const delay = Math.min(
			PAYLOAD_RETRY_MAX_MS,
			PAYLOAD_RETRY_BASE_MS * 2 ** Math.max(0, entry.attempts - 1),
		);
		if (entry.retryTimer !== null) this.clearTimer(entry.retryTimer);
		entry.retryTimer = this.setTimer(() => {
			entry.retryTimer = null;
			if (!this.unacked.has(entry.seq)) return;
			if (this.dropIfExpired(entry)) return;
			entry.state = "buffered";
			// The retry runs on its own timer, independent of new traffic: a lone
			// entry that hit one SQLITE_BUSY still commits with no further writes.
			this.ensureActiveGeneration();
			this.trySend(entry);
		}, delay);
		if (detail) {
			log.debug(
				`Payload ${entry.requestId} retryable NACK (attempt ${entry.attempts}): ${detail}`,
			);
		}
	}

	private onWriterFatal(detail: string): void {
		if (this.writerFatal !== null) return;
		this.writerFatal = detail;
		this.admissionSuspended = true;
		log.error(
			`Payload writer reported a database-wide failure — payload writes are suspended and ${this.unacked.size} entries are retained: ${detail}`,
		);
	}

	// -- rotation --------------------------------------------------------------

	private maybeRotate(): void {
		if (this.disposed || this.rotating) return;
		// A respawn is already pending on its backoff timer — usually because the
		// previous rotation's replacement failed to spawn. Retrying the spawn on
		// every publish would bypass that backoff entirely and hammer the thread
		// pool for as long as traffic keeps arriving.
		if (this.respawnTimer !== null) return;
		const generation = this.active;
		if (!generation) return;
		if (generation.publishedBytes < this.rotationByteBudget) return;
		this.rotationInFlight = this.rotate(generation);
	}

	private async rotate(outgoing: GenerationState): Promise<void> {
		if (this.rotating) return;
		this.rotating = true;
		try {
			// Stop feeding the outgoing worker: new entries buffer in the registry
			// until the replacement is active.
			this.active = null;

			const replacement = await this.spawnGeneration();
			if (!replacement) {
				// Roll back: the outgoing generation keeps draining and a respawn is
				// already scheduled by onSpawnFailure.
				if (outgoing.status !== "dead") this.active = outgoing;
				return;
			}

			await this.closeGeneration(outgoing, PAYLOAD_ROTATION_DEADLINE_MS);
			// The replacement can die (crash, close event) while the outgoing
			// worker is still closing. Installing a dead generation as active would
			// wedge the client permanently: everything would buffer against a
			// thread that no longer exists, and the watchdog — which only looks at
			// SENT entries — would keep reporting healthy.
			if (
				replacement.status !== "ready" ||
				!this.generations.has(replacement.id)
			) {
				log.warn(
					`Payload writer replacement generation ${replacement.id} died during cutover — respawning`,
				);
				this.active = null;
				this.scheduleRespawn();
				return;
			}
			// Only now — the outgoing worker is closed or terminated — does the
			// replacement become active, so two writers are never active at once.
			this.active = replacement;
			this.rotations++;
		} finally {
			this.rotating = false;
			this.rotationInFlight = null;
			if (this.active) this.replayToActive();
		}
	}

	/** Ask a generation to close; terminate it if it misses the deadline. */
	private closeGeneration(
		generation: GenerationState,
		deadlineMs: number,
	): Promise<void> {
		if (generation.status === "dead") return Promise.resolve();
		if (deadlineMs <= 0) {
			// No grace at all — terminate straight away rather than waiting for a
			// close-ack that we would not honor anyway.
			this.killGeneration(generation, "closed (no grace)");
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			let settled = false;
			const done = (): void => {
				if (settled) return;
				settled = true;
				if (generation.closeTimer !== null) {
					this.clearTimer(generation.closeTimer);
					generation.closeTimer = null;
				}
				this.killGeneration(generation, "closed");
				resolve();
			};

			generation.onClosed = done;
			generation.status = "closing";
			generation.closeTimer = this.setTimer(() => {
				generation.closeTimer = null;
				log.warn(
					`Payload writer generation ${generation.id} missed its ${deadlineMs}ms close deadline — terminating`,
				);
				done();
			}, deadlineMs);

			try {
				generation.transport.postMessage({
					type: "close",
					generation: generation.id,
				});
			} catch {
				done();
			}
		});
	}

	// -- watchdog ---------------------------------------------------------------

	private startWatchdog(): void {
		if (this.watchdogTimer !== null || this.disposed) return;
		const tick = (): void => {
			this.watchdogTimer = null;
			this.runWatchdog();
			if (!this.disposed) {
				this.watchdogTimer = this.setTimer(tick, PAYLOAD_WATCHDOG_INTERVAL_MS);
			}
		};
		this.watchdogTimer = this.setTimer(tick, PAYLOAD_WATCHDOG_INTERVAL_MS);
	}

	private runWatchdog(): void {
		if (this.disposed || this.writerFatal !== null) return;

		let oldestSentAt: number | null = null;
		for (const entry of this.unacked.values()) {
			if (entry.state !== "sent") continue;
			if (oldestSentAt === null || entry.sentAt < oldestSentAt) {
				oldestSentAt = entry.sentAt;
			}
		}
		if (oldestSentAt === null) {
			// Nothing is in flight — an idle writer is not a stalled writer.
			this.lastAckAt = this.now();
			if (this.watchdogUnhealthy) {
				this.watchdogUnhealthy = false;
				this.admissionSuspended = false;
			}
			return;
		}

		const now = this.now();
		const noProgressMs = Math.min(now - oldestSentAt, now - this.lastAckAt);

		if (noProgressMs >= PAYLOAD_NO_PROGRESS_FENCE_MS) {
			this.fence(noProgressMs);
			return;
		}
		if (
			noProgressMs >= PAYLOAD_NO_PROGRESS_UNHEALTHY_MS &&
			!this.watchdogUnhealthy
		) {
			this.watchdogUnhealthy = true;
			this.admissionSuspended = true;
			log.warn(
				`Payload writer made no progress for ${Math.round(noProgressMs)}ms with ${this.unacked.size} entries pending — admission suspended`,
			);
		}
	}

	/**
	 * Terminate the stalled generation FIRST, then replay. Doing it in this order
	 * is what guarantees a fenced worker cannot still be writing the entries the
	 * replacement is about to write.
	 */
	private fence(noProgressMs: number): void {
		const generation = this.active;
		if (!generation) return;
		this.fences++;
		log.error(
			`Fencing payload writer generation ${generation.id} after ${Math.round(noProgressMs)}ms without progress`,
		);
		this.killGeneration(generation, "fenced (no progress)");
		for (const entry of this.unacked.values()) {
			if (entry.state === "sent") {
				entry.state = "buffered";
				entry.generation = null;
			}
		}
		this.lastAckAt = this.now();
		this.watchdogUnhealthy = true;
		this.admissionSuspended = true;
		this.scheduleRespawn();
	}

	// -- disposal ----------------------------------------------------------------

	dispose(deadlineMs: number = PAYLOAD_DISPOSE_DEADLINE_MS): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposePromise = this.doDispose(deadlineMs);
		return this.disposePromise;
	}

	private async doDispose(deadlineMs: number): Promise<void> {
		// Stop admission and rotation before anything else.
		this.disposed = true;
		this.admissionSuspended = true;

		if (this.watchdogTimer !== null) {
			this.clearTimer(this.watchdogTimer);
			this.watchdogTimer = null;
		}
		if (this.respawnTimer !== null) {
			this.clearTimer(this.respawnTimer);
			this.respawnTimer = null;
		}
		for (const entry of this.unacked.values()) {
			if (entry.retryTimer !== null) {
				this.clearTimer(entry.retryTimer);
				entry.retryTimer = null;
			}
		}

		try {
			// A spawn may be in flight with entries already buffered behind it —
			// give it (bounded) time to land so a shutdown right after a respawn
			// does not abandon work the worker could still have flushed.
			if (this.spawnInFlight && this.unacked.size > 0) {
				await this.raceDeadline(this.spawnInFlight, deadlineMs);
			}
			// Likewise for a rotation: while it runs `active` is null, so reading it
			// now would skip the graceful handover entirely and abandon everything
			// unacked. Wait (bounded) for the rotation to settle on a generation.
			if (this.rotationInFlight) {
				await this.raceDeadline(this.rotationInFlight, deadlineMs);
			}

			const active = this.active;
			if (active && active.status === "ready" && this.writerFatal === null) {
				// Hand over anything still buffered, then let the worker flush and
				// close-ack within the deadline.
				for (const entry of [...this.unacked.values()]) {
					if (entry.state === "sent" && entry.generation === active.id)
						continue;
					entry.state = "buffered";
					entry.generation = null;
					this.sendDuringDispose(active, entry);
				}
				await this.closeGeneration(active, deadlineMs);
			}
		} finally {
			for (const generation of [...this.generations.values()]) {
				this.killGeneration(generation, "disposed");
			}
			this.active = null;
			for (const entry of [...this.unacked.values()]) {
				this.abandoned++;
				this.settle(entry, "abandoned");
			}
		}
	}

	/** Resolve when `promise` settles or `ms` elapses, whichever comes first. */
	private raceDeadline(promise: Promise<unknown>, ms: number): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		return new Promise<void>((resolve) => {
			let settled = false;
			const timer = this.setTimer(() => {
				if (settled) return;
				settled = true;
				resolve();
			}, ms);
			void promise.then(
				() => {
					if (settled) return;
					settled = true;
					this.clearTimer(timer);
					resolve();
				},
				() => {
					if (settled) return;
					settled = true;
					this.clearTimer(timer);
					resolve();
				},
			);
		});
	}

	/** Like trySend, but bypasses the (now suspended) admission guards. */
	private sendDuringDispose(
		generation: GenerationState,
		entry: RegistryEntry,
	): void {
		entry.state = "sent";
		entry.generation = generation.id;
		entry.sentAt = this.now();
		entry.attempts++;
		try {
			generation.transport.postMessage({
				type: "write",
				generation: generation.id,
				seq: entry.seq,
				id: entry.requestId,
				ciphertext: entry.ciphertext,
				timestamp: entry.timestamp,
			});
		} catch {
			entry.state = "buffered";
			entry.generation = null;
		}
	}
}
