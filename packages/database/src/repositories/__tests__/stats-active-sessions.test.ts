import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NO_ACCOUNT_ID } from "@clankermux/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { RequestRepository } from "../request.repository";
import { StatsRepository } from "../stats.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA foreign_keys = ON");
	ensureSchema(db);
	return db;
}

function insertRequest(db: Database, id: string): void {
	db.run(
		`INSERT INTO requests
			(id, timestamp, method, path, account_used, status_code, success,
			 error_message, response_time_ms, failover_attempts)
		 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
		[id, Date.now()],
	);
}

let seq = 0;
async function seedRouting(
	db: Database,
	repo: RequestRepository,
	opts: {
		affinityScope: string | null;
		affinityKeyHash: string | null;
		createdAt: number;
		selectedAccountId?: string | null;
	},
): Promise<void> {
	const requestId = `req-${seq++}`;
	insertRequest(db, requestId);
	await repo.saveRouting({
		requestId,
		strategy: "session",
		decision: "affinity_hit",
		affinityScope: opts.affinityScope ?? undefined,
		affinityKeyHash: opts.affinityKeyHash ?? undefined,
		selectedAccountId: opts.selectedAccountId ?? undefined,
		createdAt: opts.createdAt,
	});
}

describe("StatsRepository.getActiveSessionCounts", () => {
	let db: Database;
	let requestRepo: RequestRepository;
	let statsRepo: StatsRepository;

	beforeEach(() => {
		db = makeDb();
		const adapter = new BunSqlAdapter(db);
		requestRepo = new RequestRepository(adapter);
		statsRepo = new StatsRepository(adapter);
	});

	afterEach(() => {
		db.close();
	});

	it("returns all zeros for an empty table", async () => {
		const counts = await statsRepo.getActiveSessionCounts(0);
		expect(counts).toEqual({ claude: 0, codex: 0, other: 0, total: 0 });
	});

	it("counts distinct hashes per scope (same hash+scope collapses to 1)", async () => {
		const now = Date.now();
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "hash-dup",
			createdAt: now,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "hash-dup",
			createdAt: now + 1,
		});

		const counts = await statsRepo.getActiveSessionCounts(now - 1000);
		expect(counts).toEqual({ claude: 1, codex: 0, other: 0, total: 1 });
	});

	it("excludes rows at or before sinceMs and includes rows after it", async () => {
		const since = 1_700_000_000_000;
		// created_at == since -> excluded (strictly greater than only)
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "hash-eq",
			createdAt: since,
		});
		// created_at < since -> excluded
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "hash-old",
			createdAt: since - 1,
		});
		// created_at > since -> included
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "hash-new",
			createdAt: since + 1,
		});

		const counts = await statsRepo.getActiveSessionCounts(since);
		expect(counts).toEqual({ claude: 1, codex: 0, other: 0, total: 1 });
	});

	it("excludes rows with a NULL affinity_key_hash entirely", async () => {
		const now = Date.now();
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: null,
			createdAt: now,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: null,
			affinityKeyHash: null,
			createdAt: now,
		});

		const counts = await statsRepo.getActiveSessionCounts(now - 1000);
		expect(counts).toEqual({ claude: 0, codex: 0, other: 0, total: 0 });
	});

	it("maps the three scopes to claude/codex/other and totals across them", async () => {
		const now = Date.now();
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "c-1",
			createdAt: now,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: "codex_thread",
			affinityKeyHash: "x-1",
			createdAt: now,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: "codex_thread",
			affinityKeyHash: "x-2",
			createdAt: now,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: "project",
			affinityKeyHash: "p-1",
			createdAt: now,
		});

		const counts = await statsRepo.getActiveSessionCounts(now - 1000);
		expect(counts).toEqual({ claude: 1, codex: 2, other: 1, total: 4 });
		// total equals claude+codex+other when scopes use disjoint hashes
		expect(counts.total).toBe(counts.claude + counts.codex + counts.other);
	});

	it("counts a hash shared across two scopes once in the distinct total", async () => {
		const now = Date.now();
		// Same hash appears under two different scopes: each scope counts it,
		// but the distinct total counts the hash only once.
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "shared",
			createdAt: now,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: "codex_thread",
			affinityKeyHash: "shared",
			createdAt: now,
		});

		const counts = await statsRepo.getActiveSessionCounts(now - 1000);
		expect(counts.claude).toBe(1);
		expect(counts.codex).toBe(1);
		expect(counts.total).toBe(1);
	});
});

describe("StatsRepository.getActiveSessionCountsByAccount", () => {
	let db: Database;
	let requestRepo: RequestRepository;
	let statsRepo: StatsRepository;

	beforeEach(() => {
		db = makeDb();
		const adapter = new BunSqlAdapter(db);
		requestRepo = new RequestRepository(adapter);
		statsRepo = new StatsRepository(adapter);
	});

	afterEach(() => {
		db.close();
	});

	it("returns an empty Map for an empty table", async () => {
		const counts = await statsRepo.getActiveSessionCountsByAccount(0);
		expect(counts.size).toBe(0);
	});

	it("counts distinct hashes per account (same hash+account collapses to 1)", async () => {
		const now = Date.now();
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "hash-dup",
			selectedAccountId: "acct-a",
			createdAt: now,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "hash-dup",
			selectedAccountId: "acct-a",
			createdAt: now + 1,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "hash-other",
			selectedAccountId: "acct-a",
			createdAt: now + 2,
		});

		const counts = await statsRepo.getActiveSessionCountsByAccount(now - 1000);
		expect(counts.get("acct-a")).toBe(2);
	});

	it("excludes rows at or before sinceMs and includes rows after it", async () => {
		const since = 1_700_000_000_000;
		// created_at == since -> excluded (strictly greater than only)
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "hash-eq",
			selectedAccountId: "acct-a",
			createdAt: since,
		});
		// created_at < since -> excluded
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "hash-old",
			selectedAccountId: "acct-a",
			createdAt: since - 1,
		});
		// created_at > since -> included
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "hash-new",
			selectedAccountId: "acct-a",
			createdAt: since + 1,
		});

		const counts = await statsRepo.getActiveSessionCountsByAccount(since);
		expect(counts.get("acct-a")).toBe(1);
	});

	it("excludes rows with a NULL affinity_key_hash even when an account is set", async () => {
		const now = Date.now();
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: null,
			selectedAccountId: "acct-a",
			createdAt: now,
		});

		const counts = await statsRepo.getActiveSessionCountsByAccount(now - 1000);
		expect(counts.size).toBe(0);
	});

	it("groups rows with a NULL selected_account_id under the NO_ACCOUNT_ID key", async () => {
		const now = Date.now();
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "orphan-1",
			selectedAccountId: null,
			createdAt: now,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "orphan-2",
			selectedAccountId: null,
			createdAt: now,
		});

		const counts = await statsRepo.getActiveSessionCountsByAccount(now - 1000);
		expect(counts.get(NO_ACCOUNT_ID)).toBe(2);
	});

	it("counts two different accounts independently", async () => {
		const now = Date.now();
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "a-1",
			selectedAccountId: "acct-a",
			createdAt: now,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "a-2",
			selectedAccountId: "acct-a",
			createdAt: now,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: "codex_thread",
			affinityKeyHash: "b-1",
			selectedAccountId: "acct-b",
			createdAt: now,
		});

		const counts = await statsRepo.getActiveSessionCountsByAccount(now - 1000);
		expect(counts.get("acct-a")).toBe(2);
		expect(counts.get("acct-b")).toBe(1);
	});

	it("counts a hash shared across two accounts once under EACH account", async () => {
		const now = Date.now();
		// The same session hash was routed to two different accounts (e.g. after a
		// failover). Each account counts it, so the per-account counts deliberately
		// do NOT sum to the global distinct total.
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "shared",
			selectedAccountId: "acct-a",
			createdAt: now,
		});
		await seedRouting(db, requestRepo, {
			affinityScope: "claude_session",
			affinityKeyHash: "shared",
			selectedAccountId: "acct-b",
			createdAt: now,
		});

		const counts = await statsRepo.getActiveSessionCountsByAccount(now - 1000);
		expect(counts.get("acct-a")).toBe(1);
		expect(counts.get("acct-b")).toBe(1);
	});
});
