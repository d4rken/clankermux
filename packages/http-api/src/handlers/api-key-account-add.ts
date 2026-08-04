import crypto from "node:crypto";
import {
	patterns,
	sanitizers,
	validateAndSanitizeModelMappings,
	validateNumber,
	validateString,
} from "@clankermux/core";
import {
	type DatabaseOperations,
	insertAccountUnique,
} from "@clankermux/database";
import { ValidationError } from "@clankermux/errors";
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";

const log = new Logger("API:Accounts");

/** API-key accounts get a nominal 1-year expiry; there is no token to refresh. */
const API_KEY_ACCOUNT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Where the value written to `accounts.api_key` comes from. */
type ApiKeySource =
	/** Read from the request body and required. */
	| { from: "body" }
	/**
	 * A constant. Ollama is a local server that authenticates nothing, but the
	 * column is NOT NULL and the provider stack expects a value, so a fixed
	 * placeholder stands in.
	 */
	| { from: "fixed"; value: string };

/** Where the value written to `accounts.custom_endpoint` comes from. */
type EndpointSource =
	/** Read from the request body; `required` decides whether omitting it is a 400. */
	| { from: "body"; required: boolean }
	/** A constant (or null when the provider has a single well-known endpoint). */
	| { from: "fixed"; value: string | null };

/**
 * Everything that differs between the API-key-based account-add endpoints.
 *
 * These providers were originally implemented as one hand-written handler each.
 * The handlers were byte-identical apart from the fields below, so adding a
 * provider meant copying ~150 lines including its own INSERT statement, and the
 * copies drifted: two skipped model-mapping sanitization or stored the string
 * "null" in `model_mappings`.
 */
export interface ApiKeyProviderSpec {
	/** Value written to `accounts.provider`. */
	provider: string;
	/** Human-readable name used in the success message and log lines. */
	label: string;
	apiKey: ApiKeySource;
	endpoint: EndpointSource;
	/**
	 * Whether the API key is mirrored into `refresh_token` and `access_token`.
	 *
	 * Most providers do this so the token-refresh path sees a non-null token and
	 * treats the account as permanently valid. Kilo and OpenRouter leave both
	 * NULL instead.
	 */
	mirrorKeyToTokens: boolean;
	/** Whether a `modelMappings` body field is accepted. */
	modelMappings: boolean;
}

/**
 * The API-key providers, keyed by the name their handler factory used to have.
 */
export const API_KEY_PROVIDERS = {
	zai: {
		provider: "zai",
		label: "z.ai",
		apiKey: { from: "body" },
		endpoint: { from: "body", required: false },
		mirrorKeyToTokens: true,
		modelMappings: true,
	},
	openai: {
		provider: "openai-compatible",
		label: "OpenAI-compatible",
		apiKey: { from: "body" },
		endpoint: { from: "body", required: true },
		mirrorKeyToTokens: true,
		modelMappings: true,
	},
	minimax: {
		provider: "minimax",
		label: "Minimax",
		apiKey: { from: "body" },
		endpoint: { from: "fixed", value: null },
		mirrorKeyToTokens: true,
		modelMappings: false,
	},
	anthropicCompatible: {
		provider: "anthropic-compatible",
		label: "Anthropic-compatible",
		apiKey: { from: "body" },
		endpoint: { from: "body", required: false },
		mirrorKeyToTokens: true,
		modelMappings: true,
	},
	ollama: {
		provider: "ollama",
		label: "Ollama",
		apiKey: { from: "fixed", value: "ollama" },
		endpoint: { from: "body", required: false },
		mirrorKeyToTokens: true,
		modelMappings: true,
	},
	ollamaCloud: {
		provider: "ollama-cloud",
		label: "Ollama Cloud",
		apiKey: { from: "body" },
		endpoint: { from: "fixed", value: "https://ollama.com" },
		mirrorKeyToTokens: true,
		modelMappings: true,
	},
	kilo: {
		provider: "kilo",
		label: "Kilo Gateway",
		apiKey: { from: "body" },
		endpoint: { from: "fixed", value: null },
		mirrorKeyToTokens: false,
		modelMappings: true,
	},
	alibabaCodingPlan: {
		provider: "alibaba-coding-plan",
		label: "Alibaba Coding Plan",
		apiKey: { from: "body" },
		endpoint: { from: "fixed", value: null },
		mirrorKeyToTokens: true,
		modelMappings: true,
	},
	openrouter: {
		provider: "openrouter",
		label: "OpenRouter",
		apiKey: { from: "body" },
		endpoint: { from: "fixed", value: null },
		mirrorKeyToTokens: false,
		modelMappings: true,
	},
} as const satisfies Record<string, ApiKeyProviderSpec>;

/**
 * Parse and validate `customEndpoint` as an absolute URL.
 *
 * The rejection is a `ValidationError` rather than a bare `Error` because
 * `validateString` invokes `transform` unwrapped: a bare `Error` carries no
 * `statusCode`, so `errorResponse` falls through to its generic branch and
 * answers a malformed URL with 500. `ValidationError` carries 400.
 */
function readEndpoint(
	body: Record<string, unknown>,
	spec: ApiKeyProviderSpec,
): string | null {
	if (spec.endpoint.from === "fixed") return spec.endpoint.value;

	const required = spec.endpoint.required;
	const raw = required ? body.customEndpoint : body.customEndpoint || null;

	const invalid = () =>
		new ValidationError("customEndpoint must be a valid URL", "customEndpoint");

	const value = validateString(raw, "customEndpoint", {
		required,
		transform: (input: string) => {
			const trimmed = input.trim();
			if (!trimmed) {
				if (required) throw invalid();
				return "";
			}
			try {
				new URL(trimmed);
			} catch {
				throw invalid();
			}
			return trimmed;
		},
	});

	return value || null;
}

/**
 * Parse `modelMappings` into the JSON string stored in `accounts.model_mappings`.
 *
 * Returns a `Response` when the field is present but does not survive
 * sanitization — the caller returns it as-is. Rejecting is deliberate: silently
 * dropping a caller's mappings leaves them with an account that quietly ignores
 * its routing config.
 */
function readModelMappings(
	body: Record<string, unknown>,
	spec: ApiKeyProviderSpec,
): { json: string | null } | { error: Response } {
	if (!spec.modelMappings || !body.modelMappings) return { json: null };

	if (typeof body.modelMappings !== "object") {
		return {
			error: errorResponse(BadRequest("modelMappings must be an object")),
		};
	}

	const sanitized = validateAndSanitizeModelMappings(body.modelMappings);
	if (!sanitized || Object.keys(sanitized).length === 0) {
		return {
			error: errorResponse(
				BadRequest(
					"modelMappings contains no valid entries. Each key and value must be a known model identifier.",
				),
			),
		};
	}

	return { json: JSON.stringify(sanitized) };
}

/**
 * Build the POST handler that creates an account for an API-key provider.
 *
 * Every such provider shares the same request shape (`name`, `apiKey`,
 * `priority`, optionally `customEndpoint` and `modelMappings`), the same INSERT
 * and the same response body; `spec` supplies the differences.
 */
export function createApiKeyAccountAddHandler(
	dbOps: DatabaseOperations,
	spec: ApiKeyProviderSpec,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = (await req.json()) as Record<string, unknown>;

			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
				transform: sanitizers.trim,
			});
			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			let apiKey: string;
			if (spec.apiKey.from === "fixed") {
				apiKey = spec.apiKey.value;
			} else {
				// Trimmed for every provider. Only the Ollama Cloud handler did this
				// originally, but a key is mirrored into refresh_token/access_token,
				// so surrounding whitespace from a paste authenticates as garbage.
				const provided = validateString(body.apiKey, "apiKey", {
					required: true,
					minLength: 1,
					transform: sanitizers.trim,
				});
				if (!provided) {
					return errorResponse(BadRequest("API key is required"));
				}
				apiKey = provided;
			}

			// Priority is validated before the endpoint and mappings so the first
			// error a caller sees matches what the per-provider handlers reported.
			const priority =
				validateNumber(body.priority, "priority", {
					min: 0,
					max: 100,
					integer: true,
				}) || 0;

			const customEndpoint = readEndpoint(body, spec);
			if (spec.endpoint.from === "body" && spec.endpoint.required) {
				if (!customEndpoint) {
					return errorResponse(BadRequest("Endpoint URL is required"));
				}
			}

			const mappings = readModelMappings(body, spec);
			if ("error" in mappings) return mappings.error;

			const accountId = crypto.randomUUID();
			const now = Date.now();
			const token = spec.mirrorKeyToTokens ? apiKey : null;
			const db = dbOps.getAdapter();

			await insertAccountUnique(
				db,
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					spec.provider,
					apiKey,
					token,
					token,
					now + API_KEY_ACCOUNT_TTL_MS,
					now,
					0,
					0,
					priority,
					customEndpoint,
					mappings.json,
				],
				name,
			);

			log.info(
				customEndpoint
					? `Successfully added ${spec.label} account: ${name} (Endpoint: ${customEndpoint}, Priority ${priority})`
					: `Successfully added ${spec.label} account: ${name} (Priority ${priority})`,
			);

			const account = await db.get<{
				id: string;
				name: string;
				provider: string;
				request_count: number;
				total_requests: number;
				last_used: number | null;
				created_at: number;
				expires_at: number;
				refresh_token: string;
				paused: number;
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}

			return jsonResponse({
				message: `${spec.label} account '${name}' added successfully`,
				account: {
					id: account.id,
					name: account.name,
					provider: account.provider,
					requestCount: account.request_count,
					totalRequests: account.total_requests,
					lastUsed: account.last_used
						? new Date(account.last_used).toISOString()
						: null,
					created: new Date(account.created_at).toISOString(),
					paused: account.paused === 1,
					priority: priority,
					// The OpenAI-compatible handler returned this; the others did not.
					// Reported for every provider (null when there is no endpoint)
					// rather than dropped, so no caller loses a field it had.
					customEndpoint,
					tokenStatus: "valid" as const,
					tokenExpiresAt: new Date(account.expires_at).toISOString(),
					rateLimitStatus: "OK",
					rateLimitReset: null,
					rateLimitRemaining: null,
					rateLimitedUntil: null,
					sessionInfo: "No active session",
					hasRefreshToken: false,
				},
			});
		} catch (error) {
			log.error(`${spec.label} account creation error:`, error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error(`Failed to create ${spec.label} account`),
			);
		}
	};
}
