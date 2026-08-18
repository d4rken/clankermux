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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { api, type RequestPayload, type RequestSummary } from "../api";
import { API_LIMITS } from "../constants";
import { queryKeys } from "../lib/query-keys";
import { RequestsTab } from "./RequestsTab";

/**
 * The Requests tab's URL-addressable state, mounted for real.
 *
 * `?request=<id>` and `?project=<name>` are what the Live Activity card links
 * to, so their resolution has to hold up against a real router and a real query
 * client: the modal is a portalled Radix dialog that `renderToStaticMarkup`
 * cannot see at all, and the four states of the by-id lookup only exist once
 * the query has actually run.
 *
 * API access is stubbed with `spyOn` on the `api` object, never `mock.module` —
 * a partial `mock.module` return leaks into later files in this suite.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LOADED_ID = "loaded-request";
const REMOTE_ID = "remote-request";

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

/** Reports the router's live query string so URL effects can be asserted. */
function SearchProbe() {
	currentSearch = useLocation().search;
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
	/** What the by-id lookup does. */
	byId?: () => Promise<RequestSummary | null>;
}

async function mount(initialEntry: string, stubs: Stubs = {}): Promise<void> {
	spyOn(api, "getRequestsSummary").mockImplementation(async () =>
		stubs.loaded ? [...stubs.loaded] : [],
	);
	spyOn(api, "getRequestById").mockImplementation(
		stubs.byId ?? (async () => null),
	);
	spyOn(api, "getRequestsCount").mockImplementation(async () => 0);
	spyOn(api, "getAccounts").mockImplementation(async () => []);
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
