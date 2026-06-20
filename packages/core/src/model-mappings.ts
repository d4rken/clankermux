import { Logger } from "@clankermux/logger";
import type { Account, ContextComposition } from "@clankermux/types";
import { safeJsonParse, validateModelMappings } from "./validation";

const log = new Logger("ModelMappings");

// Inline types to avoid Bun import issues
// Types are now defined in index.ts and exported from there

// Known model family patterns for O(1) direct matching
// Pattern order: Check "opus" before "haiku" before "sonnet" to avoid substring collisions
// in edge cases like "claude-opus-haiku-test" (though we would never see this pattern from the client)
export const KNOWN_PATTERNS = ["opus", "haiku", "sonnet", "fable"] as const;

/**
 * Get the model family (opus/sonnet/haiku/fable) from a model ID
 * Uses the same pattern matching as mapModelName().
 * Mythos-class IDs (e.g. claude-mythos-5) resolve to the "fable" family —
 * Mythos 5 is the same underlying model as Fable 5, so they share routing,
 * combo, and provider-fallback behaviour.
 * @returns Model family or null if no pattern matches
 */
export function getModelFamily(
	modelId: string,
): "opus" | "sonnet" | "haiku" | "fable" | null {
	const normalized = modelId.toLowerCase();
	// Mythos 5 shares the Fable model class — route it as the "fable" family.
	if (normalized.includes("mythos")) {
		return "fable";
	}
	for (const pattern of KNOWN_PATTERNS) {
		if (normalized.includes(pattern)) {
			return pattern;
		}
	}
	return null;
}

/**
 * Validate if a model ID is a valid Claude model
 * Accepts any model containing opus, sonnet, haiku, fable, or mythos
 * (case-insensitive)
 * @returns true if model matches a known pattern
 */
export function isValidClaudeModel(modelId: string): boolean {
	return getModelFamily(modelId) !== null;
}

/**
 * Get a user-friendly error message listing allowed model patterns
 * @returns Error message string for API responses
 */
export function getAllowedModelsMessage(): string {
	return "Model must contain one of: opus, sonnet, haiku, fable (e.g., claude-opus-4-6, claude-fable-5)";
}

/**
 * Parse custom endpoint data from account's custom_endpoint field
 */
export function parseCustomEndpointData(
	customEndpoint: string | null,
): { endpoint?: string; modelMappings?: Record<string, string> } | null {
	if (!customEndpoint) {
		return null;
	}

	const trimmed = customEndpoint.trim();
	if (!trimmed.startsWith("{")) {
		// Return plain string as endpoint
		return { endpoint: trimmed };
	}

	try {
		return safeJsonParse<{
			endpoint?: string;
			modelMappings?: Record<string, string>;
		}>(trimmed, "custom_endpoint");
	} catch (error) {
		log.warn(
			`Failed to parse custom_endpoint JSON, treating as plain string: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { endpoint: trimmed };
	}
}

/**
 * Parse model mappings from account's model_mappings field.
 * Values may be a single string or an ordered array of model names to try.
 */
export function parseModelMappings(
	modelMappings: string | null,
): Record<string, string | string[]> | null {
	if (!modelMappings) {
		return null;
	}

	try {
		return safeJsonParse<Record<string, string | string[]>>(
			modelMappings,
			"model_mappings",
		);
	} catch (error) {
		log.warn(
			`Failed to parse model_mappings JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * Normalise a model mapping value to an array.
 */
function toArray(value: string | string[]): string[] {
	return Array.isArray(value) ? value : [value];
}

/**
 * Get effective model mappings for an account, merging model_fallbacks into
 * the arrays so that model_fallbacks becomes the second+ entry for each family.
 */
export function getModelMappings(
	account: Account,
): Record<string, string | string[]> {
	const mappings: Record<string, string | string[]> = {};

	// Check for environment variable overrides (only in Node.js)
	if (
		typeof process !== "undefined" &&
		process.env?.OPENAI_COMPATIBLE_MODEL_MAPPINGS
	) {
		try {
			const envMappings = safeJsonParse<Record<string, string | string[]>>(
				process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS,
				"OPENAI_COMPATIBLE_MODEL_MAPPINGS environment variable",
			);
			Object.assign(mappings, envMappings);
		} catch (error) {
			log.warn(
				"Failed to parse OPENAI_COMPATIBLE_MODEL_MAPPINGS environment variable:",
				error,
			);
		}
	}

	// Check for account-specific mappings in model_mappings field
	const accountMappings = parseModelMappings(account.model_mappings);
	if (accountMappings) {
		Object.assign(mappings, accountMappings);
	}

	// Check for legacy mappings in custom_endpoint JSON payload (fallback)
	const customEndpointData = parseCustomEndpointData(account.custom_endpoint);
	if (customEndpointData?.modelMappings) {
		log.warn(
			`Found model mappings in custom_endpoint for account ${account.name} - this is deprecated. Use model_mappings field instead.`,
		);
		Object.assign(mappings, customEndpointData.modelMappings);
	}

	// Merge model_fallbacks into the arrays so they become the next models to try
	// after the primary mapping is exhausted. model_fallbacks is now deprecated as
	// a separate concept — the array in model_mappings supersedes it.
	if (account.model_fallbacks) {
		const fallbacks = parseModelFallbacks(account.model_fallbacks);
		if (fallbacks) {
			for (const [family, fallbackModel] of Object.entries(fallbacks)) {
				const existing = mappings[family];
				if (existing !== undefined) {
					const arr = toArray(existing);
					if (!arr.includes(fallbackModel)) {
						mappings[family] = [...arr, fallbackModel];
					}
				} else {
					mappings[family] = fallbackModel;
				}
			}
		}
	}

	return mappings;
}

/**
 * Check whether an account has any model mapping configuration.
 * Returns false if the account should just forward the model name unchanged.
 */
function hasAccountModelMappings(account: Account): boolean {
	if (account.model_mappings) return true;
	if (account.model_fallbacks) return true;

	const customEndpointData = parseCustomEndpointData(account.custom_endpoint);
	if (customEndpointData?.modelMappings) return true;

	// Check env override
	if (
		typeof process !== "undefined" &&
		process.env?.OPENAI_COMPATIBLE_MODEL_MAPPINGS
	) {
		try {
			const envMappings = safeJsonParse<Record<string, string | string[]>>(
				process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS,
				"OPENAI_COMPATIBLE_MODEL_MAPPINGS environment variable",
			);
			if (envMappings && Object.keys(envMappings).length > 0) return true;
		} catch {
			// Ignore — treat parse error as no env override
		}
	}

	return false;
}

/**
 * Get the ordered list of models to try for a given Anthropic model name.
 * Returns [primaryModel, ...fallbacks] from the account's model_mappings.
 * Returns null if the account has no model mapping configuration — the model
 * name should be forwarded unchanged to the upstream provider.
 */
export function getModelList(
	anthropicModel: string,
	account: Account,
): string[] | null {
	// No custom mappings configured — don't touch the model name
	if (!hasAccountModelMappings(account)) {
		return null;
	}

	const mappings = getModelMappings(account);

	// Exact match first
	if (mappings[anthropicModel] !== undefined) {
		return toArray(mappings[anthropicModel]);
	}

	// Family match
	const family = getModelFamily(anthropicModel);
	if (family && mappings[family] !== undefined) {
		return toArray(mappings[family]);
	}

	// No mapping for this model — pass through unchanged
	return [anthropicModel];
}

/**
 * Map Anthropic model name to provider-specific model name (first in list).
 * Optimized for known model patterns with direct matching (O(1) vs O(n log n))
 */
export function mapModelName(anthropicModel: string, account: Account): string {
	const list = getModelList(anthropicModel, account);
	if (!list) return anthropicModel;

	const mapped = list[0];

	if (
		process.env.DEBUG?.includes("model") ||
		process.env.DEBUG === "true" ||
		process.env.NODE_ENV === "development"
	) {
		log.info(`Model mapping: ${anthropicModel} -> ${mapped}`);
	}

	return mapped;
}

/**
 * Get endpoint URL from account, falling back to default
 */
export function getEndpointUrl(account: Account): string {
	const defaultEndpoint = "https://api.openai.com";
	const customEndpointData = parseCustomEndpointData(account.custom_endpoint);

	if (customEndpointData?.endpoint) {
		// Use the parsed endpoint from JSON
		return customEndpointData.endpoint;
	}

	if (
		account.custom_endpoint &&
		!account.custom_endpoint.trim().startsWith("{")
	) {
		// Plain string URL
		return account.custom_endpoint.trim();
	}

	// No custom endpoint - use default
	return defaultEndpoint;
}

/**
 * Create custom endpoint data with endpoint and model mappings
 */
export function createCustomEndpointData(
	endpoint: string,
	modelMappings?: Record<string, string>,
): string {
	const data: { endpoint?: string; modelMappings?: Record<string, string> } = {
		endpoint,
	};

	if (modelMappings && Object.keys(modelMappings).length > 0) {
		data.modelMappings = modelMappings;
	}

	return JSON.stringify(data);
}

/**
 * Parse model fallbacks from account's model_fallbacks field.
 * Model fallbacks map model family names (opus/sonnet/haiku/fable) to fallback model names.
 */
export function parseModelFallbacks(
	modelFallbacks: string | null,
): Record<string, string> | null {
	if (!modelFallbacks) {
		return null;
	}

	try {
		return safeJsonParse<Record<string, string>>(
			modelFallbacks,
			"model_fallbacks",
		);
	} catch (error) {
		log.warn(
			`Failed to parse model_fallbacks JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * Validate model fallbacks for storage.
 * @deprecated Prefer storing fallbacks as arrays in model_mappings instead.
 */
export function validateAndSanitizeModelFallbacks(
	fallbacks: unknown,
): Record<string, string> | null {
	if (!fallbacks) {
		return null;
	}

	try {
		const result = validateModelMappings(fallbacks, "modelFallbacks");
		// model_fallbacks only ever stored single strings — cast back
		return Object.fromEntries(
			Object.entries(result).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
		);
	} catch (error) {
		log.warn(
			`Invalid model fallbacks: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * Validate model mappings for storage. Values may be a string or string[].
 */
export function validateAndSanitizeModelMappings(
	mappings: unknown,
): Record<string, string | string[]> | null {
	if (!mappings) {
		return null;
	}

	try {
		return validateModelMappings(mappings, "modelMappings");
	} catch (error) {
		log.warn(
			`Invalid model mappings: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

// ── Context-window-aware routing ─────────────────────────────────────────────

/**
 * Codex (ChatGPT-auth) context windows. These are the CODEX caps, not the
 * API-key caps. Source of truth: the codex-cli models cache
 * (~/.codex/models_cache.json, fetched 2026-06-09 by codex 0.136) —
 * `context_window` per slug. The previous 400K figure for gpt-5.5 was stale;
 * the cache reports 272K. gpt-5.4's 1M `max_context_window` is the
 * client-gated experimental tier, NOT reachable via the proxy — use 272K.
 * Retired slugs (gpt-5-codex, gpt-5.3-codex) are no longer served and were
 * removed.
 *
 * Omitted models (compaction/internal models) are treated as
 * "unknown → fits, never gated" — no false exclusion.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"gpt-5.5": 272_000,
	"gpt-5.4": 272_000,
	"gpt-5.4-mini": 272_000,
	"gpt-5.3-codex-spark": 128_000,
};

/**
 * Fraction of window the context-window gate admits during normal routing — a
 * thin honest buffer on top of the (now-calibrated) gate estimate. Was 0.85,
 * which compensated for an estimator that under-counted input ~22% (chars/4.0)
 * while over-reserving output (full max_tokens). Those errors cancelled, so the
 * gate was correct only by coincidence. With `estimateContextWindowTokens`
 * calibrated against 46.7k production requests, 0.97 is a real safety band, not
 * a fudge factor. The last-resort path (`codexAccountFitsRequestUnmargined`)
 * drops even this band when a Codex account is the only way to serve.
 */
export const SAFETY_MARGIN = 0.97;

/**
 * Chars-per-token divisor for the context-window GATE estimate. Empirical mean
 * across 46,775 production requests is 3.13 (median 2.89, p10 2.43, p90 3.78);
 * 3.0 is deliberately a touch below the mean (slightly conservative → counts a
 * few more tokens) and matches the fallback path's divisor.
 */
export const GATE_CHARS_PER_TOKEN = 3.0;

/**
 * Cap on the output-token reservation in the gate estimate. Clients (Claude
 * Code) send `max_tokens` ceilings of 32k–64k, but real output is tiny: p50
 * 234, p95 3,035, p99 6,825. Reserving the full ceiling against the window was
 * the dominant cause of false rejections. 4,000 covers the p95 case; the rare
 * request that both sits near the window AND generates >4k output is backstopped
 * by Codex returning its own context-length error.
 */
export const GATE_OUTPUT_RESERVE_CAP = 4_000;

/**
 * Look up the context window for a Codex model.
 * Returns undefined for unknown/compaction models.
 */
export function resolveModelContextWindow(model: string): number | undefined {
	return MODEL_CONTEXT_WINDOWS[model];
}

/**
 * Coarse request-size estimate used by the cache-warming session-promotion path
 * (not the context-window gate — that uses `estimateContextWindowTokens`). Kept
 * intentionally unchanged: the promotion threshold (`getCacheWarmingMinTokens`,
 * default 100k) was tuned against this formula, and cache-warming is sensitive
 * to perturbation, so this stays byte-identical.
 *
 * When a ContextComposition is provided (preferred), uses the already-walked
 * content-char counts (system + tools + messages) divided by 4.0.  This avoids
 * the JSON-escaping inflation of re-serialising the whole body: every `\n` in
 * bash/file output becomes `\\n` in JSON, and structural envelope bytes
 * ("role","content","type","text"…) tokenise far more efficiently than 3
 * chars/token.
 *
 * Without a composition (e.g. non-messages endpoints), falls back to
 * JSON.stringify(body).length / 3.0 — deliberately over-counts, but that is
 * acceptable as a last resort.
 *
 * No tiktoken — hot path.
 */
export function estimateRequestTokens(
	parsedBody: Record<string, unknown> | null | undefined,
	composition?: ContextComposition | null,
): number {
	if (!parsedBody) return 0;
	const maxTokens =
		typeof parsedBody.max_tokens === "number" ? parsedBody.max_tokens : 0;
	if (composition) {
		const contentChars =
			composition.systemChars +
			composition.toolsChars +
			composition.messagesChars;
		return Math.ceil(contentChars / 4.0) + maxTokens;
	}
	const inputTokens = Math.ceil(JSON.stringify(parsedBody).length / 3.0);
	return inputTokens + maxTokens;
}

/**
 * Token estimate for the context-window GATE only — "does input + a realistic
 * output reservation fit the backend's window?".
 *
 * Distinct from `estimateRequestTokens` (the promotion-path estimate) in two
 * calibrated ways, both derived from 46,775 production requests:
 *   1. content chars ÷ `GATE_CHARS_PER_TOKEN` (3.0, vs the promotion path's 4.0
 *      which under-counts real input by ~22%);
 *   2. the output reservation is capped at `GATE_OUTPUT_RESERVE_CAP` (4k) rather
 *      than trusting the client's `max_tokens` ceiling (32k–64k), because real
 *      output is tiny (p95 ≈ 3k).
 *
 * The result is fed to `codexAccountFitsRequest` (admits at `window * SAFETY_MARGIN`)
 * during normal routing, and to `codexAccountFitsRequestUnmargined` (admits at
 * the full `window`) as a last resort. No tiktoken — hot path.
 */
export function estimateContextWindowTokens(
	parsedBody: Record<string, unknown> | null | undefined,
	composition?: ContextComposition | null,
): number {
	if (!parsedBody) return 0;
	const maxTokens =
		typeof parsedBody.max_tokens === "number" ? parsedBody.max_tokens : 0;
	const outputReserve = Math.min(maxTokens, GATE_OUTPUT_RESERVE_CAP);
	if (composition) {
		const contentChars =
			composition.systemChars +
			composition.toolsChars +
			composition.messagesChars;
		return Math.ceil(contentChars / GATE_CHARS_PER_TOKEN) + outputReserve;
	}
	// Fallback (non-/v1/messages): whole-body JSON over-counts; keep /3.0 but
	// still cap the output reservation for consistency with the gate's intent.
	const inputTokens = Math.ceil(JSON.stringify(parsedBody).length / 3.0);
	return inputTokens + outputReserve;
}

/**
 * Default Anthropic-family → Codex model mapping, used when a Codex account has
 * no explicit `model_mappings` entry for the requested family.
 *
 * This is the single source of truth shared with the Codex provider's
 * `mapModel()`. Keeping both on this map is load-bearing: the context-window
 * gate and the provider MUST agree on which Codex model a defaulted request
 * actually hits, or the gate would size requests against the wrong window.
 */
export const DEFAULT_CODEX_MODEL_BY_FAMILY: Record<
	"opus" | "sonnet" | "haiku" | "fable",
	string
> = {
	opus: "gpt-5.5",
	sonnet: "gpt-5.4",
	haiku: "gpt-5.4-mini",
	// Fable/Mythos are above Opus — route to the top Codex tier (same as opus).
	fable: "gpt-5.5",
};

/**
 * Resolve the Codex model a request will actually be sent to for the given
 * account: the account's explicit `model_mappings` entry if one exists,
 * otherwise the family default (`DEFAULT_CODEX_MODEL_BY_FAMILY`). Mirrors the
 * Codex provider's `mapModel()` precedence exactly. A non-Claude model with no
 * mapping is returned unchanged.
 */
export function resolveCodexTargetModel(
	effectiveModel: string,
	account: Account,
): string {
	const mapped = mapModelName(effectiveModel, account);
	if (mapped !== effectiveModel) {
		return mapped; // explicit account mapping (or combo slot already-gpt model) wins
	}
	const family = getModelFamily(effectiveModel);
	if (family) {
		return DEFAULT_CODEX_MODEL_BY_FAMILY[family];
	}
	return effectiveModel;
}

/**
 * Check whether a Codex account can serve a request of the given estimated size.
 *
 * Resolves the target model via `resolveCodexTargetModel` (account mapping, then
 * family default — matching what the provider will actually send), looks up
 * `MODEL_CONTEXT_WINDOWS`, and returns true if the estimate fits within
 * `floor(window * SAFETY_MARGIN)`. Models with no known window always fit — no
 * false exclusion.
 *
 * @param account      The Codex account to check
 * @param effectiveModel  The Anthropic-side model name (e.g. "claude-opus-4-7")
 *                        — resolved through the account's mapping / family default.
 * @param estimate     Token estimate from `estimateRequestTokens()`
 */
export function codexAccountFitsRequest(
	account: Account,
	effectiveModel: string,
	estimate: number,
): boolean {
	const target = resolveCodexTargetModel(effectiveModel, account);
	const window = MODEL_CONTEXT_WINDOWS[target];
	if (window === undefined) return true; // unknown model → fits (no false exclusion)
	return estimate <= Math.floor(window * SAFETY_MARGIN);
}

/**
 * Last-resort variant of `codexAccountFitsRequest` that drops the `SAFETY_MARGIN`
 * guard band and admits up to the **full** window. Used only when a context-gate-
 * excluded Codex account is the *only* remaining way to serve the request — at
 * that point a clean 400 helps no one, so we re-admit anything the estimate says
 * plausibly fits the real window and let the request be attempted.
 *
 * This is an *estimated* fit, not a proof: it relies on the same lossy
 * `estimateContextWindowTokens` (calibrated divisor + capped output reserve), so
 * a dense or large-output request can still slip over the true window — in which
 * case Codex returns its own context-length error, which is the correct outcome.
 *
 * Models with no known window always fit (no false exclusion), matching
 * `codexAccountFitsRequest`.
 */
export function codexAccountFitsRequestUnmargined(
	account: Account,
	effectiveModel: string,
	estimate: number,
): boolean {
	const target = resolveCodexTargetModel(effectiveModel, account);
	const window = MODEL_CONTEXT_WINDOWS[target];
	if (window === undefined) return true;
	return estimate <= window;
}
