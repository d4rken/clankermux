#!/usr/bin/env bun
/**
 * Boot the compiled single-file binary and prove the parts of it that only
 * exist once it is compiled actually work.
 *
 * `bun build --compile` silently drops what it cannot see: a Worker resolved
 * through `new URL("./x.ts", import.meta.url)` is not bundled, and the binary
 * then fails at runtime with `ModuleNotFound resolving "/$bunfs/root/x.ts"`,
 * which only `worker.onerror` ever reports. Unit tests run from the checkout,
 * where every one of those paths resolves, so they cannot see any of it. This
 * script exercises the binary itself: the dashboard assets, both handler
 * workers and one database worker, then the first-run setup-code claim over
 * HTTP and the `auth password --status|--clear` subcommand. Compiled `--set`
 * is not covered because it needs a TTY; its logic is unit-tested in
 * packages/http-api/src/cli/auth-password.test.ts, and the HTTP claim runs the
 * same compiled scrypt path.
 *
 * ISOLATION IS ABSOLUTE, and it has to be. XDG_CONFIG_HOME alone does NOT
 * isolate a run: CLANKERMUX_DB_PATH and CLANKERMUX_CONFIG_PATH are read
 * straight from the environment and take precedence over the XDG-derived
 * directory, CLANKERMUX_LOG_DIR defaults to the shared /tmp/clankermux-logs
 * (the live instance's log), and `bun run` auto-loads a repo-root `.env` into
 * process.env — where CLANKERMUX_DB_PATH is a documented setting. An inherited
 * value would point this run at the operator's live database, which startup
 * would then migrate. So the child environment is built explicitly: every
 * CLANKERMUX_ key is dropped before this run's own are set.
 *
 * No account is configured and no upstream provider request is made.
 *
 * Usage: bun run smoke:server   (requires apps/server/dist/clankermux-server)
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BINARY_PATH = join(REPO_ROOT, "apps/server/dist/clankermux-server");

/** How long the server gets to answer /public/v1/status after spawn. */
const READY_TIMEOUT_MS = 90_000;
/**
 * How long to wait for the first quota-drift pass. Its scheduler defers the
 * first run by 90 s and there is no HTTP trigger, so most of this budget is
 * spent waiting out that timer rather than on the pass itself.
 */
const QUOTA_DRIFT_TIMEOUT_MS = 150_000;
/** Per-request ceiling; every fetch gets one so a wedged server fails loudly. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Grace between SIGTERM and SIGKILL. Doubles as the shutdown assertion. */
const SIGTERM_GRACE_MS = 30_000;
/** Ceiling for one `auth password` run; it exits on its own well before this. */
const CLI_TIMEOUT_MS = 30_000;
/** How long the announced setup code gets to show up in the server output. */
const SETUP_CODE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

/**
 * Ports this script must never use: 8090 is the live service, 8080 its Caddy
 * front, and 8081 the shared local test port other agents on this machine use.
 */
const FORBIDDEN_PORTS = new Set([8080, 8081, 8090]);

class SmokeFailure extends Error {}

export type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };

type Server = {
	child: ChildProcess;
	port: number;
	/** Everything the child wrote, in arrival order across both streams. */
	output: () => string;
	/** Resolves once the child is gone AND its stdio streams are closed. */
	closed: Promise<ExitStatus>;
	/** Non-null as soon as the child exits, so a poll loop can bail early. */
	exitStatus: () => ExitStatus | null;
};

function log(message: string): void {
	console.log(`[smoke] ${message}`);
}

/** Bind port 0, read what the OS handed out, release it. */
function pickEphemeralPort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = probe.port;
	probe.stop(true);
	if (port === undefined) {
		throw new SmokeFailure("Bun.serve did not report a bound port");
	}
	if (FORBIDDEN_PORTS.has(port)) {
		throw new SmokeFailure(`the OS handed out a reserved port (${port})`);
	}
	return port;
}

/** Where this run's copy of the binary lives inside `dir`. */
function binaryIn(dir: string): string {
	return join(dir, basename(BINARY_PATH));
}

/** This run's database. Every child, server or CLI, targets this file. */
function dbPathIn(dir: string): string {
	return join(dir, "clankermux.db");
}

/**
 * Copy the binary into `dir` and create the directories its environment names.
 * Running from a copy outside the checkout is the point: it proves nothing the
 * binary needs is resolved relative to the repository.
 */
function prepareDir(dir: string): void {
	copyFileSync(BINARY_PATH, binaryIn(dir));
	mkdirSync(join(dir, "config/clankermux"), { recursive: true });
	mkdirSync(join(dir, "logs"), { recursive: true });
}

/**
 * The inherited environment with every CLANKERMUX_ key dropped and this run's
 * own paths set, all inside `dir`. Shared by the server and every CLI run, so
 * none of them can reach the operator's database.
 */
function isolatedEnv(dir: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key.startsWith("CLANKERMUX_")) continue;
		env[key] = value;
	}
	env.XDG_CONFIG_HOME = join(dir, "config");
	// Must sit under $XDG_CONFIG_HOME/clankermux/: the config loader runs the
	// path through the security path-validator, which allows only the app's own
	// directory inside the XDG root.
	env.CLANKERMUX_CONFIG_PATH = join(dir, "config/clankermux/clankermux.json");
	env.CLANKERMUX_DB_PATH = dbPathIn(dir);
	env.CLANKERMUX_LOG_DIR = join(dir, "logs");
	return env;
}

/** Launch the binary copy in `dir` (see `prepareDir`), with `dir` as its cwd. */
function startServer(dir: string, port: number): Server {
	const env = isolatedEnv(dir);
	env.PORT = String(port);
	// The script only ever fetches 127.0.0.1, and a loopback bind must still
	// print the setup code.
	env.CLANKERMUX_HOST = "127.0.0.1";

	const child = spawn(binaryIn(dir), [], {
		cwd: dir,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const { stdout, stderr } = child;
	if (!stdout || !stderr) {
		throw new SmokeFailure("expected piped stdout and stderr from the server");
	}

	// Drain both pipes from the moment of spawn: a full pipe blocks the child,
	// and startup is chatty enough to fill one.
	const chunks: string[] = [];
	stdout.setEncoding("utf8");
	stderr.setEncoding("utf8");
	stdout.on("data", (chunk: string) => chunks.push(chunk));
	stderr.on("data", (chunk: string) => chunks.push(chunk));

	let exitStatus: ExitStatus | null = null;
	child.on("exit", (code, signal) => {
		exitStatus ??= { code, signal };
	});
	// "close", not "exit": only then are both pipes drained and closed, so the
	// captured output is complete when the assertions scan it.
	const closed = new Promise<ExitStatus>((resolve) => {
		child.on("close", (code, signal) => {
			exitStatus ??= { code, signal };
			resolve(exitStatus);
		});
		child.on("error", (error) => {
			chunks.push(`\n[spawn error] ${error.message}\n`);
			exitStatus ??= { code: null, signal: null };
			resolve(exitStatus);
		});
	});

	return {
		child,
		port,
		output: () => chunks.join(""),
		closed,
		exitStatus: () => exitStatus,
	};
}

/**
 * SIGTERM, escalate to SIGKILL after a grace period, await the exit. Safe on an
 * already-dead child.
 */
async function stopServer(server: Server): Promise<ExitStatus> {
	if (server.exitStatus() === null) server.child.kill("SIGTERM");
	const killer = setTimeout(() => {
		if (server.exitStatus() === null) server.child.kill("SIGKILL");
	}, SIGTERM_GRACE_MS);
	try {
		return await server.closed;
	} finally {
		clearTimeout(killer);
	}
}

/**
 * A signal-terminated process reports `{code: null, signal: <name>}`, so the
 * code alone cannot tell "stopped on SIGTERM" from "had to be SIGKILLed once
 * the grace period expired". Only a voluntary exit 0 is a clean shutdown.
 */
export function isCleanExit(status: ExitStatus): boolean {
	return status.code === 0 && status.signal === null;
}

type CliResult = { code: number | null; output: string };

/**
 * Run `<binary> auth password ...args` in this run's isolated environment,
 * with no stdin, capturing both streams. Fails the run if it has not exited
 * within CLI_TIMEOUT_MS. The kill is SIGKILL because the CLI ignores SIGTERM.
 */
async function runAuthCli(dir: string, args: string[]): Promise<CliResult> {
	const child = spawn(binaryIn(dir), ["auth", "password", ...args], {
		cwd: dir,
		env: isolatedEnv(dir),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const { stdout, stderr } = child;
	if (!stdout || !stderr) {
		throw new SmokeFailure("expected piped stdout and stderr from the CLI");
	}
	const chunks: string[] = [];
	stdout.setEncoding("utf8");
	stderr.setEncoding("utf8");
	stdout.on("data", (chunk: string) => chunks.push(chunk));
	stderr.on("data", (chunk: string) => chunks.push(chunk));

	let timedOut = false;
	const killer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, CLI_TIMEOUT_MS);
	try {
		const code = await new Promise<number | null>((resolve) => {
			child.on("close", (exitCode) => resolve(exitCode));
			child.on("error", (error) => {
				chunks.push(`\n[spawn error] ${error.message}\n`);
				resolve(null);
			});
		});
		const output = chunks.join("");
		if (timedOut) {
			throw new SmokeFailure(
				`auth password ${args.join(" ")}: no exit within ${CLI_TIMEOUT_MS}ms\n\n--- CLI output ---\n${output}`,
			);
		}
		return { code, output };
	} finally {
		clearTimeout(killer);
	}
}

/** Run the CLI and require `expectedCode` plus every string in `mustContain`. */
async function assertAuthCli(
	dir: string,
	args: string[],
	expectedCode: number,
	mustContain: string[],
): Promise<CliResult> {
	const result = await runAuthCli(dir, args);
	const what = `auth password ${args.join(" ")}`;
	const quoted = `\n\n--- CLI output ---\n${result.output}`;
	if (result.code !== expectedCode) {
		throw new SmokeFailure(
			`${what}: expected exit ${expectedCode}, got ${result.code}${quoted}`,
		);
	}
	for (const needle of mustContain) {
		if (!result.output.includes(needle)) {
			throw new SmokeFailure(
				`${what}: output lacks ${JSON.stringify(needle)}${quoted}`,
			);
		}
	}
	log(
		`${what}: exit ${expectedCode}, output has ${JSON.stringify(mustContain)}`,
	);
	return result;
}

/** Fail the run, quoting everything the server said. */
function fail(server: Server, message: string): never {
	throw new SmokeFailure(
		`${message}\n\n--- server output ---\n${server.output()}`,
	);
}

/** Fetch with a hard deadline, turning transport failures into a null result. */
async function get(
	server: Server,
	path: string,
	init: RequestInit = {},
): Promise<Response | null> {
	try {
		return await fetch(`http://127.0.0.1:${server.port}${path}`, {
			...init,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
}

/** Poll until `attempt` returns non-null, the deadline passes, or the child dies. */
async function poll<T>(
	server: Server,
	deadlineMs: number,
	what: string,
	attempt: () => Promise<T | null>,
): Promise<T> {
	const until = Date.now() + deadlineMs;
	for (;;) {
		const status = server.exitStatus();
		if (status !== null) {
			fail(
				server,
				`server exited (code ${status.code}, signal ${status.signal}) while waiting for ${what}`,
			);
		}
		const result = await attempt();
		if (result !== null) return result;
		if (Date.now() >= until) {
			fail(server, `timed out after ${deadlineMs}ms waiting for ${what}`);
		}
		await Bun.sleep(POLL_INTERVAL_MS);
	}
}

async function assertReady(server: Server): Promise<void> {
	// /public/v1/status, not /health: /health answers 503 forever on a pool with
	// no accounts, which is exactly the pool this run has.
	await poll(server, READY_TIMEOUT_MS, "GET /public/v1/status", async () => {
		const res = await get(server, "/public/v1/status");
		return res?.status === 200 ? res : null;
	});
	log("ready: /public/v1/status answered 200");
}

async function assertHealth(server: Server): Promise<void> {
	const res = await get(server, "/health");
	// 503 is the CORRECT answer for a zero-account pool, and getting it proves
	// the rollup opened the database and ran its account query.
	if (res?.status !== 503) {
		fail(
			server,
			`GET /health: expected 503, got ${res?.status ?? "no response"}`,
		);
	}
	const body = (await res.json()) as { status?: string };
	if (body.status !== "unhealthy") {
		fail(server, `GET /health: expected status "unhealthy", got ${body.status}`);
	}
	log('/health: 503 "unhealthy", the right answer with no accounts');
}

/** Asserts the dashboard HTML, and returns the asset path it references. */
async function assertDashboard(server: Server): Promise<string> {
	const res = await get(server, "/dashboard");
	if (res?.status !== 200) {
		fail(
			server,
			`GET /dashboard: expected 200, got ${res?.status ?? "no response"}`,
		);
	}
	const contentType = res.headers.get("content-type") ?? "";
	if (!contentType.includes("text/html")) {
		fail(server, `GET /dashboard: expected text/html, got ${contentType}`);
	}
	const html = await res.text();
	// The HTML references assets as `./<file>`; the embedded keys are `/<file>`.
	const match = html.match(/(?:src|href)="\.?\/?([^"]+\.(?:js|css))"/);
	if (!match?.[1]) {
		fail(server, "GET /dashboard: body references no built .js or .css asset");
	}
	log("/dashboard: 200 text/html referencing a built asset");
	return `/${match[1]}`;
}

async function assertAsset(server: Server, path: string): Promise<void> {
	const res = await get(server, path);
	if (res?.status !== 200) {
		fail(
			server,
			`GET ${path}: expected 200, got ${res?.status ?? "no response"}`,
		);
	}
	const contentType = res.headers.get("content-type") ?? "";
	if (!/javascript|text\/css/.test(contentType)) {
		fail(server, `GET ${path}: expected a JS or CSS type, got ${contentType}`);
	}
	const body = await res.text();
	if (body.length === 0) fail(server, `GET ${path}: empty body`);
	log(`${path}: 200 ${contentType}, ${body.length} bytes`);
}

async function assertStats(server: Server): Promise<void> {
	const res = await get(server, "/api/stats");
	if (res?.status !== 200) {
		fail(
			server,
			`GET /api/stats: expected 200, got ${res?.status ?? "no response"}`,
		);
	}
	// The header pins the claim: without it a 200 proves only that some handler
	// answered, not that the analytics WORKER did.
	const mode = res.headers.get("x-clankermux-analytics-mode");
	if (mode !== "worker") {
		fail(
			server,
			`GET /api/stats: expected x-clankermux-analytics-mode: worker, got ${mode ?? "no header"}`,
		);
	}
	await res.json();
	log("/api/stats: 200 JSON, served by the analytics worker");
}

async function assertQuotaDrift(server: Server): Promise<void> {
	log(
		`waiting up to ${Math.round(QUOTA_DRIFT_TIMEOUT_MS / 1000)}s for the first quota-drift pass`,
	);
	// The endpoint answers 200 with status "computing" until a pass lands, and
	// the scheduler defers the first one by 90 s with no way to trigger it. A
	// completed payload is the only evidence its worker spawned at all.
	const status = await poll(
		server,
		QUOTA_DRIFT_TIMEOUT_MS,
		"a completed quota-drift pass",
		async () => {
			const res = await get(server, "/api/analytics/quota-drift");
			if (res?.status !== 200) return null;
			const body = (await res.json()) as { status?: string };
			return body.status && body.status !== "computing" ? body.status : null;
		},
	);
	log(`/api/analytics/quota-drift: pass completed, status "${status}"`);
}

async function assertIntegrityCheck(server: Server): Promise<void> {
	const res = await get(server, "/api/storage/integrity/check", {
		method: "POST",
		body: "",
	});
	if (res?.status !== 200) {
		fail(
			server,
			`POST /api/storage/integrity/check: expected 200, got ${res?.status ?? "no response"}`,
		);
	}
	const body = (await res.json()) as {
		kind?: string;
		result?: string;
		error?: string | null;
	};
	if (body.kind !== "quick" || body.result !== "ok" || body.error !== null) {
		fail(
			server,
			`POST /api/storage/integrity/check: expected a healthy quick check, got ${JSON.stringify(body)}`,
		);
	}
	log("/api/storage/integrity/check: quick check ok, via a database worker");
}

/**
 * The binary marks both Agent SDKs external, so it cannot run Claude Code. It
 * must still start, and say so instead of offering official Anthropic
 * accounts to clients that could only reach them through the bridge.
 */
async function assertSdkBridgeUnavailable(server: Server): Promise<void> {
	const res = await get(server, "/api/system/status");
	if (res?.status !== 200) {
		fail(
			server,
			`GET /api/system/status: expected 200, got ${res?.status ?? "no response"}`,
		);
	}
	const body = (await res.json()) as {
		sdkBridge?: { availability?: { state?: string; reason?: string } };
	};
	const availability = body.sdkBridge?.availability;
	if (availability?.state !== "unavailable") {
		fail(
			server,
			`GET /api/system/status: expected the SDK bridge unavailable, got ${JSON.stringify(body.sdkBridge ?? null)}`,
		);
	}
	log(`/api/system/status: SDK bridge unavailable (${availability.reason})`);
}

const SETUP_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SETUP_CODE_LINE =
	/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * The distinct setup codes announced in `output`, in first-seen order. A code
 * counts only when it is the whole of a trimmed line after a
 * `One-time setup code:` line and before that block's closing rule, so a
 * code-shaped fragment elsewhere (the middle of an upper-case UUID, say) is
 * never picked up:
 *
 *   ----------------------------------------------------
 *   No management password is set. One-time setup code:
 *
 *       7K2M-QX9P-4RTV            <- this line
 *
 *   Open the dashboard at http://127.0.0.1:4000/dashboard ...
 *   ----------------------------------------------------
 */
export function extractSetupCodes(output: string): string[] {
	const codes = new Set<string>();
	let inBlock = false;
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (line.includes("One-time setup code:")) {
			inBlock = true;
		} else if (inBlock && /^-{8,}$/.test(line)) {
			inBlock = false;
		} else if (inBlock && SETUP_CODE_LINE.test(line)) {
			codes.add(line);
			inBlock = false;
		}
	}
	return [...codes];
}

/**
 * A well-formed code guaranteed to differ from `code`: its first character
 * moved one place along the alphabet. `7K2M-QX9P-4RTV` becomes `8K2M-QX9P-4RTV`.
 */
export function differentSetupCode(code: string): string {
	const first = SETUP_CODE_ALPHABET.indexOf(code.charAt(0));
	const next = SETUP_CODE_ALPHABET.charAt(
		(first + 1) % SETUP_CODE_ALPHABET.length,
	);
	return `${next}${code.slice(1)}`;
}

/** Fail unless `res` answered `expected`; returns it as non-null. */
function expectStatus(
	server: Server,
	what: string,
	res: Response | null,
	expected: number,
): Response {
	if (res?.status !== expected) {
		fail(
			server,
			`${what}: expected ${expected}, got ${res?.status ?? "no response"}`,
		);
	}
	return res;
}

async function assertAuthStatus(
	server: Server,
	cookie: string | null,
	expected: { configured: boolean; authenticated: boolean },
): Promise<void> {
	const what = `GET /api/auth/status${cookie ? " with the session" : ""}`;
	const res = expectStatus(
		server,
		what,
		await get(
			server,
			"/api/auth/status",
			cookie ? { headers: { Cookie: cookie } } : {},
		),
		200,
	);
	const body = (await res.json()) as {
		configured?: unknown;
		authenticated?: unknown;
	};
	if (
		body.configured !== expected.configured ||
		body.authenticated !== expected.authenticated
	) {
		fail(
			server,
			`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(body)}`,
		);
	}
	log(`${what}: ${JSON.stringify(expected)}`);
}

function postSetup(
	server: Server,
	code: string,
	password: string,
): Promise<Response | null> {
	return get(server, "/api/auth/setup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code, password }),
	});
}

/**
 * Claim the first management password with the code the server printed, and
 * prove the claim closes the fail-open API. Must run after every assertion
 * that relies on `/api/*` being open.
 */
async function assertSetupCodeFlow(server: Server): Promise<void> {
	const codes = await poll(
		server,
		SETUP_CODE_TIMEOUT_MS,
		"a setup code in the server output",
		async () => {
			const found = extractSetupCodes(server.output());
			return found.length > 0 ? found : null;
		},
	);
	const [code] = codes;
	if (codes.length !== 1 || code === undefined) {
		fail(
			server,
			`expected one setup code, the output announced ${codes.length}`,
		);
	}
	log("server output: exactly one setup code announced");

	const history = expectStatus(
		server,
		"GET /api/logs/history",
		await get(server, "/api/logs/history"),
		200,
	);
	const historyBody = await history.text();
	if (
		historyBody.includes(code) ||
		historyBody.includes(code.replaceAll("-", ""))
	) {
		fail(
			server,
			"GET /api/logs/history: the log history contains the setup code",
		);
	}
	log("/api/logs/history: does not contain the setup code");

	expectStatus(
		server,
		"GET /api/debug/snapshot while unconfigured",
		await get(server, "/api/debug/snapshot"),
		403,
	);
	log("/api/debug/snapshot: 403 while no password is set");

	await assertAuthStatus(server, null, {
		configured: false,
		authenticated: false,
	});

	const password = "smoke-password-1";
	expectStatus(
		server,
		"POST /api/auth/setup with a wrong code",
		await postSetup(server, differentSetupCode(code), password),
		403,
	);
	log("/api/auth/setup: 403 for a wrong code");

	const claimed = expectStatus(
		server,
		"POST /api/auth/setup with the announced code",
		await postSetup(server, code, password),
		200,
	);
	const setCookie = claimed.headers.get("set-cookie") ?? "";
	const cookie = setCookie.split(";")[0]?.trim() ?? "";
	if (!cookie.startsWith("cmx_session=") || cookie === "cmx_session=") {
		fail(
			server,
			`POST /api/auth/setup: expected a cmx_session cookie, got ${JSON.stringify(setCookie)}`,
		);
	}
	log("/api/auth/setup: 200 with a cmx_session cookie");

	await assertAuthStatus(server, cookie, {
		configured: true,
		authenticated: true,
	});

	expectStatus(
		server,
		"POST /api/auth/setup once configured",
		await postSetup(server, code, password),
		409,
	);
	log("/api/auth/setup: 409 once a password exists");

	expectStatus(
		server,
		"GET /api/stats without a session",
		await get(server, "/api/stats"),
		401,
	);
	expectStatus(
		server,
		"GET /api/stats with the session",
		await get(server, "/api/stats", { headers: { Cookie: cookie } }),
		200,
	);
	log("/api/stats: 401 without the session, 200 with it");
}

/** The catch-all for the silent failure mode: a worker that never loaded. */
function assertNoModuleErrors(server: Server): void {
	const output = server.output();
	for (const needle of ["ModuleNotFound", "/$bunfs/root/"]) {
		if (output.includes(needle)) {
			fail(server, `server output contains ${JSON.stringify(needle)}`);
		}
	}
	log("server output: no ModuleNotFound, no /$bunfs/root/ reference");
}

/**
 * Start the server, retrying once if it dies immediately on a taken port — the
 * probe releases the ephemeral port before the server binds it, so another
 * process can claim it in between.
 */
async function startWithRetry(dir: string, adopt: (s: Server) => void) {
	for (let attempt = 1; ; attempt++) {
		const port = pickEphemeralPort();
		log(`starting ${basename(BINARY_PATH)} in ${dir} on port ${port}`);
		const server = startServer(dir, port);
		adopt(server);
		const status = await Promise.race([
			server.closed,
			Bun.sleep(POLL_INTERVAL_MS).then(() => null),
		]);
		if (status === null) return server;

		const output = server.output();
		await stopServer(server);
		if (attempt >= 2 || !/EADDRINUSE|address already in use/i.test(output)) {
			console.error(output);
			throw new SmokeFailure(
				`server exited immediately (code ${status.code}, signal ${status.signal})`,
			);
		}
		log("port was taken between probe and bind; retrying once");
	}
}

async function main(): Promise<void> {
	if (!existsSync(BINARY_PATH)) {
		console.error(`[smoke] no binary at ${BINARY_PATH}`);
		console.error("[smoke] build it first: bun run build:server");
		process.exit(1);
	}

	const dir = await mkdtemp(join(tmpdir(), "clankermux-smoke-"));
	let started: Server | null = null;
	// Every path out of here runs this, including a signal to the script itself.
	const cleanup = async (): Promise<void> => {
		if (started) await stopServer(started);
		started = null;
		await rm(dir, { recursive: true, force: true });
	};
	const onSignal = (signal: NodeJS.Signals): void => {
		void cleanup().then(() => process.exit(signal === "SIGINT" ? 130 : 143));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	try {
		prepareDir(dir);
		const dbPath = dbPathIn(dir);

		// No server has run yet, so no database exists: the CLI must refuse
		// rather than create one, and must not boot the server on the way.
		const missing = await assertAuthCli(
			dir,
			["--status", "--db-path", dbPath],
			1,
			["No database at that path."],
		);
		if (missing.output.includes("ClankerMux Server v")) {
			throw new SmokeFailure(
				`auth password --status started the server\n\n--- CLI output ---\n${missing.output}`,
			);
		}
		if (existsSync(dbPath)) {
			throw new SmokeFailure(
				`auth password --status created ${dbPath} instead of refusing`,
			);
		}
		log("auth password: missing database refused, not created");

		const server = await startWithRetry(dir, (s) => {
			started = s;
		});

		await assertReady(server);
		await assertHealth(server);
		await assertAsset(server, await assertDashboard(server));
		await assertStats(server);
		await assertSdkBridgeUnavailable(server);
		await assertQuotaDrift(server);
		await assertIntegrityCheck(server);
		await assertSetupCodeFlow(server);

		// Shutdown is an assertion too: a binary that will not stop on SIGTERM
		// stalls every restart behind the SIGKILL timeout.
		log("sending SIGTERM");
		const status = await stopServer(server);
		if (!isCleanExit(status)) {
			fail(
				server,
				`server did not shut down cleanly on SIGTERM (code ${status.code}, signal ${status.signal})`,
			);
		}
		log(`server exited (code ${status.code}, signal ${status.signal})`);

		// Both pipes are closed only now, so this sees everything the run wrote.
		assertNoModuleErrors(server);

		await assertAuthCli(dir, ["--status", "--db-path", dbPath], 0, [
			"A management password is set",
		]);
		await assertAuthCli(dir, ["--clear", "--db-path", dbPath], 0, ["Cleared."]);
		await assertAuthCli(dir, ["--status", "--db-path", dbPath], 0, [
			"UNPROTECTED",
		]);
		log("PASS");
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		await cleanup();
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(
			error instanceof SmokeFailure
				? `[smoke] FAIL: ${error.message}`
				: `[smoke] FAIL: ${error instanceof Error ? error.stack : String(error)}`,
		);
		process.exit(1);
	}
}
