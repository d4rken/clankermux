/**
 * Persistence of the Codex usage snapshot onto
 * accounts.codex_usage_json / accounts.codex_usage_observed_at.
 *
 * Why it exists: the dashboard's Codex usage recovery used to fall back to the
 * newest STORED REQUEST PAYLOAD, whose response headers can predate the
 * account's current window by hours (a pre-lock 99% resurrected as if it were
 * current). Coordinator ping observations were never persisted anywhere, so
 * after a restart or a cache eviction there was nothing better to serve. Every
 * observation now writes its normalized snapshot to the account row.
 *
 * The credits carry-forward is done IN SQL (JSON1): the in-memory
 * carry-forward can only see the usage CACHE, so on a cold cache a credits-less
 * observation would otherwise erase the credits state the column still holds.
 * That statement is therefore exercised against a real in-memory bun:sqlite DB
 * rather than a recording double.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema } from "@clankermux/database";
import { type RateLimitInfo, usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import {
	type ApplyCodexObservationOptions,
	applyCodexObservation,
	clearCodexUsagePersistMemo,
} from "../codex-observation";
import type { ProxyContext } from "../proxy-types";

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-persist",
		name: "codex-account",
		provider: "codex",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

/**
 * ctx backed by a REAL in-memory accounts table, so the JSON1 statement itself
 * is under test. `enqueue` runs its job synchronously by default and its return
 * value is switchable (the bounded metadata queue really does refuse jobs).
 * Flipping `defer` parks jobs in a queue instead, which is how the real bounded
 * writer behaves — and the only way to let the world change between the enqueue
 * and the flush.
 */
function makeDbCtx(db: Database) {
	const accept = { value: true };
	const defer = { value: false };
	const pending: Array<() => void | Promise<void>> = [];
	const runSql: Array<{ sql: string; params: unknown[] }> = [];
	const ctx = {
		dbOps: {
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			resetConsecutiveRateLimits: async () => {},
			resetAccountSession: async () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async (sql: string, params: unknown[]) => {
					runSql.push({ sql, params });
					db.run(sql, params as never[]);
				},
				runWithChanges: async (sql: string, params: unknown[]) => {
					runSql.push({ sql, params });
					return db.run(sql, params as never[]).changes;
				},
			}),
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				if (!accept.value) return false;
				if (defer.value) pending.push(job);
				else void job();
				return true;
			},
		},
	} as unknown as Pick<ProxyContext, "asyncWriter" | "dbOps">;
	const persistWrites = () =>
		runSql.filter((c) => c.sql.includes("codex_usage_json")).length;
	/** Flush every parked job in enqueue order. */
	const runPending = async (): Promise<void> => {
		while (pending.length > 0) {
			const job = pending.shift();
			await job?.();
		}
	};
	return { ctx, accept, defer, runPending, runSql, persistWrites };
}

/** The refresh token every seeded row and account fixture starts on. */
const REFRESH_TOKEN = "rt";

function seedAccountRow(db: Database, id: string): void {
	db.run(
		"INSERT INTO accounts (id, name, provider, created_at, refresh_token) VALUES (?, ?, 'codex', ?, ?)",
		[id, id, Date.now(), REFRESH_TOKEN],
	);
}

function readUsageColumns(
	db: Database,
	id: string,
): { codex_usage_json: string | null; codex_usage_observed_at: number | null } {
	return db
		.prepare(
			"SELECT codex_usage_json, codex_usage_observed_at FROM accounts WHERE id = ?",
		)
		.get(id) as {
		codex_usage_json: string | null;
		codex_usage_observed_at: number | null;
	};
}

function baseOpts(
	overrides: Partial<ApplyCodexObservationOptions> = {},
): ApplyCodexObservationOptions {
	return {
		source: "real-traffic",
		rateLimitInfo: { isRateLimited: false } as RateLimitInfo,
		requestAccounting: "none",
		rateLimitAction: { kind: "skip" },
		successRecovery: "standard",
		...overrides,
	};
}

/** A Codex 200 with a 5h window header, optionally carrying credits headers. */
function codexResponse(
	fiveHourResetMs: number,
	utilization: number,
	extraHeaders: Record<string, string> = {},
): Response {
	return new Response('{"id":"msg_1"}', {
		status: 200,
		headers: {
			"content-type": "application/json",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": String(fiveHourResetMs / 1000),
			"x-codex-primary-used-percent": String(utilization),
			...extraHeaders,
		},
	});
}

let db: Database;
const cleanupIds = new Set<string>();

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	clearCodexUsagePersistMemo();
});

afterEach(() => {
	db.close();
	for (const id of cleanupIds) usageCache.delete(id);
	cleanupIds.clear();
	clearCodexUsagePersistMemo();
});

function track(id: string): string {
	cleanupIds.add(id);
	return id;
}

describe("Codex usage snapshot persistence", () => {
	it("writes the normalized snapshot and its observation time", () => {
		const id = track("persist-basic");
		seedAccountRow(db, id);
		const account = makeCodexAccount({ id });
		const { ctx } = makeDbCtx(db);
		const before = Date.now();

		applyCodexObservation(
			account,
			codexResponse(Date.now() + 4 * 3600_000, 42),
			ctx,
			baseOpts(),
		);

		const row = readUsageColumns(db, id);
		expect(row.codex_usage_json).not.toBeNull();
		const parsed = JSON.parse(row.codex_usage_json as string) as {
			five_hour: { utilization: number };
		};
		expect(parsed.five_hour.utilization).toBe(42);
		expect(row.codex_usage_observed_at).toBeGreaterThanOrEqual(before);
		expect(row.codex_usage_observed_at).toBeLessThanOrEqual(Date.now());
	});

	it("skips a second write when the follow-up observation is byte-identical", () => {
		const id = track("persist-dedup");
		seedAccountRow(db, id);
		const { ctx, persistWrites } = makeDbCtx(db);
		const resetMs = Date.now() + 4 * 3600_000;

		applyCodexObservation(
			makeCodexAccount({ id }),
			codexResponse(resetMs, 42),
			ctx,
			baseOpts(),
		);
		expect(persistWrites()).toBe(1);

		applyCodexObservation(
			makeCodexAccount({ id }),
			codexResponse(resetMs, 42),
			ctx,
			baseOpts(),
		);

		// Byte-identical snapshot → no second write.
		expect(persistWrites()).toBe(1);
	});

	it("re-enqueues after a dropped write instead of deduping it away", () => {
		const id = track("persist-drop");
		seedAccountRow(db, id);
		const { ctx, accept } = makeDbCtx(db);
		const resetMs = Date.now() + 4 * 3600_000;

		// The bounded metadata queue refuses the job: nothing reaches the DB.
		accept.value = false;
		applyCodexObservation(
			makeCodexAccount({ id }),
			codexResponse(resetMs, 42),
			ctx,
			baseOpts(),
		);
		expect(readUsageColumns(db, id).codex_usage_json).toBeNull();

		// The identical follow-up must NOT be deduped away — the memo entry for the
		// dropped write was removed.
		accept.value = true;
		applyCodexObservation(
			makeCodexAccount({ id }),
			codexResponse(resetMs, 42),
			ctx,
			baseOpts(),
		);
		const parsed = JSON.parse(
			readUsageColumns(db, id).codex_usage_json as string,
		) as { five_hour: { utilization: number } };
		expect(parsed.five_hour.utilization).toBe(42);
	});

	it("keeps the column's credits when a credits-less observation overwrites it", () => {
		const id = track("persist-credits");
		seedAccountRow(db, id);
		const { ctx } = makeDbCtx(db);

		// 1. An observation carrying credits headers writes them into the column.
		applyCodexObservation(
			makeCodexAccount({ id }),
			codexResponse(Date.now() + 4 * 3600_000, 10, {
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-balance": "7.25",
			}),
			ctx,
			baseOpts(),
		);
		const withCredits = JSON.parse(
			readUsageColumns(db, id).codex_usage_json as string,
		) as { codexCredits?: { hasCredits: boolean; balance: number | null } };
		expect(withCredits.codexCredits?.hasCredits).toBe(true);
		expect(withCredits.codexCredits?.balance).toBe(7.25);

		// 2. A COLD cache (the restart case) means the in-memory carry-forward has
		//    nothing to carry: only the SQL can preserve the credits.
		usageCache.delete(id);
		clearCodexUsagePersistMemo(id);
		applyCodexObservation(
			makeCodexAccount({ id }),
			codexResponse(Date.now() + 4 * 3600_000, 55),
			ctx,
			baseOpts(),
		);

		const after = JSON.parse(
			readUsageColumns(db, id).codex_usage_json as string,
		) as {
			five_hour: { utilization: number };
			codexCredits?: { hasCredits: boolean; balance: number | null };
		};
		// The windows were refreshed…
		expect(after.five_hour.utilization).toBe(55);
		// …and the previously-learned credits survived.
		expect(after.codexCredits?.hasCredits).toBe(true);
		expect(after.codexCredits?.balance).toBe(7.25);
	});
});

// ---------------------------------------------------------------------------
// Credential CAS. The persist job sits in a BOUNDED queue and only knows the
// account id, so a job enqueued before a re-authentication would flush after it
// and restore the very snapshot the reauth NULLed. Clearing the memo cannot
// cancel a queued closure — the WHERE clause has to.
// ---------------------------------------------------------------------------

describe("Codex usage snapshot persistence — credential rotation", () => {
	it("voids a queued snapshot whose account credentials rotated first", async () => {
		const id = track("persist-rotated");
		seedAccountRow(db, id);
		const { ctx, defer, runPending, persistWrites } = makeDbCtx(db);
		defer.value = true;

		applyCodexObservation(
			makeCodexAccount({ id }),
			codexResponse(Date.now() + 4 * 3600_000, 42),
			ctx,
			baseOpts(),
		);
		// Re-authentication lands while the job is still queued: new refresh token,
		// columns cleared.
		db.run(
			"UPDATE accounts SET refresh_token = 'rt-reauthed', codex_usage_json = NULL, codex_usage_observed_at = NULL WHERE id = ?",
			[id],
		);

		await runPending();

		// The write ran and matched nothing — the cleared columns stayed cleared.
		expect(persistWrites()).toBe(1);
		const row = readUsageColumns(db, id);
		expect(row.codex_usage_json).toBeNull();
		expect(row.codex_usage_observed_at).toBeNull();
	});

	it("writes normally when the row still carries the enqueued refresh token", async () => {
		const id = track("persist-same-token");
		seedAccountRow(db, id);
		const { ctx, defer, runPending } = makeDbCtx(db);
		defer.value = true;

		applyCodexObservation(
			makeCodexAccount({ id }),
			codexResponse(Date.now() + 4 * 3600_000, 42),
			ctx,
			baseOpts(),
		);
		await runPending();

		const parsed = JSON.parse(
			readUsageColumns(db, id).codex_usage_json as string,
		) as { five_hour: { utilization: number } };
		expect(parsed.five_hour.utilization).toBe(42);
	});

	it("re-persists an identical observation after a voided write (memo cleared)", async () => {
		const id = track("persist-rotated-retry");
		seedAccountRow(db, id);
		const { ctx, defer, runPending } = makeDbCtx(db);
		const resetMs = Date.now() + 4 * 3600_000;
		defer.value = true;

		// 1. Enqueued under the old credentials, then voided by the rotation.
		applyCodexObservation(
			makeCodexAccount({ id }),
			codexResponse(resetMs, 42),
			ctx,
			baseOpts(),
		);
		db.run("UPDATE accounts SET refresh_token = 'rt-reauthed' WHERE id = ?", [
			id,
		]);
		await runPending();
		expect(readUsageColumns(db, id).codex_usage_json).toBeNull();

		// 2. The very next observation carries a BYTE-IDENTICAL snapshot. It must
		//    not be deduped against the write that never landed.
		applyCodexObservation(
			makeCodexAccount({ id, refresh_token: "rt-reauthed" }),
			codexResponse(resetMs, 42),
			ctx,
			baseOpts(),
		);
		await runPending();

		const parsed = JSON.parse(
			readUsageColumns(db, id).codex_usage_json as string,
		) as { five_hour: { utilization: number } };
		expect(parsed.five_hour.utilization).toBe(42);
	});
});
