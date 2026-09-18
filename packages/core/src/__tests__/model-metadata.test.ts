import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientModelMetadata, ModelCachePolicy } from "@clankermux/types";
import {
	reduceModelCachePolicies,
	resolveClientModelMetadata,
	resolveModelCachePolicy,
} from "../model-metadata";
import { __pricingTestHooks } from "../pricing";

/**
 * Published client metadata: what a Pi / Oh My Pi / OpenCode configuration is
 * told about a model, resolved from the routes that actually serve it.
 */

const originalCacheHome = process.env.XDG_CACHE_HOME;
const originalFetch = globalThis.fetch;
let cacheDir: string;

const entry = (extra: Record<string, unknown>) => ({
	id: "x",
	name: "X",
	cost: { input: 1, output: 2 },
	...extra,
});

/** models.dev-shaped fixture, loaded before every case that reads it. */
const CATALOGUE = {
	openai: {
		models: {
			"gpt-6-astra": entry({
				// The API window, deliberately unlike the verified 872k subscription
				// ceiling a Codex route admits.
				limit: { context: 400_000, output: 128_000 },
				reasoning: true,
				modalities: { input: ["text", "image"], output: ["text"] },
				cost: {
					input: 10,
					output: 50,
					cache_read: 1,
					cache_write: 12.5,
					tiers: [
						{
							tier: { type: "context", size: 272_000 },
							input: 20,
							output: 100,
						},
					],
				},
			}),
		},
	},
	anthropic: {
		models: {
			"claude-opus-4-8": entry({
				limit: { context: 1_000_000, output: 64_000 },
			}),
			"claude-haiku-4-5": entry({ limit: { context: 200_000, output: 8_192 } }),
		},
	},
	openrouter: {
		models: {
			"shared-model": entry({
				limit: { context: 500_000, input: 262_144, output: 32_000 },
				reasoning: true,
				modalities: { input: ["text", "image", "pdf"], output: ["text"] },
				cost: { input: 3, output: 15 },
			}),
			"gpt-9-turbo": entry({ limit: { context: 111_000, output: 11_000 } }),
			malformed: entry({
				limit: { context: "big", output: 4_096 },
				reasoning: "yes",
				modalities: { input: "text" },
				cost: {
					input: 1,
					tiers: [{ tier: { type: "context" }, input: 2, output: 3 }],
				},
			}),
		},
	},
	"openai-compatible": {
		models: {
			"shared-model": entry({
				limit: { context: 300_000, output: 64_000 },
				reasoning: false,
				modalities: { input: ["text"], output: ["text"] },
				cost: { input: 4, output: 15 },
			}),
		},
	},
};

async function loadCatalogue(): Promise<void> {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(CATALOGUE), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
	await __pricingTestHooks.loadPricing();
}

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "cmux-model-metadata-"));
	process.env.XDG_CACHE_HOME = cacheDir;
	__pricingTestHooks.reset();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	__pricingTestHooks.reset();
	if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = originalCacheHome;
	rmSync(cacheDir, { recursive: true, force: true });
});

describe("published model metadata", () => {
	it("publishes native account metadata without a catalogue route", async () => {
		const discovered: ClientModelMetadata = {
			contextWindow: 131_072,
			maxOutputTokens: 16_384,
			inputModalities: ["text", "image"],
		};
		expect(
			await resolveClientModelMetadata({
				targetModel: "swe-2",
				providers: [],
				discoveredMetadata: [discovered],
			}),
		).toEqual(discovered);
	});

	it("reduces native accounts to their smallest limits and shared modalities", async () => {
		const discoveredMetadata: ClientModelMetadata[] = [
			{
				contextWindow: 131_072,
				maxOutputTokens: 32_768,
				reasoning: true,
				inputModalities: ["text", "image"],
			},
			{
				contextWindow: 262_144,
				maxOutputTokens: 16_384,
				reasoning: false,
				inputModalities: ["text"],
			},
		];
		const original = structuredClone(discoveredMetadata);
		expect(
			await resolveClientModelMetadata({
				targetModel: "swe-2",
				providers: [],
				discoveredMetadata,
			}),
		).toEqual({
			contextWindow: 131_072,
			maxOutputTokens: 16_384,
			reasoning: false,
			inputModalities: ["text"],
		});
		expect(discoveredMetadata).toEqual(original);
	});

	it("drops fields that an unknown native account cannot substantiate", async () => {
		expect(
			await resolveClientModelMetadata({
				targetModel: "swe-2",
				providers: [],
				discoveredMetadata: [
					{
						contextWindow: 131_072,
						maxOutputTokens: 16_384,
						inputModalities: ["text", "image"],
					},
					{},
				],
			}),
		).toEqual({});
	});

	it("reduces native account metadata together with catalogue routes", async () => {
		await loadCatalogue();
		expect(
			await resolveClientModelMetadata({
				targetModel: "shared-model",
				providers: ["openrouter"],
				discoveredMetadata: [
					{
						contextWindow: 131_072,
						maxOutputTokens: 64_000,
						reasoning: true,
						inputModalities: ["text"],
					},
				],
			}),
		).toEqual({
			contextWindow: 131_072,
			maxOutputTokens: 32_000,
			reasoning: true,
			inputModalities: ["text"],
		});
	});

	it("publishes no native metadata when routes remain unresolved", async () => {
		expect(
			await resolveClientModelMetadata({
				targetModel: "swe-2",
				providers: [],
				discoveredMetadata: [{ contextWindow: 131_072 }],
				unresolvedRoutes: true,
			}),
		).toEqual({});
	});

	it("publishes the verified Codex ceiling rather than the client default", async () => {
		await loadCatalogue();
		const metadata = await resolveClientModelMetadata({
			targetModel: "gpt-6-astra",
			providers: ["codex"],
		});
		// 872_000 is the verified subscription ceiling; 272_000 is the Codex client
		// default and 400_000 is what the catalogue publishes for the API product.
		expect(metadata.contextWindow).toBe(872_000);
		expect(metadata.maxOutputTokens).toBe(128_000);
		expect(metadata.reasoning).toBe(true);
		expect(metadata.inputModalities).toEqual(["text", "image"]);
		expect(metadata.cost).toEqual({
			input: 10,
			output: 50,
			cacheRead: 1,
			cacheWrite: 12.5,
			tiers: [{ inputTokensAbove: 272_000, input: 20, output: 100 }],
		});
	});

	it("caps Anthropic routes at the window this proxy can actually reach", async () => {
		await loadCatalogue();
		for (const provider of ["anthropic", "claude-console-api"]) {
			expect(
				(
					await resolveClientModelMetadata({
						targetModel: "claude-opus-4-8",
						providers: [provider],
					})
				).contextWindow,
			).toBe(200_000);
		}
		// Below the cap the catalogue value stands unchanged.
		const haiku = await resolveClientModelMetadata({
			targetModel: "claude-haiku-4-5",
			providers: ["anthropic"],
		});
		expect(haiku.contextWindow).toBe(200_000);
		expect(haiku.maxOutputTokens).toBe(8_192);
	});

	it("prefers the catalogue's input ceiling over its context figure", async () => {
		await loadCatalogue();
		const metadata = await resolveClientModelMetadata({
			targetModel: "shared-model",
			providers: ["openrouter"],
		});
		expect(metadata.contextWindow).toBe(262_144);
		expect(metadata.maxOutputTokens).toBe(32_000);
		expect(metadata.inputModalities).toEqual(["text", "image"]);
	});

	it("reduces a multi-provider route to what holds for every one of them", async () => {
		await loadCatalogue();
		const metadata = await resolveClientModelMetadata({
			targetModel: "shared-model",
			providers: ["openrouter", "openai-compatible"],
		});
		expect(metadata.contextWindow).toBe(262_144);
		expect(metadata.maxOutputTokens).toBe(32_000);
		expect(metadata.reasoning).toBe(false);
		expect(metadata.inputModalities).toEqual(["text"]);
		// $3/M and $4/M input: no honest single rate, so no rate at all.
		expect(metadata.cost).toBeUndefined();
	});

	it("publishes nothing when one provider in the set has no entry", async () => {
		await loadCatalogue();
		// devin has no catalogue key at all, so `shared-model` is unknown on it —
		// which is exactly the live gpt-6-astra shape if the provider set were not
		// narrowed by model permission first.
		expect(
			await resolveClientModelMetadata({
				targetModel: "shared-model",
				providers: ["openrouter", "devin"],
			}),
		).toEqual({});
	});

	it("says nothing about an unresolved or empty route", async () => {
		await loadCatalogue();
		expect(
			await resolveClientModelMetadata({
				targetModel: "gpt-6-astra",
				providers: ["codex"],
				unresolvedRoutes: true,
			}),
		).toEqual({});
		expect(
			await resolveClientModelMetadata({
				targetModel: "gpt-6-astra",
				providers: [],
			}),
		).toEqual({});
	});

	it("resolves a dated snapshot through its base slug", async () => {
		await loadCatalogue();
		const metadata = await resolveClientModelMetadata({
			targetModel: "gpt-9-turbo-2026-01-01",
			providers: ["openrouter"],
		});
		expect(metadata.contextWindow).toBe(111_000);
		expect(metadata.maxOutputTokens).toBe(11_000);
	});

	it("drops each malformed field on its own without throwing", async () => {
		await loadCatalogue();
		const metadata = await resolveClientModelMetadata({
			targetModel: "malformed",
			providers: ["openrouter"],
		});
		expect(metadata).toEqual({ maxOutputTokens: 4_096 });
	});

	it("publishes the configured Anthropic cache policy with estimate semantics", () => {
		expect(
			resolveModelCachePolicy("claude-opus-4-8", [
				{ provider: "anthropic", format: "anthropic" },
			]),
		).toEqual({
			mode: "explicit",
			defaultTtlMs: 300_000,
			supportedTtlMs: [300_000, 3_600_000],
			refreshOnReuse: true,
			expiry: "estimated",
			source: "gateway-policy",
			ttlAnchor: "request_start",
			ttlSemantics: "minimum",
		});
	});

	it("does not infer cache policy from conflicting or unresolved routes", () => {
		expect(
			resolveModelCachePolicy("claude-opus-4-8", [
				{ provider: "anthropic", format: "anthropic" },
				{ provider: "openrouter", format: "anthropic" },
			]),
		).toBeUndefined();
		expect(
			resolveModelCachePolicy(
				"claude-opus-4-8",
				[{ provider: "anthropic", format: "anthropic" }],
				true,
			),
		).toBeUndefined();
		expect(
			resolveModelCachePolicy("claude-opus-4-8", [
				{
					provider: "anthropic",
					format: "anthropic",
					customEndpoint: "https://proxy.invalid",
				},
			]),
		).toBeUndefined();
	});

	it("requires known models, native Anthropic ingress and at least one route", () => {
		for (const format of ["openai", "codex"] as const) {
			expect(
				resolveModelCachePolicy("claude-opus-4-8", [
					{ provider: "anthropic", format },
				]),
			).toBeUndefined();
		}
		expect(resolveModelCachePolicy("claude-opus-4-8", [])).toBeUndefined();
		expect(
			resolveModelCachePolicy("claude-unknown", [
				{ provider: "anthropic", format: "anthropic" },
			]),
		).toBeUndefined();
		const direct = resolveModelCachePolicy("claude-opus-4-8", [
			{ provider: "anthropic", format: "anthropic" },
		]);
		expect(
			resolveModelCachePolicy("claude-opus-4-8", [
				{ provider: "anthropic", format: "anthropic" },
				{ provider: "claude-console-api", format: "anthropic" },
			]),
		).toEqual(direct);
	});
});

describe("cache policy reduction", () => {
	const policy: ModelCachePolicy = {
		mode: "explicit",
		defaultTtlMs: 300_000,
		supportedTtlMs: [300_000, 3_600_000],
		refreshOnReuse: true,
		expiry: "estimated",
		source: "gateway-policy",
		ttlAnchor: "request_start",
		ttlSemantics: "minimum",
	};
	const resolve = reduceModelCachePolicies;

	it("publishes common fields and intersects supported TTLs without mutating candidates", async () => {
		const candidates = [policy, { ...policy, supportedTtlMs: [300_000] }];
		const original = structuredClone(candidates);
		expect(await resolve(candidates)).toEqual({
			...policy,
			supportedTtlMs: [300_000],
		});
		expect(candidates).toEqual(original);
	});

	it("omits a conflicting default while retaining supported request TTLs", async () => {
		const expected = { ...policy };
		delete expected.defaultTtlMs;
		expect(
			await resolve([policy, { ...policy, defaultTtlMs: 3_600_000 }]),
		).toEqual(expected);
	});

	it("drops conflicting anchors or semantics and makes expiry unavailable", async () => {
		for (const override of [
			{ ttlAnchor: "request_end" as const },
			{ ttlSemantics: "configured" as const },
		]) {
			const expected = { ...policy, expiry: "unavailable" as const };
			if ("ttlAnchor" in override) delete expected.ttlAnchor;
			else delete expected.ttlSemantics;
			expect(await resolve([policy, { ...policy, ...override }])).toEqual(
				expected,
			);
		}
	});

	it("never derives an estimate from typical retention or exact claims", async () => {
		expect(await resolve([{ ...policy, ttlSemantics: "typical" }])).toEqual({
			...policy,
			ttlSemantics: "typical",
			expiry: "unavailable",
		});
		expect(await resolve([{ ...policy, expiry: "exact" }])).toEqual({
			...policy,
			expiry: "unavailable",
		});
	});

	it("does not let an unknown route inherit known TTL options", async () => {
		expect(await resolve([policy, undefined])).toBeUndefined();
		const expected = { ...policy };
		delete expected.supportedTtlMs;
		expect(
			await resolve([policy, { ...policy, supportedTtlMs: undefined }]),
		).toEqual(expected);
	});

	it("does not retain TTLs when cache modes conflict", async () => {
		expect(await resolve([policy, { ...policy, mode: "implicit" }])).toEqual({
			mode: "unknown",
			expiry: "unavailable",
			source: "gateway-policy",
		});
	});

	it("does not infer a refresh on reuse when routes disagree", async () => {
		const expected = { ...policy };
		delete expected.refreshOnReuse;
		expect(
			await resolve([policy, { ...policy, refreshOnReuse: false }]),
		).toEqual(expected);
	});
});
