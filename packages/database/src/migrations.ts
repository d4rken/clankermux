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
			auto_pause_on_overage_enabled INTEGER DEFAULT 1,
			peak_hours_pause_enabled INTEGER NOT NULL DEFAULT 0,
			codex_auto_apply_reset_credits_enabled INTEGER NOT NULL DEFAULT 0,
			codex_auto_apply_reset_on_weekly_limit_enabled INTEGER NOT NULL DEFAULT 0,
			pause_reason TEXT,
			rate_limited_reason TEXT,
			rate_limited_at INTEGER,
			consecutive_rate_limits INTEGER NOT NULL DEFAULT 0,
			renewal_anchor TEXT,
			renewal_cadence TEXT,
			renewal_price_usd_micros INTEGER,
			renewal_auto_start_date TEXT,
			notes TEXT,
			identity_external_id TEXT,
			identity_email TEXT,
			identity_organization_name TEXT,
			identity_plan_tier TEXT,
			identity_rate_limit_tier TEXT,
			identity_captured_at INTEGER,
			identity_profile_fetched_at INTEGER,
			codex_usage_json TEXT,
			codex_usage_observed_at INTEGER,
			refresh_token_expires_at INTEGER
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
			requested_model TEXT,
			prompt_tokens INTEGER DEFAULT 0,
			completion_tokens INTEGER DEFAULT 0,
			total_tokens INTEGER DEFAULT 0,
			cost_usd REAL DEFAULT 0,
			output_tokens_per_second REAL,
			output_tokens_per_second_approx INTEGER,
			input_tokens INTEGER DEFAULT 0,
			cache_read_input_tokens INTEGER DEFAULT 0,
			cache_creation_input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			project TEXT,
			-- Which attribution tier produced the project column
			-- (ProjectAttributionSource). NULL = the row predates this column, or
			-- the request was never eligible for project attribution at all.
			project_attribution_source TEXT,
			billing_type TEXT DEFAULT 'api',
			api_key_id TEXT,
			api_key_name TEXT,
			combo_name TEXT,
			reasoning_effort TEXT,
			context_system_chars INTEGER,
			context_tools_chars INTEGER,
			context_tool_count INTEGER,
			context_messages_chars INTEGER,
			context_message_count INTEGER,
			context_tool_result_chars INTEGER,
			context_largest_tool_chars INTEGER,
			context_largest_tool_name TEXT,
			context_binary_chars INTEGER,
			-- When a persistable token vector first became known, ms epoch. The
			-- row's own timestamp column is written at PERSISTENCE time (after the
			-- async writer drains), so it lags the moment the usage was actually
			-- true by the response duration plus queue depth. NULL = no usable
			-- usage ever arrived (waived, or a summary carrying no model).
			usage_finalized_at INTEGER
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

	// Create request_tool_calls table for per-request tool-call analytics
	// (one row per distinct tool used in the request's final message).
	db.run(`
		CREATE TABLE IF NOT EXISTS request_tool_calls (
			request_id TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			call_count INTEGER NOT NULL DEFAULT 1,
			error_count INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (request_id, tool_name),
			FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
		)
	`);

	// Create request_tool_errors table for truncated per-tool error samples.
	db.run(`
		CREATE TABLE IF NOT EXISTS request_tool_errors (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			request_id TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			error_text TEXT,
			FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
		)
	`);

	db.run(
		`CREATE INDEX IF NOT EXISTS idx_request_tool_errors_request_id ON request_tool_errors(request_id)`,
	);

	// Create strategies table for persisted operational metadata.
	db.run(`
		CREATE TABLE IF NOT EXISTS strategies (
			name TEXT PRIMARY KEY,
			config TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	// Create request_payloads table for storing full request/response data.
	// `bytes` is the stored payload's UTF-8 length, recorded at write time so the
	// byte-budget cleanup pass can sum sizes from an index instead of scanning
	// the blobs (SUM(LENGTH(json)) measured 1.29 s per GiB — unusable per tick).
	db.run(`
		CREATE TABLE IF NOT EXISTS request_payloads (
			id TEXT PRIMARY KEY,
			json TEXT NOT NULL,
			timestamp INTEGER,
			bytes INTEGER,
			FOREIGN KEY (id) REFERENCES requests(id) ON DELETE CASCADE
		)
	`);

	// Index for efficient age-based payload cleanup
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_request_payloads_timestamp ON request_payloads(timestamp)`,
	);

	// The payload-size covering index. Column order matters: `timestamp` first
	// serves both the ORDER BY timestamp DESC running-sum and the cutoff delete;
	// including `bytes` makes the window query index-only (SUM over an integer
	// column scales with row count, not with the multi-MB blobs).
	//
	// Unconditional, and safe on an upgraded DB: runMigrations() applies
	// ADDITIVE_COLUMNS BEFORE ensureSchema(), so `bytes` exists by the time this
	// runs. It used to be guarded and deferred to a post-transaction call
	// because the order was the other way round.
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_request_payloads_size
		   ON request_payloads(timestamp, bytes)`,
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
			observed_at INTEGER,
			plan_tier TEXT,
			rate_limit_tier TEXT,
			PRIMARY KEY (account_id, sampled_at),
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)
	`);

	// Index on sampled_at for retention pruning; (account_id, sampled_at)
	// lookups are served by the primary key.
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_usage_snapshots_sampled_at ON usage_snapshots(sampled_at)`,
	);

	// Create usage_scoped_snapshots table — append-only time-series of the
	// PER-MODEL-FAMILY weekly windows Anthropic reports in its generic `limits[]`
	// array (`kind: "weekly_scoped"`). A different axis from usage_snapshots,
	// which records the account-wide 5h/7d windows only; a family can be spent
	// while the account-wide weekly window still has headroom, and that is
	// invisible in the account-wide series.
	//
	// `family` is the ROUTING family (opus/sonnet/haiku/fable) resolved by
	// getModelFamily(). `display_name` is stored alongside it because that
	// resolution is lossy in exactly the dimension a quota-drift analysis cares
	// about: "Claude Opus 4.8" and "Claude Opus 5" both map to `opus`. If a
	// provider ever scopes a weekly window per generation, the family column
	// alone could not tell them apart, and history cannot be backfilled.
	//
	// display_name is therefore part of the KEY, and NOT NULL. Keyed on
	// (account, tick, family) alone, one response carrying scoped limits for two
	// generations of one family would insert the first row and then overwrite it
	// with the second, losing a whole scoped series irrecoverably — the exact
	// loss the column exists to prevent.
	//
	// account_id CASCADE: deleting an account removes its history.
	db.run(`
		CREATE TABLE IF NOT EXISTS usage_scoped_snapshots (
			account_id TEXT NOT NULL,
			sampled_at INTEGER NOT NULL,
			family TEXT NOT NULL,
			display_name TEXT NOT NULL,
			pct REAL,
			reset_at INTEGER,
			PRIMARY KEY (account_id, sampled_at, family, display_name),
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)
	`);

	// Index on sampled_at for retention pruning; (account_id, sampled_at, family,
	// display_name) lookups are served by the primary key.
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_usage_scoped_snapshots_sampled_at ON usage_scoped_snapshots(sampled_at)`,
	);

	// Create unified_claim_observations table — the REQUEST-ALIGNED time-series
	// of Anthropic's per-claim rate-limit readings
	// (`anthropic-ratelimit-unified-<claim>-utilization`), one row per claim per
	// response. A third axis beside the two snapshot tables: those are sampled on
	// the poller's own cadence (~120 s) and record what the usage endpoint says,
	// while this records what the request itself was told, at the moment it was
	// told, including the responses the sampler never sees.
	//
	// utilization is nullable and NULL means NO READING — a reported utilization
	// of 0 is stored as 0. Same for reset_at, which is NULL when the claim's
	// `-reset` line is absent or does not parse to an epoch-ms instant.
	//
	// `request_started_at` is stored beside `observed_at` because neither
	// substitutes for the other: `observed_at` is headers-arrival time, and the
	// `requests` row's own timestamp is written at PERSISTENCE time (after the
	// stream finishes), so a series joined on it would be skewed by the response
	// duration.
	//
	// Deliberately NO foreign key to requests(id): internal traffic (cache
	// keepalive replays, auto-refresh probes) consumes real quota and must be
	// captured, but is deliberately absent from Request History, so those rows
	// have no parent to point at. The two also have independent retention (see
	// UNIFIED_CLAIM_OBSERVATION_RETENTION_MS), which a cascade would couple.
	//
	// account_id CASCADE mirrors the snapshot tables: deleting an account removes
	// its history.
	db.run(
		`
		CREATE TABLE IF NOT EXISTS unified_claim_observations (
			request_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			source TEXT NOT NULL,
			request_started_at INTEGER NOT NULL,
			observed_at INTEGER NOT NULL,
			http_status INTEGER NOT NULL,
			claim TEXT NOT NULL,
			status TEXT NOT NULL,
			utilization REAL,
			reset_at INTEGER,
			-- The claim's own surpassed-threshold line: the utilization band the
			-- provider says the claim has crossed. Recorded, never interpreted —
			-- NULL means no reading, 0 is a reading.
			surpassed_threshold REAL,
			PRIMARY KEY (request_id, claim),
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)
	`,
	);

	// Per-account series reads; the bare observed_at index serves retention
	// pruning, which scans the whole table by time regardless of account.
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_unified_claim_obs_account_time ON unified_claim_observations(account_id, observed_at)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_unified_claim_obs_observed_at ON unified_claim_observations(observed_at)`,
	);

	// Create unified_summary_observations table — the SUMMARY-level sibling of
	// unified_claim_observations. One row per Anthropic response that carried any
	// summary-level unified field, keyed by the request that received it.
	//
	// Not derivable from the claim rows: a per-IP burst 429 carries a bare
	// `retry-after` and no claim lines at all, and the summary's status/reset
	// describe whichever claim the provider chose to REPRESENT the account by —
	// the exact field the 2026-08-02 scoped-rejection incidents turned on.
	//
	// Every column past the identity block is nullable and NULL means the header
	// was absent (or did not parse). `remaining` and `retry_after` are stored
	// VERBATIM as text: their units are not documented, and a number here would
	// be a guess baked into the series forever.
	//
	// Deliberately NO foreign key to requests(id), and account_id CASCADE — same
	// reasoning as unified_claim_observations.
	db.run(`
		CREATE TABLE IF NOT EXISTS unified_summary_observations (
			request_id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			source TEXT NOT NULL,
			http_status INTEGER NOT NULL,
			request_started_at INTEGER NOT NULL,
			observed_at INTEGER NOT NULL,
			status TEXT,
			reset_at INTEGER,
			remaining TEXT,
			representative_claim TEXT,
			fallback TEXT,
			fallback_percentage REAL,
			overage_status TEXT,
			overage_disabled_reason TEXT,
			retry_after TEXT,
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)
	`);

	db.run(
		`CREATE INDEX IF NOT EXISTS idx_unified_summary_obs_account_time ON unified_summary_observations(account_id, observed_at)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_unified_summary_obs_observed_at ON unified_summary_observations(observed_at)`,
	);

	// Create internal_dispatch_spend table — per-dispatch token vectors for the
	// proxy's OWN upstream traffic (cache-keepalive replays, auto-refresh probes).
	//
	// That traffic consumes real quota but is excluded from `requests` by
	// shouldRecordRequest, so the proxy's own burn is otherwise invisible to every
	// analysis built on the request series. `id` is the dispatch's request id —
	// the SAME id its unified_claim_observations rows carry — so a probe's spend
	// and the claim state its response reported join without a heuristic.
	//
	// Token columns are nullable: NULL = no reading (the response carried no
	// usage), while a reported 0 is stored as 0. account_id CASCADE mirrors the
	// observation tables.
	db.run(`
		CREATE TABLE IF NOT EXISTS internal_dispatch_spend (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			source TEXT NOT NULL,
			model TEXT,
			http_status INTEGER NOT NULL,
			started_at INTEGER NOT NULL,
			completed_at INTEGER,
			input_tokens INTEGER,
			output_tokens INTEGER,
			cache_read_input_tokens INTEGER,
			cache_creation_input_tokens INTEGER,
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)
	`);

	// Per-account series reads; the bare started_at index serves retention
	// pruning, which scans the whole table by time regardless of account.
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_internal_dispatch_spend_account_time ON internal_dispatch_spend(account_id, started_at)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_internal_dispatch_spend_started_at ON internal_dispatch_spend(started_at)`,
	);

	// Create account_tier_history table — the effective-dated record of each
	// account's plan tier and rate-limit tier.
	//
	// The accounts row only carries TODAY's value, so any analysis attributing
	// historical usage to a tier refiles the whole history under whatever the
	// account moved to most recently — and a tier change reads exactly like a
	// change in what the subscription buys, which is the one thing such an
	// analysis must be able to tell apart.
	//
	// Rows are appended on CHANGE only (an incoming null preserves the stored
	// tier and is therefore not a change) plus one `seed` row per account from
	// the one-shot backfill. NOT pruned: the series is one row per actual tier
	// change, and losing the early rows destroys exactly the comparison it exists
	// for. account_id CASCADE — the history dies with the account.
	db.run(`
		CREATE TABLE IF NOT EXISTS account_tier_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id TEXT NOT NULL,
			observed_at INTEGER NOT NULL,
			plan_tier TEXT,
			rate_limit_tier TEXT,
			source TEXT NOT NULL,
			app_version TEXT,
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)
	`);

	db.run(
		`CREATE INDEX IF NOT EXISTS idx_account_tier_history_account_time ON account_tier_history(account_id, observed_at)`,
	);

	// Create quota_drift_results table — the precomputed quota-drift analysis.
	// One row per completed precompute pass; the latest row wins and the cleanup
	// pass keeps only the most recent few.
	//
	// A cache, not a record: the fit is a pure function of `usage_snapshots` and
	// `requests`, so losing every row costs one scheduler tick and nothing else.
	// The whole payload is one JSON blob because nothing queries INTO it — the
	// endpoint hands it to the dashboard verbatim.
	db.run(`
		CREATE TABLE IF NOT EXISTS quota_drift_results (
			computed_at INTEGER PRIMARY KEY,
			payload TEXT NOT NULL
		)
	`);

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
			heap_total_bytes INTEGER,
			event_loop_max_lag_ms REAL
		)
	`);

	// Create cache_keepalive_snapshots table — append-only time-series of the
	// cache-keepalive feature's health, backing the dashboard analytics panel.
	// One row per sample tick (no account dimension); sampled_at is the INTEGER
	// PRIMARY KEY (rowid alias) so range scans and retention pruning are served
	// without a secondary index, exactly like memory_snapshots.
	//
	// Gauges (warm_sessions/promoted_sessions/total_bytes) are point-in-time;
	// the counters (keepalives_sent/hits/misses/failures/spent_usd/saved_usd) are
	// CUMULATIVE-since-process-restart values captured at sample time.
	db.run(`
		CREATE TABLE IF NOT EXISTS cache_keepalive_snapshots (
			sampled_at INTEGER PRIMARY KEY,
			warm_sessions INTEGER NOT NULL,
			promoted_sessions INTEGER NOT NULL,
			total_bytes INTEGER NOT NULL,
			keepalives_sent INTEGER NOT NULL,
			hits INTEGER NOT NULL,
			misses INTEGER NOT NULL,
			failures INTEGER NOT NULL,
			spent_usd REAL NOT NULL,
			saved_usd REAL NOT NULL,
			warm_resumes INTEGER NOT NULL DEFAULT 0,
			saved_usd_5m REAL NOT NULL DEFAULT 0
		)
	`);

	// Create account_payments table — the per-account payments ledger
	// (subscription renewals + ad-hoc usage-credit purchases) backing the
	// dashboard's real out-of-pocket cost view. Deliberately NO foreign key
	// on account_id: the ledger must survive account deletion (account_name
	// is denormalized for display after the account is gone). Rows are
	// soft-deleted via deleted_at; the partial UNIQUE index on
	// (account_id, paid_date) for kind='subscription' covers soft-deleted
	// rows too, so a tombstone suppresses the auto-recorder from re-inserting
	// the same due date (idempotency by design). The partial UNIQUE index on
	// import_key gives seed/backfill retries the same idempotency for credit
	// purchases.
	db.run(`
		CREATE TABLE IF NOT EXISTS account_payments (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			account_name TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('subscription','credits')),
			paid_date TEXT NOT NULL,
			paid_at_ms INTEGER NOT NULL,
			amount_usd_micros INTEGER NOT NULL CHECK (amount_usd_micros >= 0),
			recorded_at INTEGER NOT NULL,
			source TEXT NOT NULL CHECK (source IN ('auto','manual','backfill')),
			import_key TEXT,
			notes TEXT,
			deleted_at INTEGER
		)
	`);

	db.run(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_account_payments_subscription_due
			ON account_payments(account_id, paid_date) WHERE kind = 'subscription'`,
	);

	db.run(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_account_payments_import_key
			ON account_payments(import_key) WHERE import_key IS NOT NULL`,
	);

	db.run(
		`CREATE INDEX IF NOT EXISTS idx_account_payments_paid_at ON account_payments(paid_at_ms DESC)`,
	);

	db.run(
		`CREATE INDEX IF NOT EXISTS idx_account_payments_account ON account_payments(account_id, paid_at_ms DESC)`,
	);

	// Create codex_reset_credit_events table — durable ledger of Codex
	// usage-limit reset-credit consume attempts (manual button presses and the
	// opt-in auto-apply scheduler). Auto rows use a deterministic id
	// "{account_id}:{credit_id}:{attempt_seq}" so the idempotency key survives
	// crashes; manual rows use crypto.randomUUID(). created_at/resolved_at are
	// ms epoch; credit_expires_at is a unix-SECONDS snapshot of the credit's
	// expiry as reported by the backend. Deliberately NO foreign key on
	// account_id: the ledger must survive account deletion (account_name is
	// denormalized for display after the account is gone).
	db.run(`
		CREATE TABLE IF NOT EXISTS codex_reset_credit_events (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			account_name TEXT NOT NULL,
			credit_id TEXT,
			trigger TEXT NOT NULL CHECK (trigger IN ('manual','auto')),
			cause TEXT CHECK (cause IN ('expiry','weekly-limit')),
			attempt_seq INTEGER,
			idempotency_key TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending','reset','nothingToReset','noCredit','alreadyRedeemed','failed')),
			windows_reset INTEGER,
			error_message TEXT,
			credit_expires_at INTEGER,
			created_at INTEGER NOT NULL,
			resolved_at INTEGER
		)
	`);

	// One auto attempt row per (account, credit, seq) — INSERT OR IGNORE against
	// this index makes concurrent auto claims race-safe (the loser reuses the
	// winner's row and idempotency key).
	db.run(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_reset_credit_events_auto_attempt
			ON codex_reset_credit_events(account_id, credit_id, attempt_seq)
			WHERE trigger = 'auto' AND credit_id IS NOT NULL`,
	);

	db.run(
		`CREATE INDEX IF NOT EXISTS idx_codex_reset_credit_events_account
			ON codex_reset_credit_events(account_id, created_at DESC)`,
	);

	// Dashboard/management session auth.
	//
	// `auth_password` holds AT MOST ONE row — the CHECK on the primary key is
	// what enforces that, so "the password" cannot silently become a set of
	// passwords. `verifier` is a scrypt output over an operator-chosen secret;
	// `params` carries the versioned cost parameters that produced it, so the
	// cost can be raised later without invalidating verifiers written under the
	// old one. Absence of the row is the FAIL-OPEN state: no password
	// configured, management API ungated.
	db.run(`
		CREATE TABLE IF NOT EXISTS auth_password (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			verifier TEXT NOT NULL,
			params TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	// One row per live session cookie. `token_hash` is an unsalted SHA-256 of
	// the cookie value and is the PRIMARY KEY, so validating a session is ONE
	// indexed lookup and never a key-derivation — scrypt-per-request is exactly
	// what caused the ~300ms API-key stalls. Unsalted is safe here for the same
	// reason as api_keys.hashed_key: the token is 32 random bytes we minted, not
	// a secret a human chose.
	db.run(`
		CREATE TABLE IF NOT EXISTS auth_sessions (
			token_hash TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL
		)
	`);

	// Drives the startup + hourly expiry sweep.
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at)`,
	);

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
 * backfills, or renames. (Those were one-time legacy upgrades, now removed.
 * One-shot data backfills live in backfills.ts, outside migrations.)
 *
 * Entries are NEVER removed: an entry is the only thing that can carry a column
 * onto a database created before it existed, and the supported floor only ever
 * moves by a deliberate decision (see schema-floor.fixture.ts).
 *
 * Exported so schema-invariant.test.ts can assert that this list plus the
 * historical baselines reconstruct the current schema exactly.
 */
export const ADDITIVE_COLUMNS: ReadonlyArray<{
	table: string; // e.g. "accounts"
	column: string; // e.g. "my_field"
	ddl: string; // full statement, e.g. "ALTER TABLE accounts ADD COLUMN my_field TEXT"
}> = [
	// ---------------------------------------------------------------------
	// Restored 2026-08-23. These eight entries were deleted by 35b993f0
	// ("remove legacy DB migration code"), which emptied this array on the
	// premise that only two populations exist: this deployment (fully migrated)
	// and fresh installs (born complete). A third population was missed — the
	// repository went public on 2026-05-13, so anyone who cloned between then
	// and the refactor has a ClankerMux-created database that runMigrations()
	// could no longer bring forward.
	//
	// The supported floor is therefore the schema a fresh install produced from
	// the newest migrations.ts available when the repository went public
	// (0e4ad752, 2026-05-04), not the refactor's schema. The first seven columns
	// below are exactly the gap between that floor and the current schema; the
	// other 39 deleted columns need a database predating the public repository
	// (private pre-public ClankerMux, or upstream better-ccflare / ccflare) and
	// stay dropped, as the refactor intended.
	//
	// DDL is copied verbatim from 35b993f0^ — never re-derived from the
	// CREATE TABLE, whose types and defaults may have moved since.
	// ---------------------------------------------------------------------
	// Priority carried through the OAuth handshake so the account created on
	// callback lands at the priority the operator picked when starting it.
	// oauth.repository.ts INSERTs it by name, so a floor DB fails to add ANY
	// OAuth account without this.
	{
		table: "oauth_sessions",
		column: "priority",
		ddl: "ALTER TABLE oauth_sessions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
	},
	// Consecutive 429s observed for the account, used by the rate-limit
	// escalation logic. NOT NULL DEFAULT 0 — existing rows read 0, i.e. "no
	// streak recorded", which is also the value a successful request writes.
	{
		table: "accounts",
		column: "consecutive_rate_limits",
		ddl: "ALTER TABLE accounts ADD COLUMN consecutive_rate_limits INTEGER NOT NULL DEFAULT 0",
	},
	// Free-text per-account operator notes. NULL = no notes.
	{
		table: "accounts",
		column: "notes",
		ddl: "ALTER TABLE accounts ADD COLUMN notes TEXT",
	},
	// Manually-entered subscription renewal date (YYYY-MM-DD, local calendar).
	// NULL = renewal tracking off for the account.
	{
		table: "accounts",
		column: "renewal_anchor",
		ddl: "ALTER TABLE accounts ADD COLUMN renewal_anchor TEXT",
	},
	// Renewal recurrence ('monthly' | 'yearly' | 'none'); NULL when there is no
	// anchor to recur from.
	{
		table: "accounts",
		column: "renewal_cadence",
		ddl: "ALTER TABLE accounts ADD COLUMN renewal_cadence TEXT",
	},
	// Pins an API key to one backend account for routing (takes precedence over
	// pinned_providers). NULL = no constraint. Named in five SELECTs in
	// api-key.repository.ts, so a floor DB fails EVERY API-key lookup without it.
	{
		table: "api_keys",
		column: "pinned_account_id",
		ddl: "ALTER TABLE api_keys ADD COLUMN pinned_account_id TEXT",
	},
	// JSON array string of provider names an API key may route to, consulted
	// only when pinned_account_id is NULL. NULL = no constraint.
	{
		table: "api_keys",
		column: "pinned_providers",
		ddl: "ALTER TABLE api_keys ADD COLUMN pinned_providers TEXT",
	},
	// Committed JS heap at sample time; memory_snapshots first shipped with only
	// rss/heap_used. Defensive rather than reachable from the floor — the table
	// postdates it and the window in which a DB could be created without this
	// column was ten minutes on 2026-06-03 — but the entry costs nothing and
	// keeps the "every post-baseline column has an entry" invariant total
	// (see schema-invariant.test.ts), exactly like the
	// codex_reset_credit_events.cause entry below.
	{
		table: "memory_snapshots",
		column: "heap_total_bytes",
		ddl: "ALTER TABLE memory_snapshots ADD COLUMN heap_total_bytes INTEGER",
	},
	// ---------------------------------------------------------------------
	// 1 when output_tokens_per_second came from the implausible-streaming-window
	// → total-request-duration fallback (rendered "~N tok/s"), NULL otherwise.
	{
		table: "requests",
		column: "output_tokens_per_second_approx",
		ddl: "ALTER TABLE requests ADD COLUMN output_tokens_per_second_approx INTEGER",
	},
	// Peak event-loop lag (ms) observed during the sample interval, from the
	// event-loop monitor — persisted so main-thread stalls are visible
	// historically alongside the RSS series. NULL on rows that predate the
	// column or were written while the monitor wasn't running.
	{
		table: "memory_snapshots",
		column: "event_loop_max_lag_ms",
		ddl: "ALTER TABLE memory_snapshots ADD COLUMN event_loop_max_lag_ms REAL",
	},
	// Per-request reasoning effort: "thinking:<budget>"/"thinking" (Anthropic)
	// or the raw reasoning.effort string (OpenAI Responses), NULL when absent.
	{
		table: "requests",
		column: "reasoning_effort",
		ddl: "ALTER TABLE requests ADD COLUMN reasoning_effort TEXT",
	},
	// Model named at request ingress. Unlike `model` (provider-reported), this is
	// available for upstream errors and local synthetic rejections with no usage.
	{
		table: "requests",
		column: "requested_model",
		ddl: "ALTER TABLE requests ADD COLUMN requested_model TEXT",
	},
	// Ingest-time context composition: per-bucket character counts computed
	// from the parsed /v1/messages body. All nullable — NULL = "composition
	// not recorded" (old rows, parse failures, non-messages endpoints), while
	// 0 is a valid recorded value.
	{
		table: "requests",
		column: "context_system_chars",
		ddl: "ALTER TABLE requests ADD COLUMN context_system_chars INTEGER",
	},
	{
		table: "requests",
		column: "context_tools_chars",
		ddl: "ALTER TABLE requests ADD COLUMN context_tools_chars INTEGER",
	},
	{
		table: "requests",
		column: "context_tool_count",
		ddl: "ALTER TABLE requests ADD COLUMN context_tool_count INTEGER",
	},
	{
		table: "requests",
		column: "context_messages_chars",
		ddl: "ALTER TABLE requests ADD COLUMN context_messages_chars INTEGER",
	},
	{
		table: "requests",
		column: "context_message_count",
		ddl: "ALTER TABLE requests ADD COLUMN context_message_count INTEGER",
	},
	{
		table: "requests",
		column: "context_tool_result_chars",
		ddl: "ALTER TABLE requests ADD COLUMN context_tool_result_chars INTEGER",
	},
	{
		table: "requests",
		column: "context_largest_tool_chars",
		ddl: "ALTER TABLE requests ADD COLUMN context_largest_tool_chars INTEGER",
	},
	{
		table: "requests",
		column: "context_largest_tool_name",
		ddl: "ALTER TABLE requests ADD COLUMN context_largest_tool_name TEXT",
	},
	// Subscription price in USD micros (integer math; 1 USD = 1_000_000) for
	// the payments-ledger auto-recorder and dashboard display. NULL = no price
	// configured (auto-recording disabled for the account).
	{
		table: "accounts",
		column: "renewal_price_usd_micros",
		ddl: "ALTER TABLE accounts ADD COLUMN renewal_price_usd_micros INTEGER",
	},
	// Lower bound (YYYY-MM-DD, local calendar) for auto-recorded subscription
	// payments — due dates strictly before it are never auto-backfilled.
	{
		table: "accounts",
		column: "renewal_auto_start_date",
		ddl: "ALTER TABLE accounts ADD COLUMN renewal_auto_start_date TEXT",
	},
	// Cache-bridge: count of real warm resumes captured at sample time (CUMULATIVE,
	// like the other counters). Previously dropped from the snapshot, so the bridge's
	// headline ROI signal was lost on every restart; now persisted. DEFAULT 0 for old
	// rows (they predate the column — treated as "unknown", reads back as 0).
	{
		table: "cache_keepalive_snapshots",
		column: "warm_resumes",
		ddl: "ALTER TABLE cache_keepalive_snapshots ADD COLUMN warm_resumes INTEGER NOT NULL DEFAULT 0",
	},
	// Cache-bridge: honest (conservative) cumulative savings valued at the 5-minute
	// write rate — the no-bridge counterfactual — vs the optimistic saved_usd (1h
	// rate). DEFAULT 0 for old rows.
	{
		table: "cache_keepalive_snapshots",
		column: "saved_usd_5m",
		ddl: "ALTER TABLE cache_keepalive_snapshots ADD COLUMN saved_usd_5m REAL NOT NULL DEFAULT 0",
	},
	// Opt-in per-account toggle: automatically consume expiring Codex
	// usage-limit reset credits when the account is rate-limited. Default OFF
	// (no automation without explicit operator consent).
	{
		table: "accounts",
		column: "codex_auto_apply_reset_credits_enabled",
		ddl: "ALTER TABLE accounts ADD COLUMN codex_auto_apply_reset_credits_enabled INTEGER NOT NULL DEFAULT 0",
	},
	// Opt-in per-account toggle: automatically consume a Codex usage-limit
	// reset credit as soon as the account hits its weekly limit (instead of
	// waiting for the credit to be about to expire). Default OFF.
	{
		table: "accounts",
		column: "codex_auto_apply_reset_on_weekly_limit_enabled",
		ddl: "ALTER TABLE accounts ADD COLUMN codex_auto_apply_reset_on_weekly_limit_enabled INTEGER NOT NULL DEFAULT 0",
	},
	// Why an auto consume attempt was claimed ('expiry' | 'weekly-limit'); NULL
	// on manual rows. Defense-in-depth: the table and this column shipped
	// together, so no live DB should lack it — this entry insures partial-deploy
	// scenarios where the table was created from an older CREATE TABLE. (The
	// column CHECK travels with ALTER TABLE ADD COLUMN; existing rows read NULL,
	// which the CHECK accepts.)
	{
		table: "codex_reset_credit_events",
		column: "cause",
		ddl: "ALTER TABLE codex_reset_credit_events ADD COLUMN cause TEXT CHECK (cause IN ('expiry','weekly-limit'))",
	},
	// Account profile identity — captured from provider tokens/profile endpoints
	// so accounts can be labeled by their real upstream identity and duplicate
	// logins (same provider + external id/email) can be detected. All nullable;
	// NULL = identity not yet captured for this account.
	{
		table: "accounts",
		column: "identity_external_id",
		ddl: "ALTER TABLE accounts ADD COLUMN identity_external_id TEXT",
	},
	{
		table: "accounts",
		column: "identity_email",
		ddl: "ALTER TABLE accounts ADD COLUMN identity_email TEXT",
	},
	{
		table: "accounts",
		column: "identity_organization_name",
		ddl: "ALTER TABLE accounts ADD COLUMN identity_organization_name TEXT",
	},
	{
		table: "accounts",
		column: "identity_plan_tier",
		ddl: "ALTER TABLE accounts ADD COLUMN identity_plan_tier TEXT",
	},
	// Anthropic rate-limit multiplier token (e.g. "20x", "5x") captured from
	// organization.rate_limit_tier — a SEPARATE column from identity_plan_tier so
	// a token-refresh envelope that lacks it writes null → COALESCE preserves the
	// profile-captured value. NULL for Codex / uncaptured accounts.
	{
		table: "accounts",
		column: "identity_rate_limit_tier",
		ddl: "ALTER TABLE accounts ADD COLUMN identity_rate_limit_tier TEXT",
	},
	// ms-epoch of when the identity fields were last captured/updated.
	{
		table: "accounts",
		column: "identity_captured_at",
		ddl: "ALTER TABLE accounts ADD COLUMN identity_captured_at INTEGER",
	},
	// ms-epoch of the last successful profile-endpoint fetch (distinct from
	// identity_captured_at, which may be set from token claims without a fetch).
	{
		table: "accounts",
		column: "identity_profile_fetched_at",
		ddl: "ALTER TABLE accounts ADD COLUMN identity_profile_fetched_at INTEGER",
	},
	// Which attribution tier produced the row's `project` (see
	// ProjectAttributionSource): header / wd_primary / wd_plain / codex_cwd /
	// session_inherited / session_ambiguous / none. NULL means something
	// different from 'none': the row predates this column, or the request was
	// never eligible for project attribution. Deliberately NOT backfilled — a
	// guessed source would defeat the point of measuring attribution quality.
	{
		table: "requests",
		column: "project_attribution_source",
		ddl: "ALTER TABLE requests ADD COLUMN project_attribution_source TEXT",
	},
	// UTF-8 byte length of the stored payload, recorded at write time so the
	// byte-budget cleanup pass can sum sizes off an index. NULL on rows that
	// predate the column — deliberately NOT backfilled (policy forbids data
	// backfills in migrations, and the retention window repopulates it within one
	// window anyway). The size pass ignores NULL-bytes rows in BOTH its running
	// sum and its delete predicate, so a legacy row can neither be counted nor
	// evicted by it.
	{
		table: "request_payloads",
		column: "bytes",
		ddl: "ALTER TABLE request_payloads ADD COLUMN bytes INTEGER",
	},
	// Last Codex usage snapshot observed for the account (the normalized
	// UsageData JSON) plus its ms-epoch observation time. Written by the
	// observation bookkeeping so a restart / cache eviction can restore the real
	// last-known usage instead of resurrecting the newest stored request payload,
	// whose headers may predate the account's current window by hours. NULL =
	// nothing observed yet for this account.
	{
		table: "accounts",
		column: "codex_usage_json",
		ddl: "ALTER TABLE accounts ADD COLUMN codex_usage_json TEXT",
	},
	{
		table: "accounts",
		column: "codex_usage_observed_at",
		ddl: "ALTER TABLE accounts ADD COLUMN codex_usage_observed_at INTEGER",
	},
	// Base64 attachment chars (images + documents) carried by the request,
	// EXCLUDED from the context_*_chars buckets — transport bytes are not
	// context. NULL = the row predates the column or had no composition walk.
	{
		table: "requests",
		column: "context_binary_chars",
		ddl: "ALTER TABLE requests ADD COLUMN context_binary_chars INTEGER",
	},
	// When the account's CURRENT refresh token stops being accepted, from the
	// provider's own `refresh_token_expires_in`. Distinct from expires_at (the
	// short-lived access token) and from refresh_token_issued_at (when we last
	// rotated). Written atomically with refresh_token, because it describes that
	// exact token. NULL = the provider does not report a deadline (Codex, the
	// API-key providers) or the row predates the column — unknown, never "far
	// away", so nothing may warn off a NULL.
	{
		table: "accounts",
		column: "refresh_token_expires_at",
		ddl: "ALTER TABLE accounts ADD COLUMN refresh_token_expires_at INTEGER",
	},
	// When the usage reading a snapshot row reports was actually OBSERVED, as
	// opposed to `sampled_at`, which is the sampler tick's own clock. The tick
	// accepts any cache entry younger than the freshness bound
	// (max(2 * pollInterval, 150s)), so the two can legitimately differ by up to
	// that bound — and anything correlating the percentage clock against the
	// request clock is wrong by exactly that unknown amount without this column.
	// NULL on every row written before it existed: unknown, never "the same as
	// sampled_at".
	{
		table: "usage_snapshots",
		column: "observed_at",
		ddl: "ALTER TABLE usage_snapshots ADD COLUMN observed_at INTEGER",
	},
	// The account's plan tier and rate-limit tier AS OF THE SAMPLE. Both are
	// otherwise only available as today's value on the accounts row, which would
	// refile the whole history under a tier the account may have moved to
	// yesterday — and a tier change reads exactly like a change in what the
	// subscription buys. NULL on pre-column rows; a reader must fall back to the
	// account's present-day value and mark that inference as assumed.
	{
		table: "usage_snapshots",
		column: "plan_tier",
		ddl: "ALTER TABLE usage_snapshots ADD COLUMN plan_tier TEXT",
	},
	{
		table: "usage_snapshots",
		column: "rate_limit_tier",
		ddl: "ALTER TABLE usage_snapshots ADD COLUMN rate_limit_tier TEXT",
	},
	// When a persistable token vector first became known for the request, ms
	// epoch. The row's `timestamp` is written at PERSISTENCE time, which lags
	// this by the response duration plus writer-queue depth — an unknown amount
	// that anything correlating spend against a rate-limit clock is wrong by.
	// NULL on pre-column rows and on rows whose usage was never usable.
	{
		table: "requests",
		column: "usage_finalized_at",
		ddl: "ALTER TABLE requests ADD COLUMN usage_finalized_at INTEGER",
	},
	// The per-claim `-surpassed-threshold` reading, which the first version of
	// the claim series parsed past. NULL = no reading; 0 is a reading.
	{
		table: "unified_claim_observations",
		column: "surpassed_threshold",
		ddl: "ALTER TABLE unified_claim_observations ADD COLUMN surpassed_threshold REAL",
	},
];

/**
 * Apply the ADDITIVE_COLUMNS ALTERs to a pre-existing database.
 *
 * Runs entirely before ensureSchema(), so every column an index may reference
 * exists by the time any CREATE INDEX runs. Entries whose table does not exist
 * yet are skipped, not an error: on a fresh database there are no tables at all
 * (ensureSchema() creates them complete a moment later), and on an upgraded one
 * a table introduced after that database was created is likewise absent until
 * ensureSchema() adds it — with the current CREATE TABLE, which already has the
 * column.
 */
function applyAdditiveColumns(db: Database): void {
	if (ADDITIVE_COLUMNS.length === 0) return;

	const tx = db.transaction(() => {
		const tableExists = db.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
		);
		// null marks "table absent" so a missing table is probed once, not once
		// per entry.
		const cache = new Map<string, Set<string> | null>();
		const cols = (table: string): Set<string> | null => {
			let s = cache.get(table);
			if (s === undefined) {
				s = tableExists.get(table)
					? new Set(
							(
								db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
									name: string;
								}>
							).map((c) => c.name),
						)
					: null;
				cache.set(table, s);
			}
			return s;
		};
		for (const { table, column, ddl } of ADDITIVE_COLUMNS) {
			const existing = cols(table);
			if (existing === null || existing.has(column)) continue;
			db.prepare(ddl).run();
			existing.add(column);
			log.info(`Added column ${table}.${column}`);
		}
	});
	tx();
}

export function runMigrations(db: Database): void {
	// Additive ALTERs FIRST, then the base schema. The order is load-bearing:
	// ensureSchema() creates indexes (its own, plus addPerformanceIndexes()) and
	// an index over a column that only ADDITIVE_COLUMNS can supply would throw
	// `no such column` at startup on every upgraded DB if it ran first. That has
	// already happened once, to idx_request_payloads_size over
	// request_payloads.bytes. Doing the ALTERs first removes the whole class of
	// failure instead of guarding one index at a time.
	//
	// Safe on a fresh DB: no tables exist yet, so every entry is skipped and
	// ensureSchema() still sees an empty database (its leading
	// `PRAGMA auto_vacuum = INCREMENTAL` only takes effect there).
	applyAdditiveColumns(db);

	ensureSchema(db);
}
