/**
 * Mint a key, then authenticate with it — against a real database, the real
 * crypto, and the real admin functions.
 *
 * The unit tests either side of this seam both use fakes: the auth tests fake
 * the database, and the repository tests fake the hashes. Neither would notice
 * if minting and verification stopped agreeing on the stored format, which is
 * the one failure that would lock every key out at once.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import { apiKeyHashScheme, apiKeyLookupSuffix } from "@clankermux/types";
import {
	deleteApiKey,
	disableApiKey,
	generateApiKey,
	regenerateApiKey,
} from "../admin/api-keys";
import { AuthService } from "../auth-service";

let dir: string;
let dbPath: string;
let dbOps: DatabaseOperations;
let svc: AuthService;

const auth = (key: string) =>
	svc.authenticateRequest(
		new Request("http://localhost/v1/messages", {
			headers: { "x-api-key": key },
		}),
		"/v1/messages",
		"POST",
	);

/**
 * Wait for the stored hash to reach a scheme, or give up.
 *
 * The rewrite is deliberately not awaited by the request path, so tests have to
 * wait for it. A fixed sleep would either flake on a loaded machine or hide a
 * rewrite that never happened; this fails loudly with what it actually saw.
 */
const waitForScheme = async (
	name: string,
	scheme: "sha256" | "scrypt-legacy",
	timeoutMs = 2000,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	let seen = "";
	while (Date.now() < deadline) {
		seen = apiKeyHashScheme(storedHashOf(name));
		if (seen === scheme) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(
		`stored hash for '${name}' never became ${scheme}; it is still ${seen}`,
	);
};

const storedHashOf = (name: string): string => {
	const db = new Database(dbPath, { readonly: true });
	try {
		return (
			db.query("SELECT hashed_key FROM api_keys WHERE name = ?").get(name) as {
				hashed_key: string;
			}
		).hashed_key;
	} finally {
		db.close();
	}
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "clankermux-apikey-"));
	dbPath = path.join(dir, "test.db");
	dbOps = new DatabaseOperations(dbPath);
	svc = new AuthService(dbOps);
});

afterEach(() => {
	dbOps.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("mint then authenticate", () => {
	it("stores a new key in the sha256 scheme and authenticates it", async () => {
		const minted = await generateApiKey(dbOps, "first");

		expect(apiKeyHashScheme(storedHashOf("first"))).toBe("sha256");

		const r = await auth(minted.apiKey);
		expect(r.isAuthenticated).toBe(true);
		expect(r.apiKeyName).toBe("first");
		expect(r.apiKeyId).toBe(minted.id);
	});

	it("stores the lookup suffix verification will look for", async () => {
		const minted = await generateApiKey(dbOps, "first");

		expect(minted.prefixLast8).toBe(apiKeyLookupSuffix(minted.apiKey));
	});

	it("rejects a key that was never minted", async () => {
		await generateApiKey(dbOps, "first");

		const r = await auth("btr-neverMintedNeverMintedNever1");
		expect(r.isAuthenticated).toBe(false);
	});

	it("keeps two keys distinct", async () => {
		const a = await generateApiKey(dbOps, "a");
		const b = await generateApiKey(dbOps, "b");

		expect((await auth(a.apiKey)).apiKeyName).toBe("a");
		expect((await auth(b.apiKey)).apiKeyName).toBe("b");
	});
});

describe("the lifecycle a key can go through", () => {
	it("stops accepting the old secret after a regenerate, and takes the new one", async () => {
		const first = await generateApiKey(dbOps, "rotating");
		// A second key keeps authentication switched on throughout; with zero
		// active keys the proxy lets everything through and the assertions below
		// would pass for the wrong reason.
		await generateApiKey(dbOps, "bystander");
		expect((await auth(first.apiKey)).isAuthenticated).toBe(true);

		const second = await regenerateApiKey(dbOps, "rotating");

		expect((await auth(first.apiKey)).isAuthenticated).toBe(false);
		expect((await auth(second.apiKey)).isAuthenticated).toBe(true);
		expect(apiKeyHashScheme(storedHashOf("rotating"))).toBe("sha256");
	});

	it("stops accepting a disabled key", async () => {
		const key = await generateApiKey(dbOps, "doomed");
		await generateApiKey(dbOps, "bystander");

		await disableApiKey(dbOps, "doomed");

		expect((await auth(key.apiKey)).isAuthenticated).toBe(false);
	});

	it("stops accepting a deleted key", async () => {
		const key = await generateApiKey(dbOps, "doomed");
		await generateApiKey(dbOps, "bystander");

		await deleteApiKey(dbOps, "doomed");

		expect((await auth(key.apiKey)).isAuthenticated).toBe(false);
	});
});

describe("a key stored under the old scrypt scheme", () => {
	/** Plant a row exactly as the pre-migration code would have written it. */
	const plantLegacyKey = async (name: string, secret: string) => {
		const nodeCrypto = require("node:crypto");
		const salt = nodeCrypto.randomBytes(16).toString("hex");
		const hashed = `${salt}:${nodeCrypto.scryptSync(secret, salt, 64).toString("hex")}`;
		await dbOps.createApiKey({
			id: `id-${name}`,
			name,
			hashedKey: hashed,
			prefixLast8: apiKeyLookupSuffix(secret),
			createdAt: Date.now(),
			isActive: true,
		});
		return hashed;
	};

	it("authenticates, and is rewritten to the new scheme", async () => {
		const secret = "btr-legacylegacylegacylegacyLEG1";
		const planted = await plantLegacyKey("old", secret);
		expect(apiKeyHashScheme(planted)).toBe("scrypt-legacy");

		expect((await auth(secret)).isAuthenticated).toBe(true);

		await waitForScheme("old", "sha256");
	});

	it("still authenticates after being rewritten", async () => {
		const secret = "btr-legacylegacylegacylegacyLEG1";
		await plantLegacyKey("old", secret);

		await auth(secret);
		// Assert the rewrite actually landed before testing life after it,
		// otherwise this is just the legacy path passing a second time.
		await waitForScheme("old", "sha256");

		const again = await auth(secret);
		expect(again.isAuthenticated).toBe(true);
		expect(again.apiKeyName).toBe("old");
	});

	it("rejects the wrong key without rewriting anything", async () => {
		const planted = await plantLegacyKey(
			"old",
			"btr-aaaaaaaaaaaaaaaaaaaaSUFFIX12",
		);

		// Same public suffix, different secret: the case an attacker can construct.
		const r = await auth("btr-bbbbbbbbbbbbbbbbbbbbSUFFIX12");
		// Give a rewrite time to happen, so "nothing changed" means it was not
		// attempted rather than that we looked too early.
		await new Promise((res) => setTimeout(res, 100));

		expect(r.isAuthenticated).toBe(false);
		expect(storedHashOf("old")).toBe(planted);
		expect(apiKeyHashScheme(storedHashOf("old"))).toBe("scrypt-legacy");
	});
});
