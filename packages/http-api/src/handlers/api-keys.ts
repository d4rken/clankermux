import type { DatabaseOperations } from "@clankermux/database";
import { BadRequest, NotFound } from "@clankermux/errors";
import {
	type ApiKeyGenerationResult,
	isKnownProvider,
	PROVIDER_NAMES,
	toApiKeyResponse,
} from "@clankermux/types";
import {
	deleteApiKey,
	disableApiKey,
	enableApiKey,
	generateApiKey,
	listApiKeys,
	regenerateApiKey,
	renameApiKey,
} from "../services/admin/api-keys";
import { errorResponse } from "../utils/http-error";

export function createApiKeysListHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const apiKeys = await listApiKeys(dbOps);
			const response = {
				success: true,
				data: apiKeys,
				count: apiKeys.length,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeysGenerateHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();
			const { name } = body;

			if (!name || typeof name !== "string" || name.trim().length === 0) {
				return errorResponse(
					BadRequest("Name is required and must be a non-empty string"),
				);
			}

			const result = await generateApiKey(dbOps, name.trim());
			const response: ApiKeyGenerationResult = {
				id: result.id,
				name: result.name,
				apiKey: result.apiKey, // Full key shown only once
				prefixLast8: result.prefixLast8,
				createdAt: result.createdAt,
			};

			return new Response(JSON.stringify({ success: true, data: response }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyDisableHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, name: string): Promise<Response> => {
		try {
			await disableApiKey(dbOps, name);
			const response = {
				success: true,
				message: `API key '${name}' disabled successfully`,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyEnableHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, name: string): Promise<Response> => {
		try {
			await enableApiKey(dbOps, name);
			const response = {
				success: true,
				message: `API key '${name}' enabled successfully`,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyRegenerateHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, name: string): Promise<Response> => {
		try {
			const result = await regenerateApiKey(dbOps, name);
			return new Response(JSON.stringify({ success: true, data: result }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyPinHandler(dbOps: DatabaseOperations) {
	return async (req: Request, keyIdOrName: string): Promise<Response> => {
		try {
			// Resolve the key by id first, then fall back to name (mirrors the way
			// the router passes a keyIdOrName segment).
			const apiKey =
				(await dbOps.getApiKey(keyIdOrName)) ??
				(await dbOps.getApiKeyByName(keyIdOrName));
			if (!apiKey) {
				return errorResponse(NotFound(`API key '${keyIdOrName}' not found`));
			}

			// A pin is a security-sensitive routing constraint, so a malformed body
			// must NOT silently clear it. Invalid JSON / a non-object body → 400.
			// An explicit JSON object with no accountId/providers (or `null`) clears.
			let body: { accountId?: unknown; providers?: unknown };
			try {
				const parsed = await req.json();
				// Only a JSON object is a valid request. Clearing is an explicit
				// object (`{}` / `{accountId:null}` / `{providers:null}`); top-level
				// null, arrays, and scalars are rejected so they can't silently
				// clear a pin.
				if (
					typeof parsed === "object" &&
					parsed !== null &&
					!Array.isArray(parsed)
				) {
					body = parsed as { accountId?: unknown; providers?: unknown };
				} else {
					return errorResponse(
						BadRequest("Request body must be a JSON object."),
					);
				}
			} catch {
				return errorResponse(BadRequest("Invalid JSON body."));
			}

			// Reject typed-but-invalid field shapes so a wrong-typed field (e.g.
			// {providers:"codex"} or {accountId:123}) can't slip into the clear
			// branch and silently drop a pin. Allowed: accountId = omitted | null |
			// non-empty string; providers = omitted | null | non-empty string[].
			if (
				body.accountId !== undefined &&
				body.accountId !== null &&
				!(typeof body.accountId === "string" && body.accountId.length > 0)
			) {
				return errorResponse(
					BadRequest("accountId must be a non-empty string, null, or omitted."),
				);
			}
			if (
				body.providers !== undefined &&
				body.providers !== null &&
				!(
					Array.isArray(body.providers) &&
					body.providers.length > 0 &&
					body.providers.every((p) => typeof p === "string")
				)
			) {
				return errorResponse(
					BadRequest(
						"providers must be a non-empty array of strings, null, or omitted.",
					),
				);
			}

			const hasAccount =
				typeof body.accountId === "string" && body.accountId.length > 0;
			const hasProviders =
				Array.isArray(body.providers) && body.providers.length > 0;

			// accountId and providers are mutually exclusive on the wire.
			if (hasAccount && hasProviders) {
				return errorResponse(
					BadRequest("Specify either accountId or providers, not both."),
				);
			}

			if (hasAccount) {
				const accountId = body.accountId as string;
				const account = await dbOps.getAccount(accountId);
				if (!account) {
					return errorResponse(
						BadRequest(`Account ${accountId} does not exist.`),
					);
				}
				await dbOps.updateApiKeyPin(apiKey.id, accountId, null);
			} else if (hasProviders) {
				const requested = body.providers as unknown[];
				const invalid: string[] = [];
				const valid: string[] = [];
				const seen = new Set<string>();
				for (const entry of requested) {
					if (typeof entry !== "string" || !isKnownProvider(entry)) {
						invalid.push(String(entry));
						continue;
					}
					if (!seen.has(entry)) {
						seen.add(entry);
						valid.push(entry);
					}
				}
				if (invalid.length > 0) {
					const allowed = Object.values(PROVIDER_NAMES).join(", ");
					return errorResponse(
						BadRequest(
							`Unknown provider(s): ${invalid.join(", ")}. Allowed providers: ${allowed}.`,
						),
					);
				}
				await dbOps.updateApiKeyPin(apiKey.id, null, valid);
			} else {
				// Both absent/null/empty → clear the pin.
				await dbOps.updateApiKeyPin(apiKey.id, null, null);
			}

			// Re-fetch using the resolved id so the response reflects the new pin in
			// the same shape the list endpoint returns.
			const updated = await dbOps.getApiKey(apiKey.id);
			if (!updated) {
				return errorResponse(
					NotFound(`API key '${keyIdOrName}' not found after update`),
				);
			}

			// Wrap in the { success, data } envelope used by the sibling api-keys
			// handlers (list/generate/regenerate) for response-shape consistency.
			return new Response(
				JSON.stringify({ success: true, data: toApiKeyResponse(updated) }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyRenameHandler(dbOps: DatabaseOperations) {
	return async (req: Request, idOrName: string): Promise<Response> => {
		try {
			// A malformed/non-object body must be a 400, not a 500. Mirror the pin
			// handler: reject invalid JSON and non-object payloads (incl. top-level
			// null/arrays/scalars) before touching the service.
			let body: { name?: unknown };
			try {
				const parsed = await req.json();
				if (
					typeof parsed !== "object" ||
					parsed === null ||
					Array.isArray(parsed)
				) {
					return errorResponse(
						BadRequest("Request body must be a JSON object."),
					);
				}
				body = parsed as { name?: unknown };
			} catch {
				return errorResponse(BadRequest("Invalid JSON body."));
			}

			// A missing/non-string name becomes "" so the service's validation
			// reports the empty-name 400 rather than throwing.
			const name = typeof body.name === "string" ? body.name : "";
			const result = await renameApiKey(dbOps, idOrName, name);
			return new Response(JSON.stringify({ success: true, data: result }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyDeleteHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, name: string): Promise<Response> => {
		try {
			await deleteApiKey(dbOps, name);
			const response = {
				success: true,
				message: `API key '${name}' deleted successfully`,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeysStatsHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const total = await dbOps.countAllApiKeys();
			const active = await dbOps.countActiveApiKeys();
			const inactive = total - active;

			const response = {
				success: true,
				data: {
					total,
					active,
					inactive,
				},
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}
