/**
 * One-shot backfills: the pass must apply once and then never touch the data
 * again, because what it writes is a per-account toggle the operator owns from
 * that point on.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ATTEMPT_SDK_BRIDGE_AT_CAPACITY,
	ATTEMPT_STREAM_FAILED,
	ATTEMPT_TRANSPORT_FAILED,
	CLIENT_CLOSED_REQUEST,
} from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { runOneShotBackfills } from "../backfills";
import { ensureSchema } from "../migrations";
import { RoutingRepository } from "../repositories/routing.repository";

const MARKER = "backfill:auto-pause-overage-default";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clankermux-backfills-"));
	dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertAccount(db: Database, id: string, autoPause: number): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at, auto_pause_on_overage_enabled)
		 VALUES (?, ?, 'anthropic', ?, ?)`,
		[id, id, 1_700_000_000_000, autoPause],
	);
}

function autoPause(db: Database, id: string): number {
	return (
		db
			.prepare(
				`SELECT auto_pause_on_overage_enabled AS v FROM accounts WHERE id = ?`,
			)
			.get(id) as { v: number }
	).v;
}

function marker(db: Database): { config: string } | null {
	return db
		.prepare(`SELECT config FROM strategies WHERE name = ?`)
		.get(MARKER) as { config: string } | null;
}

describe("auto-pause-on-overage default backfill", () => {
	it("enables overage auto-pause on pre-existing rows and records the marker", () => {
		const db = new Database(dbPath, { create: true });
		try {
			ensureSchema(db);
			insertAccount(db, "old-acct", 0);
			insertAccount(db, "already-on", 1);

			runOneShotBackfills(db);

			expect(autoPause(db, "old-acct")).toBe(1);
			expect(autoPause(db, "already-on")).toBe(1);

			const row = marker(db);
			expect(row).not.toBeNull();
			expect(JSON.parse(row?.config ?? "{}").accountsUpdated).toBe(1);
		} finally {
			db.close();
		}
	});

	it("never re-enables an account the operator turned off afterwards", () => {
		// The whole reason this is one-shot: a level-triggered pass would read
		// "0" as "not yet backfilled" and silently undo a deliberate opt-out on
		// every single restart.
		const db = new Database(dbPath, { create: true });
		try {
			ensureSchema(db);
			insertAccount(db, "old-acct", 0);
			runOneShotBackfills(db);

			db.run(
				`UPDATE accounts SET auto_pause_on_overage_enabled = 0 WHERE id = ?`,
				["old-acct"],
			);
			runOneShotBackfills(db);

			expect(autoPause(db, "old-acct")).toBe(0);
		} finally {
			db.close();
		}
	});

	it("stays applied across a reopen", () => {
		const first = new Database(dbPath, { create: true });
		try {
			ensureSchema(first);
			insertAccount(first, "old-acct", 0);
			runOneShotBackfills(first);
		} finally {
			first.close();
		}

		const second = new Database(dbPath);
		try {
			const before = marker(second);
			second.run(
				`UPDATE accounts SET auto_pause_on_overage_enabled = 0 WHERE id = ?`,
				["old-acct"],
			);

			runOneShotBackfills(second);

			expect(autoPause(second, "old-acct")).toBe(0);
			// The marker is the persisted record, not an in-process flag.
			expect(marker(second)?.config).toBe(before?.config ?? "");
		} finally {
			second.close();
		}
	});

	it("leaves the data alone when another connection already claimed the marker", () => {
		// The marker claim is an INSERT OR IGNORE inside the transaction, so the
		// process that loses the race sees changes = 0 and returns instead of
		// throwing `UNIQUE constraint failed: strategies.name` out of the
		// DatabaseOperations constructor and failing its own startup.
		const db = new Database(dbPath, { create: true });
		try {
			ensureSchema(db);
			runOneShotBackfills(db);
			const claimed = marker(db);

			insertAccount(db, "later-acct", 0);

			expect(() => runOneShotBackfills(db)).not.toThrow();
			expect(autoPause(db, "later-acct")).toBe(0);
			expect(marker(db)?.config).toBe(claimed?.config ?? "");
		} finally {
			db.close();
		}
	});

	it("is a no-op on a database whose accounts are all enabled", () => {
		const db = new Database(dbPath, { create: true });
		try {
			ensureSchema(db);
			insertAccount(db, "a", 1);
			insertAccount(db, "b", 1);

			runOneShotBackfills(db);

			expect(JSON.parse(marker(db)?.config ?? "{}").accountsUpdated).toBe(0);
			expect(autoPause(db, "a")).toBe(1);
			expect(autoPause(db, "b")).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe("unrated request model backfill", () => {
	const UNRATED_MARKER = "backfill:unrated-request-model";

	function insertRequest(
		db: Database,
		id: string,
		success: number | null,
		model: string | null,
	): void {
		db.run(
			`INSERT INTO requests (id, timestamp, method, path, status_code, success, model)
			 VALUES (?, 1, 'POST', '/v1/messages', ?, ?, ?)`,
			[id, success === null ? 499 : 200, success, model],
		);
	}

	function model(db: Database, id: string): string | null {
		return (
			db.prepare(`SELECT model FROM requests WHERE id = ?`).get(id) as {
				model: string | null;
			}
		).model;
	}

	it("clears the model on rows without an outcome, once", () => {
		const db = new Database(dbPath, { create: true });
		try {
			ensureSchema(db);
			insertRequest(db, "abort", null, "gpt-6-astra");
			insertRequest(db, "ok", 1, "gpt-6-astra");
			insertRequest(db, "failed", 0, "gpt-6-luna");

			runOneShotBackfills(db);

			expect(model(db, "abort")).toBeNull();
			expect(model(db, "ok")).toBe("gpt-6-astra");
			expect(model(db, "failed")).toBe("gpt-6-luna");
			const config = db
				.prepare(`SELECT config FROM strategies WHERE name = ?`)
				.get(UNRATED_MARKER) as { config: string };
			expect(JSON.parse(config.config).requestsCleared).toBe(1);

			// A row written with a model afterwards is not the pass's business.
			insertRequest(db, "later", null, "gpt-6-astra");
			runOneShotBackfills(db);
			expect(model(db, "later")).toBe("gpt-6-astra");
		} finally {
			db.close();
		}
	});

	it("seeks the rows through the success index", () => {
		const db = new Database(dbPath, { create: true });
		try {
			ensureSchema(db);
			const plan = (
				db
					.query(
						"EXPLAIN QUERY PLAN UPDATE requests SET model = NULL WHERE success IS NULL AND model IS NOT NULL",
					)
					.all() as { detail: string }[]
			).map((row) => row.detail);
			expect(plan.join("\n")).toContain(
				"USING INDEX idx_requests_success_timestamp (success=?)",
			);
		} finally {
			db.close();
		}
	});
});

describe("served service tier backfill", () => {
	const MARKER = "backfill:served-service-tier";

	function insertRequest(db: Database, id: string): void {
		db.run(
			`INSERT INTO requests (id, timestamp, method, path, status_code, success, model)
			 VALUES (?, 1, 'POST', '/v1/responses', 200, 1, 'gpt-6-astra')`,
			[id],
		);
	}

	function insertAttempt(
		db: Database,
		id: string,
		requestId: string,
		tier: string | null,
		startedAt: number,
		end: { status?: number | null; error?: string | null } = {},
	): void {
		db.run(
			`INSERT INTO routing_attempts (id, request_id, route_snapshot_id, requested_model, kind, started_at, service_tier_sent, status, error)
			 VALUES (?, ?, 'snap', 'gpt-6-astra', 'upstream_send', ?, ?, ?, ?)`,
			[
				id,
				requestId,
				startedAt,
				tier,
				end.status === undefined ? 200 : end.status,
				end.error ?? null,
			],
		);
	}

	function tier(db: Database, id: string): string | null {
		return (
			db.prepare(`SELECT service_tier FROM requests WHERE id = ?`).get(id) as {
				service_tier: string | null;
			}
		).service_tier;
	}

	it("fills the tier from the latest upstream attempt, once", () => {
		const db = new Database(dbPath, { create: true });
		try {
			ensureSchema(db);
			insertRequest(db, "fast");
			insertAttempt(db, "a1", "fast", "priority", 10);
			insertRequest(db, "failover");
			insertAttempt(db, "a2", "failover", "priority", 10);
			insertAttempt(db, "a3", "failover", null, 20);
			insertRequest(db, "tie");
			insertAttempt(db, "a4", "tie", null, 30);
			insertAttempt(db, "a5", "tie", "priority", 30);
			insertRequest(db, "untiered");
			insertAttempt(db, "a6", "untiered", null, 40);
			// A bridge refusal ran nothing, so the earlier send still decides.
			insertRequest(db, "refused");
			insertAttempt(db, "a8", "refused", "priority", 10);
			insertAttempt(db, "a9", "refused", null, 20, {
				status: 529,
				error: `${ATTEMPT_SDK_BRIDGE_AT_CAPACITY}full`,
			});
			// Whether a failed fetch or a client-closed send went out is unknown.
			insertRequest(db, "transport");
			insertAttempt(db, "a10", "transport", "priority", 10);
			insertAttempt(db, "a11", "transport", null, 20, {
				status: 502,
				error: ATTEMPT_TRANSPORT_FAILED,
			});
			insertRequest(db, "closed");
			insertAttempt(db, "a12", "closed", "priority", 10, {
				status: 499,
				error: CLIENT_CLOSED_REQUEST,
			});
			// A stream that failed after the answer started did go out.
			insertRequest(db, "stream");
			insertAttempt(db, "a13", "stream", "priority", 10, {
				status: 200,
				error: ATTEMPT_STREAM_FAILED,
			});

			runOneShotBackfills(db);

			expect(tier(db, "fast")).toBe("priority");
			expect(tier(db, "failover")).toBe("standard");
			expect(tier(db, "tie")).toBe("priority");
			// No tiered attempt: left NULL, which already reads as standard.
			expect(tier(db, "untiered")).toBeNull();
			expect(tier(db, "refused")).toBe("priority");
			expect(tier(db, "transport")).toBeNull();
			expect(tier(db, "closed")).toBeNull();
			expect(tier(db, "stream")).toBe("priority");
			const config = db
				.prepare(`SELECT config FROM strategies WHERE name = ?`)
				.get(MARKER) as { config: string };
			expect(JSON.parse(config.config).requestsFilled).toBe(5);

			// Rows after the pass belong to the recorder, not the backfill.
			insertRequest(db, "later");
			insertAttempt(db, "a7", "later", "priority", 50);
			runOneShotBackfills(db);
			expect(tier(db, "later")).toBeNull();
		} finally {
			db.close();
		}
	});
});

/**
 * The one-shot pass that physically rewrote `target_kind = 'default'` rows to
 * `'requested'` is gone. What replaced it is not a rewrite at all: the rule
 * validator normalizes on read, so a legacy row keeps its stored value and is
 * still usable. This test covers that path, which the repository tests cannot —
 * they create rules through saveRule(), which normalizes BEFORE storage.
 */
describe("legacy routing target_kind", () => {
	it("reads a stored 'default' rule as 'requested' without rewriting it", async () => {
		const db = new Database(dbPath, { create: true });
		try {
			ensureSchema(db);
			// Raw SQL on purpose: saveRule() would normalize the value away.
			db.run(
				`INSERT INTO routing_rules (
					id, name, enabled, position, match_api_key_id, match_model_kind,
					match_model_value, pool_kind, pool_provider, pool_account_ids,
					target_kind, target_model
				) VALUES ('legacy', 'legacy', 1, 0, NULL, 'any', NULL, 'inherit', NULL, NULL, 'default', NULL)`,
			);

			const repo = new RoutingRepository(new BunSqlAdapter(db));
			const rules = await repo.listRules();

			expect(rules.map((r) => r.target_kind)).toEqual(["requested"]);
			expect(
				(
					db
						.prepare(`SELECT target_kind AS v FROM routing_rules WHERE id = ?`)
						.get("legacy") as { v: string }
				).v,
			).toBe("default");
		} finally {
			db.close();
		}
	});
});
