/**
 * API key verification: cost and correctness.
 *
 * Verification used to hash the presented key against EVERY active key in turn,
 * with `scryptSync` — a deliberately expensive password KDF, measured at 34.8ms
 * per call on the deployment host. Nine active keys meant up to 313ms of
 * uninterruptible CPU on the event loop for a single request, and the stall
 * profiler attributed 100% of a run of 250-950ms event-loop freezes to exactly
 * that frame.
 *
 * These tests pin both halves of the fix: a verified key is hashed once and
 * then remembered, and a cold verification only hashes the record whose stored
 * lookup suffix matches the presented key.
 *
 * The cache authenticates without re-hashing, so most of what follows is about
 * the ways it must STOP doing that: revoked, rotated and renamed keys.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { ApiKey, CryptoUtils } from "@clankermux/types";
import { apiKeyLookupSuffix } from "@clankermux/types";
import { AuthService } from "../auth-service";

/** Counts hashing so a test can assert what was NOT paid for. */
class CountingCrypto implements CryptoUtils {
	verifyCalls: { apiKey: string; hashedKey: string }[] = [];

	async generateApiKey(): Promise<string> {
		return "btr-unused";
	}
	async hashApiKey(apiKey: string): Promise<string> {
		return `hash-of:${apiKey}`;
	}
	async verifyApiKey(apiKey: string, hashedKey: string): Promise<boolean> {
		this.verifyCalls.push({ apiKey, hashedKey });
		return hashedKey === `hash-of:${apiKey}`;
	}
	get verifyCount(): number {
		return this.verifyCalls.length;
	}
}

const makeKey = (
	name: string,
	secret: string,
	over: Partial<ApiKey> = {},
): ApiKey => ({
	id: `id-${name}`,
	name,
	hashedKey: `hash-of:${secret}`,
	prefixLast8: apiKeyLookupSuffix(secret),
	createdAt: 1,
	lastUsed: null,
	usageCount: 0,
	isActive: true,
	pinnedAccountId: null,
	pinnedProviders: null,
	...over,
});

/** Minimal DatabaseOperations surface the auth path actually touches. */
class FakeDbOps {
	activeKeys: ApiKey[] = [];
	usageUpdates: { id: string; at: number }[] = [];
	getActiveCalls = 0;

	async getActiveApiKeys(): Promise<ApiKey[]> {
		this.getActiveCalls++;
		return this.activeKeys;
	}
	async countActiveApiKeys(): Promise<number> {
		return this.activeKeys.length;
	}
	async updateApiKeyUsage(id: string, at: number): Promise<void> {
		this.usageUpdates.push({ id, at });
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

/** Nine keys, the real one LAST, which is the worst case of the old scan. */
const NINE_KEYS_REAL_LAST = () => [
	...Array.from({ length: 8 }, (_, i) =>
		makeKey(`other-${i}`, `btr-decoyDecoyDecoyDecoyDecoy${i}${i}xxxx`),
	),
	makeKey("real", "btr-realrealrealrealrealrealREAL1"),
];

beforeEach(() => {
	db = new FakeDbOps();
	crypto = new CountingCrypto();
	svc = build(db, crypto);
});

describe("API key verification cost", () => {
	it("hashes only the key whose stored suffix matches", async () => {
		db.activeKeys = NINE_KEYS_REAL_LAST();

		const r = await auth(svc, "btr-realrealrealrealrealrealREAL1");

		expect(r.isAuthenticated).toBe(true);
		expect(r.apiKeyName).toBe("real");
		// One, not nine. This is the whole point: the old loop hashed every
		// record ahead of the match, at ~35ms each.
		expect(crypto.verifyCount).toBe(1);
	});

	it("does not hash at all on a repeat request with the same key", async () => {
		db.activeKeys = NINE_KEYS_REAL_LAST();
		const key = "btr-realrealrealrealrealrealREAL1";

		await auth(svc, key);
		crypto.verifyCalls = [];

		const r = await auth(svc, key);
		expect(r.isAuthenticated).toBe(true);
		expect(r.apiKeyName).toBe("real");
		expect(crypto.verifyCount).toBe(0);
	});

	it("does not hash at all for a key no stored suffix matches", async () => {
		db.activeKeys = NINE_KEYS_REAL_LAST();

		const r = await auth(svc, "btr-nothingHereMatchesThisSuffix!");

		expect(r.isAuthenticated).toBe(false);
		// An unauthenticated caller could otherwise spend 9 hashes of event-loop
		// time per request just by presenting a wrong key.
		expect(crypto.verifyCount).toBe(0);
	});

	it("still rejects a wrong key that happens to share a suffix", async () => {
		// Identical last 8 characters, different secrets.
		db.activeKeys = [makeKey("real", "btr-aaaaaaaaaaaaaaaaaaaaSUFFIX12")];

		const r = await auth(svc, "btr-bbbbbbbbbbbbbbbbbbbbSUFFIX12");

		expect(r.isAuthenticated).toBe(false);
		// The suffix narrows the candidates; it never decides the outcome.
		expect(crypto.verifyCount).toBe(1);
	});

	it("keeps counting usage on both the cold and the remembered path", async () => {
		db.activeKeys = NINE_KEYS_REAL_LAST();
		const key = "btr-realrealrealrealrealrealREAL1";

		await auth(svc, key);
		await auth(svc, key);

		expect(db.usageUpdates.map((u) => u.id)).toEqual(["id-real", "id-real"]);
	});
});

describe("API key verification — the cache must stop trusting a key", () => {
	const KEY = "btr-realrealrealrealrealrealREAL1";

	it("rejects a remembered key once it is deactivated", async () => {
		// A second key stays active throughout, because removing the LAST key
		// turns authentication off altogether (the first-run behaviour) and would
		// make this pass for the wrong reason.
		const other = makeKey("other", "btr-otherotherotherotherotherOTH");
		db.activeKeys = [makeKey("real", KEY), other];
		expect((await auth(svc, KEY)).isAuthenticated).toBe(true);

		db.activeKeys = [other]; // deactivated or deleted

		const r = await auth(svc, KEY);
		expect(r.isAuthenticated).toBe(false);
	});

	it("rejects a remembered key once its secret is rotated", async () => {
		db.activeKeys = [makeKey("real", KEY)];
		expect((await auth(svc, KEY)).isAuthenticated).toBe(true);

		// rotateSecret writes a new hash and suffix for the same id.
		db.activeKeys = [
			makeKey("real", "btr-rotatedrotatedrotatedrotatedNW", { id: "id-real" }),
		];

		const r = await auth(svc, KEY);
		expect(r.isAuthenticated).toBe(false);
	});

	it("reports the current name after a rename, not the remembered one", async () => {
		db.activeKeys = [makeKey("old-name", KEY)];
		await auth(svc, KEY);

		db.activeKeys = [makeKey("old-name", KEY, { name: "new-name" })];

		const r = await auth(svc, KEY);
		expect(r.isAuthenticated).toBe(true);
		expect(r.apiKeyName).toBe("new-name");
		expect(crypto.verifyCount).toBe(1); // still remembered, still not re-hashed
	});

	it("re-verifies from scratch after a key is deactivated and restored", async () => {
		const other = makeKey("other", "btr-otherotherotherotherotherOTH");
		db.activeKeys = [makeKey("real", KEY), other];
		await auth(svc, KEY);

		db.activeKeys = [other];
		await auth(svc, KEY); // rejected, and the stale entry is dropped here
		crypto.verifyCalls = [];

		db.activeKeys = [makeKey("real", KEY), other];
		const r = await auth(svc, KEY);

		expect(r.isAuthenticated).toBe(true);
		expect(crypto.verifyCount).toBe(1);
	});

	it("does not let a verified key vouch for a different key sharing its suffix", async () => {
		// The bypass this guards against: the stored suffix is PUBLIC (the
		// key-listing endpoint returns it), so if a verified key were remembered
		// under anything derived from the suffix rather than the whole secret,
		// anyone could authenticate by ending their key with the right 8
		// characters once the real holder had made one request.
		const real = "btr-aaaaaaaaaaaaaaaaaaaaSUFFIX12";
		const forged = "btr-bbbbbbbbbbbbbbbbbbbbSUFFIX12";
		expect(apiKeyLookupSuffix(real)).toBe(apiKeyLookupSuffix(forged));

		db.activeKeys = [makeKey("real", real)];
		expect((await auth(svc, real)).isAuthenticated).toBe(true);

		const r = await auth(svc, forged);
		expect(r.isAuthenticated).toBe(false);
	});

	it("does not let one key's cache entry authenticate another key", async () => {
		db.activeKeys = [
			makeKey("a", "btr-aaaaaaaaaaaaaaaaaaaaaaaaaaaAAA"),
			makeKey("b", "btr-bbbbbbbbbbbbbbbbbbbbbbbbbbbBBB"),
		];
		await auth(svc, "btr-aaaaaaaaaaaaaaaaaaaaaaaaaaaAAA");

		const r = await auth(svc, "btr-bbbbbbbbbbbbbbbbbbbbbbbbbbbBBB");
		expect(r.apiKeyName).toBe("b");
	});

	it("treats a case-changed key as a different key", async () => {
		// Indexing the cache by anything normalised — lowercased, trimmed — would
		// let a near-miss inherit a real verification. Keys are case-sensitive.
		const real = "btr-MixedCaseKeyMixedCaseKeyAbCd";
		db.activeKeys = [makeKey("real", real)];
		expect((await auth(svc, real)).isAuthenticated).toBe(true);

		const r = await auth(svc, real.toLowerCase());
		expect(r.isAuthenticated).toBe(false);
	});

	it("finds the right record when two active keys share a suffix", async () => {
		// A decoy with the same stored suffix sits FIRST, so the loop has to keep
		// going after it fails rather than concluding from the first candidate.
		const decoy = "btr-decoydecoydecoydecoySHARED12";
		const real = "btr-realrealrealrealrealSHARED12";
		expect(apiKeyLookupSuffix(decoy)).toBe(apiKeyLookupSuffix(real));
		db.activeKeys = [makeKey("decoy", decoy), makeKey("real", real)];

		const first = await auth(svc, real);
		expect(first.apiKeyName).toBe("real");
		expect(crypto.verifyCount).toBe(2); // decoy tried, then the real one

		const second = await auth(svc, real);
		expect(second.apiKeyName).toBe("real");
		expect(crypto.verifyCount).toBe(2); // remembered, nothing re-hashed
	});

	it("does not remember a rejection, so a key can start working later", async () => {
		const key = "btr-notyetnotyetnotyetnotyetNOTY";
		const other = makeKey("other", "btr-otherotherotherotherotherOTH");
		db.activeKeys = [other];
		expect((await auth(svc, key)).isAuthenticated).toBe(false);

		db.activeKeys = [other, makeKey("real", key)];
		const r = await auth(svc, key);
		expect(r.isAuthenticated).toBe(true);
	});

	it("bounds what it remembers", async () => {
		// Every entry is a successful verification, so only a holder of valid
		// keys can grow this at all — but it is still bounded.
		const keys = Array.from(
			{ length: 600 },
			(_, i) => `btr-${String(i).padStart(28, "0")}key`,
		);
		db.activeKeys = keys.map((k, i) => makeKey(`k${i}`, k));

		for (const k of keys) await auth(svc, k);
		crypto.verifyCalls = [];

		// The oldest entries are gone, so the first key costs a hash again while
		// the most recent one does not.
		await auth(svc, keys[0]);
		expect(crypto.verifyCount).toBe(1);
		await auth(svc, keys[keys.length - 1]);
		expect(crypto.verifyCount).toBe(1);
	});
});

describe("API key verification — policy is unchanged", () => {
	it("goes open when the last key is removed, cache or no cache", async () => {
		// Worth pinning because it is surprising: with zero active keys the proxy
		// authenticates everything, so a remembered entry is never consulted and
		// never needs to be. A test that revokes the only key and then asserts a
		// rejection is testing this branch, not the cache.
		const KEY = "btr-realrealrealrealrealrealREAL1";
		db.activeKeys = [makeKey("real", KEY)];
		await auth(svc, KEY);

		db.activeKeys = [];
		expect((await auth(svc, KEY)).isAuthenticated).toBe(true);
		expect((await auth(svc, "anything-at-all")).isAuthenticated).toBe(true);
	});

	it("lets management and health paths through without a key", async () => {
		db.activeKeys = [makeKey("real", "btr-realrealrealrealrealrealREAL1")];

		for (const path of ["/health", "/api/accounts", "/dashboard"]) {
			const r = await svc.authenticateRequest(request(), path, "GET");
			expect(r.isAuthenticated).toBe(true);
		}
		expect(crypto.verifyCount).toBe(0);
	});

	it("is open when no keys are configured at all", async () => {
		db.activeKeys = [];
		expect((await auth(svc)).isAuthenticated).toBe(true);
	});

	it("refuses a proxy request with no key when keys exist", async () => {
		db.activeKeys = [makeKey("real", "btr-realrealrealrealrealrealREAL1")];
		const r = await auth(svc);
		expect(r.isAuthenticated).toBe(false);
		expect(r.error).toContain("API key required");
	});
});

describe("lookup suffix derivation", () => {
	it("matches what minting stores, so a key can always be found", () => {
		// Minting does `apiKey.slice(-8)` through this same function. If the two
		// ever diverged, every key minted afterwards would be unrecognisable.
		const key = "btr-abcdefghijklmnopqrstuvwxyz012345";
		expect(apiKeyLookupSuffix(key)).toBe("yz012345");
		expect(apiKeyLookupSuffix(key)).toBe(key.slice(-8));
	});

	it("does not crash on a key shorter than the suffix", () => {
		expect(apiKeyLookupSuffix("abc")).toBe("abc");
	});

	it("rejects a key whose stored suffix disagrees with it — deliberately", async () => {
		// A DELIBERATE narrowing of behaviour, recorded here so it is a decision
		// rather than an accident. The old scan hashed every record, so a row with
		// a wrong stored suffix still authenticated; this one never hashes it.
		//
		// Judged safe because such a row cannot arise from the app: the column has
		// been NOT NULL since the table was created, minting and rotation are its
		// only writers and both derive it with apiKeyLookupSuffix, and all nine
		// keys on the deployment carry a correctly-shaped value. It could only
		// come from a hand-edited or imported row, and the failure would be an
		// immediate, loud 401 rather than anything silent.
		//
		// The alternative — falling back to hashing everything — would keep such a
		// row working, at the price of letting any wrong key burn ~373ms of event
		// loop with no credential at all.
		db = new FakeDbOps();
		crypto = new CountingCrypto();
		svc = build(db, crypto);

		const key = "btr-consistentconsistentconsist1";
		db.activeKeys = [
			makeKey("tampered", key, { prefixLast8: "badvalue" }),
			makeKey("other", "btr-otherotherotherotherotherOTH"),
		];

		const r = await auth(svc, key);
		expect(r.isAuthenticated).toBe(false);
		expect(crypto.verifyCount).toBe(0);
	});
});
