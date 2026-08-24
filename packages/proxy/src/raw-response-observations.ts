import { Logger } from "@clankermux/logger";
import { extractRawOpenAiBuckets } from "@clankermux/openai-formats";
import { extractRawCodexWindows } from "@clankermux/providers";
import type {
	Account,
	CodexWindowObservationRow,
	OpenAiBucketObservationRow,
	UnifiedClaimObservationSource,
} from "@clankermux/types";

const log = new Logger("RawResponseObservations");

/**
 * The RAW upstream-response observation hook.
 *
 * ## Why it lives here and not in a provider
 *
 * The readings this captures are destroyed on the way to the client, and each is
 * destroyed by a different layer:
 *
 *  - `sanitizeHeaders` (openai-formats) deletes the entire `x-ratelimit-*`
 *    family, so the bucket readings exist only while the raw response does;
 *  - the Codex provider NORMALIZES its window headers into `UsageData`, which is
 *    lossy in exactly the dimensions a series needs — it slots by duration
 *    (dropping the per-family 5-hour slots), collapses placeholder windows, and
 *    substitutes a default utilization on a 429.
 *
 * So the capture has to happen BEFORE `provider.processResponse` runs. It could
 * not live in the provider packages regardless: those have no database
 * dependency and must not acquire one, which is why they expose PURE header
 * extractors and this module owns the sink.
 *
 * ## One observation per upstream ATTEMPT
 *
 * `observationId` is minted per call. A retry or failover produces several
 * responses for one logical request, possibly from different accounts, and
 * folding them under the request id would average readings that describe
 * different quota states. `requestId` correlates them and is deliberately not
 * unique in either table.
 *
 * ## One clock
 *
 * `observedAt` is read ONCE here and threaded into the extractors, so every row
 * from one response is dated identically — including the Codex windows whose
 * reset is reported as a relative offset and must be resolved against the
 * instant the headers arrived, not against a later clock read.
 */

/** Everything the hook needs, gathered at the raw-response site. */
export interface RawUpstreamObservationInput {
	/** Logical request id — correlation only. */
	requestId: string;
	account: Account | null;
	/** Which dispatch produced this attempt. */
	source: UnifiedClaimObservationSource;
	/** Request start, ms since epoch. */
	requestStartedAt: number;
	/** Upstream path this attempt was made against; null when unknown. */
	endpoint: string | null;
	httpStatus: number;
	/** The RAW upstream headers, before any provider transform or sanitizer. */
	headers: Headers;
}

/** The async sink the rows are handed to; the real one is the proxy context. */
export interface RawObservationSink {
	asyncWriter: { enqueue(job: () => void | Promise<void>): boolean };
	dbOps: {
		saveCodexWindowObservations(
			rows: CodexWindowObservationRow[],
		): Promise<void>;
		saveOpenAiBucketObservations(
			rows: OpenAiBucketObservationRow[],
		): Promise<void>;
	};
}

/**
 * Capture whatever raw rate-limit evidence this upstream response carried.
 *
 * Gated on the HEADERS, not on the provider name: the extractors yield nothing
 * for a response that carries none of their lines, so a backend this proxy has
 * no model of costs one map lookup and writes nothing. An unauthenticated
 * attempt is skipped entirely — the rows are keyed to an account.
 *
 * Never throws: a capture failure must not take down a response that already
 * succeeded upstream.
 */
export function captureRawUpstreamObservation(
	input: RawUpstreamObservationInput,
	sink: RawObservationSink,
): void {
	const account = input.account;
	if (!account) return;

	// The ONE clock read for this attempt.
	const observedAt = Date.now();
	const observationId = crypto.randomUUID();

	const codexReadings = extractRawCodexWindows(input.headers, observedAt);
	if (codexReadings.length > 0) {
		const rows: CodexWindowObservationRow[] = codexReadings.map((reading) => ({
			observationId,
			requestId: input.requestId,
			accountId: account.id,
			source: input.source,
			httpStatus: input.httpStatus,
			requestStartedAt: input.requestStartedAt,
			observedAt,
			scope: reading.scope,
			familyCodename: reading.familyCodename,
			slot: reading.slot,
			limitName: reading.limitName,
			usedPercent: reading.usedPercent,
			windowMinutes: reading.windowMinutes,
			resetAt: reading.resetAtMs,
			activeLimit: reading.activeLimit,
		}));
		const accepted = sink.asyncWriter.enqueue(() =>
			sink.dbOps.saveCodexWindowObservations(rows),
		);
		if (!accepted) {
			log.warn(
				`Dropped ${rows.length} Codex window observation rows for request ` +
					`${input.requestId} (account=${account.name}): the metadata write queue is at capacity`,
			);
		}
	}

	const bucketReadings = extractRawOpenAiBuckets(input.headers);
	if (bucketReadings.length > 0) {
		const rows: OpenAiBucketObservationRow[] = bucketReadings.map(
			(reading) => ({
				observationId,
				requestId: input.requestId,
				accountId: account.id,
				bucket: reading.bucket,
				requestStartedAt: input.requestStartedAt,
				observedAt,
				httpStatus: input.httpStatus,
				endpoint: input.endpoint,
				limitValue: reading.limitValue,
				remaining: reading.remaining,
				resetRaw: reading.resetRaw,
			}),
		);
		const accepted = sink.asyncWriter.enqueue(() =>
			sink.dbOps.saveOpenAiBucketObservations(rows),
		);
		if (!accepted) {
			log.warn(
				`Dropped ${rows.length} OpenAI bucket observation rows for request ` +
					`${input.requestId} (account=${account.name}): the metadata write queue is at capacity`,
			);
		}
	}
}
