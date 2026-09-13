import { Logger } from "@clankermux/logger";
import type { QuotaDriftResponse } from "@clankermux/types";
import { EMBEDDED_QUOTA_DRIFT_WORKER_CODE } from "./inline-quota-drift-worker";
import type {
	QuotaDriftWorkerRequest,
	QuotaDriftWorkerResponse,
} from "./quota-drift-worker";

const log = new Logger("QuotaDriftPrecompute");

/**
 * Main-thread client for the quota-drift precompute worker.
 *
 * Owns the Worker spawn so the scheduler (which lives in apps/server) never has
 * to resolve a module URL into this package. One worker per pass, terminated as
 * soon as it answers: the pass runs every 30 minutes, so keeping a connection
 * and a thread alive between runs buys nothing and costs a file handle on the
 * database for the other 29.
 *
 * A pass that exceeds the deadline is abandoned and its worker terminated. The
 * caller keeps the previously stored row in that case — a stale result is
 * strictly better than a blank panel, and a wedged pass must not accumulate
 * threads at the 30-minute cadence.
 */
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * Hard deadline for one pass. Measured against the live database (155k
 * snapshots, 590k requests, ~82 days), a full pass is far below this; the
 * ceiling exists so a pathological growth in history cannot leave a worker
 * running into the next tick.
 */
export const QUOTA_DRIFT_PASS_TIMEOUT_MS = 10 * 60_000;

/** Structural view of the Worker, so a test can substitute a stub. */
export type QuotaDriftWorkerLike = {
	postMessage(message: QuotaDriftWorkerRequest): void;
	terminate(): void;
	onmessage: ((event: MessageEvent<QuotaDriftWorkerResponse>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	unref?: () => void;
	/**
	 * Release the Blob object URL an embedded-path worker was spawned from.
	 * Idempotent, and absent on the source-path worker and on test stubs.
	 */
	releaseSource?: () => void;
};

let workerFactoryOverride: (() => QuotaDriftWorkerLike) | null = null;

/**
 * Spawn the real precompute Worker: from the embedded base64 bundle when one
 * was built, from the on-disk source otherwise (development, tests).
 *
 * The embedded path is what makes this worker exist at all in the compiled
 * single-file binary — `bun build --compile` does not follow a
 * `new URL("./quota-drift-worker.ts", import.meta.url)` target, so the file URL
 * resolves to a `/$bunfs/root/…` path that is not there, and the failure
 * surfaces only through `onerror`.
 *
 * The object URL is NOT revoked straight after `new Worker(url)`: Bun resolves
 * it while the thread boots, and revoking synchronously fails the spawn with
 * "Blob URL is missing". A pass terminates its worker as soon as it settles, so
 * `releaseSource` rides that path — one blob per pass would otherwise be leaked
 * every 30 minutes.
 */
function createRealWorker(): QuotaDriftWorkerLike {
	if (!EMBEDDED_QUOTA_DRIFT_WORKER_CODE) {
		return new Worker(
			new URL("./quota-drift-worker.ts", import.meta.url).href,
			{
				smol: true,
			},
		) as unknown as QuotaDriftWorkerLike;
	}

	const code = Buffer.from(EMBEDDED_QUOTA_DRIFT_WORKER_CODE, "base64").toString(
		"utf8",
	);
	let objectUrl: string | null = URL.createObjectURL(
		new Blob([code], { type: "text/javascript" }),
	);
	let worker: Worker;
	try {
		worker = new Worker(objectUrl, { smol: true });
	} catch (error) {
		// Nothing will exist to release the URL later, so release it here — a
		// throwing constructor would otherwise leak the blob for the process
		// lifetime, once per failed spawn.
		URL.revokeObjectURL(objectUrl);
		objectUrl = null;
		throw error;
	}

	const workerLike = worker as unknown as QuotaDriftWorkerLike;
	workerLike.releaseSource = () => {
		if (objectUrl === null) return;
		URL.revokeObjectURL(objectUrl);
		objectUrl = null;
	};
	return workerLike;
}

export interface RunQuotaDriftPassOptions {
	dbPath: string;
	/** Wall clock stamped onto the payload. */
	now: number;
	timeoutMs?: number;
}

/** One completed pass: the payload plus how long the worker actually took. */
export interface QuotaDriftPassResult {
	payload: QuotaDriftResponse;
	workerMs: number;
}

/**
 * Run one precompute pass on a dedicated worker and resolve with its payload.
 *
 * Rejects on worker error, on a malformed payload, and on the deadline. It
 * never writes anything: the worker's connection is read-only, so persistence
 * is the caller's job on the main thread.
 */
export function runQuotaDriftPass(
	options: RunQuotaDriftPassOptions,
): Promise<QuotaDriftPassResult> {
	const timeoutMs = options.timeoutMs ?? QUOTA_DRIFT_PASS_TIMEOUT_MS;
	const id = crypto.randomUUID();

	return new Promise<QuotaDriftPassResult>((resolve, reject) => {
		const worker = (workerFactoryOverride ?? createRealWorker)();
		let settled = false;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker.releaseSource?.();
			try {
				worker.terminate();
			} catch {
				// Worker already gone.
			}
			fn();
		};

		const timer = setTimeout(() => {
			finish(() =>
				reject(
					new Error(`quota-drift precompute timed out after ${timeoutMs}ms`),
				),
			);
		}, timeoutMs);
		// The pass is a background job; it must never hold the process open.
		(timer as { unref?: () => void }).unref?.();
		worker.unref?.();

		worker.onmessage = (event: MessageEvent<QuotaDriftWorkerResponse>) => {
			const data = event.data;
			if (data.id !== id) return;
			finish(() => {
				if (!data.ok) {
					reject(new Error(data.error ?? "quota-drift precompute failed"));
					return;
				}
				try {
					resolve({
						payload: JSON.parse(data.payload) as QuotaDriftResponse,
						workerMs: data.totalMs,
					});
				} catch (error) {
					reject(
						new Error(
							`quota-drift precompute returned an unreadable payload: ${
								error instanceof Error ? error.message : String(error)
							}`,
						),
					);
				}
			});
		};

		worker.onerror = (event: ErrorEvent) => {
			finish(() =>
				reject(new Error(event.message || "quota-drift worker error")),
			);
		};

		try {
			worker.postMessage({
				id,
				dbPath: options.dbPath,
				busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
				now: options.now,
			} satisfies QuotaDriftWorkerRequest);
		} catch (error) {
			log.error(`Failed to dispatch quota-drift pass: ${error}`);
			finish(() =>
				reject(error instanceof Error ? error : new Error(String(error))),
			);
		}
	});
}

/**
 * Test seam: swap the precompute Worker for a controllable stub. Pass null to
 * restore the real factory.
 */
export function __setQuotaDriftWorkerFactoryForTests(
	factory: (() => QuotaDriftWorkerLike) | null,
): void {
	workerFactoryOverride = factory;
}
