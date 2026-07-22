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
import { createCacheEffectivenessHandler as createDirectCacheEffectivenessHandler } from "./cache-effectiveness-direct";
import { createCacheKeepaliveHistoryHandler as createDirectCacheKeepaliveHistoryHandler } from "./cache-keepalive-history-direct";
import { createMemoryHistoryHandler as createDirectMemoryHistoryHandler } from "./memory-history-direct";
import { createPaymentsSummaryDataHandler as createDirectPaymentsSummaryDataHandler } from "./payments-summary-direct";
import { createStatsHandler as createDirectStatsHandler } from "./stats-direct";
import { createUsageHistoryHandler as createDirectUsageHistoryHandler } from "./usage-history-direct";

const log = new Logger("AnalyticsRunner");

const DEFAULT_CACHE_TTL_MS = 10_000;
// Per-request "soft" deadline. When it fires we reject only that request and
// leave the shared worker running (see runDashboardWorker), so one slow query
// can't take sibling dashboard panels down with it.
const DEFAULT_WORKER_TIMEOUT_MS = 15_000;
// The all-time analytics view sweeps the full requests table across ~15 serial
// query phases (percentiles, window functions, per-model/per-account rollups),
// which legitimately needs far longer than the light panels on a large DB.
// It gets its own generous soft deadline; every other kind keeps the tight one
// so a slow stats/history read still surfaces quickly.
const ANALYTICS_WORKER_TIMEOUT_MS = 60_000;
// Last-resort "hard" deadline. Only a genuinely wedged worker (no response to a
// request long after even its soft deadline) trips this, and only this path
// terminates the shared worker. Kept well above the largest soft deadline so a
// merely-slow query that finishes late is never mistaken for a wedge.
const HARD_WORKER_TIMEOUT_MS = 120_000;
const SQLITE_BUSY_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESPONSE_CACHE_ENTRIES = 128;
const DEFAULT_MAX_IN_FLIGHT_ENTRIES = 64;

const WORKER_SOFT_TIMEOUT_MS_BY_KIND: Record<DashboardWorkerKind, number> = {
	analytics: ANALYTICS_WORKER_TIMEOUT_MS,
	stats: DEFAULT_WORKER_TIMEOUT_MS,
	"usage-history": DEFAULT_WORKER_TIMEOUT_MS,
	"memory-history": DEFAULT_WORKER_TIMEOUT_MS,
	"cache-keepalive-history": DEFAULT_WORKER_TIMEOUT_MS,
	"cache-effectiveness": DEFAULT_WORKER_TIMEOUT_MS,
	"payments-summary": DEFAULT_WORKER_TIMEOUT_MS,
};

/** Per-request soft timeout (ms) for a dashboard worker kind. */
export function getWorkerTimeoutMs(kind: DashboardWorkerKind): number {
	return WORKER_SOFT_TIMEOUT_MS_BY_KIND[kind] ?? DEFAULT_WORKER_TIMEOUT_MS;
}

type CachedResponse = {
	expiresAt: number;
	status: number;
	body: string;
};

const responseCache = new Map<string, CachedResponse>();
const inFlight = new Map<string, Promise<Response>>();

// Per-kind invalidation epoch. Bumped by invalidateDashboardCache so a
// pre-invalidation request that is still in flight can't re-prime the cache
// with stale data when it completes (cacheIfSuccessful compares epochs).
const invalidationEpochs = new Map<DashboardWorkerKind, number>();

/**
 * Drop all cached responses (and in-flight dedup promises) for one dashboard
 * worker kind. Call after a mutation that changes the data backing that kind
 * (e.g. payment ledger writes invalidate "payments-summary") so an immediate
 * follow-up read reflects the write instead of a pre-mutation cache entry.
 *
 * In-flight promises are only removed from the dedup map — their original
 * awaiters still resolve normally; new readers start a fresh worker request.
 * The epoch bump prevents those orphaned requests from writing stale results
 * into the cache when they finish.
 */
export function invalidateDashboardCache(kind: DashboardWorkerKind): void {
	invalidationEpochs.set(kind, (invalidationEpochs.get(kind) ?? 0) + 1);
	const prefix = `${kind}\0`;
	for (const key of responseCache.keys()) {
		if (key.startsWith(prefix)) responseCache.delete(key);
	}
	for (const key of inFlight.keys()) {
		if (key.startsWith(prefix)) inFlight.delete(key);
	}
}

type PendingWorkerRequest = {
	resolve: (response: Response) => void;
	reject: (error: Error) => void;
	// Fires first: rejects this one request without touching the worker.
	softTimeoutHandle: ReturnType<typeof setTimeout>;
	// Fires much later if this request is still unanswered; terminates the
	// worker only when it has gone fully silent (a genuine wedge).
	hardTimeoutHandle: ReturnType<typeof setTimeout>;
	// Set once the caller has been given an answer (result OR soft-timeout
	// error). A late worker result for an already-settled request is dropped,
	// and resetDashboardWorker won't reject it a second time.
	settled: boolean;
};

/**
 * Structural view of the dashboard Worker the runner depends on. A test seam
 * (__setDashboardWorkerFactoryForTests) can swap in a controllable stub, so
 * this is kept to exactly the surface the runner uses.
 */
export type DashboardWorkerLike = {
	postMessage(message: AnalyticsWorkerRequest): void;
	terminate(): void;
	onmessage: ((event: MessageEvent<AnalyticsWorkerResponse>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	onmessageerror: (() => void) | null;
	unref?: () => void;
};

let dashboardWorker: DashboardWorkerLike | undefined;
const pendingWorkerRequests = new Map<string, PendingWorkerRequest>();

// Wall-clock of the worker's most recent sign of life: its creation, or any
// message it posts back (for any request, including ones already timed out).
// The hard watchdog only tears the worker down if it has stayed silent this
// entire time — a worker still answering other reads is demonstrably alive, so
// a merely-slow query aging out never triggers a collateral teardown of
// healthy sibling requests.
let lastWorkerActivityAt = 0;

// Test seams (see analytics-worker-timeout.test.ts). Both default to null so
// production behaviour is unchanged.
let workerFactoryOverride: (() => DashboardWorkerLike) | null = null;
let workerTimeoutOverrideMs: { soft?: number; hard?: number } | null = null;

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
	"cache-keepalive-history": {
		timeoutMessage: "Cache keepalive history request timed out",
		failureMessage: "Failed to fetch cache keepalive history data",
		tooManyMessage: "Too many cache keepalive history requests",
	},
	"cache-effectiveness": {
		timeoutMessage: "Cache effectiveness request timed out",
		failureMessage: "Failed to fetch cache effectiveness data",
		tooManyMessage: "Too many cache effectiveness requests",
	},
	"payments-summary": {
		timeoutMessage: "Payments summary request timed out",
		failureMessage: "Failed to fetch payments summary data",
		tooManyMessage: "Too many payments summary requests",
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

export function createIsolatedCacheKeepaliveHistoryHandler(
	context: APIContext,
) {
	return createIsolatedDashboardHandler(
		context,
		"cache-keepalive-history",
		createDirectCacheKeepaliveHistoryHandler(context),
	);
}

export function createIsolatedCacheEffectivenessHandler(context: APIContext) {
	return createIsolatedDashboardHandler(
		context,
		"cache-effectiveness",
		createDirectCacheEffectivenessHandler(context),
	);
}

/**
 * Worker-routed data collector for the payments summary. Returns the RAW
 * PaymentsSummaryData JSON (see payments-summary-direct.ts); the main-thread
 * assembly into the PaymentsSummary response shape lives in payments.ts.
 */
export function createIsolatedPaymentsSummaryDataHandler(context: APIContext) {
	return createIsolatedDashboardHandler(
		context,
		"payments-summary",
		createDirectPaymentsSummaryDataHandler(context),
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

		if (inFlight.size >= DEFAULT_MAX_IN_FLIGHT_ENTRIES) {
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
			// Identity-checked: invalidateDashboardCache() may have evicted this
			// entry and a fresh request may have claimed the key since.
			if (inFlight.get(key) === promise) inFlight.delete(key);
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
	const epochAtStart = invalidationEpochs.get(kind) ?? 0;
	try {
		const response = await runDashboardWorker(kind, dbPath, params);
		await cacheIfSuccessful(kind, cacheKey, response, epochAtStart);
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
	const softMs = workerTimeoutOverrideMs?.soft ?? getWorkerTimeoutMs(kind);
	const hardMs = workerTimeoutOverrideMs?.hard ?? HARD_WORKER_TIMEOUT_MS;

	return new Promise<Response>((resolve, reject) => {
		const softTimeoutHandle = setTimeout(() => {
			const pending = pendingWorkerRequests.get(id);
			if (!pending || pending.settled) return;
			// Reject ONLY this request; leave the shared worker running so
			// sibling dashboard panels keep their in-flight results. The entry
			// stays registered (settled=true) so a late worker result is dropped
			// cleanly and the hard watchdog can still recover a wedged worker.
			pending.settled = true;
			pending.reject(new DashboardWorkerTimeoutError(softMs));
		}, softMs);

		const hardTimeoutHandle = setTimeout(() => {
			const pending = pendingWorkerRequests.get(id);
			if (!pending) return;
			// This request has gone unanswered well past even its soft deadline.
			// Only tear the worker down if it has been completely silent the whole
			// time — that's a genuine wedge. If it has posted anything recently
			// (other reads still completing), it's alive and merely slow on this
			// query, so don't punish healthy siblings: quietly retire this
			// abandoned entry and let the late result (if any) be dropped.
			if (Date.now() - lastWorkerActivityAt >= hardMs) {
				resetDashboardWorker(new DashboardWorkerTimeoutError(hardMs));
				return;
			}
			clearTimeout(pending.softTimeoutHandle);
			clearTimeout(pending.hardTimeoutHandle);
			pendingWorkerRequests.delete(id);
			if (!pending.settled) {
				pending.settled = true;
				pending.reject(new DashboardWorkerTimeoutError(hardMs));
			}
		}, hardMs);

		pendingWorkerRequests.set(id, {
			resolve,
			reject,
			softTimeoutHandle,
			hardTimeoutHandle,
			settled: false,
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
				clearTimeout(pending.softTimeoutHandle);
				clearTimeout(pending.hardTimeoutHandle);
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

function createRealDashboardWorker(): DashboardWorkerLike {
	return new Worker(new URL("./analytics-worker.ts", import.meta.url).href, {
		smol: true,
	}) as unknown as DashboardWorkerLike;
}

function getDashboardWorker(): DashboardWorkerLike {
	if (dashboardWorker) return dashboardWorker;

	const worker = (workerFactoryOverride ?? createRealDashboardWorker)();
	dashboardWorker = worker;
	lastWorkerActivityAt = Date.now();

	if ("unref" in worker && typeof worker.unref === "function") {
		worker.unref();
	}

	worker.onmessage = (event: MessageEvent<AnalyticsWorkerResponse>) => {
		handleDashboardWorkerMessage(event.data);
	};
	worker.onerror = (event: ErrorEvent) => {
		resetDashboardWorker(new Error(event.message || "dashboard worker error"));
	};
	worker.onmessageerror = () => {
		resetDashboardWorker(
			new Error("dashboard worker message deserialization failed"),
		);
	};

	return worker;
}

function handleDashboardWorkerMessage(data: AnalyticsWorkerResponse): void {
	// Any message — even one for an already-dropped request — is proof the
	// worker is alive; record it before anything else so the hard watchdog can
	// tell "slow" apart from "wedged".
	lastWorkerActivityAt = Date.now();

	const pending = pendingWorkerRequests.get(data.id);
	if (!pending) return;

	clearTimeout(pending.softTimeoutHandle);
	clearTimeout(pending.hardTimeoutHandle);
	pendingWorkerRequests.delete(data.id);

	// The caller already got a soft-timeout error; the worker answered late but
	// is healthy. Drop the stale result and keep the worker for the next read.
	if (pending.settled) return;
	pending.settled = true;

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
		clearTimeout(pending.softTimeoutHandle);
		clearTimeout(pending.hardTimeoutHandle);
		pendingWorkerRequests.delete(id);
		// A soft-timed-out request has already been answered; don't reject twice.
		if (pending.settled) continue;
		pending.settled = true;
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
	epochAtStart: number,
): Promise<void> {
	if (!response.ok) return;
	// The data was read before an invalidation landed — caching it would
	// resurrect pre-mutation results for a full TTL.
	if ((invalidationEpochs.get(kind) ?? 0) !== epochAtStart) return;
	try {
		const body = await response.clone().text();
		responseCache.set(cacheKey, {
			expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
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

	while (responseCache.size > DEFAULT_MAX_RESPONSE_CACHE_ENTRIES) {
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
	constructor(timeoutMs: number) {
		super(`dashboard worker timed out after ${timeoutMs}ms`);
		this.name = "DashboardWorkerTimeoutError";
	}
}

export function clearAnalyticsCachesForTests(): void {
	responseCache.clear();
	inFlight.clear();
}

/**
 * Test seam: swap the dashboard Worker for a controllable stub. Pass null to
 * restore the real worker factory. Only affects workers created after the call,
 * so pair it with terminateAnalyticsWorker() to drop any cached instance.
 */
export function __setDashboardWorkerFactoryForTests(
	factory: (() => DashboardWorkerLike) | null,
): void {
	workerFactoryOverride = factory;
}

/**
 * Test seam: shrink the soft/hard worker deadlines so timeout behaviour is
 * exercised in milliseconds instead of the production minute-scale values. Pass
 * null to restore production timeouts.
 */
export function __setDashboardWorkerTimeoutsForTests(
	override: { soft?: number; hard?: number } | null,
): void {
	workerTimeoutOverrideMs = override;
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
