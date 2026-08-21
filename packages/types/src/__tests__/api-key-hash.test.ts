/**
 * How an API key is hashed for storage, and why the scheme changed.
 *
 * Keys used to be stored as `scrypt(key, random-salt)`. scrypt is a PASSWORD
 * KDF: deliberately slow and memory-hard so that a human-chosen secret cannot
 * be brute-forced. An API key is not a human-chosen secret — it is 32
 * characters drawn from `randomBytes(32)`, so there is nothing to brute-force
 * and nothing for the cost to buy. What the cost did buy was a 34.8ms stall
 * per verification on the deployment host.
 *
 * Worse, the random per-key salt meant a stored hash could not be computed from
 * a presented key, so finding the matching record meant hashing against every
 * record in turn. That is what froze the event loop for ~373ms per request.
 *
 * The scheme is now an unsalted SHA-256, which makes the stored value a direct
 * lookup key. That is only sound BECAUSE the input is high-entropy: these tests
 * pin the entropy assumption alongside the format, because the day someone lets
 * a user choose their own key string, this file is the one that should fail.
 */

import { describe, expect, it } from "bun:test";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { apiKeyHashScheme, NodeCryptoUtils } from "../api-key";

const crypto = new NodeCryptoUtils();

/**
 * The old scheme, written out independently so compatibility is pinned to the
 * format as it exists in the database, not to our own current code.
 */
function legacyScryptHash(apiKey: string): string {
	const salt = randomBytes(16).toString("hex");
	return `${salt}:${scryptSync(apiKey, salt, 64).toString("hex")}`;
}

describe("stored hash format", () => {
	it("is a self-describing sha256 value", async () => {
		const hash = await crypto.hashApiKey("btr-abcdefghijklmnopqrstuvwxyz0123");

		expect(hash).toMatch(/^sha256\$[0-9a-f]{64}$/);
	});

	it("is deterministic, which is what makes it a lookup key", async () => {
		// The whole fix rests on this: the same key must always produce the same
		// stored value, so a presented key can be turned straight into a SELECT.
		const key = "btr-abcdefghijklmnopqrstuvwxyz0123";

		expect(await crypto.hashApiKey(key)).toBe(await crypto.hashApiKey(key));
	});

	it("gives different keys different hashes", async () => {
		const a = await crypto.hashApiKey("btr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		const b = await crypto.hashApiKey("btr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaab");

		expect(a).not.toBe(b);
	});

	it("is the plain SHA-256 of the key, with no server-held secret mixed in", async () => {
		// Pinned because the stored value must be reproducible from the key ALONE.
		// A keyed digest (HMAC with a per-installation pepper) would still be
		// deterministic and still indexable, so it would not break the lookup —
		// what it would break is recovery: the pepper becomes a second secret that
		// has to survive backup, restore and host moves, and losing it invalidates
		// every key in the database. There is no key-management story here to hang
		// that on.
		const key = "btr-abcdefghijklmnopqrstuvwxyz0123";
		const expected = createHash("sha256").update(key).digest("hex");

		expect(await crypto.hashApiKey(key)).toBe(`sha256$${expected}`);
	});

	it("mints keys in the shape the unsalted-hash argument depends on", async () => {
		// Dropping the salt is only defensible because the input is long and
		// random. This pins the SHAPE — length and alphabet — which is what a
		// careless edit to generateApiKey would change. It deliberately does NOT
		// claim to measure entropy: 50 distinct outputs would not catch a weak
		// generator, only an obviously broken one.
		const key = await crypto.generateApiKey();

		expect(key).toMatch(/^btr-[A-Za-z0-9]{32}$/);
		const distinct = new Set(
			await Promise.all(
				Array.from({ length: 50 }, () => crypto.generateApiKey()),
			),
		);
		expect(distinct.size).toBe(50);
	});
});

describe("classifying a stored hash", () => {
	it("recognises the old salted scrypt values", () => {
		expect(apiKeyHashScheme(legacyScryptHash("btr-whatever"))).toBe(
			"scrypt-legacy",
		);
	});

	it("recognises the new values", async () => {
		const hash = await crypto.hashApiKey("btr-abcdefghijklmnopqrstuvwxyz0123");

		expect(apiKeyHashScheme(hash)).toBe("sha256");
	});

	it("calls anything else unrecognised rather than guessing", () => {
		// This is the fail-closed half. An earlier version of this classifier
		// answered "legacy" for everything that was not a new-format value, which
		// sounded conservative and was not: the legacy parser splits on `:` and
		// ignores trailing fields, so a malformed row was both MORE permissive
		// than intended and cost a ~35ms hash to reject.
		for (const junk of [
			"",
			"garbage",
			"sha256$",
			"sha256$xyz",
			":",
			"a:b",
			// Neither shape, but the old classifier called it legacy and the old
			// parser would have happily verified against the middle field.
			`sha256$not-a-digest:${"ab".repeat(64)}:trailing`,
			// Right shape, wrong lengths.
			`${"a".repeat(31)}:${"b".repeat(128)}`,
			`${"a".repeat(32)}:${"b".repeat(127)}`,
			// Hex is written lowercase by toString("hex"); uppercase was never
			// stored, so accepting it would only widen what counts as a verifier.
			`${"A".repeat(32)}:${"B".repeat(128)}`,
		]) {
			expect(apiKeyHashScheme(junk)).toBe("unrecognised");
		}
	});
});

describe("verifying against a stored hash", () => {
	it("accepts the right key against a new-format hash", async () => {
		const key = "btr-abcdefghijklmnopqrstuvwxyz0123";
		const hash = await crypto.hashApiKey(key);

		expect(await crypto.verifyApiKey(key, hash)).toBe(true);
	});

	it("rejects the wrong key against a new-format hash", async () => {
		const hash = await crypto.hashApiKey("btr-abcdefghijklmnopqrstuvwxyz0123");

		expect(await crypto.verifyApiKey("btr-nope", hash)).toBe(false);
	});

	it("still accepts a key stored under the old scrypt scheme", async () => {
		// The migration is opportunistic — rows are rewritten only when their key
		// is next presented — so this path stays load-bearing indefinitely for any
		// key that is never used again.
		const key = "btr-legacylegacylegacylegacyLEG1";
		const stored = legacyScryptHash(key);

		expect(await crypto.verifyApiKey(key, stored)).toBe(true);
	});

	it("still rejects the wrong key under the old scheme", async () => {
		const stored = legacyScryptHash("btr-legacylegacylegacylegacyLEG1");

		expect(
			await crypto.verifyApiKey("btr-legacylegacylegacylegacyLEG2", stored),
		).toBe(false);
	});

	it("does not let a new-format hash be verified as if it were legacy", async () => {
		const key = "btr-abcdefghijklmnopqrstuvwxyz0123";
		const newHash = await crypto.hashApiKey(key);
		// Same digest, mangled into something whose shape the legacy parser would
		// accept. It must not verify.
		const mangled = newHash.replace(
			"sha256$",
			"00112233445566778899aabbccddeeff:",
		);

		expect(await crypto.verifyApiKey(key, mangled)).toBe(false);
	});

	it("refuses a stored value that carries extra colon-separated fields", async () => {
		// The concrete hole the strict classifier closes. The legacy parser takes
		// split(":")[0] and [1] and ignores the rest, so a row of the form
		// `<anything>:<real scrypt output>:<trailer>` used to verify.
		const key = "btr-legacylegacylegacylegacyLEG1";
		const salt = randomBytes(16).toString("hex");
		const real = scryptSync(key, salt, 64).toString("hex");

		expect(await crypto.verifyApiKey(key, `${salt}:${real}:trailer`)).toBe(
			false,
		);
		expect(await crypto.verifyApiKey(key, `sha256$junk:${real}`)).toBe(false);
	});

	it("returns false rather than throwing on a malformed stored value", async () => {
		for (const junk of ["", "garbage", "sha256$", ":", "a:b"]) {
			expect(await crypto.verifyApiKey("btr-anything", junk)).toBe(false);
		}
	});

	it("checks a legacy key without blocking the event loop", async () => {
		// scryptSync costs ~35ms of CPU and freezes the loop for all of it, which
		// is the stall this whole change exists to remove. The stored lookup
		// suffix is public, so an attacker can force this path with a wrong key as
		// often as they like; it must cost threadpool time, not serving time.
		const stored = legacyScryptHash("btr-legacylegacylegacylegacyLEG1");

		let ticks = 0;
		let worstLagMs = 0;
		let last = performance.now();
		const ticker = setInterval(() => {
			ticks++;
			const now = performance.now();
			worstLagMs = Math.max(worstLagMs, now - last - 5);
			last = now;
		}, 5);

		try {
			// Let the timer actually start ticking BEFORE the work. Without this
			// the loop never runs the callback at all: a synchronous hash would
			// block from the first line to the last, the ticker would record
			// nothing, and zero samples would read as zero lag. That is exactly
			// how this test passed against scryptSync when it was first written.
			await new Promise((r) => setTimeout(r, 40));

			// Wrong key, so this runs the hash and then fails: the attacker's case.
			await crypto.verifyApiKey("btr-legacylegacylegacylegacyLEG2", stored);

			// And let it observe the aftermath, since a block is only visible on
			// the first tick that manages to run once the loop is free again.
			await new Promise((r) => setTimeout(r, 40));
		} finally {
			clearInterval(ticker);
		}

		// Silence is not success: assert the instrument was alive before trusting
		// what it did not see.
		expect(ticks).toBeGreaterThan(5);
		// A synchronous scrypt parks the loop for tens of milliseconds. Generous
		// bound so this cannot flake on a loaded machine while still failing
		// loudly if the implementation goes back to scryptSync.
		expect(worstLagMs).toBeLessThan(20);
	});
});
