import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@clankermux/database";
import { DatabaseFactory } from "@clankermux/database";
import { createApiKeyRenameHandler } from "../api-keys";

const TEST_DB_PATH = "/tmp/test-api-keys-rename.db";

/** Insert a minimal active API key row and return its generated id. */
async function insertApiKey(
	dbOps: DatabaseOperations,
	name: string,
): Promise<string> {
	const id = crypto.randomUUID();
	await dbOps.createApiKey({
		id,
		name,
		hashedKey: `hash-${id}`,
		prefixLast8: id.slice(-8),
		createdAt: Date.now(),
		isActive: true,
	});
	return id;
}

/** Build a fake POST Request carrying the given JSON body. */
function makeRequest(body: unknown): Request {
	return new Request("http://localhost/api/api-keys/x/rename", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

interface RenameResponse {
	id: string;
	name: string;
	prefixLast8: string;
	usageCount: number;
	isActive: boolean;
}

describe("createApiKeyRenameHandler", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request, idOrName: string) => Promise<Response>;

	beforeAll(() => {
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createApiKeyRenameHandler(dbOps);
	});

	afterAll(() => {
		DatabaseFactory.reset();
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch {
			// ignore
		}
	});

	beforeEach(async () => {
		await dbOps.getAdapter().run("DELETE FROM api_keys", []);
	});

	it("success resolving by id: 200 with the new name; secret/stats preserved", async () => {
		const keyId = await insertApiKey(dbOps, "old-name");
		const before = await dbOps.getApiKey(keyId);

		const response = await handler(makeRequest({ name: "new-name" }), keyId);
		const { success, data } = (await response.json()) as {
			success: boolean;
			data: RenameResponse;
		};

		expect(response.status).toBe(200);
		expect(success).toBe(true);
		expect(data.id).toBe(keyId);
		expect(data.name).toBe("new-name");
		// Secret prefix and stats are preserved.
		expect(data.prefixLast8).toBe(before?.prefixLast8);
		expect(data.usageCount).toBe(before?.usageCount ?? 0);
		expect(data.isActive).toBe(true);

		// Confirm persistence.
		const after = await dbOps.getApiKey(keyId);
		expect(after?.name).toBe("new-name");
		expect(after?.hashedKey).toBe(before?.hashedKey);
	});

	it("success resolving by name (idOrName can be the current name)", async () => {
		const keyId = await insertApiKey(dbOps, "by-name");

		const response = await handler(makeRequest({ name: "renamed" }), "by-name");
		const { data } = (await response.json()) as {
			success: boolean;
			data: RenameResponse;
		};

		expect(response.status).toBe(200);
		expect(data.id).toBe(keyId);
		expect(data.name).toBe("renamed");
	});

	it("trims the name before persisting", async () => {
		const keyId = await insertApiKey(dbOps, "trim-me");

		const response = await handler(makeRequest({ name: "  spaced  " }), keyId);
		const { data } = (await response.json()) as {
			success: boolean;
			data: RenameResponse;
		};

		expect(response.status).toBe(200);
		expect(data.name).toBe("spaced");

		const after = await dbOps.getApiKey(keyId);
		expect(after?.name).toBe("spaced");
	});

	it("409 when renaming to a name held by a different key", async () => {
		const keyId = await insertApiKey(dbOps, "first");
		await insertApiKey(dbOps, "second");

		const response = await handler(makeRequest({ name: "second" }), keyId);
		expect(response.status).toBe(409);

		// The first key keeps its name.
		const after = await dbOps.getApiKey(keyId);
		expect(after?.name).toBe("first");
	});

	it("own-name no-op: renaming a key to its own current name is allowed (200)", async () => {
		const keyId = await insertApiKey(dbOps, "same");

		const response = await handler(makeRequest({ name: "same" }), keyId);
		const { data } = (await response.json()) as {
			success: boolean;
			data: RenameResponse;
		};

		expect(response.status).toBe(200);
		expect(data.name).toBe("same");
	});

	it("own-name no-op also works when only whitespace differs", async () => {
		const keyId = await insertApiKey(dbOps, "same2");

		const response = await handler(makeRequest({ name: "  same2  " }), keyId);
		expect(response.status).toBe(200);
		const { data } = (await response.json()) as {
			success: boolean;
			data: RenameResponse;
		};
		expect(data.name).toBe("same2");
	});

	it("404 when the id/name is unknown", async () => {
		const response = await handler(
			makeRequest({ name: "whatever" }),
			"no-such-key",
		);
		expect(response.status).toBe(404);
	});

	it("400 when the name is empty", async () => {
		const keyId = await insertApiKey(dbOps, "needs-name");

		const response = await handler(makeRequest({ name: "" }), keyId);
		expect(response.status).toBe(400);
	});

	it("400 when the name is whitespace only", async () => {
		const keyId = await insertApiKey(dbOps, "needs-name-2");

		const response = await handler(makeRequest({ name: "   " }), keyId);
		expect(response.status).toBe(400);
	});

	it("400 when the name field is missing entirely", async () => {
		const keyId = await insertApiKey(dbOps, "needs-name-3");

		const response = await handler(makeRequest({}), keyId);
		expect(response.status).toBe(400);
	});

	it("400 when the name exceeds 100 characters", async () => {
		const keyId = await insertApiKey(dbOps, "needs-short");

		const response = await handler(
			makeRequest({ name: "a".repeat(101) }),
			keyId,
		);
		expect(response.status).toBe(400);
	});

	it("400 (not 500) when the body is not valid JSON", async () => {
		const keyId = await insertApiKey(dbOps, "needs-json");
		const req = new Request("http://localhost/api/api-keys/x/rename", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not-json",
		});

		const response = await handler(req, keyId);
		expect(response.status).toBe(400);

		// The name is untouched by a rejected request.
		const after = await dbOps.getApiKey(keyId);
		expect(after?.name).toBe("needs-json");
	});

	it("400 (not 500) when the JSON body is not an object", async () => {
		const keyId = await insertApiKey(dbOps, "needs-object");

		// A top-level null would throw on `body.name` if not guarded.
		const response = await handler(makeRequest(null), keyId);
		expect(response.status).toBe(400);
	});
});
