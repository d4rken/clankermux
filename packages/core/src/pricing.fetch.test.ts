import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __pricingTestHooks, estimateCostUSD } from "./pricing";

/**
 * B3: the models.dev fetch must be bounded (AbortController timeout) and
 * de-duped (one in-flight load shared by concurrent callers), and estimateCostUSD
 * must NEVER hang on a slow remote — it always resolves quickly from the bundled
 * fallback while the remote refresh happens in the background.
 */

// Point the disk cache at a fresh empty dir so a stale models.dev cache can't
// satisfy loadPricing() — we want to exercise the remote-fetch path. Restore in
// afterAll-equivalent teardown (bun shares one process across files).
const originalTmpdir = process.env.TMPDIR;
const originalFetch = globalThis.fetch;
let cacheDir: string;

// Matches DEFAULT_PRICING_FETCH_TIMEOUT_MS in pricing.ts (the fetch timeout is
// no longer overridable via env, so the abort test waits out the real default).
const PRICING_FETCH_TIMEOUT_MS = 4_000;

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "cmux-pricing-fetch-"));
	process.env.TMPDIR = cacheDir;
	__pricingTestHooks.reset();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	__pricingTestHooks.reset();
	if (originalTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdir;
	rmSync(cacheDir, { recursive: true, force: true });
});

describe("pricing fetch bounding + de-dupe (B3)", () => {
	it("estimateCostUSD resolves quickly from bundled data even when the remote fetch hangs", async () => {
		// A fetch that never resolves on its own — only the AbortController can end
		// it. If estimateCostUSD awaited this, it would hang.
		let aborted = false;
		globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				});
			});
		}) as unknown as typeof fetch;

		const start = Date.now();
		// claude-opus-4-8 is in the bundled table: input $5/M, output $25/M.
		const cost = await estimateCostUSD("claude-opus-4-8", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
		});
		const elapsed = Date.now() - start;

		// Bundled pricing answered immediately (well under the 4s fetch timeout).
		expect(elapsed).toBeLessThan(1_000);
		expect(cost).toBeCloseTo(30, 6);
		// The hung fetch is still running in the background; it has NOT blocked us.
		expect(aborted).toBe(false);
	});

	it("aborts a fetch that exceeds the default timeout", async () => {
		let aborted = false;
		globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				});
			});
		}) as unknown as typeof fetch;

		// Trigger the background load directly and wait past the default timeout for
		// it to settle (it falls back to bundled after the abort fires).
		await __pricingTestHooks.getPricing();
		await new Promise((r) => setTimeout(r, PRICING_FETCH_TIMEOUT_MS + 200));
		expect(aborted).toBe(true);
	}, 10_000);

	it("de-dupes concurrent cold loads behind a single fetch", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			await new Promise((r) => setTimeout(r, 30));
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		// Fire several truly-concurrent loads on a freshly-reset catalogue. They
		// all start before the first fetch resolves, so without de-dupe each would
		// fire its own fetch.
		await Promise.all([
			__pricingTestHooks.loadPricing(),
			__pricingTestHooks.loadPricing(),
			__pricingTestHooks.loadPricing(),
		]);

		// All callers shared ONE in-flight remote load.
		expect(fetchCalls).toBe(1);
	});
});
