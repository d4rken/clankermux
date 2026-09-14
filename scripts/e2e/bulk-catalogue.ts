#!/usr/bin/env bun
/**
 * Drives the bulk catalogue editor end to end against a running ClankerMux.
 *
 * A real Chromium over CDP, real dispatched input, the real dashboard bundle
 * and the real server. The database assertions at the end are the point of
 * running it at all: the UI cannot see a half-applied transaction, so the run
 * finishes by reading the rows the batch wrote.
 *
 * Boot the instance with scripts/e2e/run-bulk-catalogue.sh; this script only
 * drives one that is already answering.
 *
 * Usage:
 *   bun scripts/e2e/bulk-catalogue.ts --base-url http://127.0.0.1:8082 \
 *     --db /tmp/…/e2e.db --password <management password>
 */

import { Database } from "bun:sqlite";
import {
	CdpClient,
	clickSelector,
	evaluateInPage,
	isRecord,
	launchChromium,
	navigateAndWait,
	type PageSession,
	openPageSession,
	shutdownChromium,
	waitForSelector,
} from "../cdp/client";
import { ALPHA_MODEL, SUGGESTED_MODEL } from "./seed-bulk-db";

interface Options {
	baseUrl: string;
	dbPath: string;
	password: string;
}

function parseArgs(argv: string[]): Options {
	const read = (flag: string): string => {
		const index = argv.indexOf(flag);
		const value = index === -1 ? undefined : argv[index + 1];
		if (value === undefined) {
			console.error(
				"Usage: bun scripts/e2e/bulk-catalogue.ts --base-url <url> --db <path> --password <password>",
			);
			process.exit(1);
		}
		return value;
	};
	return {
		baseUrl: read("--base-url"),
		dbPath: read("--db"),
		password: read("--password"),
	};
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const quote = (value: string) => JSON.stringify(value);

/** Everything the page currently renders, as one string. */
async function pageText(page: PageSession): Promise<string> {
	const value = await evaluateInPage(
		page,
		"document.body.textContent",
		"Reading the page",
	);
	return typeof value === "string" ? value : "";
}

/**
 * Clicks the element matching `selector` whose accessible name is `text`.
 *
 * CSS cannot select on text, so the element is marked first and then clicked
 * through {@link clickSelector} — the click itself still goes through real
 * mouse events and real hit testing.
 */
async function clickLabelled(
	page: PageSession,
	selector: string,
	text: string,
	{ prefix = false } = {},
): Promise<void> {
	const marked = await evaluateInPage(
		page,
		`(() => {
			for (const stale of document.querySelectorAll("[data-e2e-target]"))
				stale.removeAttribute("data-e2e-target");
			const name = (node) =>
				node.getAttribute("aria-label") ?? node.textContent.trim();
			const node = [...document.querySelectorAll(${quote(selector)})].find((n) =>
				${prefix ? `name(n).startsWith(${quote(text)})` : `name(n) === ${quote(text)}`},
			);
			if (!node) return false;
			node.setAttribute("data-e2e-target", "1");
			return true;
		})()`,
		`Finding ${selector} labelled ${text}`,
	);
	assert(marked === true, `No ${selector} labelled "${text}" on the page`);
	await clickSelector(page, `${selector}[data-e2e-target="1"]`);
}

/**
 * Sets a native `<select>` and fires its change event.
 *
 * The only synthetic event in this script: a native dropdown's popup is drawn
 * by the platform, not the page, so there is no CDP input sequence that can
 * choose an option in it.
 */
async function chooseOption(
	page: PageSession,
	label: string,
	value: string,
): Promise<void> {
	const selector = `select[aria-label=${quote(label)}]`;
	await waitForSelector(page, selector);
	const chosen = await evaluateInPage(
		page,
		`(() => {
			const el = document.querySelector(${quote(selector)});
			const setter = Object.getOwnPropertyDescriptor(
				HTMLSelectElement.prototype,
				"value",
			).set;
			setter.call(el, ${quote(value)});
			el.dispatchEvent(new Event("change", { bubbles: true }));
			return el.value;
		})()`,
		`Choosing ${value} in ${label}`,
	);
	assert(chosen === value, `${label} did not take the value ${value}`);
}

/** The whole list row for `name`, located through its selection checkbox. */
async function clientRow(
	page: PageSession,
	name: string,
): Promise<string | null> {
	const selector = `input[aria-label=${quote(`Select ${name}`)}]`;
	const value = await evaluateInPage(
		page,
		`(() => {
			const box = document.querySelector(${quote(selector)});
			return box === null ? null : box.closest("li").textContent;
		})()`,
		`Reading the row for ${name}`,
	);
	return typeof value === "string" ? value : null;
}

/** How many OpenAI catalogue models the list reports for `name`. */
async function openaiCount(page: PageSession, name: string): Promise<number> {
	const row = await clientRow(page, name);
	assert(row !== null, `${name} is not in the client list`);
	const match = /(\d+)\s+OpenAI/.exec(row);
	assert(match !== null, `The row for ${name} has no OpenAI count: ${row}`);
	return Number(match[1]);
}

/**
 * Records every `/api/clients/bulk/*` exchange on the page.
 *
 * A stalled wait in this script is almost always the server having refused the
 * batch: the component catches the failure into its error banner and never
 * leaves the editor. Without the status and body the timeout reports only the
 * selector it gave up on, which says nothing about why.
 *
 * Survives no navigation, so it is reinstalled after each one.
 */
async function recordBulkCalls(page: PageSession): Promise<void> {
	await evaluateInPage(
		page,
		`(() => {
			if (window.__bulkCalls) return true;
			window.__bulkCalls = [];
			const original = window.fetch;
			window.fetch = async (...args) => {
				const response = await original(...args);
				const input = args[0];
				const url = typeof input === "string" ? input : (input?.url ?? "");
				if (url.includes("/api/clients/bulk/")) {
					let body;
					try {
						body = (await response.clone().text()).slice(0, 1000);
					} catch (e) {
						body = "<body unreadable: " + e + ">";
					}
					window.__bulkCalls.push({ url, status: response.status, body });
				}
				return response;
			};
			return true;
		})()`,
		"Installing the bulk request recorder",
	);
}

/** What the page was showing when a step gave up. */
async function describePage(page: PageSession): Promise<string> {
	try {
		const state = await evaluateInPage(
			page,
			`(() => {
				const calls = window.__bulkCalls ?? [];
				return {
					alerts: [...document.querySelectorAll('[role="alert"]')].map((n) =>
						n.textContent.trim(),
					),
					previewMounted:
						document.querySelector('[aria-label="Bulk edit preview"]') !== null,
					buttons: [...document.querySelectorAll("button")].map(
						(b) => b.textContent.trim() + (b.disabled ? " [disabled]" : ""),
					),
					lastBulkCall: calls.length ? calls[calls.length - 1] : null,
					bulkCallCount: calls.length,
				};
			})()`,
			"Collecting page state",
		);
		return JSON.stringify(state, null, 2);
	} catch (error) {
		return `page state unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
}

async function login(page: PageSession, options: Options): Promise<void> {
	// The login must run from the app's own origin: a fetch from about:blank has
	// an opaque origin and its Set-Cookie is dropped.
	await navigateAndWait(page, options.baseUrl);
	await recordBulkCalls(page);
	const result = await evaluateInPage(
		page,
		`(async () => {
			const r = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ password: ${quote(options.password)} }),
				credentials: "same-origin",
			});
			const status = await fetch("/api/auth/status", { credentials: "same-origin" });
			return { login: r.status, authenticated: (await status.json()).authenticated };
		})()`,
		"Management login",
		true,
	);
	assert(
		isRecord(result) && result.authenticated === true,
		`Management login did not take: ${JSON.stringify(result)}`,
	);
}

async function drive(page: PageSession, options: Options): Promise<void> {
	await login(page, options);

	// --- the list, and the selection -----------------------------------------
	await navigateAndWait(page, new URL("/clients", options.baseUrl).toString());
	await recordBulkCalls(page);
	for (const name of ["Alpha", "Bravo", "Charlie"])
		await waitForSelector(page, `input[aria-label="Select ${name}"]`);
	assert(
		(await openaiCount(page, "Alpha")) === 1 &&
			(await openaiCount(page, "Bravo")) === 0 &&
			(await openaiCount(page, "Charlie")) === 0,
		"The seeded OpenAI catalogue counts are not what the run expects",
	);
	await clickSelector(page, 'input[aria-label="Select Alpha"]');
	await clickSelector(page, 'input[aria-label="Select Bravo"]');
	assert(
		(await pageText(page)).includes("2 selected"),
		"The selection bar does not report two selected clients",
	);

	// --- add one model to both -----------------------------------------------
	await clickLabelled(page, "button", "Edit catalogues");
	await waitForSelector(page, '[role="tab"]');
	await clickLabelled(page, '[role="tab"]', "OpenAI", { prefix: true });
	await waitForSelector(page, `input[aria-label="Select ${SUGGESTED_MODEL}"]`);
	await clickSelector(page, `input[aria-label="Select ${SUGGESTED_MODEL}"]`);
	await clickLabelled(page, "button", "Add to all selected");
	await waitForSelector(page, '[aria-label="Bulk edit preview"]');
	const preview = await pageText(page);
	assert(
		preview.includes("2 of 2 clients will change"),
		`The preview does not report two changed clients: ${preview}`,
	);
	for (const id of ["alpha", "bravo"]) {
		const row = await evaluateInPage(
			page,
			`document.querySelector('[data-preview=${quote(id)}]')?.textContent ?? null`,
			`Reading the preview row for ${id}`,
		);
		assert(
			typeof row === "string" &&
				row.includes("changed") &&
				row.includes(SUGGESTED_MODEL),
			`The preview row for ${id} does not add ${SUGGESTED_MODEL}: ${String(row)}`,
		);
	}
	const unselected = await evaluateInPage(
		page,
		'document.querySelector(\'[data-preview="charlie"]\') !== null',
		"Checking the unselected client",
	);
	assert(
		unselected === false,
		"The unselected client appears in the bulk preview",
	);
	await clickLabelled(page, "button", "Apply to", { prefix: true });

	// --- back on the list, with two catalogues changed ------------------------
	await waitForSelector(page, 'input[aria-label="Select Alpha"]');
	await waitUntil(
		async () => (await openaiCount(page, "Bravo")) === 1,
		"Bravo's OpenAI catalogue never gained the added model",
	);
	assert(
		(await openaiCount(page, "Alpha")) === 2,
		"Alpha's OpenAI catalogue did not gain the added model",
	);
	assert(
		(await openaiCount(page, "Charlie")) === 0,
		"The unselected client's catalogue changed",
	);

	// --- replace Bravo's whole OpenAI catalogue from Alpha's ------------------
	await clickSelector(page, 'input[aria-label="Select Alpha"]');
	await clickSelector(page, 'input[aria-label="Select Bravo"]');
	await clickLabelled(page, "button", "Edit catalogues");
	await clickLabelled(page, '[role="tab"]', "OpenAI", { prefix: true });
	await clickSelector(page, "details > summary");
	await chooseOption(page, "Start from", "alpha");
	await clickLabelled(page, "button", "Replace catalogue for", { prefix: true });
	await waitForSelector(page, '[role="dialog"]');
	await clickLabelled(page, "button", "Replace catalogues");
	await waitForSelector(page, '[aria-label="Bulk edit preview"]');
	await clickLabelled(page, "button", "Apply to", { prefix: true });
	await waitForSelector(page, 'input[aria-label="Select Alpha"]');
	await waitUntil(
		async () => (await openaiCount(page, "Bravo")) === 2,
		"Bravo's OpenAI catalogue was not replaced with Alpha's",
	);
}

async function waitUntil(
	check: () => Promise<boolean>,
	message: string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() >= deadline) throw new Error(message);
		await Bun.sleep(100);
	}
}

/**
 * What the UI cannot show: whether the batch landed whole. A half-applied
 * transaction renders exactly like a complete one until the next reload.
 */
function assertDatabase(dbPath: string): void {
	const db = new Database(dbPath, { readonly: true });
	try {
		const profiles = db
			.query("SELECT api_key_id, revision, catalogues FROM client_profiles")
			.all() as { api_key_id: string; revision: number; catalogues: string }[];
		const by = new Map(profiles.map((p) => [p.api_key_id, p]));
		for (const id of ["alpha", "bravo", "charlie"])
			assert(by.has(id), `Client ${id} lost its profile`);
		assert(
			by.get("alpha")!.revision === 2,
			`Alpha's revision is ${by.get("alpha")?.revision}, expected 2 (one add, then a replace that changed nothing)`,
		);
		assert(
			by.get("bravo")!.revision === 3,
			`Bravo's revision is ${by.get("bravo")?.revision}, expected 3 (one add and one replace)`,
		);
		assert(
			by.get("charlie")!.revision === 1,
			`The unselected client's revision moved to ${by.get("charlie")?.revision}`,
		);
		const ids = (id: string) =>
			(
				JSON.parse(by.get(id)!.catalogues) as {
					openai: { models: { id: string }[] };
				}
			).openai.models
				.map((m) => m.id)
				.sort();
		const expected = [ALPHA_MODEL, SUGGESTED_MODEL].sort();
		for (const id of ["alpha", "bravo"])
			assert(
				JSON.stringify(ids(id)) === JSON.stringify(expected),
				`${id} published ${JSON.stringify(ids(id))}, expected ${JSON.stringify(expected)}`,
			);
		assert(
			ids("charlie").length === 0,
			"The unselected client's catalogue was written",
		);

		const orphans = db
			.query(
				`SELECT rule_id FROM client_alias_rules
				 WHERE rule_id NOT IN (SELECT id FROM routing_rules)`,
			)
			.all() as { rule_id: string }[];
		assert(
			orphans.length === 0,
			`client_alias_rules points at ${orphans.length} missing routing rules`,
		);
		const positions = db
			.query(
				"SELECT COUNT(*) AS total, COUNT(DISTINCT position) AS distinct_positions FROM routing_rules",
			)
			.get() as { total: number; distinct_positions: number };
		assert(
			positions.total === positions.distinct_positions,
			`${positions.total} routing rules share ${positions.distinct_positions} positions`,
		);
	} finally {
		db.close();
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const browser = await launchChromium();
	let client: CdpClient | null = null;
	try {
		client = await CdpClient.connect(browser.webSocketDebuggerUrl);
		const page = await openPageSession(client);
		await client.send(
			"Emulation.setDeviceMetricsOverride",
			{ width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false },
			page.sessionId,
		);
		try {
			await drive(page, options);
		} catch (error) {
			// Before the `finally` below takes the browser down with it.
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${message}\n\nPage state:\n${await describePage(page)}`);
		}
	} finally {
		client?.close();
		await shutdownChromium(browser);
	}
	assertDatabase(options.dbPath);
	console.log("bulk catalogue end-to-end run passed");
}

await main();
