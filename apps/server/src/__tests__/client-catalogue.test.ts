import { describe, expect, it } from "bun:test";
import { resolveClientModelMetadata } from "@clankermux/core";
import type {
	ClientCatalogue,
	ClientModelMetadataMap,
} from "@clankermux/types";
import { aliasCodexMetadata, renderClientCatalogue } from "../client-catalogue";
import { handleModelsRoute, type ModelsRouteDeps } from "../models-route";
import anthropicRetentionFixture from "./fixtures/cache-retention/anthropic.json";
import codexRetentionFixture from "./fixtures/cache-retention/codex.json";
import emptyRetentionFixture from "./fixtures/cache-retention/empty-enrichment.json";
import openaiRetentionFixture from "./fixtures/cache-retention/openai.json";

const catalogue: ClientCatalogue = {
	defaultModel: null,
	models: [
		{
			id: "friendly",
			displayName: "Friendly model",
			createdAt: "2026-01-01T00:00:00Z",
			targetModel: "real-model",
			accountIds: ["a"],
			codexMetadata: {
				slug: "real-model",
				context_window: 12345,
				base_instructions: "Actual instructions",
			},
		},
	],
};
describe("client catalogue serving", () => {
	it("omits unknown Codex alias efforts while preserving the published entry", async () => {
		const model = { ...catalogue.models[0], targetModel: "alias:unknown" };
		for (const metadata of [
			undefined,
			{},
			{ supportedReasoningEfforts: ["low", "medium"] as const },
		]) {
			const supported = metadata?.supportedReasoningEfforts;
			const known = supported !== undefined;
			const info = aliasCodexMetadata(
				model,
				supported === undefined
					? metadata
					: { supportedReasoningEfforts: [...supported] },
			);
			const body = await renderClientCatalogue(
				{ defaultModel: null, models: [{ ...model, codexMetadata: info }] },
				"codex",
			).json();
			expect(body.models).toHaveLength(1);
			const entry = body.models[0];
			expect(entry.slug).toBe("friendly");
			expect(entry.base_instructions).toBe("You are a coding assistant.");
			expect(entry.supports_reasoning_summaries).toBe(false);
			expect(entry.supports_reasoning_summary_parameter).toBe(false);
			if (known) {
				expect(
					entry.supported_reasoning_levels.map(
						(level: { effort: string }) => level.effort,
					),
				).toEqual(["low", "medium"]);
				expect(entry.default_reasoning_level).toBe("low");
			} else {
				expect(entry).not.toHaveProperty("supported_reasoning_levels");
				expect(entry).not.toHaveProperty("default_reasoning_level");
			}
		}
	});

	it("does not publish efforts for unmapped future GPT variants", async () => {
		for (const targetModel of [
			"gpt-5-future",
			"gpt-6-future",
			"gpt-6-astra-future-2027-01-01",
		]) {
			const metadata = await resolveClientModelMetadata({
				targetModel,
				providers: ["codex"],
			});
			expect(metadata).not.toHaveProperty("supportedReasoningEfforts");
			const model = { ...catalogue.models[0], targetModel: "alias:future" };
			model.codexMetadata = aliasCodexMetadata(model, metadata);
			const body = await renderClientCatalogue(
				{ defaultModel: null, models: [model] },
				"codex",
				{ friendly: metadata },
			).json();
			expect(body.models[0]).not.toHaveProperty("supported_reasoning_levels");
			expect(body.models[0].clankermux).not.toHaveProperty(
				"supportedReasoningEfforts",
			);
		}
	});
	it("renders the three wire shapes without mixing metadata", async () => {
		expect(
			await renderClientCatalogue(catalogue, "openai").json(),
		).toMatchObject({ object: "list", data: [{ id: "friendly" }] });
		expect(
			await renderClientCatalogue(catalogue, "anthropic").json(),
		).toMatchObject({
			data: [{ id: "friendly", display_name: "Friendly model", type: "model" }],
			has_more: false,
		});
		expect(
			await renderClientCatalogue(catalogue, "codex").json(),
		).toMatchObject({
			models: [
				{
					slug: "friendly",
					context_window: 12345,
					base_instructions: "Actual instructions",
				},
			],
		});
		expect(catalogue.models[0]?.codexMetadata?.slug).toBe("real-model");
	});
	it("adds opt-in metadata only to returned aliases in each native shape", async () => {
		const metadata: ClientModelMetadataMap = {
			friendly: {
				contextWindow: 200000,
				cachePolicy: {
					mode: "explicit",
					expiry: "estimated",
					source: "gateway-policy",
					defaultTtlMs: 300000,
					ttlAnchor: "request_start",
					ttlSemantics: "minimum",
				},
			},
			privateModel: { contextWindow: 999999 },
		};
		for (const format of ["openai", "anthropic", "codex"] as const) {
			const original = await renderClientCatalogue(catalogue, format).json();
			const response = renderClientCatalogue(catalogue, format, metadata);
			const enriched = await response.json();
			const rows = enriched.data ?? enriched.models;
			expect(rows).toHaveLength(1);
			expect(rows[0].clankermux).toEqual(metadata.friendly);
			delete rows[0].clankermux;
			expect(enriched).toEqual(original);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			expect(JSON.stringify(enriched)).not.toContain("accountIds");
		}
	});
	it("matches sanitized retention fixtures without changing native response fields", async () => {
		const metadata: ClientModelMetadataMap = {
			friendly: {
				contextWindow: 12345,
				cachePolicy: {
					mode: "implicit",
					expiry: "unavailable",
					source: "gateway-policy",
				},
				cacheRetention: {
					basis: "inferred",
					retentionMs: 1_800_000,
					semantics: "minimum",
					confidence: "low",
					anchor: "request_start",
					anchorBasis: "assumed",
					refreshOnReuse: true,
					refreshBasis: "assumed",
					sources: [
						{
							url: "https://developers.openai.com/api/docs/guides/prompt-caching",
							note: "OpenAI API minimum for GPT-5.6 and later.",
						},
					],
					note: "API retention is an inferred default for Codex subscriptions; applicability is unverified.",
				},
			},
			privateModel: { contextWindow: 999999 },
		};
		for (const [format, fixture] of [
			["openai", openaiRetentionFixture],
			["anthropic", anthropicRetentionFixture],
			["codex", codexRetentionFixture],
		] as const) {
			const body = await renderClientCatalogue(
				catalogue,
				format,
				metadata,
			).json();
			expect(body).toEqual(fixture);
			const rows = body.data ?? body.models;
			expect(rows).toHaveLength(1);
			for (const key of [
				"accountIds",
				"customEndpoint",
				"providerKinds",
				"thinkingLevels",
				"sessionCache",
				"estimatedExpiresAt",
			]) {
				expect(JSON.stringify(body)).not.toContain(`"${key}"`);
			}
			delete rows[0].clankermux;
			expect(body).toEqual(
				await renderClientCatalogue(catalogue, format).json(),
			);
		}
		expect(await renderClientCatalogue(catalogue, "openai", {}).json()).toEqual(
			emptyRetentionFixture,
		);
	});

	it("opts in only for clankermux_metadata=1", async () => {
		const seen: unknown[] = [];
		const deps: ModelsRouteDeps = {
			getClientCatalog: async (key, format, includeMetadata) => {
				seen.push([key, format, includeMetadata]);
				return renderClientCatalogue(catalogue, format);
			},
		};
		for (const dialect of ["openai", "anthropic"] as const) {
			for (const query of [
				"",
				"?clankermux_metadata=0",
				"?clankermux_metadata=true",
				"?clankermux_metadata=1",
			])
				await handleModelsRoute(
					new URL(`http://test/v1/models${query}`),
					deps,
					"key-a",
					dialect,
				);
		}
		expect(seen).toEqual(
			["openai", "anthropic"].flatMap((format) =>
				[false, false, false, true].map((flag) => ["key-a", format, flag]),
			),
		);
	});

	it("uses only selected IDs in the fallback when Codex metadata is unknown", async () => {
		expect(
			await renderClientCatalogue(
				{
					defaultModel: null,
					models: [
						{
							id: "unknown",
							displayName: "Unknown",
							targetModel: "unknown",
							accountIds: null,
						},
					],
				},
				"codex",
			).json(),
		).toMatchObject({ object: "list", data: [{ id: "unknown" }] });
	});
	it("does not allow private snapshots to use upstream cache validators", () => {
		const response = renderClientCatalogue(catalogue, "codex");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("etag")).toBeNull();
	});
	it("scopes by authenticated key and query shape", async () => {
		const seen: string[] = [];
		const deps: ModelsRouteDeps = {
			getClientCatalog: async (key, format) => {
				seen.push(`${key}:${format}`);
				return renderClientCatalogue(
					{ models: [], defaultModel: null },
					"openai",
				);
			},
		};
		await handleModelsRoute(
			new URL("http://test/v1/models?client_version=1"),
			deps,
			"key-a",
			"openai",
		);
		await handleModelsRoute(
			new URL("http://test/v1/models"),
			deps,
			"key-b",
			"anthropic",
		);
		await handleModelsRoute(
			new URL("http://test/v1/models"),
			deps,
			"key-c",
			"openai",
		);
		expect(seen).toEqual(["key-a:codex", "key-b:anthropic", "key-c:openai"]);
	});
	// Only the PRESENCE of client_version is read. Its value is client-controlled
	// and reading it would make an arbitrary string decide which shape is served.
	it("reads only the presence of client_version, never its value", async () => {
		const seen: string[] = [];
		const deps: ModelsRouteDeps = {
			getClientCatalog: async (_key, format) => {
				seen.push(format);
				return renderClientCatalogue(
					{ models: [], defaultModel: null },
					"codex",
				);
			},
		};
		for (const value of [
			"0.149.0",
			"",
			"latest",
			"9".repeat(4096),
			"../../etc/passwd",
		]) {
			await handleModelsRoute(
				new URL(
					`http://test/v1/models?client_version=${encodeURIComponent(value)}`,
				),
				deps,
				"key-a",
				"openai",
			);
		}
		expect(seen).toEqual(["codex", "codex", "codex", "codex", "codex"]);
	});
	it("allows optional enrichment time beyond a successful slow catalogue read", async () => {
		const response = await handleModelsRoute(
			new URL("http://test/v1/models?clankermux_metadata=1"),
			{
				getClientCatalog: async () => {
					await new Promise((resolve) => setTimeout(resolve, 2100));
					return renderClientCatalogue(catalogue, "openai", {});
				},
			},
			"key-a",
			"openai",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: [{ id: "friendly", clankermux: {} }],
		});
	});

	it("fails explicitly when a scoped catalogue cannot be read", async () => {
		const deps: ModelsRouteDeps = {
			getClientCatalog: async () => {
				throw new Error("db unavailable");
			},
		};
		const response = await handleModelsRoute(
			new URL("http://test/v1/models"),
			deps,
			"key-a",
			"openai",
		);
		expect(response.status).toBe(503);
	});
	// The only way this route can answer at all, so its failure mode is
	// load-bearing: a catalogue read that never settles must become a bounded
	// 503 rather than holding a client's startup probe open indefinitely.
	it("gives up on a catalogue read that never settles", async () => {
		const deps: ModelsRouteDeps = {
			getClientCatalog: () => new Promise<Response>(() => {}),
		};
		const response = await handleModelsRoute(
			new URL("http://test/v1/models"),
			deps,
			"key-a",
			"anthropic",
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toMatchObject({
			error: { type: "server_error" },
		});
	}, 10_000);
});
