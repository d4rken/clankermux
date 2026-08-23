/**
 * Tests for AuthRepository — the management password verifier and the sessions
 * it issues.
 *
 * The properties that matter here are the ones a caller cannot restore after
 * the fact: at most one password row, and rotation (set OR clear) revoking
 * every session in the same transaction. A rotation that left old cookies valid
 * would make "change the password" not actually lock anyone out, which is the
 * whole reason the operator rotates.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { AuthRepository } from "./auth.repository";

let db: Database;
let repo: AuthRepository;

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	repo = new AuthRepository(new BunSqlAdapter(db));
});

afterEach(() => {
	db.close();
});

function session(
	tokenHash: string,
	over: Partial<{
		createdAt: number;
		expiresAt: number;
		lastSeenAt: number;
	}> = {},
) {
	return {
		tokenHash,
		createdAt: over.createdAt ?? 1_000,
		expiresAt: over.expiresAt ?? 100_000,
		lastSeenAt: over.lastSeenAt ?? 1_000,
	};
}

describe("password storage", () => {
	it("reports no password on a fresh database", async () => {
		expect(await repo.getPassword()).toBeNull();
	});

	it("round-trips the verifier and its cost parameters", async () => {
		await repo.setPassword("deadbeef", '{"v":1,"N":16384}', 5_000);
		expect(await repo.getPassword()).toEqual({
			verifier: "deadbeef",
			params: '{"v":1,"N":16384}',
			updatedAt: 5_000,
		});
	});

	it("keeps exactly one row across repeated sets", async () => {
		await repo.setPassword("one", "{}", 1);
		await repo.setPassword("two", "{}", 2);
		const rows = db.query(`SELECT id, verifier FROM auth_password`).all();
		expect(rows).toEqual([{ id: 1, verifier: "two" }]);
	});

	it("refuses a second row outright", () => {
		db.run(
			`INSERT INTO auth_password (id, verifier, params, updated_at) VALUES (1, 'a', '{}', 1)`,
		);
		expect(() =>
			db.run(
				`INSERT INTO auth_password (id, verifier, params, updated_at) VALUES (2, 'b', '{}', 2)`,
			),
		).toThrow();
	});

	it("clears back to the fail-open state", async () => {
		await repo.setPassword("one", "{}", 1);
		await repo.clearPassword();
		expect(await repo.getPassword()).toBeNull();
	});
});

describe("rotation invalidates sessions", () => {
	it("deletes every session when the password is set", async () => {
		await repo.createSession(session("a"));
		await repo.createSession(session("b"));
		const revoked = await repo.setPassword("new", "{}", 10);
		expect(revoked).toBe(2);
		expect(await repo.getSession("a")).toBeNull();
		expect(await repo.getSession("b")).toBeNull();
	});

	it("deletes every session when the password is cleared", async () => {
		await repo.setPassword("old", "{}", 1);
		await repo.createSession(session("a"));
		const revoked = await repo.clearPassword();
		expect(revoked).toBe(1);
		expect(await repo.getSession("a")).toBeNull();
	});

	it("cannot reactivate pre-clear sessions via clear-then-set", async () => {
		await repo.setPassword("old", "{}", 1);
		await repo.createSession(session("a"));
		await repo.clearPassword();
		await repo.setPassword("new", "{}", 2);
		expect(await repo.getSession("a")).toBeNull();
		expect(db.query(`SELECT COUNT(*) as n FROM auth_sessions`).get()).toEqual({
			n: 0,
		});
	});

	it("leaves neither half applied if the transaction cannot commit", async () => {
		await repo.setPassword("old", "{}", 1);
		await repo.createSession(session("a"));
		// A CHECK violation inside the transaction: the verifier write fails, so
		// the session delete that preceded it must roll back with it.
		expect(() => {
			db.transaction(() => {
				db.run(`DELETE FROM auth_sessions`);
				db.run(
					`INSERT INTO auth_password (id, verifier, params, updated_at) VALUES (2, 'x', '{}', 3)`,
				);
			})();
		}).toThrow();
		expect(await repo.getSession("a")).not.toBeNull();
		expect((await repo.getPassword())?.verifier).toBe("old");
	});
});

describe("session lifecycle", () => {
	it("round-trips a session by its token hash", async () => {
		await repo.createSession(
			session("hash", { createdAt: 5, expiresAt: 500, lastSeenAt: 7 }),
		);
		expect(await repo.getSession("hash")).toEqual({
			tokenHash: "hash",
			createdAt: 5,
			expiresAt: 500,
			lastSeenAt: 7,
		});
	});

	it("returns an expired row rather than filtering it — expiry is the caller's call", async () => {
		await repo.createSession(session("hash", { expiresAt: 1 }));
		expect(await repo.getSession("hash")).not.toBeNull();
	});

	it("deletes one session without touching the others", async () => {
		await repo.createSession(session("a"));
		await repo.createSession(session("b"));
		expect(await repo.deleteSession("a")).toBe(1);
		expect(await repo.getSession("a")).toBeNull();
		expect(await repo.getSession("b")).not.toBeNull();
	});

	it("reports zero rows removed for an unknown token", async () => {
		expect(await repo.deleteSession("nope")).toBe(0);
	});
});

describe("touch is conditional", () => {
	it("writes when last_seen_at is older than the staleness bound", async () => {
		await repo.createSession(session("a", { lastSeenAt: 1_000 }));
		const changed = await repo.touchSession("a", 9_000, 5_000);
		expect(changed).toBe(1);
		expect((await repo.getSession("a"))?.lastSeenAt).toBe(9_000);
	});

	it("writes nothing when the stored value is already recent", async () => {
		await repo.createSession(session("a", { lastSeenAt: 8_000 }));
		const changed = await repo.touchSession("a", 9_000, 5_000);
		expect(changed).toBe(0);
		expect((await repo.getSession("a"))?.lastSeenAt).toBe(8_000);
	});
});

describe("expiry sweep", () => {
	it("removes rows past their absolute deadline", async () => {
		await repo.createSession(
			session("dead", { expiresAt: 500, lastSeenAt: 500 }),
		);
		await repo.createSession(
			session("live", { expiresAt: 5_000, lastSeenAt: 900 }),
		);
		expect(await repo.deleteExpiredSessions(1_000, 0)).toBe(1);
		expect(await repo.getSession("dead")).toBeNull();
		expect(await repo.getSession("live")).not.toBeNull();
	});

	it("removes rows idle past the idle cutoff even when the absolute deadline is far away", async () => {
		await repo.createSession(
			session("idle", { expiresAt: 1_000_000, lastSeenAt: 100 }),
		);
		expect(await repo.deleteExpiredSessions(1_000, 500)).toBe(1);
		expect(await repo.getSession("idle")).toBeNull();
	});

	it("keeps a row that satisfies both bounds", async () => {
		await repo.createSession(
			session("ok", { expiresAt: 1_000_000, lastSeenAt: 900 }),
		);
		expect(await repo.deleteExpiredSessions(1_000, 500)).toBe(0);
		expect(await repo.getSession("ok")).not.toBeNull();
	});
});
