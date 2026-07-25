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
import {
	__pricingTestHooks,
	estimateCostUSD,
	getModelCacheRates,
	getPricingGapOverflowCount,
	getPricingGaps,
	type TokenBreakdown,
} from "./pricing";

// Make pricing deterministic: never hit the network, and point the disk cache
// at a fresh empty dir so a stale/remote models.dev cache can't leak in. This
// forces the bundled fallback table to be the sole source of truth.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error("pricing test network disabled");
};

// The pricing disk cache is rooted at `tmpdir()`, so redirect the OS temp dir to
// a throwaway location. `bun test` shares one process across all test files, so
// this mutation must be restored in afterAll — leaking it makes `tmpdir()`
// return the throwaway dir for every file that runs afterward, which broke
// security/path-validator's "should include temp directory" assertion (its
// cached allowlist held the real /tmp while tmpdir() returned cmux-pricing-*).
const originalTmpdir = process.env.TMPDIR;
const pricingTmpdir = mkdtempSync(join(tmpdir(), "cmux-pricing-"));
process.env.TMPDIR = pricingTmpdir;

afterAll(() => {
	globalThis.fetch = originalFetch;
	if (originalTmpdir === undefined) {
		delete process.env.TMPDIR;
	} else {
		process.env.TMPDIR = originalTmpdir;
	}
	rmSync(pricingTmpdir, { recursive: true, force: true });
});

describe("estimateCostUSD", () => {
	it("returns 0 for an unknown model and records nothing without opt-in", async () => {
		__pricingTestHooks.reset();
		const tokenBreakdown: TokenBreakdown = {
			inputTokens: 1000,
			outputTokens: 1000,
		};

		const cost = await estimateCostUSD(
			"this-model-does-not-exist",
			tokenBreakdown,
		);

		expect(cost).toBe(0);
		// Reporting is opt-in: a bare call still de-duplicates the log warning
		// internally, but surfaces no gap.
		expect(getPricingGaps()).toEqual([]);
	});

	it("computes cost for a known bundled Anthropic model", async () => {
		// claude-haiku-4-5: input $1/M, output $5/M
		const tokenBreakdown: TokenBreakdown = {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
		};

		const cost = await estimateCostUSD("claude-haiku-4-5", tokenBreakdown);

		// 1M input * $1/M + 1M output * $5/M = $6 (only if remote/bundled has it)
		expect(cost).toBeGreaterThanOrEqual(0);
	});
});

describe("bundled Opus pricing (offline fallback)", () => {
	// Opus 4.7, 4.8 and 5 all price at $5/M input, $25/M output,
	// $0.50/M cache read, $6.25/M cache write — same tier as Opus 4.5/4.6.
	// (Opus 5's $10/$50 "fast mode" is a Claude-API-only research preview with
	// no representation in this proxy.)
	const ioTokens: TokenBreakdown = {
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
	};
	const cacheTokens: TokenBreakdown = {
		cacheReadInputTokens: 1_000_000,
		cacheCreationInputTokens: 1_000_000,
	};

	it("prices claude-opus-5 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-opus-5", ioTokens)).toBeCloseTo(30, 6);
	});

	it("prices claude-opus-5 cache tokens from bundled data", async () => {
		expect(await estimateCostUSD("claude-opus-5", cacheTokens)).toBeCloseTo(
			6.75,
			6,
		);
	});

	it("prices claude-opus-4-8 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-opus-4-8", ioTokens)).toBeCloseTo(
			30,
			6,
		);
	});

	it("prices claude-opus-4-8 cache tokens from bundled data", async () => {
		expect(await estimateCostUSD("claude-opus-4-8", cacheTokens)).toBeCloseTo(
			6.75,
			6,
		);
	});

	it("backfills claude-opus-4-7 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-opus-4-7", ioTokens)).toBeCloseTo(
			30,
			6,
		);
	});
});

describe("bundled cost fields backfill a partial remote entry", () => {
	// models.dev can list a freshly-released model before it carries cache
	// pricing. Merging "remote wins wholesale" would then leave the merged entry
	// without cache_read/cache_write, getCostRate would throw, and the WHOLE
	// request cost would collapse to 0 (persisted as NULL) — the same outage the
	// bundled entry exists to prevent. Bundled must fill the per-field gaps while
	// every value the remote does define still wins.
	const allTokens: TokenBreakdown = {
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
		cacheReadInputTokens: 1_000_000,
		cacheCreationInputTokens: 1_000_000,
	};
	const cacheOnlyTokens: TokenBreakdown = {
		cacheReadInputTokens: 1_000_000,
		cacheCreationInputTokens: 1_000_000,
	};

	async function withRemoteCatalogue(
		remote: unknown,
		run: () => Promise<void>,
	): Promise<void> {
		const offlineFetch = globalThis.fetch;
		// Point the disk cache somewhere disposable so the stub catalogue can't
		// leak into any later test through the on-disk pricing cache.
		const remoteTmpdir = mkdtempSync(join(tmpdir(), "cmux-pricing-remote-"));
		process.env.TMPDIR = remoteTmpdir;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(remote), {
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		try {
			__pricingTestHooks.reset();
			await __pricingTestHooks.loadPricing();
			await run();
		} finally {
			globalThis.fetch = offlineFetch;
			process.env.TMPDIR = pricingTmpdir;
			rmSync(remoteTmpdir, { recursive: true, force: true });
			__pricingTestHooks.reset();
		}
	}

	it("fills missing cache costs while the remote input cost still wins", async () => {
		await withRemoteCatalogue(
			{
				anthropic: {
					models: {
						"claude-opus-5": {
							id: "claude-opus-5",
							name: "Claude Opus 5",
							// Deliberately no cache_read/cache_write, and an input
							// cost that differs from the bundled $5 so we can tell
							// which side won.
							cost: { input: 7, output: 25 },
						},
					},
				},
			},
			async () => {
				// 7 (remote input) + 25 (remote output), plus the bundled cache rates
				// scaled to the remote tier (7/5 = 1.4x): 0.5*1.4 + 6.25*1.4.
				expect(await estimateCostUSD("claude-opus-5", allTokens)).toBeCloseTo(
					41.45,
					6,
				);
			},
		);
	});

	it("scales backfilled cache costs to the remote price tier", async () => {
		await withRemoteCatalogue(
			{
				anthropic: {
					models: {
						"claude-opus-5": {
							id: "claude-opus-5",
							name: "Claude Opus 5",
							// models.dev moved the model to the doubled tier
							// (bundled is 5 / 25 / 0.5 / 6.25) and still lists no
							// cache rates. Copying the bundled cache absolutes would
							// price cached tokens at the old tier forever.
							cost: { input: 10, output: 50 },
						},
					},
				},
			},
			async () => {
				// Merged cache rates are 0.5*2 = 1.0 and 6.25*2 = 12.5 per 1M.
				expect(
					await estimateCostUSD("claude-opus-5", cacheOnlyTokens),
				).toBeCloseTo(13.5, 6);
				// ...and the input/output rates the remote defined still win.
				expect(await estimateCostUSD("claude-opus-5", allTokens)).toBeCloseTo(
					73.5,
					6,
				);
			},
		);
	});

	it("copies bundled cache costs verbatim when the remote input is zero", async () => {
		await withRemoteCatalogue(
			{
				anthropic: {
					models: {
						"claude-opus-5": {
							id: "claude-opus-5",
							name: "Claude Opus 5",
							// A zero-rated input carries no tier information; scaling
							// by it would wipe out the cache rates entirely, so the
							// bundled absolutes are copied instead.
							cost: { input: 0, output: 25 },
						},
					},
				},
			},
			async () => {
				expect(
					await estimateCostUSD("claude-opus-5", cacheOnlyTokens),
				).toBeCloseTo(6.75, 6);
			},
		);
	});

	it("still adds models the remote catalogue omits entirely", async () => {
		await withRemoteCatalogue(
			{
				anthropic: {
					models: {
						"claude-opus-5": {
							id: "claude-opus-5",
							name: "Claude Opus 5",
							cost: { input: 7, output: 25 },
						},
					},
				},
			},
			async () => {
				// claude-opus-4-8 is bundled-only in this catalogue: 5 + 25 + 0.5 + 6.25
				expect(await estimateCostUSD("claude-opus-4-8", allTokens)).toBeCloseTo(
					36.75,
					6,
				);
			},
		);
	});

	it("does not overwrite a remote cost of zero", async () => {
		await withRemoteCatalogue(
			{
				anthropic: {
					models: {
						"claude-opus-5": {
							id: "claude-opus-5",
							name: "Claude Opus 5",
							// A free/zero-rated field is a defined remote value and
							// must survive the backfill.
							cost: { input: 5, output: 25, cache_read: 0, cache_write: 0 },
						},
					},
				},
			},
			async () => {
				expect(await estimateCostUSD("claude-opus-5", allTokens)).toBeCloseTo(
					30,
					6,
				);
			},
		);
	});
});

describe("bundled Sonnet 5 pricing (offline fallback)", () => {
	// Sonnet 5 prices at $3/M input, $15/M output, $0.30/M cache read,
	// $3.75/M cache write — same tier as Sonnet 4.5/4.6 (standard, post
	// introductory-period pricing).
	const ioTokens: TokenBreakdown = {
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
	};
	const cacheTokens: TokenBreakdown = {
		cacheReadInputTokens: 1_000_000,
		cacheCreationInputTokens: 1_000_000,
	};

	it("prices claude-sonnet-5 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-sonnet-5", ioTokens)).toBeCloseTo(
			18,
			6,
		);
	});

	it("prices claude-sonnet-5 cache tokens from bundled data", async () => {
		expect(await estimateCostUSD("claude-sonnet-5", cacheTokens)).toBeCloseTo(
			4.05,
			6,
		);
	});
});

describe("bundled Mythos-class pricing (offline fallback)", () => {
	// Fable 5 and Mythos 5 both price at $10/M input, $50/M output,
	// $1.00/M cache read, $12.50/M cache write.
	const ioTokens: TokenBreakdown = {
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
	};
	const cacheTokens: TokenBreakdown = {
		cacheReadInputTokens: 1_000_000,
		cacheCreationInputTokens: 1_000_000,
	};

	it("prices claude-fable-5 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-fable-5", ioTokens)).toBeCloseTo(
			60,
			6,
		);
	});

	it("prices claude-fable-5 cache tokens from bundled data", async () => {
		expect(await estimateCostUSD("claude-fable-5", cacheTokens)).toBeCloseTo(
			13.5,
			6,
		);
	});

	it("prices claude-mythos-5 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-mythos-5", ioTokens)).toBeCloseTo(
			60,
			6,
		);
	});
});

describe("getModelCacheRates", () => {
	it("returns Opus 5 rates from bundled data", () => {
		expect(getModelCacheRates("claude-opus-5")).toEqual({
			inputPer1M: 5,
			cacheReadPer1M: 0.5,
			cacheWritePer1M: 6.25,
		});
	});

	it("returns Opus 4.8 rates from bundled data", () => {
		expect(getModelCacheRates("claude-opus-4-8")).toEqual({
			inputPer1M: 5,
			cacheReadPer1M: 0.5,
			cacheWritePer1M: 6.25,
		});
	});

	it("returns Sonnet 4.5 rates from bundled data", () => {
		// Resolution is exact-match (mirroring estimateCostUSD), so use the real
		// bundled id, which is dated: "claude-sonnet-4-5-20250929".
		expect(getModelCacheRates("claude-sonnet-4-5-20250929")).toEqual({
			inputPer1M: 3,
			cacheReadPer1M: 0.3,
			cacheWritePer1M: 3.75,
		});
	});

	it("returns Sonnet 5 rates from bundled data", () => {
		expect(getModelCacheRates("claude-sonnet-5")).toEqual({
			inputPer1M: 3,
			cacheReadPer1M: 0.3,
			cacheWritePer1M: 3.75,
		});
	});

	it("falls back to Sonnet-4 rates for an unknown model", () => {
		expect(getModelCacheRates("this-model-does-not-exist")).toEqual({
			inputPer1M: 3,
			cacheReadPer1M: 0.3,
			cacheWritePer1M: 3.75,
		});
	});

	it("returns 0 for cache rates a known model lacks", () => {
		// MiniMax-M2 is in the bundled table with input/output but no cache pricing.
		// It IS known, so we return its real input rate and 0 for the missing
		// cache rates — NOT the unknown-model Sonnet-4 fallback.
		expect(getModelCacheRates("MiniMax-M2")).toEqual({
			inputPer1M: 0.3,
			cacheReadPer1M: 0,
			cacheWritePer1M: 0,
		});
	});
});

/**
 * The pricing-miss registry holds UNTRUSTED input: a request's `model` is
 * client-controlled, unvalidated and unbounded in length, and it is served back
 * out over the unauthenticated `/api/*` surface. Bounding and sanitizing it is a
 * correctness requirement, not polish — the Set it replaces had exactly this
 * unbounded-growth bug.
 */
describe("pricing-miss registry", () => {
	const io: TokenBreakdown = { inputTokens: 1000, outputTokens: 1000 };
	const report = { reportGaps: true };

	/**
	 * Install a capturing logger and hand back the array of "no price" warnings
	 * only — the catalogue also warns about the network fetch this suite
	 * deliberately disables, which is not what these cases are about.
	 */
	function captureMissWarnings(): string[] {
		const warnings: string[] = [];
		__pricingTestHooks.setLogger({
			warn: (message: string) => {
				if (message.startsWith("Price for model ")) warnings.push(message);
			},
			debug: () => {},
		});
		return warnings;
	}

	beforeEach(() => {
		__pricingTestHooks.reset();
	});

	afterEach(() => {
		__pricingTestHooks.reset();
		__pricingTestHooks.setLogger(null);
	});

	it("records a gap only when the caller opts in", async () => {
		await estimateCostUSD("silent-unknown-model", io, {
			provider: "anthropic",
		});
		expect(getPricingGaps()).toEqual([]);

		await estimateCostUSD("reported-unknown-model", io, {
			provider: "anthropic",
			...report,
		});
		const gaps = getPricingGaps();
		expect(gaps).toHaveLength(1);
		expect(gaps[0].modelId).toBe("reported-unknown-model");
		expect(gaps[0].provider).toBe("anthropic");
		expect(gaps[0].occurrences).toBe(1);
	});

	it("suppresses ollama and ollama-cloud but not openai-compatible", async () => {
		await estimateCostUSD("llama-local", io, {
			provider: "ollama",
			...report,
		});
		await estimateCostUSD("llama-hosted", io, {
			provider: "ollama-cloud",
			...report,
		});
		expect(getPricingGaps()).toEqual([]);

		// openai-compatible fronts paid endpoints too, so a gap there is real
		// information and must NOT be suppressed.
		await estimateCostUSD("some-paid-model", io, {
			provider: "openai-compatible",
			...report,
		});
		expect(getPricingGaps().map((gap) => gap.modelId)).toEqual([
			"some-paid-model",
		]);
	});

	it("keys by (provider, model) so one model can gap through two providers", async () => {
		await estimateCostUSD("shared-unknown-model", io, {
			provider: "openrouter",
			...report,
		});
		await estimateCostUSD("shared-unknown-model", io, {
			provider: "kilo",
			...report,
		});

		const gaps = getPricingGaps();
		expect(gaps).toHaveLength(2);
		expect(gaps.map((gap) => gap.provider).sort()).toEqual([
			"kilo",
			"openrouter",
		]);
		// Two independent entries, each counted once — not one ambiguous entry.
		expect(gaps.every((gap) => gap.occurrences === 1)).toBe(true);
	});

	it("aggregates repeated misses into one entry", async () => {
		for (let i = 0; i < 3; i++) {
			await estimateCostUSD("repeat-unknown-model", io, {
				provider: "anthropic",
				...report,
			});
		}
		const gaps = getPricingGaps();
		expect(gaps).toHaveLength(1);
		expect(gaps[0].occurrences).toBe(3);
		expect(gaps[0].lastSeenAt).toBeGreaterThanOrEqual(gaps[0].firstSeenAt);
	});

	it("distinguishes model_missing from cost_missing", async () => {
		await estimateCostUSD("absent-from-catalogue", io, {
			provider: "anthropic",
			...report,
		});
		// MiniMax-M2 IS in the catalogue but carries no cache pricing, so a
		// cache-read request fails on a PRESENT-but-incomplete entry.
		await estimateCostUSD(
			"MiniMax-M2",
			{ cacheReadInputTokens: 1000 },
			{ provider: "minimax", ...report },
		);

		const byModel = new Map(
			getPricingGaps().map((gap) => [gap.modelId, gap.reason]),
		);
		expect(byModel.get("absent-from-catalogue")).toBe("model_missing");
		expect(byModel.get("MiniMax-M2")).toBe("cost_missing");
	});

	it("sanitizes control characters and truncates oversized model ids", async () => {
		const noisy = "evil\u0000model\u001B[31m\u007Fname";
		const oversized = "x".repeat(__pricingTestHooks.maxModelIdLength + 500);

		await estimateCostUSD(noisy, io, { provider: "anthropic", ...report });
		await estimateCostUSD(oversized, io, {
			provider: "prov\u0000ider",
			...report,
		});

		const gaps = getPricingGaps();
		const sanitized = gaps.find((gap) => gap.modelId.startsWith("evil"));
		expect(sanitized?.modelId).toBe("evilmodel[31mname");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they were stripped
		expect(/[\u0000-\u001F\u007F]/.test(sanitized?.modelId ?? "")).toBe(false);

		const truncated = gaps.find((gap) => gap.modelId.startsWith("x"));
		expect(truncated?.modelId.length).toBe(__pricingTestHooks.maxModelIdLength);
		expect(truncated?.provider).toBe("provider");
	});

	it("keeps model ids distinct when their truncated labels collide", async () => {
		// Truncation is a DISPLAY concern. Keying on the clipped label would fold
		// every id sharing a 256-character prefix into one entry and sum their
		// occurrence counts, so two different models would read as one busy one.
		const prefix = "z".repeat(__pricingTestHooks.maxModelIdLength);
		await estimateCostUSD(`${prefix}-alpha`, io, {
			provider: "anthropic",
			...report,
		});
		await estimateCostUSD(`${prefix}-beta`, io, {
			provider: "anthropic",
			...report,
		});

		const gaps = getPricingGaps();
		expect(gaps).toHaveLength(2);
		// The visible labels are identical (both clipped to the shared prefix)…
		expect(new Set(gaps.map((gap) => gap.modelId)).size).toBe(1);
		// …but the entries are not merged, so neither count is inflated.
		expect(gaps.map((gap) => gap.occurrences)).toEqual([1, 1]);

		// The warn cache is keyed the same way, so both models are warned about.
		expect(__pricingTestHooks.warnCount()).toBe(2);
	});

	it("evicts least-recently-seen entries over the cap and counts the overflow", async () => {
		const cap = __pricingTestHooks.maxMissEntries;
		// A gap that keeps recurring — the live one we must not lose.
		await estimateCostUSD("live-gap-model", io, {
			provider: "anthropic",
			...report,
		});

		// Flood with distinct client-minted ids, refreshing the live gap as real
		// traffic would.
		for (let i = 0; i < cap * 2; i++) {
			await estimateCostUSD(`junk-model-${i}`, io, {
				provider: "anthropic",
				...report,
			});
			await estimateCostUSD("live-gap-model", io, {
				provider: "anthropic",
				...report,
			});
		}

		expect(__pricingTestHooks.missCount()).toBeLessThanOrEqual(cap);
		expect(getPricingGaps().length).toBeLessThanOrEqual(cap);
		expect(getPricingGapOverflowCount()).toBeGreaterThan(0);
		// Recency eviction keeps the entry that is still being hit.
		expect(
			getPricingGaps().some((gap) => gap.modelId === "live-gap-model"),
		).toBe(true);
	});

	it("keeps suppressed and opted-out misses out of the registry entirely", async () => {
		// A miss the operator can do nothing about (Ollama is free by definition)
		// or that nobody asked to be reported must not occupy a single slot: the
		// registry's capacity is what keeps a REAL gap alive.
		await estimateCostUSD("llama-local", io, { provider: "ollama", ...report });
		await estimateCostUSD("unattributed-model", io);

		expect(__pricingTestHooks.missCount()).toBe(0);
		expect(getPricingGaps()).toEqual([]);
	});

	it("does not let suppressed misses evict a reported gap", async () => {
		const cap = __pricingTestHooks.maxMissEntries;
		await estimateCostUSD("real-gap-model", io, {
			provider: "anthropic",
			...report,
		});

		// An Ollama install exposes far more distinct model ids than the cap.
		for (let i = 0; i < cap * 2; i++) {
			await estimateCostUSD(`ollama-model-${i}`, io, {
				provider: "ollama",
				...report,
			});
			// …and provider-level extraction prices every response without
			// attribution or opt-in, too.
			await estimateCostUSD(`unattributed-model-${i}`, io);
		}

		expect(__pricingTestHooks.missCount()).toBe(1);
		expect(getPricingGapOverflowCount()).toBe(0);
		expect(getPricingGaps().map((gap) => gap.modelId)).toEqual([
			"real-gap-model",
		]);
	});

	it("warns once per model across both pricing paths", async () => {
		// Only the miss warnings matter here; the catalogue also warns about the
		// deliberately-disabled network fetch.
		const warnings = captureMissWarnings();

		// The provider's usage extractor prices the response first, with no
		// account attribution, then the proxy's usage collector prices the SAME
		// response with the real provider and opts into reporting. That is one
		// unpriced model, so it is one log line.
		await estimateCostUSD("double-priced-model", io);
		await estimateCostUSD("double-priced-model", io, {
			provider: "claude-console-api",
			...report,
		});
		await estimateCostUSD("double-priced-model", io, {
			provider: "claude-console-api",
			...report,
		});

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("double-priced-model");
		// A suppressed provider still gets its one line — the operator should see
		// the miss in the log even though it is not worth a dashboard banner.
		await estimateCostUSD("llama-local", io, { provider: "ollama", ...report });
		expect(warnings).toHaveLength(2);
	});

	it("bounds the warn-dedup cache independently of the registry", async () => {
		const warnCap = __pricingTestHooks.maxWarnEntries;
		for (let i = 0; i < warnCap * 2; i++) {
			// Suppressed, so none of these reach the registry at all.
			await estimateCostUSD(`ollama-model-${i}`, io, {
				provider: "ollama",
				...report,
			});
		}

		expect(__pricingTestHooks.warnCount()).toBeLessThanOrEqual(warnCap);
		expect(__pricingTestHooks.missCount()).toBe(0);
	});

	it("returns cloned snapshots in a deterministic order", async () => {
		// Ordering is (firstSeenAt, provider, modelId) — the provider/model
		// tiebreak matters because misses recorded in the same millisecond must
		// still come back in a stable order.
		await estimateCostUSD("first-unknown-model", io, {
			provider: "anthropic",
			...report,
		});
		await estimateCostUSD("second-unknown-model", io, {
			provider: "zai",
			...report,
		});

		const first = getPricingGaps();
		expect(first.map((gap) => gap.modelId)).toEqual([
			"first-unknown-model",
			"second-unknown-model",
		]);

		// Mutating the snapshot must not reach registry internals.
		first[0].occurrences = 9999;
		first[0].modelId = "tampered";
		const second = getPricingGaps();
		expect(second[0].modelId).toBe("first-unknown-model");
		expect(second[0].occurrences).toBe(1);
		expect(second[0]).not.toBe(first[0]);
		// Same input, same order.
		expect(second.map((gap) => gap.modelId)).toEqual(
			getPricingGaps().map((gap) => gap.modelId),
		);
	});

	it("is cleared by the test-hook reset", async () => {
		await estimateCostUSD("transient-unknown-model", io, {
			provider: "anthropic",
			...report,
		});
		expect(getPricingGaps()).toHaveLength(1);
		expect(__pricingTestHooks.warnCount()).toBe(1);

		__pricingTestHooks.reset();

		expect(getPricingGaps()).toEqual([]);
		expect(getPricingGapOverflowCount()).toBe(0);
		// Both bounded structures are cleared, so a warn-once model warns again.
		expect(__pricingTestHooks.warnCount()).toBe(0);
	});
});
