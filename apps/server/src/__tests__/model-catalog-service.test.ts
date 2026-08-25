/**
 * The shared catalogue service: the single source both `/v1/models` and the
 * dashboard's Models page read.
 *
 * Two behaviours are specific to this layer. The editing view SHOWS hidden
 * entries (the wire drops them) — an operator cannot un-hide a row the page
 * does not render. And a write that describes no difference from upstream
 * deletes the row instead of storing it, so the table cannot accumulate rows
 * that mean "unchanged".
 */

import { describe, expect, test } from "bun:test";
import type { ModelOverrideRow } from "@clankermux/database";
import type { AnthropicModelCatalogSnapshot } from "@clankermux/proxy";
import { ModelCatalogService } from "../model-catalog-service";

const CATALOG_BODY = JSON.stringify({
	models: [
		{ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
		{ slug: "gpt-only-upstream", display_name: "Fresh Model" },
	],
});

function row(over: Partial<ModelOverrideRow> = {}): ModelOverrideRow {
	return {
		dialect: "anthropic",
		model_id: "claude-opus-5",
		hidden: 0,
		custom: 0,
		display_name: null,
		created_at: 1_000,
		updated_at: 1_000,
		...over,
	};
}

function snapshot(
	over: Partial<AnthropicModelCatalogSnapshot> = {},
): AnthropicModelCatalogSnapshot {
	return {
		models: [
			{
				id: "claude-opus-5",
				displayName: "Claude Opus 5",
				createdAt: "2026-01-01T00:00:00Z",
			},
			{
				id: "claude-sonnet-5",
				displayName: "Claude Sonnet 5",
				createdAt: "2026-02-01T00:00:00Z",
			},
		],
		source: "upstream",
		fetchedAt: 5_000,
		...over,
	};
}

interface HarnessOptions {
	rows?: ModelOverrideRow[];
	anthropic?: AnthropicModelCatalogSnapshot;
	codexBody?: string | null;
	codexFetchedAt?: number | null;
	now?: number;
}

function harness(options: HarnessOptions = {}) {
	const upserts: unknown[] = [];
	const removals: Array<{ dialect: string; modelId: string }> = [];
	const service = new ModelCatalogService({
		anthropicCatalog: { get: async () => options.anthropic ?? snapshot() },
		codexCatalog: {
			get: async () =>
				options.codexBody === undefined
					? { bodyText: CATALOG_BODY, etag: null }
					: options.codexBody === null
						? null
						: { bodyText: options.codexBody, etag: null },
			getFetchedAt: () => options.codexFetchedAt ?? 7_000,
		},
		staticModelIds: ["gpt-5.6-sol", "gpt-5.5"],
		listOverrides: async (dialect) =>
			(options.rows ?? []).filter((r) => r.dialect === dialect),
		upsertOverride: async (input) => {
			upserts.push(input);
		},
		removeOverride: async (dialect, modelId) => {
			removals.push({ dialect, modelId });
			return true;
		},
		now: () => options.now ?? 9_000,
	});
	return { service, upserts, removals };
}

describe("ModelCatalogService: the editing view", () => {
	test("reports the anthropic baseline with its provenance", async () => {
		const { service } = harness();

		const view = await service.getCatalogView("anthropic");

		expect(view.baseline).toEqual({ source: "upstream", fetchedAt: 5_000 });
		expect(view.rows).toEqual([
			{
				id: "claude-opus-5",
				displayName: "Claude Opus 5",
				source: "upstream",
				hidden: false,
				overrideDisplayName: null,
			},
			{
				id: "claude-sonnet-5",
				displayName: "Claude Sonnet 5",
				source: "upstream",
				hidden: false,
				overrideDisplayName: null,
			},
		]);
	});

	test("says when the anthropic baseline is the bundled fallback", async () => {
		const { service } = harness({
			anthropic: snapshot({ source: "bundled", fetchedAt: null }),
		});

		expect((await service.getCatalogView("anthropic")).baseline).toEqual({
			source: "bundled",
			fetchedAt: null,
		});
	});

	// The wire drops hidden entries; the page must not, or the operator has no
	// way back.
	test("keeps hidden rows visible, flagged", async () => {
		const { service } = harness({
			rows: [row({ model_id: "claude-sonnet-5", hidden: 1 })],
		});

		const view = await service.getCatalogView("anthropic");

		expect(view.rows.map((r) => [r.id, r.hidden])).toEqual([
			["claude-opus-5", false],
			["claude-sonnet-5", true],
		]);
	});

	test("shows the stored name of a hidden row so it survives un-hiding", async () => {
		const { service } = harness({
			rows: [
				row({ model_id: "claude-sonnet-5", hidden: 1, display_name: "Kept" }),
			],
		});

		const view = await service.getCatalogView("anthropic");

		expect(view.rows[1].overrideDisplayName).toBe("Kept");
		expect(view.rows[1].displayName).toBe("Kept");
	});

	test("appends custom rows, oldest first, marked as such", async () => {
		const { service } = harness({
			rows: [
				row({
					model_id: "claude-late",
					custom: 1,
					display_name: "Late",
					created_at: 2_000,
				}),
				row({ model_id: "claude-early", custom: 1, created_at: 1_000 }),
			],
		});

		const view = await service.getCatalogView("anthropic");

		expect(view.rows.slice(2)).toEqual([
			{
				id: "claude-early",
				displayName: "claude-early",
				source: "custom",
				hidden: false,
				overrideDisplayName: null,
			},
			{
				id: "claude-late",
				displayName: "Late",
				source: "custom",
				hidden: false,
				overrideDisplayName: "Late",
			},
		]);
	});

	test("reads only the requested dialect's rows", async () => {
		const { service } = harness({
			rows: [
				row({ dialect: "openai", model_id: "gpt-5.5", hidden: 1 }),
				row({ dialect: "anthropic", model_id: "claude-opus-5", hidden: 1 }),
			],
		});

		const anthropic = await service.getCatalogView("anthropic");
		expect(anthropic.rows.find((r) => r.id === "claude-opus-5")?.hidden).toBe(
			true,
		);
	});
});

describe("ModelCatalogService: the openai baseline", () => {
	// Two clients read two different lists from this mount. Curating either one
	// should not require knowing which client reads which, so the baseline is
	// their union.
	test("unions the static list with the Codex catalogue", async () => {
		const { service } = harness();

		const view = await service.getCatalogView("openai");

		expect(view.baseline).toEqual({
			source: "codex-catalog",
			fetchedAt: 7_000,
		});
		expect(view.rows.map((r) => r.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.5",
			"gpt-only-upstream",
		]);
		// The catalogue's own name beats the bare slug the static list carries.
		expect(view.rows[0].displayName).toBe("GPT-5.6 Sol");
	});

	test("falls back to the static list when no catalogue can be read", async () => {
		const { service } = harness({ codexBody: null });

		const view = await service.getCatalogView("openai");

		expect(view.baseline).toEqual({ source: "static", fetchedAt: null });
		expect(view.rows.map((r) => r.id)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
	});

	test("falls back to the static list when the catalogue is unparseable", async () => {
		const { service } = harness({ codexBody: "not json" });

		expect((await service.getCatalogView("openai")).baseline.source).toBe(
			"static",
		);
	});
});

describe("ModelCatalogService: writes", () => {
	test("stores a row that describes a difference", async () => {
		const { service, upserts, removals } = harness();

		await service.setOverride({
			dialect: "openai",
			modelId: "gpt-5.5",
			hidden: true,
			custom: false,
			displayName: null,
		});

		expect(upserts).toEqual([
			{
				dialect: "openai",
				modelId: "gpt-5.5",
				hidden: true,
				custom: false,
				displayName: null,
				now: 9_000,
			},
		]);
		expect(removals).toEqual([]);
	});

	// A row that hides nothing, adds nothing and renames nothing is
	// indistinguishable from no row at all, and keeping it would mean a write on
	// every render of an untouched entry.
	test("deletes the row when the edit reverts it to no-op", async () => {
		const { service, upserts, removals } = harness();

		await service.setOverride({
			dialect: "anthropic",
			modelId: "claude-opus-5",
			hidden: false,
			custom: false,
			displayName: null,
		});

		expect(upserts).toEqual([]);
		expect(removals).toEqual([
			{ dialect: "anthropic", modelId: "claude-opus-5" },
		]);
	});

	test("keeps a renamed row even when nothing else is set", async () => {
		const { service, upserts } = harness();

		await service.setOverride({
			dialect: "anthropic",
			modelId: "claude-opus-5",
			hidden: false,
			custom: false,
			displayName: "House Model",
		});

		expect(upserts).toHaveLength(1);
	});

	test("passes a deletion straight through", async () => {
		const { service, removals } = harness();

		expect(await service.removeOverride("openai", "gpt-5.5")).toBe(true);
		expect(removals).toEqual([{ dialect: "openai", modelId: "gpt-5.5" }]);
	});
});
