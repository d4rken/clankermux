import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROVIDER_NAMES,
	type PricingGap,
	type PricingGapReason,
} from "@clankermux/types";
import { TIME_CONSTANTS } from "./constants";
import { CLAUDE_MODEL_IDS, MODEL_DISPLAY_NAMES } from "./models";

export interface TokenBreakdown {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
}

interface ModelCost {
	input: number;
	output: number;
	cache_read?: number;
	cache_write?: number;
}

interface ModelDef {
	id: string;
	name: string;
	cost?: ModelCost;
}

interface ApiResponse {
	[provider: string]: {
		models?: {
			[modelId: string]: ModelDef;
		};
	};
}

// Bundled fallback pricing for Anthropic models (dollars per 1M tokens)
const BUNDLED_PRICING: ApiResponse = {
	anthropic: {
		models: {
			[CLAUDE_MODEL_IDS.HAIKU_4_5]: {
				id: CLAUDE_MODEL_IDS.HAIKU_4_5,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.HAIKU_4_5],
				cost: {
					input: 1,
					output: 5,
					cache_read: 0.1,
					cache_write: 1.25,
				},
			},
			[CLAUDE_MODEL_IDS.SONNET_4]: {
				id: CLAUDE_MODEL_IDS.SONNET_4,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.SONNET_4],
				cost: {
					input: 3,
					output: 15,
					cache_read: 0.3,
					cache_write: 3.75,
				},
			},
			[CLAUDE_MODEL_IDS.SONNET_4_5]: {
				id: CLAUDE_MODEL_IDS.SONNET_4_5,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.SONNET_4_5],
				cost: {
					input: 3,
					output: 15,
					cache_read: 0.3,
					cache_write: 3.75,
				},
			},
			[CLAUDE_MODEL_IDS.SONNET_4_6]: {
				id: CLAUDE_MODEL_IDS.SONNET_4_6,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.SONNET_4_6],
				cost: {
					input: 3,
					output: 15,
					cache_read: 0.3,
					cache_write: 3.75,
				},
			},
			[CLAUDE_MODEL_IDS.SONNET_5]: {
				id: CLAUDE_MODEL_IDS.SONNET_5,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.SONNET_5],
				cost: {
					input: 3,
					output: 15,
					cache_read: 0.3,
					cache_write: 3.75,
				},
			},
			[CLAUDE_MODEL_IDS.OPUS_4]: {
				id: CLAUDE_MODEL_IDS.OPUS_4,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.OPUS_4],
				cost: {
					input: 15,
					output: 75,
					cache_read: 1.5,
					cache_write: 18.75,
				},
			},
			[CLAUDE_MODEL_IDS.OPUS_4_1]: {
				id: CLAUDE_MODEL_IDS.OPUS_4_1,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.OPUS_4_1],
				cost: {
					input: 15,
					output: 75,
					cache_read: 1.5,
					cache_write: 18.75,
				},
			},
			[CLAUDE_MODEL_IDS.OPUS_4_5]: {
				id: CLAUDE_MODEL_IDS.OPUS_4_5,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.OPUS_4_5],
				cost: {
					input: 5,
					output: 25,
					cache_read: 0.5,
					cache_write: 6.25,
				},
			},
			[CLAUDE_MODEL_IDS.OPUS_4_6]: {
				id: CLAUDE_MODEL_IDS.OPUS_4_6,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.OPUS_4_6],
				cost: {
					input: 5,
					output: 25,
					cache_read: 0.5,
					cache_write: 6.25,
				},
			},
			[CLAUDE_MODEL_IDS.OPUS_4_7]: {
				id: CLAUDE_MODEL_IDS.OPUS_4_7,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.OPUS_4_7],
				cost: {
					input: 5,
					output: 25,
					cache_read: 0.5,
					cache_write: 6.25,
				},
			},
			[CLAUDE_MODEL_IDS.OPUS_4_8]: {
				id: CLAUDE_MODEL_IDS.OPUS_4_8,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.OPUS_4_8],
				cost: {
					input: 5,
					output: 25,
					cache_read: 0.5,
					cache_write: 6.25,
				},
			},
			// Opus 5 keeps the Opus 4.5–4.8 tier ($5/$25). The $10/$50 quoted at
			// launch is the "fast mode" premium — a Claude-API-only research
			// preview with no representation in this proxy.
			[CLAUDE_MODEL_IDS.OPUS_5]: {
				id: CLAUDE_MODEL_IDS.OPUS_5,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.OPUS_5],
				cost: {
					input: 5,
					output: 25,
					cache_read: 0.5,
					cache_write: 6.25,
				},
			},
			// Mythos-class models: $10/M input, $50/M output,
			// $1.00/M cache read (0.1x), $12.50/M cache write (1.25x).
			[CLAUDE_MODEL_IDS.FABLE_5]: {
				id: CLAUDE_MODEL_IDS.FABLE_5,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.FABLE_5],
				cost: {
					input: 10,
					output: 50,
					cache_read: 1.0,
					cache_write: 12.5,
				},
			},
			[CLAUDE_MODEL_IDS.MYTHOS_5]: {
				id: CLAUDE_MODEL_IDS.MYTHOS_5,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.MYTHOS_5],
				cost: {
					input: 10,
					output: 50,
					cache_read: 1.0,
					cache_write: 12.5,
				},
			},
		},
	},
};

// Pricing for Zhipu AI models (GLM models)
BUNDLED_PRICING.zai = {
	models: {
		"glm-4.5": {
			id: "glm-4.5",
			name: "GLM-4.5",
			cost: {
				input: 0.6,
				output: 2.2,
				cache_read: 0.11,
				cache_write: 0,
			},
		},
		"glm-4.5-air": {
			id: "glm-4.5-air",
			name: "GLM-4.5-Air",
			cost: {
				input: 0.2,
				output: 1.1,
				cache_read: 0.03,
				cache_write: 0,
			},
		},
		"glm-4.6": {
			id: "glm-4.6",
			name: "GLM-4.6",
			cost: {
				input: 0.6,
				output: 2.2,
				cache_read: 0.11,
				cache_write: 0,
			},
		},
		"glm-4.6-air": {
			id: "glm-4.6-air",
			name: "GLM-4.6-Air",
			cost: {
				input: 0.2,
				output: 1.1,
				cache_read: 0.03,
				cache_write: 0,
			},
		},
	},
};

// Pricing for Minimax models (dollars per 1M tokens)
BUNDLED_PRICING.minimax = {
	models: {
		"MiniMax-M2": {
			id: "MiniMax-M2",
			name: "MiniMax-M2",
			cost: {
				input: 0.3,
				output: 1.2,
				// Cache pricing not available for Minimax models
			},
		},
	},
};

interface Logger {
	warn(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

/** Default models.dev fetch timeout. Kept short so a hung remote never stalls
 * the per-request usage finalizer (which awaits estimateCostUSD). */
const DEFAULT_PRICING_FETCH_TIMEOUT_MS = 4_000;

/** How long a fetched pricing catalogue is treated as fresh before a background
 * refresh is triggered. */
const PRICING_REFRESH_HOURS = 24;

/**
 * Hard cap on distinct (provider, model) REPORTABLE pricing misses held in
 * memory.
 *
 * A request's `model` is client-controlled and never validated, so any caller
 * can mint unlimited distinct model strings that reach the cost estimator. The
 * registry therefore evicts least-recently-seen entries once the cap is
 * reached. A real gap recurs on every affected request, so recency eviction
 * keeps live gaps and drops one-shot junk.
 *
 * Only misses that are actually surfaced by {@link getPricingGaps} occupy this
 * capacity: suppressed providers (Ollama) and calls that never opted into
 * reporting are deliberately kept out, so they cannot evict a genuine finding.
 * Warn de-duplication lives in its own separately-bounded cache.
 */
const MAX_PRICING_MISS_ENTRIES = 128;

/**
 * Hard cap on the warn-de-duplication cache — the bounded replacement for the
 * unbounded `warnedModels` Set. Keyed by MODEL ONLY (no provider) so an unpriced
 * model logs exactly once no matter which of the two pricing paths observed it
 * (a provider's usage extractor prices the response without account
 * attribution, then the proxy's usage collector prices it again with the real
 * provider). Kept separate from the gap registry so warn traffic can never
 * evict a reported gap, and vice versa.
 */
const MAX_PRICING_WARN_ENTRIES = 128;

/** Longest model id retained in the registry; longer ids are truncated. */
const MAX_PRICING_MISS_MODEL_ID_LENGTH = 256;

/** Longest provider name retained in the registry; longer ones are truncated. */
const MAX_PRICING_MISS_PROVIDER_LENGTH = 64;

/** Placeholder for a model id / provider that sanitizes down to nothing. */
const UNKNOWN_PRICING_LABEL = "unknown";

/**
 * Bounded key over the ORIGINAL, untruncated parts.
 *
 * The stored label is sanitized and clipped to 256 characters, so keying on it
 * would merge every model id sharing a 256-character prefix into a single entry
 * — combining the occurrence counts of models that are not the same model. The
 * digest keeps distinct inputs distinct however identical their visible labels
 * end up looking.
 *
 * Two properties this has to hold, because the input is client-controlled and
 * bounding it is exactly what this key exists for:
 *
 *  - **Lossless encoding.** `hash.update(string)` UTF-8-encodes its argument,
 *    and UTF-8 has no encoding for an unpaired surrogate — every lone surrogate
 *    collapses to U+FFFD, so `model-\uD800` and `model-\uD801` would digest
 *    identically and merge into one entry with one warning. The parts are
 *    therefore hashed as raw UTF-16LE code units, which round-trip any JS
 *    string.
 *  - **Full width.** The whole 256-bit digest is kept. A truncated 48-bit key
 *    puts a birthday collision within ~2^24 hashes of anyone who can pick the
 *    `model` field — which is the adversary this bounding exists to contain.
 *    Memory is irrelevant at a 128-entry cap.
 *
 * Each part is length-prefixed (by byte count) so no concatenation of parts can
 * be reproduced by a different split: a client-controlled model id may contain
 * any character, separators included.
 */
function digestKey(...parts: string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		const bytes = Buffer.from(part, "utf16le");
		hash.update(`${bytes.length}:`);
		hash.update(bytes);
	}
	return hash.digest("hex");
}

/**
 * Characters removed from an untrusted label before it is stored, logged, or
 * served over the `/api/*` surface:
 *
 *  - `Cc` — ALL Unicode controls, both the C0 block plus DEL and the C1 block
 *    (U+0080–U+009F). C1 matters as much as C0: U+009B is a single-character
 *    CSI, so a C0-only strip still lets a model id smuggle terminal escape
 *    sequences into console output.
 *  - `Cf` — formatting controls, which include the bidirectional overrides
 *    (U+202E and friends) that can visually reorder a log line or a dashboard
 *    row so it reads as something it is not.
 *  - `Zl`/`Zp` — the line and paragraph separators, which forge a line break in
 *    a log file the same way a raw newline would.
 */
const UNSAFE_LABEL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Strip unsafe characters and bound the length of an untrusted label before it
 * is stored (and later served over the unauthenticated `/api/*` surface).
 */
function sanitizeLabel(value: string | undefined, maxLength: number): string {
	if (!value) return UNKNOWN_PRICING_LABEL;
	const stripped = value.replace(UNSAFE_LABEL_CHARS, "").trim();
	if (stripped.length === 0) return UNKNOWN_PRICING_LABEL;
	return stripped.slice(0, maxLength);
}

/**
 * A pricing-catalogue lookup failure, carrying the reason so the caller does not
 * have to parse an error message to tell "no such model" from "model present but
 * missing a rate".
 */
class PricingLookupError extends Error {
	constructor(
		message: string,
		readonly reason: PricingGapReason,
	) {
		super(message);
		this.name = "PricingLookupError";
	}
}

class PriceCatalogue {
	private static instance: PriceCatalogue;
	private priceData: ApiResponse | null = null;
	private lastFetch = 0;
	/**
	 * Bounded registry of REPORTABLE pricing misses, keyed by the digest of the
	 * ORIGINAL `(provider, modelId)` pair. Capped, holds untrusted ids only after
	 * sanitization,
	 * and aggregates occurrences so the misses can be surfaced by
	 * {@link getGaps}.
	 *
	 * Only reportable misses are inserted — a suppressed provider or a call that
	 * did not opt in never touches this map, so it cannot spend the capacity a
	 * genuine gap needs.
	 *
	 * Insertion order is maintained as least-recently-seen first (an existing
	 * entry is deleted and re-inserted when touched), so eviction is O(1) on the
	 * first key.
	 */
	private pricingMisses = new Map<string, PricingGap>();
	/**
	 * Bounded warn-de-duplication cache, keyed by MODEL ONLY, so an unpriced
	 * model produces exactly one log line however many pricing paths observe it.
	 * Same least-recently-seen ordering and eviction as the registry above, and
	 * deliberately a separate structure: warn traffic must never evict a reported
	 * gap.
	 */
	private warnedModels = new Set<string>();
	/** How many entries have been evicted by the cap since process start. */
	private pricingMissOverflow = 0;
	/** Whether the cap-exceeded warning has been emitted (log once, not per request). */
	private warnedPricingMissOverflow = false;
	private logger: Logger | null = null;
	/**
	 * Single in-flight remote-load promise so concurrent getPricing() callers
	 * (e.g. many requests finalizing at once on a cold catalogue) share ONE
	 * models.dev fetch instead of each firing their own. Cleared when it settles.
	 */
	private inFlightLoad: Promise<ApiResponse> | null = null;

	private constructor() {}

	setLogger(logger: Logger): void {
		this.logger = logger;
	}

	/**
	 * Test-only: swap in (or clear) the warn logger so a test can capture the
	 * de-duplicated warning without the app's real logger.
	 */
	setLoggerForTests(logger: Logger | null): void {
		this.logger = logger;
	}

	static get(): PriceCatalogue {
		if (!PriceCatalogue.instance) {
			PriceCatalogue.instance = new PriceCatalogue();
		}
		return PriceCatalogue.instance;
	}

	private getCacheDir(): string {
		return join(tmpdir(), "clankermux");
	}

	private getCachePath(): string {
		return join(this.getCacheDir(), "models.dev.json");
	}

	private getCacheDurationMs(): number {
		return PRICING_REFRESH_HOURS * TIME_CONSTANTS.HOUR;
	}

	private async ensureCacheDir(): Promise<void> {
		try {
			await fs.mkdir(this.getCacheDir(), { recursive: true });
		} catch (error) {
			this.logger?.warn("Failed to create cache directory", error);
		}
	}

	/**
	 * Merge remote pricing data with bundled pricing data to ensure all models are included
	 */
	private mergePricingData(
		remote: ApiResponse,
		bundled: ApiResponse,
	): ApiResponse {
		const merged: ApiResponse = {};

		// List of preferred providers in priority order
		const preferredProviders = ["zai", "anthropic"];

		// First, add preferred providers from remote data
		for (const providerName of preferredProviders) {
			if (remote[providerName]) {
				merged[providerName] = remote[providerName];
			}
		}

		// Then add remaining providers from remote data, filtering out problematic ones.
		// Collect filtered names per reason so we can log one summary line each instead
		// of thousands of per-provider DEBUG lines on every pricing load.
		const filteredByPattern: string[] = [];
		const filteredByZeroCost: string[] = [];
		for (const [providerName, providerData] of Object.entries(remote)) {
			if (merged[providerName]) {
				continue;
			}
			const filterReason = this.getProviderFilterReason(
				providerName,
				providerData,
			);
			if (filterReason === "pattern") {
				filteredByPattern.push(providerName);
			} else if (filterReason === "zero-cost") {
				filteredByZeroCost.push(providerName);
			} else {
				merged[providerName] = providerData;
			}
		}
		if (filteredByPattern.length > 0) {
			this.logger?.debug(
				`Filtered out ${filteredByPattern.length} providers due to problematic name patterns: ${filteredByPattern.join(", ")}`,
			);
		}
		if (filteredByZeroCost.length > 0) {
			this.logger?.debug(
				`Filtered out ${filteredByZeroCost.length} providers because all models have zero cost: ${filteredByZeroCost.join(", ")}`,
			);
		}

		// For each provider in bundled pricing, ensure it exists in merged data
		for (const [providerName, providerData] of Object.entries(bundled)) {
			if (!merged[providerName]) {
				this.logger?.warn(
					`Provider "${providerName}" not found in remote pricing, using bundled data`,
				);
				merged[providerName] = providerData;
			} else if (providerData.models) {
				// Merge models from bundled into remote data
				if (!merged[providerName].models) {
					merged[providerName].models = {};
				}

				// Fill gaps in the remote table from bundled data: models the remote
				// omits entirely, plus individual cost fields a present remote entry
				// leaves undefined. Remote values always win where they are defined
				// (including 0) — bundled only backfills holes. Without the per-field
				// backfill, a remote entry that lists a model but omits e.g.
				// cache_read makes getCostRate throw and collapses the ENTIRE request
				// cost to 0 (persisted as NULL), which is exactly what the bundled
				// table exists to prevent.
				let addedModels = 0;
				let backfilledModels = 0;
				for (const [modelId, modelData] of Object.entries(
					providerData.models,
				)) {
					const existing = merged[providerName].models?.[modelId];
					if (!existing) {
						merged[providerName].models[modelId] = modelData;
						addedModels++;
						continue;
					}
					if (
						modelData.cost &&
						this.backfillModelCost(existing, modelData.cost)
					) {
						backfilledModels++;
					}
				}

				if (addedModels > 0) {
					this.logger?.debug(
						`Added ${addedModels} missing models for provider "${providerName}" from bundled pricing`,
					);
				}

				if (backfilledModels > 0) {
					this.logger?.debug(
						`Backfilled missing cost fields for ${backfilledModels} models of provider "${providerName}" from bundled pricing`,
					);
				}
			}
		}

		return merged;
	}

	/**
	 * Copy any cost field the remote entry leaves undefined from the bundled
	 * entry. Remote values win wherever they are defined, so a rate the remote
	 * reports as 0 is preserved rather than treated as missing. Returns true when
	 * at least one field was filled in.
	 *
	 * Cache fields are not copied verbatim: they are scaled by the ratio between
	 * the remote input rate and the bundled input rate. If models.dev has moved a
	 * model to another price tier (say input $5 -> $10) the bundled cache rates
	 * belong to the old tier, and mixing them with the authoritative remote input
	 * price would mis-cost every cached request for that model. Scaling preserves
	 * whatever cache-to-input ratio the BUNDLED entry itself encodes, which keeps
	 * this provider-agnostic — mergePricingData also runs for zai/minimax/
	 * openrouter, where Anthropic's 0.1x/1.25x cache ratios do not hold, so
	 * hardcoding those multipliers would corrupt non-Anthropic entries. The
	 * strictly-positive guard means a provider that temporarily zero-rates input
	 * falls back to the bundled absolutes instead of zeroing the cache rates.
	 * input/output are never scaled — a missing one is copied verbatim.
	 *
	 * Both sides are treated as Partial<ModelCost>: the remote table is parsed
	 * JSON, so any field can be absent at runtime regardless of the declared type.
	 */
	private backfillModelCost(
		remoteModel: ModelDef,
		bundledCost: Partial<ModelCost>,
	): boolean {
		if (!remoteModel.cost) {
			remoteModel.cost = { ...bundledCost } as ModelCost;
			return true;
		}

		const cost = remoteModel.cost as Partial<ModelCost>;
		let filled = false;

		// Read the remote input rate BEFORE the backfill below can populate it:
		// only a remote-DEFINED input identifies the tier models.dev put the model
		// on. A backfilled one is the bundled value, whose ratio is 1 anyway.
		const remoteInput = cost.input;
		const bundledInput = bundledCost.input;
		const cacheScale =
			typeof remoteInput === "number" &&
			Number.isFinite(remoteInput) &&
			remoteInput > 0 &&
			typeof bundledInput === "number" &&
			Number.isFinite(bundledInput) &&
			bundledInput > 0
				? remoteInput / bundledInput
				: 1;

		if (cost.input === undefined && bundledCost.input !== undefined) {
			cost.input = bundledCost.input;
			filled = true;
		}
		if (cost.output === undefined && bundledCost.output !== undefined) {
			cost.output = bundledCost.output;
			filled = true;
		}
		if (cost.cache_read === undefined && bundledCost.cache_read !== undefined) {
			cost.cache_read = bundledCost.cache_read * cacheScale;
			filled = true;
		}
		if (
			cost.cache_write === undefined &&
			bundledCost.cache_write !== undefined
		) {
			cost.cache_write = bundledCost.cache_write * cacheScale;
			filled = true;
		}

		return filled;
	}

	/**
	 * Determine whether a provider should be filtered out (e.g. zero-cost
	 * duplicates or coding-plan variants). Returns the filter reason
	 * ("pattern" | "zero-cost"), or null to keep the provider. Callers
	 * aggregate the reasons into summary log lines.
	 */
	private getProviderFilterReason(
		providerName: string,
		providerData: { models?: Record<string, unknown> },
	): "pattern" | "zero-cost" | null {
		// Filter out providers with names that suggest they're coding plans or special variants
		const problematicPatterns = [
			/-coding-plan$/,
			/-special$/,
			/-demo$/,
			/-free$/,
			/-trial$/,
		];

		if (problematicPatterns.some((pattern) => pattern.test(providerName))) {
			return "pattern";
		}

		// Filter out providers that have models with all zero costs
		if (providerData.models) {
			const modelEntries = Object.entries(providerData.models);
			if (modelEntries.length > 0) {
				const allZeroCost = modelEntries.every(([, model]) => {
					if (!model || typeof model !== "object" || !("cost" in model))
						return true;
					const cost = (model as { cost?: unknown }).cost;
					if (!cost || typeof cost !== "object") return true;
					const {
						input = 0,
						output = 0,
						cache_read = 0,
						cache_write = 0,
					} = cost as Record<string, unknown>;
					return (
						input === 0 && output === 0 && cache_read === 0 && cache_write === 0
					);
				});

				if (allZeroCost) {
					return "zero-cost";
				}
			}
		}

		return null;
	}

	private async loadFromCache(): Promise<ApiResponse | null> {
		try {
			const cachePath = this.getCachePath();
			const stats = await fs.stat(cachePath);
			const age = Date.now() - stats.mtime.getTime();

			if (age < this.getCacheDurationMs()) {
				const content = await fs.readFile(cachePath, "utf-8");
				return JSON.parse(content);
			}
		} catch {
			// Cache miss or error - that's ok
		}
		return null;
	}

	private async saveToCache(data: ApiResponse): Promise<void> {
		try {
			await this.ensureCacheDir();
			const cachePath = this.getCachePath();
			await fs.writeFile(cachePath, JSON.stringify(data, null, 2));
		} catch (error) {
			this.logger?.warn("Failed to save pricing cache", error);
		}
	}

	private getFetchTimeoutMs(): number {
		return DEFAULT_PRICING_FETCH_TIMEOUT_MS;
	}

	private async fetchRemote(): Promise<ApiResponse | null> {
		// Bound the fetch with an AbortController timeout so a hung models.dev
		// connection can never stall the caller (estimateCostUSD must always
		// resolve quickly — it's awaited on the per-request usage finalize path).
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			this.getFetchTimeoutMs(),
		);
		try {
			const response = await fetch("https://models.dev/api.json", {
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
			const data = await response.json();
			await this.saveToCache(data);
			return data;
		} catch (error) {
			this.logger?.warn("Failed to fetch pricing data", error);
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Deep copy of the bundled fallback table (never mutate the shared const). */
	private cloneBundled(): ApiResponse {
		return structuredClone
			? structuredClone(BUNDLED_PRICING)
			: (JSON.parse(JSON.stringify(BUNDLED_PRICING)) as ApiResponse);
	}

	/**
	 * Resolve the full pricing table from remote (bounded) or disk cache, merged
	 * with bundled; falls back to bundled-only. De-duped behind a single
	 * in-flight promise so concurrent cold callers share one fetch.
	 */
	private loadPricing(): Promise<ApiResponse> {
		if (this.inFlightLoad) return this.inFlightLoad;
		const load = (async () => {
			let data = await this.fetchRemote();
			if (!data) {
				data = await this.loadFromCache();
			}
			if (data) {
				data = this.mergePricingData(data, BUNDLED_PRICING);
			} else {
				data = this.cloneBundled();
			}
			this.priceData = data;
			this.lastFetch = Date.now();
			return data;
		})().finally(() => {
			this.inFlightLoad = null;
		});
		this.inFlightLoad = load;
		return load;
	}

	async getPricing(): Promise<ApiResponse> {
		// Fresh cached data → return immediately.
		if (
			this.priceData &&
			Date.now() - this.lastFetch < this.getCacheDurationMs()
		) {
			return this.priceData;
		}

		// Cold start: seed priceData synchronously with the bundled table and
		// kick off the (de-duped, timeout-bounded) remote+disk load in the
		// BACKGROUND. estimateCostUSD therefore always resolves immediately from
		// at least the bundled prices and never hangs on a slow models.dev. The
		// background load replaces priceData with the richer merged table when it
		// lands, so subsequent calls get full coverage. Errors are swallowed
		// (loadPricing already falls back to bundled).
		if (!this.priceData) {
			this.priceData = this.cloneBundled();
			this.lastFetch = Date.now();
			void this.loadPricing().catch(() => undefined);
			return this.priceData;
		}

		// Stale (TTL elapsed) but we still have a table: refresh in the background
		// and return the existing data right away.
		void this.loadPricing().catch(() => undefined);
		return this.priceData;
	}

	/**
	 * Test-only: clear cached pricing + in-flight load so a test can exercise the
	 * cold-start path deterministically. Not part of the public runtime surface.
	 */
	resetForTests(): void {
		this.priceData = null;
		this.lastFetch = 0;
		this.inFlightLoad = null;
		this.pricingMisses.clear();
		this.warnedModels.clear();
		this.pricingMissOverflow = 0;
		this.warnedPricingMissOverflow = false;
	}

	/** Test-only: size of the reported-gap registry. */
	getMissCountForTests(): number {
		return this.pricingMisses.size;
	}

	/** Test-only: size of the warn-de-duplication cache. */
	getWarnCountForTests(): number {
		return this.warnedModels.size;
	}

	/** Test-only: is a background remote load currently in flight? */
	hasInFlightLoadForTests(): boolean {
		return this.inFlightLoad !== null;
	}

	/** Test-only: invoke the de-duped loader directly. */
	loadPricingForTests(): Promise<ApiResponse> {
		return this.loadPricing();
	}

	/**
	 * Record a pricing-catalogue miss for `(provider, modelId)`.
	 *
	 * Two independent, independently-bounded effects:
	 *
	 *  - the model is warned about at most once (model-keyed cache), however many
	 *    pricing paths priced the same response; and
	 *  - the miss enters the reported-gap registry ONLY when `report` is true —
	 *    i.e. the caller opted in via `estimateCostUSD`'s `reportGaps` flag AND
	 *    the provider is not one whose free models make a gap expected. A
	 *    suppressed or unattributed miss must not consume registry capacity,
	 *    because that capacity is what keeps a genuine gap alive.
	 */
	recordMiss(opts: {
		modelId: string;
		provider?: string;
		reason: PricingGapReason;
		report: boolean;
		now?: number;
	}): void {
		const modelId = sanitizeLabel(
			opts.modelId,
			MAX_PRICING_MISS_MODEL_ID_LENGTH,
		);
		const provider = sanitizeLabel(
			opts.provider,
			MAX_PRICING_MISS_PROVIDER_LENGTH,
		);

		this.warnOnce(digestKey(opts.modelId), modelId, provider, opts.reason);

		if (!opts.report) return;

		// Keyed on the ORIGINAL pair, not the display labels: two model ids that
		// share their first 256 characters must stay two entries.
		const key = digestKey(opts.provider ?? "", opts.modelId);
		const now = opts.now ?? Date.now();

		const existing = this.pricingMisses.get(key);
		if (existing) {
			existing.occurrences++;
			existing.lastSeenAt = now;
			// The latest observation wins: a model that was absent and is now
			// present-but-incomplete should report the failure it fails with today.
			existing.reason = opts.reason;
			// Re-insert to move the entry to the most-recently-seen end.
			this.pricingMisses.delete(key);
			this.pricingMisses.set(key, existing);
			return;
		}

		this.pricingMisses.set(key, {
			modelId,
			provider,
			reason: opts.reason,
			occurrences: 1,
			firstSeenAt: now,
			lastSeenAt: now,
		});
		this.evictOverflowingMisses();
	}

	/**
	 * Log the "no price" warning at most once per model, then keep the cache
	 * bounded by dropping the least-recently-warned entry. Model-keyed (not
	 * provider-keyed) so the provider extractor and the usage collector, which
	 * price the same response with different attribution, do not each log a line.
	 *
	 * `key` is the digest of the ORIGINAL model id; `modelId`/`provider` are the
	 * sanitized labels used for display only.
	 *
	 * Everything interpolated into the line is bounded: the two sanitized labels
	 * and the typed reason. The lookup error's message is deliberately NOT
	 * logged — it embeds the raw model id, which would smuggle the untruncated,
	 * unsanitized client string straight past both the length cap and the
	 * control-character strip.
	 */
	private warnOnce(
		key: string,
		modelId: string,
		provider: string,
		reason: PricingGapReason,
	): void {
		if (this.warnedModels.has(key)) {
			// Re-insert to move the entry to the most-recently-warned end.
			this.warnedModels.delete(key);
			this.warnedModels.add(key);
			return;
		}
		this.warnedModels.add(key);
		while (this.warnedModels.size > MAX_PRICING_WARN_ENTRIES) {
			const oldest = this.warnedModels.values().next();
			if (oldest.done) break;
			this.warnedModels.delete(oldest.value);
		}
		this.logger?.warn(
			`Price for model "${modelId}" (provider "${provider}") not found - cost set to 0 (reason: ${reason})`,
		);
	}

	/** Drop least-recently-seen entries until the registry is back under the cap. */
	private evictOverflowingMisses(): void {
		while (this.pricingMisses.size > MAX_PRICING_MISS_ENTRIES) {
			const oldest = this.pricingMisses.keys().next();
			if (oldest.done) return;
			this.pricingMisses.delete(oldest.value);
			this.pricingMissOverflow++;
		}
		if (this.pricingMissOverflow > 0 && !this.warnedPricingMissOverflow) {
			this.warnedPricingMissOverflow = true;
			this.logger?.warn(
				`Pricing-miss registry exceeded ${MAX_PRICING_MISS_ENTRIES} entries; ` +
					`least-recently-seen entries are being evicted (unknown model ids are client-controlled)`,
			);
		}
	}

	/**
	 * Cloned snapshots of the reported misses, in a deterministic order (oldest
	 * first, then provider, then model id). Never hands out registry internals.
	 * Every entry in the registry is reportable by construction — suppressed and
	 * opted-out misses were never inserted.
	 */
	getGaps(): PricingGap[] {
		const gaps: PricingGap[] = [];
		for (const entry of this.pricingMisses.values()) {
			gaps.push({
				modelId: entry.modelId,
				provider: entry.provider,
				reason: entry.reason,
				occurrences: entry.occurrences,
				firstSeenAt: entry.firstSeenAt,
				lastSeenAt: entry.lastSeenAt,
			});
		}
		return gaps.sort(
			(a, b) =>
				a.firstSeenAt - b.firstSeenAt ||
				a.provider.localeCompare(b.provider) ||
				a.modelId.localeCompare(b.modelId),
		);
	}

	/** How many registry entries the cap has evicted since process start. */
	getGapOverflowCount(): number {
		return this.pricingMissOverflow;
	}
}

/**
 * Set the logger for pricing warnings
 */
export function setPricingLogger(logger: Logger): void {
	PriceCatalogue.get().setLogger(logger);
}

/**
 * Test-only handle onto the pricing singleton. Lets tests reset cached state
 * (the reported-gap registry and the warn-de-duplication cache), swap the warn
 * logger, and inspect the in-flight load.
 *
 * It is exported from the package barrel because cross-package tests (proxy,
 * providers) price responses through the real singleton and need to reset it
 * between cases — so `reset()` is reachable at runtime. The underscore prefix
 * marks it as private API: nothing on the request path may call it, and there is
 * no other way to clear recorded gaps.
 */
export const __pricingTestHooks = {
	reset(): void {
		PriceCatalogue.get().resetForTests();
	},
	/** Number of reported gaps currently held by the bounded registry. */
	missCount(): number {
		return PriceCatalogue.get().getMissCountForTests();
	},
	/** Number of models currently held by the bounded warn-dedup cache. */
	warnCount(): number {
		return PriceCatalogue.get().getWarnCountForTests();
	},
	/** Swap in a capturing logger (or `null` to silence pricing warnings). */
	setLogger(logger: Logger | null): void {
		PriceCatalogue.get().setLoggerForTests(logger);
	},
	maxMissEntries: MAX_PRICING_MISS_ENTRIES,
	maxWarnEntries: MAX_PRICING_WARN_ENTRIES,
	maxModelIdLength: MAX_PRICING_MISS_MODEL_ID_LENGTH,
	hasInFlightLoad(): boolean {
		return PriceCatalogue.get().hasInFlightLoadForTests();
	},
	getPricing(): Promise<unknown> {
		return PriceCatalogue.get().getPricing();
	},
	loadPricing(): Promise<unknown> {
		return PriceCatalogue.get().loadPricingForTests();
	},
};

/**
 * Resolve a model id to its bundled ModelCost entry, synchronously, by searching
 * every provider in BUNDLED_PRICING for an exact id match. This mirrors the exact
 * lookup `getCostRate` uses (`provider.models?.[modelId]`) — no normalization,
 * family matching, or case folding — so callers resolve models identically.
 * Returns null when the id is not in the bundled table.
 */
function resolveBundledCost(modelId: string): ModelCost | null {
	for (const provider of Object.values(BUNDLED_PRICING)) {
		const model = provider.models?.[modelId];
		if (model?.cost) {
			return model.cost;
		}
	}
	return null;
}

/**
 * Get the per-1M-token input and cache rates for a model, synchronously, from the
 * in-process BUNDLED_PRICING table (NOT the async remote catalogue).
 *
 * For a known model, returns its real input rate and its cache rates, using 0 for
 * any cache rate the model's ModelCost omits (e.g. MiniMax-M2 has no cache pricing
 * — it is known, so we report 0 rather than the unknown-model fallback).
 *
 * For an unknown model, falls back to Sonnet-4 rates. Anthropic's cache ratios are
 * stable across models (cache write ≈ 1.25× input, cache read ≈ 0.1× input), so
 * Sonnet-4's mid-tier rates are a safe default for estimating cache economics.
 */
export function getModelCacheRates(modelId: string): {
	inputPer1M: number;
	cacheReadPer1M: number;
	cacheWritePer1M: number;
} {
	const cost = resolveBundledCost(modelId);
	if (!cost) {
		// Unknown model: Sonnet-4 rates (input 3, cache_read 0.3, cache_write 3.75).
		return { inputPer1M: 3, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 };
	}
	return {
		inputPer1M: cost.input,
		cacheReadPer1M: cost.cache_read ?? 0,
		cacheWritePer1M: cost.cache_write ?? 0,
	};
}

/**
 * Get the cost rate for a specific model and token type
 * @returns Cost in dollars per token (NOT per million)
 * @throws If model or cost type is unknown
 */
async function getCostRate(
	modelId: string,
	kind: "input" | "output" | "cache_read" | "cache_write",
): Promise<number> {
	const catalogue = PriceCatalogue.get();
	const pricing = await catalogue.getPricing();

	// Search all providers for the model
	for (const provider of Object.values(pricing)) {
		if (provider.models?.[modelId]) {
			const model = provider.models[modelId];
			if (!model.cost) {
				throw new PricingLookupError(
					`Model ${modelId} has no cost information`,
					"cost_missing",
				);
			}

			const costKey =
				kind === "cache_read" || kind === "cache_write"
					? kind
					: kind === "input"
						? "input"
						: "output";
			const costPerMillion = model.cost[costKey];

			if (costPerMillion === undefined) {
				throw new PricingLookupError(
					`Model ${modelId} has no ${kind} cost`,
					"cost_missing",
				);
			}

			// Convert from per-million to per-token
			return costPerMillion / 1_000_000;
		}
	}

	throw new PricingLookupError(
		`Model ${modelId} not found in pricing catalogue`,
		"model_missing",
	);
}

/**
 * Optional call-site context for {@link estimateCostUSD}.
 *
 * Reporting is deliberately OPT-IN. The same response is priced more than once
 * on the normal proxy path (a provider's usage extractor and the proxy's usage
 * collector both call this), so a default-on reporter would double-count every
 * miss — and would also report misses from provider-level calls that have no
 * account attribution, defeating the per-provider suppression. Exactly one call
 * site (the proxy usage collector, which owns the persisted `cost_usd`) passes
 * `reportGaps: true`.
 */
export interface PricingEstimateContext {
	/**
	 * Provider the request was actually served by — the ACCOUNT's provider where
	 * available, which is not always the registered provider handling it (e.g.
	 * `claude-console-api` accounts are served by the `anthropic` provider).
	 */
	provider?: string;
	/** Opt in to recording a pricing gap when the lookup fails. Default: false. */
	reportGaps?: boolean;
}

/**
 * Providers whose models are free by definition, so a missing catalogue entry is
 * expected rather than a costing failure worth surfacing. Built from the
 * canonical constants — never string literals, where a typo silently disables
 * suppression.
 *
 * `openai-compatible` is deliberately NOT suppressed: it fronts both free local
 * endpoints and paid ones, so a gap there is real information.
 */
const PRICING_GAP_SUPPRESSED_PROVIDERS: ReadonlySet<string> = new Set<string>([
	PROVIDER_NAMES.OLLAMA,
	PROVIDER_NAMES.OLLAMA_CLOUD,
]);

/**
 * Cloned snapshots of the pricing-catalogue misses observed since process start
 * (cumulative — an entry is never retracted, because a later successful
 * input-only estimate does not prove the missing cache rate has appeared).
 */
export function getPricingGaps(): PricingGap[] {
	return PriceCatalogue.get().getGaps();
}

/**
 * How many pricing-miss entries the registry cap has evicted since process
 * start. Non-zero means unknown model ids outnumbered the cap — the gap list is
 * a recent sample rather than the complete set.
 */
export function getPricingGapOverflowCount(): number {
	return PriceCatalogue.get().getGapOverflowCount();
}

/**
 * Estimate the total cost in USD for a request based on token counts
 * @returns Cost in dollars (NOT per million)
 */
export async function estimateCostUSD(
	modelId: string,
	tokens: TokenBreakdown,
	context?: PricingEstimateContext,
): Promise<number> {
	const catalogue = PriceCatalogue.get();

	try {
		let totalCost = 0;

		if (tokens.inputTokens) {
			const rate = await getCostRate(modelId, "input");
			totalCost += tokens.inputTokens * rate;
		}

		if (tokens.outputTokens) {
			const rate = await getCostRate(modelId, "output");
			totalCost += tokens.outputTokens * rate;
		}

		if (tokens.cacheReadInputTokens) {
			const rate = await getCostRate(modelId, "cache_read");
			totalCost += tokens.cacheReadInputTokens * rate;
		}

		if (tokens.cacheCreationInputTokens) {
			const rate = await getCostRate(modelId, "cache_write");
			totalCost += tokens.cacheCreationInputTokens * rate;
		}

		return totalCost;
	} catch (error) {
		const provider = context?.provider;
		catalogue.recordMiss({
			modelId,
			provider,
			// Anything that isn't a typed lookup failure is treated as a missing
			// model: the remediation wording covers both ("add or complete").
			reason:
				error instanceof PricingLookupError ? error.reason : "model_missing",
			report:
				context?.reportGaps === true &&
				!(
					provider !== undefined &&
					PRICING_GAP_SUPPRESSED_PROVIDERS.has(provider)
				),
		});
		return 0;
	}
}
