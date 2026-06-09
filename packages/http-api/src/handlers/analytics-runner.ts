import {
	errorResponse,
	InternalServerError,
	ServiceUnavailable,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type { APIContext } from "../types";
import { createAnalyticsHandler as createDirectAnalyticsHandler } from "./analytics-direct";
import type {
	AnalyticsWorkerRequest,
	AnalyticsWorkerResponse,
} from "./analytics-worker";

const log = new Logger("AnalyticsRunner");

const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_WORKER_TIMEOUT_MS = 15_000;
const SQLITE_BUSY_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESPONSE_CACHE_ENTRIES = 128;
const DEFAULT_MAX_IN_FLIGHT_ENTRIES = 64;

type CachedAnalytics = {
	expiresAt: number;
	status: number;
	body: string;
};

const responseCache = new Map<string, CachedAnalytics>();
const inFlight = new Map<string, Promise<Response>>();

type PendingAnalyticsRequest = {
	resolve: (response: Response) => void;
	reject: (error: Error) => void;
	timeoutHandle: ReturnType<typeof setTimeout>;
};

let analyticsWorker: Worker | undefined;
const pendingWorkerRequests = new Map<string, PendingAnalyticsRequest>();

export function createIsolatedAnalyticsHandler(context: APIContext) {
	const directHandler = createDirectAnalyticsHandler(context);

	return async (params: URLSearchParams): Promise<Response> => {
		const dbOps = context.dbOps as Partial<APIContext["dbOps"]>;
		const dbPath = dbOps.getResolvedDbPath?.();
		if (!dbPath) {
			return directHandler(params);
		}

		const key = `${dbPath}\0${canonicalAnalyticsKey(params)}`;
		const now = Date.now();
		pruneResponseCache(now);
		const cached = responseCache.get(key);
		if (cached && cached.expiresAt > now) {
			responseCache.delete(key);
			responseCache.set(key, cached);
			return responseFromCached(cached);
		}
		if (cached) responseCache.delete(key);

		const existing = inFlight.get(key);
		if (existing) return cloneResponse(await existing);

		if (inFlight.size >= resolveMaxInFlightEntries()) {
			log.warn(
				`Rejecting analytics request: ${inFlight.size} worker requests already in flight`,
			);
			return errorResponse(ServiceUnavailable("Too many analytics requests"));
		}

		const promise = runAnalytics(dbPath, params, key);
		inFlight.set(key, promise);
		try {
			return cloneResponse(await promise);
		} finally {
			inFlight.delete(key);
		}
	};
}

function canonicalAnalyticsKey(params: URLSearchParams): string {
	const copy = new URLSearchParams(params);
	const entries = Array.from(copy.entries()).sort(
		([aKey, aVal], [bKey, bVal]) =>
			aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey),
	);
	return new URLSearchParams(entries).toString();
}

async function runAnalytics(
	dbPath: string,
	params: URLSearchParams,
	cacheKey: string,
): Promise<Response> {
	const startedAt = performance.now();

	try {
		const response = await runAnalyticsWorker(dbPath, params);
		await cacheIfSuccessful(cacheKey, response);
		logIfSlow("worker", cacheKey, performance.now() - startedAt);
		return response;
	} catch (error) {
		log.error("Analytics worker failed:", error);
		return errorResponse(
			error instanceof AnalyticsTimeoutError
				? ServiceUnavailable("Analytics request timed out")
				: InternalServerError("Failed to fetch analytics data"),
		);
	}
}

function runAnalyticsWorker(
	dbPath: string,
	params: URLSearchParams,
): Promise<Response> {
	const id = crypto.randomUUID();

	return new Promise<Response>((resolve, reject) => {
		const timeoutHandle = setTimeout(() => {
			resetAnalyticsWorker(new AnalyticsTimeoutError());
		}, resolveWorkerTimeoutMs());

		pendingWorkerRequests.set(id, {
			resolve,
			reject,
			timeoutHandle,
		});

		try {
			getAnalyticsWorker().postMessage({
				id,
				dbPath,
				params: params.toString(),
				busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
			} satisfies AnalyticsWorkerRequest);
		} catch (error) {
			const pending = pendingWorkerRequests.get(id);
			if (pending) {
				clearTimeout(pending.timeoutHandle);
				pendingWorkerRequests.delete(id);
			}
			const err =
				error instanceof Error
					? error
					: new Error(`analytics worker postMessage failed: ${String(error)}`);
			resetAnalyticsWorker(err);
			reject(err);
		}
	});
}

function getAnalyticsWorker(): Worker {
	if (analyticsWorker) return analyticsWorker;

	analyticsWorker = new Worker(
		new URL("./analytics-worker.ts", import.meta.url).href,
		{
			smol: true,
		},
	);

	if (
		"unref" in analyticsWorker &&
		typeof (analyticsWorker as { unref?: () => void }).unref === "function"
	) {
		(analyticsWorker as { unref: () => void }).unref();
	}

	analyticsWorker.onmessage = (
		event: MessageEvent<AnalyticsWorkerResponse>,
	) => {
		handleAnalyticsWorkerMessage(event.data);
	};
	analyticsWorker.onerror = (event: ErrorEvent) => {
		resetAnalyticsWorker(new Error(event.message || "analytics worker error"));
	};
	analyticsWorker.onmessageerror = () => {
		resetAnalyticsWorker(
			new Error("analytics worker message deserialization failed"),
		);
	};

	return analyticsWorker;
}

function handleAnalyticsWorkerMessage(data: AnalyticsWorkerResponse): void {
	const pending = pendingWorkerRequests.get(data.id);
	if (!pending) return;

	clearTimeout(pending.timeoutHandle);
	pendingWorkerRequests.delete(data.id);

	if (data.timings && data.timings.totalMs > 500) {
		log.warn(
			`Analytics worker completed slowly in ${Math.round(data.timings.totalMs)}ms`,
		);
	}
	if (!data.ok && data.error) {
		log.warn(`Analytics worker returned error: ${data.error}`);
	}

	pending.resolve(
		new Response(data.body, {
			status: data.status,
			headers: {
				"Content-Type": "application/json",
				"X-ClankerMux-Analytics-Mode": "worker",
			},
		}),
	);
}

function resetAnalyticsWorker(error: Error): void {
	const worker = analyticsWorker;
	analyticsWorker = undefined;

	if (worker) {
		try {
			worker.terminate();
		} catch {
			// Worker already gone.
		}
	}

	for (const [id, pending] of pendingWorkerRequests) {
		clearTimeout(pending.timeoutHandle);
		pendingWorkerRequests.delete(id);
		pending.reject(error);
	}
}

export function terminateAnalyticsWorker(): void {
	resetAnalyticsWorker(new Error("analytics worker terminated"));
}

async function cacheIfSuccessful(
	cacheKey: string,
	response: Response,
): Promise<void> {
	if (!response.ok) return;
	try {
		const body = await response.clone().text();
		responseCache.set(cacheKey, {
			expiresAt: Date.now() + resolveCacheTtlMs(),
			status: response.status,
			body,
		});
		pruneResponseCache(Date.now());
	} catch (error) {
		log.warn(`Failed to cache analytics response: ${String(error)}`);
	}
}

function pruneResponseCache(now: number): void {
	for (const [key, cached] of responseCache) {
		if (cached.expiresAt <= now) {
			responseCache.delete(key);
		}
	}

	const maxEntries = resolveMaxResponseCacheEntries();
	while (responseCache.size > maxEntries) {
		const oldestKey = responseCache.keys().next().value;
		if (typeof oldestKey !== "string") break;
		responseCache.delete(oldestKey);
	}
}

function responseFromCached(cached: CachedAnalytics): Response {
	return new Response(cached.body, {
		status: cached.status,
		headers: {
			"Content-Type": "application/json",
			"X-ClankerMux-Analytics-Mode": "worker-cache",
		},
	});
}

function cloneResponse(response: Response): Response {
	return response.clone();
}

function logIfSlow(
	mode: "direct" | "worker",
	cacheKey: string,
	durationMs: number,
) {
	if (durationMs <= 500) return;
	log.warn(
		`Analytics ${mode} request took ${Math.round(durationMs)}ms (${cacheKey || "default"})`,
	);
}

class AnalyticsTimeoutError extends Error {
	constructor() {
		super(`analytics worker timed out after ${resolveWorkerTimeoutMs()}ms`);
		this.name = "AnalyticsTimeoutError";
	}
}

function resolveCacheTtlMs(): number {
	return resolvePositiveInt(
		process.env.CLANKERMUX_ANALYTICS_CACHE_TTL_MS,
		DEFAULT_CACHE_TTL_MS,
	);
}

function resolveWorkerTimeoutMs(): number {
	return resolvePositiveInt(
		process.env.CLANKERMUX_ANALYTICS_WORKER_TIMEOUT_MS,
		DEFAULT_WORKER_TIMEOUT_MS,
	);
}

function resolveMaxResponseCacheEntries(): number {
	return resolvePositiveInt(
		process.env.CLANKERMUX_ANALYTICS_CACHE_MAX_ENTRIES,
		DEFAULT_MAX_RESPONSE_CACHE_ENTRIES,
	);
}

function resolveMaxInFlightEntries(): number {
	return resolvePositiveInt(
		process.env.CLANKERMUX_ANALYTICS_INFLIGHT_MAX_ENTRIES,
		DEFAULT_MAX_IN_FLIGHT_ENTRIES,
	);
}

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function clearAnalyticsCachesForTests(): void {
	responseCache.clear();
	inFlight.clear();
}

export function getAnalyticsCacheStatsForTests(): {
	responseCacheSize: number;
	inFlightSize: number;
} {
	return {
		responseCacheSize: responseCache.size,
		inFlightSize: inFlight.size,
	};
}
