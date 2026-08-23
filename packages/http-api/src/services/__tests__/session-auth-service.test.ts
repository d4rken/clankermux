/**
 * The app-level login behind `/api/*`.
 *
 * Three properties carry the weight and are asserted repeatedly:
 *
 *  - FAIL-OPEN until a password exists. An upgrade must not lock an operator
 *    out of their own box, so "no verifier row" admits everything.
 *  - Session validation NEVER runs a key derivation. Scrypt per request is what
 *    produced the ~300ms API-key stalls fixed in v2026.8.41, and the login
 *    endpoint is the only place allowed to pay it.
 *  - Both lifetime ceilings are real and independent — a session dies at 30
 *    days regardless of activity, and at 7 days idle regardless of how far its
 *    absolute deadline still is.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type {
	AuthSessionRecord,
	StoredPasswordVerifier,
} from "@clankermux/database";
import {
	clearedSessionCookieHeader,
	hashSessionToken,
	type PasswordHasher,
	readSessionCookie,
	SESSION_ABSOLUTE_MAX_MS,
	SESSION_COOKIE_NAME,
	SESSION_IDLE_MAX_MS,
	SESSION_TOUCH_INTERVAL_MS,
	SessionAuthService,
	type SessionAuthStore,
	scryptPasswordHasher,
	sessionCookieHeader,
} from "../session-auth-service";

/** In-memory store with the same semantics as AuthRepository, minus SQL. */
class FakeStore implements SessionAuthStore {
	password: StoredPasswordVerifier | null = null;
	sessions = new Map<string, AuthSessionRecord>();
	touchCalls: { tokenHash: string; now: number; staleBefore: number }[] = [];

	async getManagementPassword(): Promise<StoredPasswordVerifier | null> {
		return this.password;
	}
	async createManagementSession(record: AuthSessionRecord): Promise<void> {
		this.sessions.set(record.tokenHash, { ...record });
	}
	async getManagementSession(
		tokenHash: string,
	): Promise<AuthSessionRecord | null> {
		return this.sessions.get(tokenHash) ?? null;
	}
	async touchManagementSession(
		tokenHash: string,
		now: number,
		staleBeforeMs: number,
	): Promise<number> {
		this.touchCalls.push({ tokenHash, now, staleBefore: staleBeforeMs });
		const row = this.sessions.get(tokenHash);
		if (!row || row.lastSeenAt >= staleBeforeMs) return 0;
		row.lastSeenAt = now;
		return 1;
	}
	async deleteManagementSession(tokenHash: string): Promise<number> {
		return this.sessions.delete(tokenHash) ? 1 : 0;
	}
	async cleanupExpiredManagementSessions(
		now: number,
		idleCutoff: number,
	): Promise<number> {
		let removed = 0;
		for (const [hash, row] of [...this.sessions]) {
			if (row.expiresAt <= now || row.lastSeenAt <= idleCutoff) {
				this.sessions.delete(hash);
				removed++;
			}
		}
		return removed;
	}
}

/**
 * A cheap stand-in for scrypt that COUNTS derivations. Its whole purpose is to
 * let a test assert that session validation performed none.
 */
class CountingHasher implements PasswordHasher {
	hashCalls = 0;
	verifyCalls = 0;

	async hash(password: string) {
		this.hashCalls++;
		return {
			verifier: createHash("sha256").update(`x:${password}`).digest("hex"),
			params: JSON.stringify({ v: 1, kdf: "fake" }),
		};
	}
	async verify(password: string, verifier: string) {
		this.verifyCalls++;
		return (
			createHash("sha256").update(`x:${password}`).digest("hex") === verifier
		);
	}
}

function makeService(over: { now?: () => number } = {}) {
	const store = new FakeStore();
	const hasher = new CountingHasher();
	const clock = over.now ?? (() => 1_000_000);
	const svc = new SessionAuthService(store, hasher, clock);
	return { store, hasher, svc };
}

async function configure(
	store: FakeStore,
	hasher: CountingHasher,
	password: string,
) {
	const { verifier, params } = await hasher.hash(password);
	store.password = { verifier, params, updatedAt: 0 };
	hasher.hashCalls = 0;
}

function requestWithCookie(token?: string): Request {
	return new Request("http://localhost/api/accounts", {
		headers: token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {},
	});
}

describe("fail-open until a password is set", () => {
	it("reports unconfigured on a fresh deployment", async () => {
		const { svc } = makeService();
		expect(await svc.isConfigured()).toBe(false);
	});

	it("admits a request with no cookie at all", async () => {
		const { svc } = makeService();
		expect(await svc.authorizeRequest(requestWithCookie())).toBe(true);
	});

	it("reports configured:false, authenticated:false rather than claiming a session", async () => {
		const { svc } = makeService();
		expect(await svc.checkRequest(requestWithCookie("anything"))).toEqual({
			configured: false,
			authenticated: false,
			tokenHash: null,
		});
	});

	it("never verifies a password when none is stored", async () => {
		const { svc, hasher } = makeService();
		expect(await svc.verifyPassword("guess")).toBe(false);
		expect(hasher.verifyCalls).toBe(0);
	});

	it("gates once a password exists", async () => {
		const { svc, store, hasher } = makeService();
		await configure(store, hasher, "hunter2");
		expect(await svc.authorizeRequest(requestWithCookie())).toBe(false);
	});
});

describe("password verification", () => {
	it("accepts the configured password and rejects everything else", async () => {
		const { svc, store, hasher } = makeService();
		await configure(store, hasher, "hunter2");
		expect(await svc.verifyPassword("hunter2")).toBe(true);
		expect(await svc.verifyPassword("hunter3")).toBe(false);
	});

	it("round-trips through the real scrypt hasher", async () => {
		const store = new FakeStore();
		const svc = new SessionAuthService(store, scryptPasswordHasher);
		const { verifier, params } =
			await scryptPasswordHasher.hash("correct horse");
		store.password = { verifier, params, updatedAt: 0 };
		expect(await svc.verifyPassword("correct horse")).toBe(true);
		expect(await svc.verifyPassword("correct hors")).toBe(false);
	});

	it("refuses rather than throws when the stored parameters are unusable", async () => {
		const store = new FakeStore();
		const svc = new SessionAuthService(store, scryptPasswordHasher);
		store.password = { verifier: "aa", params: "not json", updatedAt: 0 };
		expect(await svc.verifyPassword("anything")).toBe(false);
		store.password = {
			verifier: "aa",
			params: JSON.stringify({ kdf: "argon2" }),
			updatedAt: 0,
		};
		expect(await svc.verifyPassword("anything")).toBe(false);
	});

	it("carries the cost parameters that produced the verifier", async () => {
		const { params } = await scryptPasswordHasher.hash("pw");
		const parsed = JSON.parse(params);
		expect(parsed.kdf).toBe("scrypt");
		expect(parsed.v).toBe(1);
		expect(typeof parsed.salt).toBe("string");
		expect(parsed.n).toBeGreaterThan(1);
	});
});

describe("session validation costs no key derivation", () => {
	it("performs zero derivations across many validations", async () => {
		const { svc, store, hasher } = makeService();
		await configure(store, hasher, "hunter2");
		const { token } = await svc.createSession();
		hasher.verifyCalls = 0;
		for (let i = 0; i < 25; i++) {
			expect(await svc.authorizeRequest(requestWithCookie(token))).toBe(true);
		}
		expect(hasher.verifyCalls).toBe(0);
		expect(hasher.hashCalls).toBe(0);
	});

	it("stores only the token's hash, never the token", async () => {
		const { svc, store, hasher } = makeService();
		await configure(store, hasher, "hunter2");
		const { token } = await svc.createSession();
		expect([...store.sessions.keys()]).toEqual([hashSessionToken(token)]);
		expect(JSON.stringify([...store.sessions.keys()])).not.toContain(token);
	});
});

describe("session lifetime", () => {
	it("sets the absolute deadline 30 days out", async () => {
		const { svc, store, hasher } = makeService({ now: () => 1_000 });
		await configure(store, hasher, "pw");
		const { expiresAt } = await svc.createSession();
		expect(expiresAt).toBe(1_000 + SESSION_ABSOLUTE_MAX_MS);
		expect(SESSION_ABSOLUTE_MAX_MS).toBe(30 * 24 * 60 * 60 * 1000);
	});

	it("rejects a session past its absolute deadline even when it was just used", async () => {
		let now = 1_000;
		const { svc, store, hasher } = makeService({ now: () => now });
		await configure(store, hasher, "pw");
		const { token } = await svc.createSession();
		now += SESSION_ABSOLUTE_MAX_MS;
		// Activity right up to the deadline does not extend it.
		const row = store.sessions.get(hashSessionToken(token));
		if (!row) throw new Error("session was not stored");
		row.lastSeenAt = now - 1;
		expect(await svc.authorizeRequest(requestWithCookie(token))).toBe(false);
	});

	it("rejects a session idle past 7 days while its absolute deadline is far away", async () => {
		let now = 1_000;
		const { svc, store, hasher } = makeService({ now: () => now });
		await configure(store, hasher, "pw");
		const { token } = await svc.createSession();
		now += SESSION_IDLE_MAX_MS;
		expect(await svc.authorizeRequest(requestWithCookie(token))).toBe(false);
		expect(SESSION_IDLE_MAX_MS).toBe(7 * 24 * 60 * 60 * 1000);
		expect(SESSION_IDLE_MAX_MS).toBeLessThan(SESSION_ABSOLUTE_MAX_MS);
	});

	it("deletes the row it just rejected rather than leaving it for the sweep", async () => {
		let now = 1_000;
		const { svc, store, hasher } = makeService({ now: () => now });
		await configure(store, hasher, "pw");
		const { token } = await svc.createSession();
		now += SESSION_ABSOLUTE_MAX_MS;
		await svc.authorizeRequest(requestWithCookie(token));
		expect(store.sessions.size).toBe(0);
	});

	it("sweeps both classes of dead session", async () => {
		const now = 1_000;
		const { svc, store, hasher } = makeService({ now: () => now });
		await configure(store, hasher, "pw");
		store.sessions.set("expired", {
			tokenHash: "expired",
			createdAt: 0,
			expiresAt: 500,
			lastSeenAt: 500,
		});
		store.sessions.set("idle", {
			tokenHash: "idle",
			createdAt: 0,
			expiresAt: now + SESSION_ABSOLUTE_MAX_MS,
			lastSeenAt: now - SESSION_IDLE_MAX_MS,
		});
		store.sessions.set("live", {
			tokenHash: "live",
			createdAt: 0,
			expiresAt: now + SESSION_ABSOLUTE_MAX_MS,
			lastSeenAt: now,
		});
		expect(await svc.sweepExpiredSessions()).toBe(2);
		expect([...store.sessions.keys()]).toEqual(["live"]);
	});
});

describe("activity touch is conditional and never blocking", () => {
	it("asks for a write only against an hour-old staleness bound", async () => {
		const now = 10 * SESSION_TOUCH_INTERVAL_MS;
		const { svc, store, hasher } = makeService({ now: () => now });
		await configure(store, hasher, "pw");
		const { token } = await svc.createSession();
		store.touchCalls = [];
		await svc.authorizeRequest(requestWithCookie(token));
		await Promise.resolve();
		expect(store.touchCalls).toHaveLength(1);
		expect(store.touchCalls[0]?.staleBefore).toBe(
			now - SESSION_TOUCH_INTERVAL_MS,
		);
	});

	it("leaves last_seen_at alone for a session touched moments ago", async () => {
		const now = 10 * SESSION_TOUCH_INTERVAL_MS;
		const { svc, store, hasher } = makeService({ now: () => now });
		await configure(store, hasher, "pw");
		const { token } = await svc.createSession();
		const before = store.sessions.get(hashSessionToken(token))?.lastSeenAt;
		await svc.authorizeRequest(requestWithCookie(token));
		await Promise.resolve();
		expect(store.sessions.get(hashSessionToken(token))?.lastSeenAt).toBe(
			before,
		);
	});

	it("still authenticates when the activity write fails", async () => {
		const { svc, store, hasher } = makeService();
		await configure(store, hasher, "pw");
		const { token } = await svc.createSession();
		store.touchManagementSession = async () => {
			throw new Error("database is locked");
		};
		expect(await svc.authorizeRequest(requestWithCookie(token))).toBe(true);
	});
});

describe("logout", () => {
	it("removes the row and reports the hash it removed", async () => {
		const { svc, store, hasher } = makeService();
		await configure(store, hasher, "pw");
		const { token } = await svc.createSession();
		expect(await svc.destroySession(requestWithCookie(token))).toBe(
			hashSessionToken(token),
		);
		expect(store.sessions.size).toBe(0);
	});

	it("reports nothing removed when the request carried no cookie", async () => {
		const { svc } = makeService();
		expect(await svc.destroySession(requestWithCookie())).toBeNull();
	});

	it("invalidates the token for every later request", async () => {
		const { svc, store, hasher } = makeService();
		await configure(store, hasher, "pw");
		const { token } = await svc.createSession();
		await svc.destroySession(requestWithCookie(token));
		expect(await svc.authorizeRequest(requestWithCookie(token))).toBe(false);
	});
});

describe("cookie handling", () => {
	it("picks the session cookie out of a crowded header", () => {
		const req = new Request("http://localhost/", {
			headers: {
				cookie: `theme=dark; ${SESSION_COOKIE_NAME}=abc123; other=1`,
			},
		});
		expect(readSessionCookie(req)).toBe("abc123");
	});

	it("returns null for an absent, empty or foreign cookie", () => {
		expect(readSessionCookie(new Request("http://localhost/"))).toBeNull();
		expect(
			readSessionCookie(
				new Request("http://localhost/", {
					headers: { cookie: `${SESSION_COOKIE_NAME}=` },
				}),
			),
		).toBeNull();
		expect(
			readSessionCookie(
				new Request("http://localhost/", { headers: { cookie: "other=x" } }),
			),
		).toBeNull();
	});

	it("does not match a cookie whose name merely ends with ours", () => {
		const req = new Request("http://localhost/", {
			headers: { cookie: `not_${SESSION_COOKIE_NAME}=abc` },
		});
		expect(readSessionCookie(req)).toBeNull();
	});

	it("issues an HttpOnly, SameSite=Strict, root-path cookie", () => {
		const header = sessionCookieHeader("tok");
		expect(header).toContain(`${SESSION_COOKIE_NAME}=tok`);
		expect(header).toContain("HttpOnly");
		expect(header).toContain("SameSite=Strict");
		expect(header).toContain("Path=/");
		expect(header).toContain("Max-Age=2592000");
	});

	it("clears with Max-Age=0", () => {
		expect(clearedSessionCookieHeader()).toContain("Max-Age=0");
	});
});
