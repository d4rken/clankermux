/**
 * The two SQL statements API key authentication now rests on.
 *
 * `findByHashedKey` replaced a scan that hashed every stored key with a single
 * indexed lookup — which means this one statement, and specifically its
 * `is_active = 1` predicate, is what stands between a disabled key and a
 * successful request. It had no test at all.
 *
 * `rotateSecret` is what migrates a row off the old salted-scrypt scheme the
 * first time its key is presented. It is a compare-and-swap rather than a blind
 * UPDATE, and the tests below pin every condition its WHERE clause encodes,
 * because a silent no-op there means a key that never stops paying the slow
 * verification path.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as api-key-rename.test.ts.
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { ApiKeyRepository } from "../api-key.repository";

const LEGACY_HASH = `00112233445566778899aabbccddeeff:${"ab".repeat(64)}`;
const NEW_HASH = `sha256$${"cd".repeat(32)}`;

let db: Database;
let repo: ApiKeyRepository;

function insertKey(
	id: string,
	hashedKey: string,
	{ active = true, suffix = "abcdefgh" } = {},
): void {
	db.run(
		`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, last_used, usage_count, is_active)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[id, id, hashedKey, suffix, 1000, null, 0, active ? 1 : 0],
	);
}

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	repo = new ApiKeyRepository(new BunSqlAdapter(db));
});

afterEach(() => {
	db.close();
});

describe("finding a key by its stored hash", () => {
	it("returns the row whose hash matches exactly", async () => {
		insertKey("wanted", NEW_HASH);
		insertKey("other", LEGACY_HASH);

		const found = await repo.findByHashedKey(NEW_HASH);

		expect(found?.id).toBe("wanted");
		expect(found?.hashedKey).toBe(NEW_HASH);
	});

	it("returns null when nothing matches", async () => {
		insertKey("other", LEGACY_HASH);

		expect(await repo.findByHashedKey(NEW_HASH)).toBeNull();
	});

	it("refuses to return a disabled key", async () => {
		// The security boundary of the whole fast path. A disabled key must not
		// authenticate, and this predicate is the only thing enforcing it —
		// verification never gets a second look at is_active.
		insertKey("disabled", NEW_HASH, { active: false });

		expect(await repo.findByHashedKey(NEW_HASH)).toBeNull();
	});

	it("does not match on a prefix of the stored hash", async () => {
		// A LIKE or a truncated comparison would turn the public part of a key
		// into a credential. Pinned so the statement can only ever be an equality.
		insertKey("wanted", NEW_HASH);

		expect(await repo.findByHashedKey(NEW_HASH.slice(0, 40))).toBeNull();
	});

	it("is case-sensitive", async () => {
		insertKey("wanted", NEW_HASH);

		expect(await repo.findByHashedKey(NEW_HASH.toUpperCase())).toBeNull();
	});
});

describe("migrating a stored hash", () => {
	it("swaps the hash when the row still holds the expected one", async () => {
		insertKey("k", LEGACY_HASH);

		const ok = await repo.rotateSecret("k", LEGACY_HASH, NEW_HASH, "abcdefgh");

		expect(ok).toBe(true);
		expect((await repo.findById("k"))?.hashedKey).toBe(NEW_HASH);
	});

	it("makes the row findable by its new hash and not its old one", async () => {
		insertKey("k", LEGACY_HASH);

		await repo.rotateSecret("k", LEGACY_HASH, NEW_HASH, "abcdefgh");

		expect((await repo.findByHashedKey(NEW_HASH))?.id).toBe("k");
		expect(await repo.findByHashedKey(LEGACY_HASH)).toBeNull();
	});

	it("refuses when the row's hash has already changed", async () => {
		// A regenerate that landed between the read and this write. Overwriting
		// would resurrect a secret the operator had just replaced.
		insertKey("k", LEGACY_HASH);
		const rotatedElsewhere = `sha256$${"ee".repeat(32)}`;
		await repo.rotateSecret("k", LEGACY_HASH, rotatedElsewhere, "zzzzzzzz");

		const ok = await repo.rotateSecret("k", LEGACY_HASH, NEW_HASH, "abcdefgh");

		expect(ok).toBe(false);
		expect((await repo.findById("k"))?.hashedKey).toBe(rotatedElsewhere);
	});

	it("refuses on a disabled row", async () => {
		insertKey("k", LEGACY_HASH, { active: false });

		const ok = await repo.rotateSecret("k", LEGACY_HASH, NEW_HASH, "abcdefgh");

		expect(ok).toBe(false);
	});

	it("refuses when the row does not exist", async () => {
		expect(
			await repo.rotateSecret("gone", LEGACY_HASH, NEW_HASH, "abcdefgh"),
		).toBe(false);
	});

	it("leaves every other column alone", async () => {
		// Migration must be invisible: same key, same identity, same statistics.
		// Only how the secret is stored changes.
		db.run(
			`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, last_used, usage_count, is_active, pinned_account_id)
			 VALUES ('k', 'the name', ?, 'abcdefgh', 1234, 5678, 42, 1, 'acct-1')`,
			[LEGACY_HASH],
		);

		await repo.rotateSecret("k", LEGACY_HASH, NEW_HASH, "abcdefgh");

		const after = await repo.findById("k");
		expect(after?.name).toBe("the name");
		expect(after?.createdAt).toBe(1234);
		expect(after?.lastUsed).toBe(5678);
		expect(after?.usageCount).toBe(42);
		expect(after?.isActive).toBe(true);
		expect(after?.pinnedAccountId).toBe("acct-1");
	});

	it("does not disturb other rows", async () => {
		insertKey("k", LEGACY_HASH);
		const otherHash = `sha256$${"11".repeat(32)}`;
		insertKey("untouched", otherHash);

		await repo.rotateSecret("k", LEGACY_HASH, NEW_HASH, "abcdefgh");

		expect((await repo.findById("untouched"))?.hashedKey).toBe(otherHash);
	});
});
