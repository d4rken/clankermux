import type { ModelCacheRetention } from "@clankermux/types";

export interface CacheUsageEvidence {
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const count = (...values: unknown[]): number | undefined => {
	const value = values.find((candidate) => candidate !== undefined);
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
};

/** Pass the merged, final usage object, not individual partial stream deltas. */
export function readCacheUsage(usage: unknown): CacheUsageEvidence {
	const value = record(usage);
	const details = record(
		value.input_tokens_details ?? value.prompt_tokens_details,
	);
	const read = count(
		value.cache_read_input_tokens,
		details.cached_tokens,
		value.prompt_cache_hit_tokens,
		value.cachedContentTokenCount,
	);
	const write = count(
		value.cache_creation_input_tokens,
		details.cache_write_tokens,
		details.cache_creation_input_tokens,
	);
	return {
		...(read !== undefined ? { cacheReadTokens: read } : {}),
		...(write !== undefined ? { cacheWriteTokens: write } : {}),
	};
}

/** IDs must be opaque local identities. Never supply prompt text or upstream cache keys. */
export interface CacheEstimateContext {
	provider: string;
	model: string;
	sessionId: string;
	branchId: string;
	prefixId: string;
	toolsAndSystemId: string;
	routePolicyId: string;
}
export interface SessionCacheEstimateState extends CacheUsageEvidence {
	status: "warm" | "warm_write" | "likely_warm" | "unknown";
	lastObservedAt?: number;
	/** Epoch milliseconds. Crossing this advisory horizon means uncertainty, not expiry. */
	estimatedUntil?: number;
	refreshedByRequestId?: string;
	previousPrefixUnavailable?: boolean;
}
export interface CacheEstimateRequest {
	readonly requestId: string;
	readonly startedAt: number;
}

/** One client session, in memory only. Never use this display estimate to schedule paid requests. */
export class SessionCacheEstimate {
	private contextKey: string | undefined;
	private retention: ModelCacheRetention | undefined;
	private generation = 0;
	private sequence = 0;
	private latestSequence = -1;
	private requests = new WeakMap<
		CacheEstimateRequest,
		{ generation: number; sequence: number }
	>();
	private state: SessionCacheEstimateState = { status: "unknown" };
	private previouslyWarm = false;

	setContext(
		context: CacheEstimateContext,
		retention?: ModelCacheRetention,
	): void {
		const key = JSON.stringify([
			context.provider,
			context.model,
			context.sessionId,
			context.branchId,
			context.prefixId,
			context.toolsAndSystemId,
			context.routePolicyId,
			retention,
		]);
		if (key === this.contextKey) return;
		this.clear();
		this.contextKey = key;
		this.retention = retention ? structuredClone(retention) : undefined;
	}

	clear(): void {
		this.generation++;
		this.contextKey = undefined;
		this.retention = undefined;
		this.state = { status: "unknown" };
		this.previouslyWarm = false;
		this.latestSequence = -1;
		this.requests = new WeakMap();
	}

	beginRequest(requestId: string, startedAt: number): CacheEstimateRequest {
		if (!Number.isFinite(startedAt) || startedAt < 0)
			throw new Error("Invalid request timestamp");
		const request = Object.freeze({ requestId, startedAt });
		this.requests.set(request, {
			generation: this.generation,
			sequence: this.sequence++,
		});
		return request;
	}

	observe(
		request: CacheEstimateRequest,
		usage: unknown,
		completedAt: number,
	): void {
		const pending = this.requests.get(request);
		if (!pending || pending.generation !== this.generation || !this.contextKey)
			return;
		if (!Number.isFinite(completedAt) || completedAt < request.startedAt)
			throw new Error("Invalid completion timestamp");
		this.requests.delete(request);
		if (pending.sequence < this.latestSequence) return;
		this.latestSequence = pending.sequence;
		const evidence = readCacheUsage(usage);
		const hit = (evidence.cacheReadTokens ?? 0) > 0;
		const write = (evidence.cacheWriteTokens ?? 0) > 0;
		if (!hit && !write && evidence.cacheReadTokens === undefined) return;
		const previousPrefixUnavailable =
			this.previouslyWarm && evidence.cacheReadTokens === 0 && write;
		if (!hit && !write) {
			this.state = {
				...evidence,
				status: "unknown",
				lastObservedAt: completedAt,
			};
			return;
		}
		this.previouslyWarm ||= hit;
		const retention = this.retention;
		let estimatedUntil = this.state.estimatedUntil;
		let refreshedByRequestId = this.state.refreshedByRequestId;
		if (
			retention &&
			Number.isFinite(retention.retentionMs) &&
			retention.retentionMs > 0 &&
			(write || (hit && retention.refreshOnReuse))
		) {
			const anchor =
				retention.anchor === "request_end" ? completedAt : request.startedAt;
			estimatedUntil = anchor + retention.retentionMs;
			refreshedByRequestId = request.requestId;
		}
		this.state = {
			...evidence,
			status: hit ? "warm" : "warm_write",
			lastObservedAt: completedAt,
			...(estimatedUntil !== undefined
				? { estimatedUntil, refreshedByRequestId }
				: {}),
			previousPrefixUnavailable,
		};
	}

	snapshot(now: number): SessionCacheEstimateState {
		const state = { ...this.state };
		if (state.status === "unknown") return state;
		if (state.estimatedUntil !== undefined && now >= state.estimatedUntil) {
			state.status = "unknown";
			return state;
		}
		if (now === state.lastObservedAt) return state;
		state.status =
			state.estimatedUntil !== undefined && now < state.estimatedUntil
				? "likely_warm"
				: "unknown";
		return state;
	}
}
