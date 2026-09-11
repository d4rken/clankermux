import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	RoutingRepository,
} from "@clankermux/database";
import {
	createAccountPermissionsHandler,
	createRoutingHandler,
} from "../routing";

let db: Database;
let handler: ReturnType<typeof createRoutingHandler>;
beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	handler = createRoutingHandler(new RoutingRepository(new BunSqlAdapter(db)));
});
afterEach(() => db.close());
const req = (path: string, method = "GET", body?: unknown) =>
	new Request(`http://localhost/api/routing-rules${path}`, {
		method,
		...(body === undefined
			? {}
			: {
					body: JSON.stringify(body),
					headers: { "content-type": "application/json" },
				}),
	});
it("creates, lists, reorders and removes validated rules", async () => {
	const body = {
		name: "Example",
		enabled: true,
		position: 0,
		match_api_key_id: null,
		match_model_kind: "any",
		match_model_value: null,
		pool_kind: "inherit",
		pool_provider: null,
		pool_account_ids: null,
		target_kind: "requested",
		target_model: null,
	};
	const created = await handler(req("", "POST", body));
	expect(created.status).toBe(201);
	const { data } = await created.json();
	expect((await (await handler(req(""))).json()).data).toHaveLength(1);
	expect(
		(await handler(req("/reorder", "PUT", { ids: [data.id] }))).status,
	).toBe(200);
	expect((await handler(req(`/${data.id}`, "DELETE"))).status).toBe(200);
	expect((await (await handler(req(""))).json()).data).toEqual([]);
});
it("rejects stray fields and missing references before persisting", async () => {
	expect((await handler(req("", "POST", { name: "bad" }))).status).toBe(400);
	expect(
		(await handler(req("/reorder", "PUT", { ids: ["missing"] }))).status,
	).toBe(400);
});

it("appends concurrent creates in unique server-allocated positions", async () => {
	const body = {
		name: "Concurrent",
		enabled: true,
		position: 0,
		match_api_key_id: null,
		match_model_kind: "any",
		match_model_value: null,
		pool_kind: "inherit",
		pool_provider: null,
		pool_account_ids: null,
		target_kind: "requested",
		target_model: null,
	};
	const responses = await Promise.all([
		handler(req("", "POST", body)),
		handler(req("", "POST", body)),
	]);
	expect(responses.map((r) => r.status)).toEqual([201, 201]);
	const rows = (await (await handler(req(""))).json()).data;
	expect(rows.map((r: { position: number }) => r.position)).toEqual([0, 1]);
});

it("reports a permission edit race as409 without replacing the newer manual set", async () => {
	const repository = new RoutingRepository(new BunSqlAdapter(db));
	const permission = await repository.setManualModels("a", "scope", [
		"original",
	]);
	const permissionsHandler = createAccountPermissionsHandler(
		{ getAccount: async () => ({ id: "a" }), routing: repository } as never,
		{
			permissions: async () => {
				await repository.setManualModels("a", "scope", ["newer"]);
				return permission;
			},
			refresh: async () => {},
		},
	);
	const response = await permissionsHandler(
		new Request("http://localhost/api/accounts/a/model-permissions", {
			method: "PUT",
			body: JSON.stringify({
				manual_ids: ["stale"],
				generation: permission.generation,
				declare_empty: false,
			}),
		}),
		"a",
	);
	expect(response.status).toBe(409);
	expect((await repository.getPermissions("a"))?.manual_ids).toEqual(["newer"]);
});
