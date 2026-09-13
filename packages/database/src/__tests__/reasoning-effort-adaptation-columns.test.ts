import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";

const COLUMNS = [
	"reasoning_effort_requested",
	"reasoning_effort_effective",
	"reasoning_effort_reason",
] as const;

function columnNames(db: Database): Set<string> {
	return new Set(
		(
			db.prepare("PRAGMA table_info(routing_attempts)").all() as Array<{
				name: string;
			}>
		).map((column) => column.name),
	);
}

describe("routing_attempts reasoning-effort columns", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => db.close());

	it("are present for fresh databases", () => {
		ensureSchema(db);
		const cols = columnNames(db);
		for (const column of COLUMNS) expect(cols.has(column)).toBe(true);
	});

	it("are added to a database created without them, and re-running is a no-op", () => {
		ensureSchema(db);
		for (const column of COLUMNS) {
			db.run(`ALTER TABLE routing_attempts DROP COLUMN ${column}`);
		}
		const dropped = columnNames(db);
		for (const column of COLUMNS) expect(dropped.has(column)).toBe(false);

		runMigrations(db);
		const restored = columnNames(db);
		for (const column of COLUMNS) expect(restored.has(column)).toBe(true);
		expect(() => runMigrations(db)).not.toThrow();
		expect(columnNames(db)).toEqual(restored);
	});

	it("leave rows written before they existed NULL rather than defaulted", () => {
		ensureSchema(db);
		for (const column of COLUMNS) {
			db.run(`ALTER TABLE routing_attempts DROP COLUMN ${column}`);
		}
		db.run("INSERT INTO routing_snapshots(id,content) VALUES('snapshot','{}')");
		db.run(
			`INSERT INTO routing_attempts(id,request_id,route_snapshot_id,requested_model,kind,started_at)
			 VALUES('historical','request','snapshot','claude-sonnet-4-5','upstream_send',10)`,
		);

		runMigrations(db);

		expect(
			db
				.prepare(
					`SELECT reasoning_effort_requested, reasoning_effort_effective, reasoning_effort_reason
					 FROM routing_attempts WHERE id='historical'`,
				)
				.get(),
		).toEqual({
			reasoning_effort_requested: null,
			reasoning_effort_effective: null,
			reasoning_effort_reason: null,
		});
	});
});
