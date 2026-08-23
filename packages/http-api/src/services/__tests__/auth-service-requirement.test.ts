/**
 * The EXPLICIT auth requirement — the override that lets a caller state what a
 * request needs instead of having it inferred from the path.
 *
 * This exists because agent traffic now arrives under a mount (`/wire/<dialect>`)
 * that is stripped before anything downstream sees it. The router therefore
 * knows, from its own route classification, that the request is upstream AI
 * traffic and must present an API key — but the path it hands to the auth
 * service is the CANONICAL one, and canonical `/api/event_logging/v2/batch` is
 * something `policyFor` classifies as public management surface.
 *
 * So these tests deliberately use paths whose inferred policy is `public`. If
 * the override were a no-op, every other auth test would still pass while
 * mounted `/api/*` traffic was served with no key at all — which is exactly the
 * failure this file has to be able to see.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { ApiKey, CryptoUtils } from "@clankermux/types";
import { apiKeyLookupSuffix } from "@clankermux/types";
import { AuthService } from "../auth-service";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hashOf = (secret: string) => `sha256$${sha256(secret)}`;

const VALID_KEY = "btr-validvalidvalidvalidvalidVAL1";

class TestCrypto implements CryptoUtils {
	async generateApiKey(): Promise<string> {
		return "btr-unused";
	}
	async hashApiKey(apiKey: string): Promise<string> {
		return hashOf(apiKey);
	}
	async verifyApiKey(apiKey: string, hashedKey: string): Promise<boolean> {
		return hashedKey === hashOf(apiKey);
	}
}

/** Minimal DatabaseOperations surface the auth path touches. */
class FakeDbOps {
	keys: ApiKey[] = [];

	async getActiveApiKeys(): Promise<ApiKey[]> {
		return this.keys.filter((k) => k.isActive);
	}
	async countActiveApiKeys(): Promise<number> {
		return this.keys.filter((k) => k.isActive).length;
	}
	async updateApiKeyUsage(): Promise<void> {}
	async getApiKeyByHashedKey(hashedKey: string): Promise<ApiKey | null> {
		return (
			this.keys.find((k) => k.hashedKey === hashedKey && k.isActive) ?? null
		);
	}
	async rotateApiKeySecret(): Promise<boolean> {
		return true;
	}
}

function keyRow(secret: string): ApiKey {
	return {
		id: "id-wire",
		name: "wire-key",
		hashedKey: hashOf(secret),
		prefixLast8: apiKeyLookupSuffix(secret),
		createdAt: 1,
		lastUsed: null,
		usageCount: 0,
		isActive: true,
		pinnedAccountId: null,
		pinnedProviders: null,
	};
}

function makeRequest(key?: string): Request {
	return new Request("http://localhost/", {
		method: "POST",
		headers: key ? { "x-api-key": key } : {},
	});
}

let db: FakeDbOps;
let svc: AuthService;

beforeEach(() => {
	db = new FakeDbOps();
	db.keys = [keyRow(VALID_KEY)];
	// biome-ignore lint/suspicious/noExplicitAny: the fake covers only the auth path
	svc = new AuthService(db as any, new TestCrypto());
});

describe("authenticateRequest with an explicit requirement", () => {
	// Every path here is one `policyFor` would call public. That is the point.
	const publicByPath = [
		"/api/event_logging/v2/batch",
		"/api/system/status",
		"/",
		"/health",
		"/dashboard/accounts",
	];

	for (const path of publicByPath) {
		it(`requires a key for ${path} when "api_key" is passed`, async () => {
			const result = await svc.authenticateRequest(
				makeRequest(),
				path,
				"POST",
				"api_key",
			);
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toMatch(/API key required/);
		});

		it(`rejects an invalid key for ${path} when "api_key" is passed`, async () => {
			const result = await svc.authenticateRequest(
				makeRequest("btr-not-a-real-key"),
				path,
				"POST",
				"api_key",
			);
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toBe("Invalid API key");
		});

		it(`accepts a valid key for ${path} when "api_key" is passed`, async () => {
			const result = await svc.authenticateRequest(
				makeRequest(VALID_KEY),
				path,
				"POST",
				"api_key",
			);
			expect(result.isAuthenticated).toBe(true);
			expect(result.apiKeyName).toBe("wire-key");
			expect(result.apiKeyId).toBe("id-wire");
		});
	}

	it("still lets everything through when no keys are configured", async () => {
		db.keys = [];
		const result = await svc.authenticateRequest(
			makeRequest(),
			"/api/event_logging/v2/batch",
			"POST",
			"api_key",
		);
		expect(result.isAuthenticated).toBe(true);
		expect(result.apiKeyId).toBeUndefined();
	});

	it("overrides the path policy in the other direction too", async () => {
		// `/v1/messages` infers `api_key`; an explicit "public" wins.
		const result = await svc.authenticateRequest(
			makeRequest(),
			"/v1/messages",
			"POST",
			"public",
		);
		expect(result.isAuthenticated).toBe(true);
	});

	it("falls back to the path policy when no requirement is passed", async () => {
		const publicPath = await svc.authenticateRequest(
			makeRequest(),
			"/api/event_logging/v2/batch",
			"POST",
		);
		expect(publicPath.isAuthenticated).toBe(true);

		const gatedPath = await svc.authenticateRequest(
			makeRequest(),
			"/v1/messages",
			"POST",
		);
		expect(gatedPath.isAuthenticated).toBe(false);
	});
});
