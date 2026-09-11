import { Logger } from "@clankermux/logger";
import type { Account, ContextComposition } from "@clankermux/types";
import { stripDatedModelSuffix } from "./models";
import { safeJsonParse } from "./validation";

const log = new Logger("ModelMappings");

// Known model family patterns for O(1) direct matching
// Pattern order: Check "opus" before "haiku" before "sonnet" to avoid substring collisions
// in edge cases like "claude-opus-haiku-test" (though we would never see this pattern from the client)
export const KNOWN_PATTERNS = ["opus", "haiku", "sonnet", "fable"] as const;

/** Canonical Claude model family, as resolved by {@link getModelFamily}. */
export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable";

/**
 * Get the model family (opus/sonnet/haiku/fable) from a model ID
 * Used for quota attribution; routing rule matching lives in routing.ts.
 * Mythos-class IDs (e.g. claude-mythos-5) resolve to the "fable" family —
 * Mythos and Fable share quota attribution; routing uses its strict classifier.
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
): { endpoint?: string } | null {
	if (!customEndpoint) {
		return null;
	}

	const trimmed = customEndpoint.trim();
	if (!trimmed.startsWith("{")) {
		// Return plain string as endpoint
		return { endpoint: trimmed };
	}

	try {
		const parsed = safeJsonParse<{ endpoint?: string }>(
			trimmed,
			"custom_endpoint",
		);
		return parsed && typeof parsed.endpoint === "string"
			? { endpoint: parsed.endpoint }
			: null;
	} catch (error) {
		log.warn(
			`Failed to parse custom_endpoint JSON, treating as plain string: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { endpoint: trimmed };
	}
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

export function createCustomEndpointData(endpoint: string): string {
	return JSON.stringify({ endpoint });
}

// ── Context-window-aware routing ─────────────────────────────────────────────

/**
 * Default Codex (ChatGPT-auth) context windows from the subscription catalog.
 * These feed client context gauges / compaction metadata. Routing may use a
 * larger verified maximum via resolveModelMaxContextWindow.
 * Unknown / compaction models remain ungated.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"gpt-5.5": 272_000,
	"gpt-5.4": 272_000,
	"gpt-5.4-mini": 272_000,
	"gpt-5.3-codex-spark": 128_000,
	"gpt-5.6-sol": 272_000,
	"gpt-5.6-terra": 272_000,
	"gpt-5.6-luna": 272_000,
	"gpt-6-astra": 272_000,
};

/**
 * Verified subscription routing ceilings, separate from client defaults.
 * Astra's live catalog (client_version=0.153.1, 2026-09-07) reports
 * max_context_window=872000 on both pool accounts. Live requests completed
 * with 300,070 and 850,070 input tokens and correctly returned both markers.
 * See docs/astra-subscription-context-2026-09-07.md for the probe details.
 * The API window and pricing threshold do not define this subscription limit.
 * Other models retain existing routing ceilings until their larger windows
 * are verified.
 */
const MODEL_MAX_CONTEXT_WINDOWS: Record<string, number> = {
	"gpt-6-astra": 872_000,
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
	const exact = Object.hasOwn(MODEL_CONTEXT_WINDOWS, model)
		? MODEL_CONTEXT_WINDOWS[model]
		: undefined;
	if (exact !== undefined) return exact;
	const base = stripDatedModelSuffix(model);
	if (base !== null && Object.hasOwn(MODEL_CONTEXT_WINDOWS, base))
		return MODEL_CONTEXT_WINDOWS[base];
	return undefined;
}

/** Maximum verified routing window, falling back to the client default. */
export function resolveModelMaxContextWindow(
	model: string,
): number | undefined {
	const exact = Object.hasOwn(MODEL_MAX_CONTEXT_WINDOWS, model)
		? MODEL_MAX_CONTEXT_WINDOWS[model]
		: undefined;
	if (exact !== undefined) return exact;
	const base = stripDatedModelSuffix(model);
	if (
		base !== null &&
		Object.hasOwn(MODEL_MAX_CONTEXT_WINDOWS, base) &&
		MODEL_MAX_CONTEXT_WINDOWS[base] !== undefined
	) {
		return MODEL_MAX_CONTEXT_WINDOWS[base];
	}
	return resolveModelContextWindow(model);
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

/** Central routing defaults for Claude families on Codex. */
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

/** Size admission uses the already-resolved upstream model. */
export function codexAccountFitsRequest(
	_account: Account,
	effectiveModel: string,
	estimate: number,
): boolean {
	const target = effectiveModel;
	const window = resolveModelMaxContextWindow(target);
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
	_account: Account,
	effectiveModel: string,
	estimate: number,
): boolean {
	const target = effectiveModel;
	const window = resolveModelMaxContextWindow(target);
	if (window === undefined) return true;
	return estimate <= window;
}
