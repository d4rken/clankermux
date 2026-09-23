/**
 * `clankermux-server auth password …` runs the password command and nothing
 * else: no server banner, no listener, and no database created at a path that
 * did not exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN_ENTRY = join(import.meta.dir, "..", "main.ts");
const TIMEOUT_MS = 30_000;

let dir: string;

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cmx-main-auth-")));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** The parent environment minus anything that could point at a real deployment. */
function isolatedEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("CLANKERMUX_")) {
			env[key] = value;
		}
	}
	env.CLANKERMUX_LOG_DIR = join(dir, "logs");
	return env;
}

async function runMain(
	args: string[],
): Promise<{ code: number; output: string }> {
	const proc = Bun.spawn([process.execPath, MAIN_ENTRY, ...args], {
		env: isolatedEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	// The subcommand ignores SIGTERM (module-level handlers that do not exit),
	// so a hung run has to be killed outright.
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, TIMEOUT_MS);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(timedOut).toBe(false);
		return { code, output: `${stdout}\n${stderr}` };
	} finally {
		clearTimeout(timer);
	}
}

describe("auth password subcommand", () => {
	it(
		"runs the password command without starting the server",
		async () => {
			const dbPath = join(dir, "missing", "clankermux.db");
			const { code, output } = await runMain([
				"auth",
				"password",
				"--status",
				"--db-path",
				dbPath,
			]);
			expect(code).toBe(1);
			expect(output).toContain(`Database: ${dbPath}`);
			expect(output).toContain("No database at that path.");
			expect(output).not.toContain("ClankerMux Server v");
			expect(existsSync(dbPath)).toBe(false);
		},
		TIMEOUT_MS + 5_000,
	);

	it(
		"prints usage for an unknown auth subcommand",
		async () => {
			const { code, output } = await runMain(["auth", "bogus"]);
			expect(code).toBe(1);
			expect(output).toContain(
				"Usage: clankermux-server auth password --set|--clear|--status [--db-path <file>]",
			);
			expect(output).not.toContain("ClankerMux Server v");
		},
		TIMEOUT_MS + 5_000,
	);
});
