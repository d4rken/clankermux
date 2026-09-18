import { describe, expect, it } from "bun:test";
import type { ModelCacheRetention } from "@clankermux/types";
import {
	readCacheUsage,
	SessionCacheEstimate,
} from "../session-cache-estimate";

const retention: ModelCacheRetention = {
	basis: "inferred",
	retentionMs: 1_800_000,
	semantics: "minimum",
	confidence: "low",
	anchor: "request_start",
	anchorBasis: "assumed",
	refreshOnReuse: true,
	refreshBasis: "assumed",
	sources: [],
	note: "Subscription applicability unverified.",
};
const context = {
	provider: "clankermux",
	model: "astra",
	sessionId: "session",
	branchId: "branch",
	prefixId: "opaque-prefix",
	toolsAndSystemId: "opaque-config",
	routePolicyId: "opaque-policy",
};
function tracker(policy = retention) {
	const value = new SessionCacheEstimate();
	value.setContext(context, policy);
	return value;
}

describe("cache usage evidence", () => {
	it("does not replace malformed or null primary evidence with another dialect's count", () => {
		expect(
			readCacheUsage({
				cache_read_input_tokens: -1,
				cachedContentTokenCount: 50,
			}),
		).toEqual({});
		expect(
			readCacheUsage({
				cache_read_input_tokens: null,
				prompt_cache_hit_tokens: 50,
			}),
		).toEqual({});
		expect(
			readCacheUsage({
				input_tokens_details: {
					cache_write_tokens: -1,
					cache_creation_input_tokens: 50,
				},
			}),
		).toEqual({});
	});

	it.each([
		[
			{ cache_read_input_tokens: 50, cache_creation_input_tokens: 20 },
			{ cacheReadTokens: 50, cacheWriteTokens: 20 },
		],
		[
			{ input_tokens_details: { cached_tokens: 50, cache_write_tokens: 20 } },
			{ cacheReadTokens: 50, cacheWriteTokens: 20 },
		],
		[
			{ prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 20 } },
			{ cacheReadTokens: 0, cacheWriteTokens: 20 },
		],
		[{ prompt_cache_hit_tokens: 50 }, { cacheReadTokens: 50 }],
		[{ cachedContentTokenCount: 50 }, { cacheReadTokens: 50 }],
		[{ cache_creation_input_tokens: 20 }, { cacheWriteTokens: 20 }],
		[{ cache_read_input_tokens: null, cache_creation_input_tokens: -1 }, {}],
		[
			{
				input_tokens_details: {
					cached_tokens: Number.NaN,
					cache_write_tokens: Infinity,
				},
			},
			{},
		],
		[{ input_tokens: 50 }, {}],
		[null, {}],
	])("reads counts without inventing evidence: %j", (usage, expected) => {
		expect(readCacheUsage(usage)).toEqual(expected);
	});
});

describe("in-memory session estimate", () => {
	it("has no session estimate before evidence, even with a retention default", () => {
		expect(tracker().snapshot(0)).toEqual({ status: "unknown" });
	});
	it("anchors at request start, shows partial hit counts, and becomes uncertain after the window", () => {
		const state = tracker();
		const request = state.beginRequest("r1", 1000);
		state.observe(
			request,
			{ input_tokens_details: { cached_tokens: 42 } },
			2000,
		);
		expect(state.snapshot(2000)).toMatchObject({
			status: "warm",
			lastObservedAt: 2000,
			cacheReadTokens: 42,
			estimatedUntil: 1_801_000,
			refreshedByRequestId: "r1",
		});
		expect(state.snapshot(2001).status).toBe("likely_warm");
		expect(state.snapshot(1_801_000).status).toBe("unknown");
	});
	it("refreshes on a hit, and does not refresh on a prompt with missing usage", () => {
		const state = tracker();
		state.observe(
			state.beginRequest("r1", 1000),
			{ cache_read_input_tokens: 20 },
			2000,
		);
		state.observe(
			state.beginRequest("r2", 3000),
			{ cache_read_input_tokens: 20 },
			4000,
		);
		expect(state.snapshot(4001).estimatedUntil).toBe(1_803_000);
		state.observe(state.beginRequest("r3", 5000), { input_tokens: 200 }, 6000);
		expect(state.snapshot(6000).estimatedUntil).toBe(1_803_000);
	});
	it("keeps write evidence separate from expiry and qualifies prior-prefix loss", () => {
		const state = tracker();
		state.observe(
			state.beginRequest("first", 1000),
			{ cache_creation_input_tokens: 40 },
			2000,
		);
		expect(state.snapshot(2000)).toMatchObject({
			status: "warm_write",
			previousPrefixUnavailable: false,
		});
		state.observe(
			state.beginRequest("hit", 3000),
			{ cache_read_input_tokens: 40 },
			4000,
		);
		state.observe(
			state.beginRequest("missing-read", 5000),
			{ cache_creation_input_tokens: 40 },
			6000,
		);
		expect(state.snapshot(6000).previousPrefixUnavailable).toBe(false);
		state.observe(
			state.beginRequest("write", 7000),
			{ cache_read_input_tokens: 0, cache_creation_input_tokens: 40 },
			8000,
		);
		expect(state.snapshot(8000)).toMatchObject({
			status: "warm_write",
			previousPrefixUnavailable: true,
		});
	});
	it("clears a prior estimate on explicit zero reads without a new write", () => {
		const state = tracker();
		state.observe(
			state.beginRequest("hit", 1000),
			{ cache_read_input_tokens: 40 },
			2000,
		);
		state.observe(
			state.beginRequest("miss", 3000),
			{ cache_read_input_tokens: 0 },
			4000,
		);
		expect(state.snapshot(4000)).toMatchObject({
			status: "unknown",
			cacheReadTokens: 0,
		});
		expect(state.snapshot(4000).estimatedUntil).toBeUndefined();
	});
	it("does not extend non-refreshing caches on reuse", () => {
		const state = tracker({ ...retention, refreshOnReuse: false });
		state.observe(
			state.beginRequest("write", 1000),
			{ cache_creation_input_tokens: 40 },
			2000,
		);
		state.observe(
			state.beginRequest("read", 3000),
			{ cache_read_input_tokens: 40 },
			4000,
		);
		expect(state.snapshot(4000).estimatedUntil).toBe(1_801_000);
		const onlyRead = tracker({ ...retention, refreshOnReuse: false });
		onlyRead.observe(
			onlyRead.beginRequest("read", 1000),
			{ cache_read_input_tokens: 40 },
			2000,
		);
		expect(onlyRead.snapshot(2000).estimatedUntil).toBeUndefined();
		expect(onlyRead.snapshot(2001).status).toBe("unknown");
	});
	it.each(
		Object.keys(context) as Array<keyof typeof context>,
	)("resets on %s and ignores an old in-flight response", (key) => {
		const state = tracker();
		const old = state.beginRequest("old", 1000);
		state.observe(old, { cache_read_input_tokens: 40 }, 2000);
		state.setContext({ ...context, [key]: "changed" }, retention);
		state.observe(old, { cache_read_input_tokens: 40 }, 3000);
		expect(state.snapshot(3000)).toEqual({ status: "unknown" });
	});
	it("resets on changed metadata or clear, without storing context in state", () => {
		const state = tracker();
		const old = state.beginRequest("old", 1000);
		state.observe(old, { cache_read_input_tokens: 40 }, 2000);
		state.setContext(context, { ...retention, retentionMs: 300_000 });
		expect(state.snapshot(2000)).toEqual({ status: "unknown" });
		state.observe(
			state.beginRequest("new", 3000),
			{ cache_read_input_tokens: 40 },
			4000,
		);
		expect(JSON.stringify(state.snapshot(4000))).not.toContain("opaque-prefix");
		state.clear();
		expect(state.snapshot(5000)).toEqual({ status: "unknown" });
	});
	it("rejects stale overlapping completions and invalid times", () => {
		const state = tracker();
		const older = state.beginRequest("older", 1000);
		const newer = state.beginRequest("newer", 2000);
		state.observe(newer, { cache_read_input_tokens: 40 }, 3000);
		state.observe(older, { cache_read_input_tokens: 0 }, 4000);
		expect(state.snapshot(4000).estimatedUntil).toBe(1_802_000);
		expect(() => state.beginRequest("invalid", NaN)).toThrow();
		const next = state.beginRequest("next", 5000);
		expect(() => state.observe(next, {}, 4000)).toThrow();
	});
	it("does not claim current warmth when a long request outlasts the advisory window", () => {
		const state = tracker({ ...retention, retentionMs: 1000 });
		state.observe(
			state.beginRequest("long", 1000),
			{ cache_read_input_tokens: 40 },
			3000,
		);
		expect(state.snapshot(3000)).toMatchObject({
			status: "unknown",
			estimatedUntil: 2000,
		});
	});
	it("supports the end anchor only when explicitly selected", () => {
		const state = tracker({ ...retention, anchor: "request_end" });
		state.observe(
			state.beginRequest("r", 1000),
			{ cache_creation_input_tokens: 40 },
			2000,
		);
		expect(state.snapshot(2000).estimatedUntil).toBe(1_802_000);
	});
});
