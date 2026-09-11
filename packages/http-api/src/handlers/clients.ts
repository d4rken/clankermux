import {
	type DatabaseOperations,
	RoutingConflictError,
} from "@clankermux/database";
import { BadRequest, NotFound } from "@clankermux/errors";
import type {
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
				if (path.endsWith("/suggestions"))
					return ok(
						await manager.suggestions(body.destinations, body.refresh === true),
					);
				if (path.endsWith("/review")) return ok(await manager.review(body));
				if (typeof body.token !== "string")
					throw BadRequest("Review token is required");
				return ok(await manager.commit(body.token));
			}
			const match =
				/^\/api\/clients\/([^/]+)(?:\/(enable|disable|rotate))?$/.exec(path);
			if (!match) throw NotFound("Client endpoint not found");
			const id = decodeURIComponent(match[1]!);
			const key = await dbOps.getApiKey(id);
			if (!key) throw NotFound("Client not found");
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
			if (
				error instanceof RoutingConflictError ||
				(error instanceof Error &&
					/referenced by routing rules|conflicts with API key destinations|UNIQUE constraint failed/.test(
						error.message,
					))
			)
				return Response.json({ error: error.message }, { status: 409 });
			return errorResponse(error);
		}
	};
}
