import {
	type DatabaseOperations,
	isClientInputError,
	RoutingConflictError,
} from "@clankermux/database";
import { BadRequest, Conflict, NotFound } from "@clankermux/errors";
import type {
	ClientBulkReview,
	ClientReview,
	ClientSuggestions,
	ClientView,
} from "@clankermux/types";
import { apiKeyLookupSuffix, NodeCryptoUtils } from "@clankermux/types";
import { errorResponse } from "../utils/http-error";

export interface ClientManager {
	list(): Promise<ClientView[]>;
	suggestions(input: unknown, refresh?: boolean): Promise<ClientSuggestions>;
	review(input: unknown): Promise<ClientReview>;
	commit(token: string): Promise<{ client: ClientView; apiKey?: string }>;
	bulkReview(input: unknown): Promise<ClientBulkReview>;
	bulkCommit(token: string): Promise<{ clients: ClientView[] }>;
	remove(id: string): Promise<void>;
}
export function createClientsHandler(
	manager: ClientManager,
	dbOps: DatabaseOperations,
) {
	return async (req: Request, url: URL): Promise<Response> => {
		const ok = (data: unknown, status = 200) =>
			Response.json(
				{ data },
				{ status, headers: { "Cache-Control": "private, no-store" } },
			);
		try {
			const path = url.pathname;
			if (path === "/api/clients" && req.method === "GET")
				return ok(await manager.list());
			if (
				req.method === "POST" &&
				[
					"/api/clients/suggestions",
					"/api/clients/review",
					"/api/clients/commit",
					"/api/clients/bulk/review",
					"/api/clients/bulk/commit",
				].includes(path)
			) {
				let body: Record<string, unknown>;
				try {
					body = await req.json();
				} catch {
					throw BadRequest("Invalid JSON body");
				}
				if (!body || typeof body !== "object" || Array.isArray(body))
					throw BadRequest("Request must be an object");
				// Exact paths, not suffixes: "/api/clients/bulk/review" ends with
				// "/review" too, and a batch handed to the single-client reviewer
				// fails as a malformed draft.
				if (path === "/api/clients/suggestions")
					return ok(
						await manager.suggestions(body.destinations, body.refresh === true),
					);
				if (path === "/api/clients/review")
					return ok(await manager.review(body));
				if (path === "/api/clients/bulk/review")
					return ok(await manager.bulkReview(body));
				if (typeof body.token !== "string")
					throw BadRequest("Review token is required");
				if (path === "/api/clients/bulk/commit")
					return ok(await manager.bulkCommit(body.token));
				return ok(await manager.commit(body.token));
			}
			const match =
				/^\/api\/clients\/([^/]+)(?:\/(enable|disable|rotate|setup-key))?$/.exec(
					path,
				);
			if (!match) throw NotFound("Client endpoint not found");
			const id = decodeURIComponent(match[1]!);
			const key = await dbOps.getApiKey(id);
			if (!key) throw NotFound("Client not found");
			if (match[2] === "setup-key") {
				if (req.method === "GET")
					return ok({ apiKey: await dbOps.getApiKeySetupSecret(id) });
				if (req.method === "POST") {
					let body: unknown;
					try {
						body = await req.json();
					} catch {
						throw BadRequest("Invalid JSON body");
					}
					if (
						!body ||
						typeof body !== "object" ||
						!("apiKey" in body) ||
						typeof body.apiKey !== "string" ||
						!body.apiKey.length ||
						body.apiKey.length > 512
					)
						throw BadRequest("Enter the existing API key for this client");
					if (
						!(await new NodeCryptoUtils().verifyApiKey(
							body.apiKey,
							key.hashedKey,
						))
					)
						throw BadRequest("This API key does not match the client");
					if (
						!(await dbOps.saveApiKeySetupSecret(id, key.hashedKey, body.apiKey))
					)
						throw Conflict("Client changed; reopen setup and try again");
					return ok({ apiKey: body.apiKey });
				}
			}

			if (req.method === "DELETE" && !match[2]) {
				await manager.remove(id);
				return ok({ deleted: true });
			}
			if (req.method === "POST") {
				if (match[2] === "enable" || match[2] === "disable") {
					const changed = await (match[2] === "enable"
						? dbOps.enableApiKey(id)
						: dbOps.disableApiKey(id));
					if (!changed) throw NotFound("Client not found");
					return ok({ updated: true });
				}
				if (match[2] === "rotate") {
					if (!key.isActive)
						throw BadRequest("Enable the client before rotating its key");
					const crypto = new NodeCryptoUtils();
					const apiKey = await crypto.generateApiKey();
					if (
						!(await dbOps.rotateApiKeySecret(
							id,
							key.hashedKey,
							await crypto.hashApiKey(apiKey),
							apiKeyLookupSuffix(apiKey),
							apiKey,
						))
					)
						throw new RoutingConflictError(
							"Client changed; reload before rotating",
						);
					return ok({ apiKey });
				}
			}
			throw NotFound("Client endpoint not found");
		} catch (error) {
			if (isClientInputError(error))
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 409 },
				);
			return errorResponse(error);
		}
	};
}
