/**
 * Whether a key check counts as a request by that client.
 *
 * `last_used` and `usage_count` are what the dashboard shows as a client's last
 * request and its within-24h activity marker, so they have to mean "this client
 * sent traffic". A surface where the key is presented to READ ABOUT past
 * requests rather than to send one opts out with `recordUsage: false`; every
 * other caller states nothing and must keep counting, which is why the default
 * gets its own assertions here rather than being taken on trust from the
 * signature.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { ApiKey, CryptoUtils } from "@clankermux/types";
import { apiKeyLookupSuffix } from "@clankermux/types";
import { AuthService } from "../auth-service";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hashOf = (secret: string) => `sha256$${sha256(secret)}`;
/** The old scheme's exact shape: a 16-byte hex salt, a colon, 64 hex bytes. */
const legacyHashOf = (secret: string) =>
	`${sha256(secret).slice(0, 32)}:${sha256(secret)}${sha256(`${secret}#2`)}`;

/** A row in the current SHA-256 scheme, found by the indexed lookup. */
const MIGRATED_KEY = "btr-migratedmigratedmigratedMG01";
/** A row still in the salted scrypt scheme, found by the scan. */
const LEGACY_KEY = "btr-legacylegacylegacylegacyLG01";

class TestCrypto implements CryptoUtils {
	async generateApiKey(): Promise<string> {
		return "btr-unused";
	}
	async hashApiKey(apiKey: string): Promise<string> {
		return hashOf(apiKey);
	}
	async verifyApiKey(apiKey: string, hashedKey: string): Promise<boolean> {
		return hashedKey === legacyHashOf(apiKey);
	}
}

function keyRow(id: string, secret: string, legacy: boolean): ApiKey {
	return {
		id,
		name: id,
		hashedKey: legacy ? legacyHashOf(secret) : hashOf(secret),
		prefixLast8: apiKeyLookupSuffix(secret),
		createdAt: 1,
		lastUsed: null,
		usageCount: 0,
		isActive: true,
		pinnedAccountId: null,
		pinnedProviders: null,
	};
}

class FakeDbOps {
	keys: ApiKey[] = [
		keyRow("key-migrated", MIGRATED_KEY, false),
		keyRow("key-legacy", LEGACY_KEY, true),
	];
	usageWrites: { id: string; at: number }[] = [];

	async getActiveApiKeys(): Promise<ApiKey[]> {
		return this.keys.filter((k) => k.isActive);
	}
	async countActiveApiKeys(): Promise<number> {
		return this.keys.length;
	}
	updateApiKeyUsage(id: string, at: number): void {
		this.usageWrites.push({ id, at });
	}
	async getApiKeyByHashedKey(hashedKey: string): Promise<ApiKey | null> {
		return this.keys.find((k) => k.hashedKey === hashedKey) ?? null;
	}
	async rotateApiKeySecret(): Promise<boolean> {
		return true;
	}
	async getManagementPassword(): Promise<null> {
		return null;
	}
}

let db: FakeDbOps;
let svc: AuthService;

beforeEach(() => {
	db = new FakeDbOps();
	// biome-ignore lint/suspicious/noExplicitAny: the fake covers only the auth path
	svc = new AuthService(db as any, new TestCrypto());
});

function withKey(key: string): Request {
	return new Request("http://localhost/", {
		method: "POST",
		headers: { "x-api-key": key },
	});
}

// Both acceptance paths: the indexed lookup and the legacy scan that verifies
// and migrates. Either can be the one a client's key takes.
const paths: [string, string, string][] = [
	["the indexed lookup", MIGRATED_KEY, "key-migrated"],
	["the legacy verification scan", LEGACY_KEY, "key-legacy"],
];

describe("recordUsage", () => {
	for (const [what, key, id] of paths) {
		it(`counts the hit on ${what} when no options are passed`, async () => {
			const result = await svc.authenticateRequest(
				withKey(key),
				"/v1/messages",
				"POST",
			);
			expect(result.isAuthenticated).toBe(true);
			expect(db.usageWrites.map((w) => w.id)).toEqual([id]);
		});

		it(`counts the hit on ${what} when recordUsage is true`, async () => {
			await svc.authenticateRequest(
				withKey(key),
				"/v1/messages",
				"POST",
				"api_key",
				{
					recordUsage: true,
				},
			);
			expect(db.usageWrites.map((w) => w.id)).toEqual([id]);
		});

		it(`skips the hit on ${what} when recordUsage is false`, async () => {
			const result = await svc.authenticateRequest(
				withKey(key),
				"/client/v1/retention",
				"GET",
				"api_key",
				{ recordUsage: false },
			);
			// Still fully authenticated — the identity is what the surface is
			// scoped to; only the usage bookkeeping is suppressed.
			expect(result.isAuthenticated).toBe(true);
			expect(result.apiKeyId).toBe(id);
			expect(db.usageWrites).toEqual([]);
		});
	}
});

describe("the client namespace's default policy", () => {
	// Nothing should reach here without the router's explicit requirement, but
	// if something does, the whole namespace fails closed rather than falling
	// through to the public catch-all.
	for (const path of ["/client", "/client/", "/client/v1/retention"]) {
		it(`requires a key for ${path} with no requirement passed`, async () => {
			const result = await svc.authenticateRequest(
				new Request("http://localhost/"),
				path,
				"GET",
			);
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toMatch(/API key required/);
		});
	}

	it("leaves neighbouring root paths on the public catch-all", async () => {
		for (const path of ["/clientevil", "/clientele", "/clients"]) {
			const result = await svc.authenticateRequest(
				new Request("http://localhost/"),
				path,
				"GET",
			);
			expect(result.isAuthenticated).toBe(true);
		}
	});
});
