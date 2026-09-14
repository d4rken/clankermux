#!/usr/bin/env bun
/**
 * Chrome DevTools Protocol plumbing: launch a headless Chromium, attach to a
 * page, evaluate in it, navigate, and dispatch real input events.
 *
 * Driven directly over a raw WebSocket. There is no puppeteer/playwright here
 * and none is wanted: the consumers are a screenshot run and one end-to-end
 * flow, and a browser-automation dependency tree is a poor trade for that.
 *
 * The input helpers dispatch through `Input.*` rather than calling DOM methods,
 * so the handlers under test are the ones a real click would reach.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

export type CdpParams = Record<string, unknown>;
export type CdpResult = Record<string, unknown>;
export type CdpEventHandler = (
	params: CdpParams,
	sessionId: string | undefined,
) => void;

interface PendingCommand {
	resolve: (result: CdpResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	label: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minimal CDP transport: correlates command ids with their replies, dispatches
 * everything else as an event, and refuses to let any command outlive
 * {@link COMMAND_TIMEOUT_MS}.
 */
export class CdpClient {
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

export function expectString(result: CdpResult, key: string, context: string): string {
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

export interface Browser {
	proc: ReturnType<typeof Bun.spawn>;
	userDataDir: string;
	webSocketDebuggerUrl: string;
}

export function chromiumArgs(userDataDir: string): string[] {
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
export function readDevToolsUrl(
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

export async function launchChromium(): Promise<Browser> {
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

export async function shutdownChromium(browser: Browser): Promise<void> {
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
export class NetworkQuietTracker {
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

export interface PageSession {
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

export async function openPageSession(client: CdpClient): Promise<PageSession> {
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
export async function evaluateInPage(
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
export async function navigateAndWait(page: PageSession, url: string): Promise<void> {
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

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** How long {@link waitForSelector} waits by default. */
export const SELECTOR_TIMEOUT_MS = 10_000;
const SELECTOR_POLL_MS = 50;

/** Escaped so a selector can be embedded in an evaluated expression. */
const literal = (value: string) => JSON.stringify(value);

/** Resolves when `selector` matches at least one element, or throws. */
export async function waitForSelector(
	page: PageSession,
	selector: string,
	timeoutMs = SELECTOR_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await evaluateInPage(
			page,
			`!!document.querySelector(${literal(selector)})`,
			`Waiting for ${selector}`,
		);
		if (found === true) return;
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting ${timeoutMs}ms for ${selector}`);
		await Bun.sleep(SELECTOR_POLL_MS);
	}
}

/** The trimmed text of the first match, or `null` when nothing matches. */
export async function textOf(
	page: PageSession,
	selector: string,
): Promise<string | null> {
	const value = await evaluateInPage(
		page,
		`(() => {
			const node = document.querySelector(${literal(selector)});
			return node === null ? null : node.textContent.trim();
		})()`,
		`Reading ${selector}`,
	);
	if (value === null) return null;
	if (typeof value !== "string")
		throw new Error(
			`Reading ${selector} returned ${JSON.stringify(value)}, expected text`,
		);
	return value;
}

/**
 * Clicks the centre of the first match with a real mouse event pair.
 *
 * `element.click()` would be simpler and would be wrong: it skips hit testing,
 * so a control covered by an overlay or scrolled out of view still "clicks",
 * and the run passes against a UI a person could not operate.
 */
export async function clickSelector(
	page: PageSession,
	selector: string,
): Promise<void> {
	await waitForSelector(page, selector);
	const box = await evaluateInPage(
		page,
		`(() => {
			const node = document.querySelector(${literal(selector)});
			node.scrollIntoView({ block: "center", inline: "center" });
			const rect = node.getBoundingClientRect();
			return {
				x: rect.left + rect.width / 2,
				y: rect.top + rect.height / 2,
				width: rect.width,
				height: rect.height,
			};
		})()`,
		`Locating ${selector}`,
	);
	if (
		!isRecord(box) ||
		typeof box.x !== "number" ||
		typeof box.y !== "number" ||
		typeof box.width !== "number" ||
		typeof box.height !== "number"
	)
		throw new Error(
			`Locating ${selector} returned an unusable box: ${JSON.stringify(box)}`,
		);
	if (box.width === 0 || box.height === 0)
		throw new Error(`${selector} has no layout box, so it cannot be clicked`);
	for (const type of ["mousePressed", "mouseReleased"] as const)
		await page.client.send(
			"Input.dispatchMouseEvent",
			{
				type,
				x: box.x,
				y: box.y,
				button: "left",
				buttons: type === "mousePressed" ? 1 : 0,
				clickCount: 1,
			},
			page.sessionId,
		);
}

/** Focuses the first match and inserts `text` as typed input. */
export async function typeIntoSelector(
	page: PageSession,
	selector: string,
	text: string,
): Promise<void> {
	await waitForSelector(page, selector);
	await evaluateInPage(
		page,
		`document.querySelector(${literal(selector)}).focus()`,
		`Focusing ${selector}`,
	);
	await page.client.send("Input.insertText", { text }, page.sessionId);
}
