/**
 * The management endpoints behind the dashboard's Models page.
 *
 * Two contracts are worth pinning down here. The write is a FULL REPLACEMENT —
 * the page holds the whole row state it renders, so a partial body would let
 * two edits from the same page combine into a state neither asked for. And a
 * row that describes no difference from upstream is DELETED rather than stored,
 * so the table cannot fill with rows that mean "unchanged".
 */

import { describe, expect, test } from "bun:test";
import type { ModelCatalogResponse, ModelDialect } from "@clankermux/types";
import { createModelOverrideHandlers } from "../model-overrides";

interface Recorded {
	set: Array<{
		dialect: ModelDialect;
		modelId: string;
		hidden: boolean;
		custom: boolean;
		displayName: string | null;
	}>;
	removed: Array<{ dialect: ModelDialect; modelId: string }>;
	read: ModelDialect[];
}

function harness(
	catalog: ModelCatalogResponse = {
		baseline: { source: "upstream", fetchedAt: 42 },
		rows: [],
	},
) {
	const recorded: Recorded = { set: [], removed: [], read: [] };
	const handlers = createModelOverrideHandlers({
		getCatalog: async (dialect) => {
			recorded.read.push(dialect);
			return catalog;
		},
		setOverride: async (input) => {
			recorded.set.push(input);
		},
		removeOverride: async (dialect, modelId) => {
			recorded.removed.push({ dialect, modelId });
			return true;
		},
	});
	return { handlers, recorded };
}

function postBody(body: unknown): Request {
	return new Request("http://localhost/api/models/overrides", {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
		headers: { "Content-Type": "application/json" },
	});
}

const VALID = {
	dialect: "openai",
	modelId: "gpt-5.5",
	hidden: true,
	custom: false,
	displayName: null,
};

describe("GET /api/models/catalog", () => {
	test("returns the editing view for the requested dialect", async () => {
		const { handlers, recorded } = harness({
			baseline: { source: "bundled", fetchedAt: null },
			rows: [
				{
					id: "claude-opus-5",
					displayName: "Big",
					source: "upstream",
					hidden: true,
					overrideDisplayName: "Big",
				},
			],
		});

		const resp = await handlers.getCatalog(
			new URL("http://localhost/api/models/catalog?dialect=anthropic"),
		);
		const body = (await resp.json()) as ModelCatalogResponse;

		expect(resp.status).toBe(200);
		expect(recorded.read).toEqual(["anthropic"]);
		expect(body.baseline).toEqual({ source: "bundled", fetchedAt: null });
		expect(body.rows[0].hidden).toBe(true);
	});

	test("400s an unknown or missing dialect", async () => {
		const { handlers, recorded } = harness();

		for (const query of ["", "?dialect=", "?dialect=gemini"]) {
			const resp = await handlers.getCatalog(
				new URL(`http://localhost/api/models/catalog${query}`),
			);
			expect(resp.status).toBe(400);
		}
		expect(recorded.read).toEqual([]);
	});
});

describe("POST /api/models/overrides", () => {
	test("writes a complete row", async () => {
		const { handlers, recorded } = harness();

		const resp = await handlers.setOverride(postBody(VALID));

		expect(resp.status).toBe(204);
		expect(recorded.set).toEqual([
			{
				dialect: "openai",
				modelId: "gpt-5.5",
				hidden: true,
				custom: false,
				displayName: null,
			},
		]);
	});

	test("trims the id and the display name", async () => {
		const { handlers, recorded } = harness();

		await handlers.setOverride(
			postBody({
				...VALID,
				hidden: false,
				modelId: "  gpt-5.5  ",
				displayName: "  House Model  ",
			}),
		);

		expect(recorded.set[0].modelId).toBe("gpt-5.5");
		expect(recorded.set[0].displayName).toBe("House Model");
	});

	// A blank name is not a name: normalised to null so the row can then be
	// recognised as describing no difference at all.
	test("normalises a blank display name to null", async () => {
		const { handlers, recorded } = harness();

		await handlers.setOverride(postBody({ ...VALID, displayName: "   " }));

		expect(recorded.set[0].displayName).toBeNull();
	});

	test("rejects a body that is not a JSON object", async () => {
		const { handlers, recorded } = harness();

		for (const body of ["not json", JSON.stringify([VALID]), '"a string"']) {
			const resp = await handlers.setOverride(postBody(body));
			expect(resp.status).toBe(400);
		}
		expect(recorded.set).toEqual([]);
	});

	test("rejects missing or mistyped fields", async () => {
		const { handlers, recorded } = harness();

		const bad: unknown[] = [
			{ ...VALID, dialect: "gemini" },
			{ ...VALID, dialect: undefined },
			{ ...VALID, modelId: "" },
			{ ...VALID, modelId: "   " },
			{ ...VALID, modelId: 7 },
			{ ...VALID, modelId: undefined },
			{ ...VALID, modelId: "x".repeat(201) },
			{ ...VALID, hidden: "yes" },
			{ ...VALID, hidden: undefined },
			{ ...VALID, custom: 1 },
			{ ...VALID, custom: undefined },
			{ ...VALID, displayName: 7 },
			{ ...VALID, hidden: false, displayName: "y".repeat(201) },
		];

		for (const body of bad) {
			const resp = await handlers.setOverride(postBody(body));
			expect(resp.status).toBe(400);
		}
		expect(recorded.set).toEqual([]);
	});

	// The storage layer refuses this pairing too; catching it here makes the
	// refusal a 400 with a reason rather than a constraint violation.
	test("rejects a row that is both hidden and custom", async () => {
		const { handlers, recorded } = harness();

		const resp = await handlers.setOverride(
			postBody({ ...VALID, hidden: true, custom: true }),
		);

		expect(resp.status).toBe(400);
		expect(recorded.set).toEqual([]);
	});
});

describe("DELETE /api/models/overrides", () => {
	test("removes the addressed row", async () => {
		const { handlers, recorded } = harness();

		const resp = await handlers.removeOverride(
			new URL(
				"http://localhost/api/models/overrides?dialect=openai&modelId=gpt-5.5",
			),
		);

		expect(resp.status).toBe(204);
		expect(recorded.removed).toEqual([
			{ dialect: "openai", modelId: "gpt-5.5" },
		]);
	});

	// The caller asked for the row to be gone, and it is. A 404 would make a
	// double-click an error.
	test("answers 204 even when nothing was stored", async () => {
		const recorded: Recorded = { set: [], removed: [], read: [] };
		const handlers = createModelOverrideHandlers({
			getCatalog: async () => ({
				baseline: { source: "static", fetchedAt: null },
				rows: [],
			}),
			setOverride: async () => {},
			removeOverride: async (dialect, modelId) => {
				recorded.removed.push({ dialect, modelId });
				return false;
			},
		});

		const resp = await handlers.removeOverride(
			new URL(
				"http://localhost/api/models/overrides?dialect=openai&modelId=nothing",
			),
		);

		expect(resp.status).toBe(204);
		expect(recorded.removed).toHaveLength(1);
	});

	test("400s a missing dialect or model id", async () => {
		const { handlers, recorded } = harness();

		for (const query of [
			"?modelId=gpt-5.5",
			"?dialect=gemini&modelId=gpt-5.5",
			"?dialect=openai",
			"?dialect=openai&modelId=%20%20",
		]) {
			const resp = await handlers.removeOverride(
				new URL(`http://localhost/api/models/overrides${query}`),
			);
			expect(resp.status).toBe(400);
		}
		expect(recorded.removed).toEqual([]);
	});
});
