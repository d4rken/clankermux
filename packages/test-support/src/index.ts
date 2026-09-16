import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "@clankermux/types";

export interface TempDbTracker {
	/**
	 * Returns a fresh, unique database path inside this tracker's own temporary
	 * directory. The directory is created lazily on first use.
	 */
	next(): string;
	/**
	 * Removes the tracker's temporary directory and everything inside it,
	 * including SQLite sidecars (`-wal`, `-shm`, `-journal`). Idempotent: a
	 * later `next()` re-arms the tracker with a fresh directory.
	 */
	cleanup(): void;
}

/**
 * Tracks temporary SQLite fixture databases for a test file.
 *
 * All fixtures handed out by one tracker live in a single directory under the
 * OS temporary directory, so removing that directory removes the database
 * files and any sidecars SQLite created next to them.
 */
export function tempDbTracker(prefix: string): TempDbTracker {
	let dir: string | null = null;

	return {
		next(): string {
			dir ??= mkdtempSync(join(tmpdir(), `${prefix}-`));
			return join(dir, `${prefix}-${randomBytes(6).toString("hex")}.db`);
		},
		cleanup(): void {
			if (dir === null) return;
			rmSync(dir, { recursive: true, force: true });
			dir = null;
		},
	};
}

/**
 * A complete {@link Account} for tests, with every field a call site does not
 * mention set to an inert canonical value: nullable fields `null`, booleans
 * `false`, numeric counters `0`.
 *
 * Deterministic on purpose — no `Date.now()` here. A fixture that depends on a
 * live clock must say so by passing the field itself.
 */
export function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "r",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		codex_auto_apply_reset_on_weekly_limit_enabled: false,
		custom_endpoint: null,
		billing_type: null,
		pause_reason: null,
		notes: null,
		refresh_token_issued_at: null,
		refresh_token_expires_at: null,
		renewal_anchor: null,
		renewal_anchor_source: null,
		renewal_cadence: null,
		renewal_price_usd_micros: null,
		renewal_auto_start_date: null,
		identity_external_id: null,
		identity_email: null,
		identity_organization_name: null,
		identity_plan_tier: null,
		identity_rate_limit_tier: null,
		identity_subscription_status: null,
		identity_subscription_started_at: null,
		identity_subscription_ends_at: null,
		identity_subscription_will_renew: null,
		identity_subscription_grace_ends_at: null,
		identity_subscription_checked_at: null,
		identity_captured_at: null,
		identity_profile_fetched_at: null,
		...overrides,
	};
}

/**
 * Wraps a plain request handler as a stand-in for `globalThis.fetch`.
 *
 * Bun's `typeof fetch` carries a `preconnect` static, so a bare function is not
 * assignable to it. The no-op static below plus the single cast are the reason
 * this helper exists: assign `mockFetch(...)` instead of hand-rolling the cast
 * at each call site.
 */
export function mockFetch(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	const preconnect: typeof fetch.preconnect = () => {};
	return Object.assign(impl, { preconnect }) as typeof fetch;
}
