import type { Config } from "@clankermux/config";
import type { BunSqlAdapter, DatabaseOperations } from "@clankermux/database";
import type {
	ApiKey,
	EventLoopLagStats,
	IntegrityStatus,
	LoadBalancingStrategy,
} from "@clankermux/types";

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
}

// Re-export all types from the centralized types package
export type {
	AccountDeleteRequest,
	AccountResponse,
	ActiveSessionsAnalytics,
	ActiveSessionsTimePoint,
	AnalyticsResponse,
	CacheFlowPoint,
	CleanupResponse,
	ConfigResponse,
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
