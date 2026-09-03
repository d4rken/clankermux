import { Logger } from "@clankermux/logger";
import type { Account, ContextComposition } from "@clankermux/types";
import { isDebugEnabled } from "./env";
import { stripDatedModelSuffix } from "./models";
import { safeJsonParse, validateModelMappings } from "./validation";

const log = new Logger("ModelMappings");

// Inline types to avoid Bun import issues
// Types are now defined in index.ts and exported from there

// Known model family patterns for O(1) direct matching
// Pattern order: Check "opus" before "haiku" before "sonnet" to avoid substring collisions
// in edge cases like "claude-opus-haiku-test" (though we would never see this pattern from the client)
export const KNOWN_PATTERNS = ["opus", "haiku", "sonnet", "fable"] as const;

/** Canonical Claude model family, as resolved by {@link getModelFamily}. */
export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable";

/**
 * Get the model family (opus/sonnet/haiku/fable) from a model ID
 * Uses the same pattern matching as mapModelName().
 * Mythos-class IDs (e.g. claude-mythos-5) resolve to the "fable" family —
 * Mythos 5 is the same underlying model as Fable 5, so they share routing,
 * combo, and provider-fallback behaviour.
 * @returns Model family or null if no pattern matches
 */
export function getModelFamily(modelId: string): ModelFamily | null {
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
 * Model families ordered most-advanced first. Index 0 is the single protected
 * family whose shared quota we reserve capacity for (see {@link PROTECTED_FAMILY}).
 * When a newer flagship family ships, bump this one line to prepend it.
 */
export const FAMILY_PRIORITY: readonly ModelFamily[] = [
	"fable",
	"opus",
	"sonnet",
	"haiku",
] as const;

/** The single most-advanced family we reserve shared-quota capacity for. */
export const PROTECTED_FAMILY: ModelFamily = FAMILY_PRIORITY[0];

/** True if `family` is the protected (most-advanced) family. */
export function isProtectedFamily(family: ModelFamily | null): boolean {
	return family === PROTECTED_FAMILY;
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
 * True iff a raw mapping value is usable as a model target: a non-empty string,
 * or a non-empty array of non-empty strings.
 */
function isValidMappingValue(value: unknown): value is string | string[] {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) {
		return (
			value.length > 0 &&
			value.every((item) => typeof item === "string" && item.trim().length > 0)
		);
	}
	return false;
}

/**
 * Apply one configuration layer over `target`, dropping entries whose value is
 * not a usable model target. Unvalidated, `{"sonnet": null}` (or `42`, or `[]`)
 * would shadow a lower-precedence default and reach the wire as the outbound
 * model name via {@link toArray}.
 */
function applyMappingLayer(
	target: Record<string, string | string[]>,
	layer: Record<string, unknown> | null | undefined,
	source: string,
): void {
	if (!layer) return;
	for (const [key, value] of Object.entries(layer)) {
		if (!isValidMappingValue(value)) {
			log.warn(
				`Ignoring invalid model mapping for '${key}' from ${source}: ${JSON.stringify(value)}`,
			);
			continue;
		}
		target[key] = value;
	}
}

/**
 * Built-in family defaults for `account.provider`, or undefined when the
 * provider has none. Own-property lookup only — a provider name that collides
 * with an Object.prototype key must not resolve to an inherited member.
 */
function getProviderDefaultMappings(
	provider: string,
): Record<ModelFamily, string> | undefined {
	return Object.hasOwn(PROVIDER_DEFAULT_MODEL_MAPPINGS, provider)
		? PROVIDER_DEFAULT_MODEL_MAPPINGS[provider]
		: undefined;
}

/**
 * Get effective model mappings for an account, merging model_fallbacks into
 * the arrays so that model_fallbacks becomes the second+ entry for each family.
 *
 * Layered lowest-precedence first: built-in provider defaults, then the env
 * override, then the account's `model_mappings`, then the legacy
 * `custom_endpoint` payload. Explicit configuration always beats a built-in
 * default.
 */
export function getModelMappings(
	account: Account,
): Record<string, string | string[]> {
	const mappings: Record<string, string | string[]> = {};

	// Built-in provider defaults (e.g. qwen → coder-model) — the lowest layer.
	const providerDefaults = getProviderDefaultMappings(account.provider);
	if (providerDefaults) {
		Object.assign(mappings, providerDefaults);
	}

	// Check for environment variable overrides (only in Node.js)
	if (
		typeof process !== "undefined" &&
		process.env?.OPENAI_COMPATIBLE_MODEL_MAPPINGS
	) {
		try {
			const envMappings = safeJsonParse<Record<string, unknown>>(
				process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS,
				"OPENAI_COMPATIBLE_MODEL_MAPPINGS environment variable",
			);
			applyMappingLayer(
				mappings,
				envMappings,
				"OPENAI_COMPATIBLE_MODEL_MAPPINGS environment variable",
			);
		} catch (error) {
			log.warn(
				"Failed to parse OPENAI_COMPATIBLE_MODEL_MAPPINGS environment variable:",
				error,
			);
		}
	}

	// Check for account-specific mappings in model_mappings field
	const accountMappings = parseModelMappings(account.model_mappings);
	applyMappingLayer(
		mappings,
		accountMappings,
		`model_mappings for account ${account.name}`,
	);

	// Check for legacy mappings in custom_endpoint JSON payload (fallback)
	const customEndpointData = parseCustomEndpointData(account.custom_endpoint);
	if (customEndpointData?.modelMappings) {
		log.warn(
			`Found model mappings in custom_endpoint for account ${account.name} - this is deprecated. Use model_mappings field instead.`,
		);
		applyMappingLayer(
			mappings,
			customEndpointData.modelMappings,
			`custom_endpoint for account ${account.name}`,
		);
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
	// A provider with built-in family defaults always maps, even unconfigured.
	if (getProviderDefaultMappings(account.provider)) return true;
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

	if (isDebugEnabled("model") || process.env.NODE_ENV === "development") {
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
	// GPT-5.6 tiers. Read live from `GET /backend-api/codex/models` against a
	// real account (2026-08-21): `context_window` is 272,000 for all three, and
	// no value anywhere near 353K appears in the payload.
	//
	// This corrects an earlier 353_000 taken from the Codex TUI on 2026-07-10.
	// Both readings were honest when made: codex-cli v0.144.6 (2026-07-18)
	// corrected its bundled metadata to cap gpt-5.6 at 272K input tokens, and
	// the specific 353,400 figure the old comment recorded matches the known
	// oscillation bug (openai/codex#30875) where the effective window swung
	// between 258,400 and 353,400 rather than settling.
	//
	// 272K is a BILLING threshold, not a hard model limit: prompts above it
	// bill input at 2x and output at 1.5x for the whole session. So the gate
	// admitting past this number does not produce an error the way an oversized
	// request to a hard cap would — it silently doubles the bill, which is
	// exactly the kind of unasked-for spend this pool exists to avoid.
	//
	// The same payload reports `max_context_window` of 872,000 for these three
	// and 1,000,000 for gpt-5.4, both deliberately ignored: that is the raw
	// payload ceiling, not the window the harness uses or prices normally.
	"gpt-5.6-sol": 272_000,
	"gpt-5.6-terra": 272_000,
	"gpt-5.6-luna": 272_000,
	// GPT-6 Astra (released 2026-09-03). The Codex catalog entry that shipped in
	// codex-cli 0.153.1 (openai/codex#42605) reports `context_window: 272000`
	// and `max_context_window: 872000`, the same split as the 5.6 tiers, and
	// the API pricing page keeps the same >272K-input surcharge (2x input, 1.5x
	// output for the whole request). The documented 1.05M API window is the raw
	// ceiling, ignored here for the same reason as 5.6's 872K.
	"gpt-6-astra": 272_000,
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
 * Flat per-image token allowance used by every estimator instead of counting an
 * attached image's base64 payload as prompt text.
 *
 * Vision tokens are a function of pixels, not of transport bytes: Anthropic
 * bills roughly (width × height) / 750, which tops out near 1,600 tokens at the
 * 1568×1568 resize ceiling, and OpenAI's high-detail tile pricing caps around
 * 1.1k–1.5k. 2,000 is a deliberate slight over-count, matching the gate's
 * conservative bias, and is applied uniformly to every recognised image block.
 *
 * The bug this replaces: a 1.4MB PNG arrives as ~1.9MB of base64, which the
 * chars/3 heuristic read as ~630k tokens — enough to fail the context-window
 * gate with a spurious context_window_exceeded on a request whose real size was
 * ~47k tokens.
 */
export const IMAGE_TOKEN_ESTIMATE = 2_000;

/** Per-block measurement produced by {@link measureContentBlock}. */
export interface ContentBlockMeasurement {
	/** JSON.stringify length with recognised binary payloads removed. */
	chars: number;
	/** Recognised image blocks (base64 AND url sources). */
	imageCount: number;
	/** Base64 image payload chars excluded from `chars`. */
	imagePayloadChars: number;
	/** Base64 document payload chars excluded from `chars`. */
	documentPayloadChars: number;
}

/** Whole-body measurement produced by {@link measureBodyForEstimate}. */
export interface BodyMeasurement {
	/** Whole-body JSON length minus the recognised binary payload chars. */
	textChars: number;
	imageCount: number;
	imagePayloadChars: number;
	documentPayloadChars: number;
}

function isBlockRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** JSON.stringify length, 0 for unstringifiable values (circular refs, undefined). */
function safeJsonLength(value: unknown): number {
	try {
		const json = JSON.stringify(value);
		return typeof json === "string" ? json.length : 0;
	} catch {
		return 0;
	}
}

const EMPTY_MEASUREMENT: ContentBlockMeasurement = {
	chars: 0,
	imageCount: 0,
	imagePayloadChars: 0,
	documentPayloadChars: 0,
};

/**
 * Measure ONE content block of an Anthropic-shaped message: its char size with
 * any base64 attachment payload stripped out, plus what was stripped.
 *
 * Recognised shapes (everything else is measured as plain JSON, unchanged):
 *   - `{type:"image", source:{type:"base64", data:"<b64>"}}` — payload chars are
 *     excluded from `chars` and reported separately; counts as one image.
 *   - `{type:"image", source:{type:"url", …}}` — counts as one image, carries no
 *     payload.
 *   - `{type:"document", source:{type:"base64", data:"<b64>"}}` — payload chars
 *     reported separately. A `text`-source document's `data` is REAL prompt text
 *     and is deliberately left in `chars`; so is a URL source.
 *   - `{type:"tool_result", content:[…]}` — the nested blocks get the same
 *     recognition (Claude Code returns screenshots inside tool results).
 *
 * Malformed shapes (non-string `data`, missing `source`) fall through to the
 * full JSON length with no tallies: never guess about a shape we don't know.
 *
 * This is the single source of truth shared by the proxy's ingest-time
 * composition walk and the whole-body estimator fallback.
 */
export function measureContentBlock(block: unknown): ContentBlockMeasurement {
	if (!isBlockRecord(block)) return EMPTY_MEASUREMENT;

	const fullChars = safeJsonLength(block);

	if (block.type === "image" && isBlockRecord(block.source)) {
		const source = block.source;
		if (source.type === "base64" && typeof source.data === "string") {
			return {
				chars: Math.max(0, fullChars - source.data.length),
				imageCount: 1,
				imagePayloadChars: source.data.length,
				documentPayloadChars: 0,
			};
		}
		if (source.type === "url") {
			return {
				chars: fullChars,
				imageCount: 1,
				imagePayloadChars: 0,
				documentPayloadChars: 0,
			};
		}
		return { ...EMPTY_MEASUREMENT, chars: fullChars };
	}

	if (block.type === "document" && isBlockRecord(block.source)) {
		const source = block.source;
		if (source.type === "base64" && typeof source.data === "string") {
			return {
				chars: Math.max(0, fullChars - source.data.length),
				imageCount: 0,
				imagePayloadChars: 0,
				documentPayloadChars: source.data.length,
			};
		}
		return { ...EMPTY_MEASUREMENT, chars: fullChars };
	}

	if (block.type === "tool_result" && Array.isArray(block.content)) {
		let imageCount = 0;
		let imagePayloadChars = 0;
		let documentPayloadChars = 0;
		for (const nested of block.content) {
			const measured = measureContentBlock(nested);
			imageCount += measured.imageCount;
			imagePayloadChars += measured.imagePayloadChars;
			documentPayloadChars += measured.documentPayloadChars;
		}
		return {
			chars: Math.max(0, fullChars - imagePayloadChars - documentPayloadChars),
			imageCount,
			imagePayloadChars,
			documentPayloadChars,
		};
	}

	return { ...EMPTY_MEASUREMENT, chars: fullChars };
}

/**
 * Whole-body measurement for the estimator fallback (no ContextComposition
 * available — e.g. /v1/messages/count_tokens, which ingress excludes from the
 * composition walk by exact-path match).
 *
 * `textChars` is the plain `JSON.stringify(body).length` MINUS the base64
 * payload chars found at SEMANTIC positions only: `messages[].content[]` blocks
 * and the blocks nested in a `tool_result.content[]`. Deliberately not a
 * JSON.stringify replacer — an image-shaped object sitting in a `tool_use.input`
 * or in a tool's JSON schema is model-visible text and must keep its full count.
 * Base64-looking strings in ordinary text are prompt text too, and are never
 * touched.
 *
 * A body with no `messages` array is measured exactly as before (plain
 * stringify length, zero tallies). Stringify throws propagate to the caller,
 * as they always did — no fail-open zero.
 */
export function measureBodyForEstimate(
	parsedBody: Record<string, unknown>,
): BodyMeasurement {
	const totalChars = JSON.stringify(parsedBody).length;
	const messages = parsedBody.messages;
	if (!Array.isArray(messages)) {
		return {
			textChars: totalChars,
			imageCount: 0,
			imagePayloadChars: 0,
			documentPayloadChars: 0,
		};
	}

	let imageCount = 0;
	let imagePayloadChars = 0;
	let documentPayloadChars = 0;

	for (const message of messages) {
		if (!isBlockRecord(message)) continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const measured = measureContentBlock(block);
			imageCount += measured.imageCount;
			imagePayloadChars += measured.imagePayloadChars;
			documentPayloadChars += measured.documentPayloadChars;
		}
	}

	return {
		textChars: Math.max(
			0,
			totalChars - imagePayloadChars - documentPayloadChars,
		),
		imageCount,
		imagePayloadChars,
		documentPayloadChars,
	};
}

/**
 * Look up the context window for a Codex model.
 * Returns undefined for unknown/compaction models.
 *
 * Exact keys win. If the exact slug is unknown but ends in a trailing
 * `-YYYY-MM-DD` release-date suffix (e.g. `gpt-5.6-sol-2026-05-13`), fall back
 * to the base model's window (`gpt-5.6-sol`). Non-date suffixes stay unknown.
 */
export function resolveModelContextWindow(model: string): number | undefined {
	const exact = MODEL_CONTEXT_WINDOWS[model];
	if (exact !== undefined) return exact;
	const base = stripDatedModelSuffix(model);
	if (base !== null) return MODEL_CONTEXT_WINDOWS[base];
	return undefined;
}

/**
 * Coarse request-size estimate used by the cache-warming session-promotion path
 * (not the context-window gate — that uses `estimateContextWindowTokens`). The
 * promotion threshold (`getCacheWarmingMinTokens`, default 100k) was tuned
 * against this formula and cache-warming is sensitive to perturbation, so a
 * TEXT-ONLY body still measures byte-identically to the original.
 *
 * Image-bearing bodies deliberately do NOT: attached screenshots were counted
 * as base64 text, so a screenshot session crossed the 100k promotion threshold
 * on transport bytes alone and paid the 2× 1h-cache-write premium for context
 * it never had. Images now cost {@link IMAGE_TOKEN_ESTIMATE} each.
 *
 * When a ContextComposition is provided (preferred), uses the already-walked
 * content-char counts (system + tools + messages) divided by 4.0.  This avoids
 * the JSON-escaping inflation of re-serialising the whole body: every `\n` in
 * bash/file output becomes `\\n` in JSON, and structural envelope bytes
 * ("role","content","type","text"…) tokenise far more efficiently than 3
 * chars/token.
 *
 * Without a composition (e.g. non-messages endpoints), falls back to
 * `measureBodyForEstimate(body).textChars / 3.0` — deliberately over-counts,
 * but that is acceptable as a last resort.
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
		// Document payloads keep the chars/N treatment; only images are priced
		// per-attachment.
		return (
			Math.ceil(
				(contentChars + (composition.documentPayloadChars ?? 0)) / 4.0,
			) +
			(composition.imageCount ?? 0) * IMAGE_TOKEN_ESTIMATE +
			maxTokens
		);
	}
	const measured = measureBodyForEstimate(parsedBody);
	const inputTokens =
		Math.ceil((measured.textChars + measured.documentPayloadChars) / 3.0) +
		measured.imageCount * IMAGE_TOKEN_ESTIMATE;
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
 * Attached images are priced at a flat {@link IMAGE_TOKEN_ESTIMATE} each rather
 * than by their base64 size: transport bytes are not prompt text, and counting
 * them as such made one 1.4MB screenshot estimate at 657,214 tokens on a ~47k
 * request, which the gate rejected as context_window_exceeded. Base64 documents
 * keep the chars/N treatment (their real tokenisation is text-like).
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
		return (
			Math.ceil(
				(contentChars + (composition.documentPayloadChars ?? 0)) /
					GATE_CHARS_PER_TOKEN,
			) +
			(composition.imageCount ?? 0) * IMAGE_TOKEN_ESTIMATE +
			outputReserve
		);
	}
	// Fallback (non-/v1/messages): whole-body JSON over-counts; keep /3.0 but
	// still cap the output reservation for consistency with the gate's intent.
	const measured = measureBodyForEstimate(parsedBody);
	const inputTokens =
		Math.ceil((measured.textChars + measured.documentPayloadChars) / 3.0) +
		measured.imageCount * IMAGE_TOKEN_ESTIMATE;
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
	// GPT-5.6 tier-matched: flagship→sol, balanced→terra, efficient→luna. All
	// three verified served on a prolite plan with a 353K window (see
	// MODEL_CONTEXT_WINDOWS), 2026-07-10.
	opus: "gpt-5.6-sol",
	sonnet: "gpt-5.6-terra",
	haiku: "gpt-5.6-luna",
	// Fable/Mythos are above Opus — route to the top Codex tier. Since
	// 2026-09-03 that is GPT-6 Astra; opus deliberately stays on gpt-5.6-sol,
	// which lists at roughly half of Astra's per-token price.
	fable: "gpt-6-astra",
};

/**
 * Default Anthropic-family → Qwen model mapping. Qwen/DashScope serves every
 * tier from one unified coding model, so all four families collapse onto it.
 *
 * Typed exhaustively over {@link ModelFamily}: adding a family must fail
 * compilation here rather than silently leaving that family unmapped — which is
 * exactly how the previous provider-local map missed `fable`/`mythos` and sent
 * `claude-fable-5` upstream to DashScope as an unknown model.
 */
export const DEFAULT_QWEN_MODEL_BY_FAMILY: Record<ModelFamily, string> = {
	opus: "coder-model",
	sonnet: "coder-model",
	haiku: "coder-model",
	fable: "coder-model",
};

/**
 * Built-in family defaults per provider, seeded by {@link getModelMappings} as
 * the LOWEST-precedence layer. This is the single mechanism for "this provider
 * has a sensible default target for every Claude family" — providers must not
 * re-implement it in their own request hooks.
 *
 * Codex is deliberately absent: its defaults apply through
 * {@link resolveCodexTargetModel} and the Codex provider's own `mapModel()`,
 * which the context-window gate is built around. Registering them here too
 * would give Codex two disagreeing default paths.
 */
export const PROVIDER_DEFAULT_MODEL_MAPPINGS: Partial<
	Record<string, Record<ModelFamily, string>>
> = {
	qwen: DEFAULT_QWEN_MODEL_BY_FAMILY,
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
	const window = resolveModelContextWindow(target);
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
	const window = resolveModelContextWindow(target);
	if (window === undefined) return true;
	return estimate <= window;
}
