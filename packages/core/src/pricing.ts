import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	PROVIDER_NAMES,
	type PricingGap,
	type PricingGapReason,
} from "@clankermux/types";
import { TIME_CONSTANTS } from "./constants";
import {
	CLAUDE_MODEL_IDS,
	MODEL_DISPLAY_NAMES,
	stripDatedModelSuffix,
} from "./models";

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

/**
 * Pricing for the Codex-served OpenAI models (dollars per 1M tokens).
 *
 * Scope is exactly the slug set in `MODEL_CONTEXT_WINDOWS` (model-mappings.ts) —
 * the models a Codex account can actually be routed to. A test asserts the two
 * lists stay in lockstep, so a new routable slug fails CI until it is priced
 * here. The keys are string literals rather than an import: pricing.ts must not
 * depend on model-mappings.ts, which builds a Logger at import time.
 *
 * Every rate is a VERBATIM snapshot of the models.dev base tier, not an
 * independent estimate. That is deliberate: bundled values only ever fill holes
 * (mergePricingData backfills per field, remote wins wherever it is defined), so
 * a bundled number that disagreed with remote would be a silent second opinion
 * that surfaces only when the network is down. Mirroring makes the merge a
 * no-op against a live catalogue.
 *
 * `cache_write` is omitted wherever models.dev omits it. Codex uses an automatic
 * prompt cache and never reports cache-creation tokens, so `estimateCostUSD`
 * never asks for that rate — inventing one would be an unverifiable price on a
 * bucket that is always zero.
 *
 * models.dev also carries a >272K-context tier (roughly 2x) for these models.
 * the lookup reads only the base rates — for every provider, not just this one —
 * so requests above that threshold are undercharged. Pre-existing behaviour,
 * unchanged here.
 *
 * Note these entries are now also visible to the synchronous bundled-only
 * lookups (`resolveBundledCost` / `getModelCacheRates`). That is inert today:
 * the only caller is the cache keep-alive, which `isBridgeableProvider` gates to
 * Anthropic accounts.
 */
BUNDLED_PRICING.openai = {
	models: {
		"gpt-5.6-sol": {
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			cost: {
				input: 5,
				output: 30,
				cache_read: 0.5,
				cache_write: 6.25,
			},
		},
		"gpt-5.6-terra": {
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			cost: {
				input: 2.5,
				output: 15,
				cache_read: 0.25,
				cache_write: 3.125,
			},
		},
		"gpt-5.6-luna": {
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			cost: {
				input: 1,
				output: 6,
				cache_read: 0.1,
				cache_write: 1.25,
			},
		},
		"gpt-5.5": {
			id: "gpt-5.5",
			name: "GPT-5.5",
			cost: {
				input: 5,
				output: 30,
				cache_read: 0.5,
			},
		},
		"gpt-5.4": {
			id: "gpt-5.4",
			name: "GPT-5.4",
			cost: {
				input: 2.5,
				output: 15,
				cache_read: 0.25,
			},
		},
		"gpt-5.4-mini": {
			id: "gpt-5.4-mini",
			name: "GPT-5.4 mini",
			cost: {
				input: 0.75,
				output: 4.5,
				cache_read: 0.075,
			},
		},
		"gpt-5.3-codex-spark": {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			cost: {
				input: 1.75,
				output: 14,
				cache_read: 0.175,
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
 * Hard ceiling on how long a pricing lookup will wait for an in-flight
 * catalogue load before pricing from whatever is already published.
 *
 * The load's AbortController bounds the network call, but not the snapshot
 * `stat`/read/write around it — and the snapshot lives under the home
 * directory, which can be a slow or wedged network mount. Comfortably above the
 * 4s fetch timeout so a normal cold load is never cut short; its only job is to
 * stop a stuck filesystem from parking usage finalizers forever.
 */
const MAX_CATALOGUE_WAIT_MS = 6_000;

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
 * model logs exactly once however many callers price it, and once per model
 * rather than once per affected request. Kept separate from the gap registry so
 * warn traffic can never evict a reported gap, and vice versa.
 */
const MAX_PRICING_WARN_ENTRIES = 128;

/** Longest model id retained in the registry; longer ids are truncated. */
const MAX_PRICING_MISS_MODEL_ID_LENGTH = 256;

/** Longest provider name retained in the registry; longer ones are truncated. */
const MAX_PRICING_MISS_PROVIDER_LENGTH = 64;

/** Placeholder for a model id / provider that sanitizes down to nothing. */
const UNKNOWN_PRICING_LABEL = "unknown";

/**
 * Hex characters of the entry digest exposed as the human-comparable
 * fingerprint. 16 hex chars (64 bits) is short enough to read off a dashboard
 * row and long enough that two rows an operator is comparing will not tie.
 *
 * It is carried in its OWN field, never appended into a label: the label is
 * client-controlled, so a suffix inside it can simply be typed by the client.
 * Nothing is ever keyed on the fingerprint — that is the FULL digest.
 */
const PRICING_MISS_FINGERPRINT_LENGTH = 16;

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
 *
 * The result is a DISPLAY label and nothing more. Cleaning and clipping can cost
 * it its uniqueness — two different inputs can reduce to the same text — but
 * that is not repaired here by decorating the label: what tells two entries
 * apart is the separately-carried digest (`key`) and its short `fingerprint`,
 * neither of which the client can write.
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

/**
 * Does this model entry carry at least one rate this codebase can charge — one
 * of the four known keys, holding a finite non-negative number?
 *
 * "Any numeric property" would not do: it accepts `Infinity`, and it accepts
 * unrelated fields such as a context size, neither of which prices anything.
 */
function hasUsableRate(model: unknown): boolean {
	if (!model || typeof model !== "object") return false;
	const cost = (model as { cost?: unknown }).cost as
		| Record<string, unknown>
		| undefined;
	if (!cost || typeof cost !== "object") return false;
	return COST_KINDS.some((kind) => {
		const rate = cost[kind];
		return typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
	});
}

/**
 * Accept a parsed catalogue only if it can actually price something — at least
 * one provider carrying at least one model with at least one usable rate.
 *
 * Both the network response and the disk snapshot are unvalidated JSON, and
 * anything that merges down to exactly the bundled table would otherwise still
 * mark the catalogue "loaded" — the one signal saying the bundled seed has been
 * replaced, which gates both the cold-start wait and the backfill preflight.
 * `{}` is the obvious case, but so are a truncated write, an error page that
 * happened to parse, and a structurally-plausible shape whose model entries are
 * null or priceless. The check is deliberately about usable CONTENT, not shape.
 */
function asUsableCatalogue(parsed: unknown): ApiResponse | null {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	for (const provider of Object.values(parsed as Record<string, unknown>)) {
		if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
			continue;
		}
		const models = (provider as { models?: unknown }).models;
		if (!models || typeof models !== "object" || Array.isArray(models))
			continue;
		for (const model of Object.values(models as Record<string, unknown>)) {
			if (hasUsableRate(model)) return parsed as ApiResponse;
		}
	}
	return null;
}

/** Every model id the bundled fallback table already covers. */
const BUNDLED_MODEL_IDS: ReadonlySet<string> = new Set(
	Object.values(BUNDLED_PRICING).flatMap((provider) =>
		Object.keys(provider.models ?? {}),
	),
);

/**
 * Does a merged table PRICE anything the bundled fallback does not?
 *
 * This is the honest test of "a real catalogue is loaded". Validating the raw
 * response is not enough on either axis: the merge drops whole providers
 * (coding-plan name patterns, all-zero-cost tables), so a response can pass
 * validation and still merge down to exactly the bundled seed; and validation is
 * satisfied by ANY one usable entry, which a bundled id can supply while every
 * unknown id in the table is priceless. Both are asked here instead — an unknown
 * model id AND a rate on it. Short-circuits on the first, which a genuine
 * catalogue hits almost immediately.
 */
function addsCoverageBeyondBundled(merged: ApiResponse): boolean {
	for (const provider of Object.values(merged)) {
		for (const [modelId, model] of Object.entries(provider.models ?? {})) {
			if (!BUNDLED_MODEL_IDS.has(modelId) && hasUsableRate(model)) return true;
		}
	}
	return false;
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
	/**
	 * Single in-flight BACKGROUND refresh promise, kept separate from
	 * {@link inFlightLoad} so a refresh can never be mistaken for the initial
	 * load that {@link awaitInFlightLoad} waits on.
	 */
	private inFlightRefresh: Promise<void> | null = null;
	/**
	 * Whether a real catalogue (remote or disk snapshot) has replaced the bundled
	 * cold-start seed.
	 *
	 * `priceData !== null` cannot answer this: getPricing() publishes the bundled
	 * table synchronously so the per-request finalizer never blocks, which means
	 * for the first few hundred milliseconds of a process "the catalogue" is 26
	 * models and every non-bundled lookup legitimately misses. Requests that
	 * finalized in that window were recorded with cost NULL and raised a pricing
	 * gap for a model that was in the catalogue all along.
	 */
	private catalogueLoaded = false;
	/**
	 * Whether the loaded catalogue came from a disk snapshot past its refresh
	 * window because the remote was unreachable. Live pricing accepts that
	 * happily — an old real catalogue beats the bundled fallback — but a tool
	 * writing durable prices deserves to know before it commits them.
	 */
	private catalogueStale = false;

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

	/**
	 * Directory holding the models.dev catalogue snapshot.
	 *
	 * Deliberately NOT the OS temp dir. /tmp is tmpfs on a normal Linux install,
	 * so the snapshot was destroyed on every reboot and the first start afterwards
	 * had to re-download the full catalogue (~5MB) over the network before any
	 * non-bundled model could be priced. A cache that survives reboots is what
	 * makes the cache-first path in {@link loadPricing} actually cheap.
	 *
	 * The platform rule mirrors `getPlatformConfigDir()` in @clankermux/config.
	 * It is restated rather than imported because @clankermux/config depends on
	 * @clankermux/core — importing it here would close a cycle.
	 *
	 * Read off the `process` global rather than imported from `node:process` or
	 * `node:os`. This module is bundled into the DASHBOARD, whose browser target
	 * has no real Node runtime: `import { platform } from "node:process"` broke
	 * that build outright ("Browser polyfill ... doesn't have a matching export
	 * named platform") and took the service down on its next restart, since the
	 * dashboard build is a systemd ExecStartPre. A property read on a global
	 * gives a bundler nothing to resolve, so it cannot fail that way again.
	 */
	private getCacheDir(): string {
		if (typeof process !== "undefined" && process.platform === "win32") {
			const base =
				process.env.LOCALAPPDATA ??
				process.env.APPDATA ??
				join(homedir(), "AppData", "Local");
			return join(base, "clankermux", "cache");
		}
		const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
		return join(base, "clankermux");
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
				// cache_read makes the rate lookup throw and collapses the ENTIRE
				// request cost to 0 (persisted as NULL), which is exactly what the
				// bundled table exists to prevent. This backfill only reaches an entry
				// under the SAME provider and id: a partial entry under a DIFFERENT
				// provider is deliberately left alone, since preferring some other
				// provider's complete entry would reprice the request off a reseller's
				// list (see selectModelEntry, which only does that for the base slug of
				// a dated snapshot, and only when the rates agree).
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

	/**
	 * Read the catalogue snapshot from disk.
	 *
	 * By default only a snapshot inside the refresh window is returned — that is
	 * the copy {@link loadPricing} is willing to serve requests from without
	 * touching the network. Pass `allowStale` to accept one of any age: an
	 * out-of-date real catalogue still prices thousands of models the 26-model
	 * bundled table has never heard of, so it is strictly better than the bundled
	 * fallback when the remote is unreachable.
	 */
	private async loadFromCache(
		opts: { allowStale?: boolean } = {},
	): Promise<ApiResponse | null> {
		try {
			const cachePath = this.getCachePath();
			const stats = await fs.stat(cachePath);
			const age = Date.now() - stats.mtime.getTime();

			if (opts.allowStale || age < this.getCacheDurationMs()) {
				const content = await fs.readFile(cachePath, "utf-8");
				return asUsableCatalogue(JSON.parse(content));
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
			const data = asUsableCatalogue(await response.json());
			if (!data) {
				throw new Error("models.dev returned no usable model data");
			}
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
	 * Resolve the full pricing table, merged with bundled; falls back to
	 * bundled-only. De-duped behind a single in-flight promise so concurrent cold
	 * callers share one load.
	 *
	 * Cache-first, in this order:
	 *
	 *  1. a disk snapshot inside the refresh window — a local read, no network,
	 *     with a background remote refresh kicked off so freshness is still bound
	 *     by the snapshot's own age rather than by process lifetime;
	 *  2. otherwise the remote fetch (bounded by its own timeout);
	 *  3. otherwise a STALE disk snapshot, which used to be skipped entirely —
	 *     an unreachable remote dropped straight to the 26-model bundled table
	 *     even when a complete, slightly-old catalogue sat on disk;
	 *  4. otherwise bundled-only.
	 *
	 * Steps 1-3 can produce a real catalogue and step 4 cannot, but none of them
	 * SETS `catalogueLoaded` by virtue of having run: the flag is decided by
	 * {@link addsCoverageBeyondBundled} on the merged result, because a response
	 * from any of the first three can still merge down to exactly the bundled
	 * table. That flag is what {@link estimateCostUSD} keys its cold-start retry
	 * on, so it must mean "the bundled seed has been replaced", never "a load
	 * ran".
	 */
	private loadPricing(): Promise<ApiResponse> {
		if (this.inFlightLoad) return this.inFlightLoad;
		const load = (async () => {
			let data = await this.loadFromCache();
			const servedFromFreshCache = data !== null;
			if (!data) {
				data = await this.fetchRemote();
			}
			let servedFromStaleCache = false;
			if (!data) {
				data = await this.loadFromCache({ allowStale: true });
				servedFromStaleCache = data !== null;
			}
			if (data) {
				data = this.mergePricingData(data, BUNDLED_PRICING);
				// Judged on the MERGE RESULT, not on what went in. Provider filtering
				// runs inside the merge (coding-plan name patterns, all-zero-cost
				// providers), so a response whose only usable provider is dropped
				// yields exactly the bundled table — loaded, but with no more coverage
				// than the seed it was supposed to replace.
				this.catalogueLoaded = addsCoverageBeyondBundled(data);
				this.catalogueStale = this.catalogueLoaded && servedFromStaleCache;
			} else {
				data = this.cloneBundled();
				// A refresh that finds nothing usable REPLACES a catalogue that had
				// loaded earlier, so the flag has to come back down with it. Leaving it
				// set would tell estimateCostUSD the bundled seed was already replaced
				// and make the offline backfill preflight a false positive.
				this.catalogueLoaded = false;
				this.catalogueStale = false;
			}
			this.priceData = data;
			this.lastFetch = Date.now();
			// Kick the refresh AFTER priceData is published so the fast path is
			// already serving requests while the network call runs.
			if (servedFromFreshCache) {
				void this.refreshFromRemote();
			}
			return data;
		})().finally(() => {
			this.inFlightLoad = null;
		});
		this.inFlightLoad = load;
		return load;
	}

	/**
	 * Background remote refresh, used when {@link loadPricing} answered from a
	 * fresh disk snapshot. Without it, serving from a nearly-expired snapshot and
	 * then resetting the TTL would let the in-memory catalogue drift up to two
	 * refresh windows behind models.dev.
	 *
	 * Failure is silent and harmless: whatever the snapshot provided stays in
	 * place. Guarded by its own in-flight promise (not `inFlightLoad`) so it can
	 * never be mistaken for the initial load the cold-start retry waits on.
	 */
	private refreshFromRemote(): Promise<void> {
		if (this.inFlightRefresh) return this.inFlightRefresh;
		const refresh = (async () => {
			const remote = await this.fetchRemote();
			if (!remote) return;
			const merged = this.mergePricingData(remote, BUNDLED_PRICING);
			this.priceData = merged;
			this.lastFetch = Date.now();
			this.catalogueLoaded = addsCoverageBeyondBundled(merged);
			this.catalogueStale = false;
		})().finally(() => {
			this.inFlightRefresh = null;
		});
		this.inFlightRefresh = refresh;
		return refresh;
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
	 * Whether a real catalogue has replaced the bundled cold-start seed. A lookup
	 * that fails while this is false may simply be early, not missing.
	 */
	isCatalogueLoaded(): boolean {
		return this.catalogueLoaded;
	}

	/**
	 * Is a catalogue load or background refresh running right now — i.e. is there
	 * anything a failed lookup could usefully wait for? False means the table on
	 * hand is the best that exists, so a miss against it is real.
	 */
	hasPendingCatalogueWork(): boolean {
		return this.inFlightLoad !== null || this.inFlightRefresh !== null;
	}

	/** Did the loaded catalogue come from a snapshot past its refresh window? */
	isCatalogueStale(): boolean {
		return this.catalogueStale;
	}

	/**
	 * Await a catalogue load or background refresh if one is ALREADY running,
	 * then hand back whatever table is current.
	 *
	 * Deliberately never starts one. A lookup miss must not be able to trigger
	 * network traffic: in the degraded state where the first load already
	 * finished without producing a catalogue (remote down, no snapshot on disk),
	 * every subsequent miss would fire its own fetch. In that state there is
	 * genuinely nothing to wait for and the miss is real, so the caller should
	 * record it.
	 *
	 * The background refresh counts too. Serving from a fresh disk snapshot marks
	 * the catalogue loaded, so without this a model that is missing from a
	 * ≤24h-old snapshot but present in the refresh landing right now would still
	 * be recorded unpriced — the original bug in a narrower window.
	 *
	 * Bounded: the load's own 4s abort covers the network, but not the disk reads
	 * and writes around it, and the snapshot now lives under the home directory,
	 * which can be a wedged network mount. On timeout the caller simply prices
	 * from what is already published, which is the pre-existing behaviour.
	 *
	 * `settled` says whether the awaited work actually finished. It is what stops
	 * a caller from waiting the full deadline twice over on one stuck promise, and
	 * what lets a tool writing durable prices tell "nothing left to do" apart from
	 * "gave up while work was still running".
	 */
	async awaitInFlightLoad(): Promise<{
		pricing: ApiResponse;
		settled: boolean;
	}> {
		if (!this.hasPendingCatalogueWork()) {
			return { pricing: this.priceData ?? this.cloneBundled(), settled: true };
		}

		// One stage per call — the initial load if there is one, otherwise the
		// refresh. A load that answered from a disk snapshot starts the refresh as
		// its final act, so a caller still missing its model after the first call
		// can call again to wait out the refresh. Staged rather than chained so the
		// common case (the snapshot had the model) never pays for the network.
		const inFlight: Promise<unknown> =
			this.inFlightLoad ?? (this.inFlightRefresh as Promise<unknown>);

		// A rejection counts as settled: the work is over, just unsuccessfully, and
		// there is nothing further to wait for. Swallowing it here also keeps an
		// internal load error from surfacing as a bogus "model not found".
		const completion = inFlight.then(
			() => true,
			() => true,
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), MAX_CATALOGUE_WAIT_MS);
		});
		let settled: boolean;
		try {
			settled = await Promise.race([completion, deadline]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		return { pricing: this.priceData ?? this.cloneBundled(), settled };
	}

	/**
	 * Test-only: clear cached pricing + in-flight load so a test can exercise the
	 * cold-start path deterministically. Not part of the public runtime surface.
	 */
	resetForTests(): void {
		this.priceData = null;
		this.lastFetch = 0;
		this.inFlightLoad = null;
		this.inFlightRefresh = null;
		this.catalogueLoaded = false;
		this.catalogueStale = false;
		this.pricingMisses.clear();
		this.warnedModels.clear();
		this.pricingMissOverflow = 0;
		this.warnedPricingMissOverflow = false;
	}

	/** Test-only: the resolved catalogue-snapshot directory. */
	getCacheDirForTests(): string {
		return this.getCacheDir();
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
		// Keyed on the ORIGINAL pair, not the display labels: two model ids that
		// share their first 256 characters must stay two entries.
		const key = digestKey(opts.provider ?? "", opts.modelId);
		// Prefix of the same digest — one hash, one identity, two lengths. Derived
		// here (server side) and never from the label, so no model text can forge
		// it.
		const fingerprint = key.slice(0, PRICING_MISS_FINGERPRINT_LENGTH);

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
			key,
			fingerprint,
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
				key: entry.key,
				fingerprint: entry.fingerprint,
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
				a.modelId.localeCompare(b.modelId) ||
				// Last resort: two entries whose labels tie are still two entries, and
				// the order they come back in must not depend on insertion order.
				a.key.localeCompare(b.key),
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
	fingerprintLength: PRICING_MISS_FINGERPRINT_LENGTH,
	hasInFlightLoad(): boolean {
		return PriceCatalogue.get().hasInFlightLoadForTests();
	},
	/** Has a real catalogue replaced the bundled cold-start seed? */
	isCatalogueLoaded(): boolean {
		return PriceCatalogue.get().isCatalogueLoaded();
	},
	/** Directory the catalogue snapshot is read from and written to. */
	cacheDir(): string {
		return PriceCatalogue.get().getCacheDirForTests();
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
 * every provider in BUNDLED_PRICING for an exact id match — no normalization,
 * family matching, or case folding. Returns null when the id is not in the
 * bundled table.
 *
 * This is the EXACT-match step of the async lookup only: {@link selectModelEntry}
 * additionally falls back to the base slug of a dated snapshot. The divergence is inert
 * for the one caller ({@link getModelCacheRates}, whose cache-keepalive callers
 * are gated to Anthropic accounts): Anthropic ids carry an undelimited date
 * (`claude-sonnet-4-20250514`), which is not the `-YYYY-MM-DD` form the fallback
 * recognises, so both paths resolve them identically.
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

/** The four rate kinds a request can be charged for. */
const COST_KINDS = ["input", "output", "cache_read", "cache_write"] as const;
type CostKind = (typeof COST_KINDS)[number];

/**
 * Pick the ONE entry a request is priced from.
 *
 * A `-YYYY-MM-DD` release-date suffix is the only id rewriting allowed:
 * `gpt-5.4-mini-2026-03-17` may resolve through `gpt-5.4-mini`. Codex serves
 * dated snapshots that most catalogues never list, and pricing a snapshot at its
 * base rate is right where the catalogue is silent — the same reasoning, and the
 * same helper, as `resolveModelContextWindow`.
 *
 * Selecting per request rather than per rate is deliberate. A request is charged
 * from a single price list; taking `input` from one provider's entry and
 * `cache_read` from another's would silently blend two price tiers into a number
 * that matches no real bill.
 *
 * Among EXACT id matches the first one wins, unchanged from before. It is
 * tempting to prefer whichever entry covers the most rates — a partial entry
 * otherwise voids the whole request — but across resellers of the same id that
 * trades a visible failure for a silent, badly wrong number. models.dev lists
 * `gemini-3-pro-image-preview` at $2/$120 from Google with no cache_read and at
 * $2/$12 from a reseller WITH cache_read: a coverage-first rule would move every
 * cached request onto an output rate ten times too low. A NULL cost is loud (it
 * raises the unpriced-model banner); a 10x-wrong cost is not.
 *
 * The dated-snapshot fallback is the ONE place coverage decides, and only in one
 * of its two cases:
 *
 *  - nothing publishes the dated id — first base entry wins, no coverage scan.
 *    There is no dated entry to check a candidate against, so scanning on for a
 *    complete one would hand the request to whichever reseller lists every rate:
 *    the same silent repricing refused above.
 *  - the dated id IS published but cannot price the request — this is the real
 *    case. 16 recorded `gpt-5.4-mini-2026-03-17` requests cost NULL because a
 *    reseller listed that exact id with input and output but no `cache_read`,
 *    and a single missing rate collapses the ENTIRE cost. Here a base entry may
 *    supply the hole, but only where it AGREES with the rates the dated entry
 *    does publish ({@link entriesAgree}) — a base slug priced differently is a
 *    different product, not a source of the missing rate.
 */
function selectModelEntry(
	pricing: ApiResponse,
	modelId: string,
	needed: readonly CostKind[],
): { entry: ModelDef | null; exact: boolean } {
	const exact = firstEntryFor(pricing, modelId);
	if (exact && entryCovers(exact, needed)) return { entry: exact, exact: true };

	const base = stripDatedModelSuffix(modelId);
	if (base !== null) {
		if (!exact) {
			// Nothing publishes the dated id, so the base slug is the whole answer:
			// first entry wins, exactly as for an ordinary id. Scanning on for a
			// COVERING base entry here would reintroduce the repricing this function
			// refuses everywhere else — with no exact entry there is nothing to check
			// a later candidate against, so a cheap reseller listing every rate would
			// beat the vendor's own partial one.
			return { entry: firstEntryFor(pricing, base), exact: false };
		}
		// The dated id IS published but cannot price this request. A base entry may
		// supply the missing rate only where it agrees with every rate the dated
		// entry does publish — evidence that the two are the same price list rather
		// than two products that happen to share a prefix.
		for (const provider of Object.values(pricing)) {
			const entry = provider.models?.[base];
			if (!entry) continue;
			if (entryCovers(entry, needed) && entriesAgree(exact, entry)) {
				return { entry, exact: false };
			}
		}
	}

	return { entry: exact, exact: exact !== null };
}

/**
 * Do two entries share at least one rate and agree on every rate they both
 * define?
 *
 * Guards the dated-snapshot fallback: filling a hole in a snapshot's price list
 * from its base slug is only sound while the two describe the same product, and
 * matching overlapping rates is the strongest available evidence of that. A base
 * entry that prices input differently from the snapshot is rejected rather than
 * quietly overriding an explicitly published rate.
 *
 * Only reached when a dated entry exists to be contradicted; with none, the
 * caller does not scan for coverage at all.
 */
function entriesAgree(a: ModelDef, b: ModelDef): boolean {
	const costA = a.cost;
	const costB = b.cost;
	if (!costA || !costB) return false;
	let shared = 0;
	for (const kind of COST_KINDS) {
		const rateA = costA[kind];
		const rateB = costB[kind];
		if (rateA === undefined || rateB === undefined) continue;
		if (rateA !== rateB) return false;
		shared++;
	}
	// No overlap is not agreement. A priceless dated stub, or one whose rates
	// simply do not intersect the base entry's, is no evidence that the two are
	// the same product — and treating it as agreement would let a cheap reseller's
	// complete base entry reprice the request, which is what this guard exists to
	// stop.
	return shared > 0;
}

/** First entry for an exact id across providers, in catalogue order. */
function firstEntryFor(pricing: ApiResponse, modelId: string): ModelDef | null {
	for (const provider of Object.values(pricing)) {
		const entry = provider.models?.[modelId];
		if (entry) return entry;
	}
	return null;
}

/** Does this entry price every rate the request needs? */
function entryCovers(
	entry: ModelDef | null,
	needed: readonly CostKind[],
): boolean {
	const cost = entry?.cost;
	if (!cost) return false;
	return needed.every((kind) => cost[kind] !== undefined);
}

/**
 * Read one rate off the selected entry, in dollars per token (NOT per million).
 * @throws PricingLookupError when the entry does not define it.
 */
function rateFromEntry(
	entry: ModelDef,
	modelId: string,
	kind: CostKind,
): number {
	const costPerMillion = entry.cost?.[kind];
	if (costPerMillion === undefined) {
		throw new PricingLookupError(
			`Model ${modelId} has no ${kind} cost`,
			"cost_missing",
		);
	}
	return costPerMillion / 1_000_000;
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

/** Outcome of {@link loadPricingCatalogue}. */
export interface PricingCatalogueStatus {
	/** A real catalogue is in memory (not just the bundled fallback). */
	loaded: boolean;
	/**
	 * The catalogue came from a disk snapshot older than the refresh window,
	 * because the remote could not be reached. Its prices may be out of date.
	 */
	stale: boolean;
	/**
	 * All catalogue work has finished, so the table in memory will not change
	 * underneath the caller. False means a load or refresh was still running when
	 * the wait gave up — it can still land later and replace the table, so a tool
	 * pricing many rows against it would write two different generations.
	 */
	stable: boolean;
}

/**
 * Force the pricing catalogue to settle and report what is now in memory.
 *
 * For offline tools — the cost backfill script — that write durable prices and
 * must know up front what they are writing from, instead of discovering it as a
 * silently smaller or silently outdated repair. Waits out the background refresh
 * as well as the initial load, so the table cannot change generation underneath
 * a caller that then prices thousands of rows against it.
 *
 * The proxy never needs this: `estimateCostUSD` already waits on in-flight
 * catalogue work before declaring a model unpriced.
 */
export async function loadPricingCatalogue(): Promise<PricingCatalogueStatus> {
	const catalogue = PriceCatalogue.get();
	await catalogue.getPricing();
	// Two rounds: the first settles the initial load, which is what STARTS the
	// background refresh when it answered from a snapshot; the second waits that
	// refresh out. Unlike a live lookup, a tool writing durable prices wants the
	// final generation even when an earlier one would have answered — otherwise
	// the refresh lands mid-run and neighbouring rows get different prices.
	await catalogue.awaitInFlightLoad();
	await catalogue.awaitInFlightLoad();
	return {
		loaded: catalogue.isCatalogueLoaded(),
		stale: catalogue.isCatalogueStale(),
		// Asked of the catalogue rather than inferred from the waits: whether they
		// settled or timed out, the only thing that matters is that nothing is left
		// running which could swap the table mid-run.
		stable: !catalogue.hasPendingCatalogueWork(),
	};
}

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
		// Only the buckets this request actually used are priced. A model whose
		// catalogue entry omits, say, cache_write is perfectly usable for a request
		// that created no cache — and the entry chosen below is scored on these
		// rates alone, so an irrelevant hole never rejects an otherwise complete
		// entry.
		const needed: CostKind[] = [];
		if (tokens.inputTokens) needed.push("input");
		if (tokens.outputTokens) needed.push("output");
		if (tokens.cacheReadInputTokens) needed.push("cache_read");
		if (tokens.cacheCreationInputTokens) needed.push("cache_write");
		// No metered tokens: nothing to charge, and nothing to look up — an
		// unknown model on an empty request is not a pricing gap.
		if (needed.length === 0) return 0;

		let match = selectModelEntry(await catalogue.getPricing(), modelId, needed);
		// A result that is a miss, a partial entry, or an INFERENCE from a dated
		// snapshot's base slug proves nothing while a catalogue load is still in
		// flight. That window is short, but it is exactly when the first requests
		// after a restart finalize, and every one of them used to be persisted with
		// a NULL cost and reported as an unpriced model. Inferences count because
		// the bundled seed can satisfy a base slug on its own: taking that as final
		// would price a dated snapshot from the fallback while the real catalogue —
		// which may list that exact id at its own rate — was still loading.
		//
		// Keyed on work actually being in flight rather than on the catalogue being
		// unloaded, so it also covers a background refresh landing right now, and so
		// it never waits once the best available table is already published.
		// awaitInFlightLoad never starts a load and gives up after a bounded wait;
		// once it does give up, waiting on the same stuck promise again would only
		// spend the deadline twice, so a timeout ends the loop.
		//
		// At most two rounds, because there are at most two things to wait for: the
		// initial load, and the background refresh that a load answering from a disk
		// snapshot starts as its final act.
		for (
			let round = 0;
			round < 2 &&
			!(match.exact && entryCovers(match.entry, needed)) &&
			catalogue.hasPendingCatalogueWork();
			round++
		) {
			const waited = await catalogue.awaitInFlightLoad();
			match = selectModelEntry(waited.pricing, modelId, needed);
			if (!waited.settled) break;
		}
		const entry = match.entry;
		if (!entry) {
			throw new PricingLookupError(
				`Model ${modelId} not found in pricing catalogue`,
				"model_missing",
			);
		}
		if (!entry.cost) {
			throw new PricingLookupError(
				`Model ${modelId} has no cost information`,
				"cost_missing",
			);
		}

		let totalCost = 0;

		if (tokens.inputTokens) {
			totalCost += tokens.inputTokens * rateFromEntry(entry, modelId, "input");
		}

		if (tokens.outputTokens) {
			totalCost +=
				tokens.outputTokens * rateFromEntry(entry, modelId, "output");
		}

		if (tokens.cacheReadInputTokens) {
			totalCost +=
				tokens.cacheReadInputTokens *
				rateFromEntry(entry, modelId, "cache_read");
		}

		if (tokens.cacheCreationInputTokens) {
			totalCost +=
				tokens.cacheCreationInputTokens *
				rateFromEntry(entry, modelId, "cache_write");
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
