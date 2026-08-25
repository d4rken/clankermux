import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeConfig } from "@clankermux/config";
import {
	type Disposable,
	PAUSE_REASON_NEEDS_REAUTH,
	TIME_CONSTANTS,
} from "@clankermux/core";
import type {
	Account,
	AccountIdentity,
	AccountPaymentRow,
	CodexWindowObservationRow,
	Combo,
	ComboFamily,
	ComboFamilyAssignment,
	ComboSlot,
	ComboWithSlots,
	IntegrityStatus,
	InternalDispatchSpendRow,
	MemoryHistoryPoint,
	MemorySnapshotRow,
	OpenAiBucketObservationRow,
	PaymentSource,
	RankedSnapshot,
	RateLimitReason,
	ScopedUsageSnapshotRow,
	ScopedUsageSnapshotSample,
	StorageUsageType,
	StrategyStore,
	ToolCallStat,
	UnifiedClaimObservationRow,
	UnifiedSummaryObservationRow,
	UsageSnapshotRow,
	UsageSnapshotSample,
} from "@clankermux/types";
import { parsePinnedProviders } from "@clankermux/types";
import { BunSqlAdapter } from "./adapters/bun-sql-adapter";
import { runOneShotBackfills } from "./backfills";
import type { CleanupCounts } from "./incremental-vacuum-worker";
import { EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE } from "./inline-incremental-vacuum-worker";
import { EMBEDDED_VACUUM_WORKER_CODE } from "./inline-vacuum-worker";
import { runMigrations } from "./migrations";
import { resolveDbPath } from "./paths";
import {
	PayloadWriteClient,
	type PayloadWriterFactory,
} from "./payload-write-client";
import { AccountRepository } from "./repositories/account.repository";
import { AccountPaymentRepository } from "./repositories/account-payment.repository";
import { ApiKeyRepository } from "./repositories/api-key.repository";
import {
	AuthRepository,
	type AuthSessionRecord,
	type PasswordBinding,
	type StoredPasswordVerifier,
} from "./repositories/auth.repository";
import {
	type CacheKeepaliveHistoryPoint,
	CacheKeepaliveSnapshotRepository,
	type CacheKeepaliveSnapshotRow,
} from "./repositories/cache-keepalive-snapshot.repository";
import {
	type CodexResetCreditAutoClaim,
	CodexResetCreditEventRepository,
	type CodexResetCreditEventResolvedStatus,
	type CodexResetCreditEventRow,
} from "./repositories/codex-reset-credit-event.repository";
import { CodexWindowObservationRepository } from "./repositories/codex-window-observation.repository";
import { ComboRepository } from "./repositories/combo.repository";
import { InternalDispatchSpendRepository } from "./repositories/internal-dispatch-spend.repository";
import { MemorySnapshotRepository } from "./repositories/memory-snapshot.repository";
import {
	type ModelOverrideDialect,
	ModelOverrideRepository,
	type ModelOverrideRow,
	type ModelOverrideUpsert,
} from "./repositories/model-override.repository";
import { OAuthRepository } from "./repositories/oauth.repository";
import { OpenAiBucketObservationRepository } from "./repositories/openai-bucket-observation.repository";
import {
	QuotaDriftResultRepository,
	type QuotaDriftResultRow,
} from "./repositories/quota-drift-result.repository";
import {
	type RequestData,
	RequestRepository,
	type RequestRoutingData,
} from "./repositories/request.repository";
import { StatsRepository } from "./repositories/stats.repository";
import { StrategyRepository } from "./repositories/strategy.repository";
import { UnifiedClaimObservationRepository } from "./repositories/unified-claim-observation.repository";
import { UnifiedSummaryObservationRepository } from "./repositories/unified-summary-observation.repository";
import { UsageScopedSnapshotRepository } from "./repositories/usage-scoped-snapshot.repository";
import { UsageSnapshotRepository } from "./repositories/usage-snapshot.repository";
import { withRetryingMethods } from "./retry";
import { runStorageUsageScanInWorker } from "./storage-usage-runner";

export interface DatabaseConfig {
	/** Enable WAL (Write-Ahead Logging) mode for better concurrency */
	walMode?: boolean;
	/**
	 * SQLite busy timeout in milliseconds for WORKER connections (vacuum,
	 * integrity-check). The MAIN connection deliberately does NOT use this —
	 * it is bounded to {@link MAIN_CONNECTION_BUSY_TIMEOUT_MS} so a C-level
	 * busy wait can never freeze the event loop for seconds.
	 */
	busyTimeoutMs?: number;
	/** Cache size in pages (negative value = KB) */
	cacheSize?: number;
	/** Synchronous mode: OFF, NORMAL, FULL */
	synchronous?: "OFF" | "NORMAL" | "FULL";
	/** Memory-mapped I/O size in bytes */
	mmapSize?: number;
	/** Retry configuration for database operations */
	retry?: DatabaseRetryConfig;
	/** Page size in bytes - default 2048 (2KB), recommend 4096 (4KB) for better memory efficiency */
	pageSize?: number;
}

export interface DatabaseRetryConfig {
	/** Maximum number of retry attempts for database operations */
	attempts?: number;
	/** Initial delay between retries in milliseconds */
	delayMs?: number;
	/** Backoff multiplier for exponential backoff */
	backoff?: number;
	/** Maximum delay between retries in milliseconds */
	maxDelayMs?: number;
}

/**
 * busy_timeout for the MAIN-thread connection only.
 *
 * bun:sqlite's busy handler waits at the C level (usleep) — the entire Bun
 * event loop freezes for however long this is whenever a main-thread call
 * hits SQLITE_BUSY (e.g. while the vacuum/integrity worker holds the write
 * lock). Keep it just long enough to absorb a brief write burst from a
 * worker connection; anything longer is handled asynchronously by
 * `BunSqlAdapter.withBusyRetry`, which catches SQLITE_BUSY and retries via
 * setTimeout (500ms cadence, up to 10 minutes) with the event loop free
 * between attempts.
 *
 * The separate `dbConfig.busyTimeoutMs` (default 10 000) is still passed to
 * WORKER connections (vacuum / integrity-check / dashboard workers), where
 * long C-level blocking is fine — workers have no event loop to protect.
 */
export const MAIN_CONNECTION_BUSY_TIMEOUT_MS = 250;

/**
 * Apply SQLite pragmas for optimal performance on distributed filesystems.
 *
 * Note: `PRAGMA integrity_check` is NOT run here. The check is moved to a
 * background worker (see `packages/proxy/src/integrity-scheduler.ts`) so it
 * doesn't gate startup — on a multi-GB DB it can block the event loop for
 * tens of seconds. The scheduler runs `quick_check` every few hours and a
 * full `integrity_check` daily, surfacing corruption through `/api/storage`
 * and the dashboard "Storage Integrity" card.
 */
function configureSqlite(db: Database, config: DatabaseConfig): void {
	try {
		// MUST be the first write-affecting PRAGMA. SQLite's auto_vacuum
		// mode is locked in the DB header at first-write time. Anything that
		// causes pages to be allocated (notably `PRAGMA journal_mode = WAL`
		// below) BEFORE this call would leave a fresh DB stuck at
		// auto_vacuum=NONE. For DBs created prior to this change the PRAGMA
		// is a no-op (rejected on non-empty mode-0 DBs); the migration
		// happens via `bootstrapAutoVacuum()` at server startup.
		//
		// We ONLY issue the PRAGMA when the current mode is 0. SQLite quietly
		// allows mode 1 (FULL) → mode 2 (INCREMENTAL) transitions without a
		// VACUUM — issuing the PRAGMA unconditionally would silently rewrite
		// an operator's `auto_vacuum=FULL` choice, which is a behavior change
		// Greptile flagged on the original PR. (Greptile #230)
		const currentMode = (
			db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
		).auto_vacuum;
		if (currentMode === 0) {
			db.exec("PRAGMA auto_vacuum = INCREMENTAL");
		}

		// Enable WAL mode for better concurrency (with error handling)
		if (config.walMode !== false) {
			try {
				const result = db.query("PRAGMA journal_mode = WAL").get() as {
					journal_mode: string;
				};
				if (result.journal_mode !== "wal") {
					console.warn(
						"Failed to enable WAL mode, falling back to DELETE mode",
					);
					db.run("PRAGMA journal_mode = DELETE");
				}
			} catch (error) {
				console.warn("WAL mode failed, using DELETE mode:", error);
				db.run("PRAGMA journal_mode = DELETE");
			}
		}

		// Bound the C-level busy wait on the main connection. Deliberately NOT
		// config.busyTimeoutMs (that value is for worker connections): a long
		// busy_timeout here parks the whole event loop inside SQLite's busy
		// handler whenever a worker holds the write lock. The adapter's async
		// busy-retry layer takes over past this bound. See
		// MAIN_CONNECTION_BUSY_TIMEOUT_MS.
		db.run(`PRAGMA busy_timeout = ${MAIN_CONNECTION_BUSY_TIMEOUT_MS}`);

		// Configure cache size
		if (config.cacheSize !== undefined) {
			db.run(`PRAGMA cache_size = ${config.cacheSize}`);
		}

		// Set synchronous mode (more conservative for distributed filesystems)
		const syncMode = config.synchronous || "FULL"; // Default to FULL for safety
		db.run(`PRAGMA synchronous = ${syncMode}`);

		// Configure memory-mapped I/O. `mmap_size = 0` is the SQLite-defined
		// way to *disable* mmap, so the value 0 is a meaningful setting — not
		// "no preference". Previously this branch was gated on `> 0`, which
		// meant the default `mmapSize: 0` silently fell through and bun:sqlite
		// used its built-in default (~15 GiB observed on a 15 GiB DB). That
		// memory-maps the entire file, which is invisible until something
		// walks every page — e.g. a full-DB VACUUM — at which point the
		// resident set explodes and the cgroup OOM-kills the process. Treat
		// `mmapSize` as "issue the PRAGMA whenever the operator has specified
		// a value, including 0".
		if (config.mmapSize !== undefined) {
			try {
				db.run(`PRAGMA mmap_size = ${config.mmapSize}`);
			} catch (error) {
				console.warn("Failed to set mmap_size:", error);
			}
		}

		// Set page size (only effective before any data is written, or after VACUUM)
		if (config.pageSize !== undefined) {
			const currentPageSize = (
				db.query("PRAGMA page_size").get() as { page_size: number }
			).page_size;
			if (currentPageSize !== config.pageSize) {
				db.run(`PRAGMA page_size = ${config.pageSize}`);
			}
		}

		// Additional optimizations for distributed filesystems
		db.run("PRAGMA temp_store = MEMORY");
		db.run("PRAGMA foreign_keys = ON");

		// WAL checkpointing is handled entirely OFF the main thread — disable
		// autocheckpoint on this (the main, writer) connection. Autocheckpoint
		// runs a synchronous PASSIVE checkpoint inside the committing connection
		// whenever the WAL crosses the threshold; because PASSIVE can't reset the
		// WAL while any reader (analytics worker, usage pollers) holds frames, the
		// WAL grows large and each such checkpoint does hundreds of ms of
		// synchronous I/O on the main thread — freezing the event loop (observed
		// as ~250-290ms "Event loop unresponsive" WARNs). With autocheckpoint off, the
		// 5-minute off-thread optimize tick reclaims the WAL via
		// wal_checkpoint(TRUNCATE) with busy_timeout=0, which never blocks the
		// loop (see runOptimize in incremental-vacuum-worker.ts).
		db.run("PRAGMA wal_autocheckpoint = 0");
	} catch (error) {
		console.error("Database configuration failed:", error);
		throw new Error(`Failed to configure SQLite database: ${error}`);
	}
}

/**
 * After this many consecutive `incrementalVacuum()` ticks fail to claim
 * the writer slot, the per-tick console.warn escalates to a louder
 * "sustained-busy" line. 3 ticks = 3 hours of missed reclamation, which
 * is the threshold where free pages start growing noticeably on a
 * write-heavy DB. (Greptile #230)
 */
const INC_VAC_SKIP_ESCALATE_AT = 3;

/**
 * Fallback retention for the usage_snapshots time-series when a caller of
 * cleanupOldRequests() doesn't pass an explicit snapshotRetentionMs (e.g. the
 * http-api "Clean up now" handler). 90 days mirrors the default returned by
 * config.getUsageSnapshotRetentionDays(); the server's hourly/startup cleanup
 * passes the configured value explicitly so a non-default is honored there.
 */
const DEFAULT_USAGE_SNAPSHOT_RETENTION_MS = 90 * TIME_CONSTANTS.DAY;

/**
 * Fallback retention for the memory_snapshots time-series when a caller of
 * cleanupOldRequests() doesn't pass an explicit memorySnapshotRetentionMs.
 * 14 days mirrors the default returned by config.getMemorySnapshotRetentionDays();
 * the server's hourly/startup cleanup passes the configured value explicitly.
 */
const DEFAULT_MEMORY_SNAPSHOT_RETENTION_MS = 14 * TIME_CONSTANTS.DAY;

/**
 * Retention for the request-aligned `unified_claim_observations` series. FIXED,
 * with no operator control and no fallback parameter: every caller of
 * `cleanupOldRequests()` prunes it on this value.
 *
 * Deliberately NOT the `usage_snapshot_retention_days` knob, whose default is
 * 3650 days — this table grows with request volume times claims-per-response,
 * so a decade of it is a different order of magnitude from a decade of poll
 * ticks. 90 days is long enough to fit a full weekly-window analysis several
 * times over.
 */
export const UNIFIED_CLAIM_OBSERVATION_RETENTION_MS = 90 * TIME_CONSTANTS.DAY;

/**
 * Retention for the `unified_summary_observations` series. FIXED, and
 * deliberately the SAME 90 days as the claim series: the two are captured from
 * one response and are only useful together, so a shorter window on either side
 * would silently half-orphan every joined read.
 */
export const UNIFIED_SUMMARY_OBSERVATION_RETENTION_MS = 90 * TIME_CONSTANTS.DAY;

/**
 * Retention for the `internal_dispatch_spend` series. FIXED at 90 days, matching
 * the claim series it is joined against by request id — a probe's spend is only
 * interpretable next to the claim state its response reported.
 */
export const INTERNAL_DISPATCH_SPEND_RETENTION_MS = 90 * TIME_CONSTANTS.DAY;

/**
 * Retention for the raw provider window/bucket observation series. FIXED at 90
 * days, matching the claim series: these are the Codex/OpenAI analogue of it,
 * and an analysis that spans one has to be able to span the other.
 */
export const PROVIDER_WINDOW_OBSERVATION_RETENTION_MS = 90 * TIME_CONSTANTS.DAY;

/**
 * How long a per-data-type storage-usage measurement is reused before the next
 * dashboard read triggers a fresh scan. The byte sums require a full-table
 * scan, so we cache to keep them off the proxy's hot path; 5 minutes is small
 * enough to feel live while bounding scan frequency on a multi-GB DB.
 */
const RETENTION_STORAGE_USAGE_TTL_MS = 5 * TIME_CONSTANTS.MINUTE;

/**
 * The retention-governed tables measured for the per-type storage breakdown,
 * each tied to a dashboard retention control via a stable `key`. Order matches
 * the controls (payloads, requests, usage snapshots).
 */
const RETENTION_USAGE_TABLES: ReadonlyArray<{
	key: StorageUsageType["key"];
	table: string;
}> = [
	{ key: "payloads", table: "request_payloads" },
	{ key: "requests", table: "requests" },
	{ key: "usage_snapshots", table: "usage_snapshots" },
	// Rides the usage-snapshot retention control (one knob for one series
	// family), so it has no control of its own — the card sums the two.
	{ key: "usage_scoped_snapshots", table: "usage_scoped_snapshots" },
	// Request-aligned claim series. Measured beside the usage snapshots because
	// it is the same kind of data, but it rides a FIXED retention of its own
	// (UNIFIED_CLAIM_OBSERVATION_RETENTION_MS), not the usage-snapshot control.
	{ key: "unified_claim_observations", table: "unified_claim_observations" },
	// The summary-level sibling of the claim series, on its own fixed retention
	// (UNIFIED_SUMMARY_OBSERVATION_RETENTION_MS) for the same reason.
	{
		key: "unified_summary_observations",
		table: "unified_summary_observations",
	},
	// The proxy's own probe spend, on a fixed retention matching the claim series
	// it joins against (INTERNAL_DISPATCH_SPEND_RETENTION_MS).
	{ key: "internal_dispatch_spend", table: "internal_dispatch_spend" },
	// The Codex/OpenAI analogue of the claim series, on the same fixed retention
	// (PROVIDER_WINDOW_OBSERVATION_RETENTION_MS).
	{ key: "codex_window_observations", table: "codex_window_observations" },
	{ key: "openai_bucket_observations", table: "openai_bucket_observations" },
	// Precomputed analysis output, kept to a handful of rows by the cleanup pass
	// rather than by a retention control of its own.
	{ key: "quota_drift_results", table: "quota_drift_results" },
	{ key: "memory_snapshots", table: "memory_snapshots" },
	// Riders on the requests retention (FK cascade) — no control of their own.
	{ key: "tool_calls", table: "request_tool_calls" },
	{ key: "tool_errors", table: "request_tool_errors" },
];

/**
 * bun:sqlite treats exactly `":memory:"` and `""` as a private in-memory
 * database. Neither can be opened by the scan worker — it would get its own
 * unrelated empty DB and report confident zeros — so both route to the inline
 * scan path. Exact matches only: the constructor opens without SQLITE_OPEN_URI,
 * so URI-looking strings (`file::memory:`) are LITERAL disk filenames here and
 * must go through the worker like any other file, not get substring-matched
 * into the inline path where a real multi-GB file would block the loop again.
 */
function isInMemoryDbPath(path: string): boolean {
	return path === "" || path === ":memory:";
}

/**
 * Approximate per-data-type storage usage. `measuredAt` is epoch ms (the
 * http-api handler converts to ISO for the wire). See `StorageUsageResponse`
 * for the meaning of `approxBytes` (logical content bytes, not on-disk pages).
 */
export interface RetentionStorageUsage {
	available: boolean;
	/** Epoch ms — the http-api handler converts to ISO for the wire. */
	measuredAt: number;
	dbBytes: number;
	walBytes: number;
	types: StorageUsageType[];
}

/**
 * DatabaseOperations using Repository Pattern
 * Provides a clean, organized interface for database operations
 *
 * SQLite-only. All public methods are async; the underlying bun:sqlite calls
 * resolve synchronously under the hood (see {@link BunSqlAdapter}).
 */
export class DatabaseOperations implements StrategyStore, Disposable {
	private adapter: BunSqlAdapter;
	/** Raw bun:sqlite Database. */
	private sqliteDb: Database;
	/** Resolved path to the SQLite DB file — used by the vacuum worker */
	private resolvedDbPath: string;
	/**
	 * auto_vacuum mode as it was on disk when this handle was opened, captured
	 * BEFORE `configureSqlite()` issues its own `PRAGMA auto_vacuum =
	 * INCREMENTAL`. SQLite quirk: that PRAGMA flips the connection-local view
	 * to the requested value even though the on-disk header can't change
	 * without a VACUUM — so a later `PRAGMA auto_vacuum` query on this
	 * connection returns the requested value, not the persisted one. Used by
	 * `bootstrapAutoVacuum()` to decide whether a migration VACUUM is actually
	 * needed. (Greptile #230)
	 */
	private originalAutoVacuumMode?: number;
	/** Prevents concurrent compact() calls from spawning multiple vacuum workers */
	private compacting = false;
	/**
	 * Hourly `incrementalVacuum()` ticks that bailed because the worker
	 * couldn't claim the writer slot (SQLITE_BUSY). Bumped on every failure,
	 * reset on every success. Once it crosses `INC_VAC_SKIP_ESCALATE_AT` we
	 * upgrade the per-tick `console.warn` to a louder warning so an operator
	 * notices the DB isn't reclaiming pages — without that, sustained write
	 * activity at tick time could leave free pages unreclaimed indefinitely.
	 * (Greptile #230)
	 */
	private incVacuumConsecutiveSkips = 0;
	private runtime?: RuntimeConfig;
	private dbConfig: DatabaseConfig;
	private retryConfig: DatabaseRetryConfig;
	/** Cached integrity check status; surfaced via /api/storage and /health. */
	private integrityStatus: IntegrityStatus = {
		status: "unchecked",
		runningKind: null,
		lastCheckAt: null,
		lastError: null,
		lastQuickCheckAt: null,
		lastQuickResult: null,
		lastQuickError: null,
		lastQuickAttemptAt: null,
		lastQuickSkipReason: null,
		lastFullCheckAt: null,
		lastFullResult: null,
		lastFullError: null,
		lastFullAttemptAt: null,
		lastFullSkipReason: null,
	};
	/**
	 * Cached per-data-type storage-usage measurement, with the epoch ms it was
	 * computed. Reused for {@link RETENTION_STORAGE_USAGE_TTL_MS}; invalidated by
	 * `cleanupOldRequests()` so a manual "Clean up now" reflects immediately.
	 */
	private retentionUsageCache: {
		value: RetentionStorageUsage;
		computedAt: number;
	} | null = null;
	/** Dedups concurrent storage-usage computations so a slow scan runs once. */
	private retentionUsageInFlight: Promise<RetentionStorageUsage> | null = null;
	/**
	 * Bumped by every cleanup so a scan that STARTED before the cleanup cannot
	 * write its pre-cleanup counts into the cache after the invalidation — a
	 * multi-minute worker scan can easily straddle a cleanup, and without this
	 * the stale measurement would win and stick for the whole TTL.
	 */
	private retentionUsageGeneration = 0;

	// Repositories
	private accounts: AccountRepository;
	private requests: RequestRepository;
	private oauth: OAuthRepository;
	private strategy: StrategyRepository;
	private stats: StatsRepository;
	private apiKeys: ApiKeyRepository;
	private auth: AuthRepository;
	private combo: ComboRepository;
	private usageSnapshots: UsageSnapshotRepository;
	private usageScopedSnapshots: UsageScopedSnapshotRepository;
	private unifiedClaimObservations: UnifiedClaimObservationRepository;
	private unifiedSummaryObservations: UnifiedSummaryObservationRepository;
	private internalDispatchSpend: InternalDispatchSpendRepository;
	private codexWindowObservations: CodexWindowObservationRepository;
	private openAiBucketObservations: OpenAiBucketObservationRepository;
	private memorySnapshots: MemorySnapshotRepository;
	private cacheKeepaliveSnapshots: CacheKeepaliveSnapshotRepository;
	private accountPayments: AccountPaymentRepository;
	private codexResetCreditEvents: CodexResetCreditEventRepository;
	private quotaDriftResults: QuotaDriftResultRepository;
	private modelOverrides: ModelOverrideRepository;

	constructor(
		dbPath?: string,
		dbConfig?: DatabaseConfig,
		retryConfig?: DatabaseRetryConfig,
	) {
		// Default database configuration optimized for distributed filesystems
		this.dbConfig = {
			walMode: true,
			busyTimeoutMs: 10000,
			// 256 MiB (negative = KiB). Fallback default for when no runtime config
			// is supplied; kept in sync with the runtime-config default in
			// packages/config/src/index.ts so a big-table INSERT keeps its hot
			// B-tree pages resident instead of doing cold-page disk I/O (~250 ms
			// event-loop blips). The runtime config normally overrides this.
			cacheSize: -262144,
			synchronous: "FULL",
			mmapSize: 0,
			pageSize: 2048,
			...dbConfig,
		};

		// Default retry configuration for database operations
		this.retryConfig = {
			attempts: 3,
			delayMs: 100,
			backoff: 2,
			maxDelayMs: 5000,
			...retryConfig,
		};

		const resolvedPath = dbPath ?? resolveDbPath();
		this.resolvedDbPath = resolvedPath;

		// Ensure the directory exists
		const dir = dirname(resolvedPath);
		mkdirSync(dir, { recursive: true });

		this.sqliteDb = new Database(resolvedPath, { create: true });

		// Capture the persisted auto_vacuum mode BEFORE configureSqlite's
		// leading PRAGMA flips the connection-local view. See the field
		// docstring for the SQLite quirk this works around. (Greptile #230)
		this.originalAutoVacuumMode = (
			this.sqliteDb.query("PRAGMA auto_vacuum").get() as {
				auto_vacuum: number;
			}
		).auto_vacuum;

		// Apply SQLite configuration
		configureSqlite(this.sqliteDb, this.dbConfig);

		runMigrations(this.sqliteDb);

		// Data passes that migrations deliberately do not do. Runs after the
		// schema is complete, and each pass records that it ran so it never
		// repeats (see backfills.ts).
		runOneShotBackfills(this.sqliteDb);

		this.adapter = new BunSqlAdapter(this.sqliteDb);

		// Initialize repositories. Each is wrapped so every call through it
		// retries on SQLITE_BUSY/SQLITE_LOCKED without the caller opting in —
		// see withRetryingMethods(). `retryConfig` is read through a thunk
		// because setRuntimeConfig() replaces it after construction.
		const retrying = <T extends object>(repo: T, label: string): T =>
			withRetryingMethods(repo, () => this.retryConfig, label);

		this.accounts = retrying(new AccountRepository(this.adapter), "accounts");
		this.requests = retrying(new RequestRepository(this.adapter), "requests");
		this.oauth = retrying(new OAuthRepository(this.adapter), "oauth");
		this.strategy = retrying(new StrategyRepository(this.adapter), "strategy");
		this.stats = retrying(new StatsRepository(this.adapter), "stats");
		this.apiKeys = retrying(new ApiKeyRepository(this.adapter), "apiKeys");
		this.auth = retrying(new AuthRepository(this.adapter), "auth");
		this.combo = retrying(new ComboRepository(this.adapter), "combo");
		this.usageSnapshots = retrying(
			new UsageSnapshotRepository(this.adapter),
			"usageSnapshots",
		);
		this.usageScopedSnapshots = retrying(
			new UsageScopedSnapshotRepository(this.adapter),
			"usageScopedSnapshots",
		);
		this.unifiedClaimObservations = retrying(
			new UnifiedClaimObservationRepository(this.adapter),
			"unifiedClaimObservations",
		);
		this.unifiedSummaryObservations = retrying(
			new UnifiedSummaryObservationRepository(this.adapter),
			"unifiedSummaryObservations",
		);
		this.internalDispatchSpend = retrying(
			new InternalDispatchSpendRepository(this.adapter),
			"internalDispatchSpend",
		);
		this.codexWindowObservations = retrying(
			new CodexWindowObservationRepository(this.adapter),
			"codexWindowObservations",
		);
		this.openAiBucketObservations = retrying(
			new OpenAiBucketObservationRepository(this.adapter),
			"openAiBucketObservations",
		);
		this.quotaDriftResults = retrying(
			new QuotaDriftResultRepository(this.adapter),
			"quotaDriftResults",
		);
		this.memorySnapshots = retrying(
			new MemorySnapshotRepository(this.adapter),
			"memorySnapshots",
		);
		this.cacheKeepaliveSnapshots = retrying(
			new CacheKeepaliveSnapshotRepository(this.adapter),
			"cacheKeepaliveSnapshots",
		);
		this.accountPayments = retrying(
			new AccountPaymentRepository(this.adapter),
			"accountPayments",
		);
		this.codexResetCreditEvents = retrying(
			new CodexResetCreditEventRepository(this.adapter),
			"codexResetCreditEvents",
		);
		this.modelOverrides = retrying(
			new ModelOverrideRepository(this.adapter),
			"modelOverrides",
		);
	}

	setRuntimeConfig(runtime: RuntimeConfig): void {
		this.runtime = runtime;

		// Update retry config from runtime config if available
		if (runtime.database?.retry) {
			this.retryConfig = {
				...this.retryConfig,
				...runtime.database.retry,
			};
		}
	}

	/**
	 * Get the underlying BunSqlAdapter for direct queries.
	 * Prefer this over getDatabase() — it exposes the async, Promise-returning
	 * query API with built-in busy-retry.
	 */
	getAdapter(): BunSqlAdapter {
		return this.adapter;
	}

	/**
	 * Get the underlying bun:sqlite Database.
	 * @deprecated Use getAdapter() for the async query API with busy-retry.
	 */
	getDatabase(): Database {
		return this.sqliteDb;
	}

	async runQuickIntegrityCheck(): Promise<string> {
		const result = this.sqliteDb.query("PRAGMA quick_check").get() as {
			quick_check: string;
		};
		return result.quick_check;
	}

	/**
	 * Run the full integrity check. Combines `PRAGMA integrity_check` and
	 * `PRAGMA foreign_key_check`: per SQLite docs `integrity_check` does NOT
	 * verify foreign keys, so detecting "silent wrong results" needs both.
	 *
	 * Returns "ok" when both pragmas pass; otherwise a multi-line error
	 * description combining the failing reports.
	 *
	 * NOTE: blocking. On a multi-GB DB this can take tens of seconds. Callers
	 * on the proxy hot path must invoke this via the integrity-check worker
	 * to avoid freezing the event loop.
	 */
	async runFullIntegrityCheck(): Promise<string> {
		// integrity_check can return multiple rows for long error reports.
		const integrityRows = this.sqliteDb
			.query("PRAGMA integrity_check")
			.all() as Array<{ integrity_check: string }>;
		const integrityMsg = integrityRows.map((r) => r.integrity_check).join("\n");

		// foreign_key_check returns one row per violation (empty result = ok).
		const fkRows = this.sqliteDb
			.query("PRAGMA foreign_key_check")
			.all() as Array<Record<string, unknown>>;
		const integrityOk = integrityMsg === "ok";
		const fkOk = fkRows.length === 0;
		if (integrityOk && fkOk) return "ok";

		const parts: string[] = [];
		if (!integrityOk) parts.push(`integrity_check: ${integrityMsg}`);
		if (!fkOk) {
			parts.push(
				`foreign_key_check: ${fkRows.length} violation(s) — ${JSON.stringify(fkRows.slice(0, 5))}${fkRows.length > 5 ? " (truncated)" : ""}`,
			);
		}
		return parts.join("\n");
	}

	/**
	 * Get cached integrity status (copy — caller can't mutate internal state).
	 */
	getIntegrityStatus(): IntegrityStatus {
		return { ...this.integrityStatus };
	}

	/**
	 * Path to the live SQLite file. Used by the integrity-check worker to open
	 * its own read-only handle.
	 */
	getResolvedDbPath(): string {
		return this.resolvedDbPath;
	}

	/**
	 * Build the factory that AsyncDbWriter uses to create its off-thread payload
	 * writer. DatabaseOperations owns the two things the client cannot resolve
	 * itself — the resolved DB path and the worker busy timeout — while the
	 * retention-window accessor is injected by the caller (it lives on the
	 * runtime Config, not on this class).
	 *
	 * The factory is lazy in both directions: calling this creates nothing, and
	 * AsyncDbWriter only invokes it on the first payload publication, so an
	 * instance that never stores payloads never spawns a worker.
	 */
	createPayloadWriterFactory(deps: {
		getPayloadRetentionMs: () => number;
	}): PayloadWriterFactory {
		return (hooks) =>
			new PayloadWriteClient({
				dbPath: this.resolvedDbPath,
				busyTimeoutMs: this.dbConfig.busyTimeoutMs,
				getRetentionMs: deps.getPayloadRetentionMs,
				onSettled: hooks.onSettled,
			});
	}

	/**
	 * Mark an integrity probe as in flight. Callers must pair this with
	 * `recordIntegrityResult()`. Returns false if a probe is already running
	 * — used as a cheap mutex.
	 *
	 * In-flight state is tracked ONLY via `runningKind`, deliberately decoupled
	 * from the collapsed `status`. Overwriting `status` with `"running"` here
	 * would make an existing `corrupt` verdict (and its cross-dashboard banner)
	 * vanish for up to the full worker timeout every time a recheck starts —
	 * exactly when the operator most needs to keep seeing it. The last verified
	 * `status` therefore persists across a running recheck; consumers detect
	 * "in flight" from `runningKind != null`. (`"running"` remains in the
	 * `IntegrityStatus.status` union for backwards-compat but is never assigned.)
	 */
	markIntegrityCheckRunning(kind: "quick" | "full"): boolean {
		if (this.integrityStatus.runningKind !== null) return false;
		this.integrityStatus = {
			...this.integrityStatus,
			runningKind: kind,
		};
		return true;
	}

	/**
	 * Record the outcome of a quick or full integrity probe and recompute the
	 * collapsed `status` field.
	 *
	 * `result` is one of:
	 *  - `"ok"` / `"corrupt"` — a VERIFIED verdict (the probe completed and
	 *    returned a real answer). `detail` carries the corruption message for
	 *    `"corrupt"`.
	 *  - `"skipped"` — the probe could NOT complete (worker timeout, worker
	 *    exception, or a defensive size-skip). `detail` carries the skip
	 *    reason. A skip records only the attempt timestamp + skip reason for
	 *    that kind; it does NOT overwrite the kind's last verified verdict,
	 *    timestamp, or error, and it does NOT advance `lastCheckAt` (which
	 *    tracks verified completions only). This is the whole point: a
	 *    timeout on a huge DB must not masquerade as proven corruption.
	 *
	 * Sticky-corrupt rule (unchanged):
	 *  - A full `corrupt` verdict poisons `status` until another *full* probe
	 *    returns `ok`. A subsequent quick `ok` does NOT clear it. A `skipped`
	 *    attempt of either kind never clears it either (skips don't touch the
	 *    per-kind Result fields, so the corrupt precedence still wins).
	 *  - A passing full check subsumes a lingering quick-corrupt (and clears a
	 *    lingering quick skip reason), since integrity_check is a strict
	 *    superset of quick_check.
	 */
	recordIntegrityResult(
		kind: "quick" | "full",
		result: "ok" | "corrupt" | "skipped",
		detail?: string | null,
	): void {
		const now = Date.now();
		const next: IntegrityStatus = {
			...this.integrityStatus,
			runningKind: null,
		};

		if (result === "skipped") {
			// Attempt could not complete: preserve the last verified verdict,
			// timestamp, and error for this kind — only stamp the attempt +
			// skip reason. `lastCheckAt` (verified completions) is untouched.
			const reason = detail ?? "check could not complete";
			if (kind === "quick") {
				next.lastQuickAttemptAt = now;
				next.lastQuickSkipReason = reason;
			} else {
				next.lastFullAttemptAt = now;
				next.lastFullSkipReason = reason;
			}
		} else if (kind === "quick") {
			next.lastQuickCheckAt = now;
			next.lastQuickResult = result;
			next.lastQuickError = result === "corrupt" ? (detail ?? null) : null;
			next.lastQuickAttemptAt = now;
			// A real verdict supersedes any prior skip for this kind.
			next.lastQuickSkipReason = null;
			next.lastCheckAt = now;
		} else {
			next.lastFullCheckAt = now;
			next.lastFullResult = result;
			next.lastFullError = result === "corrupt" ? (detail ?? null) : null;
			next.lastFullAttemptAt = now;
			next.lastFullSkipReason = null;
			// A passing full check is a strict superset of quick_check, so it
			// subsumes any lingering quick-corrupt: if the structurally-more-
			// thorough probe is clean, the structurally-less-thorough probe's
			// stale corrupt verdict is no longer accurate. Without this clear,
			// a quick `corrupt` recorded six hours ago would keep collapsed
			// `status = "corrupt"` on the dashboard until the next quick tick
			// even though a full check just returned ok. Likewise clear a
			// lingering quick skip reason so the collapsed status can settle to
			// "ok" rather than being pinned to "skipped".
			if (result === "ok") {
				next.lastQuickResult = "ok";
				next.lastQuickError = null;
				next.lastQuickSkipReason = null;
			}
			next.lastCheckAt = now;
		}

		// Recompute collapsed status by precedence:
		//   1. corrupt (a verified corrupt verdict wins; a skip can't clear it)
		//   2. skipped (most recent attempt of some kind couldn't complete)
		//   3. ok (some kind has a verified ok)
		//   4. unchecked (nothing verified, nothing skipped)
		const fullCorrupt = next.lastFullResult === "corrupt";
		const quickCorrupt = next.lastQuickResult === "corrupt";
		if (fullCorrupt || quickCorrupt) {
			next.status = "corrupt";
			next.lastError =
				next.lastFullError ?? next.lastQuickError ?? "integrity check failed";
		} else if (
			next.lastFullSkipReason !== null ||
			next.lastQuickSkipReason !== null
		) {
			next.status = "skipped";
			next.lastError = null;
		} else if (next.lastQuickResult === "ok" || next.lastFullResult === "ok") {
			next.status = "ok";
			next.lastError = null;
		} else {
			next.status = "unchecked";
			next.lastError = null;
		}

		this.integrityStatus = next;
	}

	/**
	 * Get storage metrics for database health monitoring
	 */
	async getStorageMetrics(): Promise<{
		dbBytes: number;
		walBytes: number;
		orphanPages: number;
		lastRetentionSweepAt: number | null;
		nullAccountRows: number;
	}> {
		// Database file size
		const dbBytes = await this.getDbSizeBytes();

		// WAL file size (if exists)
		const walBytes = await this.getWalSizeBytes();

		// Orphan pages (freelist count) - only in SQLite mode
		let orphanPages = 0;
		if (this.sqliteDb) {
			const result = this.sqliteDb.query("PRAGMA freelist_count").get() as {
				freelist_count: number;
			};
			orphanPages = result.freelist_count;
		}

		// Last retention sweep timestamp
		let lastRetentionSweepAt: number | null = null;
		try {
			const strategy = await this.getStrategy("data-retention");
			if (strategy?.config?.lastSweepAt) {
				lastRetentionSweepAt = strategy.config.lastSweepAt as number;
			}
		} catch {
			// tolerate legacy databases created before the strategies table existed
		}

		// Null account rows (requests with account_used IS NULL in last 24h)
		const cutoff = Date.now() - TIME_CONSTANTS.DAY;
		const nullAccountRow = await this.adapter.get<{ count: number }>(
			"SELECT COUNT(*) AS count FROM requests WHERE account_used IS NULL AND timestamp >= ?",
			[cutoff],
		);
		const nullAccountRows = nullAccountRow?.count ?? 0;

		return {
			dbBytes,
			walBytes,
			orphanPages,
			lastRetentionSweepAt,
			nullAccountRows,
		};
	}

	/**
	 * Approximate per-data-type storage usage for the retention settings card.
	 *
	 * Returns logical content bytes (`SUM(LENGTH(col))`) + row counts for the
	 * three retention-governed tables (payloads, requests, usage snapshots),
	 * plus the exact whole-file and WAL sizes. The result is cached for
	 * {@link RETENTION_STORAGE_USAGE_TTL_MS}; concurrent callers share one
	 * in-flight computation, and `cleanupOldRequests()` clears the cache so a
	 * manual "Clean up now" is reflected on the next read.
	 *
	 * A full-table scan is unavoidable for the byte sums, but WAL readers don't
	 * block the proxy's writer and the TTL keeps scans rare.
	 */
	async getRetentionStorageUsage(opts?: {
		maxAgeMs?: number;
	}): Promise<RetentionStorageUsage> {
		const ttl = opts?.maxAgeMs ?? RETENTION_STORAGE_USAGE_TTL_MS;
		const cached = this.retentionUsageCache;
		if (cached && Date.now() - cached.computedAt < ttl) {
			return cached.value;
		}
		if (this.retentionUsageInFlight) {
			return this.retentionUsageInFlight;
		}
		const generation = this.retentionUsageGeneration;
		const inFlight = this.computeRetentionStorageUsage()
			.then((value) => {
				// A cleanup may have invalidated mid-scan; its bump makes this
				// scan's snapshot stale, so return it to the callers who asked
				// for it but keep it out of the cache.
				if (generation === this.retentionUsageGeneration) {
					this.retentionUsageCache = { value, computedAt: Date.now() };
				}
				return value;
			})
			.finally(() => {
				if (this.retentionUsageInFlight === inFlight) {
					this.retentionUsageInFlight = null;
				}
			});
		this.retentionUsageInFlight = inFlight;
		return inFlight;
	}

	private async computeRetentionStorageUsage(): Promise<RetentionStorageUsage> {
		const measuredAt = Date.now();
		const dbBytes = await this.getDbSizeBytes();
		const walBytes = await this.getWalSizeBytes();

		// The byte sums are full-table scans, and bun:sqlite is synchronous —
		// run here they block the event loop for the whole scan (observed
		// 94–130 s against a cold OS page cache after a restart, freezing ALL
		// HTTP serving). The worker opens its own readonly handle instead; WAL
		// readers don't block this connection's writer. An in-memory DB cannot
		// be shared with a worker, so it scans inline — it is by definition
		// small enough not to block anything.
		if (isInMemoryDbPath(this.resolvedDbPath)) {
			const types = await Promise.all(
				RETENTION_USAGE_TABLES.map(async ({ key, table }) => {
					const { rowCount, approxBytes } =
						await this.measureTableLogicalSize(table);
					return { key, table, rowCount, approxBytes };
				}),
			);
			return { available: true, measuredAt, dbBytes, walBytes, types };
		}

		const scan = await runStorageUsageScanInWorker(this.resolvedDbPath, {
			tables: RETENTION_USAGE_TABLES,
			busyTimeoutMs: 10000,
		});
		if (!scan.ok) {
			console.warn(`[storage-usage] scan worker failed: ${scan.error}`);
			return {
				available: false,
				measuredAt,
				dbBytes,
				walBytes,
				types: RETENTION_USAGE_TABLES.map(({ key, table }) => ({
					key,
					table,
					rowCount: 0,
					approxBytes: 0,
				})),
			};
		}
		// Re-key by table so response order is the constant list's order even if
		// a worker ever reordered its output.
		const byTable = new Map(scan.types.map((t) => [t.table, t]));
		const types = RETENTION_USAGE_TABLES.map(({ key, table }) => ({
			key,
			table,
			rowCount: byTable.get(table)?.rowCount ?? 0,
			approxBytes: byTable.get(table)?.approxBytes ?? 0,
		}));
		return { available: true, measuredAt, dbBytes, walBytes, types };
	}

	/**
	 * Inline fallback for in-memory databases ONLY — a `:memory:` DB cannot be
	 * opened by the scan worker, and is small enough that the synchronous scan
	 * cannot meaningfully block. File-backed databases always go through
	 * `runStorageUsageScanInWorker`; this method blocks the event loop for the
	 * whole scan and must not be pointed at one. Same approximation as the
	 * worker: `SUM(LENGTH(col))` over every column, zeros on error (never
	 * throws) so one bad table can't sink the whole measurement.
	 */
	private async measureTableLogicalSize(
		table: string,
	): Promise<{ rowCount: number; approxBytes: number }> {
		try {
			// `table` and the column names come from a hardcoded constant list and
			// the table's own schema (PRAGMA), never user input — safe to inline.
			const cols = await this.adapter.query<{ name: string }>(
				`PRAGMA table_info("${table}")`,
			);
			if (cols.length === 0) return { rowCount: 0, approxBytes: 0 };
			const lengthExpr = cols
				.map((c) => `COALESCE(LENGTH("${c.name}"), 0)`)
				.join(" + ");
			const row = await this.adapter.get<{
				rowCount: number;
				approxBytes: number | null;
			}>(
				`SELECT COUNT(*) AS rowCount, SUM(${lengthExpr}) AS approxBytes FROM "${table}"`,
			);
			return {
				rowCount: row?.rowCount ?? 0,
				approxBytes: row?.approxBytes ?? 0,
			};
		} catch (err) {
			console.debug(`[measureTableLogicalSize] ${table} failed:`, err);
			return { rowCount: 0, approxBytes: 0 };
		}
	}

	/**
	 * Generate manual recovery instructions for corrupted database
	 */
	generateRecoveryInstructions(): string {
		const dbPath = this.resolvedDbPath;
		return `
DATABASE RECOVERY INSTRUCTIONS

If your database is corrupted, follow these steps:

1. STOP THE SERVER
   Stop the service via your service manager (e.g. systemctl stop clankermux),
   or press Ctrl-C if it is running in a terminal.

2. BACKUP CORRUPTED DATABASE
   cp ${dbPath} ${dbPath}.corrupted.backup
   cp ${dbPath}-wal ${dbPath}-wal.corrupted.backup 2>/dev/null || true
   cp ${dbPath}-shm ${dbPath}-shm.corrupted.backup 2>/dev/null || true

3. ATTEMPT RECOVERY (optional)
   sqlite3 ${dbPath}.corrupted.backup ".recover" > recovered.sql
   sqlite3 ${dbPath}.new < recovered.sql
   # If successful, replace original:
   mv ${dbPath}.new ${dbPath}

4. START FRESH (if recovery fails)
   rm ${dbPath} ${dbPath}-wal ${dbPath}-shm
   # Restart server - it will create a new empty database
   bun start

5. RE-ADD ACCOUNTS
   Add accounts from the dashboard (Accounts tab) or via POST /api/accounts.

NOTE: You will lose all historical request data and account configurations.
OAuth tokens will need to be re-authenticated.
`.trim();
	}

	/**
	 * Get the current retry configuration
	 */
	getRetryConfig(): DatabaseRetryConfig {
		return this.retryConfig;
	}

	// Account operations delegated to the repository. Retry on lock contention
	// is applied by the repository wrapper installed in the constructor, so
	// these delegations must NOT add their own — see withRetryingMethods().
	async getAllAccounts(): Promise<Account[]> {
		return this.accounts.findAll();
	}

	async getAccount(accountId: string): Promise<Account | null> {
		return this.accounts.findById(accountId);
	}

	async updateAccountTokens(
		accountId: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
		identity?: AccountIdentity | null,
		expectedRefreshToken?: string | null,
		options?: { refreshTokenExpiresAt?: number | null },
	): Promise<boolean> {
		return this.accounts.updateTokens(
			accountId,
			accessToken,
			expiresAt,
			refreshToken,
			identity,
			expectedRefreshToken,
			options,
		);
	}

	/**
	 * Persist an account identity captured from a successful profile-endpoint
	 * fetch, stamping `identity_profile_fetched_at` (the one-time-backfill gate).
	 * See {@link AccountRepository.setAccountIdentityFromProfile}.
	 */
	async setAccountIdentityFromProfile(
		accountId: string,
		identity: AccountIdentity,
	): Promise<void> {
		await this.accounts.setAccountIdentityFromProfile(accountId, identity);
	}

	/**
	 * Persist an account identity captured from a local token decode WITHOUT
	 * stamping `identity_profile_fetched_at` (the token-agnostic sibling used by
	 * the Codex startup identity backfill).
	 * See {@link AccountRepository.setAccountIdentity}.
	 */
	async setAccountIdentity(
		accountId: string,
		identity: AccountIdentity,
	): Promise<void> {
		await this.accounts.setAccountIdentity(accountId, identity);
	}

	async updateAccountUsage(accountId: string): Promise<void> {
		const sessionDuration =
			this.runtime?.sessionDurationMs || 5 * 60 * 60 * 1000;
		await this.accounts.incrementUsage(accountId, sessionDuration);
	}

	async markAccountRateLimited(
		accountId: string,
		until: number,
		reason: RateLimitReason,
	): Promise<number> {
		return this.accounts.setRateLimited(accountId, until, reason);
	}

	async markAccountRateLimitedDeadlineOnly(
		accountId: string,
		until: number,
		reason: RateLimitReason,
	): Promise<void> {
		await this.accounts.setRateLimitedDeadlineOnly(accountId, until, reason);
	}

	async resetConsecutiveRateLimits(
		accountId: string,
		notAfterMs?: number,
	): Promise<void> {
		await this.accounts.resetConsecutiveRateLimits(accountId, notAfterMs);
	}

	/**
	 * Clear expired rate_limited_until values from all accounts
	 * @param now The current timestamp to compare against
	 * @returns Number of accounts that had their rate_limited_until cleared
	 */
	async clearExpiredRateLimits(now: number): Promise<number> {
		return this.accounts.clearExpiredRateLimits(now);
	}

	async updateAccountRateLimitMeta(
		accountId: string,
		status: string,
		reset: number | null,
		remaining?: number | null,
	): Promise<void> {
		await this.accounts.updateRateLimitMeta(
			accountId,
			status,
			reset,
			remaining,
		);
	}

	async forceResetAccountRateLimit(accountId: string): Promise<boolean> {
		const changes = await this.accounts.clearRateLimitState(accountId);
		return changes >= 0;
	}

	/**
	 * Atomically clear the rate-limit lock for the capacity-restored path — but
	 * only when the observed cooldown is still in place UNCHANGED (deadline, write
	 * instant AND reason) and predates the evidence that justifies clearing it.
	 * Pinning the exact eligible reason is what keeps the release quota-derived:
	 * an `out_of_credits` floor or a per-IP burst cooldown written concurrently
	 * simply misses the WHERE. Returns true iff a row changed. See
	 * {@link AccountRepository.clearRateLimitOnCapacityRestore}.
	 */
	async clearRateLimitOnCapacityRestore(
		accountId: string,
		expectedRateLimitedUntil: number,
		expectedRateLimitedAt: number | null,
		expectedRateLimitedReason: string,
		evidenceFetchStartedAt: number,
	): Promise<boolean> {
		return this.accounts.clearRateLimitOnCapacityRestore(
			accountId,
			expectedRateLimitedUntil,
			expectedRateLimitedAt,
			expectedRateLimitedReason,
			evidenceFetchStartedAt,
		);
	}

	async pauseAccount(accountId: string, reason = "manual"): Promise<void> {
		await this.accounts.pause(accountId, reason);
	}

	/**
	 * Pause only if currently active; returns true when this call paused it.
	 * When `expectedRefreshToken` is provided, also requires the account to still
	 * hold that exact refresh token (guards against stale re-pauses after reauth).
	 */
	async pauseAccountIfActive(
		accountId: string,
		reason: string,
		expectedRefreshToken?: string | null,
	): Promise<boolean> {
		return this.accounts.pauseIfActive(accountId, reason, expectedRefreshToken);
	}

	async resumeAccount(accountId: string): Promise<void> {
		await this.accounts.resume(accountId);
	}

	/** Resume only if paused with `reason`; returns true when this call resumed it. */
	async resumeAccountIfPausedWithReason(
		accountId: string,
		reason: string,
	): Promise<boolean> {
		return this.accounts.resumeIfPausedWithReason(accountId, reason);
	}

	/**
	 * Resume an account only if it is paused specifically for needing re-auth
	 * (`oauth_invalid_grant`). Called after a successful reauth so the account
	 * returns to rotation automatically, without lifting a manual/overage/
	 * subscription pause. Returns true when this call resumed it.
	 */
	async resumeAccountIfNeedsReauth(accountId: string): Promise<boolean> {
		return this.accounts.resumeIfPausedWithReason(
			accountId,
			PAUSE_REASON_NEEDS_REAUTH,
		);
	}

	async renameAccount(accountId: string, newName: string): Promise<void> {
		await this.accounts.rename(accountId, newName);
	}

	async resetAccountSession(
		accountId: string,
		timestamp: number,
	): Promise<void> {
		await this.accounts.resetSession(accountId, timestamp);
	}

	/**
	 * Expire the account's active-session anchor (`session_start = NULL,
	 * session_request_count = 0`) so the no-affinity `global_session` routing
	 * path stops re-sticking traffic to it. Backs the "Reset session
	 * stickiness" action together with the in-memory affinity-pin clear.
	 * Returns the number of rows changed.
	 */
	async clearAccountSessionAnchor(accountId: string): Promise<number> {
		return this.accounts.clearSessionAnchor(accountId);
	}

	async setAccountBillingType(
		accountId: string,
		billingType: string | null,
	): Promise<void> {
		await this.accounts.setBillingType(accountId, billingType);
	}

	async setAccountNotes(
		accountId: string,
		notes: string | null,
	): Promise<void> {
		await this.accounts.setNotes(accountId, notes);
	}

	async setAccountRenewal(
		accountId: string,
		anchor: string | null,
		cadence: string | null,
		priceUsdMicros: number | null,
		autoStartDate: string | null,
	): Promise<void> {
		await this.accounts.setRenewal(
			accountId,
			anchor,
			cadence,
			priceUsdMicros,
			autoStartDate,
		);
	}

	async getAccountRenewalConfigs(): Promise<
		Array<{
			id: string;
			name: string;
			renewal_anchor: string | null;
			renewal_cadence: string | null;
			renewal_price_usd_micros: number | null;
			renewal_auto_start_date: string | null;
			paused: number;
		}>
	> {
		return this.accounts.getRenewalConfigs();
	}

	async updateAccountRequestCount(
		accountId: string,
		count: number,
	): Promise<void> {
		await this.accounts.updateRequestCount(accountId, count);
	}

	async updateAccountPriority(
		accountId: string,
		priority: number,
	): Promise<void> {
		await this.accounts.updatePriority(accountId, priority);
	}

	async setAutoFallbackEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.accounts.setAutoFallbackEnabled(accountId, enabled);
	}

	async setAutoPauseOnOverageEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.accounts.setAutoPauseOnOverageEnabled(accountId, enabled);
	}

	async setPeakHoursPauseEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.adapter.run(
			"UPDATE accounts SET peak_hours_pause_enabled = ? WHERE id = ?",
			[enabled ? 1 : 0, accountId],
		);
	}

	async setCodexAutoApplyResetCreditsEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.adapter.run(
			"UPDATE accounts SET codex_auto_apply_reset_credits_enabled = ? WHERE id = ?",
			[enabled ? 1 : 0, accountId],
		);
	}

	async setCodexAutoApplyResetOnWeeklyLimitEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.adapter.run(
			"UPDATE accounts SET codex_auto_apply_reset_on_weekly_limit_enabled = ? WHERE id = ?",
			[enabled ? 1 : 0, accountId],
		);
	}

	async hasAccountsForProvider(provider: string): Promise<boolean> {
		return this.accounts.hasAccountsForProvider(provider);
	}

	// Request operations delegated to repository

	/**
	 * Persist (upsert) a request row.
	 *
	 * Takes a single options object ON PURPOSE: the row has a long tail of
	 * optional metadata fields, and with a positional signature a call site that
	 * forgot to pass a newly added one still type-checked and silently wrote SQL
	 * NULL — indistinguishable from a legacy row. With an object, every call site
	 * is named and a required field is a compile error.
	 */
	async saveRequest(data: RequestData): Promise<void> {
		await this.requests.save(data);
	}

	async saveRequestRouting(data: RequestRoutingData): Promise<void> {
		await this.requests.saveRouting(data);
	}

	async saveRequestToolCalls(
		requestId: string,
		stats: ToolCallStat[],
	): Promise<void> {
		await this.requests.saveToolCalls(requestId, stats);
	}

	async updateRequestUsage(
		requestId: string,
		usage: RequestData["usage"],
		usageFinalizedAt?: number | null,
	): Promise<void> {
		await this.requests.updateUsage(requestId, usage, usageFinalizedAt);
	}

	/**
	 * Produce the stored form of a payload envelope (ciphertext when
	 * PAYLOAD_ENCRYPTION_KEY is set, plaintext otherwise). The INSERT itself
	 * happens off-thread in the payload-write worker — there is deliberately no
	 * main-thread request_payloads write path any more.
	 */
	async encryptPayloadForStorage(json: string): Promise<string> {
		return this.requests.encryptPayloadForStorage(json);
	}

	async getRequestPayload(id: string): Promise<unknown | null> {
		return this.requests.getPayload(id);
	}

	async listRequestPayloads(
		limit = 50,
	): Promise<Array<{ id: string; json: string }>> {
		return this.requests.listPayloads(limit);
	}

	async listRequestPayloadsWithAccountNames(limit = 50): Promise<
		Array<{
			id: string;
			json: string | null;
			timestamp: number;
			account_name: string | null;
		}>
	> {
		return this.requests.listPayloadsWithAccountNames(limit);
	}

	// OAuth operations delegated to repository
	async createOAuthSession(
		sessionId: string,
		accountName: string,
		verifier: string,
		mode: "console" | "claude-oauth",
		customEndpoint?: string,
		priority: number = 0,
		ttlMinutes = 10,
	): Promise<void> {
		await this.oauth.createSession(
			sessionId,
			accountName,
			verifier,
			mode,
			customEndpoint,
			priority,
			ttlMinutes,
		);
	}

	async getOAuthSession(sessionId: string): Promise<{
		accountName: string;
		verifier: string;
		mode: "console" | "claude-oauth";
		customEndpoint?: string;
		priority: number;
	} | null> {
		return this.oauth.getSession(sessionId);
	}

	async deleteOAuthSession(sessionId: string): Promise<void> {
		await this.oauth.deleteSession(sessionId);
	}

	async cleanupExpiredOAuthSessions(): Promise<number> {
		return this.oauth.cleanupExpiredSessions();
	}

	// Management session auth, delegated to repository. The rotation methods
	// (`setManagementPassword` / `clearManagementPassword`) revoke every session
	// in the same transaction as the verifier write — see AuthRepository.
	async getManagementPassword(): Promise<StoredPasswordVerifier | null> {
		return this.auth.getPassword();
	}

	async setManagementPassword(
		verifier: string,
		params: string,
		updatedAt: number,
	): Promise<number> {
		return this.auth.setPassword(verifier, params, updatedAt);
	}

	async clearManagementPassword(): Promise<number> {
		return this.auth.clearPassword();
	}

	/**
	 * Insert a session bound to the password that authorized it. Returns the rows
	 * inserted: 0 means the verifier changed while the login was hashing, so the
	 * session belongs to a password that no longer exists. The binding is
	 * required — there is no way to mint a session that names no password.
	 */
	async createManagementSession(
		record: AuthSessionRecord,
		boundTo: PasswordBinding,
	): Promise<number> {
		return this.auth.createSession(record, boundTo);
	}

	async getManagementSession(
		tokenHash: string,
	): Promise<AuthSessionRecord | null> {
		return this.auth.getSession(tokenHash);
	}

	async touchManagementSession(
		tokenHash: string,
		now: number,
		staleBeforeMs: number,
	): Promise<number> {
		return this.auth.touchSession(tokenHash, now, staleBeforeMs);
	}

	async deleteManagementSession(tokenHash: string): Promise<number> {
		return this.auth.deleteSession(tokenHash);
	}

	async deleteAllManagementSessions(): Promise<number> {
		return this.auth.deleteAllSessions();
	}

	async cleanupExpiredManagementSessions(
		now: number,
		idleCutoff: number,
	): Promise<number> {
		return this.auth.deleteExpiredSessions(now, idleCutoff);
	}

	// Strategy operations delegated to repository
	async getStrategy(name: string): Promise<{
		name: string;
		config: Record<string, unknown>;
		updatedAt: number;
	} | null> {
		return this.strategy.getStrategy(name);
	}

	async setStrategy(
		name: string,
		config: Record<string, unknown>,
	): Promise<void> {
		await this.strategy.set(name, config);
	}

	async listStrategies(): Promise<
		Array<{
			name: string;
			config: Record<string, unknown>;
			updatedAt: number;
		}>
	> {
		return this.strategy.list();
	}

	async deleteStrategy(name: string): Promise<boolean> {
		return this.strategy.delete(name);
	}

	// Analytics methods delegated to request repository
	async getRecentRequests(limit = 100): Promise<
		Array<{
			id: string;
			timestamp: number;
			method: string;
			path: string;
			account_used: string | null;
			status_code: number | null;
			success: boolean;
			response_time_ms: number | null;
		}>
	> {
		return this.requests.getRecentRequests(limit);
	}

	async getRequestStats(since?: number): Promise<{
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		avgResponseTime: number | null;
	}> {
		return this.requests.getRequestStats(since);
	}

	async aggregateStats(rangeMs?: number) {
		return this.requests.aggregateStats(rangeMs);
	}

	async getRecentErrors(limit?: number): Promise<string[]> {
		return this.requests.getRecentErrors(limit);
	}

	async getRequestsByAccount(since?: number): Promise<
		Array<{
			accountId: string;
			accountName: string | null;
			requestCount: number;
			successRate: number;
		}>
	> {
		return this.requests.getRequestsByAccount(since);
	}

	// Cleanup operations — six explicit passes:
	// Pass 1: delete payloads older than payloadRetentionMs (+ orphan sweep)
	// Pass 2: delete request metadata older than requestRetentionMs
	// Pass 3: delete usage snapshots older than snapshotRetentionMs
	// Pass 4: delete memory snapshots older than memorySnapshotRetentionMs
	// Pass 5: delete claim observations older than the FIXED
	//         UNIFIED_CLAIM_OBSERVATION_RETENTION_MS (no parameter — that series
	//         has no operator control)
	// Pass 6: evict oldest payloads until their content fits payloadMaxBytes
	//
	// `snapshotRetentionMs` and `memorySnapshotRetentionMs` are optional so
	// existing callers (including the http-api "Clean up now" handler) prune
	// snapshots for free without being changed: when omitted each falls back to
	// its DEFAULT_*_RETENTION_MS, matching the corresponding config getter's
	// default. The server's hourly + startup jobs pass the configured values
	// explicitly so a non-default retention is honored there.
	//
	// `payloadMaxBytes` defaults to 0 = the byte budget is disabled, so every
	// existing call site keeps exactly its previous meaning.
	async cleanupOldRequests(
		payloadRetentionMs: number,
		requestRetentionMs?: number,
		snapshotRetentionMs?: number,
		memorySnapshotRetentionMs?: number,
		payloadMaxBytes = 0,
	): Promise<{
		removedRequests: number;
		removedPayloads: number;
		removedPayloadsBySize: number;
		removedSnapshots: number;
		removedMemorySnapshots: number;
		removedUnifiedClaimObservations: number;
		removedUnifiedSummaryObservations: number;
		removedInternalDispatchSpend: number;
		removedCodexWindowObservations: number;
		removedOpenAiBucketObservations: number;
	}> {
		const now = Date.now();

		// Compute the four cutoffs, then run the DELETEs OFF the main thread in
		// the incremental-vacuum worker (kind "cleanup"). Deleting aged payload
		// rows (large multi-MB blobs) synchronously on the main connection froze
		// the event loop for seconds; the worker chunks them with slot-releasing
		// yields — see runCleanup in incremental-vacuum-worker.ts. requestCutoff
		// is null when request-row retention is disabled (payloads still purged).
		const payloadCutoff = now - payloadRetentionMs;
		const requestCutoff =
			typeof requestRetentionMs === "number" &&
			Number.isFinite(requestRetentionMs)
				? now - requestRetentionMs
				: null;
		const usageSnapshotCutoff =
			now -
			(typeof snapshotRetentionMs === "number" &&
			Number.isFinite(snapshotRetentionMs)
				? snapshotRetentionMs
				: DEFAULT_USAGE_SNAPSHOT_RETENTION_MS);
		const memorySnapshotCutoff =
			now -
			(typeof memorySnapshotRetentionMs === "number" &&
			Number.isFinite(memorySnapshotRetentionMs)
				? memorySnapshotRetentionMs
				: DEFAULT_MEMORY_SNAPSHOT_RETENTION_MS);
		// No parameter and no fallback: this series has one fixed retention for
		// every caller (see UNIFIED_CLAIM_OBSERVATION_RETENTION_MS).
		const unifiedClaimObservationCutoff =
			now - UNIFIED_CLAIM_OBSERVATION_RETENTION_MS;
		// Same story for the summary sibling and the probe-spend series: one fixed
		// retention each, no parameter, no fallback.
		const unifiedSummaryObservationCutoff =
			now - UNIFIED_SUMMARY_OBSERVATION_RETENTION_MS;
		const internalDispatchSpendCutoff =
			now - INTERNAL_DISPATCH_SPEND_RETENTION_MS;
		const providerWindowObservationCutoff =
			now - PROVIDER_WINDOW_OBSERVATION_RETENTION_MS;

		const empty = {
			removedRequests: 0,
			removedPayloads: 0,
			removedPayloadsBySize: 0,
			removedSnapshots: 0,
			removedMemorySnapshots: 0,
			removedUnifiedClaimObservations: 0,
			removedUnifiedSummaryObservations: 0,
			removedInternalDispatchSpend: 0,
			removedCodexWindowObservations: 0,
			removedOpenAiBucketObservations: 0,
		};

		const worker = this.spawnIncrementalVacuumWorker();
		try {
			const result = await new Promise<
				{ ok: true; cleanup: CleanupCounts } | { ok: false; error: string }
			>((resolve, reject) => {
				worker.onmessage = (event: MessageEvent) => resolve(event.data);
				worker.onerror = (event: ErrorEvent) =>
					reject(new Error(event.message ?? "cleanup worker error"));
				worker.postMessage({
					dbPath: this.resolvedDbPath,
					kind: "cleanup",
					payloadCutoff,
					requestCutoff,
					usageSnapshotCutoff,
					memorySnapshotCutoff,
					unifiedClaimObservationCutoff,
					unifiedSummaryObservationCutoff,
					internalDispatchSpendCutoff,
					providerWindowObservationCutoff,
					payloadMaxBytes,
				});
			});

			if (!result.ok) {
				// Best-effort: a failed cleanup tick must not throw into the hourly
				// maintenance job (that would skip the follow-up vacuum). Report
				// zero removed and let the next tick retry.
				console.warn(
					`[cleanupOldRequests] worker cleanup failed: ${result.error}`,
				);
				return empty;
			}
			return result.cleanup;
		} catch (err) {
			console.warn(`[cleanupOldRequests] worker cleanup error: ${err}`);
			return empty;
		} finally {
			worker.terminate();
			// Row counts/sizes may have changed (even a partial/failed run) — drop
			// the cached storage-usage measurement so the next dashboard read
			// recomputes. Must happen on THIS instance; the worker can't touch it.
			// The generation bump stops an in-flight pre-cleanup scan from
			// re-caching its stale snapshot, and detaching the in-flight promise
			// makes the dashboard's immediate post-cleanup refetch start a fresh
			// scan instead of adopting the pre-cleanup one.
			this.retentionUsageGeneration += 1;
			this.retentionUsageCache = null;
			this.retentionUsageInFlight = null;
		}
	}

	async getTableRowCounts(): Promise<
		Array<{ name: string; rowCount: number; dataBytes?: number }>
	> {
		try {
			const tables = await this.adapter.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			);
			const rows = await Promise.all(
				tables.map(async ({ name }) => {
					const countRow = await this.adapter.get<{ rowCount: number }>(
						`SELECT COUNT(*) AS rowCount FROM "${name}"`,
					);
					const rowCount = countRow?.rowCount ?? 0;
					// Measure actual data bytes for tables with known large text/blob columns
					if (name === "request_payloads") {
						const sizeRow = await this.adapter.get<{ dataBytes: number }>(
							`SELECT SUM(LENGTH(json)) AS dataBytes FROM "${name}"`,
						);
						return { name, rowCount, dataBytes: sizeRow?.dataBytes ?? 0 };
					}
					return { name, rowCount };
				}),
			);
			// Sort: tables with dataBytes first (largest first), then by rowCount
			return rows.sort((a, b) => {
				if (a.dataBytes !== undefined && b.dataBytes !== undefined)
					return b.dataBytes - a.dataBytes;
				if (a.dataBytes !== undefined) return -1;
				if (b.dataBytes !== undefined) return 1;
				return b.rowCount - a.rowCount;
			});
		} catch (err) {
			console.debug("[getTableRowCounts] query failed:", err);
			return [];
		}
	}

	async getDbSizeBytes(): Promise<number> {
		try {
			const { size } = await stat(this.resolvedDbPath);
			return size;
		} catch (err) {
			console.debug("[getDbSizeBytes] stat failed:", err);
			return 0;
		}
	}

	/**
	 * Size of the WAL sidecar file in bytes, or 0 when there is no `-wal` file
	 * (non-WAL journal mode, or it hasn't been created yet).
	 */
	async getWalSizeBytes(): Promise<number> {
		try {
			const { size } = await stat(`${this.resolvedDbPath}-wal`);
			return size;
		} catch {
			// WAL file doesn't exist or can't be accessed.
			return 0;
		}
	}

	async close(): Promise<void> {
		await this.adapter.close();
	}

	async dispose(): Promise<void> {
		await this.close();
	}

	/**
	 * Periodic `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)` (SQLite
	 * only), off-loaded to the incremental-vacuum worker (kind "optimize").
	 *
	 * Why a worker: the previous synchronous version ran both PRAGMAs on the
	 * main thread via `sqliteDb.exec()`. When another connection (e.g. the
	 * hourly incremental-vacuum worker after a retention cleanup) held the
	 * write lock, `PRAGMA optimize`'s internal ANALYZE parked inside SQLite's
	 * C-level busy handler for the full busy_timeout (10 s) — freezing the
	 * entire event loop — and then threw "database is locked". Even
	 * uncontended, a large ANALYZE or a fat-WAL checkpoint does real work
	 * that doesn't belong on the proxy's hot path.
	 *
	 * The worker connection uses `busy_timeout = 0`, so contention resolves
	 * instantly as `{ ok: true, skipped: true }` — skipping one 5-minute
	 * cycle while maintenance contends is normal; the next tick retries.
	 *
	 * Never throws for worker-reported failures; they come back as
	 * `{ ok: false, error }` so the periodic tick can log without crashing.
	 */
	async optimizeAsync(): Promise<{
		ok: boolean;
		skipped: boolean;
		durationMs?: number;
		error?: string;
	}> {
		const start = Date.now();
		const worker = this.spawnIncrementalVacuumWorker();
		try {
			const result = await new Promise<
				| { ok: true; skipped: boolean }
				| { ok: true; mode: number }
				| { ok: false; error: string }
			>((resolve, reject) => {
				worker.onmessage = (event: MessageEvent) => resolve(event.data);
				worker.onerror = (event: ErrorEvent) =>
					reject(new Error(event.message ?? "optimize worker error"));
				worker.postMessage({ dbPath: this.resolvedDbPath, kind: "optimize" });
			});
			const durationMs = Date.now() - start;
			if (!result.ok) {
				return { ok: false, skipped: false, durationMs, error: result.error };
			}
			return {
				ok: true,
				skipped: "skipped" in result ? result.skipped : false,
				durationMs,
			};
		} catch (err) {
			return {
				ok: false,
				skipped: false,
				durationMs: Date.now() - start,
				error: err instanceof Error ? err.message : String(err),
			};
		} finally {
			worker.terminate();
		}
	}

	/**
	 * One-time migration: promote the DB from auto_vacuum=NONE (mode 0) to
	 * INCREMENTAL (mode 2).
	 *
	 * Fresh DBs are born in INCREMENTAL mode via `ensureSchema()`'s leading
	 * `PRAGMA auto_vacuum = INCREMENTAL`. Existing DBs created before that
	 * line was added show `PRAGMA auto_vacuum = 0` in their header — the
	 * PRAGMA from `ensureSchema()` has no effect on a non-empty DB until the
	 * next VACUUM rewrites every page. This method does that VACUUM exactly
	 * once, blocking the caller.
	 *
	 * **Only migrates mode 0 → 2.** A DB at mode 1 (FULL) is an explicit
	 * operator choice — FULL reclaims pages immediately on every COMMIT
	 * whereas INCREMENTAL only reclaims when the hourly worker tick runs, so
	 * silently promoting mode 1 → 2 would change reclamation timing for a
	 * user who chose FULL on purpose. We leave mode 1 alone and log a
	 * one-line notice instead. (Greptile #230)
	 *
	 * **MUST be called before HTTP binds.** VACUUM is a write transaction
	 * that holds SQLite's single writer slot for the entire rewrite — on a
	 * 15 GB DB on local SSD this can take many minutes. Called from
	 * `apps/server/src/server.ts` startup so the proxy never observes a
	 * blocked writer slot.
	 *
	 * Returns `{ migrated: false }` whenever no work was done — both for the
	 * mode 2 (already INCREMENTAL) and mode 1 (deliberately FULL) cases. The
	 * `modeBefore` field distinguishes them so callers can log appropriately.
	 *
	 * Throws if VACUUM fails (e.g. insufficient disk space — VACUUM needs
	 * roughly 2× the DB size in free space transiently). Surfacing the
	 * failure is the right behavior; the proxy would otherwise start in a
	 * state where periodic incremental reclamation can never run.
	 */
	bootstrapAutoVacuum(): {
		migrated: boolean;
		modeBefore: number;
		modeAfter: number;
		durationMs: number;
	} {
		if (!this.sqliteDb) {
			return {
				migrated: false,
				modeBefore: 0,
				modeAfter: 0,
				durationMs: 0,
			};
		}

		// Resolve modeBefore from two sources, picking the trustworthy one for
		// each case (see `incrementalVacuum()` for the full rationale):
		//   - originalMode != 0: trust the captured value (SQLite quirk leaks
		//     the configureSqlite PRAGMA into post-config queries when the
		//     starting mode was non-zero).
		//   - originalMode === 0: trust a fresh query. Fresh DBs end up at
		//     mode 2 here (PRAGMA applied because file was empty); existing
		//     mode-0 DBs stay at 0 (PRAGMA silently rejected on non-empty
		//     DB). The query distinguishes correctly. (Greptile #230)
		const modeBefore =
			this.originalAutoVacuumMode && this.originalAutoVacuumMode !== 0
				? this.originalAutoVacuumMode
				: (
						this.sqliteDb.query("PRAGMA auto_vacuum").get() as {
							auto_vacuum: number;
						}
					).auto_vacuum;

		// Mode 2 (INCREMENTAL): steady-state, nothing to do.
		// Mode 1 (FULL): operator-chosen, don't silently rewrite their policy.
		// Anything else (= mode 0, NONE): migrate.
		if (modeBefore !== 0) {
			return {
				migrated: false,
				modeBefore,
				modeAfter: modeBefore,
				durationMs: 0,
			};
		}

		const start = Date.now();
		// `ensureSchema()` already ran this PRAGMA, but it's idempotent and a
		// freshly-opened handle may not have absorbed the setting from a prior
		// session. Cheap to re-issue, and removes a "spooky action at a
		// distance" failure mode where the next VACUUM doesn't flip the mode
		// because the PRAGMA wasn't actually set on this connection.
		this.sqliteDb.exec("PRAGMA auto_vacuum = INCREMENTAL");
		this.sqliteDb.exec("VACUUM");

		const { auto_vacuum: modeAfter } = this.sqliteDb
			.query("PRAGMA auto_vacuum")
			.get() as { auto_vacuum: number };

		// VACUUM committed the new mode to the header, so update our captured
		// value too — otherwise a second `bootstrapAutoVacuum()` call (rare,
		// but possible in tests) would re-trigger the VACUUM because the old
		// captured mode would still say 0.
		this.originalAutoVacuumMode = modeAfter;

		return {
			migrated: true,
			modeBefore,
			modeAfter,
			durationMs: Date.now() - start,
		};
	}

	/** Compact and reclaim disk space (SQLite only).
	 *
	 * In WAL mode the sequence is:
	 *  1. RESTART checkpoint — flushes all WAL frames back into the main file
	 *     and resets the WAL write position.  Returns (busy, log, checkpointed).
	 *     If busy > 0 another connection still holds a read lock; we still proceed
	 *     so that VACUUM compacts what it can, but we log the fact.
	 *  2. VACUUM — rewrites the main database file to reclaim free pages.
	 *     In WAL mode this is safe to run while the WAL exists; it issues its own
	 *     internal checkpoint before rebuilding.
	 *  3. TRUNCATE checkpoint — resets the WAL file to zero bytes after VACUUM.
	 *
	 * @returns diagnostic info about the checkpoint and whether vacuum ran.
	 */
	async compact(): Promise<{
		walBusy: number;
		walLog: number;
		walCheckpointed: number;
		vacuumed: boolean;
		walTruncateBusy?: number;
		error?: string;
	}> {
		if (this.compacting) {
			return {
				walBusy: 0,
				walLog: 0,
				walCheckpointed: 0,
				vacuumed: false,
				error: "Compaction already in progress",
			};
		}

		// Run the WAL checkpoint + VACUUM + TRUNCATE sequence in a Worker thread
		// so the main Bun event loop stays free to serve health checks and other
		// requests during what can be a minutes-long exclusive DB operation.
		const dbPath = this.resolvedDbPath;
		let worker: Worker;
		if (EMBEDDED_VACUUM_WORKER_CODE) {
			const workerCode = Buffer.from(
				EMBEDDED_VACUUM_WORKER_CODE,
				"base64",
			).toString("utf8");
			const blob = new Blob([workerCode], { type: "text/javascript" });
			worker = new Worker(URL.createObjectURL(blob), { smol: true });
		} else {
			worker = new Worker(new URL("./vacuum-worker.ts", import.meta.url).href);
		}
		this.compacting = true;

		try {
			const result = await new Promise<{
				ok: boolean;
				walBusy?: number;
				walLog?: number;
				walCheckpointed?: number;
				walTruncateBusy?: number;
				error?: string;
			}>((resolve, reject) => {
				worker.onmessage = (event: MessageEvent) => resolve(event.data);
				worker.onerror = (event: ErrorEvent) =>
					reject(new Error(event.message));
				worker.postMessage({
					dbPath,
					busyTimeoutMs: this.dbConfig.busyTimeoutMs ?? 10000,
				});
			});

			if (!result.ok) {
				const msg = result.error ?? "Unknown error in vacuum worker";
				console.error(`[compact] Database compaction failed: ${msg}`);
				return {
					walBusy: result.walBusy ?? 0,
					walLog: result.walLog ?? 0,
					walCheckpointed: result.walCheckpointed ?? 0,
					vacuumed: false,
					walTruncateBusy: result.walTruncateBusy,
					error: msg,
				};
			}

			return {
				walBusy: result.walBusy ?? 0,
				walLog: result.walLog ?? 0,
				walCheckpointed: result.walCheckpointed ?? 0,
				vacuumed: true,
				walTruncateBusy: result.walTruncateBusy,
			};
		} finally {
			this.compacting = false;
			worker.terminate();
		}
	}

	/**
	 * Spawn the incremental-vacuum worker (shared by `incrementalVacuum()`
	 * — kind "vacuum" — and `optimizeAsync()` — kind "optimize"). Uses the
	 * embedded base64 bundle when available (production build), falling back
	 * to the on-disk worker source (tests / fresh worktrees where the inline
	 * file is an empty placeholder).
	 */
	private spawnIncrementalVacuumWorker(): Worker {
		if (EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE) {
			const workerCode = Buffer.from(
				EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE,
				"base64",
			).toString("utf8");
			const blob = new Blob([workerCode], { type: "text/javascript" });
			return new Worker(URL.createObjectURL(blob), { smol: true });
		}
		return new Worker(
			new URL("./incremental-vacuum-worker.ts", import.meta.url).href,
		);
	}

	/**
	 * Incremental vacuum — reclaims a bounded number of free pages back to the
	 * OS. Off-loaded to a Worker thread so the main JS event loop stays free
	 * while the operation holds the SQLite writer slot.
	 *
	 * Refuses if `auto_vacuum != 2` (INCREMENTAL). The previous implementation
	 * silently bootstrapped INCREMENTAL mode by running a full `VACUUM` inline,
	 * which on a multi-GB DB rewrote the entire file on the main thread and
	 * froze the proxy for many minutes. Fresh DBs are now born in INCREMENTAL
	 * mode via `ensureSchema()`; existing DBs upgraded from auto_vacuum=NONE
	 * are migrated at startup before HTTP binds (see runBootstrapAutoVacuum in
	 * apps/server/src/server.ts). This method therefore expects mode 2 and
	 * logs a one-line warning otherwise — no destructive fallback.
	 *
	 * Returns a Promise; callers that don't need to await can ignore it. The
	 * inner worker handles its own errors and posts them back as
	 * `{ok: false, error}` — we surface them via the returned promise rather
	 * than throwing, so a transient failure doesn't crash the hourly tick.
	 */
	async incrementalVacuum(pages = 8000): Promise<void> {
		// Resolve the effective auto_vacuum mode. The captured `originalMode`
		// is the on-disk value at handle-open time; configureSqlite then
		// issued `PRAGMA auto_vacuum = INCREMENTAL`. Two cases:
		//
		//   - originalMode != 0: SQLite quirk — the PRAGMA flips the
		//     connection-local query result to 2 even though the on-disk
		//     header can't change without a VACUUM. We trust `originalMode`.
		//
		//   - originalMode === 0: the PRAGMA either took effect (fresh DB,
		//     header now 2) or was silently rejected (non-empty mode-0 DB,
		//     header still 0). In this case the fresh PRAGMA query is
		//     reliable — it returns 0 if rejected, 2 if applied.
		//
		// (Greptile #230)
		const autoVacuum =
			this.originalAutoVacuumMode && this.originalAutoVacuumMode !== 0
				? this.originalAutoVacuumMode
				: (
						this.sqliteDb.query("PRAGMA auto_vacuum").get() as {
							auto_vacuum: number;
						}
					).auto_vacuum;
		if (autoVacuum !== 2) {
			// One-line debug; the loud startup-time warning in the bootstrap
			// path is the right place to flag this. Repeating a WARN every
			// hour would spam logs without adding signal.
			console.debug(
				`[incrementalVacuum] skipped — auto_vacuum=${autoVacuum}; expected 2 (INCREMENTAL). ` +
					`Run startup bootstrap migration to enable incremental reclamation.`,
			);
			return;
		}

		const dbPath = this.resolvedDbPath;
		const worker = this.spawnIncrementalVacuumWorker();

		try {
			const result = await new Promise<
				{ ok: true; mode: number } | { ok: false; error: string }
			>((resolve, reject) => {
				worker.onmessage = (event: MessageEvent) => resolve(event.data);
				worker.onerror = (event: ErrorEvent) =>
					reject(new Error(event.message ?? "incremental-vacuum worker error"));
				worker.postMessage({ dbPath, pages, kind: "vacuum" });
			});
			if (result.ok) {
				this.incVacuumConsecutiveSkips = 0;
			} else {
				this.incVacuumConsecutiveSkips += 1;
				// Single-tick failures are common and noise — sustained skips
				// across several hourly ticks mean the DB isn't getting any
				// reclamation, which can let free pages accumulate without
				// bound. Escalate after 3 consecutive skips (= 3 hours of
				// missed reclamation). (Greptile #230)
				if (this.incVacuumConsecutiveSkips >= INC_VAC_SKIP_ESCALATE_AT) {
					console.warn(
						`[incrementalVacuum] worker error (${this.incVacuumConsecutiveSkips} consecutive ` +
							`skips, ≈${this.incVacuumConsecutiveSkips}h of missed reclamation): ` +
							`${result.error}. ` +
							`Sustained SQLITE_BUSY suggests writer-slot contention — investigate ` +
							`whether long-running writers (large DELETEs, manual maintenance) are ` +
							`overlapping the hourly tick.`,
					);
				} else {
					console.warn(`[incrementalVacuum] worker error: ${result.error}`);
				}
			}
		} finally {
			worker.terminate();
		}
	}

	// API Key operations delegated to repository
	async getApiKeys() {
		return this.apiKeys.findAll();
	}

	async getActiveApiKeys() {
		return this.apiKeys.findActive();
	}

	async getApiKey(id: string) {
		return this.apiKeys.findById(id);
	}

	async getApiKeyByHashedKey(hashedKey: string) {
		return this.apiKeys.findByHashedKey(hashedKey);
	}

	async getApiKeyByName(name: string) {
		return this.apiKeys.findByName(name);
	}

	async apiKeyNameExists(name: string): Promise<boolean> {
		return this.apiKeys.nameExists(name);
	}

	async createApiKey(apiKey: {
		id: string;
		name: string;
		hashedKey: string;
		prefixLast8: string;
		createdAt: number;
		lastUsed?: number | null;
		isActive: boolean;
	}): Promise<void> {
		await this.apiKeys.create({
			id: apiKey.id,
			name: apiKey.name,
			hashed_key: apiKey.hashedKey,
			prefix_last_8: apiKey.prefixLast8,
			created_at: apiKey.createdAt,
			last_used: apiKey.lastUsed || null,
			is_active: apiKey.isActive ? 1 : 0,
		});
	}

	async updateApiKeyUsage(id: string, timestamp: number): Promise<void> {
		await this.apiKeys.updateUsage(id, timestamp);
	}

	/**
	 * Read just the routing pin for an API key. Returns null when the key does
	 * not exist; otherwise the parsed pinnedAccountId / pinnedProviders without
	 * exposing the stored secret to the caller.
	 */
	async getApiKeyPin(id: string): Promise<{
		pinnedAccountId: string | null;
		pinnedProviders: string[] | null;
		/**
		 * True when pinned_providers is stored as a non-empty value that does not
		 * parse to a valid provider allow-list (corruption / manual tampering).
		 * The routing layer must FAIL CLOSED on this rather than treat the key as
		 * unpinned — silently dropping a pin could route a Codex-pinned key to a
		 * Claude account (ban risk + wrong model).
		 */
		malformed: boolean;
	} | null> {
		const raw = await this.apiKeys.findRawPinById(id);
		if (!raw) {
			return null;
		}
		const pinnedProviders = parsePinnedProviders(raw.pinnedProvidersRaw);
		// Only NULL and "" are legitimate "no providers pin" states (the write
		// path clears to NULL). ANY other stored value that fails to parse to a
		// valid allow-list — whitespace-only, "[]", malformed JSON, wrong shape —
		// is corruption/tampering and must fail closed, not route unpinned.
		const malformed =
			raw.pinnedProvidersRaw != null &&
			raw.pinnedProvidersRaw !== "" &&
			pinnedProviders === null;
		return {
			pinnedAccountId: raw.pinnedAccountId,
			pinnedProviders,
			malformed,
		};
	}

	/**
	 * Set (or clear) the routing pin for an API key. Serializes the provider
	 * allow-list to a JSON array string (null when empty/unset) before storing.
	 */
	async updateApiKeyPin(
		id: string,
		pinnedAccountId: string | null,
		pinnedProviders: string[] | null,
	): Promise<boolean> {
		const serialized =
			pinnedProviders && pinnedProviders.length > 0
				? JSON.stringify(pinnedProviders)
				: null;
		return this.apiKeys.updatePin(id, pinnedAccountId, serialized);
	}

	async disableApiKey(id: string): Promise<boolean> {
		return this.apiKeys.disable(id);
	}

	async enableApiKey(id: string): Promise<boolean> {
		return this.apiKeys.enable(id);
	}

	async renameApiKey(id: string, newName: string): Promise<boolean> {
		return this.apiKeys.rename(id, newName);
	}

	async deleteApiKey(id: string): Promise<boolean> {
		return this.apiKeys.delete(id);
	}

	async rotateApiKeySecret(
		id: string,
		expectedHashedKey: string,
		newHashedKey: string,
		newPrefixLast8: string,
	): Promise<boolean> {
		return this.apiKeys.rotateSecret(
			id,
			expectedHashedKey,
			newHashedKey,
			newPrefixLast8,
		);
	}

	async countActiveApiKeys(): Promise<number> {
		return this.apiKeys.countActive();
	}

	async countAllApiKeys(): Promise<number> {
		return this.apiKeys.countAll();
	}

	/**
	 * Clear all API keys (for testing purposes)
	 */
	async clearApiKeys(): Promise<void> {
		await this.apiKeys.clearAll();
	}

	/**
	 * Get the API key repository for direct access
	 */
	getApiKeyRepository(): ApiKeyRepository {
		return this.apiKeys;
	}

	/**
	 * Get the stats repository for consolidated stats access
	 */
	getStatsRepository(): StatsRepository {
		return this.stats;
	}

	// ── Combo operations delegated to repository ──────────────────────────────

	async createCombo(name: string, description?: string | null): Promise<Combo> {
		return this.combo.create(name, description);
	}

	async listCombos(): Promise<Combo[]> {
		return this.combo.findAll();
	}

	async getCombo(id: string): Promise<Combo | null> {
		return this.combo.findById(id);
	}

	async updateCombo(
		id: string,
		fields: Partial<{
			name: string;
			description: string | null;
			enabled: boolean;
		}>,
	): Promise<Combo> {
		return this.combo.update(id, fields);
	}

	async deleteCombo(id: string): Promise<void> {
		await this.combo.delete(id);
	}

	async addComboSlot(
		comboId: string,
		accountId: string,
		model: string,
		priority: number,
	): Promise<ComboSlot> {
		return this.combo.addSlot(comboId, accountId, model, priority);
	}

	async updateComboSlot(
		slotId: string,
		fields: Partial<{ model: string; priority: number; enabled: boolean }>,
	): Promise<ComboSlot> {
		return this.combo.updateSlot(slotId, fields);
	}

	async removeComboSlot(slotId: string): Promise<void> {
		await this.combo.removeSlot(slotId);
	}

	async getComboSlots(comboId: string): Promise<ComboSlot[]> {
		return this.combo.getSlots(comboId);
	}

	async reorderComboSlots(comboId: string, slotIds: string[]): Promise<void> {
		await this.combo.reorderSlots(comboId, slotIds);
	}

	async setFamilyCombo(
		family: ComboFamily,
		comboId: string | null,
		enabled: boolean,
	): Promise<void> {
		await this.combo.setFamilyAssignment(family, comboId, enabled);
	}

	async getFamilyAssignments(): Promise<ComboFamilyAssignment[]> {
		return this.combo.getFamilyAssignments();
	}

	async getActiveComboForFamily(
		family: ComboFamily,
	): Promise<ComboWithSlots | null> {
		return this.combo.getActiveComboForFamily(family);
	}

	// ── Usage snapshot operations delegated to repository ─────────────────────

	async insertUsageSnapshots(rows: UsageSnapshotRow[]): Promise<void> {
		await this.usageSnapshots.insertSnapshots(rows);
	}

	async getUsageSnapshots(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<RankedSnapshot[]> {
		return this.usageSnapshots.getSnapshots(opts);
	}

	async getLatestUsageSnapshots(
		accountIds: string[],
	): Promise<RankedSnapshot[]> {
		return this.usageSnapshots.getLatestSnapshots(accountIds);
	}

	async getRecentUsageSnapshotsForAccounts(
		accountIds: string[],
		sinceMs: number,
	): Promise<UsageSnapshotSample[]> {
		return this.usageSnapshots.getRecentSnapshotsForAccounts(
			accountIds,
			sinceMs,
		);
	}

	async deleteUsageSnapshotsOlderThan(cutoffMs: number): Promise<number> {
		return this.usageSnapshots.deleteOlderThan(cutoffMs);
	}

	// ── Scoped (per-model-family weekly) usage snapshot operations ────────────

	async insertScopedUsageSnapshots(
		rows: ScopedUsageSnapshotRow[],
	): Promise<void> {
		await this.usageScopedSnapshots.insertSnapshots(rows);
	}

	async getRecentScopedUsageSnapshotsForAccounts(
		accountIds: string[],
		sinceMs: number,
	): Promise<ScopedUsageSnapshotSample[]> {
		return this.usageScopedSnapshots.getRecentSnapshotsForAccounts(
			accountIds,
			sinceMs,
		);
	}

	async deleteScopedUsageSnapshotsOlderThan(cutoffMs: number): Promise<number> {
		return this.usageScopedSnapshots.deleteOlderThan(cutoffMs);
	}

	// ── Request-aligned unified claim observations ────────────────────────────

	/**
	 * Record one response's per-claim rate-limit readings. Idempotent on
	 * (request_id, claim); real constraint violations still throw. Retention for
	 * this series is the cleanup worker's, not a repository method.
	 */
	async saveUnifiedClaimObservations(
		rows: UnifiedClaimObservationRow[],
	): Promise<void> {
		await this.unifiedClaimObservations.insertMany(rows);
	}

	/**
	 * Record one response's SUMMARY-level unified reading. Idempotent on
	 * request_id; real constraint violations still throw. Written from the same
	 * capture site as the claim rows and sharing their `observedAt`, but
	 * independently: a response can carry a summary and no claim lines at all.
	 */
	async saveUnifiedSummaryObservation(
		row: UnifiedSummaryObservationRow,
	): Promise<void> {
		await this.unifiedSummaryObservations.insert(row);
	}

	// ── Internal-dispatch spend ───────────────────────────────────────────────

	/**
	 * Record one internal probe dispatch's token vector (keepalive replay /
	 * auto-refresh probe). Idempotent on the dispatch's request id. Retention is
	 * the cleanup worker's, not a repository method.
	 */
	async saveInternalDispatchSpend(
		row: InternalDispatchSpendRow,
	): Promise<void> {
		await this.internalDispatchSpend.insert(row);
	}

	// ── Raw provider window / bucket observations ─────────────────────────────

	/**
	 * Record one upstream attempt's RAW Codex window lines. Idempotent on
	 * (observation_id, scope, family_codename, slot).
	 */
	async saveCodexWindowObservations(
		rows: CodexWindowObservationRow[],
	): Promise<void> {
		await this.codexWindowObservations.insertMany(rows);
	}

	/**
	 * Record one upstream attempt's OpenAI-compatible bucket readings. Idempotent
	 * on (observation_id, bucket).
	 */
	async saveOpenAiBucketObservations(
		rows: OpenAiBucketObservationRow[],
	): Promise<void> {
		await this.openAiBucketObservations.insertMany(rows);
	}

	// ── Precomputed quota-drift results ───────────────────────────────────────

	/**
	 * Store one completed quota-drift precompute pass. Written from the MAIN
	 * thread: the pass itself runs on a read-only worker connection, which
	 * cannot write.
	 */
	async insertQuotaDriftResult(row: QuotaDriftResultRow): Promise<void> {
		await this.quotaDriftResults.insertResult(row);
	}

	/** The newest stored quota-drift payload, or null before the first pass. */
	async getLatestQuotaDriftResult(): Promise<QuotaDriftResultRow | null> {
		return this.quotaDriftResults.getLatest();
	}

	// ── Memory snapshot operations delegated to repository ─────────────────────

	async insertMemorySnapshot(row: MemorySnapshotRow): Promise<void> {
		await this.memorySnapshots.insert(row);
	}

	async getMemorySnapshots(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<MemoryHistoryPoint[]> {
		return this.memorySnapshots.getSnapshots(opts);
	}

	async deleteMemorySnapshotsOlderThan(cutoffMs: number): Promise<number> {
		return this.memorySnapshots.deleteOlderThan(cutoffMs);
	}

	// ── Cache-keepalive snapshot operations delegated to repository ────────────

	async insertCacheKeepaliveSnapshot(
		row: CacheKeepaliveSnapshotRow,
	): Promise<void> {
		await this.cacheKeepaliveSnapshots.insertSnapshot(row);
	}

	async getCacheKeepaliveSnapshots(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<CacheKeepaliveHistoryPoint[]> {
		return this.cacheKeepaliveSnapshots.getSnapshots(opts);
	}

	async deleteCacheKeepaliveSnapshotsOlderThan(
		cutoffMs: number,
	): Promise<number> {
		return this.cacheKeepaliveSnapshots.deleteOlderThan(cutoffMs);
	}

	/** Most-recent cache-keepalive snapshot (for seeding bridgeStats at boot), or null. */
	async getLatestCacheKeepaliveSnapshot(): Promise<CacheKeepaliveSnapshotRow | null> {
		return this.cacheKeepaliveSnapshots.getLatestSnapshot();
	}

	// ── Account payment (ledger) operations delegated to repository ───────────

	async recordAutoPayment(
		accountId: string,
		accountName: string,
		dueDate: string,
		amountUsdMicros: number,
		now: number = Date.now(),
	): Promise<boolean> {
		return this.accountPayments.recordAuto(
			accountId,
			accountName,
			dueDate,
			amountUsdMicros,
			now,
		);
	}

	async upsertSubscriptionPayment(
		accountId: string,
		accountName: string,
		paidDate: string,
		amountUsdMicros: number,
		source: PaymentSource,
		notes: string | null,
		now: number = Date.now(),
	): Promise<void> {
		await this.accountPayments.upsertSubscription(
			accountId,
			accountName,
			paidDate,
			amountUsdMicros,
			source,
			notes,
			now,
		);
	}

	async insertCreditPayment(
		accountId: string,
		accountName: string,
		paidDate: string,
		amountUsdMicros: number,
		source: PaymentSource,
		notes: string | null,
		importKey: string | null,
		now: number = Date.now(),
	): Promise<boolean> {
		return this.accountPayments.insertCredit(
			accountId,
			accountName,
			paidDate,
			amountUsdMicros,
			source,
			notes,
			importKey,
			now,
		);
	}

	async softDeletePayment(id: string): Promise<boolean> {
		return this.accountPayments.softDelete(id);
	}

	async getRecentPayments(limit: number): Promise<AccountPaymentRow[]> {
		return this.accountPayments.findRecent(limit);
	}

	async getPaymentsInRange(
		fromMs: number,
		toMs: number,
	): Promise<AccountPaymentRow[]> {
		return this.accountPayments.findInRange(fromMs, toMs);
	}

	async sumPaymentsByKindInRange(
		fromMs: number,
		toMs: number,
	): Promise<{ kind: string; total_micros: number }[]> {
		return this.accountPayments.sumByKindInRange(fromMs, toMs);
	}

	async sumPaymentsByAccountInRange(
		fromMs: number,
		toMs: number,
	): Promise<{ account_id: string; total_micros: number }[]> {
		return this.accountPayments.sumByAccountInRange(fromMs, toMs);
	}

	async latestSubscriptionPaymentDueDate(
		accountId: string,
	): Promise<string | null> {
		return this.accountPayments.latestSubscriptionDueDate(accountId);
	}

	// ── Codex reset-credit ledger operations delegated to repository ──────────

	async claimCodexResetCreditAutoAttempt(input: {
		accountId: string;
		accountName: string;
		creditId: string;
		creditExpiresAt: number | null;
		cause: "expiry" | "weekly-limit";
		now?: number;
	}): Promise<CodexResetCreditAutoClaim | null> {
		return this.codexResetCreditEvents.claimAutoAttempt({
			...input,
			now: input.now ?? Date.now(),
		});
	}

	async resolveCodexResetCreditAttempt(
		id: string,
		status: CodexResetCreditEventResolvedStatus,
		windowsReset: number | null,
		errorMessage: string | null,
		now: number = Date.now(),
	): Promise<void> {
		await this.codexResetCreditEvents.resolveAttempt(
			id,
			status,
			windowsReset,
			errorMessage,
			now,
		);
	}

	async recordManualCodexResetCreditEvent(input: {
		accountId: string;
		accountName: string;
		creditId: string | null;
		idempotencyKey: string;
		status: CodexResetCreditEventResolvedStatus;
		windowsReset: number | null;
		errorMessage: string | null;
		now?: number;
	}): Promise<void> {
		await this.codexResetCreditEvents.recordManual({
			...input,
			now: input.now ?? Date.now(),
		});
	}

	async getTerminallyResolvedCodexResetCreditIds(
		accountId: string,
	): Promise<Set<string>> {
		return this.codexResetCreditEvents.getTerminallyResolvedCreditIds(
			accountId,
		);
	}

	async getCodexResetCreditAutoApplyCooldownAnchorAt(
		accountId: string,
	): Promise<number | null> {
		return this.codexResetCreditEvents.getLatestAutoApplyCooldownAnchorAt(
			accountId,
		);
	}

	async getRecentCodexResetCreditEvents(
		accountId: string,
		limit: number,
	): Promise<CodexResetCreditEventRow[]> {
		return this.codexResetCreditEvents.findRecentForAccount(accountId, limit);
	}

	// Model-catalogue curation. Every read is per dialect: `/wire/anthropic` and
	// `/wire/openai` are separate catalogues and their overrides never mix.

	async listModelOverrides(
		dialect: ModelOverrideDialect,
	): Promise<ModelOverrideRow[]> {
		return this.modelOverrides.listByDialect(dialect);
	}

	async upsertModelOverride(input: ModelOverrideUpsert): Promise<void> {
		await this.modelOverrides.upsert(input);
	}

	async removeModelOverride(
		dialect: ModelOverrideDialect,
		modelId: string,
	): Promise<boolean> {
		return this.modelOverrides.remove(dialect, modelId);
	}
}
