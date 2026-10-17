import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";

function hasColumn(db: Database): boolean {
	return (
		db.prepare("PRAGMA table_info(routing_attempts)").all() as Array<{
			name: string;
		}>
	).some((column) => column.name === "ignored_fields");
}

describe("routing_attempts.ignored_fields", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => db.close());

	it("is present for fresh databases", () => {
		ensureSchema(db);
		expect(hasColumn(db)).toBe(true);
	});

	it("is added to a database created without it, leaving earlier rows NULL", () => {
		ensureSchema(db);
		db.run("ALTER TABLE routing_attempts DROP COLUMN ignored_fields");
		expect(hasColumn(db)).toBe(false);
		db.run("INSERT INTO routing_snapshots(id,content) VALUES('snapshot','{}')");
		db.run(
			`INSERT INTO routing_attempts(id,request_id,route_snapshot_id,requested_model,kind,started_at)
			 VALUES('historical','request','snapshot','gpt-6-astra','upstream_send',10)`,
		);

		runMigrations(db);

		expect(hasColumn(db)).toBe(true);
		expect(() => runMigrations(db)).not.toThrow();
		expect(
			db
				.prepare(
					"SELECT ignored_fields FROM routing_attempts WHERE id='historical'",
				)
				.get(),
		).toEqual({ ignored_fields: null });
	});
});
