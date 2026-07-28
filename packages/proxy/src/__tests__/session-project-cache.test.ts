import { describe, expect, it } from "bun:test";
import {
	MAX_ENTRIES,
	SessionProjectCache,
	TTL_MS,
} from "../session-project-cache";

/** Mutable fake clock so tests control time deterministically. */
function makeClock(start = 1_000_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("SessionProjectCache", () => {
	it("roundtrips set/lookup", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);
		expect(cache.set("key:abc", "clankermux")).toBeNull();
		expect(cache.lookup("key:abc")).toEqual({
			project: "clankermux",
			ambiguous: false,
		});
	});

	it("returns a clean miss for a missing key", () => {
		const cache = new SessionProjectCache();
		expect(cache.lookup("nope")).toEqual({ project: null, ambiguous: false });
	});

	it("expires entries after TTL_MS", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);
		cache.set("key:abc", "clankermux");

		clock.advance(TTL_MS - 1);
		expect(cache.lookup("key:abc").project).toBe("clankermux");

		clock.advance(1); // exactly at expiresAt → expired
		expect(cache.lookup("key:abc")).toEqual({
			project: null,
			ambiguous: false,
		});
		// Expired entry is removed entirely.
		expect(cache.size()).toBe(0);
	});

	it("lookup() refreshes recency but does NOT extend the TTL", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);
		cache.set("key:abc", "clankermux");

		// Touch the entry frequently; TTL still counts from the original set.
		for (let i = 0; i < 10; i++) {
			clock.advance(TTL_MS / 10);
			cache.lookup("key:abc");
		}
		// Total elapsed: TTL_MS — the entry must be expired despite the lookups.
		expect(cache.lookup("key:abc").project).toBeNull();
	});

	it("set() re-anchors the TTL", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);
		cache.set("key:abc", "clankermux");

		clock.advance(TTL_MS - 1);
		cache.set("key:abc", "clankermux");

		clock.advance(TTL_MS - 1);
		expect(cache.lookup("key:abc").project).toBe("clankermux");
	});

	it("evicts the oldest entry when MAX_ENTRIES is exceeded", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);

		for (let i = 0; i < MAX_ENTRIES; i++) {
			cache.set(`key:${i}`, `proj-${i}`);
		}
		expect(cache.size()).toBe(MAX_ENTRIES);

		// One more set evicts the oldest (key:0).
		cache.set("key:overflow", "proj-overflow");
		expect(cache.size()).toBe(MAX_ENTRIES);
		expect(cache.lookup("key:0").project).toBeNull();
		expect(cache.lookup("key:overflow").project).toBe("proj-overflow");
		expect(cache.lookup("key:1").project).toBe("proj-1");
	});

	it("a recently-looked-up entry survives eviction", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);

		for (let i = 0; i < MAX_ENTRIES; i++) {
			cache.set(`key:${i}`, `proj-${i}`);
		}
		// Touch the oldest entry — it moves to most-recent position.
		expect(cache.lookup("key:0").project).toBe("proj-0");

		// Overflow now evicts key:1 (the new oldest), not key:0.
		cache.set("key:overflow", "proj-overflow");
		expect(cache.lookup("key:0").project).toBe("proj-0");
		expect(cache.lookup("key:1").project).toBeNull();
	});

	it("set() returns the previous project for the key", () => {
		const cache = new SessionProjectCache();
		expect(cache.set("key:abc", "proj-a")).toBeNull();
		expect(cache.set("key:abc", "proj-b")).toBe("proj-a");
		expect(cache.set("key:abc", "proj-b")).toBe("proj-b");
	});

	it("set() returns null when the previous entry had already expired", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);
		cache.set("key:abc", "proj-a");

		clock.advance(TTL_MS);
		// Not a real transition: the old entry is gone, so there is no previous.
		expect(cache.set("key:abc", "proj-b")).toBeNull();
	});

	it("clear() empties the cache and size() tracks entries", () => {
		const cache = new SessionProjectCache();
		expect(cache.size()).toBe(0);
		cache.set("a", "p1");
		cache.set("b", "p2");
		expect(cache.size()).toBe(2);
		cache.clear();
		expect(cache.size()).toBe(0);
		expect(cache.lookup("a").project).toBeNull();
	});

	describe("ambiguity", () => {
		it("a conflicting seed marks the session ambiguous and withholds the project", () => {
			const clock = makeClock();
			const cache = new SessionProjectCache(clock.now);
			cache.set("key:abc", "proj-a");
			cache.set("key:abc", "proj-b");

			expect(cache.lookup("key:abc")).toEqual({
				project: null,
				ambiguous: true,
			});
		});

		it("ambiguity decays TTL_MS after the conflict", () => {
			const clock = makeClock();
			const cache = new SessionProjectCache(clock.now);
			cache.set("key:abc", "proj-a");
			cache.set("key:abc", "proj-b");

			clock.advance(TTL_MS - 1);
			expect(cache.lookup("key:abc")).toEqual({
				project: null,
				ambiguous: true,
			});
		});

		it("a same-project re-seed does NOT extend the ambiguity window", () => {
			const clock = makeClock();
			const cache = new SessionProjectCache(clock.now);
			cache.set("key:abc", "proj-a");
			cache.set("key:abc", "proj-b"); // conflict at t0 → ambiguous until t0+TTL

			// Keep the session alive with same-project seeds. Each re-anchors the
			// entry TTL but must NOT push the ambiguity deadline out.
			for (let i = 0; i < 4; i++) {
				clock.advance(TTL_MS / 4);
				cache.set("key:abc", "proj-b");
			}

			// TTL_MS has elapsed since the conflict → ambiguity cleared, and the
			// entry itself is still live thanks to the re-seeds.
			expect(cache.lookup("key:abc")).toEqual({
				project: "proj-b",
				ambiguous: false,
			});
		});

		it("a conflict re-stamps the ambiguity window", () => {
			const clock = makeClock();
			const cache = new SessionProjectCache(clock.now);
			cache.set("key:abc", "proj-a");
			cache.set("key:abc", "proj-b"); // conflict 1

			clock.advance(TTL_MS / 2);
			cache.set("key:abc", "proj-a"); // conflict 2 → new window

			clock.advance(TTL_MS / 2 + 1); // past conflict 1's window only
			expect(cache.lookup("key:abc")).toEqual({
				project: null,
				ambiguous: true,
			});
		});

		it("'seed A → expire → seed B' is not a conflict", () => {
			const clock = makeClock();
			const cache = new SessionProjectCache(clock.now);
			cache.set("key:abc", "proj-a");

			clock.advance(TTL_MS); // entry expired, never looked up in between
			cache.set("key:abc", "proj-b");

			expect(cache.lookup("key:abc")).toEqual({
				project: "proj-b",
				ambiguous: false,
			});
		});

		it("ambiguity is per key", () => {
			const clock = makeClock();
			const cache = new SessionProjectCache(clock.now);
			cache.set("key:abc", "proj-a");
			cache.set("key:abc", "proj-b");
			cache.set("key:other", "proj-c");

			expect(cache.lookup("key:abc").ambiguous).toBe(true);
			expect(cache.lookup("key:other")).toEqual({
				project: "proj-c",
				ambiguous: false,
			});
		});
	});
});
