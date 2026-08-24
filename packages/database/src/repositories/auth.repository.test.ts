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

/**
 * Insert a session bound to whatever password is currently stored, seeding one
 * first when the test did not set its own.
 *
 * There is no unbound insert to fall back on: a session exists because a
 * password authorized it, so every test that wants one has to name that
 * password the way a login does.
 */
async function mintSession(record: ReturnType<typeof session>) {
	let stored = await repo.getPassword();
	if (!stored) {
		await repo.setPassword("seeded", "{}", 1);
		stored = await repo.getPassword();
	}
	if (!stored) throw new Error("no password was stored");
	return repo.createSession(record, {
		verifier: stored.verifier,
		params: stored.params,
	});
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
		await mintSession(session("a"));
		await mintSession(session("b"));
		const revoked = await repo.setPassword("new", "{}", 10);
		expect(revoked).toBe(2);
		expect(await repo.getSession("a")).toBeNull();
		expect(await repo.getSession("b")).toBeNull();
	});

	it("deletes every session when the password is cleared", async () => {
		await repo.setPassword("old", "{}", 1);
		await mintSession(session("a"));
		const revoked = await repo.clearPassword();
		expect(revoked).toBe(1);
		expect(await repo.getSession("a")).toBeNull();
	});

	it("cannot reactivate pre-clear sessions via clear-then-set", async () => {
		await repo.setPassword("old", "{}", 1);
		await mintSession(session("a"));
		await repo.clearPassword();
		await repo.setPassword("new", "{}", 2);
		expect(await repo.getSession("a")).toBeNull();
		expect(db.query(`SELECT COUNT(*) as n FROM auth_sessions`).get()).toEqual({
			n: 0,
		});
	});

	it("never lets a concurrent validation observe a half-applied rotation", async () => {
		await repo.setPassword("old", "{}", 1);
		for (const hash of ["a", "b", "c", "d"]) {
			await mintSession(session(hash));
		}

		// Interleave reads with the rotation.
		//
		// A validator is NOT one query — it reads the password, then the session
		// row — so it can straddle the rotation, and the pairing it lands on is
		// what matters. Exactly one pairing is unsafe: a NEW password beside a
		// session issued under the old one, which is "rotation happened and the
		// stolen cookie still works". That one is impossible because the delete
		// and the verifier write share a transaction whose callback runs
		// synchronously, so nothing can be scheduled between them.
		//
		// The mirror pairing (old verifier, sessions already gone) is reachable
		// and harmless: the validator finds no session and refuses.
		const observations: Array<{ verifier: string | null; live: number }> = [];
		const observe = async () => {
			const password = await repo.getPassword();
			let live = 0;
			for (const hash of ["a", "b", "c", "d"]) {
				if (await repo.getSession(hash)) live++;
			}
			observations.push({ verifier: password?.verifier ?? null, live });
		};

		await Promise.all([
			observe(),
			repo.setPassword("new", "{}", 2),
			observe(),
			observe(),
		]);
		await observe();

		for (const seen of observations) {
			if (seen.verifier === "new") {
				expect(seen.live).toBe(0);
			}
			// A pre-rotation reading must have seen all four or none — never a
			// partially-emptied table, which is what a non-transactional delete
			// would produce.
			if (seen.verifier === "old") {
				expect([0, 4]).toContain(seen.live);
			}
		}
		// And the end state is unambiguous.
		expect((await repo.getPassword())?.verifier).toBe("new");
		expect(await repo.getSession("a")).toBeNull();
	});

	it("leaves neither half applied if the transaction cannot commit", async () => {
		await repo.setPassword("old", "{}", 1);
		await mintSession(session("a"));
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

describe("a session is bound to the password that authorized it", () => {
	it("inserts when the stored password is still the one that was verified", async () => {
		await repo.setPassword("v1", '{"n":1}', 1);
		const inserted = await repo.createSession(session("a"), {
			verifier: "v1",
			params: '{"n":1}',
		});
		expect(inserted).toBe(1);
		expect(await repo.getSession("a")).not.toBeNull();
	});

	it("inserts NOTHING when the verifier was replaced between verify and insert", async () => {
		await repo.setPassword("v1", "{}", 1);
		// The login read "v1", then spent ~35ms in scrypt. The operator rotated
		// inside that window: a new verifier is stored and every session is gone.
		await repo.setPassword("v2", "{}", 2);
		const inserted = await repo.createSession(session("a"), {
			verifier: "v1",
			params: "{}",
		});
		expect(inserted).toBe(0);
		expect(await repo.getSession("a")).toBeNull();
	});

	it("inserts nothing when the password was cleared entirely", async () => {
		await repo.setPassword("v1", "{}", 1);
		await repo.clearPassword();
		expect(
			await repo.createSession(session("a"), {
				verifier: "v1",
				params: "{}",
			}),
		).toBe(0);
		expect(await repo.getSession("a")).toBeNull();
	});

	it("inserts nothing when only the cost parameters were rotated", async () => {
		// Same secret re-hashed at a higher cost: the pair the login checked is no
		// longer the stored pair, so its session must not be issued either.
		await repo.setPassword("v1", '{"n":16384}', 1);
		await repo.setPassword("v2", '{"n":32768}', 2);
		expect(
			await repo.createSession(session("a"), {
				verifier: "v1",
				params: '{"n":16384}',
			}),
		).toBe(0);
	});
});

describe("the binding is enforced by the STATEMENT, not by the signature", () => {
	// The required parameter is the first line of defence and the reason no
	// caller can forget it today. It is not the guard: a future optional
	// parameter with an unconditional fallback would compile at every call site
	// and be caught by no existing test, because every existing test passes a
	// binding. What has to hold under that change is the SQL, so these two
	// deliberately defeat the types to reach it.

	it("refuses a call that omits the binding entirely", async () => {
		await repo.setPassword("v1", "{}", 1);
		// Cast purely to write a call the compiler forbids — `createSession`
		// requires a PasswordBinding, so this cannot exist in production code.
		const unbound = repo.createSession as unknown as (
			record: ReturnType<typeof session>,
		) => Promise<number>;
		await expect(unbound.call(repo, session("a"))).rejects.toThrow();
		expect(await repo.getSession("a")).toBeNull();
	});

	it("inserts NOTHING when the binding names no password", async () => {
		await repo.setPassword("v1", "{}", 1);
		// The shape a reinstated fallback would produce: the statement really
		// runs, against a database whose password row is present and correct, and
		// still inserts nothing because `WHERE EXISTS` has nothing to match. That
		// is the guard failing closed on its own — a login that cannot name the
		// password it verified against gets no session, whatever the types above
		// it were persuaded to allow.
		const unbound = repo.createSession as unknown as (
			record: ReturnType<typeof session>,
			boundTo: { verifier?: string; params?: string },
		) => Promise<number>;
		expect(await unbound.call(repo, session("a"), {})).toBe(0);
		expect(await repo.getSession("a")).toBeNull();
		expect(db.query(`SELECT COUNT(*) as n FROM auth_sessions`).get()).toEqual({
			n: 0,
		});
	});
});

describe("session lifecycle", () => {
	it("round-trips a session by its token hash", async () => {
		await mintSession(
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
		await mintSession(session("hash", { expiresAt: 1 }));
		expect(await repo.getSession("hash")).not.toBeNull();
	});

	it("deletes one session without touching the others", async () => {
		await mintSession(session("a"));
		await mintSession(session("b"));
		expect(await repo.deleteSession("a")).toBe(1);
		expect(await repo.getSession("a")).toBeNull();
		expect(await repo.getSession("b")).not.toBeNull();
	});

	it("reports zero rows removed for an unknown token", async () => {
		expect(await repo.deleteSession("nope")).toBe(0);
	});
});

describe("touch carries a staleness predicate — as a race guard, not a shield", () => {
	it("updates the row when last_seen_at is older than the staleness bound", async () => {
		await mintSession(session("a", { lastSeenAt: 1_000 }));
		const changed = await repo.touchSession("a", 9_000, 5_000);
		expect(changed).toBe(1);
		expect((await repo.getSession("a"))?.lastSeenAt).toBe(9_000);
	});

	it("changes NO ROW when the stored value is already recent", async () => {
		// Note what this does and does not prove. It proves the predicate holds,
		// so two validations that read the same stale row cannot both rewrite it.
		// It does NOT mean nothing was written: SQLite takes the writer slot for a
		// zero-row UPDATE too, which is why SessionAuthService decides from the
		// row it already read rather than calling this on every request.
		await mintSession(session("a", { lastSeenAt: 8_000 }));
		const changed = await repo.touchSession("a", 9_000, 5_000);
		expect(changed).toBe(0);
		expect((await repo.getSession("a"))?.lastSeenAt).toBe(8_000);
	});
});

describe("expiry sweep", () => {
	it("removes rows past their absolute deadline", async () => {
		await mintSession(session("dead", { expiresAt: 500, lastSeenAt: 500 }));
		await mintSession(session("live", { expiresAt: 5_000, lastSeenAt: 900 }));
		expect(await repo.deleteExpiredSessions(1_000, 0)).toBe(1);
		expect(await repo.getSession("dead")).toBeNull();
		expect(await repo.getSession("live")).not.toBeNull();
	});

	it("removes rows idle past the idle cutoff even when the absolute deadline is far away", async () => {
		await mintSession(
			session("idle", { expiresAt: 1_000_000, lastSeenAt: 100 }),
		);
		expect(await repo.deleteExpiredSessions(1_000, 500)).toBe(1);
		expect(await repo.getSession("idle")).toBeNull();
	});

	it("keeps a row that satisfies both bounds", async () => {
		await mintSession(session("ok", { expiresAt: 1_000_000, lastSeenAt: 900 }));
		expect(await repo.deleteExpiredSessions(1_000, 500)).toBe(0);
		expect(await repo.getSession("ok")).not.toBeNull();
	});
});
