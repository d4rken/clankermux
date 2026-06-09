import type { Database } from "bun:sqlite";
import { Logger } from "@clankermux/logger";
import { addPerformanceIndexes } from "./performance-indexes";

const log = new Logger("DatabaseMigrations");

export function ensureSchema(db: Database): void {
	// Apply auto_vacuum = INCREMENTAL before any tables exist so fresh DBs are
	// born in incremental-vacuum mode. SQLite stores this in the DB header and
	// the mode can only change when no tables exist OR by a full VACUUM — once
	// committed, the periodic `PRAGMA incremental_vacuum(N)` worker can reclaim
	// free pages a chunk at a time without ever needing a multi-minute
	// blocking VACUUM. Existing DBs upgraded from auto_vacuum=NONE (mode 0)
	// take the one-shot migration VACUUM at server startup; this PRAGMA is a
	// no-op for them until that migration runs (see bootstrapAutoVacuum in
	// apps/server/src/server.ts).
	//
	// Gated on current mode === 0 to preserve `auto_vacuum=FULL` (mode 1) as
	// an explicit operator choice — SQLite quietly allows mode 1 → mode 2
	// transitions without VACUUM, and issuing the PRAGMA unconditionally
	// would silently rewrite that policy. (Greptile #230)
	const currentAutoVacuum = (
		db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
	).auto_vacuum;
	if (currentAutoVacuum === 0) {
		db.exec("PRAGMA auto_vacuum = INCREMENTAL");
	}

	// Create accounts table (full current schema)
	db.run(`
		CREATE TABLE IF NOT EXISTS accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT,
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			priority INTEGER DEFAULT 0,
			rate_limited_until INTEGER,
			session_start INTEGER,
			session_request_count INTEGER DEFAULT 0,
			paused INTEGER DEFAULT 0,
			rate_limit_reset INTEGER,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER,
			auto_fallback_enabled INTEGER DEFAULT 0,
			custom_endpoint TEXT,
			auto_refresh_enabled INTEGER DEFAULT 0,
			model_mappings TEXT,
			model_fallbacks TEXT,
			billing_type TEXT DEFAULT NULL,
			refresh_token_issued_at INTEGER,
			auto_pause_on_overage_enabled INTEGER DEFAULT 0,
			peak_hours_pause_enabled INTEGER NOT NULL DEFAULT 0,
			pause_reason TEXT,
			rate_limited_reason TEXT,
			rate_limited_at INTEGER,
			consecutive_rate_limits INTEGER NOT NULL DEFAULT 0,
			renewal_anchor TEXT,
			renewal_cadence TEXT,
			notes TEXT
		)
	`);

	// Create requests table (full current schema)
	db.run(`
		CREATE TABLE IF NOT EXISTS requests (
			id TEXT PRIMARY KEY,
			timestamp INTEGER NOT NULL,
			method TEXT NOT NULL,
			path TEXT NOT NULL,
			account_used TEXT,
			status_code INTEGER,
			success BOOLEAN,
			error_message TEXT,
			response_time_ms INTEGER,
			failover_attempts INTEGER DEFAULT 0,
			model TEXT,
			prompt_tokens INTEGER DEFAULT 0,
			completion_tokens INTEGER DEFAULT 0,
			total_tokens INTEGER DEFAULT 0,
			cost_usd REAL DEFAULT 0,
			output_tokens_per_second REAL,
			input_tokens INTEGER DEFAULT 0,
			cache_read_input_tokens INTEGER DEFAULT 0,
			cache_creation_input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			project TEXT,
			billing_type TEXT DEFAULT 'api',
			api_key_id TEXT,
			api_key_name TEXT,
			combo_name TEXT
		)
	`);

	// Create indexes for faster queries
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC)`,
	);

	// Index for JOIN performance with accounts table
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_requests_account_used ON requests(account_used)`,
	);

	// Composite index for the main requests query (timestamp DESC with account_used for JOIN)
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_requests_timestamp_account ON requests(timestamp DESC, account_used)`,
	);

	// Create request_routing table for load-balancer decision telemetry.
	db.run(`
		CREATE TABLE IF NOT EXISTS request_routing (
			request_id TEXT PRIMARY KEY,
			strategy TEXT NOT NULL,
			decision TEXT NOT NULL,
			affinity_scope TEXT,
			affinity_key_hash TEXT,
			selected_account_id TEXT,
			previous_account_id TEXT,
			candidates_count INTEGER,
			failover_attempts INTEGER DEFAULT 0,
			failover_reason TEXT,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
		)
	`);

	db.run(
		`CREATE INDEX IF NOT EXISTS idx_request_routing_decision ON request_routing(decision, created_at DESC)`,
	);

	db.run(
		`CREATE INDEX IF NOT EXISTS idx_request_routing_affinity ON request_routing(affinity_key_hash, created_at DESC) WHERE affinity_key_hash IS NOT NULL`,
	);

	// Create strategies table for persisted operational metadata.
	db.run(`
		CREATE TABLE IF NOT EXISTS strategies (
			name TEXT PRIMARY KEY,
			config TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	// Create request_payloads table for storing full request/response data
	db.run(`
		CREATE TABLE IF NOT EXISTS request_payloads (
			id TEXT PRIMARY KEY,
			json TEXT NOT NULL,
			timestamp INTEGER,
			FOREIGN KEY (id) REFERENCES requests(id) ON DELETE CASCADE
		)
	`);

	// Index for efficient age-based payload cleanup
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_request_payloads_timestamp ON request_payloads(timestamp)`,
	);

	// Create oauth_sessions table for secure PKCE verifier storage
	db.run(`
		CREATE TABLE IF NOT EXISTS oauth_sessions (
			id TEXT PRIMARY KEY,
			account_name TEXT NOT NULL,
			verifier TEXT NOT NULL,
			mode TEXT NOT NULL,
			custom_endpoint TEXT,
			priority INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`);

	// Create index for faster cleanup of expired sessions
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires ON oauth_sessions(expires_at)`,
	);

	// Create api_keys table for optional API authentication
	db.run(`
		CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			hashed_key TEXT NOT NULL UNIQUE,
			prefix_last_8 TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			usage_count INTEGER DEFAULT 0,
			is_active INTEGER DEFAULT 1,
			pinned_account_id TEXT,
			pinned_providers TEXT
		)
	`);

	// Create index for faster API key lookups
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_api_keys_hashed_key ON api_keys(hashed_key)`,
	);

	// Create index for active API keys
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active)`,
	);

	// Create combos table
	db.run(`
		CREATE TABLE IF NOT EXISTS combos (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			description TEXT,
			enabled INTEGER DEFAULT 1,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	// Create combo_slots table
	// account_id CASCADE: deleting an account removes its slots (REQ-17)
	// combo_id CASCADE: deleting a combo removes all its slots (REQ-18)
	db.run(`
		CREATE TABLE IF NOT EXISTS combo_slots (
			id TEXT PRIMARY KEY,
			combo_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			model TEXT NOT NULL,
			priority INTEGER NOT NULL,
			enabled INTEGER DEFAULT 1,
			FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE CASCADE,
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)
	`);

	// Index for fast slot lookups by combo, ordered by priority
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_combo_slots_combo_id ON combo_slots(combo_id, priority)`,
	);

	// Unique constraint to prevent duplicate (combo_id, account_id, model) slots
	db.run(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_combo_slots_unique ON combo_slots(combo_id, account_id, model)`,
	);

	// Create combo_family_assignments table
	// combo_id SET NULL: deleting a combo clears the family assignment without error
	db.run(`
		CREATE TABLE IF NOT EXISTS combo_family_assignments (
			family TEXT PRIMARY KEY,
			combo_id TEXT,
			enabled INTEGER DEFAULT 0,
			FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE SET NULL
		)
	`);

	// Seed the canonical families so fresh installs have assignment rows.
	// Re-runs on every startup (ensureSchema), so existing DBs gain new rows too.
	db.run(`
		INSERT OR IGNORE INTO combo_family_assignments (family, combo_id, enabled)
		VALUES ('opus',   NULL, 0),
		       ('sonnet', NULL, 0),
		       ('haiku',  NULL, 0),
		       ('fable',  NULL, 0);
	`);

	// Create usage_snapshots table — append-only time-series of per-account
	// rate-limit utilization. Backs the dashboard "sawtooth" graph.
	// account_id CASCADE: deleting an account removes its history.
	db.run(`
		CREATE TABLE IF NOT EXISTS usage_snapshots (
			account_id TEXT NOT NULL,
			provider TEXT,
			sampled_at INTEGER NOT NULL,
			five_hour_pct REAL,
			five_hour_reset INTEGER,
			seven_day_pct REAL,
			seven_day_reset INTEGER,
			PRIMARY KEY (account_id, sampled_at),
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)
	`);

	// Index on sampled_at for retention pruning; (account_id, sampled_at)
	// lookups are served by the primary key.
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_usage_snapshots_sampled_at ON usage_snapshots(sampled_at)`,
	);

	// Create memory_snapshots table — append-only time-series of the proxy
	// process's own memory footprint (RSS + JS heap), backing the dashboard
	// "Memory Usage" graph. One row per sample tick (no account dimension);
	// sampled_at is the INTEGER PRIMARY KEY (rowid alias) so range scans and
	// retention pruning are served without a secondary index.
	db.run(`
		CREATE TABLE IF NOT EXISTS memory_snapshots (
			sampled_at INTEGER PRIMARY KEY,
			rss_bytes INTEGER NOT NULL,
			heap_used_bytes INTEGER NOT NULL,
			heap_total_bytes INTEGER
		)
	`);

	// Performance indexes (covering/partial indexes for hot query paths)
	addPerformanceIndexes(db);
}

/**
 * Forward schema migrations for the live DB. ensureSchema() builds the full
 * current schema for fresh installs; this applies any columns added AFTER a
 * DB was created. To introduce a new column: add it to the CREATE TABLE in
 * ensureSchema() AND append one entry here.
 *
 * Additive ALTER TABLE ADD COLUMN only — no destructive rebuilds, data
 * backfills, or renames. (Those were one-time legacy upgrades, now removed.)
 */
const ADDITIVE_COLUMNS: ReadonlyArray<{
	table: string; // e.g. "accounts"
	column: string; // e.g. "my_field"
	ddl: string; // full statement, e.g. "ALTER TABLE accounts ADD COLUMN my_field TEXT"
}> = [
	// Empty: ensureSchema currently defines every column. Append future columns here, e.g.:
	// { table: "accounts", column: "my_field", ddl: "ALTER TABLE accounts ADD COLUMN my_field TEXT" },
];

export function runMigrations(db: Database): void {
	// Ensure base schema exists first (creates tables on a fresh DB).
	ensureSchema(db);

	if (ADDITIVE_COLUMNS.length === 0) return;

	const tx = db.transaction(() => {
		const cache = new Map<string, Set<string>>();
		const cols = (table: string): Set<string> => {
			let s = cache.get(table);
			if (!s) {
				s = new Set(
					(
						db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
							name: string;
						}>
					).map((c) => c.name),
				);
				cache.set(table, s);
			}
			return s;
		};
		for (const { table, column, ddl } of ADDITIVE_COLUMNS) {
			if (!cols(table).has(column)) {
				db.prepare(ddl).run();
				cols(table).add(column);
				log.info(`Added column ${table}.${column}`);
			}
		}
	});
	tx();
}
