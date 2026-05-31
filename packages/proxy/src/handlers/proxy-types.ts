import type { Config, RuntimeConfig } from "@clankermux/config";
import type { AsyncDbWriter, DatabaseOperations } from "@clankermux/database";
import type { Provider } from "@clankermux/providers";
import type { LoadBalancingStrategy } from "@clankermux/types";
import type { RequestRecorder } from "../request-recorder";
import type { UsageWorkerController } from "../usage-worker-controller";

export interface ProxyContext {
	strategy: LoadBalancingStrategy;
	dbOps: DatabaseOperations;
	runtime: RuntimeConfig;
	config: Config;
	provider: Provider;
	refreshInFlight: Map<string, Promise<string>>;
	asyncWriter: AsyncDbWriter;
	usageWorker: UsageWorkerController;
	/**
	 * Main-thread owner of request persistence (request/routing/payload rows,
	 * billingType, account side-effects, dashboard summary events). The usage
	 * worker is now a pure usage computer; the recorder merges its slim summary
	 * with captured payload + meta. See request-recorder.ts.
	 */
	requestRecorder: RequestRecorder;
}

/** Error messages used throughout the proxy module */
export const ERROR_MESSAGES = {
	NO_ACCOUNTS:
		"No active accounts available - forwarding request without authentication",
	PROVIDER_CANNOT_HANDLE: "Provider cannot handle path",
	REFRESH_NOT_FOUND: "Refresh promise not found for account",
	UNAUTHENTICATED_FAILED: "Failed to forward unauthenticated request",
	ALL_ACCOUNTS_FAILED: "All accounts failed to proxy the request",
	TOKEN_REFRESH_FAILED: "Failed to refresh access token",
	PROXY_REQUEST_FAILED: "Failed to proxy request with account",
	POOL_EXHAUSTED: "All accounts are temporarily unavailable",
} as const;

/** Timing constants */
export const TIMING = {
	WORKER_SHUTDOWN_DELAY: 100, // ms
} as const;

/** HTTP headers used in proxy operations */
export const HEADERS = {
	CONTENT_TYPE: "Content-Type",
	AUTHORIZATION: "Authorization",
} as const;
