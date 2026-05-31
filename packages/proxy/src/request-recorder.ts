import { BUFFER_SIZES } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { NO_ACCOUNT_ID, type RequestResponse } from "@clankermux/types";

const log = new Logger("RequestRecorder");

// Re-exported so consumers/tests of the recorder get the account-identity
// sentinel without a separate value-import of the `@clankermux/types` barrel.
// Importing that barrel as a *value* before `@clankermux/core` triggers a
// latent module-eval cycle (types/agent.ts → core → core/strategy.ts reads
// StrategyName before types finishes initializing it). The recorder imports
// core first, so re-exporting from here keeps the load order safe.
export { NO_ACCOUNT_ID };

/**
 * RequestRecorder — main-thread owner of request persistence.
 *
 * Owns request persistence on the main thread so large request bodies are never
 * transferred into a long-lived worker (Bun #5709: structured-clone backing
 * stores are never reclaimed). This coordinator owns:
 *
 *   - the per-request lifecycle state machine + terminal outcomes,
 *   - billingType derivation + account side-effects (auto-pause-on-overage,
 *     updateAccountUsage) fired IMMEDIATELY in begin() (invariant 4),
 *   - the payload JSON envelope (stable shape the Request History reader reads),
 *   - FK-ordered persistence (request row → routing row → payload),
 *   - payload-drop policy that never takes the metadata row with it,
 *   - dedupe (persist at most once per requestId),
 *   - a hard CAPTURE_BYTES_BUDGET + age sweep so live snapshots stay bounded,
 *   - emitting the dashboard "summary" RequestResponse event.
 *
 * All collaborators are dependency-injected so it is fully unit-testable without
 * a real DB / timers.
 */

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Routing telemetry mirror (matches StartMessage.routing minus the transfer). */
export interface RecordRouting {
	strategy: string;
	decision: string;
	affinityScope: string | null;
	affinityKeyHash: string | null;
	selectedAccountId: string | null;
	previousAccountId: string | null;
	candidatesCount: number | null;
	failoverReason: string | null;
}

/**
 * Request metadata the main thread already holds when forwarding to the client
 * — mirrors `StartMessage` minus the body transfer. `requestBody` is an
 * already-capped copy (ArrayBuffer) or null.
 */
export interface RecordMeta {
	requestId: string;
	method: string;
	path: string;
	accountId: string | null;
	accountName: string | null;
	responseStatus: number;
	responseHeaders: Record<string, string>;
	requestHeaders: Record<string, string>;
	isStream: boolean;
	providerName: string;
	accountBillingType: string | null;
	accountAutoPauseOnOverageEnabled: number | null;
	/** True when accountId is set and != NO_ACCOUNT_ID. */
	authed: boolean;
	agentUsed: string | null;
	apiKeyId: string | null;
	apiKeyName: string | null;
	comboName: string | null;
	project: string | null;
	routing: RecordRouting | null;
	timestamp: number;
	/** Pre-capped request body copy, or null when not captured / over budget. */
	requestBody: ArrayBuffer | null;
	retryAttempt: number;
	failoverAttempts: number;
}

/**
 * Slim usage summary produced by the inline usage-collector (see
 * usage-collector.ts) and attached via {@link RequestRecorder.attachUsageSummary}.
 */
export interface SlimUsageSummary {
	requestId: string;
	usage: {
		model?: string;
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		totalTokens?: number;
		costUsd?: number;
	};
	tokensPerSecond?: number;
	responseTimeMs?: number;
	cacheCreationInputTokens?: number;
}

export type TransportOutcome = "success" | "error" | "disconnect" | "timeout";

export interface RequestRecorderConfig {
	/** Hard total byte budget for live captured snapshots (req + resp). */
	CAPTURE_BYTES_BUDGET: number;
	/** Hard cap on concurrent records. */
	MAX_RECORDS: number;
	/** How long to wait for a usage summary after transport finish. */
	SUMMARY_GRACE_MS: number;
	/** Max age of any record before the sweep frees/finalizes it. */
	RECORD_MAX_AGE_MS: number;
	/** How long a persisted no-usage record is kept for a late patch. */
	PATCH_RECORD_TTL_MS: number;
	/** Stored request body cap (base64-encoded into the envelope). */
	MAX_REQUEST_BODY_BYTES: number;
	/** Stored response body cap. */
	MAX_RESPONSE_BODY_BYTES: number;
}

/**
 * Persisted routing-row shape. Mirrors `RequestRoutingData`
 * (database/src/repositories/request.repository.ts) so the recorder's
 * `DbOpsLike` is assignable from the real `DatabaseOperations` at the seam
 * (it requires this precise shape, not an arbitrary record). Kept inline so
 * the recorder stays decoupled from the database package's concrete types.
 */
interface SaveRoutingData {
	requestId: string;
	strategy: string;
	decision: string;
	affinityScope?: string | null;
	affinityKeyHash?: string | null;
	selectedAccountId?: string | null;
	previousAccountId?: string | null;
	candidatesCount?: number | null;
	failoverAttempts?: number | null;
	failoverReason?: string | null;
	createdAt?: number;
}

interface DbOpsLike {
	saveRequest(
		id: string,
		method: string,
		path: string,
		accountUsed: string | null,
		statusCode: number | null,
		success: boolean,
		errorMessage: string | null,
		responseTime: number,
		failoverAttempts: number,
		usage?: unknown,
		agentUsed?: string,
		apiKeyId?: string,
		apiKeyName?: string,
		project?: string | null,
		billingType?: string,
		comboName?: string | null,
	): Promise<void>;
	saveRequestRouting(data: SaveRoutingData): Promise<void>;
	saveRequestPayloadRaw(id: string, json: string): Promise<void>;
	updateRequestUsage(requestId: string, usage: unknown): Promise<void>;
	pauseAccount(accountId: string, reason: string): Promise<void>;
	updateAccountUsage(accountId: string): Promise<void>;
}

interface AsyncWriterLike {
	enqueue(job: () => void | Promise<void>): boolean;
	canAcceptPayload(bytes: number): boolean;
	recordPayloadDrop(bytes: number): void;
	enqueuePayload(
		id: string,
		bytes: number,
		run: () => void | Promise<void>,
	): boolean;
}

export interface RequestRecorderDeps {
	dbOps: DbOpsLike;
	asyncWriter: AsyncWriterLike;
	emitSummaryEvent: (response: RequestResponse) => void;
	getStorePayloads: () => boolean;
	now?: () => number;
	scheduleTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (id: unknown) => void;
	/** Optional hook fired when a request-row metadata enqueue is dropped. */
	onMetadataDrop?: (requestId: string) => void;
	config?: Partial<RequestRecorderConfig>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: RequestRecorderConfig = {
	// Bound total live captured snapshots so N concurrent 4 MB requests can't
	// pile up. Sized for realistic in-flight concurrency.
	CAPTURE_BYTES_BUDGET: 64 * 1024 * 1024,
	MAX_RECORDS: 5000,
	// Short grace: the inline collector finalizes usage right after the stream
	// ends (an async cost lookup), so a couple seconds covers that gap without
	// false-failing the record.
	SUMMARY_GRACE_MS: 5_000,
	// Backstop: any record older than this is freed/finalized. Aligns with the
	// longest a live stream may run (cf. cache-body-store STAGING_MAX_AGE_MS).
	RECORD_MAX_AGE_MS: 35 * 60 * 1000,
	PATCH_RECORD_TTL_MS: 60 * 1000,
	MAX_REQUEST_BODY_BYTES: BUFFER_SIZES.MAX_REQUEST_BODY_BYTES,
	MAX_RESPONSE_BODY_BYTES: 256 * 1024,
};

/** Providers whose accounts carry a subscription plan (vs pay-as-you-go API). */
const PLAN_PROVIDERS = new Set([
	"anthropic",
	"zai",
	"alibaba-coding-plan",
	"ollama",
	"ollama-cloud",
	"qwen",
	"codex",
]);

// ---------------------------------------------------------------------------
// Internal record
// ---------------------------------------------------------------------------

interface InternalRecord {
	meta: RecordMeta;
	billingType: string;
	/** Captured request body bytes (base64-encodable), null when discarded. */
	reqBytes: Uint8Array | null;
	/** Captured (capped) response body bytes. */
	respChunks: Uint8Array[];
	respBytes: number;
	/** Total bytes this record charges against the capture budget. */
	chargedBytes: number;
	transport: { outcome: TransportOutcome } | null;
	usage: SlimUsageSummary | null;
	usageWaived: boolean;
	bodyDiscarded: boolean;
	persisted: boolean;
	createdAt: number;
	/** When the record was persisted; null until then. Anchors the patch TTL. */
	persistedAt: number | null;
	graceTimer: unknown;
	patchTimer: unknown;
}

export class RequestRecorder {
	private readonly dbOps: DbOpsLike;
	private readonly asyncWriter: AsyncWriterLike;
	private readonly emitSummaryEvent: (response: RequestResponse) => void;
	private readonly getStorePayloads: () => boolean;
	private readonly now: () => number;
	private readonly scheduleTimer: (cb: () => void, ms: number) => unknown;
	private readonly clearTimer: (id: unknown) => void;
	private readonly onMetadataDrop?: (requestId: string) => void;
	private readonly config: RequestRecorderConfig;

	private readonly records = new Map<string, InternalRecord>();
	private capturedBytesPending = 0;
	private metadataDropped = 0;
	private sweepTimer: unknown = null;

	constructor(deps: RequestRecorderDeps) {
		this.dbOps = deps.dbOps;
		this.asyncWriter = deps.asyncWriter;
		this.emitSummaryEvent = deps.emitSummaryEvent;
		this.getStorePayloads = deps.getStorePayloads;
		this.now = deps.now ?? Date.now;
		this.scheduleTimer =
			deps.scheduleTimer ?? ((cb, ms) => setTimeout(cb, ms) as unknown);
		this.clearTimer =
			deps.clearTimer ??
			((id) => clearTimeout(id as Parameters<typeof clearTimeout>[0]));
		this.onMetadataDrop = deps.onMetadataDrop;
		this.config = { ...DEFAULT_CONFIG, ...deps.config };
	}

	// -------------------------------------------------------------------------
	// Observability (for tests / health)
	// -------------------------------------------------------------------------

	getCapturedBytesPending(): number {
		return this.capturedBytesPending;
	}

	getMetadataDropped(): number {
		return this.metadataDropped;
	}

	getRecordCount(): number {
		return this.records.size;
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	/**
	 * Start tracking a recordable request. Fires account side-effects
	 * IMMEDIATELY (invariant 4) and captures the request body only within the
	 * byte budget (invariant 1).
	 */
	begin(meta: RecordMeta): void {
		// Dedupe: a duplicate begin() for the same id keeps the original record.
		if (this.records.has(meta.requestId)) {
			return;
		}

		const billingType = this.deriveBillingType(meta);

		// (A) Account side-effects fire IMMEDIATELY — not at persist — so a long
		//     stream pauses/re-routes the moment overage is seen.
		if (
			billingType === "overage" &&
			meta.accountAutoPauseOnOverageEnabled === 1 &&
			meta.accountId
		) {
			const accountId = meta.accountId;
			const accountName = meta.accountName || "unknown";
			log.info(
				`Auto-pausing account '${accountName}' (${accountId}) due to overage detection (auto-pause-on-overage enabled)`,
			);
			this.asyncWriter.enqueue(async () => {
				await this.dbOps.pauseAccount(accountId, "overage");
			});
		}
		if (meta.authed && meta.accountId && meta.accountId !== NO_ACCOUNT_ID) {
			const accountId = meta.accountId;
			this.asyncWriter.enqueue(async () => {
				await this.dbOps.updateAccountUsage(accountId);
			});
		}

		// (B) Capture request body ONLY within the byte budget; else metadata-only.
		let reqBytes: Uint8Array | null = null;
		let bodyDiscarded = false;
		let chargedBytes = 0;
		const storePayloads = this.getStorePayloads();
		if (storePayloads && meta.requestBody && meta.requestBody.byteLength > 0) {
			const raw = new Uint8Array(meta.requestBody);
			const capped =
				raw.byteLength > this.config.MAX_REQUEST_BODY_BYTES
					? raw.subarray(0, this.config.MAX_REQUEST_BODY_BYTES)
					: raw;
			// Copy out of the (capped) view so the original ArrayBuffer can be GC'd.
			const len = capped.byteLength;
			if (this.capturedBytesPending + len <= this.config.CAPTURE_BYTES_BUDGET) {
				reqBytes = new Uint8Array(capped);
				chargedBytes = len;
				this.capturedBytesPending += len;
			} else {
				bodyDiscarded = true;
			}
		} else if (!storePayloads) {
			// Storage off at begin() → behave like the over-budget path: mark the
			// body discarded so captureResponseChunk's live re-check and the persist
			// path treat this as metadata-only, even across a mid-stream config flip.
			bodyDiscarded = true;
		}

		const record: InternalRecord = {
			meta,
			billingType,
			reqBytes,
			respChunks: [],
			respBytes: 0,
			chargedBytes,
			transport: null,
			usage: null,
			usageWaived: false,
			bodyDiscarded,
			persisted: false,
			createdAt: this.now(),
			persistedAt: null,
			graceTimer: null,
			patchTimer: null,
		};
		this.records.set(meta.requestId, record);

		this.ensureSweepArmed();
		this.enforceRecordCap();
	}

	/**
	 * Append response bytes up to MAX_RESPONSE_BODY_BYTES. Skips if the body was
	 * discarded (budget pressure / storage off).
	 */
	captureResponseChunk(requestId: string, chunk: Uint8Array): void {
		const record = this.records.get(requestId);
		if (!record || record.persisted) return;
		if (record.bodyDiscarded) return;
		if (!this.getStorePayloads()) return;
		if (record.respBytes >= this.config.MAX_RESPONSE_BODY_BYTES) return;

		const remaining = this.config.MAX_RESPONSE_BODY_BYTES - record.respBytes;
		const take = Math.min(remaining, chunk.byteLength);
		if (take <= 0) return;
		// Respect the global capture budget too.
		if (this.capturedBytesPending + take > this.config.CAPTURE_BYTES_BUDGET) {
			return;
		}
		const slice = take === chunk.byteLength ? chunk : chunk.subarray(0, take);
		// Copy so we don't retain a view into a larger transferred buffer.
		record.respChunks.push(new Uint8Array(slice));
		record.respBytes += take;
		record.chargedBytes += take;
		this.capturedBytesPending += take;
	}

	/**
	 * Transport finished (onEnd/onError/disconnect/timeout). Arm the
	 * summary-grace timer and try to persist.
	 */
	finishTransport(requestId: string, outcome: TransportOutcome): void {
		const record = this.records.get(requestId);
		if (!record || record.persisted) return;
		// First finish wins; ignore re-finishes.
		if (record.transport === null) {
			record.transport = { outcome };
			// Arm the grace timer: if no usage arrives within the window, persist
			// without usage but keep a patch record.
			record.graceTimer = this.scheduleTimer(() => {
				record.graceTimer = null;
				const r = this.records.get(requestId);
				if (!r || r.persisted) return;
				if (r.usage === null) {
					// Grace elapsed without usage — persist now (no usage), keep patch.
					this.persistWhenReady(requestId, /* graceElapsed */ true);
				}
			}, this.config.SUMMARY_GRACE_MS);
		}
		this.persistWhenReady(requestId);
	}

	/**
	 * Usage summary arrived. If already persisted (late), patch the row + re-emit;
	 * otherwise stash it and try to persist.
	 */
	attachUsageSummary(requestId: string, summary: SlimUsageSummary): void {
		const record = this.records.get(requestId);
		if (!record) return;
		if (record.persisted) {
			this.patchUsage(record, summary);
			return;
		}
		record.usage = summary;
		this.persistWhenReady(requestId);
	}

	/**
	 * Usage can no longer arrive for this request (e.g. the inline usage finalize
	 * rejected). Persist the row IMMEDIATELY usage-waived instead of relying on
	 * the summary-grace timer.
	 *
	 * Why not lean on grace: graceful shutdown drains the in-flight finalizers
	 * and THEN disposes the recorder. A finalize that rejects fast during
	 * shutdown would otherwise leave the row pending until the grace timer fires
	 * — but dispose() clears all timers and the map first, so the row is lost
	 * (B5). Persisting on the reject path closes that window. If transport hasn't
	 * finished yet (shouldn't happen — the finalize is launched after
	 * finishTransport) this is a no-op until it does, matching persistWhenReady's
	 * invariant 5 (never finalize an open transport). Idempotent: a no-op if the
	 * record is gone or already persisted.
	 */
	markUsageUnavailable(requestId: string): void {
		const record = this.records.get(requestId);
		if (!record || record.persisted) return;
		record.usageWaived = true;
		this.persistWhenReady(requestId);
	}

	/** Age/byte-pressure backstop — frees memory, never false-fails (invariant 5). */
	sweep(): void {
		const now = this.now();
		const overBudget =
			this.capturedBytesPending > this.config.CAPTURE_BYTES_BUDGET;
		for (const [id, record] of [...this.records]) {
			if (record.persisted) {
				// Patch-retained records: drop once their TTL passes. The TTL is
				// anchored to persistedAt (not createdAt) so a long stream's late
				// summary can still patch — createdAt may be far past the TTL the
				// instant a 30-min stream persists, which would defeat invariant 2.
				const anchor = record.persistedAt ?? record.createdAt;
				if (now - anchor > this.config.PATCH_RECORD_TTL_MS) {
					this.dropRecord(id);
				}
				continue;
			}
			const overAge = now - record.createdAt > this.config.RECORD_MAX_AGE_MS;
			if (!overAge && !overBudget) continue;

			if (record.transport === null) {
				// Still streaming → free buffers, mark discarded, DO NOT persist.
				this.releaseBuffers(record);
				record.bodyDiscarded = true;
			} else {
				// Finished but stuck → finalize without usage.
				record.usageWaived = true;
				this.persistWhenReady(id);
			}
		}
	}

	/**
	 * Record a synthetic terminal response (pool/provider-exhaustion) — a
	 * request row with no body and no usage. Emits a dashboard event.
	 */
	recordSynthetic(
		meta: RecordMeta,
		outcome: TransportOutcome,
		errorMessage?: string,
	): void {
		const billingType = this.deriveBillingType(meta);
		const success = outcome === "success";
		const responseTime = Math.max(0, this.now() - meta.timestamp);
		// Carry the specific reason (e.g. "provider_overloaded"/"pool_exhausted")
		// into the row instead of a generic "synthetic" string.
		const error = success
			? null
			: (errorMessage ?? this.outcomeToErrorString(outcome) ?? "synthetic");

		this.enqueueMetadata(
			meta,
			billingType,
			success,
			responseTime,
			undefined,
			error,
		);

		this.emitSummaryEvent(
			this.buildEventResponse(meta, billingType, success, responseTime, null, {
				outcome,
			}),
		);
	}

	dispose(): void {
		for (const record of this.records.values()) {
			this.clearTimer(record.graceTimer);
			this.clearTimer(record.patchTimer);
		}
		if (this.sweepTimer !== null) {
			this.clearTimer(this.sweepTimer);
			this.sweepTimer = null;
		}
		this.records.clear();
		this.capturedBytesPending = 0;
	}

	// -------------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------------

	/** Derive the billingType from overage headers / provider / explicit override. */
	private deriveBillingType(meta: RecordMeta): string {
		const overageInUse =
			meta.responseHeaders["anthropic-ratelimit-unified-overage-in-use"];
		const overageStatus =
			meta.responseHeaders["anthropic-ratelimit-unified-overage-status"];
		if (overageInUse === "true") {
			return "overage";
		}
		if (
			overageStatus === "rejected" ||
			overageStatus === "org_level_disabled"
		) {
			return "plan";
		}
		if (meta.accountBillingType) {
			return meta.accountBillingType;
		}
		return PLAN_PROVIDERS.has(meta.providerName) ? "plan" : "api";
	}

	/**
	 * Persist when ready: never finalize while transport open (invariant 5);
	 * wait within grace for usage; persist ordered; emit; release buffers.
	 */
	private persistWhenReady(requestId: string, graceElapsed = false): void {
		const record = this.records.get(requestId);
		if (!record || record.persisted) return;
		// NEVER finalize an unfinished request.
		if (record.transport === null) return;
		// Wait within grace for usage unless waived or grace already elapsed.
		if (record.usage === null && !record.usageWaived && !graceElapsed) {
			return;
		}

		// Clear the grace timer — we're persisting now.
		if (record.graceTimer !== null) {
			this.clearTimer(record.graceTimer);
			record.graceTimer = null;
		}

		const success = this.outcomeToSuccess(record);
		const responseTime = this.computeResponseTime(record);
		const usage = record.usage ? this.toRequestUsage(record.usage) : undefined;
		const errorMessage = this.outcomeToError(record);

		// 1. metadata (request → routing) + 2. payload (ordered, droppable).
		this.persistOrdered(record, success, responseTime, errorMessage, usage);

		// Emit the dashboard event — carry the outcome so a non-success terminal
		// (disconnect/timeout/error) populates errorMessage instead of blank.
		this.emitSummaryEvent(
			this.buildEventResponse(
				record.meta,
				record.billingType,
				success,
				responseTime,
				record.usage,
				{ outcome: record.transport?.outcome },
			),
		);

		record.persistedAt = this.now();
		record.persisted = true;

		if (record.usageWaived || record.usage !== null) {
			// Unrecoverable (waived) OR already complete with usage → drop now.
			// dropRecord releases the buffers, so do NOT release here too (the
			// double release would double-decrement capturedBytesPending).
			this.dropRecord(requestId);
		} else {
			// Persisted without usage but recoverable: keep a tiny no-body record
			// for a late patchUsage(), bounded by PATCH_RECORD_TTL_MS. Release the
			// buffers exactly once here since the record lingers in the map.
			this.releaseBuffers(record);
			record.patchTimer = this.scheduleTimer(() => {
				record.patchTimer = null;
				this.dropRecord(requestId);
			}, this.config.PATCH_RECORD_TTL_MS);
		}
	}

	/** Explicit FK order + two-stage payload check. */
	private persistOrdered(
		record: InternalRecord,
		success: boolean,
		responseTime: number,
		errorMessage: string | null,
		usage: unknown,
	): void {
		const meta = record.meta;
		const storePayloads = this.getStorePayloads();

		// Two-stage payload check: estimate BEFORE serializing.
		let willStore = false;
		let estimatedBytes = 0;
		if (storePayloads && !record.bodyDiscarded) {
			estimatedBytes = this.estimatePayloadBytes(record);
			if (this.asyncWriter.canAcceptPayload(estimatedBytes)) {
				willStore = true;
			} else {
				this.asyncWriter.recordPayloadDrop(estimatedBytes);
			}
		}
		const json = willStore ? this.buildEnvelope(record, success) : null;

		const routing = meta.routing;
		const accountUsed = meta.accountId;

		const accepted = this.asyncWriter.enqueue(async () => {
			try {
				await this.dbOps.saveRequest(
					meta.requestId,
					meta.method,
					meta.path,
					accountUsed,
					meta.responseStatus,
					success,
					errorMessage,
					responseTime,
					meta.failoverAttempts,
					usage as never,
					meta.agentUsed ?? undefined,
					meta.apiKeyId ?? undefined,
					meta.apiKeyName ?? undefined,
					meta.project ?? null,
					record.billingType,
					meta.comboName ?? null,
				);
				if (routing) {
					await this.dbOps.saveRequestRouting({
						requestId: meta.requestId,
						strategy: routing.strategy,
						decision: routing.decision,
						affinityScope: routing.affinityScope,
						affinityKeyHash: routing.affinityKeyHash,
						selectedAccountId: routing.selectedAccountId,
						previousAccountId: routing.previousAccountId,
						candidatesCount: routing.candidatesCount,
						failoverAttempts: meta.failoverAttempts,
						failoverReason: routing.failoverReason,
						createdAt: meta.timestamp,
					});
				}
			} catch (error) {
				log.error(`Failed to save request for ${meta.requestId}:`, error);
			}
		});

		if (!accepted) {
			// Metadata queue saturated — the request row was NOT persisted. Count
			// and log it; never pretend it was written.
			this.metadataDropped++;
			this.onMetadataDrop?.(meta.requestId);
			log.warn(
				`Metadata enqueue dropped for ${meta.requestId} — request row not persisted (total dropped: ${this.metadataDropped})`,
			);
			return; // do not enqueue a payload for a row that was not written
		}

		// 3. payload AFTER the row job is enqueued — droppable without losing the
		//    request row. Re-check admission before enqueuePayload.
		if (json && this.asyncWriter.canAcceptPayload(estimatedBytes)) {
			const payloadBytes = Buffer.byteLength(json);
			const acceptedPayload = this.asyncWriter.enqueuePayload(
				meta.requestId,
				payloadBytes,
				async () => {
					try {
						await this.dbOps.saveRequestPayloadRaw(meta.requestId, json);
					} catch (error) {
						log.error(`Failed to save payload for ${meta.requestId}:`, error);
					}
				},
			);
			if (!acceptedPayload) {
				log.warn(
					`Payload write rejected post-serialization for ${meta.requestId} (bytes=${payloadBytes})`,
				);
			}
		}
	}

	/**
	 * Direct metadata write for synthetic rows (no payload, no grace, no map
	 * entry needed). Mirrors persistOrdered's request→routing ordering.
	 */
	private enqueueMetadata(
		meta: RecordMeta,
		billingType: string,
		success: boolean,
		responseTime: number,
		usage: unknown,
		errorMessage: string | null = null,
	): void {
		const routing = meta.routing;
		const accepted = this.asyncWriter.enqueue(async () => {
			try {
				await this.dbOps.saveRequest(
					meta.requestId,
					meta.method,
					meta.path,
					meta.accountId,
					meta.responseStatus,
					success,
					success ? null : (errorMessage ?? "synthetic"),
					responseTime,
					meta.failoverAttempts,
					usage as never,
					meta.agentUsed ?? undefined,
					meta.apiKeyId ?? undefined,
					meta.apiKeyName ?? undefined,
					meta.project ?? null,
					billingType,
					meta.comboName ?? null,
				);
				if (routing) {
					await this.dbOps.saveRequestRouting({
						requestId: meta.requestId,
						strategy: routing.strategy,
						decision: routing.decision,
						affinityScope: routing.affinityScope,
						affinityKeyHash: routing.affinityKeyHash,
						selectedAccountId: routing.selectedAccountId,
						previousAccountId: routing.previousAccountId,
						candidatesCount: routing.candidatesCount,
						failoverAttempts: meta.failoverAttempts,
						failoverReason: routing.failoverReason,
						createdAt: meta.timestamp,
					});
				}
			} catch (error) {
				log.error(
					`Failed to save synthetic request for ${meta.requestId}:`,
					error,
				);
			}
		});
		if (!accepted) {
			this.metadataDropped++;
			this.onMetadataDrop?.(meta.requestId);
			log.warn(
				`Metadata enqueue dropped for synthetic ${meta.requestId} (total dropped: ${this.metadataDropped})`,
			);
		}
	}

	private patchUsage(record: InternalRecord, summary: SlimUsageSummary): void {
		const usage = this.toRequestUsage(summary);
		this.asyncWriter.enqueue(async () => {
			try {
				await this.dbOps.updateRequestUsage(record.meta.requestId, usage);
			} catch (error) {
				log.error(`Failed to patch usage for ${record.meta.requestId}:`, error);
			}
		});
		// Keep the live dashboard in sync — re-emit with the patched usage.
		const success = this.outcomeToSuccess(record);
		const responseTime = this.computeResponseTime(record, summary);
		this.emitSummaryEvent(
			this.buildEventResponse(
				record.meta,
				record.billingType,
				success,
				responseTime,
				summary,
				{ outcome: record.transport?.outcome },
			),
		);
		// Stop the patch-TTL drop timer and drop now — usage is in.
		if (record.patchTimer !== null) {
			this.clearTimer(record.patchTimer);
			record.patchTimer = null;
		}
		this.dropRecord(record.meta.requestId);
	}

	/**
	 * Build the payload envelope: base64 request/response bodies + the meta block.
	 * Shape is stable so the Request History reader is unchanged.
	 */
	private buildEnvelope(record: InternalRecord, success: boolean): string {
		const meta = record.meta;
		let requestBody: string | null = null;
		if (record.reqBytes && record.reqBytes.byteLength > 0) {
			requestBody = Buffer.from(record.reqBytes).toString("base64");
		}
		let responseBody: string | null = null;
		if (record.respBytes > 0) {
			const combined = this.combineChunks(record.respChunks, record.respBytes);
			responseBody = combined.toString("base64");
		}

		return JSON.stringify({
			request: {
				headers: meta.requestHeaders,
				body: requestBody,
			},
			response: {
				status: meta.responseStatus,
				headers: meta.responseHeaders,
				body: responseBody,
			},
			meta: {
				accountId: meta.accountId || NO_ACCOUNT_ID,
				timestamp: meta.timestamp,
				success,
				isStream: meta.isStream,
				retry: meta.retryAttempt,
				project: meta.project ?? undefined,
			},
		});
	}

	/** Estimate the serialized payload byte budget before building the envelope. */
	private estimatePayloadBytes(record: InternalRecord): number {
		// Request body stored as base64 (~4/3× raw bytes).
		const reqLen = record.reqBytes?.byteLength ?? 0;
		const estimatedRequestBytes = reqLen ? Math.ceil(reqLen / 3) * 4 : 0;
		// Response body stored as base64.
		const estimatedResponseBytes = record.respBytes
			? Math.ceil(record.respBytes / 3) * 4
			: 0;
		return estimatedRequestBytes + estimatedResponseBytes + 2048;
	}

	/**
	 * Build the dashboard RequestResponse from meta + billingType + usage. For
	 * non-success outcomes the live SSE event carries the same outcome-derived
	 * error string the DB row gets (via `errorSource`), so the dashboard isn't
	 * blank on disconnect/timeout/error.
	 */
	private buildEventResponse(
		meta: RecordMeta,
		billingType: string,
		success: boolean,
		responseTime: number,
		summary: SlimUsageSummary | null,
		errorSource?: { outcome?: TransportOutcome },
	): RequestResponse {
		const usage = summary?.usage;
		return {
			id: meta.requestId,
			timestamp: new Date(meta.timestamp).toISOString(),
			method: meta.method,
			path: meta.path,
			accountUsed: meta.accountId,
			statusCode: meta.responseStatus,
			success,
			errorMessage: success
				? null
				: this.outcomeToErrorString(errorSource?.outcome),
			responseTimeMs: responseTime,
			failoverAttempts: meta.failoverAttempts,
			model: usage?.model,
			promptTokens: usage?.inputTokens,
			completionTokens: usage?.outputTokens,
			totalTokens: usage?.totalTokens,
			inputTokens: usage?.inputTokens,
			cacheReadInputTokens: usage?.cacheReadInputTokens,
			cacheCreationInputTokens:
				usage?.cacheCreationInputTokens ?? summary?.cacheCreationInputTokens,
			outputTokens: usage?.outputTokens,
			costUsd: usage?.costUsd,
			agentUsed: meta.agentUsed ?? undefined,
			tokensPerSecond: summary?.tokensPerSecond,
			apiKeyId: meta.apiKeyId ?? undefined,
			apiKeyName: meta.apiKeyName ?? undefined,
			project: meta.project ?? undefined,
			billingType,
			comboName: meta.comboName ?? undefined,
		};
	}

	/**
	 * Build the RequestData usage shape from the slim summary. promptTokens
	 * aggregates input + cacheRead + cacheCreation.
	 */
	private toRequestUsage(summary: SlimUsageSummary): unknown {
		const u = summary.usage;
		if (!u.model) return undefined;
		return {
			model: u.model,
			promptTokens:
				(u.inputTokens || 0) +
				(u.cacheReadInputTokens || 0) +
				(u.cacheCreationInputTokens || 0),
			completionTokens: u.outputTokens,
			totalTokens: u.totalTokens,
			costUsd: u.costUsd,
			inputTokens: u.inputTokens,
			outputTokens: u.outputTokens,
			cacheReadInputTokens: u.cacheReadInputTokens,
			cacheCreationInputTokens: u.cacheCreationInputTokens,
			tokensPerSecond: summary.tokensPerSecond,
		};
	}

	private outcomeToSuccess(record: InternalRecord): boolean {
		return record.transport?.outcome === "success";
	}

	private outcomeToError(record: InternalRecord): string | null {
		return this.outcomeToErrorString(record.transport?.outcome);
	}

	/** Map a terminal outcome to its human-readable error string (null on success). */
	private outcomeToErrorString(
		outcome: TransportOutcome | undefined,
	): string | null {
		switch (outcome) {
			case "disconnect":
				return "client disconnected";
			case "timeout":
				return "request timed out";
			case "error":
				return "stream error";
			default:
				return null;
		}
	}

	private computeResponseTime(
		record: InternalRecord,
		summary?: SlimUsageSummary,
	): number {
		const s = summary ?? record.usage ?? undefined;
		if (s?.responseTimeMs !== undefined) return s.responseTimeMs;
		return Math.max(0, this.now() - record.meta.timestamp);
	}

	private combineChunks(chunks: Uint8Array[], totalBytes: number): Buffer {
		const out = Buffer.allocUnsafe(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return out;
	}

	private releaseBuffers(record: InternalRecord): void {
		this.capturedBytesPending -= record.chargedBytes;
		if (this.capturedBytesPending < 0) this.capturedBytesPending = 0;
		record.chargedBytes = 0;
		record.reqBytes = null;
		record.respChunks = [];
		record.respBytes = 0;
	}

	private dropRecord(requestId: string): void {
		const record = this.records.get(requestId);
		if (!record) return;
		this.clearTimer(record.graceTimer);
		record.graceTimer = null;
		this.clearTimer(record.patchTimer);
		record.patchTimer = null;
		this.releaseBuffers(record);
		this.records.delete(requestId);
	}

	private enforceRecordCap(): void {
		if (this.records.size <= this.config.MAX_RECORDS) return;
		const excess = this.records.size - this.config.MAX_RECORDS;
		let removed = 0;
		let freed = 0;
		for (const [id, record] of this.records) {
			if (removed >= excess) break;
			if (record.persisted) {
				// Already persisted (its row is written / will be) → safe to delete
				// to shrink the map. Drops the patch window early under cap pressure.
				this.dropRecord(id);
				removed++;
			} else if (record.transport === null && !record.bodyDiscarded) {
				// Still streaming → DO NOT delete (finishTransport must still persist
				// the row, else its metadata is lost). Mirror sweep(): free the
				// buffers and mark discarded so it stops charging the byte budget,
				// but leave the record in place.
				this.releaseBuffers(record);
				record.bodyDiscarded = true;
				freed++;
			}
		}
		if (removed > 0 || freed > 0) {
			log.warn(
				`RequestRecorder exceeded ${this.config.MAX_RECORDS} records; evicted ${removed} persisted record(s) and freed ${freed} in-flight body buffer(s) to bound memory (live request rows preserved)`,
			);
		}
	}

	private ensureSweepArmed(): void {
		// In production the sweep runs on a real interval. Tests drive sweep()
		// directly via the injected clock, so only arm when using real timers.
		if (this.sweepTimer !== null) return;
		// Use a recurring guard: schedule one sweep; reschedule from within.
		const interval = Math.min(this.config.RECORD_MAX_AGE_MS, 30_000);
		const tick = () => {
			this.sweep();
			this.sweepTimer = this.scheduleTimer(tick, interval);
		};
		this.sweepTimer = this.scheduleTimer(tick, interval);
	}
}
