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
	it("scopes by authenticated key and query shape without reading global overrides", async () => {
		const seen: string[] = [];
		const deps = {
			getClientCatalog: async (key: string, format: string) => {
				seen.push(`${key}:${format}`);
				return renderClientCatalogue(
					{ models: [], defaultModel: null },
					"openai",
				);
			},
			listOverrides: () => {
				throw new Error("global read");
			},
		} as unknown as ModelsRouteDeps;
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
		expect(seen).toEqual(["key-a:codex", "key-b:anthropic"]);
	});
	it("fails explicitly when a scoped catalogue cannot be read", async () => {
		const deps = {
			getClientCatalog: async () => {
				throw new Error("db unavailable");
			},
			listOverrides: () => {
				throw new Error("global read");
			},
		} as unknown as ModelsRouteDeps;
		const response = await handleModelsRoute(
			new URL("http://test/v1/models"),
			deps,
			"key-a",
			"openai",
		);
		expect(response.status).toBe(503);
	});
});
