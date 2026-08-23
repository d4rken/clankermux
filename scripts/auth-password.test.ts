/**
 * The password CLI.
 *
 * This is the only way to set the management password and the only way to
 * recover from a forgotten one, so the cases that matter are the ones where it
 * must NOT quietly succeed: a database that is not there, two entries that do
 * not match, a password too short to be worth hashing. Each of those printing a
 * success message while changing nothing is the failure mode.
 *
 * The missing-database case is the sharpest. `resolveDbPath()` reads a per-user
 * platform config directory, so running this as the wrong user names a file
 * that does not exist; creating it would report success on a database the
 * deployment has never heard of.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";
import {
	AuthRepository,
	BunSqlAdapter,
	ensureSchema,
} from "@clankermux/database";
import { FLOOR_SCHEMA_SQL } from "../packages/database/src/__tests__/schema-floor.fixture";
import { scryptPasswordHasher } from "@clankermux/http-api";
import {
	type AuthPasswordIo,
	MIN_PASSWORD_LENGTH,
	parseArgs,
	runAuthPasswordCommand,
} from "./auth-password";

let dir: string;
let dbPath: string;

beforeEach(() => {
	// realpath: on some platforms the temp directory is itself a symlink, and
	// the CLI reports the canonical path.
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cmx-auth-cli-")));
	dbPath = join(dir, "clankermux.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Create the database the CLI is allowed to operate on. */
function createDb(): void {
	const db = new Database(dbPath, { create: true });
	ensureSchema(db);
	db.close();
}

function openRepo(): { repo: AuthRepository; close: () => void } {
	const db = new Database(dbPath, { readwrite: true, create: false });
	return { repo: new AuthRepository(new BunSqlAdapter(db)), close: () => db.close() };
}

function io(passwords: string[]): AuthPasswordIo & { lines: string[] } {
	const lines: string[] = [];
	let index = 0;
	return {
		lines,
		print: (line) => {
			lines.push(line);
		},
		readPassword: async () => passwords[index++] ?? "",
	};
}

describe("argument parsing", () => {
	it("requires an action", () => {
		expect(parseArgs([])).toMatchObject({ ok: false });
	});

	it("rejects contradictory actions", () => {
		expect(parseArgs(["--set", "--clear"])).toMatchObject({ ok: false });
	});

	it("rejects an unknown flag rather than ignoring it", () => {
		expect(parseArgs(["--set", "--force"])).toMatchObject({ ok: false });
	});

	it("requires a value after --db-path", () => {
		expect(parseArgs(["--set", "--db-path"])).toMatchObject({ ok: false });
	});

	it("accepts an explicit database path", () => {
		const parsed = parseArgs(["--set", "--db-path", "/tmp/x.db"]);
		expect(parsed).toEqual({
			ok: true,
			options: { action: "set", dbPath: "/tmp/x.db" },
		});
	});

	it("falls back to the resolved default path", () => {
		const parsed = parseArgs(["--status"]);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.options.dbPath).toContain("clankermux.db");
	});
});

describe("a missing database is refused, never created", () => {
	it("exits non-zero and creates nothing", async () => {
		const out = io(["hunter2hunter2", "hunter2hunter2"]);
		const code = await runAuthPasswordCommand(
			{ action: "set", dbPath },
			out,
		);
		expect(code).toBe(1);
		expect(out.lines.join("\n")).toContain("Refusing to create one");
		expect(
			await Bun.file(dbPath)
				.exists()
				.catch(() => false),
		).toBe(false);
	});

	it("never prompts for a password it could not store", async () => {
		let prompts = 0;
		await runAuthPasswordCommand(
			{ action: "set", dbPath },
			{
				print: () => {},
				readPassword: async () => {
					prompts++;
					return "hunter2hunter2";
				},
			},
		);
		expect(prompts).toBe(0);
	});
});

describe("the resolved path is always reported", () => {
	it("prints it before anything else", async () => {
		createDb();
		const out = io([]);
		await runAuthPasswordCommand({ action: "status", dbPath }, out);
		expect(out.lines[0]).toBe(`Database: ${dbPath}`);
	});

	it("prints it even when the database is missing", async () => {
		const out = io([]);
		await runAuthPasswordCommand({ action: "status", dbPath }, out);
		expect(out.lines[0]).toBe(`Database: ${dbPath}`);
	});
});

describe("--status", () => {
	it("reports an unprotected deployment in those words", async () => {
		createDb();
		const out = io([]);
		expect(
			await runAuthPasswordCommand({ action: "status", dbPath }, out),
		).toBe(0);
		expect(out.lines.join("\n")).toContain("UNPROTECTED");
	});

	it("reports a configured password", async () => {
		createDb();
		const { repo, close } = openRepo();
		await repo.setPassword("v", "{}", 1_700_000_000_000);
		close();
		const out = io([]);
		await runAuthPasswordCommand({ action: "status", dbPath }, out);
		expect(out.lines.join("\n")).toContain("A management password is set");
	});
});

describe("--set", () => {
	it("stores a verifier that the shared hasher accepts", async () => {
		createDb();
		const out = io(["correct horse", "correct horse"]);
		expect(await runAuthPasswordCommand({ action: "set", dbPath }, out)).toBe(0);

		const { repo, close } = openRepo();
		const stored = await repo.getPassword();
		close();
		expect(stored).not.toBeNull();
		if (!stored) return;
		expect(
			await scryptPasswordHasher.verify(
				"correct horse",
				stored.verifier,
				stored.params,
			),
		).toBe(true);
		expect(
			await scryptPasswordHasher.verify(
				"wrong horse",
				stored.verifier,
				stored.params,
			),
		).toBe(false);
	});

	it("never stores the password itself", async () => {
		createDb();
		await runAuthPasswordCommand(
			{ action: "set", dbPath },
			io(["correct horse", "correct horse"]),
		);
		const { repo, close } = openRepo();
		const stored = await repo.getPassword();
		close();
		expect(JSON.stringify(stored)).not.toContain("correct horse");
	});

	it("changes nothing when the two entries differ", async () => {
		createDb();
		const out = io(["correct horse", "correct hors"]);
		expect(await runAuthPasswordCommand({ action: "set", dbPath }, out)).toBe(1);
		expect(out.lines.join("\n")).toContain("did not match");

		const { repo, close } = openRepo();
		expect(await repo.getPassword()).toBeNull();
		close();
	});

	it("refuses a password shorter than the minimum without hashing it", async () => {
		createDb();
		const out = io(["short", "short"]);
		expect(await runAuthPasswordCommand({ action: "set", dbPath }, out)).toBe(1);
		expect(out.lines.join("\n")).toContain(String(MIN_PASSWORD_LENGTH));

		const { repo, close } = openRepo();
		expect(await repo.getPassword()).toBeNull();
		close();
	});

	it("revokes every session it replaces", async () => {
		createDb();
		const { repo, close } = openRepo();
		await repo.setPassword("old", "{}", 1);
		await repo.createSession({
			tokenHash: "a",
			createdAt: 1,
			expiresAt: 2_000_000_000_000,
			lastSeenAt: 1,
		});
		close();

		const out = io(["a new password", "a new password"]);
		expect(await runAuthPasswordCommand({ action: "set", dbPath }, out)).toBe(0);
		expect(out.lines.join("\n")).toContain("1 existing session(s) revoked");

		const after = openRepo();
		expect(await after.repo.getSession("a")).toBeNull();
		after.close();
	});

	it("works on a database at the supported schema floor", async () => {
		// The oldest schema we support: a clone from when the repository went
		// public, with no auth tables yet. A live deployment picks those up on its
		// next restart, and the operator must be able to set a password first.
		const db = new Database(dbPath, { create: true });
		db.exec(FLOOR_SCHEMA_SQL);
		db.close();

		expect(
			await runAuthPasswordCommand(
				{ action: "set", dbPath },
				io(["a new password", "a new password"]),
			),
		).toBe(0);
		const { repo, close } = openRepo();
		expect(await repo.getPassword()).not.toBeNull();
		close();
	});
});

describe("a file that is not a ClankerMux database is refused, not adopted", () => {
	/**
	 * The failure this guards is the reassuring one: `existsSync` passes,
	 * `runMigrations()` creates the whole schema, and the command reports the
	 * password was set — while the real deployment is untouched and still open,
	 * and somebody else's database has been rewritten.
	 */
	async function attemptSet(): Promise<{ code: number; output: string }> {
		const out = io(["a new password", "a new password"]);
		const code = await runAuthPasswordCommand({ action: "set", dbPath }, out);
		return { code, output: out.lines.join("\n") };
	}

	it("refuses a zero-byte file and creates no schema in it", async () => {
		await Bun.write(dbPath, "");
		const { code, output } = await attemptSet();
		expect(code).toBe(1);
		expect(output).toContain("not a ClankerMux database");
		expect(output).toContain("no tables at all");

		const db = new Database(dbPath, { readwrite: true, create: false });
		const tables = db
			.query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
			.all();
		db.close();
		expect(tables).toEqual([]);
	});

	it("refuses an unrelated SQLite database without modifying it", async () => {
		const db = new Database(dbPath, { create: true });
		db.run("CREATE TABLE placeholder (id INTEGER PRIMARY KEY)");
		db.close();

		const { code, output } = await attemptSet();
		expect(code).toBe(1);
		expect(output).toContain('no "accounts" table');

		const after = new Database(dbPath, { readwrite: true, create: false });
		const tables = (
			after
				.query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		after.close();
		expect(tables).toEqual(["placeholder"]);
	});

	it("refuses a database whose accounts table is somebody else's", async () => {
		const db = new Database(dbPath, { create: true });
		db.run("CREATE TABLE accounts (id TEXT PRIMARY KEY, balance REAL)");
		db.run("CREATE TABLE requests (id TEXT PRIMARY KEY)");
		db.close();

		const { code, output } = await attemptSet();
		expect(code).toBe(1);
		expect(output).toContain('Its "accounts" table is missing');
	});

	it("never prompts for a password it is not going to store", async () => {
		await Bun.write(dbPath, "");
		let prompts = 0;
		const code = await runAuthPasswordCommand(
			{ action: "set", dbPath },
			{
				print: () => {},
				readPassword: async () => {
					prompts++;
					return "a new password";
				},
			},
		);
		expect(code).toBe(1);
		expect(prompts).toBe(0);
	});

	it("names the absolute path it checked", async () => {
		await Bun.write(dbPath, "");
		const out = io([]);
		await runAuthPasswordCommand({ action: "status", dbPath }, out);
		expect(out.lines.join("\n")).toContain(`Checked: ${dbPath}`);
	});

	it("reports an absolute path even when given a relative one", async () => {
		createDb();
		const relative = relativePath(process.cwd(), dbPath);
		const out = io([]);
		await runAuthPasswordCommand({ action: "status", dbPath: relative }, out);
		expect(out.lines[0]).toBe(`Database: ${dbPath}`);
	});
});

describe("--clear", () => {
	it("returns the deployment to fail-open and revokes sessions", async () => {
		createDb();
		const { repo, close } = openRepo();
		await repo.setPassword("v", "{}", 1);
		await repo.createSession({
			tokenHash: "a",
			createdAt: 1,
			expiresAt: 2_000_000_000_000,
			lastSeenAt: 1,
		});
		close();

		const out = io([]);
		expect(await runAuthPasswordCommand({ action: "clear", dbPath }, out)).toBe(
			0,
		);
		expect(out.lines.join("\n")).toContain("UNPROTECTED");
		expect(out.lines.join("\n")).toContain("1 session(s) revoked");

		const after = openRepo();
		expect(await after.repo.getPassword()).toBeNull();
		expect(await after.repo.getSession("a")).toBeNull();
		after.close();
	});

	it("is a no-op, not an error, when nothing was set", async () => {
		createDb();
		const out = io([]);
		expect(await runAuthPasswordCommand({ action: "clear", dbPath }, out)).toBe(
			0,
		);
		expect(out.lines.join("\n")).toContain("nothing to clear");
	});

	it("cannot be undone into reactivating the old sessions", async () => {
		createDb();
		const { repo, close } = openRepo();
		await repo.setPassword("v", "{}", 1);
		await repo.createSession({
			tokenHash: "a",
			createdAt: 1,
			expiresAt: 2_000_000_000_000,
			lastSeenAt: 1,
		});
		close();

		await runAuthPasswordCommand({ action: "clear", dbPath }, io([]));
		await runAuthPasswordCommand(
			{ action: "set", dbPath },
			io(["a new password", "a new password"]),
		);

		const after = openRepo();
		expect(await after.repo.getSession("a")).toBeNull();
		after.close();
	});
});
