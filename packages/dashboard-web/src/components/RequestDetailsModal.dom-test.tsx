import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, type RequestPayload, type RequestSummary } from "../api";
import { RequestDetailsModal } from "./RequestDetailsModal";

/**
 * The response tab's three-way fallback, mounted for real.
 *
 * It used to be two-way — a rendered response, or the permanent
 * "no response data available" text — and the loading state was missing
 * entirely. Adding it as a third branch is only correct if it is reachable and
 * if the other two still are, which a portalled Radix dialog will not tell
 * `renderToStaticMarkup`: the modal's content is not in the host subtree at all.
 *
 * API access is stubbed with `spyOn` on the `api` object, never `mock.module`.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function payload(over: Partial<RequestPayload> = {}): RequestPayload {
	return {
		id: "req-1",
		request: { headers: { "content-type": "application/json" }, body: null },
		response: null,
		meta: { timestamp: 1_700_000_000_000, success: true },
		...over,
	} as RequestPayload;
}

async function settle(rounds = 3): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}

async function mount(
	request: RequestPayload,
	summary?: RequestSummary,
): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<RequestDetailsModal
				request={request}
				summary={summary}
				isOpen={true}
				onClose={() => {}}
			/>,
		);
	});
	await settle();
}

/**
 * Switches to a tab by its trigger label.
 *
 * Radix activates a trigger on `mousedown`, not on `click`, so `el.click()`
 * alone leaves the conversation tab selected and every assertion below reads
 * the wrong panel.
 */
async function openTab(label: string): Promise<void> {
	const trigger = Array.from(
		document.body.querySelectorAll<HTMLElement>('[role="tab"]'),
	).find((el) => el.textContent?.trim() === label);
	if (!trigger) throw new Error(`no tab trigger labelled ${label}`);
	await act(async () => {
		trigger.dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, button: 0 }),
		);
		trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await settle(1);
}

function responsePanel(): HTMLElement {
	const panel = document.body.querySelector<HTMLElement>(
		'[role="tabpanel"][data-state="active"]',
	);
	if (!panel) throw new Error("no active tab panel");
	return panel;
}

afterEach(async () => {
	if (root) {
		const current = root;
		await act(async () => {
			current.unmount();
		});
		root = null;
	}
	host?.remove();
	host = null;
	document.body.innerHTML = "";
});

describe("RequestDetailsModal response tab", () => {
	it("renders the stored payload when a response is present", async () => {
		spyOn(api, "getRequestPayload").mockImplementation(
			async () => payload() as never,
		);
		await mount(
			payload({
				response: { status: 200, headers: { "x-a": "b" }, body: null },
			}),
		);
		await openTab("Response");

		const panel = responsePanel();
		expect(panel.textContent).toContain("Headers");
		expect(panel.textContent).not.toContain("No response data available");
		expect(panel.querySelector("[aria-busy]")).toBeNull();
	});

	/**
	 * The branch that did not exist before. `needsHydration` is true only while a
	 * body-less placeholder is still being fetched, and the permanent error
	 * branch below never switched on it — so folding the loading state in there
	 * would have produced a message that can never appear.
	 */
	it("renders an announced skeleton while the payload is still loading", async () => {
		// Never resolves: the modal stays in its hydrating state for the assertion.
		spyOn(api, "getRequestPayload").mockImplementation(
			() => new Promise<RequestPayload>(() => {}),
		);
		await mount(
			// `undefined`, not `null`: `RequestPayload.request` is non-nullable, and
			// the modal only ever tests it for truthiness.
			payload({
				request: undefined,
				response: null,
			}),
		);
		await openTab("Response");

		const panel = responsePanel();
		const busy = panel.querySelector<HTMLElement>('[aria-busy="true"]');
		expect(busy).not.toBeNull();
		expect(busy?.textContent).toContain("Loading payload");
		expect(panel.textContent).not.toContain("No response data available");
	});

	it("renders the permanent no-response state when nothing is loading", async () => {
		spyOn(api, "getRequestPayload").mockImplementation(
			async () => payload() as never,
		);
		await mount(
			payload({
				response: null,
				error: "upstream_overloaded",
			}),
		);
		await openTab("Response");

		const panel = responsePanel();
		expect(panel.textContent).toContain("No response data available");
		expect(panel.textContent).toContain("upstream_overloaded");
		expect(panel.querySelector("[aria-busy]")).toBeNull();
	});
});

describe("RequestDetailsModal request tab", () => {
	it("announces the loading payload rather than showing a silent skeleton", async () => {
		spyOn(api, "getRequestPayload").mockImplementation(
			() => new Promise<RequestPayload>(() => {}),
		);
		await mount(payload({ request: undefined, response: null }));
		await openTab("Request");

		const busy =
			responsePanel().querySelector<HTMLElement>('[aria-busy="true"]');
		expect(busy).not.toBeNull();
		expect(busy?.querySelector('[role="status"]')?.textContent).toBe(
			"Loading payload",
		);
	});
});

describe("RequestDetailsModal notices", () => {
	it("renders the execution error as a destructive Alert", async () => {
		spyOn(api, "getRequestPayload").mockImplementation(
			async () => payload() as never,
		);
		await mount(
			payload({
				response: { status: 500, headers: {}, body: null },
				error: "provider_overloaded",
			}),
		);

		const alert = Array.from(
			document.body.querySelectorAll<HTMLElement>("div"),
		).find((el) => el.className.includes("bg-destructive/10"));
		expect(alert).toBeDefined();
		expect(alert?.className).toContain("border-destructive/25");
		expect(alert?.className).toContain("rounded-lg");
		expect(alert?.className).toContain("p-row");
		expect(alert?.textContent).toContain("provider_overloaded");
	});
});

describe("RequestDetailsModal gateway hints", () => {
	it("shows all five hints from the summary without a retained payload", async () => {
		spyOn(api, "getRequestPayload").mockImplementation(
			async () => payload() as never,
		);
		const summary: RequestSummary = {
			id: "req-1",
			timestamp: "2026-09-17T00:00:00Z",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 429,
			success: false,
			errorMessage: "limited",
			responseTimeMs: 1,
			failoverAttempts: 0,
			gatewayHintRequestClass: "primary",
			gatewayHintAgentType: "<script>explore</script>",
			gatewayHintPrevToolDurations: "[12,34]",
			gatewayHintCompaction: "false",
			gatewayHintContextCompacted: "0",
		};
		await mount(payload(), summary);
		expect(document.body.textContent).toContain("Request class: primary");
		expect(document.body.textContent).toContain(
			"Agent type: <script>explore</script>",
		);
		await openTab("Metadata");
		const hints = document.body.querySelector(
			'[aria-label="Claude Code hints"]',
		);
		expect(hints?.textContent).toContain("[12,34]");
		expect(hints?.textContent).toContain("false");
		expect(hints?.textContent).toContain("0");
		expect(hints?.querySelectorAll("dt")).toHaveLength(5);
		expect(document.body.querySelector("script")).toBeNull();
	});
	it("omits the hints block for older clients", async () => {
		await mount(payload());
		await openTab("Metadata");
		expect(
			document.body.querySelector('[aria-label="Claude Code hints"]'),
		).toBeNull();
		expect(document.body.textContent).not.toContain("Request class:");
	});
});
