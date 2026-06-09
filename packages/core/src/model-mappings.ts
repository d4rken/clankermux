import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";
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
 * API-key caps. gpt-5.5 is 1.05M via raw API-key but only 400K via
 * Codex/ChatGPT-auth (confirmed documented hard cap, not a bug).
 *
 * Omitted models (gpt-5.4, gpt-5.2-codex, compaction models) are treated as
 * "unknown → fits, never gated" — no false exclusion.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"gpt-5.5": 400_000,
	"gpt-5.3-codex": 200_000,
	"gpt-5.4-mini": 200_000,
	"gpt-5-codex": 400_000,
};

/** Fraction of window we actually admit — conservative guard band. */
export const SAFETY_MARGIN = 0.85;

/**
 * Look up the context window for a Codex model.
 * Returns undefined for unknown/compaction models.
 */
export function resolveModelContextWindow(model: string): number | undefined {
	return MODEL_CONTEXT_WINDOWS[model];
}

/**
 * Conservative token-count estimate for a request body.
 * Uses char-count / 3.0 (deliberately over-counts) + max_tokens output reserve.
 * No tiktoken — hot path, and we use a wide guard band anyway.
 */
export function estimateRequestTokens(
	parsedBody: Record<string, unknown> | null | undefined,
): number {
	if (!parsedBody) return 0;
	const inputTokens = Math.ceil(JSON.stringify(parsedBody).length / 3.0);
	const maxTokens =
		typeof parsedBody.max_tokens === "number" ? parsedBody.max_tokens : 0;
	return inputTokens + maxTokens;
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
	sonnet: "gpt-5.3-codex",
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
