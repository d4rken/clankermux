/**
 * The Models page, mounted for real.
 *
 * Everything worth testing here is a gesture with a write behind it, and the
 * failure modes are all about WHICH write: a rename that fires per keystroke
 * would serve half-typed names to real clients, a hide that forgets to resend
 * the stored name would silently discard a rename (the write is a full
 * replacement), and a failed write that resets the field would throw away what
 * the operator typed.
 *
 * Stubbed with `spyOn` on the api singleton, never `mock.module`: a module mock
 * here is process-wide and its partial export set breaks every later file in
 * the DOM lane.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type {
	ModelCatalogResponse,
	ModelDialect,
	ModelOverrideSetRequest,
} from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../api";
import { ModelsTab } from "./ModelsTab";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: Array<() => void> = [];

interface Recorded {
	sets: ModelOverrideSetRequest[];
	deletes: Array<{ dialect: ModelDialect; modelId: string }>;
	reads: ModelDialect[];
}

const ANTHROPIC: ModelCatalogResponse = {
	baseline: { source: "upstream", fetchedAt: 1_700_000_000_000 },
	rows: [
		{
			id: "claude-opus-5",
			displayName: "Claude Opus 5",
			source: "upstream",
			hidden: false,
			overrideDisplayName: null,
		},
		{
			id: "claude-house",
			displayName: "House Special",
			source: "custom",
			hidden: false,
			overrideDisplayName: "House Special",
		},
	],
};

const OPENAI: ModelCatalogResponse = {
	baseline: { source: "codex-catalog", fetchedAt: 1_700_000_000_000 },
	rows: [
		{
			id: "gpt-5.6-sol",
			displayName: "GPT-5.6 Sol",
			source: "upstream",
			hidden: true,
			overrideDisplayName: null,
		},
	],
};

interface MountOptions {
	/** Reject the catalogue read instead of answering it. */
	readFails?: boolean;
	/** Reject the write instead of accepting it. */
	writeFails?: boolean;
	/** Never settle a write, leaving it in flight for the whole test. */
	writesHang?: boolean;
}

async function mount(options: MountOptions = {}): Promise<Recorded> {
	const recorded: Recorded = { sets: [], deletes: [], reads: [] };

	const readSpy = spyOn(api, "getModelCatalog").mockImplementation(
		async (dialect: ModelDialect) => {
			recorded.reads.push(dialect);
			if (options.readFails) throw new Error("Unauthorized");
			return dialect === "anthropic" ? ANTHROPIC : OPENAI;
		},
	);
	const setSpy = spyOn(api, "setModelOverride").mockImplementation(
		async (payload: ModelOverrideSetRequest) => {
			recorded.sets.push(payload);
			if (options.writesHang) await new Promise<void>(() => {});
			if (options.writeFails) throw new Error("nope");
		},
	);
	const deleteSpy = spyOn(api, "deleteModelOverride").mockImplementation(
		async (dialect: ModelDialect, modelId: string) => {
			recorded.deletes.push({ dialect, modelId });
		},
	);
	restores.push(
		() => readSpy.mockRestore(),
		() => setSpy.mockRestore(),
		() => deleteSpy.mockRestore(),
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
				<ModelsTab />
			</QueryClientProvider>,
		);
	});
	await settle();
	return recorded;
}

/** Let queries, mutations and their invalidations finish. */
async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function text(): string {
	return host?.textContent ?? "";
}

function nameField(modelId: string): HTMLInputElement {
	const field = host?.querySelector<HTMLInputElement>(
		`input[aria-label="Display name for ${modelId}"]`,
	);
	if (!field) throw new Error(`No display-name field for ${modelId}`);
	return field;
}

function button(label: string): HTMLElement {
	const found = host?.querySelector<HTMLElement>(`[aria-label="${label}"]`);
	if (!found) throw new Error(`No control labelled ${label}`);
	return found;
}

/** Type into a controlled input the way React expects. */
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
		// mousedown as well as click: Radix's tab trigger activates on mousedown,
		// and a click-only synthetic event would leave the tab unselected.
		element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await settle();
}

/** Commit a field the way leaving it does. React's onBlur listens to focusout. */
async function blur(field: HTMLInputElement): Promise<void> {
	await act(async () => {
		field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
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
	for (const restore of restores.splice(0)) restore();
});

describe("ModelsTab: reading", () => {
	it("shows the selected dialect's catalogue and its provenance", async () => {
		const recorded = await mount();

		expect(recorded.reads).toContain("anthropic");
		expect(text()).toContain("claude-opus-5");
		expect(text()).toContain("Live Anthropic catalogue");
	});

	it("reports a failed read instead of an empty list", async () => {
		await mount({ readFails: true });

		expect(text()).toContain("Could not load the model catalogue");
		expect(text()).toContain("Unauthorized");
	});

	// The two mounts are separate catalogues; switching tabs has to read the
	// other one rather than re-showing the first.
	it("loads the other dialect when its tab is selected", async () => {
		const recorded = await mount();
		expect(text()).not.toContain("gpt-5.6-sol");

		const openaiTab = host?.querySelector<HTMLElement>(
			'[role="tab"][value="openai"], [role="tab"][data-state="inactive"]',
		);
		if (!openaiTab) throw new Error("No inactive dialect tab");
		await click(openaiTab);

		expect(recorded.reads).toContain("openai");
		expect(text()).toContain("gpt-5.6-sol");
		expect(text()).toContain("Static list plus the Codex catalogue");
	});
});

describe("ModelsTab: renaming", () => {
	// One write per commit, not per keystroke: a per-keystroke write would serve
	// every intermediate name to real clients.
	it("writes exactly one override when the field is committed on blur", async () => {
		const recorded = await mount();

		const field = nameField("claude-opus-5");
		await type(field, "House Opus");
		expect(recorded.sets).toHaveLength(0);

		await blur(field);

		expect(recorded.sets).toEqual([
			{
				dialect: "anthropic",
				modelId: "claude-opus-5",
				hidden: false,
				custom: false,
				displayName: "House Opus",
			},
		]);
	});

	it("commits on Enter too, and only once", async () => {
		const recorded = await mount();

		const field = nameField("claude-opus-5");
		await type(field, "House Opus");
		await act(async () => {
			field.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		await settle();

		expect(recorded.sets).toHaveLength(1);
		expect(recorded.sets[0].displayName).toBe("House Opus");
	});

	// An emptied field means "use whatever upstream calls it", which is a cleared
	// override rather than a rename to the empty string.
	it("clears the override when the field is emptied", async () => {
		const recorded = await mount();

		const field = nameField("claude-house");
		await type(field, "  ");
		await blur(field);

		expect(recorded.sets[0].displayName).toBeNull();
	});

	it("writes nothing when the committed name is unchanged", async () => {
		const recorded = await mount();

		const field = nameField("claude-opus-5");
		await blur(field);

		expect(recorded.sets).toEqual([]);
	});

	// The refetch after a failed write reports the OLD name. Resetting the field
	// to it would throw away what the operator typed, at the exact moment they
	// need it to retry.
	it("keeps the draft when the write fails", async () => {
		await mount({ writeFails: true });

		const field = nameField("claude-opus-5");
		await type(field, "House Opus");
		await blur(field);

		expect(nameField("claude-opus-5").value).toBe("House Opus");
	});
});

describe("ModelsTab: hiding and adding", () => {
	// The write replaces the whole row, so the stored name has to travel with the
	// hide or the rename would be discarded by it.
	it("hides a baseline entry, carrying its stored name along", async () => {
		const recorded = await mount();

		await click(button("Show claude-opus-5 on /wire/anthropic"));

		expect(recorded.sets).toEqual([
			{
				dialect: "anthropic",
				modelId: "claude-opus-5",
				hidden: true,
				custom: false,
				displayName: null,
			},
		]);
	});

	it("un-hides an entry the wire is currently dropping", async () => {
		const recorded = await mount();
		const openaiTab = host?.querySelector<HTMLElement>(
			'[role="tab"][data-state="inactive"]',
		);
		if (!openaiTab) throw new Error("No inactive dialect tab");
		await click(openaiTab);

		await click(button("Show gpt-5.6-sol on /wire/openai"));

		expect(recorded.sets).toEqual([
			{
				dialect: "openai",
				modelId: "gpt-5.6-sol",
				hidden: false,
				custom: false,
				displayName: null,
			},
		]);
	});

	it("adds a custom model and clears the form", async () => {
		const recorded = await mount();

		const idField = host?.querySelector<HTMLInputElement>(
			"#add-model-id-anthropic",
		);
		const nameFieldEl = host?.querySelector<HTMLInputElement>(
			"#add-model-name-anthropic",
		);
		if (!idField || !nameFieldEl) throw new Error("No add-model form");

		await type(idField, "claude-experimental");
		await type(nameFieldEl, "Experimental");
		const addButton = Array.from(
			host?.querySelectorAll<HTMLElement>("button") ?? [],
		).find((element) => element.textContent?.includes("Add custom model"));
		if (!addButton) throw new Error("No add button");
		await click(addButton);

		expect(recorded.sets).toEqual([
			{
				dialect: "anthropic",
				modelId: "claude-experimental",
				hidden: false,
				custom: true,
				displayName: "Experimental",
			},
		]);
		expect(idField.value).toBe("");
		expect(nameFieldEl.value).toBe("");
	});

	// The add is a write like any other, and a write can fail. Clearing the fields
	// at submit would throw away an id the server just rejected as too long, at
	// the one moment the operator needs it back.
	it("keeps both drafts when the add fails", async () => {
		const recorded = await mount({ writeFails: true });

		const idField = host?.querySelector<HTMLInputElement>(
			"#add-model-id-anthropic",
		);
		const nameFieldEl = host?.querySelector<HTMLInputElement>(
			"#add-model-name-anthropic",
		);
		if (!idField || !nameFieldEl) throw new Error("No add-model form");

		await type(idField, "claude-experimental");
		await type(nameFieldEl, "Experimental");
		const addButton = Array.from(
			host?.querySelectorAll<HTMLElement>("button") ?? [],
		).find((element) => element.textContent?.includes("Add custom model"));
		if (!addButton) throw new Error("No add button");
		await click(addButton);

		expect(recorded.sets).toHaveLength(1);
		expect(idField.value).toBe("claude-experimental");
		expect(nameFieldEl.value).toBe("Experimental");
	});

	// Claude Code's picker filters the listing down to ids naming the Claude
	// family, so an id it would drop is worth flagging before the operator waits
	// for it to appear.
	it("warns about an id Claude Code's discovery would drop", async () => {
		await mount();

		const idField = host?.querySelector<HTMLInputElement>(
			"#add-model-id-anthropic",
		);
		if (!idField) throw new Error("No add-model form");

		await type(idField, "gpt-5.6-sol");
		expect(text()).toContain("Claude Code only keeps ids naming the Claude");

		await type(idField, "claude-experimental");
		expect(text()).not.toContain(
			"Claude Code only keeps ids naming the Claude",
		);
	});

	// Overlapping writes are one gesture apart: start a rename, then touch another
	// row while the first is still in flight. Tracking a single pending row would
	// re-enable the first one here, and the two full-replacement writes would then
	// race with the loser's change silently discarded.
	it("keeps a busy row inert while a second row is edited", async () => {
		const recorded = await mount({ writesHang: true });

		const first = nameField("claude-opus-5");
		await type(first, "House Opus");
		await blur(first);
		expect(nameField("claude-opus-5").disabled).toBe(true);

		const second = nameField("claude-house");
		await type(second, "Renamed");
		await blur(second);

		expect(recorded.sets).toHaveLength(2);
		expect(nameField("claude-opus-5").disabled).toBe(true);
		expect(
			button("Show claude-opus-5 on /wire/anthropic").hasAttribute("disabled"),
		).toBe(true);
		expect(nameField("claude-house").disabled).toBe(true);
	});

	it("deletes a custom entry", async () => {
		const recorded = await mount();

		await click(button("Remove claude-house"));

		expect(recorded.deletes).toEqual([
			{ dialect: "anthropic", modelId: "claude-house" },
		]);
		expect(recorded.sets).toEqual([]);
	});
});
