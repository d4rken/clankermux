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
	it("roundtrips set/get", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);
		expect(cache.set("key:abc", "clankermux")).toBeNull();
		expect(cache.get("key:abc")).toBe("clankermux");
	});

	it("returns null for a missing key", () => {
		const cache = new SessionProjectCache();
		expect(cache.get("nope")).toBeNull();
	});

	it("expires entries after TTL_MS", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);
		cache.set("key:abc", "clankermux");

		clock.advance(TTL_MS - 1);
		expect(cache.get("key:abc")).toBe("clankermux");

		clock.advance(1); // exactly at expiresAt → expired
		expect(cache.get("key:abc")).toBeNull();
		// Expired entry is removed entirely.
		expect(cache.size()).toBe(0);
	});

	it("get() refreshes recency but does NOT extend the TTL", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);
		cache.set("key:abc", "clankermux");

		// Touch the entry frequently; TTL still counts from the original set.
		for (let i = 0; i < 10; i++) {
			clock.advance(TTL_MS / 10);
			cache.get("key:abc");
		}
		// Total elapsed: TTL_MS — the entry must be expired despite the gets.
		expect(cache.get("key:abc")).toBeNull();
	});

	it("set() re-anchors the TTL", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);
		cache.set("key:abc", "clankermux");

		clock.advance(TTL_MS - 1);
		cache.set("key:abc", "clankermux");

		clock.advance(TTL_MS - 1);
		expect(cache.get("key:abc")).toBe("clankermux");
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
		expect(cache.get("key:0")).toBeNull();
		expect(cache.get("key:overflow")).toBe("proj-overflow");
		expect(cache.get("key:1")).toBe("proj-1");
	});

	it("a recently-get-touched entry survives eviction", () => {
		const clock = makeClock();
		const cache = new SessionProjectCache(clock.now);

		for (let i = 0; i < MAX_ENTRIES; i++) {
			cache.set(`key:${i}`, `proj-${i}`);
		}
		// Touch the oldest entry — it moves to most-recent position.
		expect(cache.get("key:0")).toBe("proj-0");

		// Overflow now evicts key:1 (the new oldest), not key:0.
		cache.set("key:overflow", "proj-overflow");
		expect(cache.get("key:0")).toBe("proj-0");
		expect(cache.get("key:1")).toBeNull();
	});

	it("set() returns the previous project for the key", () => {
		const cache = new SessionProjectCache();
		expect(cache.set("key:abc", "proj-a")).toBeNull();
		expect(cache.set("key:abc", "proj-b")).toBe("proj-a");
		expect(cache.set("key:abc", "proj-b")).toBe("proj-b");
		expect(cache.get("key:abc")).toBe("proj-b");
	});

	it("clear() empties the cache and size() tracks entries", () => {
		const cache = new SessionProjectCache();
		expect(cache.size()).toBe(0);
		cache.set("a", "p1");
		cache.set("b", "p2");
		expect(cache.size()).toBe(2);
		cache.clear();
		expect(cache.size()).toBe(0);
		expect(cache.get("a")).toBeNull();
	});
});
