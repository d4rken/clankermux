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
export { UNIFIED_CLAIM_OBSERVATION_RETENTION_MS } from "./database-operations";
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
export {
	type AccountPauseMarker,
	AccountRepository,
	type ProviderRenewalAnchorSync,
} from "./repositories/account.repository";
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
	ANTHROPIC_BANKED_RESET_REARM_MS,
	type AnthropicBankedResetAutoClaim,
	AnthropicBankedResetEventRepository,
	type AnthropicBankedResetEventResolvedStatus,
	type AnthropicBankedResetEventRow,
	type AnthropicBankedResetManualBegin,
	type AnthropicBankedResetResolution,
} from "./repositories/anthropic-banked-reset-event.repository";
export type { AnthropicUsageReadRow } from "./repositories/anthropic-usage-read.repository";
export { ApiKeyRepository } from "./repositories/api-key.repository";
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
	ClientRepository,
	MARKER as CLIENT_CATALOGUE_BACKFILL_MARKER,
} from "./repositories/client.repository";
export {
	type CodexResetCreditAutoClaim,
	CodexResetCreditEventRepository,
	type CodexResetCreditEventResolvedStatus,
	type CodexResetCreditEventRow,
} from "./repositories/codex-reset-credit-event.repository";
export { MemorySnapshotRepository } from "./repositories/memory-snapshot.repository";
export {
	ModelAliasConflictError,
	ModelAliasRepository,
} from "./repositories/model-alias.repository";
export {
	type ModelOverrideDialect,
	ModelOverrideRepository,
	type ModelOverrideRow,
} from "./repositories/model-override.repository";
export {
	QuotaDriftResultRepository,
	type QuotaDriftResultRow,
} from "./repositories/quota-drift-result.repository";
export {
	type ClientRequestRow,
	RequestRepository,
} from "./repositories/request.repository";
export {
	buildRequestFilterConditions,
	EMPTY_REQUEST_FILTERS,
	hasRequestFilters,
	type RequestFilterStatus,
	type RequestFilters,
} from "./repositories/request-filters";
export {
	isClientInputError,
	RoutingConflictError,
	RoutingRepository,
} from "./repositories/routing.repository";
export { SdkBridgeTurnRepository } from "./repositories/sdk-bridge-turn.repository";
export { StatsRepository } from "./repositories/stats.repository";
export { UsageScopedSnapshotRepository } from "./repositories/usage-scoped-snapshot.repository";
export { UsageSnapshotRepository } from "./repositories/usage-snapshot.repository";
// Re-export retry utilities for external use (from your improvements)
export { withDatabaseRetry } from "./retry";
export { isCorruptionError, isTransientLockError } from "./sqlite-error";
export { DatabaseOperations };
