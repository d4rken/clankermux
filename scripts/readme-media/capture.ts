#!/usr/bin/env bun
/**
 * Screenshots the dashboard of a locally running ClankerMux into `.assets/`.
 *
 * Headless Chromium is driven directly over the Chrome DevTools Protocol on a
 * raw WebSocket; the transport, the browser process and the page primitives
 * live in `scripts/cdp/client.ts`.
 *
 * The one thing this script is paranoid about is the theme. A capture that
 * silently came out in the wrong theme still produces a plausible-looking PNG,
 * so both theme signals are set (the media feature and the `theme` key the app
 * reads from localStorage) and the resulting `<html>` class list is asserted
 * before the screenshot is taken.
 *
 * Usage:
 *   bun scripts/readme-media/capture.ts \
 *     --base-url http://127.0.0.1:8081 --out-dir .assets \
 *     [--width 1440] [--height 980] [--scale 2] [--settle-ms 2500] \
 *     [--password <management password>]
 */

import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	CdpClient,
	evaluateInPage,
	expectString,
	isRecord,
	launchChromium,
	navigateAndWait,
	type PageSession,
	openPageSession,
	shutdownChromium,
} from "../cdp/client";

// ---------------------------------------------------------------------------
// What gets captured
// ---------------------------------------------------------------------------

/**
 * Routes to capture, and the file stem each one is written under. One per
 * feature group, plus the landing view.
 *
 * An entry may carry `height` to override the run's default viewport height for
 * that one route, for a page whose content would otherwise fall below the fold.
 */
export const CAPTURES = [
	{ route: "/", name: "overview" },
	{ route: "/clients", name: "clients" },
	{ route: "/usage", name: "limits" },
	{ route: "/routing", name: "routing" },
] as const;

export type Capture = (typeof CAPTURES)[number];

/** The two themes the app supports as an explicit choice (`system` is not one). */
export type ThemeName = "light" | "dark";

export const THEMES: readonly ThemeName[] = ["light", "dark"];

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
