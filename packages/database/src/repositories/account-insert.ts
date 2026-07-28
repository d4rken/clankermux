/**
 * Atomic, name-unique account insertion.
 *
 * Every `INSERT INTO accounts` in the codebase (the account-add handlers, the
 * device flows, and the OAuth/API-key callbacks) used to write unconditionally,
 * so two concurrent adds of the same name both succeeded. The one existing
 * pre-check — the Anthropic `begin()` name check — cannot help: it runs when the
 * OAuth flow STARTS, potentially minutes before the callback's insert.
 *
 * A `SELECT` followed by an `INSERT` is TOCTOU-prone, and a dashboard-side
 * submit latch only serializes ONE browser — not the HTTP API, the device flows,
 * or an OAuth callback. So the check and the insert are ONE statement:
 *
 *     INSERT INTO accounts (…) SELECT … WHERE NOT EXISTS (
 *       SELECT 1 FROM accounts WHERE name = ?)
 *
 * A single SQLite statement runs in its own implicit transaction, which makes
 * this atomic without opening an explicit `BEGIN IMMEDIATE` on the shared
 * connection (where an interleaved `await` could enclose unrelated writes, or a
 * nested BEGIN could throw).
 *
 * Collision key: the GLOBALLY unique `name`, not provider-scoped. That matches
 * both the rename logic and the Anthropic `begin()` check, which already treat
 * names as globally unique.
 *
 * No index and no migration: uniqueness is enforced by this statement, which is
 * the only path that writes new account rows.
 */

/** Minimal adapter surface this helper needs (the real BunSqlAdapter satisfies it). */
export interface AccountInsertAdapter {
	runWithChanges(sql: string, params: unknown[]): Promise<number>;
}

/**
 * Thrown when the requested account name is already taken.
 *
 * Carries `statusCode = 400` so `errorResponse` maps it to exactly the
 * `BadRequest` shape the Anthropic `begin()` pre-check already returns
 * (`{ error: "Account '<name>' already exists" }` at 400), on every one of the
 * insert paths, without each of them needing its own catch.
 */
export class DuplicateAccountNameError extends Error {
	readonly statusCode = 400;

	constructor(public readonly accountName: string) {
		super(`Account '${accountName}' already exists`);
		this.name = "DuplicateAccountNameError";
	}
}

/**
 * The trailing `VALUES (...)` clause of an INSERT.
 *
 * Anchored to the END of the statement — in every `INSERT INTO accounts`
 * statement in this codebase the value tuple is the last thing present, so the
 * greedy match to the final `)` captures exactly the tuple body.
 */
const TRAILING_VALUES_CLAUSE = /\bVALUES\s*\(([\s\S]*)\)\s*;?\s*$/i;

/**
 * Rewrite `INSERT INTO … VALUES (…)` into the guarded
 * `INSERT INTO … SELECT … WHERE NOT EXISTS (…)` form.
 *
 * Exported for direct testing: this rewrite is the whole correctness argument,
 * so it is verified independently of any database.
 *
 * @throws if the statement is not a supported single-tuple INSERT — better to
 *   fail loudly at the call site than to silently write an unguarded row.
 */
export function buildNameGuardedInsert(insertSql: string): string {
	const match = TRAILING_VALUES_CLAUSE.exec(insertSql);
	if (!match) {
		throw new Error(
			"buildNameGuardedInsert expects an INSERT ending in a single VALUES (...) tuple",
		);
	}
	const tuple = match[1];
	if (tuple.includes("(") || tuple.includes(")")) {
		// Multi-row inserts and sub-expressions are not supported: the guard would
		// apply to the wrong tuple boundary.
		throw new Error(
			"buildNameGuardedInsert does not support multi-row or nested VALUES tuples",
		);
	}
	return `${insertSql.slice(0, match.index)}SELECT ${tuple} WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE name = ?)`;
}

/**
 * Run an `INSERT INTO accounts … VALUES (…)` atomically, refusing a name that
 * already exists.
 *
 * @param name The account name being inserted (the collision key).
 * @throws {DuplicateAccountNameError} when the name is taken.
 */
export async function insertAccountUnique(
	adapter: AccountInsertAdapter,
	insertSql: string,
	params: unknown[],
	name: string,
): Promise<void> {
	const guarded = buildNameGuardedInsert(insertSql);
	const changes = await adapter.runWithChanges(guarded, [...params, name]);
	if (changes === 0) {
		throw new DuplicateAccountNameError(name);
	}
}
