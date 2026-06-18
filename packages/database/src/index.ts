// Re-export the DatabaseOperations class
import { DatabaseOperations } from "./database-operations";

export type { RuntimeConfig } from "@clankermux/config";
export { BunSqlAdapter } from "./adapters/bun-sql-adapter";
// Re-export other utilities
export { AsyncDbWriter } from "./async-writer";
export type {
	DatabaseConfig,
	DatabaseRetryConfig,
	RetentionStorageUsage,
} from "./database-operations";
export { DatabaseFactory } from "./factory";
export type { IntegrityCheckKind } from "./integrity-check-runner";
export { runIntegrityCheckInWorker } from "./integrity-check-runner";
export { ensureSchema, runMigrations } from "./migrations";
export { resolveDbPath } from "./paths";
// Public encryption API — only init/status helpers are exported.
// `encryptPayload`/`decryptPayload` are internal to the database package.
export {
	initPayloadEncryption,
	isEncryptionEnabled,
} from "./payload-encryption";
export { analyzeIndexUsage } from "./performance-indexes";
export { AccountRepository } from "./repositories/account.repository";
// Re-export repositories (these are constructed directly by the read-only
// dashboard worker against its own connection — stats, usage-history,
// memory-history and payments-summary all run there)
export { AccountPaymentRepository } from "./repositories/account-payment.repository";
export {
	type CacheKeepaliveHistoryPoint,
	CacheKeepaliveSnapshotRepository,
	type CacheKeepaliveSnapshotRow,
} from "./repositories/cache-keepalive-snapshot.repository";
export { MemorySnapshotRepository } from "./repositories/memory-snapshot.repository";
export { StatsRepository } from "./repositories/stats.repository";
export { UsageSnapshotRepository } from "./repositories/usage-snapshot.repository";
// Re-export retry utilities for external use (from your improvements)
export { withDatabaseRetry } from "./retry";
export { DatabaseOperations };
