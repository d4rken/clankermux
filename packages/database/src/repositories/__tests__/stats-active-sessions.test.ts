import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
