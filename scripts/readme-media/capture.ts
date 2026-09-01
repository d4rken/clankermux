#!/usr/bin/env bun
/**
 * Screenshots the dashboard of a locally running ClankerMux into `docs/media/`.
 *
 * Headless Chromium is driven directly over the Chrome DevTools Protocol on a
 * raw WebSocket. There is no puppeteer/playwright here and none is wanted: the
 * job is eight navigations and eight PNGs, and a browser-automation dependency
 * tree is a poor trade for that. Everything below is CDP commands and events.
 *
 * The one thing this script is paranoid about is the theme. A capture that
 * silently came out in the wrong theme still produces a plausible-looking PNG,
 * so both theme signals are set (the media feature and the `theme` key the app
 * reads from localStorage) and the resulting `<html>` class list is asserted
 * before the screenshot is taken.
 *
 * Usage:
 *   bun scripts/readme-media/capture.ts \
 *     --base-url http://127.0.0.1:8081 --out-dir docs/media \
 *     [--width 1440] [--height 980] [--scale 2] [--settle-ms 2500] \
 *     [--password <management password>]
 */

import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// What gets captured
// ---------------------------------------------------------------------------

/**
 * Routes to capture, and the file stem each one is written under.
 *
 * `height` overrides the run's default viewport height for that one route. The
 * account list is the case it exists for: the API returns accounts ordered by
 * `priority DESC`, so the highest-priority account is LAST, and at the default
 * height the most detailed card is the one cut off by the fold.
 */
export const CAPTURES = [
	{ route: "/", name: "overview" },
	{ route: "/accounts", name: "accounts", height: 1200 },
	{ route: "/limits", name: "limits" },
	{ route: "/analytics", name: "analytics" },
] as const;

export type Capture = (typeof CAPTURES)[number];

/** The two themes the app supports as an explicit choice (`system` is not one). */
export type ThemeName = "light" | "dark";

export const THEMES: readonly ThemeName[] = ["light", "dark"];

const CHROMIUM_BINARY = "/usr/bin/chromium";

/** Per-command ceiling. A wedged CDP call must surface as a message, not a hang. */
const COMMAND_TIMEOUT_MS = 30_000;

/** How long Chromium gets to print its DevTools endpoint on stderr. */
const LAUNCH_TIMEOUT_MS = 20_000;

const WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;

/** No request in flight for this long counts as "the page has stopped loading". */
const NETWORK_QUIET_MS = 800;

/** Upper bound on the quiet wait — the dashboard polls, so it is never idle for long. */
const NETWORK_QUIET_CEILING_MS = 15_000;

const NETWORK_QUIET_POLL_MS = 50;

const USAGE = `Usage: bun scripts/readme-media/capture.ts --base-url <url> --out-dir <dir>
                [--width 1440] [--height 980] [--scale 2] [--settle-ms 2500]
                [--password <management password>]`;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CaptureOptions {
	baseUrl: string;
	outDir: string;
	width: number;
	height: number;
	scale: number;
	settleMs: number;
	/**
	 * Management password of the capture instance, or null when it has none.
	 * A gated instance serves every /api/* route behind a session cookie, so
	 * without this the captures would all be of the login screen.
	 */
	password: string | null;
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function parsePositive(raw: string, flag: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		fail(`Invalid ${flag} value: ${raw}`);
	}
	return value;
}

export function parseArgs(argv: string[]): CaptureOptions {
	let baseUrl: string | null = null;
	let outDir: string | null = null;
	let width = 1440;
	let height = 980;
	let scale = 2;
	let settleMs = 2500;
	let password: string | null = null;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		// Both `--flag value` and `--flag=value` are accepted; the README command
		// line uses the former, shell history tends to produce the latter.
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
		const takeValue = (): string => {
			if (inlineValue !== null) return inlineValue;
			const next = argv[++i];
			if (next === undefined) fail(`Missing value for ${flag}\n${USAGE}`);
			return next;
		};

		switch (flag) {
			case "--base-url":
				baseUrl = takeValue();
				break;
			case "--out-dir":
				outDir = takeValue();
				break;
			case "--width":
				width = parsePositive(takeValue(), "--width");
				break;
			case "--height":
				height = parsePositive(takeValue(), "--height");
				break;
			case "--scale":
				scale = parsePositive(takeValue(), "--scale");
				break;
			case "--settle-ms":
				settleMs = Number(takeValue());
				if (!Number.isFinite(settleMs) || settleMs < 0) {
					fail("Invalid --settle-ms value");
				}
				break;
			case "--password":
				password = takeValue();
				break;
			case "--help":
			case "-h":
				console.log(USAGE);
				process.exit(0);
				break;
			default:
				fail(`Unknown argument: ${arg}\n${USAGE}`);
		}
	}

	if (baseUrl === null) fail(`Missing --base-url\n${USAGE}`);
	if (outDir === null) fail(`Missing --out-dir\n${USAGE}`);

	return { baseUrl, outDir, width, height, scale, settleMs, password };
}

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

type CdpParams = Record<string, unknown>;
type CdpResult = Record<string, unknown>;
type CdpEventHandler = (
	params: CdpParams,
	sessionId: string | undefined,
) => void;

interface PendingCommand {
	resolve: (result: CdpResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minimal CDP transport: correlates command ids with their replies, dispatches
 * everything else as an event, and refuses to let any command outlive
 * {@link COMMAND_TIMEOUT_MS}.
 */
class CdpClient {
	private nextId = 1;
	private readonly pending = new Map<number, PendingCommand>();
	private readonly listeners = new Map<string, Set<CdpEventHandler>>();
	private closedReason: string | null = null;

	private constructor(private readonly socket: WebSocket) {
		socket.addEventListener("message", (event: MessageEvent) => {
			this.handleMessage(event.data);
		});
		socket.addEventListener("close", () => {
			this.abortAll("CDP websocket closed");
		});
		socket.addEventListener("error", () => {
			this.abortAll("CDP websocket error");
		});
	}

	static async connect(url: string): Promise<CdpClient> {
		const socket = new WebSocket(url);
		// The client is built before the socket opens so its message handler is
		// installed ahead of the first frame Chromium sends.
		const client = new CdpClient(socket);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error(`Timed out connecting to CDP endpoint ${url}`));
			}, WEBSOCKET_CONNECT_TIMEOUT_MS);
			socket.addEventListener(
				"open",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
			socket.addEventListener(
				"error",
				() => {
					clearTimeout(timer);
					reject(new Error(`Failed to connect to CDP endpoint ${url}`));
				},
				{ once: true },
			);
		});
		return client;
	}

	send(
		method: string,
		params: CdpParams = {},
		sessionId?: string,
	): Promise<CdpResult> {
		if (this.closedReason !== null) {
			return Promise.reject(
				new Error(`${method} not sent: ${this.closedReason}`),
			);
		}
		const id = this.nextId++;
		const payload: CdpParams = { id, method, params };
		if (sessionId !== undefined) payload.sessionId = sessionId;

		return new Promise<CdpResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(
						`CDP command ${method} timed out after ${COMMAND_TIMEOUT_MS}ms`,
					),
				);
			}, COMMAND_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer, label: method });
			this.socket.send(JSON.stringify(payload));
		});
	}

	on(method: string, handler: CdpEventHandler): () => void {
		let set = this.listeners.get(method);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(method, set);
		}
		set.add(handler);
		return () => {
			set?.delete(handler);
		};
	}

	/** Resolves when `method` next fires. Register before triggering the action. */
	once(method: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CdpParams> {
		return new Promise<CdpParams>((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error(`Timed out waiting for CDP event ${method}`));
			}, timeoutMs);
			const off = this.on(method, (params) => {
				clearTimeout(timer);
				off();
				resolve(params);
			});
		});
	}

	close(): void {
		this.abortAll("CDP client closed");
		try {
			this.socket.close();
		} catch {
			// Already closing; nothing useful to do with the error.
		}
	}

	private handleMessage(data: unknown): void {
		if (typeof data !== "string") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;

		const rawId = parsed.id;
		if (typeof rawId === "number") {
			const entry = this.pending.get(rawId);
			if (entry === undefined) return;
			this.pending.delete(rawId);
			clearTimeout(entry.timer);
			const error = parsed.error;
			if (isRecord(error)) {
				const message =
					typeof error.message === "string"
						? error.message
						: JSON.stringify(error);
				const detail = typeof error.data === "string" ? ` (${error.data})` : "";
				entry.reject(
					new Error(`CDP ${entry.label} failed: ${message}${detail}`),
				);
				return;
			}
			entry.resolve(isRecord(parsed.result) ? parsed.result : {});
			return;
		}

		const method = parsed.method;
		if (typeof method !== "string") return;
		const handlers = this.listeners.get(method);
		if (handlers === undefined) return;
		const params = isRecord(parsed.params) ? parsed.params : {};
		const sessionId =
			typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
		for (const handler of [...handlers]) handler(params, sessionId);
	}

	private abortAll(reason: string): void {
		if (this.closedReason === null) this.closedReason = reason;
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error(`${entry.label}: ${reason}`));
		}
		this.pending.clear();
	}
}

function expectString(result: CdpResult, key: string, context: string): string {
	const value = result[key];
	if (typeof value !== "string") {
		throw new Error(
			`${context}: expected a string \`${key}\` in the CDP result, got ${JSON.stringify(value)}`,
		);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Chromium process
// ---------------------------------------------------------------------------

interface Browser {
	proc: ReturnType<typeof Bun.spawn>;
	userDataDir: string;
	webSocketDebuggerUrl: string;
}

function chromiumArgs(userDataDir: string): string[] {
	return [
		CHROMIUM_BINARY,
		"--headless=new",
		"--no-sandbox",
		"--disable-gpu",
		"--hide-scrollbars",
		// The page scale comes from Emulation.setDeviceMetricsOverride, so the
		// process-level factor must stay at 1 or the two would multiply.
		"--force-device-scale-factor=1",
		// Port 0 = let the OS pick. The chosen port is only discoverable from the
		// "DevTools listening on ..." line Chromium prints on stderr.
		"--remote-debugging-port=0",
		// Chromium 111+ rejects DevTools websockets carrying an Origin header it
		// was not told to allow; whether one is sent depends on the client.
		"--remote-allow-origins=*",
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate,MediaRouter",
		"about:blank",
	];
}

/**
 * Reads Chromium's stderr until the DevTools endpoint appears, then keeps
 * draining it in the background — an unread pipe eventually fills and blocks
 * the browser process mid-capture.
 */
function readDevToolsUrl(
	stderr: ReadableStream<Uint8Array>,
	timeoutMs: number,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(
				new Error(
					`Chromium did not print a DevTools endpoint within ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);

		void (async () => {
			const decoder = new TextDecoder();
			let buffered = "";
			for await (const chunk of stderr) {
				if (settled) continue;
				buffered += decoder.decode(chunk, { stream: true });
				const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
				if (match?.[1] !== undefined) {
					settled = true;
					clearTimeout(timer);
					resolve(match[1]);
					continue;
				}
				// Chromium is chatty on stderr; keep only enough to span a split line.
				if (buffered.length > 64 * 1024) buffered = buffered.slice(-8192);
			}
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(
					new Error(
						"Chromium exited before printing its DevTools endpoint. Recent stderr:\n" +
							buffered.slice(-2048),
					),
				);
			}
		})().catch((error: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

async function launchChromium(): Promise<Browser> {
	const userDataDir = mkdtempSync(join(tmpdir(), "clankermux-capture-"));
	const proc = Bun.spawn(chromiumArgs(userDataDir), {
		stdout: "ignore",
		stderr: "pipe",
	});
	try {
		const webSocketDebuggerUrl = await readDevToolsUrl(
			proc.stderr,
			LAUNCH_TIMEOUT_MS,
		);
		return { proc, userDataDir, webSocketDebuggerUrl };
	} catch (error) {
		proc.kill();
		rmSync(userDataDir, { recursive: true, force: true });
		throw error;
	}
}

/** How long a terminating Chromium gets before it is killed outright. */
const SHUTDOWN_GRACE_MS = 5_000;

async function shutdownChromium(browser: Browser): Promise<void> {
	browser.proc.kill();
	try {
		// Escalate rather than await unconditionally: a wedged renderer that never
		// reaps would otherwise hang the whole pipeline forever, behind every CDP
		// timeout, with nothing left to time out.
		await Promise.race([
			browser.proc.exited,
			new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					browser.proc.kill("SIGKILL");
					resolve();
				}, SHUTDOWN_GRACE_MS);
				// Do not hold the event loop open for the grace period when the
				// process exits first.
				timer.unref?.();
			}),
		]);
	} catch {
		// Exit status is irrelevant here; the goal is only that it is gone.
	}
	rmSync(browser.userDataDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Network quiet heuristic
// ---------------------------------------------------------------------------

/**
 * Tracks in-flight requests so a capture can wait for the page to stop loading.
 *
 * "Quiet" rather than "idle" on purpose: the dashboard refetches on a ~30s
 * timer, so a wait for zero network activity over the page's lifetime would
 * never return.
 */
class NetworkQuietTracker {
	private readonly inFlight = new Set<string>();
	private lastChangeAt = Date.now();

	constructor(client: CdpClient) {
		client.on("Network.requestWillBeSent", (params) => {
			const id = params.requestId;
			if (typeof id === "string") this.inFlight.add(id);
			this.lastChangeAt = Date.now();
		});
		const finish = (params: CdpParams): void => {
			const id = params.requestId;
			if (typeof id === "string") this.inFlight.delete(id);
			this.lastChangeAt = Date.now();
		};
		client.on("Network.loadingFinished", finish);
		client.on("Network.loadingFailed", finish);
	}

	/** Call immediately before a navigation so the previous page's tail is dropped. */
	reset(): void {
		this.inFlight.clear();
		this.lastChangeAt = Date.now();
	}

	async waitForQuiet(): Promise<void> {
		const deadline = Date.now() + NETWORK_QUIET_CEILING_MS;
		for (;;) {
			const now = Date.now();
			if (
				this.inFlight.size === 0 &&
				now - this.lastChangeAt >= NETWORK_QUIET_MS
			) {
				return;
			}
			if (now >= deadline) {
				console.warn(
					`  network still busy after ${NETWORK_QUIET_CEILING_MS}ms (${this.inFlight.size} in flight), capturing anyway`,
				);
				return;
			}
			await Bun.sleep(NETWORK_QUIET_POLL_MS);
		}
	}
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

interface PageSession {
	client: CdpClient;
	sessionId: string;
	tracker: NetworkQuietTracker;
	/**
	 * Identifier of the theme init script currently installed. Init scripts are
	 * cumulative — adding one per navigation without removing the last would
	 * leave every earlier theme's script running on later pages, and the last
	 * writer would win at random.
	 */
	initScriptId: string | null;
}

async function openPageSession(client: CdpClient): Promise<PageSession> {
	const target = await client.send("Target.createTarget", {
		url: "about:blank",
	});
	const targetId = expectString(target, "targetId", "Target.createTarget");
	const attached = await client.send("Target.attachToTarget", {
		targetId,
		flatten: true,
	});
	const sessionId = expectString(
		attached,
		"sessionId",
		"Target.attachToTarget",
	);

	await client.send("Page.enable", {}, sessionId);
	await client.send("Runtime.enable", {}, sessionId);
	await client.send("Network.enable", {}, sessionId);

	return {
		client,
		sessionId,
		tracker: new NetworkQuietTracker(client),
		initScriptId: null,
	};
}

/**
 * Runs `expression` in the page and hands back its value. `awaitPromise` lets
 * the caller pass an async IIFE and receive what it settles to.
 */
async function evaluateInPage(
	page: PageSession,
	expression: string,
	context: string,
	awaitPromise = false,
): Promise<unknown> {
	const evaluated = await page.client.send(
		"Runtime.evaluate",
		{ expression, returnByValue: true, awaitPromise },
		page.sessionId,
	);
	const details = evaluated.exceptionDetails;
	if (isRecord(details)) {
		throw new Error(
			`${context} threw in the page: ${typeof details.text === "string" ? details.text : JSON.stringify(details)}`,
		);
	}
	const wrapper = evaluated.result;
	if (!isRecord(wrapper)) {
		throw new Error(
			`${context} returned an unexpected shape: ${JSON.stringify(evaluated)}`,
		);
	}
	return wrapper.value;
}

/** Navigates and waits for the document's load event. */
async function navigateAndWait(page: PageSession, url: string): Promise<void> {
	// Subscribe before navigating: the load event can land before an await that
	// is registered afterwards.
	const loaded = page.client.once("Page.loadEventFired");
	// Nothing awaits `loaded` on the failure paths below, and it rejects on its
	// own timeout — an unobserved rejection would surface later as an unhandled
	// one, attributed to whatever happened to be running then. Attaching a
	// no-op handler marks it observed without changing the success path.
	loaded.catch(() => {});
	page.tracker.reset();
	const navigation = await page.client.send(
		"Page.navigate",
		{ url },
		page.sessionId,
	);
	const errorText = navigation.errorText;
	if (typeof errorText === "string" && errorText.length > 0) {
		throw new Error(`Navigation to ${url} failed: ${errorText}`);
	}
	await loaded;
}

interface ThemeProbe {
	matches: boolean;
	classes: string;
}

async function probeTheme(
	page: PageSession,
	theme: ThemeName,
): Promise<ThemeProbe> {
	const value = await evaluateInPage(
		page,
		`({ matches: document.documentElement.classList.contains(${JSON.stringify(theme)}), classes: document.documentElement.className })`,
		"Theme probe",
	);
	if (
		!isRecord(value) ||
		typeof value.matches !== "boolean" ||
		typeof value.classes !== "string"
	) {
		throw new Error(
			`Theme probe returned unusable data: ${JSON.stringify(value)}`,
		);
	}
	return { matches: value.matches, classes: value.classes };
}

// ---------------------------------------------------------------------------
// Management session
// ---------------------------------------------------------------------------

/** What an in-page `fetch` reports back: its status and its raw body text. */
interface FetchProbe {
	status: number;
	body: string;
}

function expectFetchProbe(value: unknown, context: string): FetchProbe {
	if (
		!isRecord(value) ||
		typeof value.status !== "number" ||
		typeof value.body !== "string"
	) {
		throw new Error(
			`${context} returned an unusable result: ${JSON.stringify(value)}`,
		);
	}
	return { status: value.status, body: value.body };
}

/**
 * Logs the browsing context in, when the capture instance has a management
 * password.
 *
 * The capture instance sets one so the dashboard does not render its red
 * "Management API unprotected" notice in every screenshot. That gates every
 * `/api/*` route behind a session cookie, so without this step all eight
 * captures would be of the login screen.
 */
async function authenticate(
	page: PageSession,
	options: CaptureOptions,
): Promise<void> {
	const password = options.password;
	if (password === null) return;

	// The login must run from the app's own origin: a fetch issued from
	// about:blank has an opaque origin, and its Set-Cookie is dropped.
	await navigateAndWait(page, options.baseUrl);

	const login = expectFetchProbe(
		await evaluateInPage(
			page,
			`(async () => {
				const r = await fetch("/api/auth/login", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ password: ${JSON.stringify(password)} }),
					credentials: "same-origin",
				});
				return { status: r.status, body: await r.text().catch(() => "") };
			})()`,
			"Management login",
			true,
		),
		"Management login",
	);
	if (login.status < 200 || login.status >= 300) {
		throw new Error(
			`Management login failed: HTTP ${login.status} ${login.body || "(empty body)"}. Refusing to capture a login screen.`,
		);
	}

	// A 2xx only says the credentials were accepted. Whether the cookie was
	// stored is a separate question, and getting that wrong yields eight
	// screenshots of the login form rather than an error.
	const status = expectFetchProbe(
		await evaluateInPage(
			page,
			`(async () => {
				const r = await fetch("/api/auth/status", { credentials: "same-origin" });
				return { status: r.status, body: await r.text().catch(() => "") };
			})()`,
			"Session status probe",
			true,
		),
		"Session status probe",
	);
	if (status.status < 200 || status.status >= 300) {
		throw new Error(
			`Session status probe failed: HTTP ${status.status} ${status.body || "(empty body)"}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(status.body);
	} catch {
		throw new Error(
			`Session status probe returned non-JSON: ${status.body || "(empty body)"}`,
		);
	}
	if (!isRecord(parsed) || parsed.authenticated !== true) {
		throw new Error(
			`Management login was accepted but the session did not take: /api/auth/status says ${JSON.stringify(parsed)}. Every capture would be of the login screen.`,
		);
	}

	console.log("Authenticated against the management API");
}

async function captureOne(
	page: PageSession,
	options: CaptureOptions,
	capture: Capture,
	theme: ThemeName,
): Promise<void> {
	const { client, sessionId } = page;
	const url = new URL(capture.route, options.baseUrl).toString();

	await client.send(
		"Emulation.setDeviceMetricsOverride",
		{
			width: options.width,
			height: "height" in capture ? capture.height : options.height,
			deviceScaleFactor: options.scale,
			mobile: false,
		},
		sessionId,
	);

	// Both theme signals. The media feature covers `theme: "system"`; the
	// localStorage key covers an explicit choice, which is what the app stores.
	await client.send(
		"Emulation.setEmulatedMedia",
		{ features: [{ name: "prefers-color-scheme", value: theme }] },
		sessionId,
	);

	if (page.initScriptId !== null) {
		await client.send(
			"Page.removeScriptToEvaluateOnNewDocument",
			{ identifier: page.initScriptId },
			sessionId,
		);
		page.initScriptId = null;
	}
	const added = await client.send(
		"Page.addScriptToEvaluateOnNewDocument",
		{
			// The same script also runs on about:blank, where localStorage access on
			// an opaque origin throws — hence the catch.
			source: `try { localStorage.setItem("theme", ${JSON.stringify(theme)}); } catch {}`,
		},
		sessionId,
	);
	page.initScriptId = expectString(
		added,
		"identifier",
		"Page.addScriptToEvaluateOnNewDocument",
	);

	await navigateAndWait(page, url);

	await page.tracker.waitForQuiet();
	// Charts animate in after their data arrives, so the network going quiet is
	// not the same as the page having stopped moving.
	if (options.settleMs > 0) await Bun.sleep(options.settleMs);

	const probe = await probeTheme(page, theme);
	if (!probe.matches) {
		throw new Error(
			`Theme assertion failed for ${capture.route} (${theme}): <html> class is "${probe.classes}", expected it to contain "${theme}". Refusing to write a screenshot in the wrong theme.`,
		);
	}

	const shot = await client.send(
		"Page.captureScreenshot",
		{ format: "png", captureBeyondViewport: false },
		sessionId,
	);
	const data = expectString(shot, "data", "Page.captureScreenshot");
	const bytes = Buffer.from(data, "base64");
	const outPath = join(options.outDir, `${capture.name}-${theme}.png`);
	await Bun.write(outPath, bytes);
	console.log(`${outPath} (${bytes.byteLength} bytes)`);
}

export async function captureAll(options: CaptureOptions): Promise<void> {
	mkdirSync(options.outDir, { recursive: true });

	const browser = await launchChromium();
	let client: CdpClient | null = null;
	try {
		client = await CdpClient.connect(browser.webSocketDebuggerUrl);
		const page = await openPageSession(client);
		await authenticate(page, options);
		for (const capture of CAPTURES) {
			for (const theme of THEMES) {
				await captureOne(page, options, capture, theme);
			}
		}
	} finally {
		client?.close();
		await shutdownChromium(browser);
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	await captureAll(options);
}

// Only run when invoked directly, so CAPTURES can be imported by other scripts.
if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
