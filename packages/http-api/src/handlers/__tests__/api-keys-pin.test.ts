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
import { createApiKeyPinHandler } from "../api-keys";

const TEST_DB_PATH = "/tmp/test-api-keys-pin.db";

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

/** Insert a minimal account row and return its generated id. */
async function insertAccount(
	dbOps: DatabaseOperations,
	name: string,
): Promise<string> {
	const db = dbOps.getAdapter();
	const id = crypto.randomUUID();
	await db.run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority)
     VALUES (?, ?, ?, ?, ?, ?)`,
		[id, name, "openai-compatible", "tok", Date.now(), 0],
	);
	return id;
}

/** Build a fake PUT Request carrying the given JSON body. */
function makeRequest(body: unknown): Request {
	return new Request("http://localhost/api/api-keys/x/pin", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

interface PinResponse {
	id: string;
	name: string;
	pinnedAccountId: string | null;
	pinnedProviders: string[] | null;
}

describe("createApiKeyPinHandler", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request, keyIdOrName: string) => Promise<Response>;

	beforeAll(() => {
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createApiKeyPinHandler(dbOps);
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
		await dbOps.getAdapter().run("DELETE FROM accounts", []);
	});

	it("account mode: pins the key to a valid account", async () => {
		const keyId = await insertApiKey(dbOps, "key1");
		const accountId = await insertAccount(dbOps, "acc1");

		const response = await handler(makeRequest({ accountId }), keyId);
		const { data } = (await response.json()) as {
			success: boolean;
			data: PinResponse;
		};

		expect(response.status).toBe(200);
		expect(data.id).toBe(keyId);
		expect(data.pinnedAccountId).toBe(accountId);
		expect(data.pinnedProviders).toBeNull();

		// Confirm persistence.
		const pin = await dbOps.getApiKeyPin(keyId);
		expect(pin?.pinnedAccountId).toBe(accountId);
		expect(pin?.pinnedProviders).toBeNull();
	});

	it("account mode: 400 when the account does not exist", async () => {
		const keyId = await insertApiKey(dbOps, "key2");

		const response = await handler(
			makeRequest({ accountId: "nonexistent-acc" }),
			keyId,
		);
		const data = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(data.error).toContain("nonexistent-acc");
	});

	it("class mode: pins the key to a list of valid providers (deduped)", async () => {
		const keyId = await insertApiKey(dbOps, "key3");

		const response = await handler(
			makeRequest({ providers: ["anthropic", "codex", "anthropic"] }),
			keyId,
		);
		const { data } = (await response.json()) as {
			success: boolean;
			data: PinResponse;
		};

		expect(response.status).toBe(200);
		expect(data.pinnedAccountId).toBeNull();
		expect(data.pinnedProviders).toEqual(["anthropic", "codex"]);

		const pin = await dbOps.getApiKeyPin(keyId);
		expect(pin?.pinnedProviders).toEqual(["anthropic", "codex"]);
	});

	it("class mode: 400 when a provider name is unknown", async () => {
		const keyId = await insertApiKey(dbOps, "key4");

		const response = await handler(
			makeRequest({ providers: ["anthropic", "bogus-provider"] }),
			keyId,
		);
		const data = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(data.error).toContain("bogus-provider");
	});

	it("400 when both accountId and providers are set", async () => {
		const keyId = await insertApiKey(dbOps, "key5");
		const accountId = await insertAccount(dbOps, "acc5");

		const response = await handler(
			makeRequest({ accountId, providers: ["anthropic"] }),
			keyId,
		);

		expect(response.status).toBe(400);
	});

	it("clear: empty body clears the pin", async () => {
		const keyId = await insertApiKey(dbOps, "key6");
		const accountId = await insertAccount(dbOps, "acc6");

		// First pin to an account.
		await handler(makeRequest({ accountId }), keyId);
		// Then clear.
		const response = await handler(makeRequest({}), keyId);
		const { data } = (await response.json()) as {
			success: boolean;
			data: PinResponse;
		};

		expect(response.status).toBe(200);
		expect(data.pinnedAccountId).toBeNull();
		expect(data.pinnedProviders).toBeNull();

		const pin = await dbOps.getApiKeyPin(keyId);
		expect(pin?.pinnedAccountId).toBeNull();
		expect(pin?.pinnedProviders).toBeNull();
	});

	it("clear: explicit nulls clear the pin", async () => {
		const keyId = await insertApiKey(dbOps, "key7");
		const accountId = await insertAccount(dbOps, "acc7");
		await handler(makeRequest({ accountId }), keyId);

		const response = await handler(
			makeRequest({ accountId: null, providers: null }),
			keyId,
		);
		const { data } = (await response.json()) as {
			success: boolean;
			data: PinResponse;
		};

		expect(response.status).toBe(200);
		expect(data.pinnedAccountId).toBeNull();
		expect(data.pinnedProviders).toBeNull();
	});

	it("400 on invalid JSON body (does NOT silently clear a pin)", async () => {
		const keyId = await insertApiKey(dbOps, "key8");
		// Seed a pin so we can prove a malformed request does not drop it.
		const accountId = await insertAccount(dbOps, "acc8");
		await handler(makeRequest({ accountId }), keyId);

		const req = new Request("http://localhost/api/api-keys/x/pin", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		const response = await handler(req, keyId);
		expect(response.status).toBe(400);

		// The previously-set pin must be untouched.
		const pin = await dbOps.getApiKeyPin(keyId);
		expect(pin?.pinnedAccountId).toBe(accountId);
	});

	it("clear: a JSON object with no fields clears the pin", async () => {
		const keyId = await insertApiKey(dbOps, "key8b");
		const accountId = await insertAccount(dbOps, "acc8b");
		await handler(makeRequest({ accountId }), keyId);

		const response = await handler(makeRequest({}), keyId);
		const { data } = (await response.json()) as {
			success: boolean;
			data: PinResponse;
		};

		expect(response.status).toBe(200);
		expect(data.pinnedAccountId).toBeNull();
		expect(data.pinnedProviders).toBeNull();
	});

	it("resolves the key by name as well as id", async () => {
		const keyId = await insertApiKey(dbOps, "named-key");
		const accountId = await insertAccount(dbOps, "acc9");

		const response = await handler(makeRequest({ accountId }), "named-key");
		const { data } = (await response.json()) as {
			success: boolean;
			data: PinResponse;
		};

		expect(response.status).toBe(200);
		expect(data.id).toBe(keyId);
		expect(data.pinnedAccountId).toBe(accountId);
	});

	it("400 on a top-level non-object body (null/array) — does NOT clear a pin", async () => {
		const keyId = await insertApiKey(dbOps, "key-nullbody");
		const accountId = await insertAccount(dbOps, "acc-nullbody");
		await handler(makeRequest({ accountId }), keyId);

		for (const bad of [null, [1, 2], 42, "x"]) {
			const res = await handler(makeRequest(bad), keyId);
			expect(res.status).toBe(400);
		}

		const pin = await dbOps.getApiKeyPin(keyId);
		expect(pin?.pinnedAccountId).toBe(accountId);
	});

	it("400 on typed-but-invalid field shapes (does NOT clear a pin)", async () => {
		const keyId = await insertApiKey(dbOps, "key-badshape");
		const accountId = await insertAccount(dbOps, "acc-badshape");
		await handler(makeRequest({ accountId }), keyId);

		// providers as a string, accountId as a number, and a wrong-typed pair
		// must all 400 rather than fall into the clear branch.
		for (const bad of [
			{ providers: "codex" },
			{ accountId: 123 },
			{ accountId: null, providers: "codex" },
			{ providers: [1, 2] },
		]) {
			const res = await handler(makeRequest(bad), keyId);
			expect(res.status).toBe(400);
		}

		// The original pin is untouched after all the rejected calls.
		const pin = await dbOps.getApiKeyPin(keyId);
		expect(pin?.pinnedAccountId).toBe(accountId);
	});

	it("404 when the API key does not exist", async () => {
		const response = await handler(
			makeRequest({ accountId: "x" }),
			"no-such-key",
		);
		expect(response.status).toBe(404);
	});

	it("getApiKeyPin flags a malformed stored pinned_providers (fail-closed signal)", async () => {
		const keyId = await insertApiKey(dbOps, "key-malformed");
		// Simulate corruption / manual tampering: a non-empty value that is not a
		// valid provider allow-list. The routing layer must treat this as a pin it
		// cannot honor (malformed), NOT as "unpinned".
		await dbOps
			.getAdapter()
			.run("UPDATE api_keys SET pinned_providers = ? WHERE id = ?", [
				"not json",
				keyId,
			]);

		const pin = await dbOps.getApiKeyPin(keyId);
		expect(pin?.malformed).toBe(true);
		expect(pin?.pinnedProviders).toBeNull();

		// Whitespace-only is NOT a legitimate clear state (writes clear to NULL),
		// so it must fail closed too.
		await dbOps
			.getAdapter()
			.run("UPDATE api_keys SET pinned_providers = ? WHERE id = ?", [
				"   ",
				keyId,
			]);
		const ws = await dbOps.getApiKeyPin(keyId);
		expect(ws?.malformed).toBe(true);

		// NULL is a legitimate "no providers pin" — not malformed.
		await dbOps
			.getAdapter()
			.run("UPDATE api_keys SET pinned_providers = NULL WHERE id = ?", [keyId]);
		const cleared = await dbOps.getApiKeyPin(keyId);
		expect(cleared?.malformed).toBe(false);
		expect(cleared?.pinnedProviders).toBeNull();

		// A valid value is not flagged.
		await dbOps
			.getAdapter()
			.run("UPDATE api_keys SET pinned_providers = ? WHERE id = ?", [
				JSON.stringify(["codex"]),
				keyId,
			]);
		const ok = await dbOps.getApiKeyPin(keyId);
		expect(ok?.malformed).toBe(false);
		expect(ok?.pinnedProviders).toEqual(["codex"]);
	});
});
