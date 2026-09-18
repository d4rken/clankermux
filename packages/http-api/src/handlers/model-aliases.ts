import { validateModelAlias } from "@clankermux/core";
import {
	ModelAliasConflictError,
	type ModelAliasRepository,
} from "@clankermux/database";

export function createModelAliasesHandler(repository: ModelAliasRepository) {
	return async (req: Request): Promise<Response> => {
		try {
			const parts = new URL(req.url).pathname.split("/");
			if (parts.length > 4)
				return Response.json({ error: "Not found" }, { status: 404 });
			const id = parts[3] ? decodeURIComponent(parts[3]) : null;
			if (req.method === "GET" && !id)
				return Response.json({ data: await repository.list() });
			if ((req.method === "POST" && !id) || (req.method === "PUT" && id)) {
				if (id && !(await repository.get(id)))
					return Response.json(
						{ error: "Model alias not found" },
						{ status: 404 },
					);
				const body = await req.json();
				if (id && body.id !== id)
					throw new Error("Alias ID must match the URL");
				const alias = validateModelAlias(body);
				if (!id && alias.revision !== 0)
					throw new Error("New aliases require revision zero");
				if (id && alias.revision === 0)
					throw new Error("Existing aliases require their current revision");
				return Response.json(
					{ data: await repository.save(alias) },
					{ status: id ? 200 : 201 },
				);
			}
			if (req.method === "DELETE" && id) {
				const body = await req.json();
				if (!(await repository.remove(id, body.revision)))
					return Response.json(
						{ error: "Model alias not found" },
						{ status: 404 },
					);
				return Response.json({ success: true });
			}
			return Response.json({ error: "Method not allowed" }, { status: 405 });
		} catch (error) {
			return Response.json(
				{
					error: error instanceof Error ? error.message : "Invalid model alias",
				},
				{ status: error instanceof ModelAliasConflictError ? 409 : 400 },
			);
		}
	};
}
