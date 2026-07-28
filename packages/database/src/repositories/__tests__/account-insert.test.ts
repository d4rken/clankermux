import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import {
	buildNameGuardedInsert,
	DuplicateAccountNameError,
	insertAccountUnique,
} from "../account-insert";

const INSERT_SQL = `INSERT INTO accounts (
	id, name, provider, created_at, request_count, total_requests, priority
) VALUES (?, ?, ?, ?, 0, 0, ?)`;

function makeDb(): BunSqlAdapter {
	const db = new Database(":memory:");
	db.run(`CREATE TABLE accounts (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		provider TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		request_count INTEGER NOT NULL,
		total_requests INTEGER NOT NULL,
		priority INTEGER NOT NULL
	)`);
	return new BunSqlAdapter(db);
}

function params(id: string, name: string): unknown[] {
	return [id, name, "anthropic", 1_700_000_000_000, 0];
}

describe("buildNameGuardedInsert", () => {
	it("rewrites VALUES into a guarded SELECT", () => {
		const guarded = buildNameGuardedInsert(
			"INSERT INTO accounts (id, name) VALUES (?, ?)",
		);
		expect(guarded).toBe(
			"INSERT INTO accounts (id, name) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE name = ?)",
		);
	});

	it("handles multi-line SQL with literals in the tuple and trailing whitespace", () => {
		const guarded = buildNameGuardedInsert(`
			INSERT INTO accounts (id, name, request_count)
			VALUES (?, ?, 0)
		`);
		expect(guarded).toContain("SELECT ?, ?, 0 WHERE NOT EXISTS");
		expect(guarded).toContain("SELECT 1 FROM accounts WHERE name = ?)");
		expect(guarded).not.toContain("VALUES");
	});

	it("REFUSES a statement it cannot guard rather than writing unguarded", () => {
		// Failing loudly is the point: a silently unguarded insert is the bug.
		expect(() =>
			buildNameGuardedInsert("INSERT INTO accounts (id) SELECT id FROM other"),
		).toThrow();
		expect(() =>
			buildNameGuardedInsert(
				"INSERT INTO accounts (id, name) VALUES (?, ?), (?, ?)",
			),
		).toThrow();
	});
});

describe("insertAccountUnique", () => {
	it("inserts when the name is free", async () => {
		const adapter = makeDb();
		await insertAccountUnique(
			adapter,
			INSERT_SQL,
			params("a", "first"),
			"first",
		);
		const row = await adapter.get<{ id: string }>(
			"SELECT id FROM accounts WHERE name = ?",
			["first"],
		);
		expect(row?.id).toBe("a");
	});

	it("refuses a duplicate name and writes nothing", async () => {
		const adapter = makeDb();
		await insertAccountUnique(adapter, INSERT_SQL, params("a", "dup"), "dup");
		await expect(
			insertAccountUnique(adapter, INSERT_SQL, params("b", "dup"), "dup"),
		).rejects.toBeInstanceOf(DuplicateAccountNameError);

		const rows = await adapter.query<{ id: string }>(
			"SELECT id FROM accounts",
			[],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("a");
	});

	it("is GLOBALLY keyed, not provider-scoped", async () => {
		const adapter = makeDb();
		await insertAccountUnique(
			adapter,
			INSERT_SQL,
			params("a", "shared"),
			"shared",
		);
		await expect(
			insertAccountUnique(
				adapter,
				INSERT_SQL,
				["b", "shared", "codex", 1_700_000_000_000, 0],
				"shared",
			),
		).rejects.toBeInstanceOf(DuplicateAccountNameError);
	});

	it("survives CONCURRENT adds of the same name — exactly one wins", async () => {
		const adapter = makeDb();
		const attempts = await Promise.allSettled(
			["a", "b", "c", "d", "e"].map((id) =>
				insertAccountUnique(adapter, INSERT_SQL, params(id, "race"), "race"),
			),
		);
		const fulfilled = attempts.filter((r) => r.status === "fulfilled");
		expect(fulfilled).toHaveLength(1);
		for (const rejected of attempts.filter((r) => r.status === "rejected")) {
			expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
				DuplicateAccountNameError,
			);
		}

		const rows = await adapter.query<{ id: string }>(
			"SELECT id FROM accounts",
			[],
		);
		expect(rows).toHaveLength(1);
	});

	it("maps to a 400 BadRequest shape via the statusCode carried on the error", async () => {
		const adapter = makeDb();
		await insertAccountUnique(
			adapter,
			INSERT_SQL,
			params("a", "taken"),
			"taken",
		);
		try {
			await insertAccountUnique(
				adapter,
				INSERT_SQL,
				params("b", "taken"),
				"taken",
			);
			throw new Error("expected a duplicate rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(DuplicateAccountNameError);
			expect((error as DuplicateAccountNameError).statusCode).toBe(400);
			// Same wording as the Anthropic begin() pre-check.
			expect((error as Error).message).toContain("already exists");
		}
	});
});

/**
 * Every production account-insert site must route through the helper. Checked
 * against the source, because an insert that silently bypasses the guard is
 * exactly the regression this commit exists to prevent — and a bypass would not
 * fail any behavioural test.
 */
describe("all production INSERT INTO accounts sites are guarded", () => {
	const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..");
	const files = [
		["packages/http-api/src/handlers/accounts.ts", 10],
		["packages/http-api/src/handlers/oauth.ts", 2],
		["packages/oauth-flow/src/index.ts", 2],
	] as const;

	for (const [relative, expected] of files) {
		it(`${relative} routes all ${expected} inserts through insertAccountUnique`, () => {
			const source = readFileSync(join(repoRoot, relative), "utf8");
			const inserts = source.split("INSERT INTO accounts").length - 1;
			const guarded = source.split("insertAccountUnique(").length - 1;
			expect(inserts).toBe(expected);
			expect(guarded).toBe(expected);
			// No raw `.run(` immediately preceding an accounts insert.
			expect(source).not.toMatch(/\.run\(\s*\n\s*`[^`]*INSERT INTO accounts/);
		});
	}
});
