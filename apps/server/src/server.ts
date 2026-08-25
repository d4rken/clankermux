import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Config, type RuntimeConfig } from "@clankermux/config";
import {
	assertBunRuntimeFloor,
	BunRuntimeFloorError,
	CACHE,
	captureBootProvenance,
	DEFAULT_STRATEGY,
	drainEventLoopSnapshotMaxLagMs,
	getEventLoopStats,
	getVersion,
	HTTP_STATUS,
	NETWORK,
	readEnv,
	registerCleanup,
	registerDisposable,
	requestEvents,
	setPricingLogger,
	shutdown,
	startEventLoopMonitor,
	stopEventLoopMonitor,
	TIME_CONSTANTS,
} from "@clankermux/core";
import { container, SERVICE_KEYS } from "@clankermux/core-di";
import type { DatabaseOperations } from "@clankermux/database";
import {
	AsyncDbWriter,
	DatabaseFactory,
	initPayloadEncryption,
	UNIFIED_CLAIM_OBSERVATION_RETENTION_MS,
} from "@clankermux/database";
import {
	APIRouter,
	AuthService,
	closeAllSseStreams,
	PublicRouter,
	SessionAuthService,
	terminateAnalyticsWorker,
} from "@clankermux/http-api";
import { LeastUsedStrategy, SessionStrategy } from "@clankermux/load-balancer";
import { Logger } from "@clankermux/logger";
import {
	handleModelsRequest,
	handleResponsesRequest,
} from "@clankermux/openai-responses-adapter";
import {
	extractCodexIdentity,
	fetchAnthropicProfile,
	fetchCodexModelCatalog,
	getFreshCapacity,
	getProvider,
	getRepresentativeUtilizationForProvider,
	usageCache,
} from "@clankermux/providers";
import {
	AutoRefreshScheduler,
	bridgeStats,
	CacheKeepaliveScheduler,
	CodexModelCatalogCache,
	type CodexResetCreditApplyScheduler,
	CodexSpendCoordinator,
	CodexUsagePoller,
	createCodexResetCreditApplyScheduler,
	dispatchProxyRequest,
	drainPendingUsageFinalizers,
	getActiveOverloadHoldCount,
	getOccupiedOverloadHoldKeys,
	getOverloadDiagnostics,
	getValidAccessToken,
	handleProxy,
	markCapacityRestoredProbePending,
	type PolledCodexAccount,
	type ProxyContext,
	RequestRecorder,
	registerAffinityClearer,
	registerCodexResetCreditConsumer,
	registerCodexResetCreditsRefresher,
	registerCodexUsageRefresher,
	registerPollingRestarter,
	registerRefreshClearer,
	rollbackCapacityRestoredProbePending,
	setRequestRecorder,
	startGlobalTokenHealthChecks,
	startIntegrityScheduler,
	stopGlobalTokenHealthChecks,
	unregisterCodexResetCreditConsumer,
	unregisterCodexResetCreditsRefresher,
	unregisterCodexUsageRefresher,
} from "@clankermux/proxy";
import { validatePathOrThrow } from "@clankermux/security";
import {
	type Account,
	type CapacitySignal,
	type LoadBalancingStrategy,
	type ProviderOverloadStatus,
	StrategyName,
	type StrategyStore,
} from "@clankermux/types";
import { type Server, serve } from "bun";
import { runAnthropicProfileBackfill } from "./anthropic-profile-backfill";
import {
	CacheKeepaliveSnapshotSampler,
	liveGauges,
	liveStats,
} from "./cache-keepalive-snapshot-sampler";
import {
	type CapacityRestoredProbeMarker,
	clearRateLimitOnCapacityRestored,
} from "./capacity-restored";
import { runCodexIdentityBackfill } from "./codex-identity-backfill";
import { waitForDrainIdle } from "./drain-idle";
import { handleModelsRoute } from "./models-route";
import { QuotaDriftScheduler } from "./quota-drift-scheduler";
import { type RequestRouterDeps, routeRequest } from "./request-router";
import { SubscriptionPaymentRecorder } from "./subscription-payment-recorder";
import { shouldStopPollingPausedAccount } from "./usage-polling-halt";
import { createUsagePollingTokenProvider } from "./usage-polling-token-provider";
import { UsageSnapshotSampler } from "./usage-snapshot-sampler";
import { WIRE_MOUNTS } from "./wire-mounts";

/**
 * Build a load-balancing strategy from its enum name. Add new strategies here
 * as additional cases. Falls back to SessionStrategy on unknown values.
 */
function buildStrategy(
	name: StrategyName,
	sessionDurationMs: number,
): LoadBalancingStrategy {
	switch (name) {
		case StrategyName.LeastUsed:
			return new LeastUsedStrategy();
		default:
			return new SessionStrategy(sessionDurationMs);
	}
}

// Import embedded dashboard assets (will be bundled in compiled binary)
let embeddedDashboard: Record<
	string,
	{ content: string; contentType: string }
> | null = null;
let dashboardManifest: Record<string, string> | null = null;

// Try to load embedded dashboard (will exist in production build)
try {
	const embedded = await import("@clankermux/dashboard-web/dist/embedded");
	embeddedDashboard = embedded.embeddedDashboard;
	dashboardManifest = embedded.dashboardManifest;
} catch {
	// Fallback: try loading from file system (development)
	try {
		const manifestModule = await import(
			"@clankermux/dashboard-web/dist/manifest.json"
		);
		dashboardManifest = manifestModule.default as Record<string, string>;
	} catch {
		console.warn("⚠️  Dashboard assets not found - dashboard will be disabled");
	}
}

// Memory monitoring thresholds
const MEMORY_MONITOR_INTERVAL_MS = 60 * 1000;
const MEMORY_GROWTH_WARN_BYTES = 512 * 1024 * 1024;
const MEMORY_GROWTH_ERROR_BYTES = 1024 * 1024 * 1024;

// Helper function to resolve dashboard assets with fallback
function resolveDashboardAsset(assetPath: string): string | null {
	try {
		// Try resolving as a package first
		return Bun.resolveSync(
			`@clankermux/dashboard-web/dist${assetPath}`,
			dirname(import.meta.path),
		);
	} catch {
		// Fallback to relative path within the repo (development / mono-repo usage)
		try {
			return Bun.resolveSync(
				`../../../packages/dashboard-web/dist${assetPath}`,
				dirname(import.meta.path),
			);
		} catch {
			return null;
		}
	}
}

// Helper function to serve dashboard files with proper headers
function serveDashboardFile(
	assetPath: string,
	contentType?: string,
	cacheControl?: string,
): Response {
	// Security headers for dashboard files
	const securityHeaders: Record<string, string> = {
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"X-XSS-Protection": "1; mode=block",
		"Referrer-Policy": "strict-origin-when-cross-origin",
	};

	// Add Content Security Policy for HTML files
	const isHtml = assetPath.endsWith(".html") || contentType === "text/html";
	if (isHtml) {
		// Strict CSP for React apps: only bundled scripts and styles from same origin
		securityHeaders["Content-Security-Policy"] = [
			"default-src 'self'",
			"script-src 'self'", // Only bundled scripts from same origin (no inline)
			"style-src 'self' 'unsafe-inline'", // CSS-in-JS and Tailwind require inline styles
			"img-src 'self' data:",
			"font-src 'self' data:",
			"connect-src 'self'", // API calls to same origin only
			"frame-ancestors 'none'",
			"base-uri 'self'",
			"form-action 'self'",
		].join("; ");
	}

	// First, try to serve from embedded assets (production)
	if (embeddedDashboard?.[assetPath]) {
		const asset = embeddedDashboard[assetPath];
		const buffer = Buffer.from(asset.content, "base64");
		return new Response(buffer, {
			headers: {
				"Content-Type": contentType || asset.contentType,
				"Cache-Control": cacheControl || CACHE.CACHE_CONTROL_NO_CACHE,
				...securityHeaders,
			},
		});
	}

	// Fallback: try file system (development)
	const fullPath = resolveDashboardAsset(assetPath);
	if (!fullPath) {
		return new Response("Not Found", { status: HTTP_STATUS.NOT_FOUND });
	}

	// Auto-detect content type if not provided
	if (!contentType) {
		if (assetPath.endsWith(".js")) contentType = "application/javascript";
		else if (assetPath.endsWith(".css")) contentType = "text/css";
		else if (assetPath.endsWith(".html")) contentType = "text/html";
		else if (assetPath.endsWith(".json")) contentType = "application/json";
		else if (assetPath.endsWith(".svg")) contentType = "image/svg+xml";
		else contentType = "text/plain";
	}

	return new Response(Bun.file(fullPath), {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": cacheControl || CACHE.CACHE_CONTROL_NO_CACHE,
			...securityHeaders,
		},
	});
}

// Module-level server instance
let serverInstance: ReturnType<typeof serve> | null = null;
let registeredServerId: string | null = null;
let stopRetentionJob: (() => void) | null = null;
let stopOAuthCleanupJob: (() => void) | null = null;
let stopManagementSessionSweepJob: (() => void) | null = null;
let stopRateLimitCleanupJob: (() => void) | null = null;
let stopDataCleanupJob: (() => void) | null = null;
let stopWalCheckpointJob: (() => void) | null = null;
let stopIntegritySchedulerJob: (() => void) | null = null;
let autoRefreshScheduler: AutoRefreshScheduler | null = null;
let codexUsagePoller: CodexUsagePoller | null = null;
let cacheKeepaliveScheduler: CacheKeepaliveScheduler | null = null;
let usageSnapshotSampler: UsageSnapshotSampler | null = null;
let cacheKeepaliveSnapshotSampler: CacheKeepaliveSnapshotSampler | null = null;
let subscriptionPaymentRecorder: SubscriptionPaymentRecorder | null = null;
let codexResetCreditApplyScheduler: CodexResetCreditApplyScheduler | null =
	null;
let quotaDriftScheduler: QuotaDriftScheduler | null = null;
let memoryMonitorInterval: Timer | null = null;
// Track usage polling retry timeouts for cleanup
const usagePollingRetryTimeouts = new Map<string, NodeJS.Timeout>();

// SSL/TLS configuration
let tlsEnabled = false;

// Startup maintenance (one-shot): cleanup only (compaction available via API endpoint)
async function runStartupMaintenance(
	config: Config,
	dbOps: DatabaseOperations,
) {
	const log = new Logger("StartupMaintenance");
	try {
		const payloadHours = config.getPayloadRetentionHours();
		const requestDays = config.getRequestRetentionDays();
		const snapshotDays = config.getUsageSnapshotRetentionDays();
		const memorySnapshotDays = config.getMemorySnapshotRetentionDays();
		const payloadMaxMb = config.getPayloadMaxMb();
		const {
			removedRequests,
			removedPayloads,
			removedPayloadsBySize,
			removedSnapshots,
			removedMemorySnapshots,
			removedUnifiedClaimObservations,
		} = await dbOps.cleanupOldRequests(
			config.getPayloadRetentionMs(),
			requestDays * 24 * 60 * 60 * 1000,
			snapshotDays * 24 * 60 * 60 * 1000,
			memorySnapshotDays * 24 * 60 * 60 * 1000,
			config.getPayloadMaxBytes(),
		);
		log.info(
			`Startup cleanup removed ${removedRequests} requests, ${removedPayloads} payloads (${removedPayloadsBySize} of them over the byte budget), ${removedSnapshots} usage snapshots, ${removedMemorySnapshots} memory snapshots, and ${removedUnifiedClaimObservations} claim observations (payload=${payloadHours}h/${payloadMaxMb > 0 ? `${payloadMaxMb}MB` : "no byte budget"}, requests=${requestDays}d, snapshots=${snapshotDays}d, memory=${memorySnapshotDays}d, claims=${UNIFIED_CLAIM_OBSERVATION_RETENTION_MS / TIME_CONSTANTS.DAY}d fixed)`,
		);
		// Prune the cache-keepalive economics time-series (separate table, separate
		// retention). Mirrors the memory/usage snapshot cutoff math above.
		const keepaliveSnapshotDays =
			config.getCacheKeepaliveSnapshotRetentionDays();
		const removedKeepaliveSnapshots =
			await dbOps.deleteCacheKeepaliveSnapshotsOlderThan(
				Date.now() - keepaliveSnapshotDays * 24 * 60 * 60 * 1000,
			);
		if (removedKeepaliveSnapshots > 0) {
			log.info(
				`Startup cleanup removed ${removedKeepaliveSnapshots} cache keepalive snapshots (keepalive=${keepaliveSnapshotDays}d)`,
			);
		}
	} catch (err) {
		log.error(`Startup cleanup error: ${err}`);
	}
	try {
		// Clean up expired OAuth sessions
		const removedSessions = await dbOps.cleanupExpiredOAuthSessions();
		if (removedSessions > 0) {
			log.info(
				`Startup cleanup removed ${removedSessions} expired OAuth sessions`,
			);
		}
	} catch (err) {
		log.error(`OAuth session cleanup error: ${err}`);
	}
	try {
		// Clear expired rate_limited_until values
		const now = Date.now();
		const clearedCount = await dbOps.clearExpiredRateLimits(now);
		if (clearedCount > 0) {
			log.info(`Cleared ${clearedCount} expired rate_limited_until entries`);
		} else {
			log.info("No expired rate_limited_until entries found to clear");
		}
	} catch (err) {
		log.error(`Rate limit cleanup error: ${err}`);
	}
	// Return a no-op stopper for compatibility
	return () => {};
}

/**
 * The proxy's process-local single-flight marker, injected into the
 * capacity-restored handler so it never deep-imports a proxy-internal file. An
 * early release makes an account selectable again in one step with no cooldown
 * deadline and a zero streak, so this marker is what keeps the first request
 * after the release a SINGLE probe instead of a stampede.
 */
const capacityRestoredProbeMarker: CapacityRestoredProbeMarker = {
	markPending: markCapacityRestoredProbePending,
	rollbackPending: rollbackCapacityRestoredProbePending,
};

/**
 * Start usage polling for an account with automatic token refresh
 */
function startUsagePollingWithRefresh(
	account: Account,
	proxyContext: ProxyContext,
	startupDelayMs: number = 0,
	intervalMs: number = 90000,
) {
	const logger = new Logger("UsagePolling");
	const MAX_RETRY_ATTEMPTS = 10;
	let retryCount = 0;

	// Initial polling with token refresh
	const pollWithRefresh = async () => {
		try {
			// Create a token provider function that gets a fresh token each time
			const tokenProvider = createUsagePollingTokenProvider(
				account,
				proxyContext,
			);

			// Start usage polling with the token provider
			usageCache.startPolling(
				account.id,
				tokenProvider,
				account.provider,
				intervalMs,
				undefined, // customEndpoint
				(accountId) => {
					// Usage window has rolled over — reset session tracking so the
					// dashboard reflects the new window without waiting for the next request.
					proxyContext.dbOps
						.resetAccountSession(accountId, Date.now())
						.catch((err) =>
							logger.warn(
								`Failed to reset session for account ${accountId} on window reset: ${err}`,
							),
						);
				},
				(evidence) => {
					// Polling observed account-wide headroom (<100%) on this account.
					// Level-triggered: reported on EVERY healthy poll, so a refused or
					// missed clear heals on the next one. The handler decides whether the
					// lock may actually be released (reason-gated, causally guarded, and
					// atomic at the DB layer) — never wiping an intentional
					// `out_of_credits` floor. See clearRateLimitOnCapacityRestored.
					clearRateLimitOnCapacityRestored(
						proxyContext.dbOps,
						logger,
						evidence,
						capacityRestoredProbeMarker,
					).catch((err) =>
						logger.warn(
							`Failed to check/clear rate_limited_until for account ${evidence.accountId} on capacity restore: ${err}`,
						),
					);
				},
				(accountId) => {
					// Usage endpoint reports the subscription/seat is gone (403
					// permission_error). Auto-pause so the router stops selecting and
					// retrying a dead account. Guarded: never overwrites an existing
					// pause (e.g. a manual one).
					proxyContext.dbOps
						.pauseAccountIfActive(accountId, "subscription_expired")
						.then((pausedNow) => {
							if (pausedNow) {
								logger.warn(
									`Auto-paused account ${account.name} (${accountId}): subscription expired (usage endpoint returned 403 permission_error)`,
								);
							}
						})
						.catch((err) =>
							logger.warn(
								`Failed to auto-pause account ${accountId} on expired subscription: ${err}`,
							),
						);
				},
				(accountId) => {
					// Usage fetch works again (fired on the failure→success transition
					// and on the first success after a restart). Lift a
					// subscription_expired pause — the seat is back after renewal.
					// Guarded: only that exact pause reason is resumed.
					proxyContext.dbOps
						.resumeAccountIfPausedWithReason(accountId, "subscription_expired")
						.then((resumedNow) => {
							if (resumedNow) {
								logger.info(
									`Auto-resumed account ${account.name} (${accountId}): usage endpoint reachable again after subscription renewal`,
								);
							}
						})
						.catch((err) =>
							logger.warn(
								`Failed to auto-resume account ${accountId} after subscription renewal: ${err}`,
							),
						);
				},
				async (accountId, error) => {
					// The refresh just failed this tick. Halt polling only if the
					// account is paused AND the failure is terminal (refresh token
					// rejected → needs a manual reauth, which restarts polling via the
					// registered polling-restarter). Re-read live state; the captured
					// `account` may be stale. See shouldStopPollingPausedAccount.
					const current = await proxyContext.dbOps
						.getAccount(accountId)
						.catch(() => null);
					return shouldStopPollingPausedAccount(current, error);
				},
				// Demand-aware cadence: poll recently-active Anthropic accounts at the
				// configured active interval, back cold accounts off to the ~10-min
				// idle cadence — to relieve the shared, aggressively-rate-limited
				// /oauth/usage + /oauth/profile bucket. The proxy path calls
				// usageCache.noteActivity() on real traffic (the primary, real-time
				// activity signal + idle→active re-arm); getLastActivityMs is only a
				// cold-start fallback that reads the CURRENT DB last_used (never the
				// captured, soon-stale `account` snapshot) so an account busy right
				// before a restart still polls actively before its next request.
				//
				// Tradeoff: for idle/paused accounts, subscription-expired recovery
				// and seat-reassignment detection may now lag by up to the idle
				// interval (~10 min). Acceptable — those are not latency-critical, and
				// on-demand refresh (account-selector's refreshNow) covers real traffic.
				{
					demandAware: account.provider === "anthropic",
					// Boot stagger: defers only the FIRST fetch. Registration is
					// synchronous so the 429 ladder's on-demand refreshNow works from
					// t=0 — deferring the whole startPolling call left refreshNow a
					// silent no-op for `index * 5s` after every restart, and a 429 in
					// that window got misclassified account-wide (Claude-Backup-2,
					// 2026-08-02).
					initialDelayMs: startupDelayMs,
					getLastActivityMs: (accountId) =>
						proxyContext.dbOps
							.getAccount(accountId)
							.then((a) => a?.last_used ?? null)
							.catch(() => null),
				},
			);

			// Reset retry count on success
			retryCount = 0;
			// Clear any tracked timeout since we succeeded
			const existingTimeout = usagePollingRetryTimeouts.get(account.id);
			if (existingTimeout) {
				clearTimeout(existingTimeout);
				usagePollingRetryTimeouts.delete(account.id);
			}
		} catch (error) {
			logger.error(
				`Error starting usage polling for account ${account.name}:`,
				{
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					accountId: account.id,
					provider: account.provider,
					timestamp: new Date().toISOString(),
					hasAccessToken: !!account.access_token,
					hasRefreshToken: !!account.refresh_token,
					expiresAt: account.expires_at
						? new Date(account.expires_at).toISOString()
						: null,
				},
			);

			// Log additional context for common error types
			if (error instanceof Error) {
				if (
					error.message.includes("401") ||
					error.message.includes("Unauthorized")
				) {
					logger.error(
						`Authentication failed for account ${account.name} - check API credentials`,
						{
							accountId: account.id,
							error: error.message,
						},
					);
				} else if (
					error.message.includes("network") ||
					error.message.includes("fetch")
				) {
					logger.error(
						`Network error for account ${account.name} - check connectivity`,
						{
							accountId: account.id,
							error: error.message,
						},
					);
				} else if (error.message.includes("rate limit")) {
					logger.error(
						`Rate limited for account ${account.name} - backing off`,
						{
							accountId: account.id,
							error: error.message,
						},
					);
				}
			}

			// Clear any existing retry timeout before scheduling a new one
			const existingTimeout = usagePollingRetryTimeouts.get(account.id);
			if (existingTimeout) {
				clearTimeout(existingTimeout);
				usagePollingRetryTimeouts.delete(account.id);
			}

			// Check if we've exceeded max retry attempts
			retryCount++;
			if (retryCount >= MAX_RETRY_ATTEMPTS) {
				logger.error(
					`Max retry attempts (${MAX_RETRY_ATTEMPTS}) reached for account ${account.name}. Please check the account configuration and try restarting the server after resolving issues.`,
				);
				return;
			}

			// Don't restore paused state on error - let the user control pause/resume via API
			// Retry with exponential backoff (5 min, 10 min, 20 min, ...)
			const baseDelayMs = 5 * 60 * 1000; // 5 minutes
			const delayMs = Math.min(
				baseDelayMs * 2 ** (retryCount - 1),
				60 * 60 * 1000, // Cap at 1 hour
			);
			logger.info(
				`Scheduling retry ${retryCount}/${MAX_RETRY_ATTEMPTS} for account ${account.name} in ${Math.round(delayMs / 1000 / 60)} minutes`,
			);

			const timeoutId = setTimeout(() => {
				logger.info(
					`Retrying usage polling for account ${account.name} (attempt ${retryCount}/${MAX_RETRY_ATTEMPTS})`,
				);
				usagePollingRetryTimeouts.delete(account.id);
				pollWithRefresh();
			}, delayMs);

			// Track the timeout for cleanup
			usagePollingRetryTimeouts.set(account.id, timeoutId);
		}
	};

	// Register the poller NOW; the boot stagger rides in as the policy's
	// initialDelayMs (first fetch only), never as a registration delay.
	pollWithRefresh();
}

// Export for programmatic use
export default async function startServer(options?: {
	port?: number;
	withDashboard?: boolean;
	sslKeyPath?: string;
	sslCertPath?: string;
}) {
	// Return existing server if already running
	if (serverInstance) {
		const existingPort = serverInstance.port;
		if (typeof existingPort !== "number") {
			throw new Error("Server instance has no valid port");
		}
		return {
			port: existingPort,
			stop: () => {
				if (serverInstance) {
					serverInstance.stop();
					serverInstance = null;
				}
			},
		};
	}

	// Refuse an unsupported runtime before anything else runs. Below the floor
	// the proxy segfaults natively whenever a client aborts a streaming
	// response (oven-sh/bun#32111) — uncatchable, so this string comparison is
	// the only chance to say why. See packages/core/src/bun-runtime-floor.ts
	// for the trade this makes and why only a positively-parsed low version
	// refuses.
	//
	// This is the earliest point in *our* code, not the earliest point in the
	// process: the whole import graph above already executed. A runtime too old
	// to parse this file is beyond anything we can report on.
	assertBunRuntimeFloor();

	// Stamp the commit this process boots on, before anything else can spend
	// time. The checkout IS the deployment, so HEAD moves under us whenever work
	// lands without a restart; capturing at first request instead would just
	// record the moved HEAD and report the process as up to date.
	captureBootProvenance();

	const {
		port = NETWORK.DEFAULT_PORT,
		withDashboard = true,
		sslKeyPath,
		sslCertPath,
	} = options || {};

	// Enable TLS if both certificate paths are provided
	tlsEnabled = !!(sslKeyPath && sslCertPath);

	// Validate SSL certificate files if TLS is enabled
	let validatedSslKeyPath: string | undefined;
	let validatedSslCertPath: string | undefined;

	if (tlsEnabled && sslKeyPath && sslCertPath) {
		// Validate paths for security (prevent path traversal)
		try {
			validatedSslKeyPath = validatePathOrThrow(sslKeyPath, {
				description: "SSL key file",
			});
			validatedSslCertPath = validatePathOrThrow(sslCertPath, {
				description: "SSL certificate file",
			});
		} catch (error) {
			// Don't expose path details in error messages - log to server only
			console.error("SSL file path validation failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw new Error(
				"SSL file path validation failed. Check server logs for details.",
			);
		}

		if (!existsSync(validatedSslKeyPath)) {
			// Don't expose paths in error messages
			console.error("SSL key file not found", {
				path: validatedSslKeyPath,
			});
			throw new Error("SSL key file not found. Check server logs for details.");
		}
		if (!existsSync(validatedSslCertPath)) {
			// Don't expose paths in error messages
			console.error("SSL certificate file not found", {
				path: validatedSslCertPath,
			});
			throw new Error(
				"SSL certificate file not found. Check server logs for details.",
			);
		}
	}

	// Initialize DI container
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	container.registerInstance(SERVICE_KEYS.Logger, new Logger("Server"));

	// Initialize payload encryption (no-op if PAYLOAD_ENCRYPTION_KEY is unset).
	// This must run before any database operations that read/write payloads.
	// The RequestRecorder writes payloads on this thread, so initializing the
	// main thread here is sufficient (the DB workers don't touch payloads).
	await initPayloadEncryption();

	// Initialize components
	const config = container.resolve<Config>(SERVICE_KEYS.Config);
	const runtime = config.getRuntime();
	// Override port if provided
	if (port !== runtime.port) {
		runtime.port = port;
	}
	DatabaseFactory.initialize(undefined, runtime);
	const dbOps = await DatabaseFactory.getInstanceAsync();

	// One-time migration: promote pre-existing DBs from auto_vacuum=NONE to
	// INCREMENTAL. Fresh DBs created since ensureSchema() started issuing
	// `PRAGMA auto_vacuum = INCREMENTAL` are already in mode 2 and this is a
	// fast no-op. Existing DBs upgraded into this build run a full VACUUM
	// here — minutes on a multi-GB file. Done BEFORE the HTTP listener binds
	// so the proxy never sees a stalled writer slot.
	const startupLog = new Logger("Startup");
	try {
		const result = dbOps.bootstrapAutoVacuum();
		if (result.migrated) {
			startupLog.info(
				`One-time auto_vacuum migration: mode ${result.modeBefore} → ${result.modeAfter} ` +
					`in ${result.durationMs}ms. Future free-page reclamation runs incrementally via the ` +
					`hourly worker — no more blocking VACUUM.`,
			);
			if (result.modeAfter !== 2) {
				startupLog.error(
					`auto_vacuum still ${result.modeAfter} after migration VACUUM — ` +
						`incremental reclamation will be a no-op. Investigate disk space and DB integrity.`,
				);
			}
		} else if (result.modeBefore === 1) {
			// Operator set auto_vacuum=FULL on purpose. We don't migrate it to
			// INCREMENTAL silently because FULL reclaims pages on every COMMIT
			// while INCREMENTAL only reclaims when our hourly worker runs —
			// rewriting that policy without notice would surprise the user.
			// Log so it shows up in startup logs and `journalctl`. (Greptile #230)
			startupLog.info(
				`auto_vacuum=FULL (mode 1) detected — left in place. The hourly incremental_vacuum ` +
					`worker is a no-op under FULL mode; pages are reclaimed on every COMMIT. ` +
					`Switch to INCREMENTAL manually if you want the worker-driven cadence.`,
			);
		}
	} catch (err) {
		startupLog.error(
			`Bootstrap auto_vacuum migration failed: ${err instanceof Error ? err.message : String(err)}. ` +
				`Free pages will not be reclaimed until this is resolved. ` +
				`Common causes: disk full (VACUUM needs ~2× DB size free), DB corruption.`,
		);
		throw err;
	}

	// Start periodic integrity scheduler. The startup `PRAGMA integrity_check`
	// is intentionally gone — on multi-GB databases it blocked startup for
	// tens of seconds. The scheduler runs `quick_check` every few hours and
	// a full `integrity_check` + `foreign_key_check` daily (in a worker), and
	// surfaces results via /api/storage and the dashboard.
	stopIntegritySchedulerJob = startIntegrityScheduler(dbOps);

	const db = dbOps.getAdapter();
	const log = container.resolve<Logger>(SERVICE_KEYS.Logger);
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

	// Initialize async DB writer. It owns the off-thread payload writer: the
	// factory is only invoked on the first payload publication, so a run that
	// never stores payloads never spawns a worker. Its dispose() drains the
	// metadata queue, gives the worker a bounded flush + close-ack window and
	// terminates every generation — and it runs inside `shutdown()` (reverse
	// registration order), while the DB handle is still open: the server never
	// closes dbOps before exiting.
	const asyncWriter = new AsyncDbWriter({
		createPayloadWriter: dbOps.createPayloadWriterFactory({
			getPayloadRetentionMs: () => config.getPayloadRetentionMs(),
		}),
	});
	container.registerInstance(SERVICE_KEYS.AsyncWriter, asyncWriter);
	registerDisposable(asyncWriter);

	// Initialize the main-thread request recorder. It owns all request
	// persistence (request/routing/payload rows, billingType, account
	// side-effects) — extracted from the post-processor worker to stop
	// transferring large request bodies into the long-lived worker (Bun #5709).
	// initPayloadEncryption() ran above (before any payload write); the recorder
	// encrypts on this thread and hands the ciphertext to the payload worker,
	// which performs the INSERT off-thread.
	const requestRecorder = new RequestRecorder({
		dbOps,
		asyncWriter,
		getStorePayloads: () => config.getStorePayloads(),
		emitSummaryEvent: (resp) =>
			requestEvents.emit("event", { type: "summary", payload: resp }),
	});
	registerDisposable({ dispose: () => requestRecorder.dispose() });
	// Wire the recorder into the usage worker's onSummary callback (module-scoped
	// controller created before any context).
	setRequestRecorder(requestRecorder);

	// Initialize pricing logger
	const pricingLogger = new Logger("Pricing");
	container.registerInstance(SERVICE_KEYS.PricingLogger, pricingLogger);
	setPricingLogger(pricingLogger);

	// Strategy is constructed below after RuntimeConfig is built. The router
	// accepts a getter so it can read the live (post-hot-reload) instance.
	let currentStrategy: LoadBalancingStrategy | null = null;

	// The management login. Built BEFORE the API router so both it and the
	// proxy's AuthService share one instance — the router hands it to the auth
	// endpoints and to the SSE revocation guard, while the front-door gate
	// reaches it through `authService`. Two instances would work but would make
	// "is a password configured" two independent reads of the same row.
	const sessionAuth = new SessionAuthService(dbOps);

	const apiRouter = new APIRouter({
		db,
		config,
		dbOps,
		sessionAuth,
		runtime: {
			port,
			tlsEnabled,
		},
		getAsyncWriterHealth: () => asyncWriter.getHealth(),
		getIntegrityStatus: () => dbOps.getIntegrityStatus(),
		getStrategy: () => currentStrategy,
		getEventLoopLag: () => getEventLoopStats(),
		// Joins the breaker's live buckets with the hold semaphore's per-bucket
		// occupancy — two module-level maps that only this layer sees together,
		// and the pairing is the useful part: an open bucket with many holders is
		// an incident actively costing client connections.
		//
		// The UNION, not just the breaker's rows. A hold freezes its slot key at
		// entry, so holders outlive the bucket they were admitted against — an
		// operator clear, or a provider-wide bucket appearing and moving the
		// effective gate, leaves occupancy under a key the breaker no longer
		// knows. Reporting only live buckets would silently drop those still
		// draining, which is the case an operator is most likely to be chasing.
		getProviderOverload: () => {
			const live = getOverloadDiagnostics();
			const rows: ProviderOverloadStatus[] = live.map((bucket) =>
				bucket.state === "open" && bucket.until !== null
					? {
							state: "open" as const,
							key: bucket.key,
							until: bucket.until,
							generation: bucket.generation,
							lease: bucket.lease,
							activeHoldSlots: getActiveOverloadHoldCount(bucket.key),
						}
					: {
							state: "half-open" as const,
							key: bucket.key,
							until: null,
							generation: bucket.generation,
							lease: bucket.lease,
							activeHoldSlots: getActiveOverloadHoldCount(bucket.key),
						},
			);
			for (const key of getOccupiedOverloadHoldKeys()) {
				if (rows.some((row) => row.key === key)) continue;
				rows.push({
					state: "closed",
					key,
					until: null,
					generation: null,
					lease: null,
					activeHoldSlots: getActiveOverloadHoldCount(key),
				});
			}
			return rows;
		},
	});

	// The read-only widget API. Its own router, mounted as a sibling of the wire
	// mounts rather than under `/api/*`, so the management session gate cannot
	// reach it and no exemption list has to keep a credential-less device
	// working.
	// `getStrategy` is the same closure the management router gets, so the
	// routing candidate this surface publishes is the one the dashboard badge
	// shows rather than a second prediction made from a second snapshot.
	const publicRouter = new PublicRouter({
		dbOps,
		config,
		getStrategy: () => currentStrategy,
	});

	// Initialize AuthService for proxy authentication. It also answers the
	// front door's `session` requirement for `/api/*`, so it is handed the same
	// SessionAuthService the API router uses.
	const authService = new AuthService(dbOps, undefined, sessionAuth);

	// Expired management sessions: swept once at startup and hourly after that.
	// Neither ceiling depends on this running — validation enforces both on
	// every read and deletes what it rejects — so this is housekeeping that
	// keeps the table from accumulating rows nobody will ever look up again.
	void sessionAuth.sweepExpiredSessions().catch((err) => {
		log.debug(`Startup management-session sweep failed: ${err}`);
	});
	const unregisterSessionSweep = registerCleanup({
		id: "management-session-sweep",
		callback: async () => {
			try {
				const removed = await sessionAuth.sweepExpiredSessions();
				if (removed > 0) {
					log.debug(`Swept ${removed} expired management session(s)`);
				}
			} catch (err) {
				log.error(`Management session sweep error: ${err}`);
			}
		},
		minutes: 60,
		description: "Management session sweep",
	});
	stopManagementSessionSweepJob = unregisterSessionSweep;

	// Run startup maintenance once (cleanup only) - fire and forget
	runStartupMaintenance(config, dbOps).catch((err) => {
		log.error("Startup maintenance failed:", err);
	});
	stopRetentionJob = () => {}; // No-op stopper

	// Set up periodic OAuth session cleanup (every hour)
	const unregisterOAuthCleanup = registerCleanup({
		id: "oauth-session-cleanup",
		callback: async () => {
			try {
				const removedSessions = await dbOps.cleanupExpiredOAuthSessions();
				if (removedSessions > 0) {
					log.debug(`Cleaned up ${removedSessions} expired OAuth sessions`);
				}
			} catch (err) {
				log.error(`OAuth session cleanup error: ${err}`);
			}
		},
		minutes: 60,
		description: "OAuth session cleanup",
	});

	stopOAuthCleanupJob = unregisterOAuthCleanup;

	// Set up periodic rate limit cleanup (every hour)
	const unregisterRateLimitCleanup = registerCleanup({
		id: "rate-limit-cleanup",
		callback: async () => {
			try {
				const now = Date.now();
				const clearedCount = await dbOps.clearExpiredRateLimits(now);
				if (clearedCount > 0) {
					log.debug(
						`Cleared ${clearedCount} expired rate_limited_until entries`,
					);
				}
			} catch (err) {
				log.error(`Rate limit cleanup error: ${err}`);
			}
		},
		minutes: 60,
		description: "Rate limit cleanup",
	});

	stopRateLimitCleanupJob = unregisterRateLimitCleanup;

	// Max free pages the hourly tick reclaims to the OS. Sized to outpace normal
	// hourly deletes AND steadily drain a pre-existing freelist backlog (a large
	// DB can carry hundreds of thousands of freed pages). The worker reclaims
	// this in small batches that release the writer slot between each, so a high
	// budget drains fast without lengthening any single contended stall, and it
	// early-breaks once the freelist is empty — so on a caught-up DB the budget
	// costs nothing beyond that hour's actual deletes. 40000 pages × 4 KiB ≈
	// 160 MiB/hr. See incremental-vacuum-worker.ts for the batching rationale.
	const INCREMENTAL_VACUUM_PAGES_PER_TICK = 40000;

	// Set up periodic data retention cleanup every 1 hour
	const dataRetentionCleanup = async () => {
		const startTime = Date.now();
		try {
			const requestDays = config.getRequestRetentionDays();
			const snapshotDays = config.getUsageSnapshotRetentionDays();
			const memorySnapshotDays = config.getMemorySnapshotRetentionDays();
			const {
				removedRequests,
				removedPayloads,
				removedPayloadsBySize,
				removedSnapshots,
				removedMemorySnapshots,
				removedUnifiedClaimObservations,
			} = await dbOps.cleanupOldRequests(
				config.getPayloadRetentionMs(),
				requestDays * TIME_CONSTANTS.DAY,
				snapshotDays * TIME_CONSTANTS.DAY,
				memorySnapshotDays * TIME_CONSTANTS.DAY,
				config.getPayloadMaxBytes(),
			);
			// Prune the cache-keepalive economics time-series (separate table,
			// separate retention). Mirrors the memory/usage snapshot cutoff math.
			const keepaliveSnapshotDays =
				config.getCacheKeepaliveSnapshotRetentionDays();
			const removedKeepaliveSnapshots =
				await dbOps.deleteCacheKeepaliveSnapshotsOlderThan(
					Date.now() - keepaliveSnapshotDays * TIME_CONSTANTS.DAY,
				);
			if (
				removedRequests > 0 ||
				removedPayloads > 0 ||
				removedSnapshots > 0 ||
				removedMemorySnapshots > 0 ||
				removedKeepaliveSnapshots > 0 ||
				removedUnifiedClaimObservations > 0
			) {
				log.info(
					// Payload removals are split so the age rule and the byte budget
					// are distinguishable in the journal — they delete for different
					// reasons and only one of them is operator-tunable by size.
					`Periodic cleanup: removed ${removedRequests} requests, ${removedPayloads} payloads (${removedPayloadsBySize} of them over the byte budget), ${removedSnapshots} usage snapshots, ${removedMemorySnapshots} memory snapshots, ${removedKeepaliveSnapshots} cache keepalive snapshots, ${removedUnifiedClaimObservations} claim observations in ${Date.now() - startTime}ms`,
				);
				// Reclaim freed pages to the OS, off-thread via the incremental-
				// vacuum worker, which batches the budget into slot-releasing
				// chunks so main-thread writes (rate-limit updates, OAuth refresh,
				// post-processor inserts) don't pile up on busy_timeout during a
				// long reclaim — see INCREMENTAL_VACUUM_PAGES_PER_TICK above and
				// the batching rationale in incremental-vacuum-worker.ts. Pre-fix
				// this path passed 200000 and silently fell back to a full main-
				// thread VACUUM when auto_vacuum=NONE — see incrementalVacuum() in
				// packages/database/src/database-operations.ts.
				dbOps
					.incrementalVacuum(INCREMENTAL_VACUUM_PAGES_PER_TICK)
					.catch((err) => {
						log.error(`Incremental vacuum error: ${err}`);
					});
			}
		} catch (err) {
			log.error(`Periodic data retention cleanup error: ${err}`);
		}
	};

	// Periodic data retention cleanup every 1 hour (reduced from 6 hours for more aggressive cleanup).
	// runStartupMaintenance() (called above) handles the initial cleanup on boot,
	// so we don't fire dataRetentionCleanup() immediately to avoid concurrent
	// large deletes that can spike WAL size and wedge the service.
	const unregisterDataCleanup = registerCleanup({
		id: "data-retention-cleanup",
		callback: dataRetentionCleanup,
		minutes: 60, // every 1 hour
		description: "Periodic data retention cleanup and incremental vacuum",
	});

	stopDataCleanupJob = unregisterDataCleanup;

	// Above this WAL file size, the periodic checkpoint tick logs a WARN instead
	// of DEBUG. With the main connection at wal_autocheckpoint=0 this tick is the
	// SOLE WAL reclaimer, so a WAL that stays large means TRUNCATE is being
	// starved (a long-lived reader perpetually holding frames) and is trending
	// toward disk-fill — which must be visible, not buried at DEBUG. A healthy
	// sawtooth resets to ~0 each reader-idle tick; 256 MiB is well above that but
	// well below the 224 MiB the pre-fix PASSIVE regime sat at indefinitely.
	const WAL_SIZE_WARN_MIB = 256;

	// Periodic WAL checkpoint every 60s to keep the WAL bounded. Runs PRAGMA
	// optimize + PRAGMA wal_checkpoint(TRUNCATE) in a worker thread — this is the
	// ONLY WAL reclaimer (the main connection has wal_autocheckpoint=0 so it never
	// checkpoints synchronously on the request hot path). 60s (down from 5min)
	// gives TRUNCATE many more chances to land in a reader-idle gap and zero the
	// WAL; busy_timeout=0 means a tick that overlaps a reader just skips, never
	// blocks. The old synchronous dbOps.optimize() parked the main thread in
	// SQLite's busy handler for up to busy_timeout (10s) whenever the hourly
	// vacuum worker held the write lock, freezing the event loop.
	const unregisterWalCheckpoint = registerCleanup({
		id: "wal-checkpoint",
		callback: () => {
			dbOps
				.optimizeAsync()
				.then(async (result) => {
					if (!result.ok) {
						log.warn(`WAL checkpoint/optimize error: ${result.error}`);
						return;
					}
					// This tick is the sole WAL reclaimer, so surface the WAL size
					// every tick: a WAL trending toward disk-fill (reader-starved
					// TRUNCATE, or repeated skips) escalates to WARN; otherwise DEBUG.
					const walMiB = (await dbOps.getWalSizeBytes()) / (1024 * 1024);
					const status = result.skipped ? "skipped (DB busy)" : "ran";
					// Duration surfaces the optimize+checkpoint's writer-slot hold. A
					// bounded ANALYZE (PRAGMA analysis_limit in the worker) keeps this
					// in the single-digit/low-tens ms range; a spike back into the
					// hundreds/seconds means ANALYZE is scanning unbounded again.
					const timing =
						result.durationMs != null ? ` in ${result.durationMs}ms` : "";
					if (walMiB > WAL_SIZE_WARN_MIB) {
						log.warn(
							`WAL checkpoint ${status}${timing}; WAL ${walMiB.toFixed(1)}MiB exceeds ${WAL_SIZE_WARN_MIB}MiB — reclaim may be starved by a long-lived reader`,
						);
					} else {
						log.debug(
							`checkpoint/optimize ${status}${timing}; WAL ${walMiB.toFixed(1)}MiB`,
						);
					}
				})
				.catch((err) => {
					log.error(`WAL checkpoint error: ${err}`);
				});
		},
		minutes: 1,
		description: "WAL checkpoint to prevent unbounded WAL file growth",
	});
	stopWalCheckpointJob = unregisterWalCheckpoint;

	// Initialize load balancing strategy (will be created after runtime config)

	// Get the provider
	const provider = getProvider("anthropic");
	if (!provider) {
		throw new Error("Anthropic provider not available");
	}

	// Create runtime config
	const runtimeConfig: RuntimeConfig = {
		clientId: config.get(
			"client_id",
			"9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		) as string,
		retry: {
			attempts: config.get("retry_attempts", 3) as number,
			delayMs: config.get("retry_delay_ms", 1000) as number,
			backoff: config.get("retry_backoff", 2) as number,
		},
		sessionDurationMs: config.get(
			"session_duration_ms",
			TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
		) as number,
		port,
	};

	// Now create the strategy with runtime config
	const strategy = buildStrategy(
		config.getStrategy(),
		runtimeConfig.sessionDurationMs,
	);
	log.info(`Load-balancing strategy: ${config.getStrategy()}`);

	const strategyStore: StrategyStore = Object.assign(dbOps, {
		getAccountUtilization(accountId: string, provider: string): number | null {
			const data = usageCache.get(accountId);
			if (!data) return null;
			return getRepresentativeUtilizationForProvider(data, provider);
		},
		getAccountCapacity(
			accountId: string,
			provider: string,
			now: number,
		): CapacitySignal | null {
			return getFreshCapacity(
				usageCache,
				accountId,
				provider,
				now,
				config.getUsagePollIntervalMs() * 2,
			);
		},
	});

	strategy.initialize?.(strategyStore);
	currentStrategy = strategy;

	// Proxy context. Usage is computed inline on the main thread (no worker):
	// forwardToClient feeds the per-request UsageState and finalizes it after
	// transport finish, attaching the summary to the RequestRecorder.
	const proxyContext: ProxyContext = {
		strategy,
		dbOps,
		runtime: runtimeConfig,
		config,
		provider,
		refreshInFlight: new Map(),
		asyncWriter,
		requestRecorder,
	};

	// The single authority for autonomous (scheduled-prime) and manual
	// (manual-refresh) Codex spend. Constructed ONCE over this proxyContext and
	// shared: Step 3 injects it into the auto-refresh scheduler (below) so codex
	// priming uses the native `/responses` ping instead of the translated Haiku
	// dummy; Step 4 will reuse this SAME instance in the codex usage refresher.
	const codexSpendCoordinator = new CodexSpendCoordinator(proxyContext);

	// Register this server's refresh clearing capability
	const serverId = `server-${runtime.port}`;
	// Track at module scope so handleGracefulShutdown can unregister cleanly.
	registeredServerId = serverId;
	registerRefreshClearer(serverId, (accountId: string) => {
		// Clear refresh cache for this account in this server's context
		proxyContext.refreshInFlight.delete(accountId);
		log.info(`Cleared refresh cache for account ${accountId} on ${serverId}`);
	});

	// Register this server's usage polling restart capability
	registerPollingRestarter(serverId, async (accountId: string) => {
		const account = await dbOps.getAccount(accountId);
		if (!account) {
			log.warn(
				`Cannot restart usage polling: account ${accountId} not found on ${serverId}`,
			);
			return false;
		}
		if (account.provider !== "anthropic") {
			log.warn(
				`Cannot restart usage polling: account ${account.name} is not an Anthropic OAuth account`,
			);
			return false;
		}
		if (!account.access_token && !account.refresh_token) {
			log.warn(
				`Cannot restart usage polling: account ${account.name} has no tokens`,
			);
			return false;
		}
		log.info(
			`Restarting usage polling for account ${account.name} on ${serverId}`,
		);
		usageCache.stopPolling(accountId);
		startUsagePollingWithRefresh(
			account,
			proxyContext,
			0,
			config.getUsagePollIntervalMs(),
		);
		return true;
	});

	// Register this server's codex on-demand usage refresher. Delegates to the
	// shared CodexSpendCoordinator: the manual "Refresh usage" click routes through
	// refreshManual → readUsageStatus, a ZERO-COST `GET /wham/usage` read (it does
	// NOT ping `/responses` and does NOT spend quota). The read is applied via the
	// shared applyCodexUsageStatus bookkeeping, so it carries prior codexCredits
	// FORWARD and persists the rate-limit reset — but a 200 for an exhausted account
	// never clears `rate_limited_until`, and it never applies a cooldown. On a read
	// failure the prior usage cache is kept and the failure is reported (no ping
	// fallback).
	registerCodexUsageRefresher(serverId, (accountId: string) =>
		codexSpendCoordinator.refreshManual(accountId),
	);
	registerCodexResetCreditsRefresher(serverId, (accountId: string) =>
		codexSpendCoordinator.refreshResetCredits(accountId),
	);
	registerCodexResetCreditConsumer(serverId, (accountId, request) =>
		codexSpendCoordinator.consumeResetCredit(accountId, request),
	);
	// Warm the read-only earned-reset cache without delaying server startup. The
	// accounts handler keeps it fresh afterward with a TTL-gated background read.
	void dbOps
		.getAdapter()
		.query<{ id: string; name: string }>(
			"SELECT id, name FROM accounts WHERE provider = 'codex'",
		)
		.then(async (accounts) => {
			for (const account of accounts) {
				const outcome = await codexSpendCoordinator.refreshResetCredits(
					account.id,
				);
				if (!outcome.success) {
					log.debug(
						`Initial Codex reset metadata refresh skipped for ${account.name}: ${outcome.message}`,
					);
				}
			}
		})
		.catch((error) =>
			log.warn("Initial Codex reset metadata refresh failed:", error),
		);

	// Register this server's session-affinity clearing capability, so the
	// "Reset session stickiness" HTTP action can wipe the in-memory affinity
	// pins held by this server's load-balancing strategy.
	registerAffinityClearer(
		serverId,
		(accountId: string) =>
			currentStrategy?.clearAffinityForAccount?.(accountId) ?? 0,
	);

	// Initialize auto-refresh scheduler (now that proxyContext is available).
	// Inject the shared CodexSpendCoordinator so codex scheduled priming routes
	// through the native ping; anthropic/zai keep the translated dummy path.
	autoRefreshScheduler = new AutoRefreshScheduler(
		db,
		proxyContext,
		codexSpendCoordinator,
	);
	autoRefreshScheduler.start();

	// Demand-aware Codex usage poller: keeps the usage cache warm with TIMED
	// readings via the zero-cost `GET /wham/usage` read, so the snapshot sampler
	// records continuous history for idle codex accounts (the quota-drift fit
	// needs observation runs, and real traffic alone only covers active bursts).
	// Skips the network read whenever live traffic already produced a reading
	// younger than one active interval. See CodexUsagePoller for the cadence
	// policy; the active interval is shared with the Anthropic usage poller.
	codexUsagePoller = new CodexUsagePoller({
		// A narrow projection rather than getAllAccounts(): this runs on every 30s
		// heartbeat, and the poller only needs these five columns.
		listCodexAccounts: () =>
			dbOps
				.getAdapter()
				.query<PolledCodexAccount>(
					"SELECT id, name, access_token, refresh_token, last_used FROM accounts WHERE provider = 'codex'",
				),
		readUsage: (accountId) => codexSpendCoordinator.readUsageStatus(accountId),
		peekObservedAtMs: (accountId) =>
			usageCache.peekWithAge(accountId)?.observedAtMs ?? null,
		activeIntervalMs: () => config.getUsagePollIntervalMs(),
	});
	codexUsagePoller.start();

	// Initialize cache keepalive scheduler
	cacheKeepaliveScheduler = new CacheKeepaliveScheduler(proxyContext, config);
	cacheKeepaliveScheduler.start();

	// Initialize token health monitoring service
	startGlobalTokenHealthChecks(() => dbOps.getAllAccounts());

	// Hot reload strategy configuration
	config.on("change", ({ key }: { key: string }) => {
		if (key === "lb_strategy") {
			const newStrategyName = config.getStrategy();
			log.info(`Strategy configuration changed to: ${newStrategyName}`);
			const strategy = buildStrategy(
				newStrategyName,
				runtimeConfig.sessionDurationMs,
			);
			strategy.initialize?.(strategyStore);
			proxyContext.strategy = strategy;
			currentStrategy = strategy;
		}
		// store_payloads needs no worker push anymore: the RequestRecorder reads
		// config.getStorePayloads() live on every begin()/capture/persist, so a
		// hot-reload of the flag takes effect on the next request automatically.
	});

	// Codex reads its model catalog from `GET /v1/models`, and the catalog is
	// per-subscription — so it comes from one of OUR Codex accounts, not from the
	// client, which authenticates with a ClankerMux API key and holds no
	// upstream-valid token. Best-effort throughout: `getCatalog` returning null
	// puts the route back on the static list it served before.
	const codexModelCatalog = new CodexModelCatalogCache({
		listAccounts: () => proxyContext.dbOps.getAllAccounts(),
		getApiKeyPin: (apiKeyId) => proxyContext.dbOps.getApiKeyPin(apiKeyId),
		getAccessToken: (account) => getValidAccessToken(account, proxyContext),
		fetchCatalog: fetchCodexModelCatalog,
	});

	// Everything the front door needs, bound once. `fetch` is a thin wrapper
	// around routeRequest so the routing itself — which namespace a request
	// belongs to, whether it needs a key, which handler owns it — is reachable
	// from a test instead of living inside a Bun.serve closure.
	const routerDeps: RequestRouterDeps = {
		handleApiRequest: (url, req) => apiRouter.handleRequest(url, req),
		handlePublicRequest: (req, url) => publicRouter.handle(req, url),
		authenticate: (req, path, method, requirement) =>
			authService.authenticateRequest(req, path, method, requirement),
		dispatchProxy: (req, url, apiKeyId, apiKeyName) =>
			dispatchProxyRequest(req, url, proxyContext, apiKeyId, apiKeyName),
		handleResponses: (req, url, apiKeyId, apiKeyName) =>
			handleResponsesRequest(
				req,
				url,
				handleProxy as Parameters<typeof handleResponsesRequest>[2],
				proxyContext,
				apiKeyId,
				apiKeyName,
			),
		handleModels: (url, apiKeyId) =>
			handleModelsRoute(
				url,
				{
					getCatalog: (keyId) => codexModelCatalog.get(keyId),
					staticModels: handleModelsRequest,
				},
				apiKeyId ?? null,
			),
		withDashboard,
		dashboardManifest,
		serveDashboardFile,
	};

	// Main server
	// Build server configuration with optional TLS and hostname binding
	const hostname = readEnv("HOST") || "0.0.0.0"; // Allow binding configuration
	try {
		const serverConfig = {
			port: runtime.port,
			hostname,
			// Run below Bun's 255s hard cap; long holds/streams re-arm their own
			// per-connection idle timer via server.timeout(req, N) (see proxy.ts).
			idleTimeout: NETWORK.SERVER_IDLE_TIMEOUT_SECONDS,
			...(tlsEnabled && validatedSslKeyPath && validatedSslCertPath
				? {
						tls: {
							key: readFileSync(validatedSslKeyPath),
							cert: readFileSync(validatedSslCertPath),
						},
					}
				: {}),
			async fetch(req: Request, server: Server<undefined>) {
				// Stash the live Bun Server so the proxy can re-arm a held/streaming
				// connection's idle timer via server.timeout(req, N). Assigned here
				// (not just after serve()) so it's set even on the very first request.
				proxyContext.server = server;
				return await routeRequest(req, routerDeps);
			},
		};

		serverInstance = serve(serverConfig);
		// Make the live Server reachable from the proxy for idle-timer re-arming.
		// The fetch handler also assigns this per-request (covers the type), but
		// stashing it here too keeps non-request callers (e.g. schedulers driving
		// internal proxy dispatch) able to re-arm.
		proxyContext.server = serverInstance;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "EADDRINUSE"
		) {
			console.error(
				`❌ Port ${runtime.port} is already in use. Please use a different port.`,
			);
			console.error(
				`   You can specify a different port with: --port <number>`,
			);
			void shutdown(); // Don't await to avoid async issues in catch
			process.exit(1);
		}
		throw error;
	}

	// Event-loop lag watchdog — makes main-thread stalls (synchronous bun:sqlite
	// etc.) diagnosable: WARN/ERROR logs on blocked ticks, live stats on
	// /api/system/status, and peak lag persisted per memory snapshot below.
	startEventLoopMonitor();

	// Memory monitoring - log RSS every 60s with warnings at growth thresholds
	const baselineRss = process.memoryUsage.rss();
	const memLog = new Logger("MemoryMonitor");
	memoryMonitorInterval = setInterval(() => {
		const mem = process.memoryUsage();
		const rssMb = Math.round(mem.rss / 1024 / 1024);
		const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
		const growthBytes = mem.rss - baselineRss;
		const growthMb = Math.round(growthBytes / 1024 / 1024);

		// Persist this sample into the memory_snapshots time-series that backs the
		// dashboard "Memory Usage" graph. Fire-and-forget at debug level: a
		// transient DB hiccup must never disturb the monitor or spam the journal.
		// eventLoopMaxLagMs drains (and resets) the lag monitor's window counter,
		// so each row carries the peak lag of exactly its own sample interval.
		void dbOps
			.insertMemorySnapshot({
				sampledAt: Date.now(),
				rssBytes: mem.rss,
				heapUsedBytes: mem.heapUsed,
				heapTotalBytes: mem.heapTotal,
				eventLoopMaxLagMs: drainEventLoopSnapshotMaxLagMs(),
			})
			.catch((err) => memLog.debug(`memory snapshot insert failed: ${err}`));

		if (growthBytes > MEMORY_GROWTH_ERROR_BYTES) {
			memLog.error(
				`RSS: ${rssMb}MB, Heap: ${heapMb}MB, Growth: +${growthMb}MB (>1GB growth - potential leak)`,
			);
		} else if (growthBytes > MEMORY_GROWTH_WARN_BYTES) {
			memLog.warn(
				`RSS: ${rssMb}MB, Heap: ${heapMb}MB, Growth: +${growthMb}MB (>512MB growth)`,
			);
		} else {
			memLog.debug(
				`RSS: ${rssMb}MB, Heap: ${heapMb}MB, Growth: +${growthMb}MB`,
			);
		}
	}, MEMORY_MONITOR_INTERVAL_MS);
	memoryMonitorInterval.unref();

	// Warn loudly if bound to a non-loopback address. The management surface
	// (/api/*) is unauthenticated by design — trust boundary is "can you reach
	// the port" — so anything besides loopback exposes account management,
	// debug endpoints, key administration, and request logs to the network.
	// Operators should put a reverse proxy with auth in front for non-local
	// deployments.
	const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
	if (!loopbackHosts.has(hostname)) {
		log.warn(
			`ClankerMux is bound to '${hostname}' and the management API ` +
				"(/api/*) is unauthenticated. Anyone who can reach this port can " +
				"manage accounts, create/revoke API keys, read request logs, and " +
				"download heap snapshots. Bind to localhost (set CLANKERMUX_HOST=127.0.0.1) " +
				"or put ClankerMux behind a reverse proxy that enforces authentication.",
		);
	}

	// Log server startup (async)
	getVersion().then((version) => {
		if (!serverInstance) return;
		const protocol = tlsEnabled ? "https" : "http";
		const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
		const dashboardStatus =
			withDashboard && dashboardManifest
				? `${protocol}://${displayHost}:${serverInstance.port}`
				: withDashboard && !dashboardManifest
					? "unavailable (assets not found)"
					: "disabled";
		console.log(`
🎯 ClankerMux Server v${version}
🌐 Port: ${serverInstance.port}
🌍 Host: ${hostname}
${tlsEnabled ? "🔒 TLS: enabled" : ""}
📊 Dashboard: ${dashboardStatus}
🔗 API Base: ${protocol}://${displayHost}:${serverInstance.port}/api

Agent base URLs (the mount names the wire dialect the client speaks, not the account pool):
- Anthropic Messages: ${protocol}://${displayHost}:${serverInstance.port}${WIRE_MOUNTS.anthropic}
- OpenAI Responses:   ${protocol}://${displayHost}:${serverInstance.port}${WIRE_MOUNTS.openai}

Available endpoints:
- GET    ${protocol}://localhost:${serverInstance.port}/api/accounts    → List accounts
- POST   ${protocol}://localhost:${serverInstance.port}/api/accounts    → Add account
- DELETE ${protocol}://localhost:${serverInstance.port}/api/accounts/:id → Remove account
- GET    ${protocol}://localhost:${serverInstance.port}/api/stats       → View statistics
- POST   ${protocol}://localhost:${serverInstance.port}/api/stats/reset → Reset statistics
- GET    ${protocol}://localhost:${serverInstance.port}/api/config      → View configuration
- PATCH  ${protocol}://localhost:${serverInstance.port}/api/config      → Update configuration

⚡ Ready to proxy requests...
`);
	});

	// Log configuration
	console.log(
		`⚙️  Current strategy: ${config.getStrategy()} (default: ${DEFAULT_STRATEGY})`,
	);

	// Log initial account status
	const accounts = await dbOps.getAllAccounts();
	const activeAccounts = accounts.filter(
		(a) => !a.paused && (!a.expires_at || a.expires_at > Date.now()),
	);
	log.info(
		`Loaded ${accounts.length} accounts (${activeAccounts.length} active)`,
	);
	if (activeAccounts.length === 0) {
		log.warn(
			"No active accounts available - requests will be forwarded without authentication",
		);
	}

	// Start usage polling for Anthropic accounts with token refresh (regardless of paused status)
	const anthropicAccounts = accounts.filter((a) => a.provider === "anthropic");
	if (anthropicAccounts.length > 0) {
		log.info(
			`Found ${anthropicAccounts.length} Anthropic accounts, starting usage polling...`,
		);
		for (const [index, account] of anthropicAccounts.entries()) {
			log.debug(`Processing account: ${account.name}`, {
				accountId: account.id,
				hasAccessToken: !!account.access_token,
				hasRefreshToken: !!account.refresh_token,
				paused: account.paused,
				expiresAt: account.expires_at
					? new Date(account.expires_at).toISOString()
					: null,
			});

			if (account.access_token || account.refresh_token) {
				// Start usage polling with token refresh capability
				// Usage data fetching should work independently of account paused status
				// Stagger the FIRST FETCH by 5s per account to avoid simultaneous
				// 429s on boot; registration itself is immediate so refreshNow works
				// during the stagger window.
				const startupDelayMs = index * 5000;
				startUsagePollingWithRefresh(
					account,
					proxyContext,
					startupDelayMs,
					config.getUsagePollIntervalMs(),
				);
				log.info(
					`Started usage polling for account ${account.name}${startupDelayMs > 0 ? ` (first fetch delayed ${startupDelayMs / 1000}s)` : ""}`,
				);
			} else {
				log.warn(
					`Account ${account.name} has no access token or refresh token, skipping usage polling`,
				);
			}
		}
	} else {
		log.info(`No Anthropic accounts found, usage polling will not start`);
	}

	// Start usage polling for Zai accounts
	const zaiAccounts = accounts.filter((a) => a.provider === "zai");
	if (zaiAccounts.length > 0) {
		log.info(
			`Found ${zaiAccounts.length} Zai accounts, starting usage polling...`,
		);
		for (const account of zaiAccounts) {
			log.debug(`Processing Zai account: ${account.name}`, {
				accountId: account.id,
				hasApiKey: !!account.api_key,
				paused: account.paused,
			});

			if (account.api_key) {
				// Zai uses API key authentication, no token refresh needed
				// Create a simple token provider that returns the API key
				const apiKeyProvider = async () => account.api_key || "";

				// Start usage polling with the API key
				usageCache.startPolling(
					account.id,
					apiKeyProvider,
					account.provider,
					config.getUsagePollIntervalMs(),
					undefined, // customEndpoint
					(accountId) => {
						dbOps
							.resetAccountSession(accountId, Date.now())
							.catch((err) =>
								log.warn(
									`Failed to reset session for Zai account ${accountId} on window reset: ${err}`,
								),
							);
					},
				);
				log.info(`Started usage polling for Zai account ${account.name}`);
			} else {
				log.warn(
					`Zai account ${account.name} has no API key, skipping usage polling`,
				);
			}
		}
	} else {
		log.info(`No Zai accounts found, usage polling will not start`);
	}

	// Start usage polling for Kilo Gateway accounts
	const kiloAccounts = accounts.filter((a) => a.provider === "kilo");
	if (kiloAccounts.length > 0) {
		log.info(
			`Found ${kiloAccounts.length} Kilo Gateway accounts, starting usage polling...`,
		);
		for (const account of kiloAccounts) {
			if (account.api_key) {
				const apiKeyProvider = async () => account.api_key || "";
				usageCache.startPolling(
					account.id,
					apiKeyProvider,
					account.provider,
					config.getUsagePollIntervalMs(),
				);
				log.info(
					`Started usage polling for Kilo Gateway account ${account.name}`,
				);
			} else {
				log.warn(
					`Kilo Gateway account ${account.name} has no API key, skipping usage polling`,
				);
			}
		}
	} else {
		log.info(`No Kilo Gateway accounts found, usage polling will not start`);
	}

	// Start the usage-snapshot sampler: a periodic job that records per-account
	// rate-limit utilization into the usage_snapshots time-series (the Limits
	// "sawtooth" graph). It is a pure read-through observer of the warm usage
	// cache (kept warm by real traffic, the Anthropic pollers above, and the
	// auto_refresh_enabled-gated auto-refresh priming — never by the sampler
	// itself, so it spends no quota) and defers its first sample until after the
	// startup poll-stagger wave.
	usageSnapshotSampler = new UsageSnapshotSampler({
		getAccounts: () => dbOps.getAllAccounts(),
		insertSnapshots: (rows) => dbOps.insertUsageSnapshots(rows),
		// Per-model-family weekly windows, recorded from the same tick. Capture
		// only for now: nothing reads this series yet, but it cannot be
		// reconstructed after the fact.
		insertScopedSnapshots: (rows) => dbOps.insertScopedUsageSnapshots(rows),
		// Persisted history for the weekly burn-slope fit that sizes the
		// pool-liveness reserve's release horizon.
		getRecentSnapshots: (accountIds, sinceMs) =>
			dbOps.getRecentUsageSnapshotsForAccounts(accountIds, sinceMs),
		cache: usageCache,
		// freshness = max(2 * pollInterval, 150s): two missed polls before a gap.
		getFreshnessMs: () =>
			Math.max(2 * config.getUsagePollIntervalMs(), 150_000),
		getPollIntervalMs: () => config.getUsagePollIntervalMs(),
	});
	usageSnapshotSampler.start().catch((err) => {
		log.error(`Failed to start usage snapshot sampler: ${err}`);
	});

	// Seed the in-memory bridge counters from the last persisted snapshot so the
	// live ledger (and the dashboard's cumulative figures) continues across restarts
	// instead of resetting to zero. Gauges are NOT seeded — they re-warm from the
	// live store. Best-effort: any failure just leaves the counters at zero.
	try {
		const prior = await dbOps.getLatestCacheKeepaliveSnapshot();
		if (prior) {
			bridgeStats.seed({
				keepalivesSent: prior.keepalivesSent,
				hits: prior.hits,
				misses: prior.misses,
				failures: prior.failures,
				warmResumes: prior.warmResumes,
				spentUsd: prior.spentUsd,
				savedUsd: prior.savedUsd,
				savedUsdConservative: prior.savedUsd5m,
			});
			log.info(
				`Seeded bridge stats from last snapshot: hits=${prior.hits} resumes=${prior.warmResumes} spentUsd=${prior.spentUsd.toFixed(4)} savedUsd5m=${prior.savedUsd5m.toFixed(4)}`,
			);
		}
	} catch (err) {
		log.warn(`Could not seed bridge stats from DB (starting at zero): ${err}`);
	}

	// Start the cache-keepalive snapshot sampler: records the Session Cache
	// Bridge's live gauges + cumulative economics into the
	// cache_keepalive_snapshots time-series (the dashboard keepalive analytics
	// panel). Same 2-minute cadence and deferred first tick as the usage sampler.
	cacheKeepaliveSnapshotSampler = new CacheKeepaliveSnapshotSampler({
		getGauges: liveGauges,
		getStats: liveStats,
		insertSnapshot: (row) => dbOps.insertCacheKeepaliveSnapshot(row),
		getPollIntervalMs: () => config.getUsagePollIntervalMs(),
	});
	cacheKeepaliveSnapshotSampler.start();

	// Start the quota-drift scheduler: recomputes the implied per-model cost of
	// each usage window (the Analytics "Quota" tab) every 30 minutes. The fit
	// runs on its own read-only worker; only the resulting row is written here,
	// because that worker's connection is query_only. Purely a read-side
	// projection — it never touches routing, cooldowns or account selection.
	quotaDriftScheduler = new QuotaDriftScheduler({
		getDbPath: () => dbOps.getResolvedDbPath(),
		storeResult: (row) => dbOps.insertQuotaDriftResult(row),
	});
	quotaDriftScheduler.start();

	// Start the subscription-payment auto-recorder: books each subscription
	// account's renewal due dates into the account_payments ledger (immediate
	// catch-up tick for due dates missed while down, then hourly).
	subscriptionPaymentRecorder = new SubscriptionPaymentRecorder({
		getRenewalConfigs: () => dbOps.getAccountRenewalConfigs(),
		recordPayment: (accountId, accountName, dueDate, amountUsdMicros, now) =>
			dbOps.recordAutoPayment(
				accountId,
				accountName,
				dueDate,
				amountUsdMicros,
				now,
			),
	});
	subscriptionPaymentRecorder.start();

	// Start the Codex reset-credit auto-applier: redeems expiring usage reset
	// credits for Codex accounts with the auto-apply toggle enabled (immediate
	// catch-up tick for credits that neared expiry while down, then every
	// minute). Metadata refreshes route through the shared CodexSpendCoordinator
	// so this stays behind the single Codex spend authority.
	codexResetCreditApplyScheduler = createCodexResetCreditApplyScheduler({
		dbOps,
		coordinator: codexSpendCoordinator,
	});
	codexResetCreditApplyScheduler.start();

	// One-time, staggered, fail-open profile backfill: fetch GET /api/oauth/profile
	// for Anthropic OAuth accounts that have never had a successful profile fetch
	// (identity_profile_fetched_at IS NULL) and merge the identity into their
	// columns. Fire-and-forget AFTER the server is already listening — the routine
	// self-guards (never throws) and sleeps an initial delay + staggers between
	// accounts, so it neither blocks startup nor bursts the shared profile/usage
	// rate-limit bucket. Gated on identity_profile_fetched_at, so it's idempotent
	// across restarts (successes never re-fetch; failures retry next boot).
	void runAnthropicProfileBackfill({
		getAccounts: () => dbOps.getAllAccounts(),
		fetchProfile: fetchAnthropicProfile,
		setIdentity: (accountId, identity) =>
			dbOps.setAccountIdentityFromProfile(accountId, identity),
	});

	// Codex identity backfill: a Codex account whose token hasn't refreshed since
	// the identity feature shipped shows no identity in the dashboard (Codex
	// identity is captured on token refresh via JWT decode, with no profile
	// endpoint). This decodes the stored access token LOCALLY (no network) and
	// merges any resolved fields. Fire-and-forget; it self-guards (never throws)
	// and is idempotent across restarts (an account with both external id AND
	// email is never re-selected).
	void runCodexIdentityBackfill({
		getAccounts: () => dbOps.getAllAccounts(),
		extractIdentity: (accessToken) => extractCodexIdentity(accessToken, null),
		setIdentity: (accountId, identity) =>
			dbOps.setAccountIdentity(accountId, identity),
	});

	const serverPort = serverInstance.port;
	if (typeof serverPort !== "number") {
		throw new Error("Server instance has no valid port");
	}

	return {
		port: serverPort,
		stop: () => {
			if (serverInstance) {
				serverInstance.stop();
				serverInstance = null;
			}
		},
	};
}

// Max wall-clock time between SIGTERM and process exit. The Caddy front proxy
// (deploy/caddy/) holds NEW connections during the drain (re-dialing until the
// app is back), so a long drain doesn't extend the client-visible outage — it
// only lets long agentic streams on the draining process run to completion.
// 300s (up from 85s) covers most real agentic turns; streams that outlive the
// watchdog are still severed when it fires.
//
// This is the HARD cap, not the usual exit path: a drain that has gone idle
// ends earlier via the `waitForDrainIdle` backstop below. Reaching 300s means
// either requests really are still running, or something later in shutdown is
// stuck (a hung force-close, a disposal that never settles, a stalled loop).
//
// COUPLED CONFIG — keep in sync:
//  - systemd TimeoutStopSec=330 (deploy/systemd/.../stop-timeout.conf) must
//    exceed this value, else systemd SIGKILLs mid-drain (default is only 90s).
//  - Caddy lb_try_duration 330s (deploy/caddy/Caddyfile) must cover the
//    worst-case drain + boot so held requests don't 502 before the app is back.
const SHUTDOWN_WATCHDOG_MS = 300_000;

// Deduplicates concurrent shutdown invocations (e.g. SIGINT arriving while
// SIGTERM is still awaiting serverInstance.stop()). Without this, the second
// invocation races on the same Bun server, worker, and DB writer.
let isShuttingDown = false;

// Graceful shutdown handler
async function handleGracefulShutdown(signal: string) {
	if (isShuttingDown) {
		console.log(`Ignoring ${signal} — shutdown already in progress`);
		return;
	}
	isShuttingDown = true;

	console.log(`\n👋 Received ${signal}, shutting down gracefully...`);

	// Hard upper bound on shutdown duration. unref'd so it doesn't itself
	// prevent a clean exit if everything else finishes first. Exits with 0
	// because the watchdog only fires on an expected SIGTERM that ran long,
	// not on a failure — a non-zero code here would leave the unit in `failed`
	// state after an ordinary `systemctl restart` and bury real crashes in the
	// noise. (It would NOT change whether systemd restarts us: the live unit is
	// Restart=always, and a requested stop suppresses Restart= regardless.)
	const watchdog = setTimeout(() => {
		console.error(
			`⚠️ Shutdown watchdog (${SHUTDOWN_WATCHDOG_MS}ms) expired, forcing exit`,
		);
		process.exit(0);
	}, SHUTDOWN_WATCHDOG_MS);
	watchdog.unref();

	try {
		// Stop scheduler triggers first so they don't add load while draining.
		// These calls only stop the recurring trigger; any in-flight task they
		// already kicked off continues until it finishes naturally.
		if (stopRetentionJob) {
			stopRetentionJob();
			stopRetentionJob = null;
		}
		if (stopOAuthCleanupJob) {
			stopOAuthCleanupJob();
			stopOAuthCleanupJob = null;
		}
		if (stopManagementSessionSweepJob) {
			stopManagementSessionSweepJob();
			stopManagementSessionSweepJob = null;
		}
		if (stopRateLimitCleanupJob) {
			stopRateLimitCleanupJob();
			stopRateLimitCleanupJob = null;
		}
		if (stopDataCleanupJob) {
			stopDataCleanupJob();
			stopDataCleanupJob = null;
		}
		if (stopWalCheckpointJob) {
			stopWalCheckpointJob();
			stopWalCheckpointJob = null;
		}
		if (stopIntegritySchedulerJob) {
			stopIntegritySchedulerJob();
			stopIntegritySchedulerJob = null;
		}
		if (autoRefreshScheduler) {
			autoRefreshScheduler.stop();
			autoRefreshScheduler = null;
		}
		if (codexUsagePoller) {
			codexUsagePoller.stop();
			codexUsagePoller = null;
		}
		if (cacheKeepaliveScheduler) {
			cacheKeepaliveScheduler.stop();
			cacheKeepaliveScheduler = null;
		}
		if (usageSnapshotSampler) {
			usageSnapshotSampler.stop();
			usageSnapshotSampler = null;
		}
		if (cacheKeepaliveSnapshotSampler) {
			cacheKeepaliveSnapshotSampler.stop();
			cacheKeepaliveSnapshotSampler = null;
		}
		if (subscriptionPaymentRecorder) {
			subscriptionPaymentRecorder.stop();
			subscriptionPaymentRecorder = null;
		}
		if (codexResetCreditApplyScheduler) {
			codexResetCreditApplyScheduler.stop();
			codexResetCreditApplyScheduler = null;
		}
		if (quotaDriftScheduler) {
			quotaDriftScheduler.stop();
			quotaDriftScheduler = null;
		}

		// Stop memory monitoring
		if (memoryMonitorInterval) {
			clearInterval(memoryMonitorInterval);
			memoryMonitorInterval = null;
		}

		// Stop the event-loop lag watchdog
		stopEventLoopMonitor();

		// Stop token health monitoring
		stopGlobalTokenHealthChecks();

		// Unregister this server's Codex on-demand usage refresher so the
		// module-level registry doesn't keep a stale callback after restart.
		// Mirrors the cleanup pattern used by the schedulers above.
		if (registeredServerId) {
			unregisterCodexResetCreditConsumer(registeredServerId);
			unregisterCodexResetCreditsRefresher(registeredServerId);
			unregisterCodexUsageRefresher(registeredServerId);
			registeredServerId = null;
		}

		// Clear all pending usage polling retry timeouts
		if (usagePollingRetryTimeouts.size > 0) {
			console.log(
				`Clearing ${usagePollingRetryTimeouts.size} pending usage polling retry timeout(s)...`,
			);
			for (const [
				_accountId,
				timeoutId,
			] of usagePollingRetryTimeouts.entries()) {
				clearTimeout(timeoutId);
			}
			usagePollingRetryTimeouts.clear();
		}

		usageCache.clear(); // Stop all usage polling

		// Endless dashboard SSE streams (requests/logs heartbeats) would hold
		// the drain below until the watchdog; close them proactively —
		// EventSource auto-reconnects through the front proxy once we're back.
		const closedSseStreams = closeAllSseStreams();
		if (closedSseStreams > 0) {
			console.log(
				`Closed ${closedSseStreams} dashboard SSE stream(s) before drain`,
			);
		}

		// Stop accepting new connections and wait for in-flight HTTP requests
		// (including streaming responses) to complete. stop() without args is
		// Bun's graceful variant; stop(true) would force-close active conns.
		//
		// stop() is RACED against an idle watcher rather than awaited alone: it
		// has been observed not resolving long after the last real request
		// finished (see drain-idle.ts). On a normal drain stop() wins and
		// nothing changes; the watcher only wins when the drain is stuck with
		// no work left, and then we force-close whatever is holding it.
		if (serverInstance) {
			console.log("Draining in-flight HTTP requests...");
			const server = serverInstance;
			// `stop()` can reject OR throw synchronously. Either way the drain
			// is over as far as this branch is concerned, but a REJECTED stop is
			// not evidence the server actually stopped, so it force-closes too.
			const stopped = (async () => {
				try {
					await server.stop();
					return "stopped" as const;
				} catch (err) {
					console.warn("⚠️ serverInstance.stop() threw:", err);
					return "stop-failed" as const;
				}
			})();
			const idleWatcher = waitForDrainIdle({
				getPendingCount: () =>
					server.pendingRequests + server.pendingWebSockets,
			});
			const outcome = await Promise.race([
				stopped,
				idleWatcher.promise.then(() => "idle" as const),
			]);
			idleWatcher.cancel();
			if (outcome !== "stopped") {
				// The pending counts go into the log on purpose: if the idle
				// branch keeps winning, they are the evidence for why a graceful
				// stop() outlives the work it is supposed to be draining.
				console.warn(
					`⚠️ HTTP drain ended as "${outcome}" (pendingRequests=${server.pendingRequests}, pendingWebSockets=${server.pendingWebSockets}); force-closing remaining connections`,
				);
				try {
					// Awaited: the disposal below must not race connections that
					// are still being torn down. The shutdown watchdog bounds a
					// force-close that hangs in turn.
					await server.stop(true);
				} catch (err) {
					console.warn("⚠️ serverInstance.stop(true) threw:", err);
				}
			}
			serverInstance = null;
			console.log("HTTP drain complete");
		}

		// Stop dashboard analytics first; HTTP drain above guarantees no new
		// analytics calls are being accepted.
		terminateAnalyticsWorker();

		// Usage is now finalized inline (no worker). The HTTP drain above means
		// no new streams will start, but in-flight finalizers (the async cost
		// lookup that runs after transport finish) may still be settling. Await
		// them — bounded — so their attachUsageSummary/onSummary land BEFORE we
		// dispose the RequestRecorder + AsyncDbWriter below (R6).
		await drainPendingUsageFinalizers();

		// Flush AsyncDbWriter and other Disposables (recorder.dispose runs here).
		await shutdown();

		console.log("✅ Shutdown complete");
		process.exit(0);
	} catch (error) {
		console.error("❌ Error during shutdown:", error);
		process.exit(1);
	}
}

// Register signal handlers
process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));

// Export helper to get the current protocol
export function getProtocol(): string {
	return tlsEnabled ? "https" : "http";
}

// Run server if this is the main entry point
if (import.meta.main) {
	// Parse command line arguments
	const args = process.argv.slice(2);
	let port: number | undefined;
	let sslKeyPath: string | undefined;
	let sslCertPath: string | undefined;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" && args[i + 1]) {
			port = Number.parseInt(args[i + 1], 10);
			i++; // Skip next arg
		} else if (args[i] === "--ssl-key" && args[i + 1]) {
			sslKeyPath = args[i + 1];
			i++; // Skip next arg
		} else if (args[i] === "--ssl-cert" && args[i + 1]) {
			sslCertPath = args[i + 1];
			i++; // Skip next arg
		}
	}

	// Use environment variables if no command line arguments
	if (!port && process.env.PORT) {
		port = Number.parseInt(process.env.PORT, 10);
	}
	if (!sslKeyPath && process.env.SSL_KEY_PATH) {
		sslKeyPath = process.env.SSL_KEY_PATH;
	}
	if (!sslCertPath && process.env.SSL_CERT_PATH) {
		sslCertPath = process.env.SSL_CERT_PATH;
	}

	// Set env vars if CLI flags were used (ensures consistency across modules)
	if (sslKeyPath) {
		process.env.SSL_KEY_PATH = sslKeyPath;
	}
	if (sslCertPath) {
		process.env.SSL_CERT_PATH = sslCertPath;
	}

	// Start the server asynchronously. This is the only boundary allowed to end
	// the process: startServer() is also an exported programmatic entrypoint, so
	// everything below it reports failure by throwing, never by exiting.
	// Previously this was a bare `void` call, which surfaced a startup failure
	// as an unhandled rejection with no exit code we could give meaning to.
	startServer({ port, sslKeyPath, sslCertPath }).catch((error: unknown) => {
		if (error instanceof BunRuntimeFloorError) {
			// A configuration error a restart cannot fix. The distinct status
			// lets systemd stop retrying — see
			// deploy/systemd/clankermux.service.d/runtime-floor.conf.
			console.error(error.message);
			process.exit(error.exitCode);
		}
		console.error("❌ Server failed to start:", error);
		process.exit(1);
	});
}
