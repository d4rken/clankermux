import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency (mirrors account-capacity-restore.test.ts).
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ComboRepository } from "../combo.repository";

function makeRepo(): { db: Database; repo: ComboRepository } {
	const db = new Database(":memory:");
	// Mirrors the production schema in migrations.ts, including the UNIQUE
	// constraints — they are what turns a retried insert into a constraint
	// violation rather than a duplicate row.
	db.run(`
		CREATE TABLE combos (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			description TEXT,
			enabled INTEGER DEFAULT 1,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	db.run(`
		CREATE TABLE combo_slots (
			id TEXT PRIMARY KEY,
			combo_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			model TEXT NOT NULL,
			priority INTEGER NOT NULL,
			enabled INTEGER DEFAULT 1
		)
	`);
	db.run(
		`CREATE UNIQUE INDEX idx_combo_slots_unique ON combo_slots(combo_id, account_id, model)`,
	);
	return { db, repo: new ComboRepository(new BunSqlAdapter(db)) };
}

function countRows(db: Database, table: string): number {
	return (
		db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM ${table}`).get()
			?.n ?? -1
	);
}

describe("ComboRepository", () => {
	let db: Database;
	let repo: ComboRepository;

	beforeEach(() => {
		({ db, repo } = makeRepo());
	});

	// create() and addSlot() use INSERT ... RETURNING so that the write and the
	// read-back are one statement (see withRetryingMethods: repository calls are
	// retried whole, and an id generated inside the method would otherwise be
	// regenerated on retry, leaving a duplicate row). These tests exist to prove
	// RETURNING actually round-trips through bun:sqlite's query().get().
	describe("create", () => {
		it("returns the inserted combo from RETURNING", async () => {
			const combo = await repo.create("my-combo", "a description");

			expect(combo.id).toBeTruthy();
			expect(combo.name).toBe("my-combo");
			expect(combo.description).toBe("a description");
			expect(combo.enabled).toBe(true);
			expect(combo.created_at).toBeGreaterThan(0);
		});

		it("writes exactly one row, matching what it returned", async () => {
			const combo = await repo.create("solo");

			expect(countRows(db, "combos")).toBe(1);
			const found = await repo.findById(combo.id);
			expect(found).toEqual(combo);
		});

		it("defaults a missing description to null", async () => {
			const combo = await repo.create("no-desc");

			expect(combo.description).toBeNull();
		});

		it("gives each combo a distinct id", async () => {
			const a = await repo.create("a");
			const b = await repo.create("b");

			expect(a.id).not.toBe(b.id);
			expect(countRows(db, "combos")).toBe(2);
		});
	});

	describe("addSlot", () => {
		it("returns the inserted slot from RETURNING", async () => {
			const combo = await repo.create("c");

			const slot = await repo.addSlot(combo.id, "acct-1", "claude-opus-5", 3);

			// Combo and ComboSlot both keep the row's snake_case field names.
			expect(slot.id).toBeTruthy();
			expect(slot.combo_id).toBe(combo.id);
			expect(slot.account_id).toBe("acct-1");
			expect(slot.model).toBe("claude-opus-5");
			expect(slot.priority).toBe(3);
			expect(slot.enabled).toBe(true);
		});

		it("writes exactly one row, retrievable via getSlots", async () => {
			const combo = await repo.create("c");

			const slot = await repo.addSlot(combo.id, "acct-1", "claude-opus-5", 0);

			expect(countRows(db, "combo_slots")).toBe(1);
			expect(await repo.getSlots(combo.id)).toEqual([slot]);
		});

		it("keeps slots of different combos separate", async () => {
			const a = await repo.create("a");
			const b = await repo.create("b");

			await repo.addSlot(a.id, "acct-1", "claude-opus-5", 0);
			await repo.addSlot(b.id, "acct-2", "claude-sonnet-5", 0);

			expect((await repo.getSlots(a.id)).map((s) => s.account_id)).toEqual([
				"acct-1",
			]);
			expect((await repo.getSlots(b.id)).map((s) => s.account_id)).toEqual([
				"acct-2",
			]);
		});
	});

	describe("update", () => {
		it("applies absolute values and returns the updated combo", async () => {
			const combo = await repo.create("before", "old");

			const updated = await repo.update(combo.id, {
				name: "after",
				description: null,
				enabled: false,
			});

			expect(updated.id).toBe(combo.id);
			expect(updated.name).toBe("after");
			expect(updated.description).toBeNull();
			expect(updated.enabled).toBe(false);
			expect(countRows(db, "combos")).toBe(1);
		});

		it("is idempotent when applied twice", async () => {
			// update() is an absolute-value UPDATE, which is what makes it safe to
			// re-run under the repository retry wrapper.
			const combo = await repo.create("x");

			const once = await repo.update(combo.id, { name: "y" });
			const twice = await repo.update(combo.id, { name: "y" });

			expect(twice.name).toBe(once.name);
			expect(countRows(db, "combos")).toBe(1);
		});
	});

	describe("updateSlot", () => {
		it("updates only the supplied fields", async () => {
			const combo = await repo.create("c");
			const slot = await repo.addSlot(combo.id, "acct-1", "claude-opus-5", 1);

			const updated = await repo.updateSlot(slot.id, { priority: 9 });

			expect(updated.priority).toBe(9);
			expect(updated.model).toBe("claude-opus-5");
			expect(updated.account_id).toBe("acct-1");
		});

		it("throws when given no fields", async () => {
			const combo = await repo.create("c");
			const slot = await repo.addSlot(combo.id, "acct-1", "claude-opus-5", 0);

			await expect(repo.updateSlot(slot.id, {})).rejects.toThrow(
				"no fields to update",
			);
		});
	});

	describe("removeSlot / delete", () => {
		it("removes a slot without touching its combo", async () => {
			const combo = await repo.create("c");
			const slot = await repo.addSlot(combo.id, "acct-1", "claude-opus-5", 0);

			await repo.removeSlot(slot.id);

			expect(await repo.getSlots(combo.id)).toEqual([]);
			expect(await repo.findById(combo.id)).not.toBeNull();
		});

		it("deletes a combo", async () => {
			const combo = await repo.create("c");

			await repo.delete(combo.id);

			expect(await repo.findById(combo.id)).toBeNull();
			expect(countRows(db, "combos")).toBe(0);
		});
	});
});
