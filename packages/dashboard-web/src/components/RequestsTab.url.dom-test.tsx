import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { HttpError } from "@clankermux/http-common";
import type { SdkBridgeTurnView } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import {
	type Account,
	api,
	type RequestPayload,
	type RequestSummary,
} from "../api";
import { API_LIMITS } from "../constants";
import { queryKeys } from "../lib/query-keys";
import { RequestsTab } from "./RequestsTab";

/**
 * The Requests tab's URL-addressable state, mounted for real.
 *
 * `?request=<id>`, `?project=<name>` and `?apiKeyId=<id>` are what the Live
 * Activity card links to, so their resolution has to hold up against a real
 * router and a real query client: the modal is a portalled Radix dialog that
 * `renderToStaticMarkup` cannot see at all, and the four states of the by-id
 * lookup only exist once the query has actually run.
 *
 * API access is stubbed with `spyOn` on the `api` object, never `mock.module` —
 * a partial `mock.module` return leaks into later files in this suite.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LOADED_ID = "loaded-request";
const REMOTE_ID = "remote-request";
const KEY_ID = "key-9";
const KEY_NAME = "workstation";
const ACCOUNT_ID = "account-9";
const ACCOUNT_NAME = "backup2-darken";

function summary(over: Partial<RequestSummary> = {}): RequestSummary {
	return {
		id: LOADED_ID,
		timestamp: new Date(1_700_000_000_000).toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: "backup2-darken",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 1200,
		failoverAttempts: 0,
		model: "claude-opus-5",
		totalTokens: 5_000,
		project: "clankermux",
		...over,
	} as RequestSummary;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let queryClient: QueryClient | null = null;
let currentSearch = "";
let goBack: (() => void) | null = null;
let goForward: (() => void) | null = null;
let goTo: ((url: string) => void) | null = null;

/**
 * Reports the router's live query string so URL effects can be asserted, and
 * hands out a Back. Memory history clamps `go(-1)` at index 0, so pressing Back
 * after a replacing navigation returns the same entry, and after a pushing one
 * returns the entry before it — which is how a test tells the two apart.
 */
function SearchProbe() {
	currentSearch = useLocation().search;
	const navigate = useNavigate();
	goBack = () => navigate(-1);
	goForward = () => navigate(1);
	goTo = (url) => navigate(url);
	return null;
}

/**
 * Let React flush effects and any resolved query promises.
 *
 * Several rounds, because the by-id lookup is deliberately held until the list
 * query has settled: the slice has to arrive, the component has to re-render
 * without it containing the request, and only then does the lookup run.
 */
async function settle(rounds = 4): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}

interface Stubs {
	/** Rows the live tail returns. */
	loaded?: RequestSummary[];
	accounts?: Account[];
	/** What the by-id lookup does. */
	byId?: () => Promise<RequestSummary | null>;
	/** What the SDK bridge turn lookup does; by default no id names a turn. */
	sdkBridgeTurn?: (id: string) => Promise<SdkBridgeTurnView | null>;
}

async function mount(initialEntry: string, stubs: Stubs = {}): Promise<void> {
	spyOn(api, "getRequestsSummary").mockImplementation(async () =>
		stubs.loaded ? [...stubs.loaded] : [],
	);
	spyOn(api, "getRequestById").mockImplementation(
		stubs.byId ?? (async () => null),
	);
	spyOn(api, "getRequestsCount").mockImplementation(async () => 0);
	spyOn(api, "getSdkBridgeTurn").mockImplementation(
		stubs.sdkBridgeTurn ?? (async () => null),
	);
	spyOn(api, "getAccounts").mockImplementation(
		async () => stubs.accounts ?? [],
	);
	spyOn(api, "getRequestProjects").mockImplementation(async () => [
		"clankermux",
		"herdr",
	]);
	spyOn(api, "get").mockImplementation(async () => ({ data: [] }) as never);
	// Body hydration for whichever request the modal ends up showing.
	spyOn(api, "getRequestPayload").mockImplementation(async (id: string) => ({
		id,
		request: { headers: {}, body: null },
		response: { status: 200, headers: {}, body: null },
		meta: { timestamp: 1_700_000_000_000, success: true },
	}));

	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={queryClient as QueryClient}>
				<MemoryRouter initialEntries={[initialEntry]}>
					<SearchProbe />
					<RequestsTab />
				</MemoryRouter>
			</QueryClientProvider>,
		);
	});
	await settle();
}

/** Portalled dialog content lives outside the host, so read the whole body. */
function pageText(): string {
	return document.body.textContent ?? "";
}

function modalIsOpen(): boolean {
	return pageText().includes("Request Details");
}

/** A button named by its own text or, for the icon-led chips, by its title. */
function findButton(label: string): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll("button")).find(
		(b) => b.textContent?.trim() === label || b.getAttribute("title") === label,
	);
}

async function clickButton(label: string): Promise<void> {
	const button = findButton(label);
	expect(button).toBeDefined();
	await act(async () => {
		button?.click();
	});
	await settle();
}

/**
 * The text of every chip in the active-filters bar, which only renders while
 * some filter is applied.
 *
 * Walks up from the Clear-all button instead of matching chip classes: the
 * chips are the bar's children apart from the group that holds the counter and
 * that button, and the classes are shared with the filter chips on the rows.
 */
function activeFilterLabels(): string[] {
	const group = findButton("Clear all")?.parentElement;
	const bar = group?.parentElement;
	if (!group || !bar) return [];
	return Array.from(bar.children)
		.filter((child) => child !== group)
		.map((child) => child.textContent?.trim() ?? "");
}

afterEach(async () => {
	if (root) {
		const current = root;
		await act(async () => {
			current.unmount();
		});
	}
	host?.remove();
	root = null;
	host = null;
	queryClient = null;
	currentSearch = "";
	goBack = null;
	goForward = null;
	goTo = null;
	// spyOn call counters live on the shared `api` object, so without this a
	// "was never called" assertion would read the previous test's calls.
	mock.restore();
});

beforeEach(() => {
	currentSearch = "";
});

describe("RequestsTab — ?request=", () => {
	it("opens a request already in the loaded slice without a by-id fetch", async () => {
		await mount(`/requests?request=${LOADED_ID}`, { loaded: [summary()] });

		expect(modalIsOpen()).toBe(true);
		expect(api.getRequestById).not.toHaveBeenCalled();
	});

	it("opens a request outside the loaded slice via the by-id summary", async () => {
		await mount(`/requests?request=${REMOTE_ID}`, {
			loaded: [summary()],
			byId: async () => summary({ id: REMOTE_ID, model: "claude-sonnet-5" }),
		});

		expect(api.getRequestById).toHaveBeenCalledWith(REMOTE_ID);
		expect(modalIsOpen()).toBe(true);
		// Sourced from the by-id summary, which is the whole point of the lookup:
		// without it these fields render empty for a deep-linked request.
		expect(pageText()).toContain("claude-sonnet-5");
	});

	it("shows nothing at all while the lookup is still pending", async () => {
		// Not even a placeholder modal: its header would flash an epoch-0
		// timestamp for a request whose real one is about to arrive.
		await mount(`/requests?request=${REMOTE_ID}`, {
			loaded: [summary()],
			byId: () => new Promise(() => {}),
		});

		expect(modalIsOpen()).toBe(false);
		expect(pageText()).not.toContain("Could not load the linked request");
		expect(pageText()).not.toContain("has not been recorded yet");
	});

	it("offers a retry when the lookup fails", async () => {
		// The dashboard retry policy does not retry an HttpError — the server
		// answered — so this is a durable state that needs a manual retry.
		await mount(`/requests?request=${REMOTE_ID}`, {
			loaded: [summary()],
			byId: async () => {
				throw new HttpError(500, "boom");
			},
		});

		expect(pageText()).toContain("Could not load the linked request");
		expect(modalIsOpen()).toBe(false);
	});

	it("says a request that has no row yet may still be in flight", async () => {
		// The common case, not an error: an in-flight request has no database
		// row until it completes, and Live Activity links in-flight marks.
		await mount(`/requests?request=${REMOTE_ID}`, {
			loaded: [summary()],
			byId: async () => null,
		});

		expect(pageText()).toContain("has not been recorded yet");
		expect(pageText()).toContain("still be in flight");
		expect(modalIsOpen()).toBe(false);
	});

	it("opens the modal once a request that was in flight completes", async () => {
		// The scenario the deep link exists for: the tab was not open when the
		// request started, so the stream never delivered a `start` for it and no
		// placeholder row exists. On `summary` the reducer finds no row to patch
		// and updates the details map ALONE — resolving the URL from the payload
		// list only would leave this stuck on the not-recorded notice forever.
		await mount(`/requests?request=${REMOTE_ID}`, {
			loaded: [summary()],
			byId: async () => null,
		});
		expect(pageText()).toContain("has not been recorded yet");
		expect(modalIsOpen()).toBe(false);

		// Exactly the shape the `summary` branch of `useRequestStream` writes for
		// a request with no row in `requests`.
		const completed = summary({ id: REMOTE_ID, model: "claude-sonnet-5" });
		await act(async () => {
			queryClient?.setQueryData(
				queryKeys.requests(API_LIMITS.requestsDetail),
				(current: {
					requests: RequestPayload[];
					detailsMap: Map<string, RequestSummary>;
				}) => ({
					requests: current.requests,
					detailsMap: new Map(current.detailsMap).set(REMOTE_ID, completed),
				}),
			);
		});
		await settle();

		expect(modalIsOpen()).toBe(true);
		expect(pageText()).toContain("claude-sonnet-5");
		expect(pageText()).not.toContain("has not been recorded yet");
	});

	it("treats an empty request parameter as no selection", async () => {
		await mount("/requests?request=", { loaded: [summary()] });

		expect(modalIsOpen()).toBe(false);
		expect(api.getRequestById).not.toHaveBeenCalled();
	});
});

describe("RequestsTab — SDK bridge turns", () => {
	const LEG_ID = "leg-request";
	const turnView = (): SdkBridgeTurnView => ({
		turn: {
			id: "turn-1",
			startedAt: 1_700_000_000_000,
			finishedAt: 1_700_000_004_000,
			status: "completed",
			httpStatus: 200,
			errorType: null,
			errorMessage: null,
			apiKeyId: KEY_ID,
			apiKeyName: KEY_NAME,
			accountId: "acct-a",
			model: "claude-opus-5-5",
			clientHarness: "pi",
			clientUserAgent: null,
			project: "clankermux",
			conversationKeyHash: null,
			ccSessionId: null,
			historyMode: "rebuild_transcript",
			rebuildReason: "account_change",
			systemPromptPolicy: "drop",
			stopReason: "end_turn",
			legCount: 1,
			toolRoundCount: 0,
			innerCallCount: 1,
			innerErrorCount: 0,
			spawnMs: 1_200,
			firstEventMs: 1_800,
			durationMs: 4_000,
			sdkNumTurns: 1,
			sdkInputTokens: null,
			sdkOutputTokens: null,
			sdkCacheReadInputTokens: null,
			sdkCacheCreationInputTokens: null,
			ignoredFields: ["temperature"],
		},
		legs: [
			{
				id: LEG_ID,
				turnId: "turn-1",
				kind: "start",
				startedAt: 1_700_000_000_000,
				finishedAt: 1_700_000_004_000,
				httpStatus: 200,
				errorPhase: null,
				stopReason: "end_turn",
				errorType: null,
				errorMessage: null,
				toolUseIds: null,
			},
		],
		inner: {
			requestCount: 1,
			inputTokens: 10,
			outputTokens: 20,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			costUsd: 0.01,
		},
		accountName: "Claude A",
		innerRequests: [
			{
				id: LOADED_ID,
				timestamp: 1_700_000_001_000,
				accountId: "acct-a",
				accountName: "Claude A",
				model: "claude-opus-5-5",
				statusCode: 200,
				success: true,
				inputTokens: 10,
				outputTokens: 20,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				costUsd: 0.01,
			},
		],
		prunedInnerCalls: 0,
		matchedLegId: null,
	});
	const turnIsOpen = () => pageText().includes("Agent SDK turn");

	it("opens the turn from an inner call's chip, and closes it again", async () => {
		await mount("/requests", {
			loaded: [summary({ sdkBridgeTurnId: "turn-1" })],
			sdkBridgeTurn: async () => turnView(),
		});
		expect(turnIsOpen()).toBe(false);

		await clickButton("Agent SDK");

		expect(currentSearch).toContain("turn=turn-1");
		expect(api.getSdkBridgeTurn).toHaveBeenCalledWith("turn-1");
		expect(turnIsOpen()).toBe(true);
		expect(modalIsOpen()).toBe(false);
		const text = pageText();
		expect(text).toContain("Rebuilt from history (account change)");
		expect(text).toContain("drop");
		expect(text).toContain("temperature");
		expect(text).toContain("Claude A");

		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		await settle();
		expect(turnIsOpen()).toBe(false);
		expect(currentSearch).not.toContain("turn=");
	});

	it("shows no chip on a request the bridge did not serve", async () => {
		await mount("/requests", { loaded: [summary()] });
		expect(findButton("Agent SDK")).toBeUndefined();
	});

	it("opens a leg's turn for a request id that has no row", async () => {
		await mount(`/requests?request=${LEG_ID}`, {
			loaded: [summary()],
			byId: async () => null,
			sdkBridgeTurn: async () => ({ ...turnView(), matchedLegId: LEG_ID }),
		});

		expect(api.getSdkBridgeTurn).toHaveBeenCalledWith(LEG_ID);
		expect(turnIsOpen()).toBe(true);
		expect(pageText()).not.toContain("has not been recorded yet");
	});
});

describe("RequestsTab — ?project=", () => {
	it("preselects a named project", async () => {
		await mount("/requests?project=clankermux", { loaded: [summary()] });

		expect(pageText()).toContain("clankermux");
		expect(api.getRequestsSummary).toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ project: "clankermux" }),
		);
	});

	it("preselects a project literally named 'all'", async () => {
		// Presence, not value: reading "all" as "no filter" is what used to make
		// this link show every request instead of that project's.
		await mount("/requests?project=all", { loaded: [summary()] });

		expect(api.getRequestsSummary).toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ project: "all" }),
		);
	});

	it("preselects the empty bucket from noProject=1", async () => {
		await mount("/requests?noProject=1", { loaded: [summary()] });

		expect(pageText()).toContain("No Project");
		expect(api.getRequestsSummary).toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ noProject: true }),
		);
	});

	it("treats an empty project parameter as no filter at all", async () => {
		// Both the client serializer and the server drop an empty name by
		// truthiness, so treating it as active would pause the live tail and
		// claim "Filtered results" over a completely unfiltered list.
		await mount("/requests?project=", { loaded: [summary()] });

		expect(pageText()).toContain("Live · latest");
		expect(pageText()).not.toContain("live updates paused");
		// The live tail passes a bare limit; only the filtered explorer sends a
		// params object.
		expect(api.getRequestsSummary).toHaveBeenCalledWith(expect.any(Number));
		expect(api.getRequestsSummary).not.toHaveBeenCalledWith(
			expect.any(Number),
			expect.anything(),
		);
	});
});

function accountSelector(): HTMLElement {
	const trigger = document.querySelector<HTMLElement>(
		'[role="combobox"][aria-label="Account"]',
	);
	if (!trigger) throw new Error("Missing Account selector");
	return trigger;
}

async function accountOptions(): Promise<HTMLElement[]> {
	await act(async () => {
		accountSelector().focus();
		accountSelector().dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
		);
	});
	return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

async function chooseAccount(label: string, index = 0): Promise<void> {
	const option = (await accountOptions()).filter(
		(item) => item.textContent === label,
	)[index];
	if (!option) throw new Error(`Missing account option ${label}`);
	await act(async () => {
		option.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		);
	});
	await settle();
}

function configuredAccount(id: string, name: string): Account {
	return { id, name, provider: "ollama", disabled: false } as Account;
}

describe("RequestsTab — account URL filters", () => {
	it("writes distinct IDs for duplicate names and preserves unrelated URL state", async () => {
		await mount(
			"/requests?account=old-name&noAccount=0&project=clankermux&keep=one&keep=two",
			{
				accounts: [
					configuredAccount("account-a", "Same"),
					configuredAccount("account-b", "Same"),
				],
			},
		);
		await clickButton("Filters");
		await chooseAccount("Same", 1);
		let params = new URLSearchParams(currentSearch);
		expect(params.get("accountId")).toBe("account-b");
		expect(params.has("account")).toBe(false);
		expect(params.has("noAccount")).toBe(false);
		expect(params.get("project")).toBe("clankermux");
		expect(params.getAll("keep")).toEqual(["one", "two"]);
		expect(api.getRequestsCount).toHaveBeenLastCalledWith({
			accountId: "account-b",
			project: "clankermux",
		});
		await chooseAccount("Same", 0);
		expect(new URLSearchParams(currentSearch).get("accountId")).toBe(
			"account-a",
		);
		await chooseAccount("No Account");
		params = new URLSearchParams(currentSearch);
		expect(params.get("noAccount")).toBe("1");
		expect(params.has("accountId")).toBe(false);
		await chooseAccount("All accounts");
		expect(new URLSearchParams(currentSearch).has("noAccount")).toBe(false);
		await act(async () => {
			goBack?.();
		});
		await settle();
		// Dropdown edits replace rather than filling browser history.
		expect(new URLSearchParams(currentSearch).has("account")).toBe(false);
	});

	it("uses current configured names and never invents IDs from names", async () => {
		await mount(`/requests?accountId=${ACCOUNT_ID}`, {
			accounts: [configuredAccount(ACCOUNT_ID, "Renamed")],
			loaded: [
				summary({ accountId: ACCOUNT_ID, accountUsed: "Old name" }),
				summary({
					id: "unknown",
					accountId: null,
					accountUsed: "Name without ID",
				}),
				summary({ id: "deleted", accountId: "deleted-id", accountUsed: null }),
			],
		});
		expect(activeFilterLabels()).toContain("Renamed");
		await clickButton("Filters");
		expect(accountSelector().textContent).toBe("Renamed");
		const labels = (await accountOptions()).map((option) => option.textContent);
		expect(labels).toContain("deleted-id");
		expect(labels).not.toContain("Name without ID");
		expect(labels).not.toContain("Old name");
	});

	it("keeps an unknown selected ID visible even with no matching rows", async () => {
		await mount("/requests?accountId=ghost");
		expect(activeFilterLabels()).toContain("ghost");
		await clickButton("Filters");
		expect(accountSelector().textContent).toBe("ghost");
		expect(
			(await accountOptions()).map((option) => option.textContent),
		).toContain("ghost");
	});

	it("preserves legacy name filtering even when the name is another account's ID", async () => {
		await mount("/requests?account=legacy-name", {
			accounts: [configuredAccount("legacy-name", "Different account")],
		});
		expect(api.getRequestsCount).toHaveBeenLastCalledWith({
			account: "legacy-name",
		});
		expect(activeFilterLabels()).toContain("legacy-name");
		await clickButton("Filters");
		expect(accountSelector().textContent).toContain("legacy-name");
		await chooseAccount("Different account");
		expect(new URLSearchParams(currentSearch).get("accountId")).toBe(
			"legacy-name",
		);
		expect(new URLSearchParams(currentSearch).has("account")).toBe(false);
	});

	it("lets ID win over legacy name and ignores empty IDs or non-1 bucket flags", async () => {
		await mount(
			`/requests?accountId=${ACCOUNT_ID}&account=legacy&noAccount=true`,
		);
		expect(api.getRequestsCount).toHaveBeenLastCalledWith({
			accountId: ACCOUNT_ID,
		});
		await act(async () => {
			goTo?.("/requests?accountId=&account=legacy&noAccount=0");
		});
		await settle();
		expect(api.getRequestsCount).toHaveBeenLastCalledWith({
			account: "legacy",
		});
		await act(async () => {
			goTo?.("/requests?accountId=&account=&noAccount=0");
		});
		await settle();
		expect(pageText()).toContain("Live · latest");
	});

	it("restores account filter state on browser back and forward", async () => {
		await mount(`/requests?accountId=${ACCOUNT_ID}&keep=yes`);
		await act(async () => {
			goTo?.("/requests?noAccount=1&keep=yes");
		});
		await settle();
		expect(activeFilterLabels()).toContain("No Account");
		await act(async () => {
			goBack?.();
		});
		await settle();
		expect(activeFilterLabels()).toEqual([ACCOUNT_ID]);
		expect(new URLSearchParams(currentSearch).get("keep")).toBe("yes");
		await act(async () => {
			goForward?.();
		});
		await settle();
		expect(activeFilterLabels()).toEqual(["No Account"]);
	});

	it("clears every account form from its chip without dropping other filters", async () => {
		await mount(
			`/requests?account=legacy&accountId=${ACCOUNT_ID}&noAccount=1&project=clankermux&keep=yes`,
		);
		const group = findButton("Clear all")?.parentElement;
		const bar = group?.parentElement;
		const chip = Array.from(bar?.children ?? []).find(
			(element) => element.textContent?.trim() === "No Account",
		);
		const clear = chip?.querySelector("button");
		expect(clear).toBeDefined();
		await act(async () => {
			clear?.click();
		});
		await settle();
		expect(currentSearch).toBe("?project=clankermux&keep=yes");
	});
	it("reads accountId as the stable account identity", async () => {
		await mount(`/requests?accountId=${ACCOUNT_ID}`, {
			loaded: [summary({ accountId: ACCOUNT_ID, accountUsed: ACCOUNT_NAME })],
		});

		expect(activeFilterLabels()).toContain(ACCOUNT_NAME);
		expect(api.getRequestsSummary).toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ accountId: ACCOUNT_ID }),
		);
	});

	it("lets noAccount win over accountId and legacy account", async () => {
		await mount(
			`/requests?account=legacy-name&accountId=${ACCOUNT_ID}&noAccount=1`,
			{
				loaded: [summary({ accountId: ACCOUNT_ID, accountUsed: ACCOUNT_NAME })],
			},
		);

		expect(activeFilterLabels()).toContain("No Account");
		expect(activeFilterLabels()).not.toContain(ACCOUNT_NAME);
		expect(api.getRequestsSummary).toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ noAccount: true }),
		);
		expect(api.getRequestsSummary).not.toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ accountId: ACCOUNT_ID }),
		);
	});

	it("keeps account when browser back closes a pushed request", async () => {
		await mount(`/requests?accountId=${ACCOUNT_ID}`, {
			loaded: [summary({ accountId: ACCOUNT_ID, accountUsed: ACCOUNT_NAME })],
		});
		await clickButton("View Details");
		expect(new URLSearchParams(currentSearch).get("request")).toBe(LOADED_ID);
		await act(async () => {
			goBack?.();
		});
		await settle();
		const params = new URLSearchParams(currentSearch);
		expect(params.get("accountId")).toBe(ACCOUNT_ID);
		expect(params.has("request")).toBe(false);
	});

	it("clears all URL filters while keeping the request and unrelated state", async () => {
		await mount(
			`/requests?account=legacy&accountId=${ACCOUNT_ID}&noAccount=0&apiKeyId=${KEY_ID}&noApiKey=0&project=clankermux&noProject=0&request=${LOADED_ID}&keep=yes`,
			{
				loaded: [summary({ accountId: ACCOUNT_ID, accountUsed: ACCOUNT_NAME })],
			},
		);
		expect(activeFilterLabels()).toContain(ACCOUNT_NAME);
		expect(modalIsOpen()).toBe(true);

		await clickButton("Clear all");
		const params = new URLSearchParams(currentSearch);
		expect(params.has("accountId")).toBe(false);
		expect(params.get("request")).toBe(LOADED_ID);
		expect(params.toString()).toBe(`request=${LOADED_ID}&keep=yes`);
		expect(activeFilterLabels()).toEqual([]);
		expect(modalIsOpen()).toBe(true);
	});
});

describe("RequestsTab — ?apiKeyId=", () => {
	it("preselects a client by key id and filters on it", async () => {
		await mount(`/requests?apiKeyId=${KEY_ID}`, {
			loaded: [summary({ apiKeyId: KEY_ID, apiKeyName: KEY_NAME })],
		});

		// The URL carries the id; the chip has to name the client behind it.
		expect(activeFilterLabels()).toContain(KEY_NAME);
		expect(pageText()).toContain("live updates paused");
		expect(api.getRequestsSummary).toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ apiKeyId: KEY_ID }),
		);
	});

	it("preselects the empty bucket from noApiKey=1", async () => {
		await mount("/requests?noApiKey=1", { loaded: [summary()] });

		expect(activeFilterLabels()).toContain("No API Key");
		expect(api.getRequestsSummary).toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ noApiKey: true }),
		);
	});

	it("lets the empty bucket win when a link carries both", async () => {
		// The two are mutually exclusive, and only one of them can reach the
		// server: leaving the id active as well would send a filter the chip is
		// not showing.
		await mount(`/requests?apiKeyId=${KEY_ID}&noApiKey=1`, {
			loaded: [summary({ apiKeyId: KEY_ID, apiKeyName: KEY_NAME })],
		});

		expect(activeFilterLabels()).toContain("No API Key");
		expect(activeFilterLabels()).not.toContain(KEY_NAME);
		expect(api.getRequestsSummary).not.toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ apiKeyId: KEY_ID }),
		);
	});

	it("renders an id nothing accounts for as itself", async () => {
		// A hard-deleted key whose rows have all scrolled out of range: nothing
		// left holds its name, and a stand-in would describe the filter that is
		// still applied as some other client.
		await mount("/requests?apiKeyId=ghost-key", { loaded: [summary()] });

		expect(activeFilterLabels()).toContain("ghost-key");
		expect(api.getRequestsSummary).toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ apiKeyId: "ghost-key" }),
		);
	});

	it("applies the row's client chip without stacking a history entry", async () => {
		await mount("/requests", {
			loaded: [summary({ apiKeyId: KEY_ID, apiKeyName: KEY_NAME })],
		});

		await clickButton(`Filter by API key ${KEY_NAME}`);
		expect(new URLSearchParams(currentSearch).get("apiKeyId")).toBe(KEY_ID);

		// Fiddling with a filter must not fill the history stack: a pushed entry
		// would put the unfiltered URL one Back away from the filtered one.
		await act(async () => {
			goBack?.();
		});
		await settle();

		expect(new URLSearchParams(currentSearch).get("apiKeyId")).toBe(KEY_ID);
	});
});

describe("RequestsTab — Clear all", () => {
	it("clears both URL filters at once and keeps the open request", async () => {
		// Both filters go in ONE setSearchParams callback. Each callback is handed
		// the params captured for the render it was created in, so a second one
		// would clone a query string that still carries what the first deleted and
		// navigate it back — leaving one of these two chips standing.
		await mount(
			`/requests?apiKeyId=${KEY_ID}&project=clankermux&request=${LOADED_ID}`,
			{ loaded: [summary({ apiKeyId: KEY_ID, apiKeyName: KEY_NAME })] },
		);

		expect(activeFilterLabels()).toContain(KEY_NAME);
		expect(activeFilterLabels()).toContain("clankermux");

		await clickButton("Clear all");

		const params = new URLSearchParams(currentSearch);
		expect(params.get("apiKeyId")).toBeNull();
		expect(params.get("project")).toBeNull();
		// Clearing filters must not close an open details modal.
		expect(params.get("request")).toBe(LOADED_ID);
	});
});

describe("RequestsTab — the two URL parameters coexist", () => {
	it("keeps the project filter when the modal opens and closes", async () => {
		await mount(`/requests?project=clankermux&request=${LOADED_ID}`, {
			loaded: [summary()],
		});
		expect(modalIsOpen()).toBe(true);

		// Close via the modal's own escape route rather than a click on chrome
		// whose markup this test would then be pinned to.
		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		await settle();

		expect(new URLSearchParams(currentSearch).get("project")).toBe(
			"clankermux",
		);
		expect(new URLSearchParams(currentSearch).has("request")).toBe(false);
	});

	it("keeps an open request when the project filter changes", async () => {
		await mount(`/requests?request=${LOADED_ID}`, { loaded: [summary()] });
		expect(modalIsOpen()).toBe(true);

		// The project chip on the row applies the filter without touching the
		// rest of the query string.
		const chip = Array.from(document.querySelectorAll("button")).find(
			(b) => b.getAttribute("title") === "Filter by project clankermux",
		);
		expect(chip).toBeDefined();
		await act(async () => {
			chip?.click();
		});
		await settle();

		const params = new URLSearchParams(currentSearch);
		expect(params.get("project")).toBe("clankermux");
		expect(params.get("request")).toBe(LOADED_ID);
	});
});
