/**
 * Revocation for the two long-running SSE lanes.
 *
 * Both authenticate at the handshake and then run indefinitely on listeners and
 * heartbeats. The handshake is a moment; the connection is a day. Without
 * periodic revalidation a copied cookie keeps receiving management events long
 * after its session has expired or been deleted — including after an operator
 * has rotated the password specifically to stop it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type {
	AuthSessionRecord,
	StoredPasswordVerifier,
} from "@clankermux/database";
import {
	hashSessionToken,
	SESSION_COOKIE_NAME,
	SessionAuthService,
	type SessionAuthStore,
} from "../session-auth-service";
import {
	closeStreamsForSession,
	createSessionStreamGuard,
	resetSessionStreamRegistryForTests,
} from "../session-stream-registry";

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

const TICK_MS = 5;
/** Long enough for several revalidation ticks to have run. */
const settle = () => new Promise((r) => setTimeout(r, TICK_MS * 6));

function streamRequest(token?: string): Request {
	return new Request("http://localhost/api/requests/stream", {
		headers: token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {},
	});
}

afterEach(() => {
	resetSessionStreamRegistryForTests();
});

describe("periodic revalidation", () => {
	it("leaves a stream alone while no password is configured", async () => {
		const store = new FakeStore();
		const svc = new SessionAuthService(store);
		const guard = createSessionStreamGuard(svc, TICK_MS);
		let closed = 0;
		const detach = guard.attach(streamRequest(), () => {
			closed++;
		});
		await settle();
		detach();
		expect(closed).toBe(0);
	});

	it("closes a stream whose session row has been deleted", async () => {
		const store = new FakeStore();
		store.password = { verifier: "v", params: "{}", updatedAt: 0 };
		const svc = new SessionAuthService(store);
		const { token } = await svc.createSession();
		const guard = createSessionStreamGuard(svc, TICK_MS);
		let closed = 0;
		const detach = guard.attach(streamRequest(token), () => {
			closed++;
		});
		store.sessions.delete(hashSessionToken(token));
		await settle();
		detach();
		expect(closed).toBeGreaterThan(0);
	});

	it("closes a stream opened while fail-open once a password appears", async () => {
		const store = new FakeStore();
		const svc = new SessionAuthService(store);
		const guard = createSessionStreamGuard(svc, TICK_MS);
		let closed = 0;
		const detach = guard.attach(streamRequest(), () => {
			closed++;
		});
		// The CLI sets a password out of process; the poll is what notices.
		store.password = { verifier: "v", params: "{}", updatedAt: 0 };
		await settle();
		detach();
		expect(closed).toBeGreaterThan(0);
	});

	it("closes a stream past its bounded lifetime even with a live session", async () => {
		const store = new FakeStore();
		store.password = { verifier: "v", params: "{}", updatedAt: 0 };
		const svc = new SessionAuthService(store);
		const { token } = await svc.createSession();
		const guard = createSessionStreamGuard(svc, TICK_MS, 0);
		let closed = 0;
		const detach = guard.attach(streamRequest(token), () => {
			closed++;
		});
		await settle();
		detach();
		expect(closed).toBeGreaterThan(0);
		// The session itself is untouched — only the connection was bounded.
		expect(store.sessions.has(hashSessionToken(token))).toBe(true);
	});

	it("keeps a live session's stream open", async () => {
		const store = new FakeStore();
		store.password = { verifier: "v", params: "{}", updatedAt: 0 };
		const svc = new SessionAuthService(store);
		const { token } = await svc.createSession();
		const guard = createSessionStreamGuard(svc, TICK_MS);
		let closed = 0;
		const detach = guard.attach(streamRequest(token), () => {
			closed++;
		});
		await settle();
		detach();
		expect(closed).toBe(0);
	});

	it("stops revalidating once the stream detaches", async () => {
		const store = new FakeStore();
		store.password = { verifier: "v", params: "{}", updatedAt: 0 };
		const svc = new SessionAuthService(store);
		const { token } = await svc.createSession();
		const guard = createSessionStreamGuard(svc, TICK_MS);
		let closed = 0;
		const detach = guard.attach(streamRequest(token), () => {
			closed++;
		});
		detach();
		store.sessions.clear();
		await settle();
		expect(closed).toBe(0);
	});
});

describe("logout closes that session's streams immediately", () => {
	it("closes every stream registered under the token hash", async () => {
		const store = new FakeStore();
		store.password = { verifier: "v", params: "{}", updatedAt: 0 };
		const svc = new SessionAuthService(store);
		const { token } = await svc.createSession();
		const guard = createSessionStreamGuard(svc, 60_000);
		let closedA = 0;
		let closedB = 0;
		const detachA = guard.attach(streamRequest(token), () => {
			closedA++;
		});
		const detachB = guard.attach(streamRequest(token), () => {
			closedB++;
		});
		expect(closeStreamsForSession(hashSessionToken(token))).toBe(2);
		expect(closedA).toBe(1);
		expect(closedB).toBe(1);
		detachA();
		detachB();
	});

	it("leaves another session's streams running", async () => {
		const store = new FakeStore();
		store.password = { verifier: "v", params: "{}", updatedAt: 0 };
		const svc = new SessionAuthService(store);
		const mine = await svc.createSession();
		const theirs = await svc.createSession();
		const guard = createSessionStreamGuard(svc, 60_000);
		let closedTheirs = 0;
		const detach = guard.attach(streamRequest(theirs.token), () => {
			closedTheirs++;
		});
		expect(closeStreamsForSession(hashSessionToken(mine.token))).toBe(0);
		expect(closedTheirs).toBe(0);
		detach();
	});

	it("reports zero for a session with no streams", () => {
		expect(closeStreamsForSession("nothing")).toBe(0);
	});
});
