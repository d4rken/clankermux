import { describe, expect, it } from "bun:test";
import type { ClientCatalogue } from "@clankermux/types";
import { renderClientCatalogue } from "../client-catalogue";
import { handleModelsRoute, type ModelsRouteDeps } from "../models-route";

const catalogue: ClientCatalogue = {
	defaultModel: null,
	models: [
		{
			id: "friendly",
			displayName: "Friendly model",
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
