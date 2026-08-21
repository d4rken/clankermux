/**
 * API key verification: cost, correctness, and the migration off scrypt.
 *
 * Verification used to hash the presented key against EVERY active key in turn
 * with `scryptSync`, a password KDF measured at 34.8ms per call on the
 * deployment host. Nine active keys meant up to 313ms of uninterruptible CPU
 * for a single request, and the stall profiler attributed 100% of a run of
 * 250-950ms event-loop freezes to exactly that frame.
 *
 * A stored hash is now the unsalted SHA-256 of the key, so it can be computed
 * from what the caller presented and looked up directly. Rows written under the
 * old scheme still exist and still work; the first request that presents such a
 * key pays one scrypt check and rewrites the row, so the cost is paid once per
 * key ever rather than once per request.
 *
 * Two properties carry the weight here and are asserted repeatedly: the fast
 * path performs NO key hashing at all, and the slow path hashes exactly one
 * candidate. Everything else is about the ways verification must still say no.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { ApiKey, CryptoUtils } from "@clankermux/types";
import { apiKeyHashScheme, apiKeyLookupSuffix } from "@clankermux/types";
import { AuthService } from "../auth-service";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Let unawaited work settle. The stored-hash migration is deliberately NOT
 * awaited by the request path, so anything asserting its effect has to wait for
 * it here rather than immediately after the call.
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A stored value with the OLD shape (`hex-salt:hex-hash`), cheap to compute.
 * Real scrypt compatibility is pinned in the types package; paying 34.8ms per
 * call here would only make this suite slow. */
const legacyHashOf = (secret: string) =>
	`00112233445566778899aabbccddeeff:${sha256(`legacy:${secret}`).repeat(2)}`;

/**
 * Counts work so a test can assert what was NOT paid for. Deliberately uses the
 * real scheme classifier, so a broken classifier fails these tests too.
 *
 * `verifyCount` counts the EXPENSIVE operation (a scrypt check against a stored
 * legacy hash). `hashCount` counts the cheap SHA-256, which the fast path does
 * once per request by design — the two are tracked separately so a test can say
 * which one it means.
 */
class CountingCrypto implements CryptoUtils {
	verifyCalls: { apiKey: string; hashedKey: string }[] = [];
	hashCalls: string[] = [];

	async generateApiKey(): Promise<string> {
		return "btr-unused";
	}
	async hashApiKey(apiKey: string): Promise<string> {
		this.hashCalls.push(apiKey);
		return `sha256$${sha256(apiKey)}`;
	}
	async verifyApiKey(apiKey: string, hashedKey: string): Promise<boolean> {
		this.verifyCalls.push({ apiKey, hashedKey });
		switch (apiKeyHashScheme(hashedKey)) {
			case "scrypt-legacy":
				return hashedKey === legacyHashOf(apiKey);
			case "sha256":
				return hashedKey === `sha256$${sha256(apiKey)}`;
			default:
				return false;
		}
	}
	get verifyCount(): number {
		return this.verifyCalls.length;
	}
}

const newHashOf = (secret: string) => `sha256$${sha256(secret)}`;

/** A key stored under the OLD scheme — the state every row is in today. */
const legacyKey = (
	name: string,
	secret: string,
	over: Partial<ApiKey> = {},
): ApiKey => ({
	id: `id-${name}`,
	name,
	hashedKey: legacyHashOf(secret),
	prefixLast8: apiKeyLookupSuffix(secret),
	createdAt: 1,
	lastUsed: null,
	usageCount: 0,
	isActive: true,
	pinnedAccountId: null,
	pinnedProviders: null,
	...over,
});

/** A key already migrated to the new scheme. */
const migratedKey = (
	name: string,
	secret: string,
	over: Partial<ApiKey> = {},
): ApiKey => legacyKey(name, secret, { hashedKey: newHashOf(secret), ...over });

/** Minimal DatabaseOperations surface the auth path actually touches. */
class FakeDbOps {
	activeKeys: ApiKey[] = [];
	usageUpdates: { id: string; at: number }[] = [];
	getActiveCalls = 0;
	lookupCalls: string[] = [];
	rotateCalls: {
		id: string;
		expected: string;
		next: string;
		prefix: string;
	}[] = [];
	/** Force the compare-and-swap to refuse, as a concurrent regenerate would. */
	rotateSucceeds = true;
	/** Force the upgrade write to blow up, as a read-only database would. */
	rotateThrows = false;
	/**
	 * Hold the write open. The real adapter retries SQLITE_BUSY for up to TEN
	 * MINUTES, so "the write is slow" is the realistic contention case, not the
	 * immediate throw above.
	 */
	rotateGate: Promise<void> | null = null;

	async getActiveApiKeys(): Promise<ApiKey[]> {
		this.getActiveCalls++;
		return this.activeKeys.filter((k) => k.isActive);
	}
	async countActiveApiKeys(): Promise<number> {
		return this.activeKeys.filter((k) => k.isActive).length;
	}
	async updateApiKeyUsage(id: string, at: number): Promise<void> {
		this.usageUpdates.push({ id, at });
	}
	/** Mirrors the real query, including its `is_active = 1` predicate. */
	async getApiKeyByHashedKey(hashedKey: string): Promise<ApiKey | null> {
		this.lookupCalls.push(hashedKey);
		return (
			this.activeKeys.find((k) => k.hashedKey === hashedKey && k.isActive) ??
			null
		);
	}
	async rotateApiKeySecret(
		id: string,
		expected: string,
		next: string,
		prefix: string,
	): Promise<boolean> {
		this.rotateCalls.push({ id, expected, next, prefix });
		if (this.rotateGate) await this.rotateGate;
		if (this.rotateThrows) throw new Error("database is read-only");
		if (!this.rotateSucceeds) return false;
		const row = this.activeKeys.find(
			(k) => k.id === id && k.hashedKey === expected && k.isActive,
		);
		if (!row) return false;
		row.hashedKey = next;
		row.prefixLast8 = prefix;
		return true;
	}
}

const build = (db: FakeDbOps, crypto: CryptoUtils) =>
	// biome-ignore lint/suspicious/noExplicitAny: the fake covers only the auth path
	new AuthService(db as any, crypto);

const request = (key?: string) =>
	new Request("http://localhost/v1/messages", {
		headers: key ? { "x-api-key": key } : {},
	});

const auth = (svc: AuthService, key?: string) =>
	svc.authenticateRequest(request(key), "/v1/messages", "POST");

let db: FakeDbOps;
let crypto: CountingCrypto;
let svc: AuthService;

const REAL = "btr-realrealrealrealrealrealREAL1";

/** Nine keys, the real one LAST, which was the worst case of the old scan. */
const nineKeys = (real: ApiKey) => [
	...Array.from({ length: 8 }, (_, i) =>
		legacyKey(`other-${i}`, `btr-decoyDecoyDecoyDecoyDecoy${i}${i}xxxx`),
	),
	real,
];

beforeEach(() => {
	db = new FakeDbOps();
	crypto = new CountingCrypto();
	svc = build(db, crypto);
});

describe("API key verification cost", () => {
	it("runs no scrypt check for a key already stored under the new scheme", async () => {
		db.activeKeys = nineKeys(migratedKey("real", REAL));

		const r = await auth(svc, REAL);

		expect(r.isAuthenticated).toBe(true);
		expect(r.apiKeyName).toBe("real");
		expect(crypto.verifyCount).toBe(0);
		// One cheap SHA-256 to build the lookup key, and nothing else. Pinned
		// explicitly because "no verify calls" alone would also hold if the fast
		// path hashed the key several times over.
		expect(crypto.hashCalls).toEqual([REAL]);
	});

	it("finds a migrated key without reading the whole active set", async () => {
		// The claim being pinned is "one indexed SELECT". If this path ever went
		// back to loading every row, nothing else here would fail — it would just
		// quietly scale with the number of keys again.
		db.activeKeys = nineKeys(migratedKey("real", REAL));

		await auth(svc, REAL);

		expect(db.lookupCalls).toEqual([newHashOf(REAL)]);
		expect(db.getActiveCalls).toBe(0);
	});

	it("hashes exactly one candidate for a key still stored under scrypt", async () => {
		db.activeKeys = nineKeys(legacyKey("real", REAL));

		const r = await auth(svc, REAL);

		expect(r.isAuthenticated).toBe(true);
		expect(r.apiKeyName).toBe("real");
		// One, not nine. The old loop hashed every record ahead of the match.
		expect(crypto.verifyCount).toBe(1);
	});

	it("pays the scrypt check once per key, not once per request", async () => {
		db.activeKeys = nineKeys(legacyKey("real", REAL));

		await auth(svc, REAL);
		await flush(); // the migration write is not awaited by the request
		crypto.verifyCalls = [];

		const r = await auth(svc, REAL);
		expect(r.isAuthenticated).toBe(true);
		expect(crypto.verifyCount).toBe(0);
	});

	it("still scans the active set for a key that matches nothing", async () => {
		// Stated plainly because it bounds the claim made above: "one indexed
		// lookup and done" describes a key that EXISTS. Every miss still reads the
		// whole active set looking for unmigrated rows, and it always will —
		// nothing tracks whether migration is complete, so there is no point at
		// which this read is skipped. What migration removes is the HASHING, not
		// the scan. The scan is O(number of keys) of plain comparisons.
		db.activeKeys = nineKeys(migratedKey("real", REAL));

		await auth(svc, "btr-nothingHereMatchesThisSuffix!");

		expect(db.getActiveCalls).toBe(1);
		expect(crypto.verifyCount).toBe(0);
	});

	it("does not hash at all for a key no stored suffix matches", async () => {
		db.activeKeys = nineKeys(legacyKey("real", REAL));

		const r = await auth(svc, "btr-nothingHereMatchesThisSuffix!");

		expect(r.isAuthenticated).toBe(false);
		// An unauthenticated caller could otherwise spend nine scrypt calls of
		// event-loop time per request just by presenting a wrong key.
		expect(crypto.verifyCount).toBe(0);
	});

	it("does not re-hash a migrated row while looking for a legacy match", async () => {
		// A wrong key whose suffix matches a row that has ALREADY been migrated.
		// The direct lookup has necessarily failed for it, so hashing it again
		// could not change the answer — it would only bring back per-request cost.
		const real = "btr-aaaaaaaaaaaaaaaaaaaaSUFFIX12";
		const forged = "btr-bbbbbbbbbbbbbbbbbbbbSUFFIX12";
		expect(apiKeyLookupSuffix(real)).toBe(apiKeyLookupSuffix(forged));
		db.activeKeys = [migratedKey("real", real)];

		const r = await auth(svc, forged);

		expect(r.isAuthenticated).toBe(false);
		expect(crypto.verifyCount).toBe(0);
	});

	it("still rejects a wrong key that shares a suffix with a legacy row", async () => {
		db.activeKeys = [legacyKey("real", "btr-aaaaaaaaaaaaaaaaaaaaSUFFIX12")];

		const r = await auth(svc, "btr-bbbbbbbbbbbbbbbbbbbbSUFFIX12");

		expect(r.isAuthenticated).toBe(false);
		// The suffix narrows the candidates; it never decides the outcome.
		expect(crypto.verifyCount).toBe(1);
	});

	it("finds the right record when two legacy keys share a suffix", async () => {
		// A decoy with the same stored suffix sits FIRST, so the loop has to keep
		// going after it fails rather than concluding from the first candidate.
		const decoy = "btr-decoydecoydecoydecoySHARED12";
		const real = "btr-realrealrealrealrealSHARED12";
		expect(apiKeyLookupSuffix(decoy)).toBe(apiKeyLookupSuffix(real));
		db.activeKeys = [legacyKey("decoy", decoy), legacyKey("real", real)];

		const r = await auth(svc, real);

		expect(r.apiKeyName).toBe("real");
		expect(crypto.verifyCount).toBe(2); // decoy tried, then the real one
	});

	it("counts usage on both the migrated and the legacy path", async () => {
		db.activeKeys = [legacyKey("real", REAL)];

		await auth(svc, REAL); // legacy, then migrated
		await flush();
		await auth(svc, REAL); // migrated

		expect(db.usageUpdates.map((u) => u.id)).toEqual(["id-real", "id-real"]);
	});
});

describe("migrating a key off scrypt", () => {
	it("rewrites the row to the new scheme on first use", async () => {
		db.activeKeys = [legacyKey("real", REAL)];

		await auth(svc, REAL);
		await flush();

		expect(db.activeKeys[0].hashedKey).toBe(newHashOf(REAL));
		expect(apiKeyHashScheme(db.activeKeys[0].hashedKey)).toBe("sha256");
	});

	it("does not make the request wait for the rewrite", async () => {
		// The database adapter retries SQLITE_BUSY for up to TEN MINUTES. If the
		// request awaited this write, ordinary write contention could hold an
		// already-authenticated request open for that long. The request does not
		// depend on the outcome, so it must not wait for it.
		let releaseWrite = () => {};
		db.rotateGate = new Promise<void>((r) => {
			releaseWrite = r;
		});
		db.activeKeys = [legacyKey("real", REAL)];

		const r = await auth(svc, REAL); // must resolve with the write still open

		expect(r.isAuthenticated).toBe(true);
		expect(db.rotateCalls).toHaveLength(1);
		expect(db.activeKeys[0].hashedKey).toBe(legacyHashOf(REAL)); // not yet written

		releaseWrite();
		await flush();
		expect(db.activeKeys[0].hashedKey).toBe(newHashOf(REAL));
	});

	it("does not pile up writes for a key whose rewrite is stuck", async () => {
		// Not awaiting the write means nothing naturally throttles it. Without a
		// single-flight guard, a row parked in the adapter's ten-minute retry loop
		// would collect one more stuck write per request.
		let releaseWrite = () => {};
		db.rotateGate = new Promise<void>((r) => {
			releaseWrite = r;
		});
		db.activeKeys = [legacyKey("real", REAL)];

		for (let i = 0; i < 5; i++) await auth(svc, REAL);

		expect(db.rotateCalls).toHaveLength(1);

		releaseWrite();
		await flush();
	});

	it("changes nothing about the key except how it is stored", async () => {
		const before = legacyKey("real", REAL, { usageCount: 42, createdAt: 99 });
		db.activeKeys = [before];

		await auth(svc, REAL);
		await flush();

		const after = db.activeKeys[0];
		expect(after.id).toBe("id-real");
		expect(after.name).toBe("real");
		expect(after.prefixLast8).toBe(apiKeyLookupSuffix(REAL));
		expect(after.usageCount).toBe(42);
		expect(after.createdAt).toBe(99);
		expect(after.isActive).toBe(true);
	});

	it("swaps the hash only if the row still holds the one it verified", async () => {
		// Compare-and-swap, not a blind UPDATE: a regenerate that lands in the
		// window between the read and the write must not be overwritten with a
		// hash of the key it just replaced.
		db.activeKeys = [legacyKey("real", REAL)];

		await auth(svc, REAL);
		await flush();

		expect(db.rotateCalls).toEqual([
			{
				id: "id-real",
				expected: legacyHashOf(REAL),
				next: newHashOf(REAL),
				prefix: apiKeyLookupSuffix(REAL),
			},
		]);
	});

	it("authenticates the request even when the rewrite is refused", async () => {
		// What this pins is narrow: a REFUSED WRITE does not fail the request.
		//
		// It is not a claim that accepting is right in every race the refusal
		// could stand for. A regenerate, disable or delete that lands between the
		// read and the write also refuses, and this in-flight request is still
		// accepted. That window is inherent to read-then-act and the migrated fast
		// path has exactly the same one (the row is read, then accepted); it is
		// not something the legacy path introduces. Every LATER request is
		// rejected normally.
		db.activeKeys = [legacyKey("real", REAL)];
		db.rotateSucceeds = false;

		const r = await auth(svc, REAL);
		await flush();

		expect(r.isAuthenticated).toBe(true);
		expect(r.apiKeyName).toBe("real");
		// The refusal has to have actually happened, or this passes for a key
		// that was never migrated in the first place.
		expect(db.rotateCalls).toHaveLength(1);
		expect(db.activeKeys[0].hashedKey).toBe(legacyHashOf(REAL));
	});

	it("authenticates the request even when the rewrite throws", async () => {
		// A read-only or otherwise broken database must not take authentication
		// down with it. The cost of the failure is that the key stays on the slow
		// path, which is exactly where it already was.
		db.activeKeys = [legacyKey("real", REAL)];
		db.rotateThrows = true;

		const r = await auth(svc, REAL);
		await flush();

		expect(r.isAuthenticated).toBe(true);
		expect(db.rotateCalls).toHaveLength(1); // the throw really was reached
	});

	it("retries the migration on the next request after a failed rewrite", async () => {
		db.activeKeys = [legacyKey("real", REAL)];
		db.rotateSucceeds = false;
		await auth(svc, REAL);
		await flush();
		expect(db.rotateCalls).toHaveLength(1);

		db.rotateSucceeds = true;
		await auth(svc, REAL);
		await flush();

		// Two attempts, not one: without the first failing attempt this would
		// also pass, and it would be testing nothing.
		expect(db.rotateCalls).toHaveLength(2);
		expect(db.activeKeys[0].hashedKey).toBe(newHashOf(REAL));
	});

	it("does not write anything for a key that is already migrated", async () => {
		db.activeKeys = [migratedKey("real", REAL)];

		await auth(svc, REAL);
		await flush();

		expect(db.rotateCalls).toEqual([]);
	});

	it("does not write anything when verification fails", async () => {
		db.activeKeys = [legacyKey("real", "btr-aaaaaaaaaaaaaaaaaaaaSUFFIX12")];

		await auth(svc, "btr-bbbbbbbbbbbbbbbbbbbbSUFFIX12");
		await flush();

		expect(db.rotateCalls).toEqual([]);
	});

	it("never hashes against a row in neither storage scheme", async () => {
		// A corrupt or hand-edited value cannot authenticate anything, so spending
		// a ~35ms hash to discover that would be pure loss — and, before the
		// classifier became strict, the legacy parser would have accepted some of
		// those values outright.
		const key = "btr-consistentconsistentconsist1";
		db.activeKeys = [
			legacyKey("corrupt", key, { hashedKey: "not-a-hash-at-all" }),
			legacyKey("other", "btr-otherotherotherotherotherOTH"),
		];

		const r = await auth(svc, key);

		expect(r.isAuthenticated).toBe(false);
		expect(crypto.verifyCount).toBe(0);
	});
});

describe("API key verification must still say no", () => {
	it("rejects a key once it is deactivated", async () => {
		// A second key stays active throughout, because removing the LAST key
		// turns authentication off altogether (the first-run behaviour) and would
		// make this pass for the wrong reason.
		const other = migratedKey("other", "btr-otherotherotherotherotherOTH");
		db.activeKeys = [migratedKey("real", REAL), other];
		expect((await auth(svc, REAL)).isAuthenticated).toBe(true);

		db.activeKeys = [other]; // deactivated or deleted

		expect((await auth(svc, REAL)).isAuthenticated).toBe(false);
	});

	it("rejects a key once its secret is rotated", async () => {
		db.activeKeys = [migratedKey("real", REAL)];
		expect((await auth(svc, REAL)).isAuthenticated).toBe(true);

		db.activeKeys = [
			migratedKey("real", "btr-rotatedrotatedrotatedrotatedNW", {
				id: "id-real",
			}),
		];

		expect((await auth(svc, REAL)).isAuthenticated).toBe(false);
	});

	it("reports the current name after a rename", async () => {
		db.activeKeys = [migratedKey("old-name", REAL)];
		await auth(svc, REAL);

		db.activeKeys = [migratedKey("old-name", REAL, { name: "new-name" })];

		const r = await auth(svc, REAL);
		expect(r.isAuthenticated).toBe(true);
		expect(r.apiKeyName).toBe("new-name");
	});

	it("treats a case-changed key as a different key", async () => {
		const real = "btr-MixedCaseKeyMixedCaseKeyAbCd";
		db.activeKeys = [migratedKey("real", real)];
		expect((await auth(svc, real)).isAuthenticated).toBe(true);

		expect((await auth(svc, real.toLowerCase())).isAuthenticated).toBe(false);
	});

	it("does not let one key authenticate as another", async () => {
		db.activeKeys = [
			migratedKey("a", "btr-aaaaaaaaaaaaaaaaaaaaaaaaaaaAAA"),
			migratedKey("b", "btr-bbbbbbbbbbbbbbbbbbbbbbbbbbbBBB"),
		];
		await auth(svc, "btr-aaaaaaaaaaaaaaaaaaaaaaaaaaaAAA");

		const r = await auth(svc, "btr-bbbbbbbbbbbbbbbbbbbbbbbbbbbBBB");
		expect(r.apiKeyName).toBe("b");
	});

	it("lets a key start working after it is added", async () => {
		const key = "btr-notyetnotyetnotyetnotyetNOTY";
		const other = migratedKey("other", "btr-otherotherotherotherotherOTH");
		db.activeKeys = [other];
		expect((await auth(svc, key)).isAuthenticated).toBe(false);

		db.activeKeys = [other, migratedKey("real", key)];
		expect((await auth(svc, key)).isAuthenticated).toBe(true);
	});
});

describe("API key verification — policy is unchanged", () => {
	it("goes open when the last key is removed", async () => {
		// Worth pinning because it is surprising: with zero active keys the proxy
		// authenticates everything. A test that revokes the only key and then
		// asserts a rejection is testing this branch, not verification.
		db.activeKeys = [migratedKey("real", REAL)];
		await auth(svc, REAL);

		db.activeKeys = [];
		expect((await auth(svc, REAL)).isAuthenticated).toBe(true);
		expect((await auth(svc, "anything-at-all")).isAuthenticated).toBe(true);
	});

	it("lets management and health paths through without a key", async () => {
		db.activeKeys = [migratedKey("real", REAL)];

		for (const path of ["/health", "/api/accounts", "/dashboard"]) {
			const r = await svc.authenticateRequest(request(), path, "GET");
			expect(r.isAuthenticated).toBe(true);
		}
		expect(crypto.verifyCount).toBe(0);
		expect(db.lookupCalls).toEqual([]);
	});

	it("is open when no keys are configured at all", async () => {
		db.activeKeys = [];
		expect((await auth(svc)).isAuthenticated).toBe(true);
	});

	it("refuses a proxy request with no key when keys exist", async () => {
		db.activeKeys = [migratedKey("real", REAL)];
		const r = await auth(svc);
		expect(r.isAuthenticated).toBe(false);
		expect(r.error).toContain("API key required");
	});
});

describe("lookup suffix derivation", () => {
	it("matches what minting stores, so a key can always be found", () => {
		const key = "btr-abcdefghijklmnopqrstuvwxyz012345";
		expect(apiKeyLookupSuffix(key)).toBe("yz012345");
		expect(apiKeyLookupSuffix(key)).toBe(key.slice(-8));
	});

	it("does not crash on a key shorter than the suffix", () => {
		expect(apiKeyLookupSuffix("abc")).toBe("abc");
	});

	it("rejects a legacy key whose stored suffix disagrees with it — deliberately", async () => {
		// A DELIBERATE narrowing, recorded here so it is a decision rather than an
		// accident. The old scan hashed every record, so a row with a wrong stored
		// suffix still authenticated; the legacy fallback never hashes it.
		//
		// Judged safe because such a row cannot arise from the app: the column has
		// been NOT NULL since the table was created, minting and rotation are its
		// only writers and both derive it with apiKeyLookupSuffix. It could only
		// come from a hand-edited or imported row, and the failure would be an
		// immediate, loud 401 rather than anything silent.
		//
		// It also stops mattering per key: once a row is migrated it is found by
		// hash, and the stored suffix is not consulted at all.
		const key = "btr-consistentconsistentconsist1";
		db.activeKeys = [
			legacyKey("tampered", key, { prefixLast8: "badvalue" }),
			legacyKey("other", "btr-otherotherotherotherotherOTH"),
		];

		const r = await auth(svc, key);
		expect(r.isAuthenticated).toBe(false);
		expect(crypto.verifyCount).toBe(0);
	});

	it("finds a migrated key even if its stored suffix is wrong", async () => {
		// The flip side of the narrowing above, and the reason it is acceptable:
		// migration removes the suffix from the decision entirely.
		const key = "btr-consistentconsistentconsist1";
		db.activeKeys = [migratedKey("tampered", key, { prefixLast8: "badvalue" })];

		expect((await auth(svc, key)).isAuthenticated).toBe(true);
	});
});
