import { getModelFamily, parseModelMappings } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";

const log = new Logger("ModelMappingUtils");

// Enhanced TypeScript interfaces for type safety
export interface ProviderAccount extends Account {
	mode?: string;
}

export interface TransformRequestBody {
	model?: string;
	messages?: Array<{
		role: string;
		content: string | Array<{ type: string; text: string }>;
	}>;
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	stop_sequences?: string[] | null;
	stream?: boolean;
	tools?: Array<{
		name: string;
		description: string;
		input_schema: Record<string, unknown>;
	}>;
	tool_choice?: {
		type: string;
		name?: string;
	} | null;
	system?: string;
	// Add other common fields as needed
}

/**
 * Standardized model mapping utility for all providers
 * Ensures consistent behavior across different provider implementations
 * Optimized for performance: O(1) exact match + O(k) pattern matching where k is the number of known patterns
 *
 * @param anthropicModel - The original Anthropic model name
 * @param account - The account containing model_mappings configuration
 * @returns The mapped model name or the original if no mapping exists
 *
 * @example
 * const mapped = getModelName("claude-sonnet-4-5", account);
 * // Returns "custom-sonnet" if account has mapping: {"claude-sonnet-4-5": "custom-sonnet"}
 */
export function getModelName(
	anthropicModel: string,
	account: Account | undefined,
): string {
	if (!anthropicModel || !account?.model_mappings) {
		return anthropicModel;
	}

	const accountMappings = parseModelMappings(account.model_mappings);
	if (!accountMappings) {
		return anthropicModel;
	}

	const toFirst = (v: string | string[]) => (Array.isArray(v) ? v[0] : v);

	// First try exact match
	if (accountMappings[anthropicModel]) {
		const mappedModel = toFirst(accountMappings[anthropicModel]);
		log.debug(`Exact model mapping: ${anthropicModel} -> ${mappedModel}`);
		return mappedModel;
	}

	// Use shared pattern detection
	const family = getModelFamily(anthropicModel);
	if (family && accountMappings[family]) {
		const mappedModel = toFirst(accountMappings[family]);
		log.debug(
			`Pattern model mapping: ${anthropicModel} (${family}) -> ${mappedModel}`,
		);
		return mappedModel;
	}

	// No mapping found, return original
	return anthropicModel;
}

/**
 * Read a request body ONCE (without `request.clone()`) for model transformation,
 * returning the raw bytes plus a `rebuild` helper that constructs a forwardable
 * Request from a body.
 *
 * Why this exists: `request.clone()` on a body-bearing Request forces Bun to
 * buffer the entire body natively to feed the tee, and that native buffer is
 * never returned to the OS in a long-lived process — leaking ~1× the request
 * body size on every proxied request. Consuming the body with `arrayBuffer()`
 * and rebuilding the Request from the bytes avoids the tee entirely. Because the
 * original body is consumed, callers MUST forward the returned Request.
 */
async function readBodyForTransform(request: Request): Promise<{
	bytes: ArrayBuffer | null;
	rebuild: (body: BodyInit) => Request;
}> {
	const rebuild = (body: BodyInit): Request =>
		new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body,
		});
	try {
		return { bytes: await request.arrayBuffer(), rebuild };
	} catch (error) {
		log.debug("Failed to read request body for model transform:", error);
		return { bytes: null, rebuild };
	}
}

/**
 * Generic model transformation function that can be used by all providers
 * Handles the common pattern of transforming request body models
 *
 * @param request - The incoming request object to transform
 * @param account - The account containing model_mappings configuration
 * @param providerSpecificMapping - Optional provider-specific mapping function
 * @returns A new Request object with transformed body, or the original if no changes needed
 *
 * @example
 * const transformed = await transformRequestBodyModel(request, account);
 * // Transforms the request body model based on account mappings
 */
export async function transformRequestBodyModel<T extends TransformRequestBody>(
	request: Request,
	account?: Account | undefined,
	providerSpecificMapping?: (model: string, account?: Account) => string,
): Promise<Request> {
	// Only JSON bodies carry a model to map; anything else passes through
	// untouched (and is left un-consumed so identity is preserved), matching the
	// openai/codex providers' content-type guard.
	const contentType = request.headers.get("content-type");
	if (!contentType?.includes("application/json")) {
		return request;
	}

	// Read the body ONCE via arrayBuffer rather than `request.clone()` + `.json()`.
	// Cloning a body-bearing Request forces Bun to buffer the entire body natively
	// to feed the tee, and that native buffer is never returned to the OS in this
	// long-lived process — a leak of ~1× the request-body size on EVERY proxied
	// request (the dominant proxy memory leak). Consuming + rebuilding avoids the
	// tee entirely. The original `request` body is consumed here, so callers must
	// use the returned Request (the existing contract — every caller already does).
	const { bytes, rebuild } = await readBodyForTransform(request);
	if (!bytes) return request;

	try {
		const body: T = JSON.parse(new TextDecoder().decode(bytes));

		// Only transform if model field exists
		if (body.model) {
			const originalModel = body.model;
			const mappedModel = providerSpecificMapping
				? providerSpecificMapping(originalModel, account)
				: getModelName(originalModel, account);

			// Only rewrite the body if the model actually changed
			if (mappedModel !== originalModel) {
				body.model = mappedModel;
				log.debug(
					`Mapped model in request: ${originalModel} -> ${mappedModel}`,
				);
				return rebuild(JSON.stringify(body));
			}
		}

		// No model change — forward the original bytes untouched.
		return rebuild(bytes);
	} catch (error) {
		log.debug("Failed to transform request body model:", error);
		// Non-JSON / unexpected body — forward the raw bytes unchanged.
		return rebuild(bytes);
	}
}

/**
 * Optimized model transformation for providers that need to force all models to a specific one
 * Uses direct body object mutation for better performance while creating a new Request object
 *
 * @param request - The incoming request object to transform
 * @param targetModel - The target model name to force all requests to
 * @returns A new Request object with the model forced to targetModel, or the original if no changes needed
 *
 * @example
 * const transformed = await transformRequestBodyModelForce(request, "MiniMax-M2");
 * // Forces all models in the request to "MiniMax-M2"
 */
export async function transformRequestBodyModelForce(
	request: Request,
	targetModel: string,
): Promise<Request> {
	// Non-JSON bodies pass through untouched (un-consumed → identity preserved).
	const contentType = request.headers.get("content-type");
	if (!contentType?.includes("application/json")) {
		return request;
	}

	// Same no-clone rationale as transformRequestBodyModel above: avoid the native
	// body-buffer leak from `request.clone()` by reading the body once and
	// rebuilding the forwardable Request from the bytes.
	const { bytes, rebuild } = await readBodyForTransform(request);
	if (!bytes) return request;

	try {
		const body = JSON.parse(new TextDecoder().decode(bytes));

		// Direct body mutation for performance - avoids object spreading overhead
		if (body && typeof body === "object" && body.model) {
			body.model = targetModel;
			log.debug(`Forced model mapping to: ${targetModel}`);
			return rebuild(JSON.stringify(body));
		}

		// No model field — forward the original bytes untouched.
		return rebuild(bytes);
	} catch (error) {
		log.debug("Failed to force model mapping:", error);
		// Non-JSON / unexpected body — forward the raw bytes unchanged.
		return rebuild(bytes);
	}
}
