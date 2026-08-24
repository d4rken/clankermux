import type { Config } from "@clankermux/config";
import type { BunSqlAdapter, DatabaseOperations } from "@clankermux/database";
import type {
	ApiKey,
	EventLoopLagStats,
	IntegrityStatus,
	LoadBalancingStrategy,
	ProviderOverloadStatus,
} from "@clankermux/types";
import type { SessionAuthService } from "./services/session-auth-service";

/**
 * Request-scoped context handed to every HTTP handler in this package.
 *
 * Defined here rather than in `@clankermux/types` because it references
 * `Config` and `DatabaseOperations` — concrete implementation types. Keeping it
 * here is what lets `@clankermux/types` stay a true leaf package with no
 * dependencies of its own.
 */
export interface APIContext {
	db: BunSqlAdapter;
	config: Config;
	dbOps: DatabaseOperations;
	/**
	 * The management login. Optional so a caller that only wants the read
	 * handlers can build a router without it; when absent the auth endpoints
	 * fall back to a service built from `dbOps`, which is the same thing the
	 * server injects. The SSE lanes lose their revocation guard without it, so
	 * production always passes one.
	 */
	sessionAuth?: SessionAuthService;
	auth?: {
		isAuthenticated: boolean;
		apiKey?: ApiKey;
	};
	runtime?: {
		port: number;
		tlsEnabled: boolean;
	};
	getAsyncWriterHealth?: () => {
		healthy: boolean;
		failureCount: number;
		recentDrops: number;
		queuedJobs: number;
	};
	getIntegrityStatus?: () => IntegrityStatus;
	getStrategy?: () => LoadBalancingStrategy | null;
	getEventLoopLag?: () => EventLoopLagStats;
	/**
	 * Live provider-overload breaker buckets. Injected because the breaker lives
	 * in @clankermux/proxy and this package must not depend on it.
	 */
	getProviderOverload?: () => ProviderOverloadStatus[];
}

// Re-export all types from the centralized types package
export type {
	AccountDeleteRequest,
	AccountResponse,
	ActiveSessionsAnalytics,
	ActiveSessionsTimePoint,
	AnalyticsFilterOption,
	AnalyticsFilterOptionsResponse,
	AnalyticsResponse,
	AnalyticsSection,
	AnalyticsTotals,
	CacheFlowPoint,
	CleanupResponse,
	ConfigResponse,
	FullAnalyticsResponse,
	HealthResponse,
	IntegrityStatus,
	ModelPerformance,
	PoolStatus,
	RequestResponse,
	RetentionGetResponse,
	RetentionSetRequest,
	SpeedTimePoint,
	StatsResponse,
	StorageUsageResponse,
	StorageUsageType,
	StrategyUpdateRequest,
	TimePoint,
	TokenBreakdown,
} from "@clankermux/types";
