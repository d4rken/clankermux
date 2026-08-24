import { BaseRepository } from "./base.repository";

/** The single stored management password, as written by the CLI. */
export interface StoredPasswordVerifier {
	/** scrypt output over the operator's password, hex. */
	verifier: string;
	/**
	 * Versioned cost parameters that produced {@link verifier}, serialized.
	 * Carried alongside the verifier so the cost can be raised later without
	 * invalidating verifiers written under the old one.
	 */
	params: string;
	updatedAt: number;
}

/**
 * The stored password a session may be bound to when it is created.
 *
 * A login reads the verifier, then spends ~35ms in scrypt before it can insert
 * anything. An operator rotating the password in that window commits a NEW
 * verifier and deletes every session; without this binding the insert that
 * follows would mint a fresh 30-day session from the verifier that was just
 * revoked. Carrying the exact pair the check ran against lets the insert refuse
 * itself when the stored password is no longer that pair.
 */
export interface PasswordBinding {
	verifier: string;
	params: string;
}

/** One live management session. */
export interface AuthSessionRecord {
	/** Unsalted SHA-256 of the cookie value, hex. */
	tokenHash: string;
	createdAt: number;
	expiresAt: number;
	lastSeenAt: number;
}

/**
 * Storage for the management password verifier and the sessions it issues.
 *
 * Two invariants live here rather than in the caller:
 *
 *  - `auth_password` holds at most one row (the table's `CHECK (id = 1)`), so
 *    "the password" cannot silently become a set of passwords.
 *  - Setting OR clearing the password deletes every session in the SAME
 *    transaction. Without that, rotating away from a compromised password would
 *    leave stolen cookies valid, and a clear-then-set could reactivate sessions
 *    issued under the password before the clear.
 *
 * The transactional methods run through `bun:sqlite`'s `db.transaction()`, whose
 * callback is synchronous — nothing can interleave inside the `BEGIN`, so no
 * unrelated write can be swept into it.
 */
export class AuthRepository extends BaseRepository<AuthSessionRecord> {
	async getPassword(): Promise<StoredPasswordVerifier | null> {
		const row = await this.get<{
			verifier: string;
			params: string;
			updated_at: number;
		}>(`SELECT verifier, params, updated_at FROM auth_password WHERE id = 1`);
		if (!row) return null;
		return {
			verifier: row.verifier,
			params: row.params,
			updatedAt: Number(row.updated_at),
		};
	}

	/**
	 * Replace the stored verifier and invalidate every session, atomically.
	 * Returns the number of sessions that were revoked.
	 */
	async setPassword(
		verifier: string,
		params: string,
		updatedAt: number,
	): Promise<number> {
		const db = this.adapter.getSQLiteDb();
		let revoked = 0;
		db.transaction(() => {
			revoked = db.run(`DELETE FROM auth_sessions`).changes;
			db.run(
				`INSERT INTO auth_password (id, verifier, params, updated_at)
				 VALUES (1, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					verifier = excluded.verifier,
					params = excluded.params,
					updated_at = excluded.updated_at`,
				[verifier, params, updatedAt],
			);
		})();
		return revoked;
	}

	/**
	 * Remove the stored verifier (returning the deployment to fail-open) and
	 * invalidate every session, atomically. Returns the sessions revoked.
	 */
	async clearPassword(): Promise<number> {
		const db = this.adapter.getSQLiteDb();
		let revoked = 0;
		db.transaction(() => {
			revoked = db.run(`DELETE FROM auth_sessions`).changes;
			db.run(`DELETE FROM auth_password`);
		})();
		return revoked;
	}

	/**
	 * Insert a session, CONDITIONAL on the password it was authorized by still
	 * being the stored one. Returns the rows inserted, so 0 means the password
	 * changed under the caller and the session was NOT issued.
	 *
	 * The binding is required, and there is deliberately no unconditional form.
	 * A session exists because a password authorized it, so a caller that cannot
	 * name which one has nothing to issue a session for — and an optional
	 * parameter is one forgotten argument away from reinstating exactly the race
	 * this refuses.
	 *
	 * The condition is part of the INSERT rather than a read-then-write, because
	 * a read-then-write is the same race one statement further down: SQLite
	 * evaluates the `WHERE EXISTS` and the insert inside a single implicit
	 * transaction, so a rotation either lands entirely before it (and the insert
	 * finds no matching verifier) or entirely after it (and revokes the row it
	 * just wrote).
	 */
	async createSession(
		record: AuthSessionRecord,
		boundTo: PasswordBinding,
	): Promise<number> {
		return this.runWithChanges(
			`INSERT INTO auth_sessions (token_hash, created_at, expires_at, last_seen_at)
			 SELECT ?, ?, ?, ?
			 WHERE EXISTS (
				SELECT 1 FROM auth_password
				WHERE id = 1 AND verifier = ? AND params = ?
			 )`,
			[
				record.tokenHash,
				record.createdAt,
				record.expiresAt,
				record.lastSeenAt,
				boundTo.verifier,
				boundTo.params,
			],
		);
	}

	/**
	 * One indexed lookup on the primary key. Deliberately returns the row
	 * unfiltered — expiry (absolute AND idle) is the service's decision, and it
	 * needs the timestamps to make it.
	 */
	async getSession(tokenHash: string): Promise<AuthSessionRecord | null> {
		const row = await this.get<{
			token_hash: string;
			created_at: number;
			expires_at: number;
			last_seen_at: number;
		}>(
			`SELECT token_hash, created_at, expires_at, last_seen_at
			 FROM auth_sessions WHERE token_hash = ?`,
			[tokenHash],
		);
		if (!row) return null;
		return {
			tokenHash: row.token_hash,
			createdAt: Number(row.created_at),
			expiresAt: Number(row.expires_at),
			lastSeenAt: Number(row.last_seen_at),
		};
	}

	/**
	 * Bump `last_seen_at`, but only when the stored value is already older than
	 * `staleBeforeMs`. The guard is IN THE STATEMENT so a dashboard polling eight
	 * endpoints concurrently cannot turn every protected GET into a SQLite write.
	 */
	async touchSession(
		tokenHash: string,
		now: number,
		staleBeforeMs: number,
	): Promise<number> {
		return this.runWithChanges(
			`UPDATE auth_sessions SET last_seen_at = ?
			 WHERE token_hash = ? AND last_seen_at < ?`,
			[now, tokenHash, staleBeforeMs],
		);
	}

	async deleteSession(tokenHash: string): Promise<number> {
		return this.runWithChanges(
			`DELETE FROM auth_sessions WHERE token_hash = ?`,
			[tokenHash],
		);
	}

	async deleteAllSessions(): Promise<number> {
		return this.runWithChanges(`DELETE FROM auth_sessions`);
	}

	/**
	 * Sweep sessions that are past their absolute deadline OR have been idle past
	 * `idleCutoff`. Both bounds are explicit; neither alone is the lifetime.
	 */
	async deleteExpiredSessions(
		now: number,
		idleCutoff: number,
	): Promise<number> {
		return this.runWithChanges(
			`DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at <= ?`,
			[now, idleCutoff],
		);
	}
}
