/**
 * The three auth endpoints.
 *
 * `GET /api/auth/status` gets the most attention here for one reason: it MUST
 * use the optional-session check, not the request gate. The gate answers "may
 * this proceed", which for a public route is unconditionally yes — routing this
 * endpoint through it would make it report a live session to a browser that has
 * never logged in, and the dashboard would then never show its login screen.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type {
	AuthSessionRecord,
	StoredPasswordVerifier,
} from "@clankermux/database";
import { LoginThrottle } from "../../services/login-throttle";
import {
	hashSessionToken,
	MAX_PASSWORD_BYTES,
	type PasswordHasher,
	SESSION_COOKIE_NAME,
	SessionAuthService,
	type SessionAuthStore,
} from "../../services/session-auth-service";
import {
	createAuthLoginHandler,
	createAuthLogoutHandler,
	createAuthStatusHandler,
} from "../auth";

class FakeStore implements SessionAuthStore {
	password: StoredPasswordVerifier | null = null;
	sessions = new Map<string, AuthSessionRecord>();

	async getManagementPassword() {
		return this.password;
	}
	async createManagementSession(record: AuthSessionRecord) {
		this.sessions.set(record.tokenHash, { ...record });
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
}

/** Cheap stand-in for scrypt; counts derivations so a test can assert none ran. */
class CountingHasher implements PasswordHasher {
	verifyCalls = 0;
	async hash(password: string) {
		return {
			verifier: createHash("sha256").update(`x:${password}`).digest("hex"),
			params: "{}",
		};
	}
	async verify(password: string, verifier: string) {
		this.verifyCalls++;
		return (
			createHash("sha256").update(`x:${password}`).digest("hex") === verifier
		);
	}
}

let store: FakeStore;
let hasher: CountingHasher;
let svc: SessionAuthService;

beforeEach(() => {
	store = new FakeStore();
	hasher = new CountingHasher();
	svc = new SessionAuthService(store, hasher);
});

async function configure(password: string) {
	const { verifier, params } = await hasher.hash(password);
	store.password = { verifier, params, updatedAt: 0 };
}

function loginRequest(body: unknown, raw?: string): Request {
	return new Request("http://localhost/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: raw ?? JSON.stringify(body),
	});
}

describe("POST /api/auth/login", () => {
	it("issues a session cookie for the right password", async () => {
		await configure("hunter2");
		const res = await createAuthLoginHandler(svc)(
			loginRequest({ password: "hunter2" }),
		);
		expect(res.status).toBe(200);
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(store.sessions.size).toBe(1);
	});

	it("refuses the wrong password without minting anything", async () => {
		await configure("hunter2");
		const res = await createAuthLoginHandler(svc)(
			loginRequest({ password: "wrong" }),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(store.sessions.size).toBe(0);
	});

	it("reports 409 rather than a phantom session when no password is configured", async () => {
		const res = await createAuthLoginHandler(svc)(
			loginRequest({ password: "anything" }),
		);
		expect(res.status).toBe(409);
		expect(store.sessions.size).toBe(0);
	});

	it("rejects a missing or non-string password before hashing", async () => {
		await configure("hunter2");
		const handler = createAuthLoginHandler(svc);
		for (const body of [{}, { password: 42 }, { password: "" }]) {
			const res = await handler(loginRequest(body));
			expect(res.status).toBe(400);
		}
		expect(hasher.verifyCalls).toBe(0);
	});

	it("rejects malformed and non-object bodies", async () => {
		await configure("hunter2");
		const handler = createAuthLoginHandler(svc);
		expect((await handler(loginRequest(null, "not json"))).status).toBe(400);
		expect((await handler(loginRequest(null, '["x"]'))).status).toBe(400);
		expect(hasher.verifyCalls).toBe(0);
	});

	it("caps the password length BEFORE paying for a derivation", async () => {
		await configure("hunter2");
		const res = await createAuthLoginHandler(svc)(
			loginRequest({ password: "a".repeat(MAX_PASSWORD_BYTES + 1) }),
		);
		expect(res.status).toBe(400);
		expect(hasher.verifyCalls).toBe(0);
	});

	it("caps the body size BEFORE paying for a derivation", async () => {
		await configure("hunter2");
		const res = await createAuthLoginHandler(svc)(
			loginRequest({ password: "hunter2", pad: "x".repeat(8_192) }),
		);
		expect(res.status).toBe(400);
		expect(hasher.verifyCalls).toBe(0);
	});

	it("answers 429 with Retry-After once the throttle is spent", async () => {
		await configure("hunter2");
		const throttle = new LoginThrottle(1, 5_000, 2, () => 0);
		const handler = createAuthLoginHandler(svc, throttle);
		expect((await handler(loginRequest({ password: "hunter2" }))).status).toBe(
			200,
		);
		const res = await handler(loginRequest({ password: "hunter2" }));
		expect(res.status).toBe(429);
		expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
	});

	it("releases its throttle slot even when verification throws", async () => {
		await configure("hunter2");
		const throttle = new LoginThrottle(10, 1_000, 1, () => 0);
		hasher.verify = async () => {
			throw new Error("threadpool exploded");
		};
		const handler = createAuthLoginHandler(svc, throttle);
		await expect(handler(loginRequest({ password: "x" }))).rejects.toThrow();
		// The slot must be free again, or one failure would wedge the endpoint.
		const claim = throttle.tryAcquire();
		expect(claim.ok).toBe(true);
	});
});

describe("POST /api/auth/logout", () => {
	it("deletes the session and clears the cookie", async () => {
		await configure("hunter2");
		const { token } = await svc.createSession();
		const res = await createAuthLogoutHandler(svc)(
			new Request("http://localhost/api/auth/logout", {
				method: "POST",
				headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
		expect(store.sessions.has(hashSessionToken(token))).toBe(false);
	});

	it("succeeds with no session — logging out is the state the caller wanted", async () => {
		const res = await createAuthLogoutHandler(svc)(
			new Request("http://localhost/api/auth/logout", { method: "POST" }),
		);
		expect(res.status).toBe(200);
	});
});

describe("GET /api/auth/status", () => {
	function statusRequest(token?: string): Request {
		return new Request("http://localhost/api/auth/status", {
			headers: token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {},
		});
	}

	it("reports unconfigured on a fresh deployment", async () => {
		const res = await createAuthStatusHandler(svc)(statusRequest());
		expect(await res.json()).toEqual({
			configured: false,
			authenticated: false,
		});
	});

	it("does NOT claim a session for a cookie-less request on a gated deployment", async () => {
		await configure("hunter2");
		const res = await createAuthStatusHandler(svc)(statusRequest());
		expect(await res.json()).toEqual({
			configured: true,
			authenticated: false,
		});
	});

	it("does NOT claim a session for a bogus cookie", async () => {
		await configure("hunter2");
		const res = await createAuthStatusHandler(svc)(statusRequest("garbage"));
		expect(await res.json()).toEqual({
			configured: true,
			authenticated: false,
		});
	});

	it("reports a live session once one exists", async () => {
		await configure("hunter2");
		const { token } = await svc.createSession();
		const res = await createAuthStatusHandler(svc)(statusRequest(token));
		expect(await res.json()).toEqual({ configured: true, authenticated: true });
	});

	it("stops reporting a session after logout", async () => {
		await configure("hunter2");
		const { token } = await svc.createSession();
		await svc.destroySession(statusRequest(token));
		const res = await createAuthStatusHandler(svc)(statusRequest(token));
		expect(await res.json()).toEqual({
			configured: true,
			authenticated: false,
		});
	});
});
