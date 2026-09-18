import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	ModelAliasRepository,
} from "@clankermux/database";
import { createModelAliasesHandler } from "../model-aliases";

describe("model alias management", () => {
	let db: Database;
	let handler: ReturnType<typeof createModelAliasesHandler>;
	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		handler = createModelAliasesHandler(
			new ModelAliasRepository(new BunSqlAdapter(db)),
		);
	});
	afterEach(() => db.close());
	const request = (method: string, path = "", body?: unknown) =>
		new Request(`http://localhost/api/model-aliases${path}`, {
			method,
			...(body === undefined
				? {}
				: {
						body: JSON.stringify(body),
						headers: { "content-type": "application/json" },
					}),
		});
	it("creates, lists, edits, and deletes aliases using revision preconditions", async () => {
		const input = {
			id: "alias:good",
			displayName: "Good",
			revision: 0,
			targets: [{ model: "gpt-6-astra", accountIds: null }],
		};
		const created = await handler(request("POST", "", input));
		expect(created.status).toBe(201);
		const { data } = await created.json();
		expect(data.revision).toBe(1);
		expect((await handler(request("POST", "", input))).status).toBe(409);
		expect(await (await handler(request("GET"))).json()).toEqual({
			data: [data],
		});
		expect(
			(
				await handler(
					request("PUT", "/alias%3Agood", { ...data, displayName: "Better" }),
				)
			).status,
		).toBe(200);
		expect(
			(await handler(request("DELETE", "/alias%3Agood", { revision: 1 })))
				.status,
		).toBe(409);
		expect(
			(await handler(request("DELETE", "/alias%3Agood", { revision: 2 })))
				.status,
		).toBe(200);
	});
	it("returns a useful conflict for aliases referenced by client catalogues", async () => {
		const input = {
			id: "alias:good",
			displayName: "Good",
			revision: 0,
			targets: [{ model: "gpt-6-astra", accountIds: null }],
		};
		await handler(request("POST", "", input));
		db.run(
			"INSERT INTO api_keys(id,name,hashed_key,prefix_last_8,created_at,is_active) VALUES('key','Client','hash','last8',0,1)",
		);
		db.query(
			"INSERT INTO client_profiles(api_key_id,application,revision,catalogues,notices) VALUES('key','generic',1,?,'[]')",
		).run(
			JSON.stringify({
				openai: {
					models: [{ id: input.id, targetModel: input.id }],
					defaultModel: input.id,
				},
			}),
		);
		const response = await handler(
			request("DELETE", "/alias%3Agood", { revision: 1 }),
		);
		expect(response.status).toBe(409);
		expect((await response.json()).error).toContain("client catalogues");
	});
	it("reports invalid input and missing aliases", async () => {
		expect((await handler(request("POST", "", {}))).status).toBe(400);
		expect((await handler(request("PUT", "/alias%3Amissing", {}))).status).toBe(
			404,
		);
		expect(
			(await handler(request("DELETE", "/alias%3Amissing", { revision: 1 })))
				.status,
		).toBe(404);
		expect((await handler(request("GET", "/bad/extra"))).status).toBe(404);
	});
});
