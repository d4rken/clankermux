/**
 * A hand-driven stand-in for the storage-usage worker, plus the bookkeeping
 * that makes "two scans, never at the same time" an assertable claim.
 *
 * A real scan of a temp DB finishes in milliseconds, so two calls never
 * actually overlap, and a real worker cannot be held open, failed on demand or
 * left silent. Every worker handed out here does nothing on its own: the test
 * finishes it with `respond`, splits the result from the close with
 * `respondWithoutAck` + `acknowledge`, or leaves it silent so the runner's
 * timeout fires.
 *
 * Installing this replaces storage-usage workers only. Anything else a caller
 * spawns — `cleanupOldRequests`' incremental-vacuum worker, notably — keeps
 * running for real, which is why the runner takes a factory instead of the
 * tests stubbing `globalThis.Worker`.
 */

import { setStorageUsageWorkerFactoryForTests } from "../storage-usage-runner";
import type {
	StorageUsageScanRequest,
	StorageUsageScanResult,
	StorageUsageWorkerMessage,
} from "../storage-usage-worker";

export type FakeWorker = {
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	postMessage: (data: unknown) => void;
	terminate: () => void;
	/** The scan request this worker was handed, for echoing its table list back. */
	request: StorageUsageScanRequest | null;
	/**
	 * Finish this worker's scan with `result` and acknowledge a clean close in
	 * the same tick — the sequence the real worker posts.
	 */
	respond: (result: StorageUsageScanResult) => void;
	/** Finish the scan and say nothing about the close. */
	respondWithoutAck: (result: StorageUsageScanResult) => void;
	/** Acknowledge the close; an `error` makes it a failed one. */
	acknowledge: (error?: string) => void;
};

export type FakeWorkerLog = {
	/** Construction and termination in call order. */
	readonly events: string[];
	readonly count: number;
	/** Resolves once the nth worker (1-based) has been constructed. */
	nth(index: number): Promise<FakeWorker>;
};

/**
 * Install the factory. A `construct:n` entry that follows `terminate:n-1` in
 * `events` is how sequencing is asserted without depending on how many turns
 * of the loop a caller takes to reach the runner.
 */
export function installFakeWorkers(): FakeWorkerLog {
	const workers: FakeWorker[] = [];
	const events: string[] = [];
	const awaited = new Map<number, () => void>();

	setStorageUsageWorkerFactoryForTests(() => {
		const index = workers.length + 1;
		const post = (message: StorageUsageWorkerMessage) => {
			fake.onmessage?.({ data: message } as MessageEvent);
		};
		const fake: FakeWorker = {
			onmessage: null,
			onerror: null,
			request: null,
			postMessage: (data) => {
				fake.request = data as StorageUsageScanRequest;
			},
			terminate: () => {
				events.push(`terminate:${index}`);
			},
			respondWithoutAck: (result) => post({ kind: "result", result }),
			acknowledge: (error) =>
				post(
					error === undefined
						? { kind: "close", closed: true }
						: { kind: "close", closed: false, error },
				),
			respond: (result) => {
				fake.respondWithoutAck(result);
				fake.acknowledge();
			},
		};
		workers.push(fake);
		events.push(`construct:${index}`);
		awaited.get(index)?.();
		awaited.delete(index);
		return fake as unknown as Worker;
	});

	return {
		events,
		get count(): number {
			return workers.length;
		},
		async nth(index: number): Promise<FakeWorker> {
			if (workers.length < index) {
				await new Promise<void>((resolve) => {
					awaited.set(index, resolve);
				});
			}
			return workers[index - 1];
		},
	};
}

/**
 * A result over exactly the tables this worker was asked for, with `rowCount`
 * as the marker that tells one scan's numbers from the next scan's.
 */
export function measuredAs(
	worker: FakeWorker,
	rowCount: number,
): StorageUsageScanResult {
	return {
		ok: true,
		types: (worker.request?.tables ?? []).map(({ key, table }) => ({
			key,
			table,
			rowCount,
			approxBytes: rowCount * 10,
		})),
	};
}

/** Let every pending continuation run, so "no worker was built" is a real claim. */
export async function settleQueue(): Promise<void> {
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
}
