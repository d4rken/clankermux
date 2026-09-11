import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { DatabaseOperations } from "@clankermux/database";
import { tempDbTracker } from "@clankermux/test-support";
import { NodeCryptoUtils } from "@clankermux/types";
import type { ClientManager } from "./clients";
import { createClientsHandler } from "./clients";

describe("client management boundary", () => {
	const handle = createClientsHandler(
		{
			review: async () => {
				throw new Error("must not reach service");
			},
		} as unknown as ClientManager,
		{} as DatabaseOperations,
	);
	it("rejects invalid JSON and non-object drafts as 400", async () => {
		for (const body of ["{", "null", "[]", '"text"'])
			expect(
				(
					await handle(
						new Request("http://test/api/clients/review", {
							method: "POST",
							body,
						}),
						new URL("http://test/api/clients/review"),
					)
				).status,
			).toBe(400);
	});
	it("requires an explicit review token to commit", async () => {
		expect(
			(
				await handle(
					new Request("http://test/api/clients/commit", {
						method: "POST",
						body: "{}",
					}),
					new URL("http://test/api/clients/commit"),
				)
			).status,
		).toBe(400);
	});
});

const temp = tempDbTracker("clients-http");
describe("client lifecycle HTTP boundary", () => {
	let db: DatabaseOperations;
	let handle: ReturnType<typeof createClientsHandler>;
	const request = (suffix: string, method = "POST") => {
		const url = new URL(`http://test/api/clients/stable${suffix}`);
		return handle(new Request(url, { method }), url);
	};
	beforeEach(async () => {
		db = new DatabaseOperations(temp.next());
		await db.createApiKey({
			id: "stable",
			name: "Original",
			hashedKey: "old-hash",
			prefixLast8: "oldtoken",
			createdAt: 10,
			isActive: true,
		});
		handle = createClientsHandler(
			{
				remove: async (id: string) => {
					await db.deleteApiKey(id);
				},
			} as ClientManager,
			db,
		);
	});
	afterEach(async () => {
		await db.dispose();
		temp.cleanup();
	});
	it("disables, enables, rotates and deletes by stable identity", async () => {
		expect((await request("/disable")).status).toBe(200);
		expect((await db.getApiKey("stable"))?.isActive).toBe(false);
		expect((await request("/rotate")).status).toBe(400);
		expect((await request("/enable")).status).toBe(200);
		const rotated = await request("/rotate");
		expect(rotated.status).toBe(200);
		expect(rotated.headers.get("cache-control")).toBe("private, no-store");
		const secret = (await rotated.json()).data.apiKey;
		const key = await db.getApiKey("stable");
		expect(key?.hashedKey).toBe(await new NodeCryptoUtils().hashApiKey(secret));
		expect(key?.prefixLast8).toBe(secret.slice(-8));
		expect(key?.name).toBe("Original");
		expect((await request("", "DELETE")).status).toBe(200);
		expect(await db.getApiKey("stable")).toBeNull();
	});
	it("returns 409 without a secret if rotation loses its optimistic swap", async () => {
		const swap = spyOn(db, "rotateApiKeySecret").mockResolvedValue(false);
		try {
			const response = await request("/rotate");
			expect(response.status).toBe(409);
			expect(await response.json()).not.toHaveProperty("data.apiKey");
			expect((await db.getApiKey("stable"))?.hashedKey).toBe("old-hash");
		} finally {
			swap.mockRestore();
		}
	});
	it("maps a manual routing reference to 409 and keeps the key", async () => {
		await db.routing.saveRule({
			id: "manual",
			name: "Manual",
			position: 0,
			enabled: true,
			match_api_key_id: "stable",
			match_model_kind: "any",
			match_model_value: null,
			pool_kind: "inherit",
			pool_provider: null,
			pool_account_ids: null,
			target_kind: "requested",
			target_model: null,
		});
		expect((await request("", "DELETE")).status).toBe(409);
		expect(await db.getApiKey("stable")).not.toBeNull();
	});
});
