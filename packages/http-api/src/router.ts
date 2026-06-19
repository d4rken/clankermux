import { validateNumber } from "@clankermux/core";
import {
	createAccountAddHandler,
	createAccountAutoFallbackHandler,
	createAccountAutoPauseOnOverageHandler,
	createAccountAutoRefreshHandler,
	createAccountBillingTypeHandler,
	createAccountCustomEndpointUpdateHandler,
	createAccountForceClearHandler,
	createAccountForceGetHandler,
	createAccountForceHandler,
	createAccountForceResetRateLimitHandler,
	createAccountModelFallbacksUpdateHandler,
	createAccountModelMappingsUpdateHandler,
	createAccountNotesUpdateHandler,
	createAccountPauseHandler,
	createAccountPeakHoursPauseHandler,
	createAccountPriorityUpdateHandler,
	createAccountRefreshUsageHandler,
	createAccountReloadHandler,
	createAccountRemoveHandler,
	createAccountRenameHandler,
	createAccountRenewalUpdateHandler,
	createAccountResetStickinessHandler,
	createAccountResumeHandler,
	createAccountsListHandler,
	createAlibabaCodingPlanAccountAddHandler,
	createAnthropicCompatibleAccountAddHandler,
	createKiloAccountAddHandler,
	createMinimaxAccountAddHandler,
	createOllamaAccountAddHandler,
	createOllamaCloudAccountAddHandler,
	createOpenAIAccountAddHandler,
	createOpenRouterAccountAddHandler,
	createZaiAccountAddHandler,
} from "./handlers/accounts";
import { createAnalyticsHandler } from "./handlers/analytics";
import {
	createApiKeyDeleteHandler,
	createApiKeyDisableHandler,
	createApiKeyEnableHandler,
	createApiKeyPinHandler,
	createApiKeyRegenerateHandler,
	createApiKeyRenameHandler,
	createApiKeysGenerateHandler,
	createApiKeysListHandler,
	createApiKeysStatsHandler,
} from "./handlers/api-keys";
import { createCacheEffectivenessHandler } from "./handlers/cache-effectiveness";
import { createCacheKeepaliveHandler } from "./handlers/cache-keepalive";
import { createCacheKeepaliveHistoryHandler } from "./handlers/cache-keepalive-history";
import {
	createComboCreateHandler,
	createComboDeleteHandler,
	createComboGetHandler,
	createCombosListHandler,
	createComboUpdateHandler,
	createFamiliesListHandler,
	createFamilyAssignHandler,
	createSlotAddHandler,
	createSlotRemoveHandler,
	createSlotReorderHandler,
	createSlotUpdateHandler,
} from "./handlers/combos";
import { createConfigHandlers } from "./handlers/config";
import {
	createHeapSnapshotHandler,
	createHeapStatsHandler,
	createRssHandler,
} from "./handlers/debug";
import { createHealthHandler } from "./handlers/health";
import { createLogsStreamHandler } from "./handlers/logs";
import { createLogsHistoryHandler } from "./handlers/logs-history";
import { createCleanupHandler } from "./handlers/maintenance";
import { createMemoryHistoryHandler } from "./handlers/memory-history";
import {
	createAnthropicReauthCallbackHandler,
	createAnthropicReauthInitHandler,
	createCodexDeviceFlowInitHandler,
	createCodexDeviceFlowStatusHandler,
	createCodexReauthHandler,
	createOAuthCallbackHandler,
	createOAuthInitHandler,
	createQwenDeviceFlowInitHandler,
	createQwenDeviceFlowStatusHandler,
	createQwenReauthHandler,
} from "./handlers/oauth";
import {
	createPaymentCreateHandler,
	createPaymentDeleteHandler,
	createPaymentsSeedHandler,
	createPaymentsSummaryHandler,
} from "./handlers/payments";
import { parseRequestFilters } from "./handlers/request-filters";
import {
	createRequestPayloadHandler,
	createRequestProjectsHandler,
	createRequestsCountHandler,
	createRequestsDetailHandler,
	createRequestsSummaryHandler,
} from "./handlers/requests";
import { createRequestsStreamHandler } from "./handlers/requests-stream";
import { createStatsHandler, createStatsResetHandler } from "./handlers/stats";
import {
	createIntegrityCheckHandler,
	createStorageHandler,
	createStorageUsageHandler,
} from "./handlers/storage";
import {
	createSystemInfoHandler,
	createSystemStatusHandler,
} from "./handlers/system";
import {
	createAccountTokenHealthHandler,
	createReauthNeededHandler,
	createTokenHealthHandler,
} from "./handlers/token-health";
import { createUsageHistoryHandler } from "./handlers/usage-history";
import { createVersionCheckHandler } from "./handlers/version";
import type { APIContext } from "./types";
import { errorResponse } from "./utils/http-error";

/**
 * API Router that handles all API endpoints
 */
export class APIRouter {
	private context: APIContext;
	private handlers: Map<
		string,
		(req: Request, url: URL) => Response | Promise<Response>
	>;
	private qwenStatusHandler: (sessionId: string) => Response;
	private codexStatusHandler: (sessionId: string) => Response;

	constructor(context: APIContext) {
		this.context = context;
		this.handlers = new Map();
		this.qwenStatusHandler = createQwenDeviceFlowStatusHandler();
		this.codexStatusHandler = createCodexDeviceFlowStatusHandler();
		this.registerHandlers();
	}

	private registerHandlers(): void {
		const {
			config,
			dbOps,
			getAsyncWriterHealth,
			getIntegrityStatus,
			getStrategy,
			getEventLoopLag,
		} = this.context;

		// Create handlers
		const healthHandler = createHealthHandler(
			dbOps,
			config,
			getAsyncWriterHealth,
			getIntegrityStatus,
		);
		const statsHandler = createStatsHandler(this.context);
		const statsResetHandler = createStatsResetHandler(dbOps);
		const storageHandler = createStorageHandler(dbOps);
		const storageUsageHandler = createStorageUsageHandler(dbOps);
		const integrityCheckHandler = createIntegrityCheckHandler(dbOps);
		const accountsHandler = createAccountsListHandler(
			dbOps,
			config,
			getStrategy,
		);
		const accountAddHandler = createAccountAddHandler(dbOps, config);
		const zaiAccountAddHandler = createZaiAccountAddHandler(dbOps);
		const minimaxAccountAddHandler = createMinimaxAccountAddHandler(dbOps);
		const alibabaCodingPlanAccountAddHandler =
			createAlibabaCodingPlanAccountAddHandler(dbOps);
		const kiloAccountAddHandler = createKiloAccountAddHandler(dbOps);
		const openrouterAccountAddHandler =
			createOpenRouterAccountAddHandler(dbOps);
		const anthropicCompatibleAccountAddHandler =
			createAnthropicCompatibleAccountAddHandler(dbOps);
		const ollamaAccountAddHandler = createOllamaAccountAddHandler(dbOps);
		const openaiAccountAddHandler = createOpenAIAccountAddHandler(dbOps);
		const _accountRemoveHandler = createAccountRemoveHandler(dbOps);
		const requestsSummaryHandler = createRequestsSummaryHandler(
			dbOps.getAdapter(),
		);
		const requestsCountHandler = createRequestsCountHandler(dbOps.getAdapter());
		const requestProjectsHandler = createRequestProjectsHandler(
			dbOps.getAdapter(),
		);
		const requestsDetailHandler = createRequestsDetailHandler(dbOps);
		const configHandlers = createConfigHandlers(config, this.context.runtime);
		const logsStreamHandler = createLogsStreamHandler();
		const logsHistoryHandler = createLogsHistoryHandler();
		const analyticsHandler = createAnalyticsHandler(this.context);
		const usageHistoryHandler = createUsageHistoryHandler(this.context);
		const memoryHistoryHandler = createMemoryHistoryHandler(this.context);
		const cacheKeepaliveHandler = createCacheKeepaliveHandler(this.context);
		const cacheKeepaliveHistoryHandler = createCacheKeepaliveHistoryHandler(
			this.context,
		);
		const cacheEffectivenessHandler = createCacheEffectivenessHandler(
			this.context,
		);
		const oauthInitHandler = createOAuthInitHandler(dbOps);
		const oauthCallbackHandler = createOAuthCallbackHandler(dbOps);
		const qwenDeviceFlowInitHandler = createQwenDeviceFlowInitHandler(dbOps);
		const qwenReauthHandler = createQwenReauthHandler(dbOps);
		const codexDeviceFlowInitHandler = createCodexDeviceFlowInitHandler(dbOps);
		const codexReauthHandler = createCodexReauthHandler(dbOps);
		const anthropicReauthInitHandler = createAnthropicReauthInitHandler(
			dbOps,
			config,
		);
		const anthropicReauthCallbackHandler = createAnthropicReauthCallbackHandler(
			dbOps,
			config,
		);
		const requestsStreamHandler = createRequestsStreamHandler();
		const cleanupHandler = createCleanupHandler(dbOps, config);
		const systemInfoHandler = createSystemInfoHandler();
		const systemStatusHandler = createSystemStatusHandler(
			dbOps,
			config,
			getAsyncWriterHealth,
			getIntegrityStatus,
			getEventLoopLag,
		);
		const versionCheckHandler = createVersionCheckHandler();

		// Debug/profiling handlers
		const heapStatsHandler = createHeapStatsHandler();
		const heapSnapshotHandler = createHeapSnapshotHandler();
		const rssHandler = createRssHandler();

		// API Key handlers
		const apiKeysListHandler = createApiKeysListHandler(dbOps);
		const apiKeysGenerateHandler = createApiKeysGenerateHandler(dbOps);
		const apiKeysStatsHandler = createApiKeysStatsHandler(dbOps);

		// Register routes
		this.handlers.set("GET:/health", (_req, url) => healthHandler(url));
		this.handlers.set("GET:/api/stats", (_req, url) => statsHandler(url));
		this.handlers.set("POST:/api/stats/reset", () => statsResetHandler());
		this.handlers.set("GET:/api/storage", (_req, _url) => storageHandler());
		this.handlers.set("GET:/api/storage/usage", () => storageUsageHandler());
		this.handlers.set("POST:/api/storage/integrity/check", (req) =>
			integrityCheckHandler(req),
		);
		this.handlers.set("GET:/api/accounts", () => accountsHandler());
		this.handlers.set("POST:/api/accounts", (req) => accountAddHandler(req));
		this.handlers.set("POST:/api/accounts/zai", (req) =>
			zaiAccountAddHandler(req),
		);
		this.handlers.set("POST:/api/accounts/minimax", (req) =>
			minimaxAccountAddHandler(req),
		);
		this.handlers.set("POST:/api/accounts/alibaba-coding-plan", (req) =>
			alibabaCodingPlanAccountAddHandler(req),
		);
		this.handlers.set("POST:/api/accounts/kilo", (req) =>
			kiloAccountAddHandler(req),
		);
		this.handlers.set("POST:/api/accounts/openrouter", (req) =>
			openrouterAccountAddHandler(req),
		);
		this.handlers.set("POST:/api/accounts/anthropic-compatible", (req) =>
			anthropicCompatibleAccountAddHandler(req),
		);
		this.handlers.set("POST:/api/accounts/ollama", (req) =>
			ollamaAccountAddHandler(req),
		);
		const ollamaCloudAccountAddHandler =
			createOllamaCloudAccountAddHandler(dbOps);
		this.handlers.set("POST:/api/accounts/ollama-cloud", (req) =>
			ollamaCloudAccountAddHandler(req),
		);
		this.handlers.set("POST:/api/accounts/openai-compatible", (req) =>
			openaiAccountAddHandler(req),
		);

		// Global force-account override (Feature 3). Registered as EXACT-match
		// routes so they take priority over the dynamic /api/accounts/:id/...
		// dispatch below — otherwise "force" would be mistaken for an account id
		// (parts[3]). The per-account POST /api/accounts/:id/force toggle is
		// handled in the dynamic block.
		const accountForceClearHandler = createAccountForceClearHandler();
		const accountForceGetHandler = createAccountForceGetHandler();
		this.handlers.set("POST:/api/accounts/force/clear", () =>
			accountForceClearHandler(),
		);
		this.handlers.set("GET:/api/accounts/force", () =>
			accountForceGetHandler(),
		);

		// Token health handlers
		const tokenHealthHandler = createTokenHealthHandler(dbOps);
		const reauthNeededHandler = createReauthNeededHandler(dbOps);

		this.handlers.set("GET:/api/token-health", tokenHealthHandler);
		this.handlers.set(
			"GET:/api/token-health/reauth-needed",
			reauthNeededHandler,
		);

		this.handlers.set("POST:/api/oauth/init", (req) => oauthInitHandler(req));
		this.handlers.set("POST:/api/oauth/callback", (req) =>
			oauthCallbackHandler(req),
		);
		this.handlers.set("POST:/api/oauth/qwen/init", (req) =>
			qwenDeviceFlowInitHandler(req),
		);
		this.handlers.set("POST:/api/oauth/qwen/reauth", (req) =>
			qwenReauthHandler(req),
		);
		this.handlers.set("POST:/api/oauth/anthropic/reauth/init", (req) =>
			anthropicReauthInitHandler(req),
		);
		this.handlers.set("POST:/api/oauth/anthropic/reauth/callback", (req) =>
			anthropicReauthCallbackHandler(req),
		);
		this.handlers.set("POST:/api/oauth/codex/init", (req) =>
			codexDeviceFlowInitHandler(req),
		);
		this.handlers.set("POST:/api/oauth/codex/reauth", (req) =>
			codexReauthHandler(req),
		);
		this.handlers.set("GET:/api/requests", (_req, url) => {
			const limitParam = url.searchParams.get("limit");
			const limit =
				validateNumber(limitParam || "50", "limit", {
					min: 1,
					max: 1000,
					integer: true,
				}) || 50;
			const offsetParam = url.searchParams.get("offset");
			const offset =
				validateNumber(offsetParam || "0", "offset", {
					min: 0,
					max: 10_000_000,
					integer: true,
				}) ?? 0;
			const filters = parseRequestFilters(url.searchParams);
			return requestsSummaryHandler(limit, offset, filters);
		});
		this.handlers.set("GET:/api/requests/count", (_req, url) => {
			const filters = parseRequestFilters(url.searchParams);
			return requestsCountHandler(filters);
		});
		this.handlers.set("GET:/api/requests/projects", () =>
			requestProjectsHandler(),
		);
		this.handlers.set("GET:/api/requests/detail", (_req, url) => {
			const limitParam = url.searchParams.get("limit");
			const limit =
				validateNumber(limitParam || "100", "limit", {
					min: 1,
					max: 1000,
					integer: true,
				}) || 100;
			return requestsDetailHandler(limit);
		});
		this.handlers.set("GET:/api/requests/stream", (req) =>
			requestsStreamHandler(req),
		);
		this.handlers.set("GET:/api/config", () => configHandlers.getConfig());
		this.handlers.set("GET:/api/config/strategy", () =>
			configHandlers.getStrategy(),
		);
		this.handlers.set("POST:/api/config/strategy", (req) =>
			configHandlers.setStrategy(req),
		);
		this.handlers.set("GET:/api/strategies", () =>
			configHandlers.getStrategies(),
		);
		this.handlers.set("GET:/api/config/retention", () =>
			configHandlers.getRetention(),
		);
		this.handlers.set("POST:/api/config/retention", (req) =>
			configHandlers.setRetention(req),
		);
		this.handlers.set("GET:/api/config/cache-warming", () =>
			configHandlers.getCacheWarming(),
		);
		this.handlers.set("POST:/api/config/cache-warming", (req) =>
			configHandlers.setCacheWarming(req),
		);
		this.handlers.set("GET:/api/config/usage-throttling", () =>
			configHandlers.getUsageThrottling(),
		);
		this.handlers.set("POST:/api/config/usage-throttling", (req) =>
			configHandlers.setUsageThrottling(req),
		);
		this.handlers.set("POST:/api/maintenance/cleanup", () => cleanupHandler());

		// Payments ledger routes (summary reads dispatch through the read-only
		// dashboard worker; DELETE /api/payments/:id is in the dynamic block)
		const paymentsSummaryHandler = createPaymentsSummaryHandler(this.context);
		const paymentCreateHandler = createPaymentCreateHandler(dbOps);
		const paymentsSeedHandler = createPaymentsSeedHandler(dbOps);
		this.handlers.set("GET:/api/payments/summary", (_req, url) =>
			paymentsSummaryHandler(url.searchParams),
		);
		this.handlers.set("POST:/api/payments", (req) => paymentCreateHandler(req));
		this.handlers.set("POST:/api/payments/seed", (req) =>
			paymentsSeedHandler(req),
		);
		this.handlers.set("GET:/api/system/info", () => systemInfoHandler());
		this.handlers.set("GET:/api/system/status", () => systemStatusHandler());
		this.handlers.set("GET:/api/version/check", () => versionCheckHandler());
		this.handlers.set("GET:/api/logs/stream", (req) => logsStreamHandler(req));
		this.handlers.set("GET:/api/logs/history", () => logsHistoryHandler());
		this.handlers.set("GET:/api/analytics", (_req, url) => {
			return analyticsHandler(url.searchParams);
		});
		this.handlers.set("GET:/api/analytics/usage-history", (_req, url) => {
			return usageHistoryHandler(url.searchParams);
		});
		this.handlers.set("GET:/api/analytics/memory-history", (_req, url) => {
			return memoryHistoryHandler(url.searchParams);
		});
		this.handlers.set("GET:/api/analytics/cache-keepalive", () =>
			cacheKeepaliveHandler(),
		);
		this.handlers.set(
			"GET:/api/analytics/cache-keepalive-history",
			(_req, url) => cacheKeepaliveHistoryHandler(url.searchParams),
		);
		this.handlers.set("GET:/api/analytics/cache-effectiveness", (_req, url) =>
			cacheEffectivenessHandler(url.searchParams),
		);
		// Debug/profiling routes
		this.handlers.set("GET:/api/debug/heap", () => heapStatsHandler());
		this.handlers.set("GET:/api/debug/snapshot", () => heapSnapshotHandler());
		this.handlers.set("GET:/api/debug/rss", () => rssHandler());

		// API Key routes
		this.handlers.set("GET:/api/api-keys", () => apiKeysListHandler());
		this.handlers.set("POST:/api/api-keys", (req) =>
			apiKeysGenerateHandler(req),
		);
		this.handlers.set("GET:/api/api-keys/stats", () => apiKeysStatsHandler());

		// Combo routes
		this.handlers.set("GET:/api/combos", () =>
			createCombosListHandler(dbOps)(),
		);
		this.handlers.set("POST:/api/combos", (req) =>
			createComboCreateHandler(dbOps)(req),
		);

		// Family assignment routes
		this.handlers.set("GET:/api/families", () =>
			createFamiliesListHandler(dbOps)(),
		);
	}

	/**
	 * Wrap a handler with error handling
	 */
	private wrapHandler(
		handler: (req: Request, url: URL) => Response | Promise<Response>,
	): (req: Request, url: URL) => Promise<Response> {
		return async (req: Request, url: URL) => {
			try {
				return await handler(req, url);
			} catch (error) {
				return errorResponse(error);
			}
		};
	}

	/**
	 * Handle an incoming request
	 */
	async handleRequest(url: URL, req: Request): Promise<Response | null> {
		const path = url.pathname;
		const method = req.method;
		const key = `${method}:${path}`;

		// Auth is intentionally NOT called here. The router only dispatches
		// /api/* paths, which are all public under the post-#216 policy. The
		// upstream-traffic paths (/v1/*, /messages/*) don't match any handler
		// here and fall through to the server.ts proxy dispatch, which runs
		// authenticateRequest exactly once. Authing here would double-increment
		// usage_count on every proxied request.

		// Check for exact match
		const handler = this.handlers.get(key);
		if (handler) {
			return await this.wrapHandler(handler)(req, url);
		}

		// Check for dynamic request payload endpoint
		if (path.startsWith("/api/requests/payload/") && method === "GET") {
			const parts = path.split("/");
			const requestId = parts[4];
			if (requestId) {
				const payloadHandler = createRequestPayloadHandler(this.context.dbOps);
				return await this.wrapHandler(() => payloadHandler(requestId))(
					req,
					url,
				);
			}
		}

		// Check for dynamic account endpoints
		if (path.startsWith("/api/accounts/")) {
			const parts = path.split("/");
			const accountId = parts[3];

			// Account pause
			if (path.endsWith("/pause") && method === "POST") {
				const pauseHandler = createAccountPauseHandler(this.context.dbOps);
				return await this.wrapHandler((req) => pauseHandler(req, accountId))(
					req,
					url,
				);
			}

			// Account resume
			if (path.endsWith("/resume") && method === "POST") {
				const resumeHandler = createAccountResumeHandler(this.context.dbOps);
				return await this.wrapHandler((req) => resumeHandler(req, accountId))(
					req,
					url,
				);
			}

			// Account reload
			if (path.endsWith("/reload") && method === "POST") {
				const reloadHandler = createAccountReloadHandler(this.context.dbOps);
				return await this.wrapHandler((req) => reloadHandler(req, accountId))(
					req,
					url,
				);
			}

			// Per-account force toggle: POST /api/accounts/:id/force.
			// Guard against accountId === "force" so this never collides with the
			// exact-match force routes (/api/accounts/force[...]) registered above
			// — those are GET /api/accounts/force and POST /api/accounts/force/clear.
			if (
				path.endsWith("/force") &&
				method === "POST" &&
				accountId !== "force"
			) {
				const forceHandler = createAccountForceHandler(this.context.dbOps);
				return await this.wrapHandler((req) => forceHandler(req, accountId))(
					req,
					url,
				);
			}

			// Account reset session stickiness
			if (path.endsWith("/reset-stickiness") && method === "POST") {
				const resetStickinessHandler = createAccountResetStickinessHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					resetStickinessHandler(req, accountId),
				)(req, url);
			}

			// Account refresh usage - force restart usage polling and token refresh
			if (path.endsWith("/refresh-usage") && method === "POST") {
				const refreshUsageHandler = createAccountRefreshUsageHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					refreshUsageHandler(req, accountId),
				)(req, url);
			}

			// Account force-reset rate limit
			if (path.endsWith("/force-reset-rate-limit") && method === "POST") {
				const forceResetRateLimitHandler =
					createAccountForceResetRateLimitHandler(this.context.dbOps);
				return await this.wrapHandler((req) =>
					forceResetRateLimitHandler(req, accountId),
				)(req, url);
			}

			// Account rename
			if (path.endsWith("/rename") && method === "POST") {
				const renameHandler = createAccountRenameHandler(this.context.dbOps);
				return await this.wrapHandler((req) => renameHandler(req, accountId))(
					req,
					url,
				);
			}

			// Account priority update
			if (path.endsWith("/priority") && method === "POST") {
				const priorityHandler = createAccountPriorityUpdateHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) => priorityHandler(req, accountId))(
					req,
					url,
				);
			}
			// Account notes update
			if (path.endsWith("/notes") && method === "POST") {
				const notesHandler = createAccountNotesUpdateHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) => notesHandler(req, accountId))(
					req,
					url,
				);
			}
			// Account auto-fallback toggle
			if (path.endsWith("/auto-fallback") && method === "POST") {
				const autoFallbackHandler = createAccountAutoFallbackHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					autoFallbackHandler(req, accountId),
				)(req, url);
			}

			// Account auto-pause-on-overage toggle
			if (path.endsWith("/auto-pause-on-overage") && method === "POST") {
				const autoPauseOnOverageHandler =
					createAccountAutoPauseOnOverageHandler(this.context.dbOps);
				return await this.wrapHandler((req) =>
					autoPauseOnOverageHandler(req, accountId),
				)(req, url);
			}

			// Account peak-hours-pause toggle (Zai accounts only)
			if (path.endsWith("/peak-hours-pause") && method === "POST") {
				const peakHoursPauseHandler = createAccountPeakHoursPauseHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					peakHoursPauseHandler(req, accountId),
				)(req, url);
			}

			// Account billing type
			if (path.endsWith("/billing-type") && method === "POST") {
				const billingTypeHandler = createAccountBillingTypeHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					billingTypeHandler(req, accountId),
				)(req, url);
			}

			// Account renewal date
			if (path.endsWith("/renewal") && method === "POST") {
				const renewalHandler = createAccountRenewalUpdateHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) => renewalHandler(req, accountId))(
					req,
					url,
				);
			}

			// Account auto-refresh toggle
			if (path.endsWith("/auto-refresh") && method === "POST") {
				const autoRefreshHandler = createAccountAutoRefreshHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					autoRefreshHandler(req, accountId),
				)(req, url);
			}

			// Account custom endpoint update
			if (path.endsWith("/custom-endpoint") && method === "POST") {
				const customEndpointHandler = createAccountCustomEndpointUpdateHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					customEndpointHandler(req, accountId),
				)(req, url);
			}

			// Account model mappings update
			if (path.endsWith("/model-mappings") && method === "POST") {
				const modelMappingsHandler = createAccountModelMappingsUpdateHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					modelMappingsHandler(req, accountId),
				)(req, url);
			}

			// Account model fallbacks update
			if (path.endsWith("/model-fallbacks") && method === "POST") {
				const modelFallbacksHandler = createAccountModelFallbacksUpdateHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					modelFallbacksHandler(req, accountId),
				)(req, url);
			}

			// Account removal
			if (parts.length === 4 && method === "DELETE") {
				const removeHandler = createAccountRemoveHandler(this.context.dbOps);
				return await this.wrapHandler((req) => removeHandler(req, accountId))(
					req,
					url,
				);
			}
		}

		// Payment soft delete: DELETE /api/payments/:id
		if (path.startsWith("/api/payments/") && method === "DELETE") {
			const parts = path.split("/");
			const paymentId = decodeURIComponent(parts[3] ?? "");
			if (parts.length === 4 && paymentId) {
				const deleteHandler = createPaymentDeleteHandler(this.context.dbOps);
				return await this.wrapHandler(() => deleteHandler(paymentId))(req, url);
			}
		}

		// Check for dynamic API key endpoints
		if (path.startsWith("/api/api-keys/")) {
			const parts = path.split("/");
			const keyIdOrName = decodeURIComponent(parts[3]); // Decode URL-encoded IDs/names

			// API key regenerate (mints a new secret, preserves stats)
			if (path.endsWith("/regenerate") && method === "POST") {
				const regenerateHandler = createApiKeyRegenerateHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					regenerateHandler(req, keyIdOrName),
				)(req, url);
			}

			// API key disable
			if (path.endsWith("/disable") && method === "POST") {
				const disableHandler = createApiKeyDisableHandler(this.context.dbOps);
				return await this.wrapHandler((req) =>
					disableHandler(req, keyIdOrName),
				)(req, url);
			}

			// API key enable
			if (path.endsWith("/enable") && method === "POST") {
				const enableHandler = createApiKeyEnableHandler(this.context.dbOps);
				return await this.wrapHandler((req) => enableHandler(req, keyIdOrName))(
					req,
					url,
				);
			}

			// API key routing pin (set/clear which account or provider-class this key routes to)
			if (path.endsWith("/pin") && method === "PUT") {
				const pinHandler = createApiKeyPinHandler(this.context.dbOps);
				return await this.wrapHandler((req) => pinHandler(req, keyIdOrName))(
					req,
					url,
				);
			}

			// API key rename (change the human-readable label; secret + stats preserved)
			if (path.endsWith("/rename") && method === "POST") {
				const renameHandler = createApiKeyRenameHandler(this.context.dbOps);
				return await this.wrapHandler((req) => renameHandler(req, keyIdOrName))(
					req,
					url,
				);
			}

			// API key delete
			if (parts.length === 4 && method === "DELETE") {
				const deleteHandler = createApiKeyDeleteHandler(this.context.dbOps);
				return await this.wrapHandler((req) => deleteHandler(req, keyIdOrName))(
					req,
					url,
				);
			}
		}

		// Check for dynamic combo endpoints
		if (path.startsWith("/api/combos/")) {
			const parts = path.split("/");
			const comboId = decodeURIComponent(parts[3]);

			// Combo slot sub-resource routes
			if (parts[4] === "slots" && parts[5] === "reorder" && method === "PUT") {
				const handler = createSlotReorderHandler(this.context.dbOps);
				return await this.wrapHandler((req) => handler(req, comboId))(req, url);
			}

			if (parts[4] === "slots" && parts.length === 5 && method === "POST") {
				const handler = createSlotAddHandler(this.context.dbOps);
				return await this.wrapHandler((req) => handler(req, comboId))(req, url);
			}

			if (parts[4] === "slots" && parts.length === 6) {
				const slotId = decodeURIComponent(parts[5]);

				if (method === "PUT") {
					const handler = createSlotUpdateHandler(this.context.dbOps);
					return await this.wrapHandler((req) => handler(req, comboId, slotId))(
						req,
						url,
					);
				}

				if (method === "DELETE") {
					const handler = createSlotRemoveHandler(this.context.dbOps);
					return await this.wrapHandler(() => handler(comboId, slotId))(
						req,
						url,
					);
				}
			}

			// GET /api/combos/:id
			if (parts.length === 4 && method === "GET") {
				const handler = createComboGetHandler(this.context.dbOps);
				return await this.wrapHandler(() => handler(comboId))(req, url);
			}

			// PUT /api/combos/:id
			if (parts.length === 4 && method === "PUT") {
				const handler = createComboUpdateHandler(this.context.dbOps);
				return await this.wrapHandler((req) => handler(req, comboId))(req, url);
			}

			// DELETE /api/combos/:id
			if (parts.length === 4 && method === "DELETE") {
				const handler = createComboDeleteHandler(this.context.dbOps);
				return await this.wrapHandler(() => handler(comboId))(req, url);
			}
		}

		// Check for dynamic family endpoints
		if (path.startsWith("/api/families/") && method === "PUT") {
			const parts = path.split("/");
			const family = decodeURIComponent(parts[3]);

			if (parts.length === 4) {
				const handler = createFamilyAssignHandler(this.context.dbOps);
				return await this.wrapHandler((req) => handler(req, family))(req, url);
			}
		}

		// Check for Qwen device flow status endpoint
		if (path.startsWith("/api/oauth/qwen/status/") && method === "GET") {
			const parts = path.split("/");
			const sessionId = parts[5];
			if (sessionId) {
				return await this.wrapHandler(() => this.qwenStatusHandler(sessionId))(
					req,
					url,
				);
			}
		}

		// Check for Codex device flow status endpoint
		if (path.startsWith("/api/oauth/codex/status/") && method === "GET") {
			const parts = path.split("/");
			const sessionId = parts[5];
			if (sessionId) {
				return await this.wrapHandler(() => this.codexStatusHandler(sessionId))(
					req,
					url,
				);
			}
		}

		// Check for token health account endpoint
		if (path.startsWith("/api/token-health/account/") && method === "GET") {
			const parts = path.split("/");
			const accountName = decodeURIComponent(parts[4]);
			if (accountName) {
				const accountTokenHealthHandler = createAccountTokenHealthHandler(
					this.context.dbOps,
					accountName,
				);
				return await this.wrapHandler(() => accountTokenHealthHandler())(
					req,
					url,
				);
			}
		}

		// No matching route
		return null;
	}
}
