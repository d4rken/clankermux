/**
 * Tests asserting that ensureSchema() ALONE produces the full current schema
 * for a fresh install. After the legacy-migration removal, ensureSchema() owns
 * the complete schema and runMigrations() only back-fills ADDITIVE_COLUMNS on
 * pre-existing live DBs, so a fresh DB must already have every column, table,
 * and performance index — without runMigrations() adding anything.
 *
 * Also asserts that intentionally-dropped Bedrock artifacts (the
 * accounts.cross_region_mode column and the model_translations table) are
 * absent, and that the retired requests.agent_used column is gone.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";

function columnNames(db: Database, table: string): Set<string> {
	return new Set(
		(
			db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
				name: string;
			}>
		).map((c) => c.name),
	);
}

function tableExists(db: Database, name: string): boolean {
	return (
		db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
			)
			.get(name) != null
	);
}

function indexExists(db: Database, name: string): boolean {
	return (
		db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
			)
			.get(name) != null
	);
}

describe("ensureSchema completeness", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("creates the accounts table with every current column", () => {
		const cols = columnNames(db, "accounts");
		const expected = [
			"id",
			"name",
			"provider",
			"api_key",
			"refresh_token",
			"access_token",
			"expires_at",
			"created_at",
			"last_used",
			"request_count",
			"total_requests",
			"priority",
			"rate_limited_until",
			"session_start",
			"session_request_count",
			"paused",
			"rate_limit_reset",
			"rate_limit_status",
			"rate_limit_remaining",
			"auto_fallback_enabled",
			"custom_endpoint",
			"auto_refresh_enabled",
			"model_mappings",
			"model_fallbacks",
			"billing_type",
			"refresh_token_issued_at",
			"auto_pause_on_overage_enabled",
			"peak_hours_pause_enabled",
			"codex_auto_apply_reset_credits_enabled",
			"codex_auto_apply_reset_on_weekly_limit_enabled",
			"pause_reason",
			"rate_limited_reason",
			"rate_limited_at",
			"consecutive_rate_limits",
			"renewal_anchor",
			"renewal_cadence",
			"renewal_price_usd_micros",
			"renewal_auto_start_date",
			"notes",
		];
		for (const col of expected) {
			expect(cols.has(col)).toBe(true);
		}
	});

	it("does NOT create the intentionally-dropped accounts.cross_region_mode column (Bedrock)", () => {
		const cols = columnNames(db, "accounts");
		expect(cols.has("cross_region_mode")).toBe(false);
	});

	it("creates the requests table with current columns and without the retired agent_used column", () => {
		const cols = columnNames(db, "requests");
		expect(cols.has("api_key_id")).toBe(true);
		expect(cols.has("api_key_name")).toBe(true);
		expect(cols.has("combo_name")).toBe(true);
		expect(cols.has("requested_model")).toBe(true);
		expect(cols.has("agent_used")).toBe(false);
	});

	it("does NOT create the model_translations table (Bedrock dropped)", () => {
		expect(tableExists(db, "model_translations")).toBe(false);
	});

	it("creates the tool-call analytics tables with their columns and index", () => {
		expect(tableExists(db, "request_tool_calls")).toBe(true);
		const callCols = columnNames(db, "request_tool_calls");
		for (const col of [
			"request_id",
			"tool_name",
			"call_count",
			"error_count",
		]) {
			expect(callCols.has(col)).toBe(true);
		}

		expect(tableExists(db, "request_tool_errors")).toBe(true);
		const errorCols = columnNames(db, "request_tool_errors");
		for (const col of ["id", "request_id", "tool_name", "error_text"]) {
			expect(errorCols.has(col)).toBe(true);
		}

		expect(indexExists(db, "idx_request_tool_errors_request_id")).toBe(true);
	});

	it("creates the account_payments table with every current column", () => {
		expect(tableExists(db, "account_payments")).toBe(true);
		const cols = columnNames(db, "account_payments");
		const expected = [
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
		];
		for (const col of expected) {
			expect(cols.has(col)).toBe(true);
		}
	});

	it("creates the account_payments indexes", () => {
		for (const idx of [
			"idx_account_payments_subscription_due",
			"idx_account_payments_import_key",
			"idx_account_payments_paid_at",
			"idx_account_payments_account",
		]) {
			expect(indexExists(db, idx)).toBe(true);
		}
	});

	it("creates the codex_reset_credit_events table with every current column", () => {
		expect(tableExists(db, "codex_reset_credit_events")).toBe(true);
		const cols = columnNames(db, "codex_reset_credit_events");
		const expected = [
			"id",
			"account_id",
			"account_name",
			"credit_id",
			"trigger",
			"cause",
			"attempt_seq",
			"idempotency_key",
			"status",
			"windows_reset",
			"error_message",
			"credit_expires_at",
			"created_at",
			"resolved_at",
		];
		for (const col of expected) {
			expect(cols.has(col)).toBe(true);
		}
	});

	it("creates the codex_reset_credit_events indexes", () => {
		for (const idx of [
			"idx_codex_reset_credit_events_auto_attempt",
			"idx_codex_reset_credit_events_account",
		]) {
			expect(indexExists(db, idx)).toBe(true);
		}
	});

	it("creates the representative performance indexes", () => {
		for (const idx of [
			"idx_requests_summary_covering",
			"idx_requests_analytics_covering",
			"idx_accounts_paused",
			"idx_requests_api_key",
		]) {
			expect(indexExists(db, idx)).toBe(true);
		}
	});

	it("runMigrations() on a fresh ensureSchema DB does not throw and adds no columns", () => {
		const before = columnNames(db, "accounts").size;
		expect(() => runMigrations(db)).not.toThrow();
		const after = columnNames(db, "accounts").size;
		expect(after).toBe(before);
	});
});
