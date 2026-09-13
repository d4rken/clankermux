/**
 * The shared upstream-catalogue holder.
 *
 * What is left here is plumbing, and the one property worth pinning is that the
 * API key reaches the Codex cache unchanged: entitlement is per-subscription,
 * so a pinned key that was handed the pool's catalogue instead of its own would
 * be offered models it cannot call.
 */

import { describe, expect, test } from "bun:test";
import type {
	AnthropicModelCatalogSnapshot,
	CodexModelCatalogEntry,
} from "@clankermux/proxy";
import { ModelCatalogService } from "../model-catalog-service";

const SNAPSHOT: AnthropicModelCatalogSnapshot = {
	models: [
		{
			id: "claude-opus-5",
			displayName: "Claude Opus 5",
			createdAt: "2026-01-01T00:00:00Z",
		},
	],
	source: "upstream",
	fetchedAt: 5_000,
};

function harness() {
	const keys: Array<string | null> = [];
	const service = new ModelCatalogService({
		anthropicCatalog: { get: async () => SNAPSHOT },
		codexCatalog: {
			get: async (apiKeyId): Promise<CodexModelCatalogEntry | null> => {
				keys.push(apiKeyId);
				return { bodyText: '{"models":[]}', etag: null };
			},
		},
		staticModelIds: ["gpt-5.6-sol", "gpt-5.5"],
	});
	return { service, keys };
}

describe("ModelCatalogService", () => {
	test("hands back Anthropic's snapshot with its provenance intact", async () => {
		const { service } = harness();

		expect(await service.getAnthropicCatalog()).toEqual(SNAPSHOT);
	});

	test("reads the Codex catalogue at the scope of the key that asked", async () => {
		const { service, keys } = harness();

		await service.getCodexCatalog("key-42");
		await service.getCodexCatalog(null);

		expect(keys).toEqual(["key-42", null]);
	});

	test("exposes the bundled Codex ids this build ships with", () => {
		const { service } = harness();

		expect(service.staticModelIds).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
	});
});
