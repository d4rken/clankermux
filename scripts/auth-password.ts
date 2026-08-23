#!/usr/bin/env bun
/**
 * Set or clear the management password that gates `/api/*`.
 *
 * This is the ONLY way to set it, and that is deliberate. While the deployment
 * is fail-open, an HTTP setter would let any caller who can reach the port win
 * the first-set race and lock the operator out of their own box; requiring
 * shell access on the machine the database lives on makes "who may set the
 * password" the same question as "who owns the deployment".
 *
 * It is also the recovery path: clearing the password returns the deployment to
 * fail-open, which is what an operator who has forgotten it needs.
 *
 * Two safety properties matter more than convenience here:
 *
 *  - The resolved ABSOLUTE path is ALWAYS printed, symlinks included.
 *    `resolveDbPath()` reads a per-user platform config directory, so the same
 *    command run as a different user names a different file.
 *  - A missing database is a hard error, never created, and an existing file
 *    that is not recognisably a ClankerMux database is refused rather than
 *    migrated. Either one, taken silently, would print every success message
 *    while the deployment the operator meant to protect stayed open.
 *
 * Usage:
 *   bun run auth:password --set              # prompt twice, no echo
 *   bun run auth:password --clear            # back to fail-open
 *   bun run auth:password --status
 *   bun run auth:password --set --db-path /path/to/clankermux.db
 */

import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
	AuthRepository,
	BunSqlAdapter,
	resolveDbPath,
	runMigrations,
} from "@clankermux/database";
import { scryptPasswordHasher } from "@clankermux/http-api";

/** Shortest password the CLI will store. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * What a ClankerMux database must already contain before this command will
 * touch it.
 *
 * `existsSync` is not a check. An empty file, a placeholder, or somebody
 * else's SQLite database all pass it, and `runMigrations()` would then happily
 * CREATE the whole ClankerMux schema there — printing "Password set." over a
 * database the deployment has never heard of, while the real one stays
 * unprotected. That is the worst failure this control can have, because it
 * fails silently in the reassuring direction.
 *
 * These two tables and their columns predate the auth tables and are present
 * in every schema back to the supported floor (see schema-floor.fixture.ts), so
 * requiring them still lets an operator set a password on a database that has
 * not been migrated yet, which is the case the migration call exists for.
 */
const REQUIRED_SCHEMA: ReadonlyArray<{
	table: string;
	columns: readonly string[];
}> = [
	{ table: "accounts", columns: ["id", "name", "provider", "api_key"] },
	{ table: "requests", columns: ["id", "timestamp", "method", "path"] },
];

/**
 * Null when `db` is recognisably a ClankerMux database, otherwise a sentence
 * naming what is missing.
 */
export function findSchemaProblem(db: Database): string | null {
	const tables = new Set(
		(
			db
				.query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
				.all() as Array<{ name: string }>
		).map((row) => row.name),
	);
	if (tables.size === 0) {
		return "It has no tables at all — an empty or newly created file.";
	}
	for (const { table, columns } of REQUIRED_SCHEMA) {
		if (!tables.has(table)) {
			return `It has no "${table}" table.`;
		}
		const present = new Set(
			(
				db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
			).map((row) => row.name),
		);
		const missing = columns.filter((column) => !present.has(column));
		if (missing.length > 0) {
			return `Its "${table}" table is missing: ${missing.join(", ")}.`;
		}
	}
	return null;
}

export type AuthPasswordAction = "set" | "clear" | "status";

export interface AuthPasswordOptions {
	action: AuthPasswordAction;
	dbPath: string;
}

/** Parsed from argv, or a message explaining why it could not be. */
export type ParsedArgs =
	| { ok: true; options: AuthPasswordOptions }
	| { ok: false; error: string };

export function parseArgs(argv: string[]): ParsedArgs {
	let action: AuthPasswordAction | null = null;
	let dbPath: string | null = null;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--set":
			case "--clear":
			case "--status": {
				const next = arg.slice(2) as AuthPasswordAction;
				if (action !== null && action !== next) {
					return {
						ok: false,
						error: `--${action} and ${arg} cannot be combined.`,
					};
				}
				action = next;
				break;
			}
			case "--db-path": {
				const value = argv[++i];
				if (!value) return { ok: false, error: "--db-path needs a value." };
				dbPath = value;
				break;
			}
			default:
				return { ok: false, error: `Unknown argument: ${arg}` };
		}
	}

	if (action === null) {
		return { ok: false, error: "One of --set, --clear or --status is required." };
	}
	return { ok: true, options: { action, dbPath: dbPath ?? resolveDbPath() } };
}

/** Everything the command writes, injected so a test can capture it. */
export interface AuthPasswordIo {
	print(line: string): void;
	/** Prompt for a password with no echo. Only called for `--set`. */
	readPassword(prompt: string): Promise<string>;
}

/**
 * Run one command against `dbPath`. Returns a process exit code.
 *
 * Separated from argv parsing and from the terminal so the behaviour that
 * matters — refusing a missing database, requiring the two entries to match,
 * revoking sessions on rotation — is testable without a TTY.
 */
export async function runAuthPasswordCommand(
	options: AuthPasswordOptions,
	io: AuthPasswordIo,
): Promise<number> {
	// Always absolute: a relative path names a different file per working
	// directory, and this message is the operator's only confirmation of WHICH
	// deployment they are about to change.
	const dbPath = resolve(options.dbPath);
	io.print(`Database: ${dbPath}`);

	if (!existsSync(dbPath)) {
		io.print("");
		io.print("No database at that path.");
		io.print(
			"Refusing to create one: a fresh empty database would accept every command",
		);
		io.print(
			"and change nothing about the deployment you meant to protect. Start the",
		);
		io.print(
			"server once as the user that owns it, or pass --db-path explicitly.",
		);
		return 1;
	}

	// Symlinks are resolved and reported, so "which file" is unambiguous even
	// when the path given was a link.
	const canonicalPath = realpathSync(dbPath);
	if (canonicalPath !== dbPath) {
		io.print(`Resolved through symlinks to: ${canonicalPath}`);
	}

	const db = new Database(canonicalPath, { readwrite: true, create: false });
	try {
		const problem = findSchemaProblem(db);
		if (problem) {
			io.print("");
			io.print("That file is not a ClankerMux database.");
			io.print(problem);
			io.print(
				"Refusing to migrate it: creating our schema on an empty or unrelated",
			);
			io.print(
				"file would report a password was set while the deployment you meant to",
			);
			io.print(
				"protect stayed open — and would modify a database that is not ours.",
			);
			io.print(`Checked: ${canonicalPath}`);
			return 1;
		}

		// Bring the schema forward: on a database created before the auth tables
		// existed, `--set` has to work without waiting for a server restart.
		runMigrations(db);
		const repo = new AuthRepository(new BunSqlAdapter(db));
		const existing = await repo.getPassword();

		if (options.action === "status") {
			io.print(
				existing
					? `A management password is set (updated ${new Date(existing.updatedAt).toISOString()}).`
					: "No management password is set — the management API is UNPROTECTED.",
			);
			return 0;
		}

		if (options.action === "clear") {
			if (!existing) {
				io.print("No management password was set; nothing to clear.");
				return 0;
			}
			const revoked = await repo.clearPassword();
			io.print(
				`Cleared. The management API is now UNPROTECTED; ${revoked} session(s) revoked.`,
			);
			return 0;
		}

		io.print(
			existing
				? "Replacing the existing management password."
				: "Setting a management password.",
		);
		const first = await io.readPassword("New password: ");
		if (first.length < MIN_PASSWORD_LENGTH) {
			io.print(
				`Password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`,
			);
			return 1;
		}
		const second = await io.readPassword("Repeat password: ");
		if (first !== second) {
			io.print("Passwords did not match. Nothing was changed.");
			return 1;
		}

		const { verifier, params } = await scryptPasswordHasher.hash(first);
		const revoked = await repo.setPassword(verifier, params, Date.now());
		io.print(
			`Password set. ${revoked} existing session(s) revoked; everyone must sign in again.`,
		);
		return 0;
	} finally {
		db.close();
	}
}

/** Read a line from a TTY without echoing it. */
async function readPasswordFromTty(prompt: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		throw new Error(
			"A password can only be entered interactively; stdin is not a terminal.",
		);
	}
	process.stdout.write(prompt);
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");

	return await new Promise<string>((resolve, reject) => {
		let buffer = "";
		const finish = (fn: () => void) => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stdout.write("\n");
			fn();
		};
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n") {
					finish(() => resolve(buffer));
					return;
				}
				if (ch === "\u0003") {
					// Ctrl-C: leave the terminal as we found it before bailing.
					finish(() => reject(new Error("Aborted.")));
					return;
				}
				if (ch === "\u007f" || ch === "\b") {
					buffer = buffer.slice(0, -1);
					continue;
				}
				buffer += ch;
			}
		};
		stdin.on("data", onData);
	});
}

const USAGE = `Set or clear the ClankerMux management password.

  bun run auth:password --set     Prompt twice (no echo) and store it
  bun run auth:password --clear   Remove it; the management API becomes open
  bun run auth:password --status  Report whether one is set

  --db-path <file>                Operate on a specific database`;

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	if (!parsed.ok) {
		console.error(parsed.error);
		console.error("");
		console.error(USAGE);
		process.exit(1);
	}

	const code = await runAuthPasswordCommand(parsed.options, {
		print: (line) => {
			console.log(line);
		},
		readPassword: readPasswordFromTty,
	});
	process.exit(code);
}

// Only run when invoked directly, so the test can import the pieces above.
if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
