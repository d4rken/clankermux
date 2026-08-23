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

const TICK_MS = 5;

/**
 * Wait for a revocation to land, polling rather than sleeping a fixed span.
 *
 * Each tick does async DB-ish work, so "how many ticks fit in N ms" is a
 * property of machine load, not of the code under test. A fixed sleep here
 * would be a flake generator on a busy CI box; the deadline is generous because
 * it is only reached when the assertion is genuinely going to fail.
 */
async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, TICK_MS));
	}
}

/**
 * Give several revalidation ticks a chance to run and assert that NOTHING
 * happened. This one has to be a fixed span — there is no event to wait for.
 */
const settle = () => new Promise((r) => setTimeout(r, TICK_MS * 20));

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
		await waitFor(() => closed > 0);
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
		await waitFor(() => closed > 0);
		detach();
		expect(closed).toBeGreaterThan(0);
	});

	it("keeps a confirmed fail-open stream open well past that lifetime", async () => {
		const store = new FakeStore();
		let reads = 0;
		store.getManagementPassword = async () => {
			reads++;
			return null;
		};
		const svc = new SessionAuthService(store);
		// No password configured is the DEFAULT deployment, and both lanes stay
		// connected for hours. A watchdog that fires anyway drops a healthy
		// stream — and /api/logs/stream has no replay, so what it was carrying
		// across the reconnect is simply gone.
		const lifetimeMs = TICK_MS * 10;
		const guard = createSessionStreamGuard(svc, TICK_MS, lifetimeMs);
		let closed = 0;
		const startedAt = Date.now();
		const detach = guard.attach(streamRequest(), () => {
			closed++;
		});
		await new Promise((r) => setTimeout(r, lifetimeMs * 2));
		detach();
		// Every one of those checks answered, and each answer re-armed the
		// watchdog, so nothing bounded a connection nobody had lost track of.
		expect(Date.now() - startedAt).toBeGreaterThan(lifetimeMs);
		expect(reads).toBeGreaterThan(1);
		expect(closed).toBe(0);
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
		await waitFor(() => closed > 0);
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

describe("a revalidation that cannot answer fails CLOSED", () => {
	function gatedStore(): FakeStore {
		const store = new FakeStore();
		store.password = { verifier: "v", params: "{}", updatedAt: 0 };
		return store;
	}

	it("closes a protected stream when the store rejects", async () => {
		const store = gatedStore();
		const svc = new SessionAuthService(store);
		const session = await svc.createSession();
		if (!session) throw new Error("no session");
		// SQLITE_BUSY, a corrupt read, anything: the answer to "is this session
		// still live?" is now unknown, and unknown must not mean "keep streaming".
		store.getManagementPassword = async () => {
			throw new Error("database is locked");
		};
		const guard = createSessionStreamGuard(svc, TICK_MS);
		let closed = 0;
		const detach = guard.attach(streamRequest(session.token), () => {
			closed++;
		});
		await waitFor(() => closed > 0);
		detach();
		expect(closed).toBe(1);
	});

	it("closes a protected stream whose revalidation NEVER resolves", async () => {
		const store = gatedStore();
		const svc = new SessionAuthService(store);
		const session = await svc.createSession();
		if (!session) throw new Error("no session");
		// The adapter retries a busy database for minutes, so a stalled read can
		// outlast any deadline that is only checked AFTER it returns.
		store.getManagementPassword = () => new Promise(() => {});
		const guard = createSessionStreamGuard(svc, TICK_MS, TICK_MS * 2);
		let closed = 0;
		const detach = guard.attach(streamRequest(session.token), () => {
			closed++;
		});
		await waitFor(() => closed > 0);
		detach();
		expect(closed).toBe(1);
	});

	it("closes a COOKIE-LESS stream when the store starts failing", async () => {
		const store = new FakeStore();
		const svc = new SessionAuthService(store);
		const guard = createSessionStreamGuard(svc, TICK_MS);
		let closed = 0;
		const detach = guard.attach(streamRequest(), () => {
			closed++;
		});
		// The handshake read succeeded and said "unconfigured"; the store breaks
		// only afterwards. That earlier answer must NOT be reused: an operator
		// gates a fail-open deployment from the CLI at a moment of their choosing,
		// so "unconfigured when we last managed to look" says nothing about now.
		// Keeping the connection on the strength of it is fail-OPEN across exactly
		// the transition this mechanism exists to enforce.
		await new Promise((r) => setTimeout(r, TICK_MS));
		store.getManagementPassword = async () => {
			throw new Error("database is locked");
		};
		await waitFor(() => closed > 0);
		detach();
		expect(closed).toBe(1);
	});

	it("closes a stream opened fail-open when the read that would notice the new password REJECTS", async () => {
		const store = new FakeStore();
		const svc = new SessionAuthService(store);
		const guard = createSessionStreamGuard(svc, TICK_MS);
		let closed = 0;
		const detach = guard.attach(streamRequest(), () => {
			closed++;
		});
		// The exact operator sequence: a cookie-less client connects to an open
		// deployment, the CLI then sets a password, and the reads that would have
		// noticed start failing (SQLITE_BUSY retries, a locked file). The gate is
		// live and this connection is on the wrong side of it.
		await new Promise((r) => setTimeout(r, TICK_MS));
		store.password = { verifier: "v", params: "{}", updatedAt: 0 };
		store.getManagementPassword = async () => {
			throw new Error("database is locked");
		};
		await waitFor(() => closed > 0);
		detach();
		expect(closed).toBe(1);
	});

	it("closes a stream opened fail-open when that read NEVER RESOLVES", async () => {
		const store = new FakeStore();
		const svc = new SessionAuthService(store);
		// A stalled read reaches neither the answer nor the error path, and ticks
		// are serialized so nothing runs behind it either. The lifetime ceiling is
		// what bounds a connection nobody can revalidate — which is why it is armed
		// for every stream at the handshake, not only for the ones known to be
		// protected at that moment.
		const guard = createSessionStreamGuard(svc, TICK_MS, TICK_MS * 4);
		let closed = 0;
		const detach = guard.attach(streamRequest(), () => {
			closed++;
		});
		await new Promise((r) => setTimeout(r, TICK_MS));
		store.password = { verifier: "v", params: "{}", updatedAt: 0 };
		store.getManagementPassword = () => new Promise(() => {});
		await waitFor(() => closed > 0);
		detach();
		expect(closed).toBe(1);
	});

	it("never runs two revalidation ticks at once", async () => {
		const store = gatedStore();
		const svc = new SessionAuthService(store);
		const session = await svc.createSession();
		if (!session) throw new Error("no session");
		let inFlight = 0;
		let peak = 0;
		const stored = store.password;
		// Deliberately slower than the interval: without an in-flight guard the
		// timer stacks reads against the store it is already waiting on.
		store.getManagementPassword = async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, TICK_MS * 4));
			inFlight--;
			return stored;
		};
		const guard = createSessionStreamGuard(svc, TICK_MS);
		let closed = 0;
		const detach = guard.attach(streamRequest(session.token), () => {
			closed++;
		});
		await settle();
		detach();
		expect(peak).toBe(1);
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
