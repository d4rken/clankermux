import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __pricingTestHooks, getPricingGaps } from "@clankermux/core";
import { AnthropicCompatibleProvider } from "@clankermux/providers";
import {
	createUsageState,
	feedNonStreamBody,
	finalizeUsage,
} from "../usage-collector";

/**
 * A normal Anthropic-compatible request is priced TWICE: the provider's usage
 * extractor computes its own `costUsd`, and the proxy's usage collector computes
 * the one that is actually persisted. Only the collector opts into gap
 * reporting, so a single request that misses the pricing catalogue must produce
 * exactly ONE gap record with `occurrences: 1` — otherwise the count on the
 * dashboard would be double the real number of affected requests.
 */

// Offline + disposable disk cache, so the bundled table is the sole source of
// truth and no models.dev response can accidentally supply the missing price.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error("pricing test network disabled");
};
// The catalogue snapshot is rooted at the XDG cache dir, not the OS temp dir.
const originalCacheHome = process.env.XDG_CACHE_HOME;
const pricingCacheHome = mkdtempSync(join(tmpdir(), "cmux-proxy-pricing-"));
process.env.XDG_CACHE_HOME = pricingCacheHome;

afterAll(() => {
	globalThis.fetch = originalFetch;
	if (originalCacheHome === undefined) {
		delete process.env.XDG_CACHE_HOME;
	} else {
		process.env.XDG_CACHE_HOME = originalCacheHome;
	}
	rmSync(pricingCacheHome, { recursive: true, force: true });
	__pricingTestHooks.reset();
});

// `bun test` shares one process across files, so an earlier suite can leave
// pricing state behind — start every case from a clean registry.
beforeEach(() => {
	__pricingTestHooks.reset();
});

afterEach(() => {
	__pricingTestHooks.reset();
	__pricingTestHooks.setLogger(null);
});

const UNPRICED_MODEL = "claude-not-yet-priced-9";

function unpricedResponseBody(): string {
	return JSON.stringify({
		model: UNPRICED_MODEL,
		usage: {
			input_tokens: 100,
			output_tokens: 10,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
	});
}

describe("one request through the main path yields exactly one gap record", () => {
	it("records once even though the provider prices the same response first", async () => {
		const body = unpricedResponseBody();
		// The same response is priced twice, by call sites with different provider
		// attribution. The warn cache is model-keyed, so the operator sees exactly
		// one log line rather than one per pricing path.
		// (The catalogue also warns about the deliberately-disabled network fetch,
		// so keep only the "no price" lines.)
		const warnings: string[] = [];
		__pricingTestHooks.setLogger({
			warn: (message: string) => {
				if (message.startsWith("Price for model ")) warnings.push(message);
			},
			debug: () => {},
		});

		// 1. Provider-level extraction (response-processor drives this first).
		const provider = new AnthropicCompatibleProvider();
		await provider.extractUsageInfo(
			new Response(body, { headers: { "content-type": "application/json" } }),
		);
		expect(getPricingGaps()).toEqual([]);

		// 2. The proxy's usage collector — the real estimator, no injected fake.
		const state = createUsageState();
		feedNonStreamBody(state, body);
		const summary = await finalizeUsage(state, {
			responseTimeMs: 1000,
			providerName: "anthropic",
			accountProvider: "claude-console-api",
			isStream: false,
		});

		// The persisted cost collapses to 0 (stored as NULL) — the failure this
		// banner exists to surface.
		expect(summary.usage.costUsd).toBe(0);

		const gaps = getPricingGaps();
		expect(gaps).toHaveLength(1);
		expect(gaps[0]).toMatchObject({
			modelId: UNPRICED_MODEL,
			provider: "claude-console-api",
			reason: "model_missing",
			occurrences: 1,
		});

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(UNPRICED_MODEL);
	});
});
