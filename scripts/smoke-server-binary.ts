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
 * workers and one database worker.
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
	if (FORBIDDEN_PORTS.has(port)) {
		throw new SmokeFailure(`the OS handed out a reserved port (${port})`);
	}
	return port;
}

/**
 * Launch the binary from a copy inside `dir`, with `dir` as its cwd. Running
 * outside the checkout is the point: it proves nothing the binary needs is
 * resolved relative to the repository.
 */
function startServer(dir: string, port: number): Server {
	const binary = join(dir, basename(BINARY_PATH));
	copyFileSync(BINARY_PATH, binary);
	mkdirSync(join(dir, "config/clankermux"), { recursive: true });
	mkdirSync(join(dir, "logs"), { recursive: true });

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
	env.CLANKERMUX_DB_PATH = join(dir, "clankermux.db");
	env.CLANKERMUX_LOG_DIR = join(dir, "logs");
	env.PORT = String(port);

	const child = spawn(binary, [], {
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
		const server = await startWithRetry(dir, (s) => {
			started = s;
		});

		await assertReady(server);
		await assertHealth(server);
		await assertAsset(server, await assertDashboard(server));
		await assertStats(server);
		await assertQuotaDrift(server);
		await assertIntegrityCheck(server);

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
