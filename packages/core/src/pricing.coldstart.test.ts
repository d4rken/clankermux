import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_CONTEXT_WINDOWS } from "./model-mappings";
import { __pricingTestHooks, estimateCostUSD, getPricingGaps } from "./pricing";

/**
 * Cold-start pricing: a request that finalizes before the models.dev catalogue
 * has replaced the bundled seed must NOT be recorded with a NULL cost, and must
 * not raise a pricing gap for a model the catalogue has had all along.
 *
 * Observed in production: the service started at 16:25:25, the first two Codex
 * requests finalized at 16:25:45.067 and .380, and the merged catalogue landed
 * at 16:25:45.479 — 99ms after the second one. Both were persisted with cost
 * NULL and put `gpt-5.6-sol` on the Overview's "recorded without pricing"
 * banner for the rest of the process, while every later request priced fine.
 */

const originalCacheHome = process.env.XDG_CACHE_HOME;
const originalFetch = globalThis.fetch;
let cacheDir: string;

/** A models.dev-shaped catalogue carrying one model the bundled table lacks. */
const REMOTE_ONLY_MODEL = "gpt-9-remote-only";
function remoteCatalogue(): unknown {
	return {
		openai: {
			models: {
				[REMOTE_ONLY_MODEL]: {
					id: REMOTE_ONLY_MODEL,
					name: "GPT-9 remote only",
					cost: { input: 2, output: 8, cache_read: 0.2 },
				},
			},
		},
	};
}

/** Write a catalogue to the disk cache the catalogue loader reads. */
function seedDiskCache(catalogue: unknown): void {
	const dir = join(cacheDir, "clankermux");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "models.dev.json"), JSON.stringify(catalogue));
}

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "cmux-pricing-cold-"));
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

describe("cold-start catalogue race", () => {
	it("prices a remote-only model that misses the bundled seed, recording no gap", async () => {
		// The load resolves shortly AFTER the request starts pricing — the exact
		// production ordering.
		globalThis.fetch = (async () => {
			await new Promise((r) => setTimeout(r, 40));
			return new Response(JSON.stringify(remoteCatalogue()), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		// Nothing has loaded yet: this is the first priced request of the process.
		expect(__pricingTestHooks.isCatalogueLoaded()).toBe(false);

		const cost = await estimateCostUSD(
			REMOTE_ONLY_MODEL,
			{ inputTokens: 1_000_000, outputTokens: 1_000_000 },
			{ provider: "codex", reportGaps: true },
		);

		// input $2/M + output $8/M over 1M each.
		expect(cost).toBeCloseTo(10, 6);
		expect(getPricingGaps()).toEqual([]);
	});

	it("still records a gap for a model that is genuinely absent", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(remoteCatalogue()), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;

		const cost = await estimateCostUSD(
			"gpt-does-not-exist",
			{ inputTokens: 1_000 },
			{ provider: "codex", reportGaps: true },
		);

		expect(cost).toBe(0);
		const gaps = getPricingGaps();
		expect(gaps).toHaveLength(1);
		expect(gaps[0].modelId).toBe("gpt-does-not-exist");
		expect(gaps[0].reason).toBe("model_missing");
	});

	it("does not start a second load per miss once the first has settled", async () => {
		// Remote is down and there is no snapshot on disk, so the catalogue never
		// loads. Every subsequent miss must be answered from what we have, NOT by
		// firing another fetch — otherwise one unknown model id becomes a fetch per
		// request.
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("network down");
		}) as unknown as typeof fetch;

		for (let i = 0; i < 5; i++) {
			await estimateCostUSD(
				"gpt-does-not-exist",
				{ inputTokens: 1_000 },
				{ provider: "codex", reportGaps: true },
			);
		}

		expect(__pricingTestHooks.isCatalogueLoaded()).toBe(false);
		expect(fetchCalls).toBe(1);
	});
});

describe("catalogue-loaded flag", () => {
	it("is not set by a well-formed but empty catalogue", async () => {
		// `{}` parses, merges to exactly the bundled table, and would otherwise
		// claim the bundled seed had been replaced — making every later miss skip
		// the wait, and the backfill preflight a false positive.
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({}), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;

		await __pricingTestHooks.loadPricing();
		expect(__pricingTestHooks.isCatalogueLoaded()).toBe(false);
	});

	it("is not set when every usable provider is filtered out of the merge", async () => {
		// `-coding-plan` providers are dropped during the merge, so this response
		// passes content validation and still merges down to exactly the bundled
		// table. Judging the flag on the merge INPUT would call that "loaded" and
		// let the backfill preflight through with bundled-only coverage.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					"acme-coding-plan": {
						models: {
							"acme-1": {
								id: "acme-1",
								name: "Acme 1",
								cost: { input: 1, output: 2 },
							},
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		await __pricingTestHooks.loadPricing();
		expect(__pricingTestHooks.isCatalogueLoaded()).toBe(false);
	});

	it("is not set when the only priced entry is one the bundled table already covers", async () => {
		// Validation is satisfied by any one usable entry anywhere — here a bundled
		// id supplies it. The unknown id next to it prices nothing, so the merge
		// adds no coverage and the catalogue is not loaded in any useful sense.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					anthropic: {
						models: {
							"claude-opus-4-8": {
								id: "claude-opus-4-8",
								name: "Claude Opus 4.8",
								cost: { input: 5, output: 25 },
							},
						},
					},
					openai: {
						models: {
							"gpt-9-priceless": { id: "gpt-9-priceless", name: "no rates" },
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		await __pricingTestHooks.loadPricing();
		expect(__pricingTestHooks.isCatalogueLoaded()).toBe(false);
	});

	it("clears when a later load degrades to bundled-only", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(remoteCatalogue()), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		await __pricingTestHooks.loadPricing();
		expect(__pricingTestHooks.isCatalogueLoaded()).toBe(true);

		// Remote gone AND the snapshot removed: the next load replaces the real
		// catalogue with the bundled table, so the flag must come down with it.
		rmSync(join(cacheDir, "clankermux"), { recursive: true, force: true });
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		await __pricingTestHooks.loadPricing();
		expect(__pricingTestHooks.isCatalogueLoaded()).toBe(false);
	});

	it("waits on a background refresh before reporting a model unpriced", async () => {
		// Serving from a fresh snapshot marks the catalogue loaded, so a model that
		// only the refresh knows about must still not be recorded as a gap.
		seedDiskCache(remoteCatalogue());
		const REFRESH_ONLY = "gpt-9-refresh-only";
		globalThis.fetch = (async () => {
			await new Promise((r) => setTimeout(r, 30));
			return new Response(
				JSON.stringify({
					openai: {
						models: {
							[REFRESH_ONLY]: {
								id: REFRESH_ONLY,
								name: "refresh only",
								cost: { input: 4, output: 4 },
							},
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const cost = await estimateCostUSD(
			REFRESH_ONLY,
			{ inputTokens: 1_000_000 },
			{ provider: "codex", reportGaps: true },
		);
		expect(cost).toBeCloseTo(4, 6);
		expect(getPricingGaps()).toEqual([]);
	});
});

describe("dated model snapshots", () => {
	it("prices a -YYYY-MM-DD snapshot at its base model's rate", async () => {
		// gpt-5.4-mini is bundled at $0.75/M input; the dated snapshot Codex
		// actually served (16 such requests are recorded with a NULL cost) appears
		// in no catalogue.
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;

		const cost = await estimateCostUSD(
			"gpt-5.4-mini-2026-03-17",
			{ inputTokens: 1_000_000 },
			{ provider: "codex", reportGaps: true },
		);

		expect(cost).toBeCloseTo(0.75, 6);
		expect(getPricingGaps()).toEqual([]);
	});

	it("prefers an exact entry over the dated-suffix fallback", async () => {
		// A catalogue that prices the dated id explicitly must win: a snapshot is
		// only assumed to share its base's price when nothing says otherwise.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					openai: {
						models: {
							"gpt-5.4-mini-2026-03-17": {
								id: "gpt-5.4-mini-2026-03-17",
								name: "dated",
								cost: { input: 99, output: 99 },
							},
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		await __pricingTestHooks.loadPricing();
		const cost = await estimateCostUSD("gpt-5.4-mini-2026-03-17", {
			inputTokens: 1_000_000,
		});
		expect(cost).toBeCloseTo(99, 6);
	});

	it("prefers a complete base entry over an incomplete exact one", async () => {
		// Production shape: one reseller lists the dated id with input+output but no
		// cache_read, while the base slug is fully priced. A missing rate collapses
		// the ENTIRE request cost, so 16 recorded requests cost NULL because the
		// partial entry was found first.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					"some-reseller": {
						models: {
							"gpt-5.4-mini-2026-03-17": {
								id: "gpt-5.4-mini-2026-03-17",
								name: "partial",
								cost: { input: 0.75, output: 4.5 },
							},
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		await __pricingTestHooks.loadPricing();
		const cost = await estimateCostUSD(
			"gpt-5.4-mini-2026-03-17",
			{ inputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 },
			{ provider: "codex", reportGaps: true },
		);

		// Priced entirely from the bundled gpt-5.4-mini entry: 0.75 + 0.075.
		expect(cost).toBeCloseTo(0.825, 6);
		expect(getPricingGaps()).toEqual([]);
	});

	it("does not let coverage move a NON-dated model onto another provider's price", async () => {
		// The vendor lists this id without cache_read; a reseller lists the same id
		// complete but an order of magnitude cheaper on output. Preferring coverage
		// here would silently reprice every cached request instead of reporting a
		// gap, so the first (vendor) entry must still win and the request must fail
		// to price.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					vendor: {
						models: {
							"image-preview": {
								id: "image-preview",
								name: "vendor",
								cost: { input: 2, output: 120 },
							},
						},
					},
					reseller: {
						models: {
							"image-preview": {
								id: "image-preview",
								name: "reseller",
								cost: { input: 2, output: 12, cache_read: 0.2 },
							},
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		await __pricingTestHooks.loadPricing();
		const cost = await estimateCostUSD(
			"image-preview",
			{ inputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 },
			{ provider: "codex", reportGaps: true },
		);

		expect(cost).toBe(0);
		const gaps = getPricingGaps();
		expect(gaps).toHaveLength(1);
		expect(gaps[0].reason).toBe("cost_missing");
	});

	it("keeps the incomplete exact entry when the request does not need the missing rate", async () => {
		// Coverage is scored against the rates the request actually uses, so an
		// irrelevant hole must not push pricing onto the base entry.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					"some-reseller": {
						models: {
							"gpt-5.4-mini-2026-03-17": {
								id: "gpt-5.4-mini-2026-03-17",
								name: "partial",
								cost: { input: 3, output: 9 },
							},
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		await __pricingTestHooks.loadPricing();
		// No cache tokens → cache_read is not needed → the exact entry covers it.
		const cost = await estimateCostUSD("gpt-5.4-mini-2026-03-17", {
			inputTokens: 1_000_000,
		});
		expect(cost).toBeCloseTo(3, 6);
	});

	it("waits for the real catalogue before pricing a snapshot from the bundled base", async () => {
		// The bundled seed alone can satisfy `gpt-5.4-mini`, so a dated snapshot
		// resolves at cold start with no waiting at all — and would be priced from
		// that inference even though the catalogue still loading lists the exact
		// dated id at its own rate. An inferred match must not end the wait.
		globalThis.fetch = (async () => {
			await new Promise((r) => setTimeout(r, 40));
			return new Response(
				JSON.stringify({
					openai: {
						models: {
							"gpt-5.4-mini-2026-03-17": {
								id: "gpt-5.4-mini-2026-03-17",
								name: "dated",
								cost: { input: 42, output: 42 },
							},
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		expect(__pricingTestHooks.isCatalogueLoaded()).toBe(false);
		const cost = await estimateCostUSD("gpt-5.4-mini-2026-03-17", {
			inputTokens: 1_000_000,
		});
		// 42 (the catalogue's own dated rate), not 0.75 (the bundled base).
		expect(cost).toBeCloseTo(42, 6);
	});

	it("refuses a base entry that contradicts the dated entry's published rates", async () => {
		// Borrowing a missing rate from the base slug is only sound while the two
		// describe the same product. A base entry priced differently is a different
		// product, so the request stays unpriced rather than being silently
		// repriced off the snapshot's own published input rate.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					reseller: {
						models: {
							"gpt-9-turbo-2026-01-01": {
								id: "gpt-9-turbo-2026-01-01",
								name: "dated",
								cost: { input: 10, output: 20 },
							},
						},
					},
					vendor: {
						models: {
							"gpt-9-turbo": {
								id: "gpt-9-turbo",
								name: "base",
								// Disagrees on input: 3 vs the dated entry's 10.
								cost: { input: 3, output: 20, cache_read: 0.3 },
							},
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		await __pricingTestHooks.loadPricing();
		const cost = await estimateCostUSD(
			"gpt-9-turbo-2026-01-01",
			{ inputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 },
			{ provider: "codex", reportGaps: true },
		);

		expect(cost).toBe(0);
		expect(getPricingGaps()).toHaveLength(1);
		expect(getPricingGaps()[0].reason).toBe("cost_missing");
	});

	it("accepts a base entry that agrees on every shared rate", async () => {
		// The production shape: the reseller's dated entry and the vendor's base
		// entry publish identical input/output, so the base entry's cache_read is
		// the missing piece of the same price list.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					reseller: {
						models: {
							"gpt-9-turbo-2026-01-01": {
								id: "gpt-9-turbo-2026-01-01",
								name: "dated",
								cost: { input: 3, output: 20 },
							},
						},
					},
					vendor: {
						models: {
							"gpt-9-turbo": {
								id: "gpt-9-turbo",
								name: "base",
								cost: { input: 3, output: 20, cache_read: 0.3 },
							},
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		await __pricingTestHooks.loadPricing();
		const cost = await estimateCostUSD(
			"gpt-9-turbo-2026-01-01",
			{ inputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 },
			{ provider: "codex", reportGaps: true },
		);

		expect(cost).toBeCloseTo(3.3, 6);
		expect(getPricingGaps()).toEqual([]);
	});

	it("does not scan past the first base entry when nothing publishes the dated id", async () => {
		// With no dated entry there is nothing to check a candidate against, so
		// preferring a COVERING base entry would hand the request to whichever
		// reseller happens to list every rate — the same silent repricing refused
		// for ordinary ids. First entry wins; the request stays unpriced.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					vendor: {
						models: {
							"gpt-9-vision": {
								id: "gpt-9-vision",
								name: "vendor",
								cost: { input: 2, output: 120 },
							},
						},
					},
					reseller: {
						models: {
							"gpt-9-vision": {
								id: "gpt-9-vision",
								name: "reseller",
								cost: { input: 2, output: 12, cache_read: 0.2 },
							},
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		await __pricingTestHooks.loadPricing();
		const cost = await estimateCostUSD(
			"gpt-9-vision-2026-01-01",
			{ inputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 },
			{ provider: "codex", reportGaps: true },
		);

		expect(cost).toBe(0);
		expect(getPricingGaps()).toHaveLength(1);
	});

	it("refuses a base entry when the dated entry publishes no rates to agree with", async () => {
		// A priceless dated stub covers nothing, so the coverage scan runs — but a
		// stub is no evidence that the base slug is the same product, so it must
		// not license a reseller's complete (and much cheaper) base entry.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					stub: {
						models: {
							"gpt-9-stub-2026-01-01": {
								id: "gpt-9-stub-2026-01-01",
								name: "priceless stub",
							},
						},
					},
					vendor: {
						models: {
							"gpt-9-stub": {
								id: "gpt-9-stub",
								name: "vendor",
								cost: { input: 2, output: 120 },
							},
						},
					},
					reseller: {
						models: {
							"gpt-9-stub": {
								id: "gpt-9-stub",
								name: "reseller",
								cost: { input: 2, output: 12, cache_read: 0.2 },
							},
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		await __pricingTestHooks.loadPricing();
		const cost = await estimateCostUSD(
			"gpt-9-stub-2026-01-01",
			{ inputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 },
			{ provider: "codex", reportGaps: true },
		);

		expect(cost).toBe(0);
		expect(getPricingGaps()).toHaveLength(1);
	});

	it("does not strip a non-date suffix", async () => {
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;

		const cost = await estimateCostUSD(
			"gpt-5.4-mini-experimental",
			{ inputTokens: 1_000_000 },
			{ provider: "codex", reportGaps: true },
		);

		expect(cost).toBe(0);
		expect(getPricingGaps()).toHaveLength(1);
	});
});

describe("bundled catalogue coverage", () => {
	it("prices every Codex-routable model without any network or disk cache", async () => {
		// The offline guarantee: a fresh install with models.dev unreachable still
		// costs every model a Codex account can be routed to.
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;

		for (const model of Object.keys(MODEL_CONTEXT_WINDOWS)) {
			const cost = await estimateCostUSD(
				model,
				{ inputTokens: 1_000_000 },
				{ provider: "codex", reportGaps: true },
			);
			expect(cost).toBeGreaterThan(0);
		}
		// Not one of them was reported as unpriced.
		expect(getPricingGaps()).toEqual([]);
	});
});

describe("catalogue cache", () => {
	it("serves a fresh disk snapshot without waiting on the network", async () => {
		seedDiskCache(remoteCatalogue());

		// A fetch that never settles: if the load waited on the network rather than
		// reading the snapshot, this would hang until the abort timeout.
		globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;

		const start = Date.now();
		const cost = await estimateCostUSD(REMOTE_ONLY_MODEL, {
			inputTokens: 1_000_000,
		});
		expect(Date.now() - start).toBeLessThan(1_000);
		expect(cost).toBeCloseTo(2, 6);
	});

	it("falls back to a stale snapshot when the remote is unreachable", async () => {
		seedDiskCache(remoteCatalogue());
		// Age the snapshot past the 24h refresh window.
		const stalePath = join(cacheDir, "clankermux", "models.dev.json");
		const staleTime = new Date(Date.now() - 72 * 60 * 60 * 1000);
		utimesSync(stalePath, staleTime, staleTime);

		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;

		// A stale real catalogue still prices thousands of models the bundled table
		// has never heard of — strictly better than dropping to bundled-only.
		const cost = await estimateCostUSD(REMOTE_ONLY_MODEL, {
			inputTokens: 1_000_000,
		});
		expect(cost).toBeCloseTo(2, 6);
	});

	it("honours XDG_CACHE_HOME", () => {
		expect(__pricingTestHooks.cacheDir()).toBe(join(cacheDir, "clankermux"));
	});

	it("defaults outside the OS temp dir", () => {
		// /tmp is tmpfs on a normal Linux install: a snapshot there dies on every
		// reboot, which is what forced a full re-download before the first request
		// after one could be priced. Asserted with the override removed — the
		// default is the part that ships.
		delete process.env.XDG_CACHE_HOME;
		try {
			const dir = __pricingTestHooks.cacheDir();
			expect(dir.startsWith(tmpdir())).toBe(false);
			expect(dir).toBe(join(homedir(), ".cache", "clankermux"));
		} finally {
			process.env.XDG_CACHE_HOME = cacheDir;
		}
	});
});
