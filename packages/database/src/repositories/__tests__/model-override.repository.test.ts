/**
 * Tests for ModelOverrideRepository — the operator's per-dialect curation of
 * `GET /v1/models`.
 *
 * Run against a REAL file database built by ensureSchema(), so the CHECK
 * constraints and the composite primary key are the deployed ones rather than a
 * hand-written approximation of them.
 *
 * The properties that matter to the callers:
 *  - upsert is a full replacement of the mutable fields, and PRESERVES
 *    created_at, which is the ordering key custom entries are appended by
 *  - the dialect is part of the identity: the same model id in both dialects is
 *    two independent rows
 *  - the flags are constrained (0/1 only, never both set) and the dialect enum
 *    is enforced, so a corrupt row cannot reach the wire route
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

	it("stores and lists a hidden baseline row", async () => {
		await repo.upsert({
			dialect: "anthropic",
			modelId: "claude-opus-4-1-20250805",
			hidden: true,
			custom: false,
			displayName: null,
			now: NOW,
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

	it("stores a custom row with a display name", async () => {
		await repo.upsert({
			dialect: "openai",
			modelId: "gpt-5.6-nova",
			hidden: false,
			custom: true,
			displayName: "GPT-5.6 Nova",
			now: NOW,
		});

		const rows = await repo.listByDialect("openai");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.custom).toBe(1);
		expect(rows[0]?.display_name).toBe("GPT-5.6 Nova");
	});

	// created_at is the order custom entries are appended in, so an edit must not
	// move a row to the end of the list the operator is looking at.
	it("preserves created_at across an upsert and advances updated_at", async () => {
		await repo.upsert({
			dialect: "openai",
			modelId: "gpt-5.6-nova",
			hidden: false,
			custom: true,
			displayName: "First",
			now: NOW,
		});
		await repo.upsert({
			dialect: "openai",
			modelId: "gpt-5.6-nova",
			hidden: false,
			custom: true,
			displayName: "Second",
			now: NOW + 60_000,
		});

		const rows = await repo.listByDialect("openai");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.display_name).toBe("Second");
		expect(rows[0]?.created_at).toBe(NOW);
		expect(rows[0]?.updated_at).toBe(NOW + 60_000);
	});

	it("clears a display name when the upsert carries null", async () => {
		await repo.upsert({
			dialect: "anthropic",
			modelId: "claude-opus-5",
			hidden: false,
			custom: false,
			displayName: "Renamed",
			now: NOW,
		});
		await repo.upsert({
			dialect: "anthropic",
			modelId: "claude-opus-5",
			hidden: true,
			custom: false,
			displayName: null,
			now: NOW + 1,
		});

		const rows = await repo.listByDialect("anthropic");
		expect(rows[0]?.display_name).toBeNull();
		expect(rows[0]?.hidden).toBe(1);
	});

	it("keeps the two dialects independent", async () => {
		await repo.upsert({
			dialect: "anthropic",
			modelId: "shared-id",
			hidden: true,
			custom: false,
			displayName: null,
			now: NOW,
		});
		await repo.upsert({
			dialect: "openai",
			modelId: "shared-id",
			hidden: false,
			custom: true,
			displayName: "Only here",
			now: NOW,
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
			await repo.upsert({
				dialect: "openai",
				modelId: id,
				hidden: false,
				custom: true,
				displayName: null,
				now: NOW + index * 1000,
			});
		}

		const rows = await repo.listByDialect("openai");
		expect(rows.map((row) => row.model_id)).toEqual(["c", "a", "b"]);
	});

	it("removes only the addressed row", async () => {
		await repo.upsert({
			dialect: "openai",
			modelId: "keep",
			hidden: true,
			custom: false,
			displayName: null,
			now: NOW,
		});
		await repo.upsert({
			dialect: "openai",
			modelId: "drop",
			hidden: true,
			custom: false,
			displayName: null,
			now: NOW,
		});

		expect(await repo.remove("openai", "drop")).toBe(true);
		expect(await repo.remove("openai", "drop")).toBe(false);
		expect((await repo.listByDialect("openai")).map((r) => r.model_id)).toEqual(
			["keep"],
		);
	});

	it("rejects an unknown dialect at the schema level", async () => {
		await expect(
			repo.upsert({
				// A dialect the schema does not know can only come from a bug or a
				// hand-edited database; the CHECK is what keeps it out of the wire route.
				dialect: "gemini" as "anthropic",
				modelId: "gemini-3",
				hidden: false,
				custom: true,
				displayName: null,
				now: NOW,
			}),
		).rejects.toThrow();
	});

	it("rejects a row that is both hidden and custom", async () => {
		await expect(
			repo.upsert({
				dialect: "openai",
				modelId: "impossible",
				hidden: true,
				custom: true,
				displayName: null,
				now: NOW,
			}),
		).rejects.toThrow();
	});
});
