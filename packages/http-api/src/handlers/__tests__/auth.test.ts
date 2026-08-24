/**
 * The three auth endpoints.
 *
 * `GET /api/auth/status` gets the most attention here for one reason: it MUST
 * use the optional-session check, not the request gate. The gate answers "may
 * this proceed", which for a public route is unconditionally yes — routing this
 * endpoint through it would make it report a live session to a browser that has
 * never logged in, and the dashboard would then never show its login screen.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	AuthRepository,
	type AuthSessionRecord,
	BunSqlAdapter,
	ensureSchema,
	type PasswordBinding,
	type StoredPasswordVerifier,
} from "@clankermux/database";
import {
	LOGIN_MAX_BODY_BYTES,
	LoginThrottle,
} from "../../services/login-throttle";
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
	async createManagementSession(
		record: AuthSessionRecord,
		boundTo: PasswordBinding,
	) {
		// Mirrors the conditional INSERT: a session may not be issued against a
		// verifier that is no longer the stored one, and there is no unbound form
		// to fall through to.
		if (
			this.password?.verifier !== boundTo.verifier ||
			this.password?.params !== boundTo.params
		) {
			return 0;
		}
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

/**
 * Store a password and return the binding a verified login would carry. Every
 * session here is minted against it, because nothing can mint one without it.
 */
async function configure(password: string): Promise<PasswordBinding> {
	const { verifier, params } = await hasher.hash(password);
	store.password = { verifier, params, updatedAt: 0 };
	return { verifier, params };
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
		expect(res.status).toBe(413);
		expect(hasher.verifyCalls).toBe(0);
	});

	it("says the body was too large instead of blaming the password field", async () => {
		// The bound refuses VALID payloads too, purely for their size, and the
		// caller cannot see that in what they sent. Reporting "Password required"
		// for a body that carried a password sends an operator looking at the one
		// thing that was fine — on the endpoint people reach for when something is
		// already wrong.
		await configure("hunter2");
		const handler = createAuthLoginHandler(svc);
		const oversize = await handler(
			loginRequest({ password: "hunter2", pad: "x".repeat(8_192) }),
		);
		const empty = await handler(loginRequest({}));

		expect(oversize.status).toBe(413);
		expect(empty.status).toBe(400);
		expect(oversize.status).not.toBe(empty.status);
		const oversizeBody = (await oversize.json()) as Record<string, unknown>;
		expect(oversizeBody).not.toEqual(
			(await empty.json()) as Record<string, unknown>,
		);
		// The limit is named, so the fix is "send less" without guesswork.
		expect(oversizeBody.error).toBe("Request body too large");
		expect(oversizeBody.limit).toBe(LOGIN_MAX_BODY_BYTES);
	});

	it("refuses a DECLARED Content-Length over the cap without consuming the body", async () => {
		// The other size tests all reach the cap by COUNTING bytes as they arrive.
		// This is the other branch, and the only one that can answer before the
		// body exists: the header alone settles it, and the handler never takes a
		// reader — which is what leaves the stream unlocked below.
		await configure("hunter2");
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode("x".repeat(1_024)));
			},
		});
		const req = new Request("http://localhost/api/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": String(LOGIN_MAX_BODY_BYTES + 1),
			},
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		const res = await createAuthLoginHandler(svc)(req);

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({
			error: "Request body too large",
			limit: LOGIN_MAX_BODY_BYTES,
		});
		expect(req.body?.locked).toBe(false);
		expect(hasher.verifyCalls).toBe(0);
	});

	it("STOPS READING an oversized body instead of buffering it first", async () => {
		// The endpoint is unauthenticated and the process also serves AI traffic,
		// so "reject after buffering" is the whole problem: a chunked body, or one
		// whose Content-Length lies, would be held in full before any check ran.
		await configure("hunter2");
		let pulls = 0;
		let cancelled = false;
		const chunk = new TextEncoder().encode("x".repeat(1_024));
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});
		const req = new Request("http://localhost/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		const res = await createAuthLoginHandler(svc)(req);

		expect(res.status).toBe(413);
		expect(cancelled).toBe(true);
		// A 4 KiB cap over 1 KiB chunks: a handful of pulls, not an endless body.
		expect(pulls).toBeLessThanOrEqual(LOGIN_MAX_BODY_BYTES / 1_024 + 2);
		expect(hasher.verifyCalls).toBe(0);
	});

	it("accepts a chunked body that stays under the cap", async () => {
		await configure("hunter2");
		const encoder = new TextEncoder();
		const payload = JSON.stringify({ password: "hunter2" });
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				// Split mid-payload: the reassembly has to survive chunk boundaries.
				controller.enqueue(encoder.encode(payload.slice(0, 5)));
				controller.enqueue(encoder.encode(payload.slice(5)));
				controller.close();
			},
		});
		const req = new Request("http://localhost/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		expect((await createAuthLoginHandler(svc)(req)).status).toBe(200);
	});

	it("refuses a body whose Content-Length lies about being small", async () => {
		await configure("hunter2");
		let cancelled = false;
		const chunk = new TextEncoder().encode("x".repeat(1_024));
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});
		const req = new Request("http://localhost/api/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				// A claim, and a false one. The counted bytes are what bind.
				"content-length": "20",
			},
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		expect((await createAuthLoginHandler(svc)(req)).status).toBe(413);
		expect(cancelled).toBe(true);
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

describe("a login that races a password rotation", () => {
	/** SessionAuthStore over the real tables, so the SQL is what decides. */
	function sqliteStore(repo: AuthRepository): SessionAuthStore {
		return {
			getManagementPassword: () => repo.getPassword(),
			createManagementSession: (record, boundTo) =>
				repo.createSession(record, boundTo),
			getManagementSession: (tokenHash) => repo.getSession(tokenHash),
			touchManagementSession: (tokenHash, now, staleBeforeMs) =>
				repo.touchSession(tokenHash, now, staleBeforeMs),
			deleteManagementSession: (tokenHash) => repo.deleteSession(tokenHash),
			cleanupExpiredManagementSessions: (now, idleCutoff) =>
				repo.deleteExpiredSessions(now, idleCutoff),
		};
	}

	it("issues NOTHING when the rotation commits between verify and insert", async () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		const repo = new AuthRepository(new BunSqlAdapter(db));
		const { verifier, params } = await new CountingHasher().hash("hunter2");
		await repo.setPassword(verifier, params, 1);

		// A barrier where scrypt's ~35ms would be. The attacker holds the window
		// open by looping logins; the operator rotates inside it.
		let verifyStarted = () => {};
		const started = new Promise<void>((resolve) => {
			verifyStarted = resolve;
		});
		let releaseVerify = () => {};
		const held = new Promise<void>((resolve) => {
			releaseVerify = resolve;
		});
		const barrierHasher: PasswordHasher = {
			hash: async (password) => new CountingHasher().hash(password),
			verify: async (password, storedVerifier) => {
				verifyStarted();
				await held;
				return (
					createHash("sha256").update(`x:${password}`).digest("hex") ===
					storedVerifier
				);
			},
		};

		const service = new SessionAuthService(sqliteStore(repo), barrierHasher);
		const pending = createAuthLoginHandler(service)(
			loginRequest({ password: "hunter2" }),
		);
		await started;

		// The CLI replaces the verifier and deletes every session. This COMMITS
		// while the login is still inside its derivation.
		const rotated = await new CountingHasher().hash("a new password");
		await repo.setPassword(rotated.verifier, rotated.params, 2);

		releaseVerify();
		const res = await pending;

		expect(res.status).toBe(401);
		expect(res.headers.get("set-cookie")).toBeNull();
		// The whole point: no 30-day session exists for the revoked password.
		expect(db.query(`SELECT COUNT(*) AS n FROM auth_sessions`).get()).toEqual({
			n: 0,
		});
		db.close();
	});

	it("still issues a session when no rotation happened", async () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		const repo = new AuthRepository(new BunSqlAdapter(db));
		const { verifier, params } = await new CountingHasher().hash("hunter2");
		await repo.setPassword(verifier, params, 1);

		const service = new SessionAuthService(
			sqliteStore(repo),
			new CountingHasher(),
		);
		const res = await createAuthLoginHandler(service)(
			loginRequest({ password: "hunter2" }),
		);

		expect(res.status).toBe(200);
		expect(db.query(`SELECT COUNT(*) AS n FROM auth_sessions`).get()).toEqual({
			n: 1,
		});
		db.close();
	});
});

describe("POST /api/auth/logout", () => {
	it("deletes the session and clears the cookie", async () => {
		const binding = await configure("hunter2");
		const { token } = await svc.createSession(binding);
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
		const binding = await configure("hunter2");
		const { token } = await svc.createSession(binding);
		const res = await createAuthStatusHandler(svc)(statusRequest(token));
		expect(await res.json()).toEqual({ configured: true, authenticated: true });
	});

	it("stops reporting a session after logout", async () => {
		const binding = await configure("hunter2");
		const { token } = await svc.createSession(binding);
		await svc.destroySession(statusRequest(token));
		const res = await createAuthStatusHandler(svc)(statusRequest(token));
		expect(await res.json()).toEqual({
			configured: true,
			authenticated: false,
		});
	});
});
