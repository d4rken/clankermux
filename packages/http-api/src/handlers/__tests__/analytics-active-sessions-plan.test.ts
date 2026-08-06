/**
 * Query-PLAN regression net for the two `activeSessions` queries.
 *
 * `analytics-active-sessions.test.ts` next door asserts RESULTS, and results
 * are identical under the fast and the slow plan — that file passes either way
 * and cannot protect this. The observable that actually changed is the plan
 * shape, so this file asserts that instead. No timing assertions: a wall-clock
 * benchmark in the suite would be flaky.
 *
 * The fixture deliberately seeds MISLEADING `sqlite_stat1` rows, reproducing
 * the live database's state — `request_routing` recorded at 71 rows from when
 * the table was new, against 362k real ones — because that is what makes a
 * plain `JOIN` plan as `SCAN rr` plus a per-row probe into `requests`.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics-direct";

let tmpDir: string;
let dbPath: string;
let dbOps: DatabaseOperations;

/** Row counts the planner is told to believe, not the ones in the fixture. */
const FAKE_ROW_COUNTS: Record<string, number> = {
	requests: 400_000,
	request_routing: 71,
};

beforeEach(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-active-sessions-plan-"));
	dbPath = join(tmpDir, "test.db");
	dbOps = new DatabaseOperations(dbPath);
	await seed();
	await seedMisleadingStats();
});

afterEach(async () => {
	await dbOps.dispose();
	rmSync(tmpDir, { recursive: true, force: true });
});

function context(): APIContext {
	return {
		db: dbOps.getAdapter(),
		config: {} as APIContext["config"],
		dbOps,
	};
}

async function seed(): Promise<void> {
	const db = dbOps.getAdapter();
	const now = Date.now();
	for (let i = 0; i < 8; i++) {
		await db.run(
			`INSERT INTO requests (
				id, timestamp, method, path, account_used, status_code, success,
				response_time_ms, failover_attempts, model
			) VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, 100, 0, 'claude-opus')`,
			[`r-${i}`, now - i * 60_000],
		);
		await db.run(
			`INSERT INTO request_routing (
				request_id, strategy, decision, affinity_scope, affinity_key_hash,
				selected_account_id, failover_attempts, created_at
			) VALUES (?, 'session', 'sticky', 'claude_session', ?, NULL, 0, ?)`,
			[`r-${i}`, `hash-${i % 3}`, now - i * 60_000],
		);
	}
}

/**
 * Rewrite the leading row-count token of every `sqlite_stat1` entry, keeping
 * each stat string's arity (it has one entry per indexed column plus the row
 * count, and SQLite rejects a mismatched one).
 */
async function seedMisleadingStats(): Promise<void> {
	const db = dbOps.getAdapter();
	await db.run("ANALYZE", []);
	const rows = await db.query<{
		tbl: string;
		idx: string | null;
		stat: string;
	}>("SELECT tbl, idx, stat FROM sqlite_stat1", []);
	for (const row of rows) {
		const fake = FAKE_ROW_COUNTS[row.tbl];
		if (fake === undefined) continue;
		const rest = row.stat.split(" ").slice(1);
		await db.run(
			"UPDATE sqlite_stat1 SET stat = ? WHERE tbl = ? AND idx IS ?",
			[[String(fake), ...rest].join(" "), row.tbl, row.idx],
		);
	}
}

/**
 * Run the analytics handler and return the SQL it actually issued.
 *
 * Captured rather than restated: a copy of the query in the test would keep
 * passing after the real one lost its pin.
 */
async function capturedSql(params: Record<string, string>): Promise<string[]> {
	const adapter = dbOps.getAdapter() as unknown as {
		query: (sql: string, p?: unknown[]) => Promise<unknown[]>;
	};
	const original = adapter.query.bind(adapter);
	const seen: string[] = [];
	adapter.query = (sql, p) => {
		seen.push(sql);
		return original(sql, p);
	};
	try {
		const response = await createAnalyticsHandler(context())(
			new URLSearchParams({
				sections: "activeSessions,activeSessionsByAccount",
				...params,
			}),
		);
		expect(response.status).toBe(200);
	} finally {
		adapter.query = original;
	}
	return seen;
}

function only(sqls: string[], marker: string): string {
	const matches = sqls.filter((sql) => sql.includes(marker));
	expect(matches).toHaveLength(1);
	return matches[0];
}

/**
 * `EXPLAIN QUERY PLAN` details, read on a SEPARATE connection so the plan is
 * chosen against the misleading stats written above rather than whatever the
 * handler's connection had already loaded.
 */
function planFor(sql: string): string[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
			.all()
			.map((row) => row.detail);
	} finally {
		db.close();
	}
}

/** Alias of the first base table the plan opens — the outer loop of the join. */
function outerTableAlias(plan: string[]): string | null {
	for (const detail of plan) {
		const match = detail.match(/^(?:SCAN|SEARCH) (r|rr)\b/);
		if (match) return match[1];
	}
	return null;
}

const SESSION_CTE = "WITH session_requests AS";
const BY_ACCOUNT = "COUNT(DISTINCT rr.affinity_key_hash) AS sessions";

/**
 * `requests` entered through an indexed range scan on `timestamp`.
 *
 * Deliberately name-agnostic. The claim being defended is "the bounded range is
 * served by an index range scan", not "it uses `idx_requests_timestamp`" —
 * pinning the name would turn a future covering index on `(timestamp, …)` into
 * a red test. The form still fails on `SCAN r`, which is the regression this
 * file exists to catch: `outerTableAlias` alone accepts a full table scan as
 * long as `requests` is the outer loop.
 */
const RANGE_SCAN_ON_TIMESTAMP =
	/SEARCH r USING (?:COVERING )?INDEX [A-Za-z0-9_]+ \(timestamp>\?\)/;

const ROUTING_PK_PROBE =
	/SEARCH rr USING (?:COVERING )?INDEX sqlite_autoindex_request_routing_1 \(request_id=\?\)/;

describe("activeSessions query plan — bounded range", () => {
	it("drives the session CTE from requests and probes request_routing by its primary key", async () => {
		const sqls = await capturedSql({ range: "24h" });
		const plan = planFor(only(sqls, SESSION_CTE));

		expect(outerTableAlias(plan)).toBe("r");
		expect(plan.some((detail) => RANGE_SCAN_ON_TIMESTAMP.test(detail))).toBe(
			true,
		);
		expect(plan.some((detail) => ROUTING_PK_PROBE.test(detail))).toBe(true);
	});

	it("drives the per-account breakdown from requests too", async () => {
		const sqls = await capturedSql({ range: "24h" });
		const plan = planFor(only(sqls, BY_ACCOUNT));

		expect(outerTableAlias(plan)).toBe("r");
		expect(plan.some((detail) => RANGE_SCAN_ON_TIMESTAMP.test(detail))).toBe(
			true,
		);
		expect(plan.some((detail) => ROUTING_PK_PROBE.test(detail))).toBe(true);
	});
});

describe("activeSessions query plan — range=all", () => {
	// No `requests` predicate is selective there, and the pin measured 5-24%
	// SLOWER, so the planner must be left free. Under the misleading stats it
	// then picks the (apparently tiny) routing table as the outer loop.
	it("does not pin requests first in the session CTE", async () => {
		const sqls = await capturedSql({ range: "all" });
		const plan = planFor(only(sqls, SESSION_CTE));

		expect(outerTableAlias(plan)).toBe("rr");
	});

	it("does not pin requests first in the per-account breakdown", async () => {
		const sqls = await capturedSql({ range: "all" });
		const plan = planFor(only(sqls, BY_ACCOUNT));

		expect(outerTableAlias(plan)).toBe("rr");
	});
});
