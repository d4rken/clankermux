import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { scryptSync } from "node:crypto";
import { DatabaseOperations } from "@clankermux/database";
import { tempDbTracker } from "@clankermux/test-support";
import { NodeCryptoUtils } from "@clankermux/types";
import { generateApiKey, regenerateApiKey } from "../services/admin/api-keys";
import { AuthService } from "../services/auth-service";
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

describe("client endpoint dispatch", () => {
	const calls: { method: string; argument: unknown }[] = [];
	const record = <T>(method: string, result: T) => {
		return async (argument: unknown, refresh?: boolean) => {
			calls.push({
				method,
				argument: refresh === undefined ? argument : { argument, refresh },
			});
			return result;
		};
	};
	const handle = createClientsHandler(
		{
			suggestions: record("suggestions", { models: [], accounts: [] }),
			review: record("review", { token: "single-review" }),
			commit: record("commit", { client: {} }),
			bulkReview: record("bulkReview", { token: "bulk-review" }),
			bulkCommit: record("bulkCommit", { clients: [] }),
		} as unknown as ClientManager,
		{} as DatabaseOperations,
	);
	const post = async (path: string, body: unknown) => {
		const url = new URL(`http://test${path}`);
		const response = await handle(
			new Request(url, { method: "POST", body: JSON.stringify(body) }),
			url,
		);
		return { status: response.status, data: (await response.json()).data };
	};
	beforeEach(() => {
		calls.length = 0;
	});
	// `/api/clients/bulk/review` also ends with "/review": a suffix match would
	// hand the batch to the single-client reviewer, and the bulk commit token to
	// the single-client commit.
	it("keeps the bulk paths away from the single-client methods", async () => {
		expect(
			await post("/api/clients/bulk/review", { clientIds: ["a"] }),
		).toEqual({ status: 200, data: { token: "bulk-review" } });
		expect(await post("/api/clients/bulk/commit", { token: "t" })).toEqual({
			status: 200,
			data: { clients: [] },
		});
		expect(calls).toEqual([
			{ method: "bulkReview", argument: { clientIds: ["a"] } },
			{ method: "bulkCommit", argument: "t" },
		]);
	});
	it("still routes the single-client paths and passes suggestions destinations", async () => {
		expect(await post("/api/clients/review", { name: "One" })).toEqual({
			status: 200,
			data: { token: "single-review" },
		});
		expect((await post("/api/clients/commit", { token: "s" })).status).toBe(
			200,
		);
		expect(
			(
				await post("/api/clients/suggestions", {
					destinations: { accountId: null, providers: null },
					refresh: true,
				})
			).status,
		).toBe(200);
		expect(calls).toEqual([
			{ method: "review", argument: { name: "One" } },
			{ method: "commit", argument: "s" },
			{
				method: "suggestions",
				argument: {
					argument: { accountId: null, providers: null },
					refresh: true,
				},
			},
		]);
	});
	it("requires a token on either commit path", async () => {
		expect((await post("/api/clients/commit", {})).status).toBe(400);
		expect((await post("/api/clients/bulk/commit", {})).status).toBe(400);
		expect(calls).toEqual([]);
	});
});

const temp = tempDbTracker("clients-http");
describe("client lifecycle HTTP boundary", () => {
	let db: DatabaseOperations;
	let handle: ReturnType<typeof createClientsHandler>;
	const request = (suffix: string, method = "POST", body?: unknown) => {
		const url = new URL(`http://test/api/clients/stable${suffix}`);
		return handle(
			new Request(url, {
				method,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
			url,
		);
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
	it("retrieves rotated keys only through the no-store setup endpoint", async () => {
		expect(
			(await (await request("/setup-key", "GET")).json()).data.apiKey,
		).toBeNull();
		const secret = (await (await request("/rotate")).json()).data.apiKey;
		const response = await request("/setup-key", "GET");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect((await response.json()).data.apiKey).toBe(secret);
		expect(JSON.stringify(await db.getApiKeys())).not.toContain(secret);
		await request("/disable");
		expect(
			(await (await request("/setup-key", "GET")).json()).data.apiKey,
		).toBe(secret);
		await request("", "DELETE");
		expect((await request("/setup-key", "GET")).status).toBe(404);
	});
	it("remembers a matching legacy key without changing its identity or authentication", async () => {
		const crypto = new NodeCryptoUtils();
		const secret = await crypto.generateApiKey();
		await db.rotateApiKeySecret(
			"stable",
			"old-hash",
			await crypto.hashApiKey(secret),
			secret.slice(-8),
		);
		const before = await db.getApiKey("stable");
		expect(
			(await request("/setup-key", "POST", { apiKey: "wrong" })).status,
		).toBe(400);
		expect(
			(await request("/setup-key", "POST", { apiKey: secret })).status,
		).toBe(200);
		expect(await db.getApiKey("stable")).toEqual(before);
		expect(
			(await (await request("/setup-key", "GET")).json()).data.apiKey,
		).toBe(secret);
		const next = (await (await request("/rotate")).json()).data.apiKey;
		expect(next).not.toBe(secret);
		expect(
			(await (await request("/setup-key", "GET")).json()).data.apiKey,
		).toBe(next);
		expect(
			(await request("/setup-key", "POST", { apiKey: secret })).status,
		).toBe(400);
	});
	it("rejects malformed imports and a key rotated during verification", async () => {
		for (const body of [null, [], {}, { apiKey: 42 }])
			expect((await request("/setup-key", "POST", body)).status).toBe(400);
		const verify = spyOn(
			NodeCryptoUtils.prototype,
			"verifyApiKey",
		).mockImplementation(async () => {
			await db.rotateApiKeySecret(
				"stable",
				"old-hash",
				"racing-hash",
				"newtoken",
			);
			return true;
		});
		try {
			expect(
				(await request("/setup-key", "POST", { apiKey: "previous" })).status,
			).toBe(409);
			expect(
				(await (await request("/setup-key", "GET")).json()).data.apiKey,
			).toBeNull();
		} finally {
			verify.mockRestore();
		}
	});

	it("captures credentials from the compatibility key creation and rotation APIs", async () => {
		const created = await generateApiKey(db, "Compatibility");
		expect(await db.getApiKeySetupSecret(created.id)).toBe(created.apiKey);
		const rotated = await regenerateApiKey(db, "Compatibility");
		expect(await db.getApiKeySetupSecret(created.id)).toBe(rotated.apiKey);
		expect(rotated.apiKey).not.toBe(created.apiKey);
	});
	it("preserves an imported scrypt key when authentication upgrades its hash", async () => {
		const secret = "btr-legacy-imported-secret";
		const salt = "00112233445566778899aabbccddeeff";
		const hash = `${salt}:${scryptSync(secret, salt, 64).toString("hex")}`;
		await db.rotateApiKeySecret("stable", "old-hash", hash, secret.slice(-8));
		expect(
			(await request("/setup-key", "POST", { apiKey: secret })).status,
		).toBe(200);
		const auth = new AuthService(db);
		const result = await auth.authenticateRequest(
			new Request("http://test/v1/models", {
				headers: { "x-api-key": secret },
			}),
			"/v1/models",
			"GET",
			"api-key",
		);
		expect(result.isAuthenticated).toBe(true);
		for (
			let i = 0;
			i < 100 && (await db.getApiKey("stable"))?.hashedKey === hash;
			i++
		)
			await new Promise((r) => setTimeout(r, 1));
		expect((await db.getApiKey("stable"))?.hashedKey).toBe(
			await new NodeCryptoUtils().hashApiKey(secret),
		);
		expect(await db.getApiKeySetupSecret("stable")).toBe(secret);
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
