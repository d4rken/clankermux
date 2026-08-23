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
 *  - The resolved database path is ALWAYS printed. `resolveDbPath()` reads a
 *    per-user platform config directory, so the same command run as a different
 *    user names a different file.
 *  - A missing database is a hard error, never created. Silently creating an
 *    empty one would print every success message while changing nothing about
 *    the deployment the operator meant to protect.
 *
 * Usage:
 *   bun run auth:password --set              # prompt twice, no echo
 *   bun run auth:password --clear            # back to fail-open
 *   bun run auth:password --status
 *   bun run auth:password --set --db-path /path/to/clankermux.db
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
	AuthRepository,
	BunSqlAdapter,
	resolveDbPath,
	runMigrations,
} from "@clankermux/database";
import { scryptPasswordHasher } from "@clankermux/http-api";

/** Shortest password the CLI will store. */
export const MIN_PASSWORD_LENGTH = 8;

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
	io.print(`Database: ${options.dbPath}`);

	if (!existsSync(options.dbPath)) {
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

	const db = new Database(options.dbPath, { readwrite: true, create: false });
	try {
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
