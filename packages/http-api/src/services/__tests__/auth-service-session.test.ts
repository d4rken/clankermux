/**
 * The `session` requirement inside AuthService — the DEFENSE-IN-DEPTH half of
 * the management gate.
 *
 * The primary mechanism is the router's own boundary, which short-circuits
 * `/api/*` before the API router ever runs. This layer exists for the case that
 * boundary is bypassed or a future caller forgets the explicit requirement: the
 * path policy alone must still refuse. A test that only exercised the router
 * would not notice this half rotting away.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type {
	AuthSessionRecord,
	StoredPasswordVerifier,
} from "@clankermux/database";
import type { ApiKey, CryptoUtils } from "@clankermux/types";
import { AuthService } from "../auth-service";
import {
	type PasswordHasher,
	SESSION_COOKIE_NAME,
	SessionAuthService,
	type SessionAuthStore,
} from "../session-auth-service";

class TestCrypto implements CryptoUtils {
	async generateApiKey() {
		return "btr-unused";
	}
	async hashApiKey(apiKey: string) {
		return `sha256$${createHash("sha256").update(apiKey).digest("hex")}`;
	}
	async verifyApiKey() {
		return false;
	}
}

class FakeStore implements SessionAuthStore {
	password: StoredPasswordVerifier | null = null;
	sessions = new Map<string, AuthSessionRecord>();

	async getManagementPassword() {
		return this.password;
	}
	async createManagementSession(record: AuthSessionRecord) {
		this.sessions.set(record.tokenHash, { ...record });
		return 1;
	}
	async getManagementSession(tokenHash: string) {
		return this.sessions.get(tokenHash) ?? null;
	}
	async touchManagementSession() {
		return 0;
	}
	async deleteManagementSession(tokenHash: string) {
		return this.sessions.delete(tokenHash) ? 1 : 0;
	}
	async cleanupExpiredManagementSessions() {
		return 0;
	}
	// The API-key half of the DatabaseOperations surface AuthService touches.
	async getActiveApiKeys(): Promise<ApiKey[]> {
		return [];
	}
	async countActiveApiKeys(): Promise<number> {
		return 0;
	}
	async updateApiKeyUsage(): Promise<void> {}
	async getApiKeyByHashedKey(): Promise<ApiKey | null> {
		return null;
	}
	async rotateApiKeySecret(): Promise<boolean> {
		return true;
	}
}

const cheapHasher: PasswordHasher = {
	async hash(password) {
		return {
			verifier: createHash("sha256").update(password).digest("hex"),
			params: "{}",
		};
	},
	async verify(password, verifier) {
		return createHash("sha256").update(password).digest("hex") === verifier;
	},
};

let store: FakeStore;
let sessionAuth: SessionAuthService;
let svc: AuthService;

beforeEach(() => {
	store = new FakeStore();
	sessionAuth = new SessionAuthService(store, cheapHasher);
	svc = new AuthService(
		// biome-ignore lint/suspicious/noExplicitAny: the fake covers only the auth path
		store as any,
		new TestCrypto(),
		sessionAuth,
	);
});

function req(path: string, token?: string): Request {
	return new Request(`http://localhost${path}`, {
		headers: token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {},
	});
}

describe("path policy maps the management surface to session", () => {
	const gated = [
		"/api",
		"/api/accounts",
		"/api/accounts/abc/pause",
		"/api/config",
		"/api/not-a-real-route",
	];

	it("admits every gated path while no password is configured", async () => {
		for (const path of gated) {
			const result = await svc.authenticateRequest(req(path), path, "GET");
			expect(result.isAuthenticated).toBe(true);
		}
	});

	it("refuses every gated path once a password exists and no cookie is presented", async () => {
		store.password = { ...(await cheapHasher.hash("pw")), updatedAt: 0 };
		for (const path of gated) {
			const result = await svc.authenticateRequest(req(path), path, "GET");
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toMatch(/Sign in/);
		}
	});

	it("admits a gated path with a live session cookie", async () => {
		store.password = { ...(await cheapHasher.hash("pw")), updatedAt: 0 };
		const { token } = await sessionAuth.createSession();
		const result = await svc.authenticateRequest(
			req("/api/accounts", token),
			"/api/accounts",
			"GET",
		);
		expect(result.isAuthenticated).toBe(true);
	});

	it("refuses a gated path with a cookie whose session was deleted", async () => {
		store.password = { ...(await cheapHasher.hash("pw")), updatedAt: 0 };
		const { token } = await sessionAuth.createSession();
		store.sessions.clear();
		const result = await svc.authenticateRequest(
			req("/api/accounts", token),
			"/api/accounts",
			"GET",
		);
		expect(result.isAuthenticated).toBe(false);
	});

	it("carries no API key identity on a session-authenticated request", async () => {
		store.password = { ...(await cheapHasher.hash("pw")), updatedAt: 0 };
		const { token } = await sessionAuth.createSession();
		const result = await svc.authenticateRequest(
			req("/api/accounts", token),
			"/api/accounts",
			"GET",
		);
		expect(result.apiKeyId).toBeUndefined();
		expect(result.apiKeyName).toBeUndefined();
	});
});

describe("paths the session policy must not touch", () => {
	beforeEach(async () => {
		store.password = { ...(await cheapHasher.hash("pw")), updatedAt: 0 };
	});

	for (const path of [
		"/api/auth/login",
		"/api/auth/logout",
		"/api/auth/status",
		"/api/event_logging/batch",
		"/api/system/package-manager",
		"/health",
		"/public/v1/status",
		"/public/v1/accounts",
		"/public/v1/stream",
		"/",
		"/assets/app.js",
	]) {
		it(`admits ${path} with no cookie even on a gated deployment`, async () => {
			const result = await svc.authenticateRequest(req(path), path, "GET");
			expect(result.isAuthenticated).toBe(true);
		});
	}

	it("still gates upstream AI traffic on an API key, not a session", async () => {
		// No keys configured, so the api_key policy fails open — what matters is
		// that the session policy did not claim it.
		const result = await svc.authenticateRequest(
			req("/v1/messages"),
			"/v1/messages",
			"POST",
		);
		expect(result.isAuthenticated).toBe(true);
	});
});

describe("an explicit requirement still wins", () => {
	it("gates a non-management path when 'session' is passed", async () => {
		store.password = { ...(await cheapHasher.hash("pw")), updatedAt: 0 };
		const result = await svc.authenticateRequest(
			req("/health"),
			"/health",
			"GET",
			"session",
		);
		expect(result.isAuthenticated).toBe(false);
	});

	it("ungates a management path when 'public' is passed", async () => {
		store.password = { ...(await cheapHasher.hash("pw")), updatedAt: 0 };
		const result = await svc.authenticateRequest(
			req("/api/accounts"),
			"/api/accounts",
			"GET",
			"public",
		);
		expect(result.isAuthenticated).toBe(true);
	});
});
