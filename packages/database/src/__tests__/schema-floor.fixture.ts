/**
 * Frozen historical schema data for the migration-floor tests.
 *
 * ## What this is
 *
 * `runMigrations()` can only carry a database forward from the oldest schema we
 * declare support for. That declared floor is the schema a fresh install
 * produced from the newest `migrations.ts` available when the repository went
 * public on 2026-05-13 — commit `0e4ad752` (2026-05-04). Anyone who cloned
 * between those two dates has exactly that schema, and nothing older is
 * supported: databases predating the public repository, including upstream
 * better-ccflare / ccflare ones, were deliberately dropped by `35b993f0`.
 *
 * ## How it was produced
 *
 * `FLOOR_SCHEMA_SQL` is the sqlite_master DDL of a database built by checking
 * `0e4ad752` out into a throwaway worktree and executing THAT era's own
 * `ensureSchema()` + `runMigrations()` against an in-memory database — not by
 * reading its source. `POST_FLOOR_TABLE_BASELINES` records the column set each
 * post-floor table shipped with: `request_routing` (33bdc22e) and
 * `memory_snapshots` (6f9e707b) predate `35b993f0` and were measured the same
 * way, because their era still had imperative ALTERs; the rest are read from
 * the `CREATE TABLE` in their introducing commit, which is equivalent once no
 * imperative ALTERs remained.
 *
 * ## Do not regenerate
 *
 * This data records history. It is NOT derived from the current schema and must
 * never be refreshed from it — that would make the floor tests tautological
 * (asserting the current schema equals itself). The only legitimate edits are:
 * appending a baseline for a newly introduced table, appending to
 * `RETIRED_AFTER_FLOOR` when a column or table is deliberately dropped, and a
 * deliberate decision to raise the declared floor, which means re-measuring
 * `FLOOR_SCHEMA_SQL` against the new floor commit.
 */
import { Database } from "bun:sqlite";

/**
 * Executable DDL of a floor database: every table and index a 2026-05-04
 * install ended up with, including the two tables the current schema no longer
 * creates (agent_preferences, model_translations) and the columns it no longer
 * has (accounts.cross_region_mode, api_keys.role, requests.agent_used). Those
 * leftovers are retained on purpose — a real upgraded database still carries
 * them, so the tests prove migration tolerates them instead of assuming a
 * cleaned-up starting point.
 */
export const FLOOR_SCHEMA_SQL = `
CREATE TABLE accounts ( id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT DEFAULT 'anthropic', api_key TEXT, refresh_token TEXT, access_token TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, last_used INTEGER, request_count INTEGER DEFAULT 0, total_requests INTEGER DEFAULT 0, priority INTEGER DEFAULT 0 , rate_limited_until INTEGER, session_start INTEGER, session_request_count INTEGER DEFAULT 0, paused INTEGER DEFAULT 0, rate_limit_reset INTEGER, rate_limit_status TEXT, rate_limit_remaining INTEGER, auto_fallback_enabled INTEGER DEFAULT 0, custom_endpoint TEXT, auto_refresh_enabled INTEGER DEFAULT 0, model_mappings TEXT, cross_region_mode TEXT DEFAULT 'geographic', model_fallbacks TEXT, billing_type TEXT DEFAULT NULL, refresh_token_issued_at INTEGER, auto_pause_on_overage_enabled INTEGER DEFAULT 0, peak_hours_pause_enabled INTEGER NOT NULL DEFAULT 0, pause_reason TEXT, rate_limited_reason TEXT, rate_limited_at INTEGER);
CREATE TABLE agent_preferences ( agent_id TEXT PRIMARY KEY, model TEXT NOT NULL, updated_at INTEGER NOT NULL );
CREATE TABLE api_keys ( id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, hashed_key TEXT NOT NULL UNIQUE, prefix_last_8 TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER, usage_count INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1 , role TEXT NOT NULL DEFAULT 'api-only');
CREATE TABLE combo_family_assignments ( family TEXT PRIMARY KEY, combo_id TEXT, enabled INTEGER DEFAULT 0, FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE SET NULL );
CREATE TABLE combo_slots ( id TEXT PRIMARY KEY, combo_id TEXT NOT NULL, account_id TEXT NOT NULL, model TEXT NOT NULL, priority INTEGER NOT NULL, enabled INTEGER DEFAULT 1, FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE CASCADE, FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE );
CREATE TABLE combos ( id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, enabled INTEGER DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
CREATE TABLE model_translations ( id TEXT PRIMARY KEY, client_name TEXT NOT NULL, bedrock_model_id TEXT NOT NULL, is_default INTEGER DEFAULT 1, auto_discovered INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
CREATE TABLE oauth_sessions ( id TEXT PRIMARY KEY, account_name TEXT NOT NULL, verifier TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL , custom_endpoint TEXT);
CREATE TABLE request_payloads ( id TEXT PRIMARY KEY, json TEXT NOT NULL, timestamp INTEGER, FOREIGN KEY (id) REFERENCES requests(id) ON DELETE CASCADE );
CREATE TABLE requests ( id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, account_used TEXT, status_code INTEGER, success BOOLEAN, error_message TEXT, response_time_ms INTEGER, failover_attempts INTEGER DEFAULT 0, model TEXT, prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, output_tokens_per_second REAL, input_tokens INTEGER DEFAULT 0, cache_read_input_tokens INTEGER DEFAULT 0, cache_creation_input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, agent_used TEXT, project TEXT, billing_type TEXT DEFAULT 'api' , api_key_id TEXT, api_key_name TEXT, combo_name TEXT);
CREATE INDEX idx_accounts_name ON accounts(name);
CREATE INDEX idx_accounts_paused ON accounts(paused) WHERE paused = 0;
CREATE INDEX idx_accounts_priority ON accounts(priority ASC, request_count DESC, last_used);
CREATE INDEX idx_accounts_rate_limited ON accounts(rate_limited_until) WHERE rate_limited_until IS NOT NULL;
CREATE INDEX idx_accounts_request_count ON accounts(request_count DESC, last_used);
CREATE INDEX idx_accounts_session ON accounts(session_start, session_request_count) WHERE session_start IS NOT NULL;
CREATE INDEX idx_api_keys_active ON api_keys(is_active);
CREATE INDEX idx_api_keys_hashed_key ON api_keys(hashed_key);
CREATE INDEX idx_api_keys_role ON api_keys(role);
CREATE INDEX idx_combo_slots_combo_id ON combo_slots(combo_id, priority);
CREATE UNIQUE INDEX idx_combo_slots_unique ON combo_slots(combo_id, account_id, model);
CREATE INDEX idx_model_translations_client_name ON model_translations(client_name);
CREATE UNIQUE INDEX idx_model_translations_unique ON model_translations(client_name, bedrock_model_id);
CREATE INDEX idx_oauth_sessions_account_name ON oauth_sessions(account_name, expires_at);
CREATE INDEX idx_oauth_sessions_expires ON oauth_sessions(expires_at);
CREATE INDEX idx_request_payloads_cleanup ON request_payloads(timestamp, id) WHERE timestamp IS NOT NULL;
CREATE INDEX idx_request_payloads_timestamp ON request_payloads(timestamp);
CREATE INDEX idx_requests_account_timestamp ON requests(account_used, timestamp DESC);
CREATE INDEX idx_requests_account_used ON requests(account_used);
CREATE INDEX idx_requests_analytics_covering ON requests(timestamp, success, total_tokens, cost_usd, billing_type, output_tokens, input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens_per_second, response_time_ms, account_used, model);
CREATE INDEX idx_requests_api_key ON requests(api_key_id) WHERE api_key_id IS NOT NULL;
CREATE INDEX idx_requests_api_key_timestamp ON requests(api_key_id, timestamp DESC) WHERE api_key_id IS NOT NULL;
CREATE INDEX idx_requests_billing_type_timestamp ON requests(billing_type, timestamp DESC) WHERE billing_type IS NOT NULL;
CREATE INDEX idx_requests_cleanup ON requests(timestamp ASC, id);
CREATE INDEX idx_requests_cost_model ON requests(cost_usd, model, timestamp DESC) WHERE cost_usd > 0 AND model IS NOT NULL;
CREATE INDEX idx_requests_model_timestamp ON requests(model, timestamp DESC) WHERE model IS NOT NULL;
CREATE INDEX idx_requests_project_timestamp ON requests(project, timestamp DESC) WHERE project IS NOT NULL;
CREATE INDEX idx_requests_response_time ON requests(model, response_time_ms) WHERE response_time_ms IS NOT NULL AND model IS NOT NULL;
CREATE INDEX idx_requests_success_timestamp ON requests(success, timestamp DESC);
CREATE INDEX idx_requests_summary_covering ON requests(timestamp DESC, id, account_used, status_code, success, response_time_ms, model, total_tokens, cost_usd, input_tokens, output_tokens, billing_type, combo_name, failover_attempts);
CREATE INDEX idx_requests_timestamp ON requests(timestamp DESC);
CREATE INDEX idx_requests_timestamp_account ON requests(timestamp DESC, account_used);
CREATE INDEX idx_requests_tokens ON requests(timestamp DESC, total_tokens) WHERE total_tokens > 0;
`;

/** One post-floor table's first-shipped shape. */
export interface PostFloorTableBaseline {
	/** Date the table first shipped, for orientation only. */
	shipped: string;
	/** Commit that introduced the CREATE TABLE. */
	commit: string;
	/** The columns that CREATE TABLE produced — NOT the current column set. */
	columns: readonly string[];
	/**
	 * How the column list was obtained. "executed" = the introducing commit's
	 * own ensureSchema()/runMigrations() were run and the result introspected,
	 * which was required while imperative ALTERs still existed.
	 * "create-table-at-intro" = read from the CREATE TABLE, valid once nothing
	 * else could alter the table on the way in.
	 */
	source: "executed" | "create-table-at-intro";
}

/**
 * Per-table first-shipped column sets for the tables created AFTER the floor.
 * A floor database has none of these tables at all; it gains each one complete
 * from the current CREATE TABLE IF NOT EXISTS. The baseline matters for
 * databases created between a table's introduction and today, which is what
 * makes "baseline + ADDITIVE_COLUMNS == current schema" the invariant
 * schema-invariant.test.ts enforces.
 *
 * Add an entry here when you add a table.
 */
export const POST_FLOOR_TABLE_BASELINES: Readonly<
	Record<string, PostFloorTableBaseline>
> = {
	request_routing: {
		shipped: "2026-05-27",
		commit: "33bdc22e",
		columns: [
			"request_id",
			"strategy",
			"decision",
			"affinity_scope",
			"affinity_key_hash",
			"selected_account_id",
			"previous_account_id",
			"candidates_count",
			"failover_attempts",
			"failover_reason",
			"created_at",
		],
		source: "executed",
	},
	request_tool_calls: {
		shipped: "2026-06-10",
		commit: "3493369e",
		columns: ["request_id", "tool_name", "call_count", "error_count"],
		source: "create-table-at-intro",
	},
	request_tool_errors: {
		shipped: "2026-06-10",
		commit: "3493369e",
		columns: ["id", "request_id", "tool_name", "error_text"],
		source: "create-table-at-intro",
	},
	strategies: {
		shipped: "2026-05-28",
		commit: "acfb38dd",
		columns: ["name", "config", "updated_at"],
		source: "create-table-at-intro",
	},
	usage_snapshots: {
		shipped: "2026-06-02",
		commit: "4bf8be11",
		columns: [
			"account_id",
			"provider",
			"sampled_at",
			"five_hour_pct",
			"five_hour_reset",
			"seven_day_pct",
			"seven_day_reset",
		],
		source: "create-table-at-intro",
	},
	memory_snapshots: {
		shipped: "2026-06-03",
		commit: "6f9e707b",
		columns: ["sampled_at", "rss_bytes", "heap_used_bytes"],
		source: "executed",
	},
	usage_scoped_snapshots: {
		shipped: "2026-08-23",
		commit: "unreleased",
		columns: [
			"account_id",
			"sampled_at",
			"family",
			"display_name",
			"pct",
			"reset_at",
		],
		source: "create-table-at-intro",
	},
	quota_drift_results: {
		shipped: "2026-08-23",
		commit: "unreleased",
		columns: ["computed_at", "payload"],
		source: "create-table-at-intro",
	},
	cache_keepalive_snapshots: {
		shipped: "2026-06-18",
		commit: "b0873329",
		columns: [
			"sampled_at",
			"warm_sessions",
			"promoted_sessions",
			"total_bytes",
			"keepalives_sent",
			"hits",
			"misses",
			"failures",
			"spent_usd",
			"saved_usd",
		],
		source: "create-table-at-intro",
	},
	account_payments: {
		shipped: "2026-06-10",
		commit: "db75cb26",
		columns: [
			"id",
			"account_id",
			"account_name",
			"kind",
			"paid_date",
			"paid_at_ms",
			"amount_usd_micros",
			"recorded_at",
			"source",
			"import_key",
			"notes",
			"deleted_at",
		],
		source: "create-table-at-intro",
	},
	codex_reset_credit_events: {
		shipped: "2026-07-20",
		commit: "372eab98",
		columns: [
			"id",
			"account_id",
			"account_name",
			"credit_id",
			"trigger",
			"attempt_seq",
			"idempotency_key",
			"status",
			"windows_reset",
			"error_message",
			"credit_expires_at",
			"created_at",
			"resolved_at",
		],
		source: "create-table-at-intro",
	},
};

/**
 * Schema elements deliberately dropped after the floor. Each entry is a
 * decision, not an accident: the tests assert every one of these still exists
 * in its baseline (so the list cannot silently rot) and is absent from the
 * current schema (so a re-added artifact is noticed).
 *
 * cross_region_mode and model_translations went with Bedrock support;
 * api_keys.role went when the dashboard API stopped distinguishing admin from
 * api-only keys; requests.agent_used and agent_preferences went with per-agent
 * model preferences.
 */
export const RETIRED_AFTER_FLOOR = {
	columns: [
		{ table: "accounts", column: "cross_region_mode" },
		{ table: "api_keys", column: "role" },
		{ table: "requests", column: "agent_used" },
	],
	tables: ["agent_preferences", "model_translations"],
} as const;

/**
 * Build an in-memory database with the exact floor schema — historical indexes
 * and inert leftover tables included. The caller owns closing it.
 */
export function createFloorDatabase(): Database {
	const db = new Database(":memory:");
	db.exec(FLOOR_SCHEMA_SQL);
	return db;
}
