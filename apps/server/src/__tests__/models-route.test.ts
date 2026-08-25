/**
 * `GET /v1/models` across both mounts, with and without operator curation.
 *
 * The three reply shapes are not interchangeable and each has a client that
 * silently ignores the other two: Claude Code reads Anthropic's `data[]`
 * listing, Codex reads the `{"models":[…]}` catalog, and generic OpenAI clients
 * read `{"object":"list"}`. "Silently" is why every path here is asserted on the
 * body rather than on the status — a wrong shape is a 200 nobody can use.
 *
 * The second theme is that curation must never cost availability: an
 * unreadable, slow or unparseable input degrades to the uncurated answer, and
 * the route still returns 200.
 */

import { describe, expect, test } from "bun:test";
import type { AnthropicModelCatalogSnapshot } from "@clankermux/proxy";
import type { ModelOverride } from "../model-overrides";
import { handleModelsRoute, type ModelsRouteDeps } from "../models-route";

const CATALOG_BODY = JSON.stringify({
	models: [
		{
			slug: "gpt-5.6-sol",
			display_name: "GPT-5.6 Sol",
			context_window: 272000,
			base_instructions: "sol instructions",
		},
		{
			slug: "gpt-5.5",
			display_name: "GPT-5.5",
			context_window: 272000,
			base_instructions: "5.5 instructions",
		},
	],
});

const STATIC_IDS = ["gpt-5.6-sol", "gpt-5.5"] as const;

function staticModels(ids: readonly string[]): Response {
	return new Response(
		JSON.stringify({
			object: "list",
			data: ids.map((id) => ({ id, object: "model" })),
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
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
		fetchedAt: 1_000,
		...over,
	};
}

function override(over: Partial<ModelOverride> = {}): ModelOverride {
	return {
		modelId: "x",
		hidden: false,
		custom: false,
		displayName: null,
		createdAt: 1_000,
		...over,
	};
}

interface HarnessOptions {
	catalog?: (apiKeyId: string | null) => Promise<{
		bodyText: string;
		etag: string | null;
	} | null>;
	anthropic?: () => Promise<AnthropicModelCatalogSnapshot>;
	overrides?: readonly ModelOverride[];
	listOverrides?: (
		dialect: "anthropic" | "openai",
	) => Promise<readonly ModelOverride[]>;
}

function harness(options: HarnessOptions = {}) {
	const keys: Array<string | null> = [];
	const dialects: string[] = [];
	const deps: ModelsRouteDeps = {
		getCatalog: (apiKeyId) => {
			keys.push(apiKeyId);
			return (
				options.catalog?.(apiKeyId) ??
				Promise.resolve({ bodyText: CATALOG_BODY, etag: null })
			);
		},
		staticModels,
		staticModelIds: STATIC_IDS,
		getAnthropicCatalog: options.anthropic ?? (async () => snapshot()),
		listOverrides: async (dialect) => {
			dialects.push(dialect);
			if (options.listOverrides) return options.listOverrides(dialect);
			return options.overrides ?? [];
		},
	};
	return { deps, keys, dialects };
}

interface AnthropicBody {
	data: Array<{
		type: string;
		id: string;
		display_name: string;
		created_at: string;
	}>;
	has_more: boolean;
	first_id: string | null;
	last_id: string | null;
}

async function anthropicBody(
	options: HarnessOptions = {},
	url = "http://proxy.local/v1/models",
): Promise<AnthropicBody> {
	const { deps } = harness(options);
	const resp = await handleModelsRoute(new URL(url), deps, null, "anthropic");
	expect(resp.status).toBe(200);
	return (await resp.json()) as AnthropicBody;
}

describe("handleModelsRoute: the anthropic dialect", () => {
	// The shape Claude Code's gateway model discovery parses. A missing field or
	// a wrong envelope leaves it with an empty picker and no error.
	test("serves Anthropic's own listing shape", async () => {
		const body = await anthropicBody();

		expect(body.data).toEqual([
			{
				type: "model",
				id: "claude-opus-5",
				display_name: "Claude Opus 5",
				created_at: "2026-01-01T00:00:00Z",
			},
			{
				type: "model",
				id: "claude-sonnet-5",
				display_name: "Claude Sonnet 5",
				created_at: "2026-02-01T00:00:00Z",
			},
		]);
		expect(body.has_more).toBe(false);
		expect(body.first_id).toBe("claude-opus-5");
		expect(body.last_id).toBe("claude-sonnet-5");
	});

	test("reads the overrides for its own dialect only", async () => {
		const { deps, dialects } = harness();
		await handleModelsRoute(
			new URL("http://proxy.local/v1/models"),
			deps,
			null,
			"anthropic",
		);
		expect(dialects).toEqual(["anthropic"]);
	});

	test("serves the bundled list when upstream could not be read", async () => {
		const body = await anthropicBody({
			anthropic: async () =>
				snapshot({
					models: [
						{
							id: "claude-opus-5",
							displayName: "Claude Opus 5",
							createdAt: "2025-01-01T00:00:00Z",
						},
					],
					source: "bundled",
					fetchedAt: null,
				}),
		});

		expect(body.data.map((entry) => entry.id)).toEqual(["claude-opus-5"]);
	});

	test("drops hidden entries", async () => {
		const body = await anthropicBody({
			overrides: [override({ modelId: "claude-sonnet-5", hidden: true })],
		});

		expect(body.data.map((entry) => entry.id)).toEqual(["claude-opus-5"]);
		expect(body.last_id).toBe("claude-opus-5");
	});

	test("applies a display-name override to a baseline entry", async () => {
		const body = await anthropicBody({
			overrides: [
				override({ modelId: "claude-opus-5", displayName: "Big Model" }),
			],
		});

		expect(body.data[0].display_name).toBe("Big Model");
		expect(body.data[0].id).toBe("claude-opus-5");
	});

	test("appends custom entries oldest-first, in ISO time", async () => {
		const body = await anthropicBody({
			overrides: [
				override({
					modelId: "claude-second",
					custom: true,
					displayName: "Second",
					createdAt: Date.UTC(2026, 4, 2),
				}),
				override({
					modelId: "claude-first",
					custom: true,
					displayName: null,
					createdAt: Date.UTC(2026, 4, 1),
				}),
			],
		});

		expect(body.data.slice(2)).toEqual([
			{
				type: "model",
				id: "claude-first",
				// No name given: the id stands in rather than an empty label.
				display_name: "claude-first",
				created_at: "2026-05-01T00:00:00.000Z",
			},
			{
				type: "model",
				id: "claude-second",
				display_name: "Second",
				created_at: "2026-05-02T00:00:00.000Z",
			},
		]);
	});

	// A hide-everything state is legitimate (an operator narrowing the pool to
	// nothing while editing), and it has to produce a valid empty listing rather
	// than an entry-less object with dangling ids.
	test("answers an empty listing when every entry is hidden", async () => {
		const body = await anthropicBody({
			overrides: [
				override({ modelId: "claude-opus-5", hidden: true }),
				override({ modelId: "claude-sonnet-5", hidden: true }),
			],
		});

		expect(body.data).toEqual([]);
		expect(body.has_more).toBe(false);
		expect(body.first_id).toBeNull();
		expect(body.last_id).toBeNull();
	});

	// The values crossed a cache and a database boundary. One unusable entry must
	// not cost the whole list, which is what a client does with a body it cannot
	// deserialize.
	test("falls back field by field on malformed entries", async () => {
		const body = await anthropicBody({
			anthropic: async () =>
				snapshot({
					models: [
						{
							id: "claude-x",
							displayName: 42 as unknown as string,
							createdAt: null as unknown as string,
						},
					],
				}),
			overrides: [
				override({
					modelId: "claude-custom",
					custom: true,
					createdAt: Number.NaN,
				}),
			],
		});

		expect(body.data).toEqual([
			{
				type: "model",
				id: "claude-x",
				display_name: "claude-x",
				created_at: "2025-01-01T00:00:00Z",
			},
			{
				type: "model",
				id: "claude-custom",
				display_name: "claude-custom",
				created_at: "2025-01-01T00:00:00Z",
			},
		]);
	});

	test("deduplicates repeated ids, first occurrence winning", async () => {
		const body = await anthropicBody({
			anthropic: async () =>
				snapshot({
					models: [
						{
							id: "dup",
							displayName: "First",
							createdAt: "2026-01-01T00:00:00Z",
						},
						{
							id: "dup",
							displayName: "Second",
							createdAt: "2026-02-01T00:00:00Z",
						},
					],
				}),
		});

		expect(body.data).toHaveLength(1);
		expect(body.data[0].display_name).toBe("First");
	});

	// The listing is short; a client asking for fewer entries than exist would
	// then have no way to reach the rest, so the parameter is accepted and
	// ignored rather than honoured or rejected.
	test("accepts and ignores a limit parameter", async () => {
		const body = await anthropicBody(
			{},
			"http://proxy.local/v1/models?limit=1",
		);

		expect(body.data).toHaveLength(2);
	});

	test("still answers 200 when the catalogue lookup throws", async () => {
		const body = await anthropicBody({
			anthropic: async () => {
				throw new Error("unexpected");
			},
			overrides: [
				override({
					modelId: "claude-custom",
					custom: true,
					displayName: "Mine",
				}),
			],
		});

		expect(body.data.map((entry) => entry.id)).toEqual(["claude-custom"]);
	});
});

describe("handleModelsRoute: the openai list shape", () => {
	test("serves the static list when no client_version is present", async () => {
		const { deps, keys } = harness();

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models"),
			deps,
			null,
			"openai",
		);
		const body = (await resp.json()) as {
			object?: string;
			data: Array<{ id: string }>;
		};

		expect(resp.status).toBe(200);
		expect(body.object).toBe("list");
		expect(body.data.map((entry) => entry.id)).toEqual([...STATIC_IDS]);
		// The catalog is never even consulted for a non-Codex client.
		expect(keys).toHaveLength(0);
	});

	test("hides and appends against the static list", async () => {
		const { deps } = harness({
			overrides: [
				override({ modelId: "gpt-5.5", hidden: true }),
				override({ modelId: "gpt-custom", custom: true, displayName: "Mine" }),
			],
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models"),
			deps,
			null,
			"openai",
		);
		const body = (await resp.json()) as { data: Array<{ id: string }> };

		expect(body.data.map((entry) => entry.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-custom",
		]);
	});
});

describe("handleModelsRoute: the codex catalog", () => {
	test("serves the catalog verbatim, ETag included, when nothing is curated", async () => {
		const { deps } = harness({
			catalog: async () => ({ bodyText: CATALOG_BODY, etag: 'W/"abc"' }),
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);

		expect(resp.status).toBe(200);
		expect(resp.headers.get("Content-Type")).toBe("application/json");
		expect(resp.headers.get("ETag")).toBe('W/"abc"');
		expect(await resp.text()).toBe(CATALOG_BODY);
	});

	test("omits the ETag header when upstream sent none", async () => {
		const { deps } = harness();

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);
		expect(resp.headers.has("ETag")).toBe(false);
	});

	// Entitlement is per-subscription, so the catalog has to be chosen for the
	// key that asked, not for the pool at large.
	test("passes the API key id through to the catalog lookup", async () => {
		const { deps, keys } = harness();

		await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			"key-42",
			"openai",
		);
		await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);

		expect(keys).toEqual(["key-42", null]);
	});

	// The value is never read — only its presence. Forwarding it upstream would
	// ask OpenAI for a catalog at a version this proxy does not speak, and would
	// make a client-controlled string into a cache key.
	test("ignores the client_version value entirely", async () => {
		const { deps, keys } = harness();

		for (const value of [
			"0.149.0",
			"",
			"latest",
			"9".repeat(4096),
			"../../etc/passwd",
		]) {
			const resp = await handleModelsRoute(
				new URL(
					`http://proxy.local/v1/models?client_version=${encodeURIComponent(value)}`,
				),
				deps,
				"key-1",
				"openai",
			);
			expect(await resp.text()).toBe(CATALOG_BODY);
		}

		// Every one reached the same lookup, keyed only by the API key.
		expect(keys).toEqual(["key-1", "key-1", "key-1", "key-1", "key-1"]);
	});

	test("drops hidden entries and drops the upstream ETag with them", async () => {
		const { deps } = harness({
			catalog: async () => ({ bodyText: CATALOG_BODY, etag: 'W/"abc"' }),
			overrides: [override({ modelId: "gpt-5.5", hidden: true })],
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);
		const body = (await resp.json()) as {
			models: Array<{ slug: string }>;
		};

		expect(body.models.map((entry) => entry.slug)).toEqual(["gpt-5.6-sol"]);
		// The body is ours now; reusing upstream's validator would let a client
		// cache it under a tag that only changes when UPSTREAM does.
		expect(resp.headers.has("ETag")).toBe(false);
	});

	test("renames an entry without touching its other fields", async () => {
		const { deps } = harness({
			overrides: [
				override({ modelId: "gpt-5.6-sol", displayName: "House Model" }),
			],
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);
		const body = (await resp.json()) as {
			models: Array<Record<string, unknown>>;
		};

		expect(body.models[0]).toEqual({
			slug: "gpt-5.6-sol",
			display_name: "House Model",
			context_window: 272000,
			base_instructions: "sol instructions",
		});
	});

	// Codex requires ~18 fields per entry; a hand-built one would be missing the
	// semantic fields and the CLI would fall back to its built-in catalog without
	// saying so. Cloning an existing entry is what makes an added model usable.
	test("clones an existing entry for a custom model", async () => {
		const { deps } = harness({
			overrides: [
				override({
					modelId: "gpt-house",
					custom: true,
					displayName: "House Special",
				}),
			],
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);
		const body = (await resp.json()) as {
			models: Array<Record<string, unknown>>;
		};

		expect(body.models).toHaveLength(3);
		expect(body.models[2]).toEqual({
			slug: "gpt-house",
			display_name: "House Special",
			context_window: 272000,
			base_instructions: "sol instructions",
		});
	});

	// The template is picked before any hide is applied, so hiding an unrelated
	// model cannot change which entry a custom model inherits its semantics from.
	test("picks the clone template from the unfiltered catalog", async () => {
		const { deps } = harness({
			overrides: [
				override({ modelId: "gpt-5.6-sol", hidden: true }),
				override({ modelId: "gpt-house", custom: true }),
			],
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);
		const body = (await resp.json()) as {
			models: Array<Record<string, unknown>>;
		};

		expect(body.models.map((entry) => entry.slug)).toEqual([
			"gpt-5.5",
			"gpt-house",
		]);
		expect(body.models[1].base_instructions).toBe("sol instructions");
	});

	test("skips custom injection when the catalog has no entry to clone", async () => {
		const { deps } = harness({
			catalog: async () => ({
				bodyText: JSON.stringify({ models: [] }),
				etag: null,
			}),
			overrides: [override({ modelId: "gpt-house", custom: true })],
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);
		const body = (await resp.json()) as { models: unknown[] };

		expect(body.models).toEqual([]);
	});

	// A custom row colliding with a real slug is a rename of the entry that is
	// already there, never a second copy of it.
	test("treats a custom row colliding with a catalog slug as a rename", async () => {
		const { deps } = harness({
			overrides: [
				override({
					modelId: "gpt-5.5",
					custom: true,
					displayName: "Renamed 5.5",
				}),
			],
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);
		const body = (await resp.json()) as {
			models: Array<{ slug: string; display_name: string }>;
		};

		expect(body.models).toHaveLength(2);
		expect(body.models[1].display_name).toBe("Renamed 5.5");
	});

	test("serves the catalog unmodified when it cannot be parsed", async () => {
		const { deps } = harness({
			catalog: async () => ({ bodyText: "not json", etag: 'W/"abc"' }),
			overrides: [override({ modelId: "gpt-5.5", hidden: true })],
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);

		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe("not json");
	});

	// The whole point of the fallback: a Codex startup must never be blocked by
	// our inability to read a catalog. It gets a 200 it cannot use and falls back
	// to its built-in catalog, exactly as it did before this route existed.
	test("falls back to the OpenAI list shape with a 200 when no catalog is available", async () => {
		const { deps } = harness({ catalog: async () => null });

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);
		const body = (await resp.json()) as { object?: string };

		expect(resp.status).toBe(200);
		expect(body.object).toBe("list");
	});

	test("falls back rather than propagating a catalog lookup throw", async () => {
		const { deps } = harness({
			catalog: async () => {
				throw new Error("unexpected");
			},
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);
		expect(resp.status).toBe(200);
		expect(((await resp.json()) as { object?: string }).object).toBe("list");
	});
});

describe("handleModelsRoute: the override read never costs availability", () => {
	test("serves the uncurated catalog when the override read rejects", async () => {
		const { deps } = harness({
			catalog: async () => ({ bodyText: CATALOG_BODY, etag: 'W/"abc"' }),
			listOverrides: async () => {
				throw new Error("database is locked");
			},
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			deps,
			null,
			"openai",
		);

		expect(resp.status).toBe(200);
		// Byte-identical passthrough: a failed override read is indistinguishable
		// from having no overrides, which is the uncurated behaviour.
		expect(await resp.text()).toBe(CATALOG_BODY);
		expect(resp.headers.get("ETag")).toBe('W/"abc"');
	});

	test("serves the uncurated listing when the override read never settles", async () => {
		const { deps } = harness({
			listOverrides: () => new Promise<readonly ModelOverride[]>(() => {}),
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models"),
			deps,
			null,
			"anthropic",
		);
		const body = (await resp.json()) as AnthropicBody;

		expect(resp.status).toBe(200);
		expect(body.data.map((entry) => entry.id)).toEqual([
			"claude-opus-5",
			"claude-sonnet-5",
		]);
	}, 10_000);
});
