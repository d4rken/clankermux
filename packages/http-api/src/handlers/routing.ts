import { validateRoutingRule } from "@clankermux/core";
import {
	RoutingConflictError,
	type RoutingRepository,
} from "@clankermux/database";

export function createRoutingHandler(repository: RoutingRepository) {
	return async (req: Request): Promise<Response> => {
		const parts = new URL(req.url).pathname.split("/");
		const id = parts[3] ? decodeURIComponent(parts[3]) : null;
		try {
			if (parts.length > 4)
				return Response.json({ error: "Not found" }, { status: 404 });
			if (req.method === "GET" && !id)
				return Response.json({ data: await repository.listRules() });
			if (req.method === "PUT" && id === "reorder") {
				const body = await req.json();
				if (
					!Array.isArray(body.ids) ||
					body.ids.some((x: unknown) => typeof x !== "string")
				)
					throw new Error("ids must list every rule exactly once");
				await repository.reorderRules(body.ids);
				return Response.json({ data: await repository.listRules() });
			}
			if ((req.method === "POST" && !id) || (req.method === "PUT" && id)) {
				if (id && !(await repository.listRules()).some((r) => r.id === id))
					return Response.json({ error: "Rule not found" }, { status: 404 });
				const body = await req.json();
				const rule = validateRoutingRule({
					...body,
					id: id ?? crypto.randomUUID(),
				});
				const saved = await repository.saveRule(rule, !id);
				return Response.json({ data: saved }, { status: id ? 200 : 201 });
			}
			if (req.method === "DELETE" && id) {
				await repository.removeRule(id);
				return Response.json({ success: true });
			}
			return Response.json({ error: "Method not allowed" }, { status: 405 });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error ? error.message : "Invalid routing rule",
				},
				{ status: error instanceof RoutingConflictError ? 409 : 400 },
			);
		}
	};
}

export interface AccountPermissionReader {
	tick?(): Promise<void>;
	permissions(
		account: import("@clankermux/types").Account,
	): Promise<import("@clankermux/types").AccountModelPermissions>;
	refresh(
		account: import("@clankermux/types").Account,
		manual?: boolean,
	): Promise<void>;
}
export function createAccountPermissionsHandler(
	dbOps: import("@clankermux/database").DatabaseOperations,
	reader: AccountPermissionReader | undefined,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		if (!reader)
			return Response.json(
				{ error: "Model discovery is unavailable" },
				{ status: 503 },
			);
		const account = await dbOps.getAccount(accountId);
		if (!account)
			return Response.json({ error: "Account not found" }, { status: 404 });
		try {
			let permissions = await reader.permissions(account);
			if (req.method === "POST") {
				await reader.refresh(account, true);
				permissions = await reader.permissions(account);
			} else if (req.method === "PUT") {
				const body = await req.json();
				if (
					!Number.isSafeInteger(body.generation) ||
					body.generation !== permissions.generation
				)
					return Response.json(
						{ error: "Model settings changed; reload before saving" },
						{ status: 409 },
					);
				if (
					!Array.isArray(body.manual_ids) ||
					typeof body.declare_empty !== "boolean"
				)
					throw new Error(
						"Manual models and explicit empty-set choice are required",
					);
				permissions = await dbOps.routing.setManualModels(
					accountId,
					permissions.scope,
					body.manual_ids,
					body.declare_empty,
					body.generation,
				);
			} else if (req.method !== "GET")
				return Response.json({ error: "Method not allowed" }, { status: 405 });
			const { scope: _scope, ...view } = permissions;
			return Response.json({ data: view });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error ? error.message : "Invalid model settings",
				},
				{ status: error instanceof RoutingConflictError ? 409 : 400 },
			);
		}
	};
}
