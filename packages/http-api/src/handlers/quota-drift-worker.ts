import { Database } from "bun:sqlite";
import { computeQuotaDrift } from "./quota-drift-compute";

/**
 * Dedicated read-only worker for the quota-drift precompute pass.
 *
 * Separate from the shared dashboard worker on purpose: this pass is a
 * scheduled batch job measured in seconds over the whole snapshot and request
 * history, and queueing it behind (or ahead of) interactive panel reads on a
 * lane that serves requests strictly one at a time would head-of-line block
 * them. The ENDPOINT that serves the result is a single-row read and does ride
 * the shared light lane — nothing here is on a request path.
 *
 * Connection setup mirrors analytics-worker.ts exactly: `readonly: true`, a
 * busy timeout, then `PRAGMA query_only = ON`. Both are kept. The pass does its
 * segment↔request join in JS precisely so it never needs to write a TEMP table,
 * which query_only would reject (see quota-drift-compute.ts).
 */
export interface QuotaDriftWorkerRequest {
	id: string;
	dbPath: string;
	busyTimeoutMs: number;
	/** Wall clock stamped onto the payload, so the caller owns the clock. */
	now: number;
}

export interface QuotaDriftWorkerResponse {
	id: string;
	ok: boolean;
	/** Serialized `QuotaDriftResponse`; empty when `ok` is false. */
	payload: string;
	error?: string;
	/** Wall-clock the pass took, including opening the connection. */
	totalMs: number;
}

self.onmessage = (event: MessageEvent<QuotaDriftWorkerRequest>) => {
	const startedAt = performance.now();
	const { id, dbPath, busyTimeoutMs, now } = event.data;
	let db: Database | undefined;

	try {
		db = new Database(dbPath, { readonly: true });
		db.exec(
			`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(Number(busyTimeoutMs) || 10000))}`,
		);
		db.exec("PRAGMA query_only = ON");

		const payload = JSON.stringify(computeQuotaDrift(db, { now }));
		db.close();
		db = undefined;

		self.postMessage({
			id,
			ok: true,
			payload,
			totalMs: performance.now() - startedAt,
		} satisfies QuotaDriftWorkerResponse);
	} catch (error) {
		db?.close();
		self.postMessage({
			id,
			ok: false,
			payload: "",
			error: error instanceof Error ? error.message : String(error),
			totalMs: performance.now() - startedAt,
		} satisfies QuotaDriftWorkerResponse);
	}
};
