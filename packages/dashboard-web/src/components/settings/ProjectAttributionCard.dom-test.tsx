/**
 * The project-attribution card, mounted for real.
 *
 * The list editor is a draft: rows are added, edited and removed locally and
 * only the Save button writes. That makes the failure modes all about WHEN and
 * WHAT is written — a save that fires while a row is half-typed would persist a
 * blank rule, a save that sends only the edited list would write the other list
 * back at its stale value, and a Save button that stays live when nothing has
 * changed invites a pointless write that clears the session cache.
 *
 * Stubbed with `spyOn` on the api singleton, never `mock.module`: a module mock
 * here is process-wide and its partial export set breaks every later file in
 * the DOM lane.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type {
	ProjectRulesGetResponse,
	ProjectRulesSetRequest,
} from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../api";
import { ProjectAttributionCard } from "./ProjectAttributionCard";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: Array<() => void> = [];

const SERVER: ProjectRulesGetResponse = {
	roots: ["/home/*/projects", "/home/*"],
	overrides: [{ prefix: "/home/anna/.claude", name: ".claude" }],
	defaultRoots: ["/home/*/projects", "/home/*"],
	unmatched: [{ path: "/workspace/myrepo", count: 4, lastSeenAt: 1 }],
};

async function mount(): Promise<{ writes: ProjectRulesSetRequest[] }> {
	const writes: ProjectRulesSetRequest[] = [];

	const readSpy = spyOn(api, "getProjectRules").mockImplementation(async () =>
		structuredClone(SERVER),
	);
	const writeSpy = spyOn(api, "setProjectRules").mockImplementation(
		async (rules: ProjectRulesSetRequest) => {
			writes.push(rules);
		},
	);
	restores.push(
		() => readSpy.mockRestore(),
		() => writeSpy.mockRestore(),
	);

	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchInterval: false },
			mutations: { retry: false },
		},
	});
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<ProjectAttributionCard />
			</QueryClientProvider>,
		);
	});
	await settle();
	return { writes };
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function inputs(): HTMLInputElement[] {
	return [...(host?.querySelectorAll<HTMLInputElement>("input") ?? [])];
}

/**
 * One labelled cell. Selecting by position is what made an earlier version of
 * this file silently type into the WRONG list: "the last input on the page"
 * is an override field, not the root row that was just added.
 */
function cell(label: string): HTMLInputElement {
	const found = host?.querySelector<HTMLInputElement>(
		`input[aria-label="${label}"]`,
	);
	if (!found) throw new Error(`No input labelled "${label}"`);
	return found;
}

function rootCells(): HTMLInputElement[] {
	return [
		...(host?.querySelectorAll<HTMLInputElement>(
			'input[aria-label$=" path"]',
		) ?? []),
	];
}

/** A control addressed by its aria-label, for the per-row buttons. */
function button(label: string): HTMLElement {
	const found = host?.querySelector<HTMLElement>(`[aria-label="${label}"]`);
	if (!found) throw new Error(`No control labelled "${label}"`);
	return found;
}

function buttons(label: string): HTMLElement[] {
	return [...(host?.querySelectorAll<HTMLElement>("button") ?? [])].filter(
		(b) => (b.textContent ?? "").trim() === label,
	);
}

function saveButton(): HTMLButtonElement {
	// Exactly one, card-level: the endpoint replaces the whole rule set, so a
	// per-list button would be a second control doing the same write.
	const found = buttons("Save rules");
	if (found.length !== 1) {
		throw new Error(`Expected one Save button, found ${found.length}`);
	}
	return found[0] as HTMLButtonElement;
}

async function type(field: HTMLInputElement, value: string): Promise<void> {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function click(element: HTMLElement): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await settle();
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	host?.remove();
	root = null;
	host = null;
	while (restores.length) restores.pop()?.();
});

describe("ProjectAttributionCard interactions", () => {
	it("seeds the draft from the server and writes nothing on mount", async () => {
		const { writes } = await mount();
		const values = inputs().map((i) => i.value);
		expect(values).toContain("/home/*/projects");
		expect(values).toContain("/home/anna/.claude");
		expect(writes).toEqual([]);
	});

	it("keeps Save inert until the draft diverges", async () => {
		await mount();
		expect(saveButton().disabled).toBe(true);
	});

	it("saves BOTH lists, so an untouched list is not written back stale", async () => {
		// The endpoint replaces the whole rule set. Sending only the list the
		// operator touched would silently revert the other one.
		const { writes } = await mount();
		await type(cell("root 1 path"), "/srv/repos");
		await click(saveButton());

		expect(writes).toHaveLength(1);
		expect(writes[0].roots[0]).toBe("/srv/repos");
		expect(writes[0].overrides).toEqual([
			{ prefix: "/home/anna/.claude", name: ".claude" },
		]);
	});

	it("adds a row without writing, and refuses to save while it is blank", async () => {
		// A blank row is "still typing", not an error — but persisting it would
		// store a rule that matches nothing.
		const { writes } = await mount();
		const before = inputs().length;
		await click(buttons("Add root")[0]);

		expect(inputs().length).toBe(before + 1);
		expect(writes).toEqual([]);
		expect(saveButton().disabled).toBe(true);
	});

	it("saves once the added row is filled in", async () => {
		const { writes } = await mount();
		await click(buttons("Add root")[0]);
		await type(cell(`root ${rootCells().length} path`), "/workspace");
		await click(saveButton());

		expect(writes).toHaveLength(1);
		expect(writes[0].roots).toContain("/workspace");
	});

	it("refuses to save an override missing its name", async () => {
		// Two columns, both required: a prefix with no name maps a path to
		// nothing.
		const { writes } = await mount();
		await click(buttons("Add override")[0]);
		await type(cell("override 2 prefix"), "/workspace/thing");
		await click(saveButton());

		expect(writes).toEqual([]);
	});

	it("removes a row and persists the shorter list", async () => {
		const { writes } = await mount();
		const before = inputs().length;
		await click(button("Remove root 1"));
		expect(inputs().length).toBe(before - 1);

		await click(saveButton());
		expect(writes).toHaveLength(1);
		expect(writes[0].roots).not.toContain("/home/*/projects");
	});

	it("restores the server's defaults into the draft without writing", async () => {
		const { writes } = await mount();
		await type(cell("root 1 path"), "/srv/repos");
		await click(buttons("Restore defaults")[0]);

		expect(inputs().map((i) => i.value)).toContain("/home/*/projects");
		expect(writes).toEqual([]);
	});

	it("shows the unmatched paths the server reported", async () => {
		await mount();
		expect(host?.textContent ?? "").toContain("/workspace/myrepo");
	});
});
