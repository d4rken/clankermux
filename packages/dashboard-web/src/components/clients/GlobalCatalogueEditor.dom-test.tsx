import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import type {
	ClientApplication,
	ClientView,
	GlobalCatalogueReview,
	GlobalCatalogueView,
} from "@clankermux/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GlobalCatalogueEditor } from "./GlobalCatalogueEditor";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let posted: { path: string; body: unknown }[] = [];
let applied: ClientView[] | null = null;

const entry = (
	id: string,
	targetModel = id,
	accountIds: string[] | null = null,
) => ({
	id,
	displayName: id,
	targetModel,
	accountIds,
});
const client = (id: string, application: ClientApplication): ClientView => ({
	apiKeyId: id,
	application,
	revision: 1,
	notices: [],
	aliasRules: [],
	global: null,
	key: {
		id,
		name: `Client ${id}`,
		application: null,
		prefixLast8: "abcdefgh",
		createdAt: "2026-01-01",
		lastUsed: null,
		usageCount: 0,
		isActive: true,
		pinnedAccountId: null,
		pinnedProviders: null,
	},
	catalogues: {
		anthropic: { models: [], defaultModel: null },
		openai: { models: [entry("from-alpha")], defaultModel: "from-alpha" },
		codex: { models: [], defaultModel: null },
	},
});
const alpha = client("alpha", "pi");
const bravo = client("bravo", "claude-code");
const view: GlobalCatalogueView = {
	revision: 2,
	subscribers: ["alpha"],
	catalogues: {
		anthropic: {
			models: [entry("claude-x", "x", ["a"])],
			defaultModel: null,
		},
		openai: { models: [entry("g1")], defaultModel: "g1" },
		codex: { models: [], defaultModel: null },
	},
};
const review: GlobalCatalogueReview = {
	token: "global-token",
	draft: { ...view, subscribers: ["alpha", "bravo"] },
	clients: [
		{
			apiKeyId: "alpha",
			name: "Client alpha",
			status: "changed",
			reason: null,
			subscription: "stays",
			formats: {
				openai: {
					added: ["gpt-new"],
					removed: [],
					modified: [],
					defaultModelChange: null,
					skipped: [],
				},
			},
			notices: [],
		},
		{
			apiKeyId: "bravo",
			name: "Client bravo",
			status: "changed",
			reason: null,
			subscription: "joins",
			formats: {
				anthropic: {
					added: [],
					removed: [],
					modified: [],
					defaultModelChange: null,
					skipped: [{ id: "gpt-raw", reason: "Claude Code requires an alias" }],
				},
			},
			notices: [],
		},
	],
};

async function mount() {
	posted = [];
	applied = null;
	spyOn(globalThis, "fetch").mockImplementation(
		mockFetch(async (input, init) => {
			const path = String(input);
			if (path.endsWith("/global-catalogue"))
				return Response.json({ data: structuredClone(view) });
			if (path.endsWith("/suggestions"))
				return Response.json({
					data: {
						models: [
							{
								id: "gpt-new",
								displayName: "GPT New",
								accountIds: ["a"],
								codexMetadataAvailable: false,
							},
						],
						accounts: [],
					},
				});
			const body = JSON.parse(String(init?.body));
			posted.push({ path, body });
			if (path.endsWith("/global-catalogue/review"))
				return Response.json({ data: review });
			if (path.endsWith("/global-catalogue/commit"))
				return Response.json({ data: { global: view, clients: [alpha] } });
			throw new Error(`Unexpected request ${path}`);
		}),
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<GlobalCatalogueEditor
				clients={[alpha, bravo]}
				accounts={[{ id: "a", name: "Account", provider: "codex" }]}
				onCancel={() => {}}
				onApplied={(clients) => {
					applied = clients;
				}}
			/>,
		);
	});
}
async function click(text: string) {
	const button = [...document.querySelectorAll("button")].find(
		(b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === text,
	);
	if (!button) throw new Error(`Missing ${text}`);
	await act(async () => button.click());
}
async function tab(label: string) {
	const trigger = [
		...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
	].find((t) => t.textContent?.startsWith(label));
	if (!trigger) throw new Error(`Missing ${label} tab`);
	await act(async () => {
		trigger.dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, button: 0 }),
		);
		trigger.click();
	});
}
async function toggle(label: string) {
	const box = document.querySelector<HTMLInputElement>(
		`input[aria-label="${label}"]`,
	);
	if (!box) throw new Error(`Missing ${label}`);
	await act(async () => box.click());
}
const listed = (pane: string) =>
	[
		...document.querySelectorAll(
			`[aria-label="${pane} models"] [data-model-id]`,
		),
	].map((row) => row.getAttribute("data-model-id"));

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	mock.restore();
});

describe("global catalogue editor", () => {
	it("offers other models to the Anthropic catalogue under a claude- alias", async () => {
		await mount();
		expect(listed("Selected")).toEqual(["claude-x"]);
		expect(listed("Available")).toEqual(["claude-gpt-new"]);
	});

	it("reviews the edited catalogue and subscriber list, then saves the reviewed token", async () => {
		await mount();
		await tab("OpenAI");
		await click("Add gpt-new");
		await toggle("Use the global catalogue for Client bravo (Claude Code)");
		await click("Review changes");
		expect(posted).toEqual([
			{
				path: "/api/clients/global-catalogue/review",
				body: {
					revision: 2,
					subscribers: ["alpha", "bravo"],
					catalogues: {
						...view.catalogues,
						openai: {
							models: [
								entry("g1"),
								{ ...entry("gpt-new"), displayName: "GPT New" },
							],
							defaultModel: "g1",
						},
					},
				},
			},
		]);
		expect(posted[0]?.body).not.toHaveProperty("droppedAliasRoutes");
		const text = document.body.textContent ?? "";
		expect(text).toContain("Adds gpt-new");
		expect(text).toContain("Starts using the global catalogue");
		expect(text).toContain("Skips gpt-raw: Claude Code requires an alias");
		await click("Save global catalogue");
		expect(posted[1]).toEqual({
			path: "/api/clients/global-catalogue/commit",
			body: { token: "global-token" },
		});
		expect(applied).toEqual([alpha]);
	});

	it("copies one format from a client", async () => {
		await mount();
		await tab("OpenAI");
		const select = document.querySelector<HTMLSelectElement>(
			'select[aria-label="Copy from client"]',
		);
		if (!select) throw new Error("Missing copy select");
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLSelectElement.prototype,
				"value",
			)?.set?.call(select, "alpha");
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await click("Copy into OpenAI");
		expect(listed("Selected")).toEqual(["from-alpha"]);
	});

	it("drops a removed alias's routes from subscribers only when asked", async () => {
		await mount();
		await click("Remove claude-x");
		const box = [...document.querySelectorAll("label")]
			.find((l) => l.textContent?.includes("Remove the claude-x route"))
			?.querySelector<HTMLInputElement>("input");
		if (!box) throw new Error("Missing route checkbox");
		await act(async () => box.click());
		await click("Review changes");
		expect(posted[0]?.body).toEqual(
			expect.objectContaining({ droppedAliasRoutes: ["claude-x"] }),
		);
	});
});
