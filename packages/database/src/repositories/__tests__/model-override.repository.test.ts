/**
 * Tests for ModelOverrideRepository — the retired per-dialect curation of
 * `GET /v1/models`, now read-only.
 *
 * Nothing writes this table any more, so the fixtures are raw INSERTs: they
 * stand in for rows an upgrading database already holds, which is the only way
 * rows get here now. The one caller left is the pre-2026.9.52 client-catalogue
 * backfill, and what it needs from this repository is the read.
 *
 * Run against a REAL file database built by ensureSchema(), so the composite
 * primary key and the row shape are the deployed ones rather than a
 * hand-written approximation of them.
 *
 * The properties that matter to that caller:
 *  - the dialect is part of the identity: the same model id in both dialects is
 *    two independent rows
 *  - rows come back oldest-first, which is the order custom entries were
 *    appended to the catalogue in
 */
import { Database } from "bun:sqlite";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as codex-reset-credit-event.repository.test.ts.
import "@clankermux/core";
import { tempDbTracker } from "@clankermux/test-support";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { ModelOverrideRepository } from "../model-override.repository";

const tempDbs = tempDbTracker("model-overrides");

const NOW = new Date(2026, 7, 25, 9).getTime();

describe("ModelOverrideRepository", () => {
	let db: Database;
	let repo: ModelOverrideRepository;

	function insert(row: {
		dialect: string;
		modelId: string;
		hidden?: 0 | 1;
		custom?: 0 | 1;
		displayName?: string | null;
		createdAt?: number;
	}): void {
		db.query(
			`INSERT INTO model_overrides
			   (dialect, model_id, hidden, custom, display_name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			row.dialect,
			row.modelId,
			row.hidden ?? 0,
			row.custom ?? 0,
			row.displayName ?? null,
			row.createdAt ?? NOW,
			row.createdAt ?? NOW,
		);
	}

	beforeEach(() => {
		db = new Database(tempDbs.next());
		ensureSchema(db);
		repo = new ModelOverrideRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	afterAll(() => {
		tempDbs.cleanup();
	});

	it("lists a hidden baseline row with every column the caller reads", async () => {
		insert({
			dialect: "anthropic",
			modelId: "claude-opus-4-1-20250805",
			hidden: 1,
		});

		const rows = await repo.listByDialect("anthropic");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			dialect: "anthropic",
			model_id: "claude-opus-4-1-20250805",
			hidden: 1,
			custom: 0,
			display_name: null,
			created_at: NOW,
			updated_at: NOW,
		});
	});

	it("lists a custom row with its display name", async () => {
		insert({
			dialect: "openai",
			modelId: "gpt-5.6-nova",
			custom: 1,
			displayName: "GPT-5.6 Nova",
		});

		const rows = await repo.listByDialect("openai");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.custom).toBe(1);
		expect(rows[0]?.display_name).toBe("GPT-5.6 Nova");
	});

	it("keeps the two dialects independent", async () => {
		insert({ dialect: "anthropic", modelId: "shared-id", hidden: 1 });
		insert({
			dialect: "openai",
			modelId: "shared-id",
			custom: 1,
			displayName: "Only here",
		});

		const anthropic = await repo.listByDialect("anthropic");
		const openai = await repo.listByDialect("openai");
		expect(anthropic).toHaveLength(1);
		expect(openai).toHaveLength(1);
		expect(anthropic[0]?.hidden).toBe(1);
		expect(openai[0]?.display_name).toBe("Only here");
	});

	it("orders rows oldest-first so appended customs keep their order", async () => {
		for (const [index, id] of ["c", "a", "b"].entries()) {
			insert({
				dialect: "openai",
				modelId: id,
				custom: 1,
				createdAt: NOW + index * 1000,
			});
		}

		const rows = await repo.listByDialect("openai");
		expect(rows.map((row) => row.model_id)).toEqual(["c", "a", "b"]);
	});

	it("answers with nothing for a dialect that was never curated", async () => {
		insert({ dialect: "anthropic", modelId: "claude-opus-5", hidden: 1 });

		expect(await repo.listByDialect("openai")).toEqual([]);
	});
});
