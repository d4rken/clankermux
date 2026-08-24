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
export {
	type AccountInsertAdapter,
	buildNameGuardedInsert,
	DuplicateAccountNameError,
	insertAccountUnique,
} from "./repositories/account-insert";
// Re-export repositories (these are constructed directly by the read-only
// dashboard worker against its own connection — stats, usage-history,
// memory-history and payments-summary all run there)
export { AccountPaymentRepository } from "./repositories/account-payment.repository";
export {
	AuthRepository,
	type AuthSessionRecord,
	type PasswordBinding,
	type StoredPasswordVerifier,
} from "./repositories/auth.repository";
export {
	type CacheKeepaliveHistoryPoint,
	CacheKeepaliveSnapshotRepository,
	type CacheKeepaliveSnapshotRow,
	type CacheKeepaliveWindowTotals,
	sumCounterDeltas,
} from "./repositories/cache-keepalive-snapshot.repository";
export {
	type CodexResetCreditAutoClaim,
	CodexResetCreditEventRepository,
	type CodexResetCreditEventResolvedStatus,
	type CodexResetCreditEventRow,
} from "./repositories/codex-reset-credit-event.repository";
export { MemorySnapshotRepository } from "./repositories/memory-snapshot.repository";
export {
	QuotaDriftResultRepository,
	type QuotaDriftResultRow,
} from "./repositories/quota-drift-result.repository";
export { StatsRepository } from "./repositories/stats.repository";
export { UsageScopedSnapshotRepository } from "./repositories/usage-scoped-snapshot.repository";
export { UsageSnapshotRepository } from "./repositories/usage-snapshot.repository";
// Re-export retry utilities for external use (from your improvements)
export { withDatabaseRetry } from "./retry";
export { isCorruptionError, isTransientLockError } from "./sqlite-error";
export { DatabaseOperations };
