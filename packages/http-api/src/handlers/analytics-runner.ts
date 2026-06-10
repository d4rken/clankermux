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
	DashboardWorkerKind,
} from "./analytics-worker";
import { createMemoryHistoryHandler as createDirectMemoryHistoryHandler } from "./memory-history-direct";
import { createStatsHandler as createDirectStatsHandler } from "./stats-direct";
import { createUsageHistoryHandler as createDirectUsageHistoryHandler } from "./usage-history-direct";

const log = new Logger("AnalyticsRunner");

const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_WORKER_TIMEOUT_MS = 15_000;
const SQLITE_BUSY_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESPONSE_CACHE_ENTRIES = 128;
const DEFAULT_MAX_IN_FLIGHT_ENTRIES = 64;

type CachedResponse = {
	expiresAt: number;
	status: number;
	body: string;
};

const responseCache = new Map<string, CachedResponse>();
const inFlight = new Map<string, Promise<Response>>();

type PendingWorkerRequest = {
	resolve: (response: Response) => void;
	reject: (error: Error) => void;
	timeoutHandle: ReturnType<typeof setTimeout>;
};

let dashboardWorker: Worker | undefined;
const pendingWorkerRequests = new Map<string, PendingWorkerRequest>();

type DirectHandler = (params: URLSearchParams) => Promise<Response>;

const KIND_LABELS: Record<
	DashboardWorkerKind,
	{ timeoutMessage: string; failureMessage: string; tooManyMessage: string }
> = {
	analytics: {
		timeoutMessage: "Analytics request timed out",
		failureMessage: "Failed to fetch analytics data",
		tooManyMessage: "Too many analytics requests",
	},
	stats: {
		timeoutMessage: "Stats request timed out",
		failureMessage: "Failed to fetch stats data",
		tooManyMessage: "Too many stats requests",
	},
	"usage-history": {
		timeoutMessage: "Usage history request timed out",
		failureMessage: "Failed to fetch usage history data",
		tooManyMessage: "Too many usage history requests",
	},
	"memory-history": {
		timeoutMessage: "Memory history request timed out",
		failureMessage: "Failed to fetch memory history data",
		tooManyMessage: "Too many memory history requests",
	},
};

export function createIsolatedAnalyticsHandler(context: APIContext) {
	return createIsolatedDashboardHandler(
		context,
		"analytics",
		createDirectAnalyticsHandler(context),
	);
}

export function createIsolatedStatsHandler(context: APIContext) {
	return createIsolatedDashboardHandler(
		context,
		"stats",
		createDirectStatsHandler(context),
	);
}

export function createIsolatedUsageHistoryHandler(context: APIContext) {
	return createIsolatedDashboardHandler(
		context,
		"usage-history",
		createDirectUsageHistoryHandler(context),
	);
}

export function createIsolatedMemoryHistoryHandler(context: APIContext) {
	return createIsolatedDashboardHandler(
		context,
		"memory-history",
		createDirectMemoryHistoryHandler(context),
	);
}

function createIsolatedDashboardHandler(
	context: APIContext,
	kind: DashboardWorkerKind,
	directHandler: DirectHandler,
) {
	return async (params: URLSearchParams): Promise<Response> => {
		const dbOps = context.dbOps as Partial<APIContext["dbOps"]>;
		const dbPath = dbOps.getResolvedDbPath?.();
		if (!dbPath) {
			return directHandler(params);
		}

		// The kind prefix keeps analytics and stats cache entries from
		// colliding even when their canonical param strings are identical.
		const key = `${kind}\0${dbPath}\0${canonicalParamsKey(params)}`;
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
		if (existing) return (await existing).clone();

		if (inFlight.size >= resolveMaxInFlightEntries()) {
			log.warn(
				`Rejecting ${kind} request: ${inFlight.size} worker requests already in flight`,
			);
			return errorResponse(
				ServiceUnavailable(KIND_LABELS[kind].tooManyMessage),
			);
		}

		const promise = runDashboardRequest(kind, dbPath, params, key);
		inFlight.set(key, promise);
		try {
			return (await promise).clone();
		} finally {
			inFlight.delete(key);
		}
	};
}

function canonicalParamsKey(params: URLSearchParams): string {
	const copy = new URLSearchParams(params);
	const entries = Array.from(copy.entries()).sort(
		([aKey, aVal], [bKey, bVal]) =>
			aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey),
	);
	return new URLSearchParams(entries).toString();
}

async function runDashboardRequest(
	kind: DashboardWorkerKind,
	dbPath: string,
	params: URLSearchParams,
	cacheKey: string,
): Promise<Response> {
	try {
		const response = await runDashboardWorker(kind, dbPath, params);
		await cacheIfSuccessful(kind, cacheKey, response);
		return response;
	} catch (error) {
		log.error(`Dashboard worker failed (${kind}):`, error);
		return errorResponse(
			error instanceof DashboardWorkerTimeoutError
				? ServiceUnavailable(KIND_LABELS[kind].timeoutMessage)
				: InternalServerError(KIND_LABELS[kind].failureMessage),
		);
	}
}

function runDashboardWorker(
	kind: DashboardWorkerKind,
	dbPath: string,
	params: URLSearchParams,
): Promise<Response> {
	const id = crypto.randomUUID();

	return new Promise<Response>((resolve, reject) => {
		const timeoutHandle = setTimeout(() => {
			resetDashboardWorker(new DashboardWorkerTimeoutError());
		}, resolveWorkerTimeoutMs());

		pendingWorkerRequests.set(id, {
			resolve,
			reject,
			timeoutHandle,
		});

		try {
			getDashboardWorker().postMessage({
				id,
				kind,
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
					: new Error(`dashboard worker postMessage failed: ${String(error)}`);
			resetDashboardWorker(err);
			reject(err);
		}
	});
}

function getDashboardWorker(): Worker {
	if (dashboardWorker) return dashboardWorker;

	dashboardWorker = new Worker(
		new URL("./analytics-worker.ts", import.meta.url).href,
		{
			smol: true,
		},
	);

	if (
		"unref" in dashboardWorker &&
		typeof (dashboardWorker as { unref?: () => void }).unref === "function"
	) {
		(dashboardWorker as { unref: () => void }).unref();
	}

	dashboardWorker.onmessage = (
		event: MessageEvent<AnalyticsWorkerResponse>,
	) => {
		handleDashboardWorkerMessage(event.data);
	};
	dashboardWorker.onerror = (event: ErrorEvent) => {
		resetDashboardWorker(new Error(event.message || "dashboard worker error"));
	};
	dashboardWorker.onmessageerror = () => {
		resetDashboardWorker(
			new Error("dashboard worker message deserialization failed"),
		);
	};

	return dashboardWorker;
}

function handleDashboardWorkerMessage(data: AnalyticsWorkerResponse): void {
	const pending = pendingWorkerRequests.get(data.id);
	if (!pending) return;

	clearTimeout(pending.timeoutHandle);
	pendingWorkerRequests.delete(data.id);

	if (data.timings && data.timings.totalMs > 500) {
		log.warn(
			`Dashboard worker completed slowly in ${Math.round(data.timings.totalMs)}ms`,
		);
	}
	if (!data.ok && data.error) {
		log.warn(`Dashboard worker returned error: ${data.error}`);
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

function resetDashboardWorker(error: Error): void {
	const worker = dashboardWorker;
	dashboardWorker = undefined;

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
	resetDashboardWorker(new Error("dashboard worker terminated"));
}

async function cacheIfSuccessful(
	kind: DashboardWorkerKind,
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
		log.warn(`Failed to cache ${kind} response: ${String(error)}`);
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

function responseFromCached(cached: CachedResponse): Response {
	return new Response(cached.body, {
		status: cached.status,
		headers: {
			"Content-Type": "application/json",
			"X-ClankerMux-Analytics-Mode": "worker-cache",
		},
	});
}

class DashboardWorkerTimeoutError extends Error {
	constructor() {
		super(`dashboard worker timed out after ${resolveWorkerTimeoutMs()}ms`);
		this.name = "DashboardWorkerTimeoutError";
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
