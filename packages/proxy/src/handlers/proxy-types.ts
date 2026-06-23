import type { Config, RuntimeConfig } from "@clankermux/config";
import type { AsyncDbWriter, DatabaseOperations } from "@clankermux/database";
import type { Provider } from "@clankermux/providers";
import type { LoadBalancingStrategy } from "@clankermux/types";
import type { RequestRecorder } from "../request-recorder";

export interface ProxyContext {
	strategy: LoadBalancingStrategy;
	dbOps: DatabaseOperations;
	runtime: RuntimeConfig;
	config: Config;
	provider: Provider;
	refreshInFlight: Map<string, Promise<string>>;
	asyncWriter: AsyncDbWriter;
	/**
	 * Main-thread owner of request persistence (request/routing/payload rows,
	 * billingType, account side-effects, dashboard summary events). Usage is
	 * computed inline (usage-collector.ts) and attached via the recorder's
	 * attachUsageSummary — the post-processor worker has been retired. See
	 * request-recorder.ts.
	 */
	requestRecorder: RequestRecorder;
	/**
	 * The live Bun `Server` for this listener. Optional so existing ctx
	 * constructors/tests are unaffected. When present, the proxy uses
	 * `server.timeout(req, N)` to re-arm a held/streaming connection's
	 * per-connection idle timer (see bumpIdleTimeout in proxy.ts) so long CW
	 * holds and long quiet streaming gaps aren't reaped by the 180s base timeout.
	 */
	server?: import("bun").Server<undefined>;
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

/** HTTP headers used in proxy operations */
export const HEADERS = {
	CONTENT_TYPE: "Content-Type",
	AUTHORIZATION: "Authorization",
} as const;
