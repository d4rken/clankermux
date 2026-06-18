/**
 * Predictive 1-hour-TTL promotion wiring (Session Cache Bridge, Phase 2b).
 *
 * Two layers are covered:
 *
 *  1. The request-path injection-DECISION block. handleProxy (proxy.ts) runs this
 *     exact gate after computing the token estimate and before finalBodyBuffer:
 *
 *         if (config.getCacheWarmingEnabled() && affinity.key) {
 *           if (tracker.observeAndShouldInject(affinity.key, now, est, min)) {
 *             injectCacheTtl1h(requestBodyContext);
 *           }
 *         }
 *
 *     It mutates `requestBodyContext` in place, so getBuffer() — which feeds both
 *     the upstream fetch AND the staged keepalive body — carries the 1h TTL. The
 *     helper `decideAndInject` below mirrors that block verbatim so the decision is
 *     unit-tested against a real RequestBodyContext without standing up the full
 *     proxy pipeline.
 *
 *  2. The STAGED body. cacheBodyStore.stageRequest() stores the SAME buffer the
 *     decision block injected into (proxyWithAccount stages baseBodyContext
 *     .getBuffer(), and baseBodyContext IS the request-path requestBodyContext).
 *     A promoted session's stored warm-body must therefore contain ttl:"1h" so the
 *     ~50-min keepalive replays refresh a 1h cache (not a 5m one). This layer
 *     drives the real cacheBodyStore → onSummary → sessionCacheStore path and
 *     asserts the persisted slot body.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_MIN_CACHE_TOKENS,
	PROMOTE_AFTER_TURNS,
} from "../bridge-policy";
import { cacheBodyStore } from "../cache-body-store";
import { injectCacheTtl1h } from "../cache-ttl-injector";
import { RequestBodyContext } from "../request-body-context";
import { sessionCacheStore } from "../session-cache-store";
import { sessionPromotionTracker } from "../session-promotion";

const OPUS = "claude-opus-4-8";

/** A /v1/messages body with one ephemeral system breakpoint (default 5m TTL). */
function makeBodyBuffer(model = OPUS): ArrayBuffer {
	const body = {
		model,
		max_tokens: 100,
		system: [
			{
				type: "text",
				text: "you are helpful",
				cache_control: { type: "ephemeral" },
			},
		],
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "hello", cache_control: { type: "ephemeral" } },
				],
			},
		],
	};
	return new TextEncoder().encode(JSON.stringify(body)).buffer;
}

function ttlValues(buffer: ArrayBuffer | null): Array<string | undefined> {
	if (!buffer) return [];
	const body = JSON.parse(new TextDecoder().decode(buffer));
	const out: Array<string | undefined> = [];
	const walk = (blocks: unknown) => {
		if (!Array.isArray(blocks)) return;
		for (const b of blocks) {
			const cc = (b as { cache_control?: { type?: string; ttl?: string } })
				.cache_control;
			if (cc?.type === "ephemeral") out.push(cc.ttl);
		}
	};
	walk(body.system);
	for (const m of body.messages ?? []) walk(m.content);
	return out;
}

/** Minimal config stub exposing only the two getters the gate reads. */
function makeConfig(enabled: boolean, minTokens = DEFAULT_MIN_CACHE_TOKENS) {
	return {
		getCacheWarmingEnabled: () => enabled,
		getCacheWarmingMinTokens: () => minTokens,
	};
}

/**
 * Verbatim mirror of the handleProxy injection-decision block (proxy.ts §3b).
 * Returns the (possibly mutated) context's buffer so the test can assert TTLs.
 *
 * `globalForcedActive` mirrors `!isInternal && getForcedAccount() !== null`: a
 * request that will route to proxyForcedAccount (which forwards the injected body
 * but never stages a warm slot). When set, the whole block is skipped — no observe,
 * no inject — so the 2x 1h-write premium is never paid with no bridging benefit.
 */
function decideAndInject(
	config: {
		getCacheWarmingEnabled: () => boolean;
		getCacheWarmingMinTokens: () => number;
	},
	affinityKey: string | null,
	context: RequestBodyContext,
	requestTokenEstimate: number,
	now: number,
	globalForcedActive = false,
): void {
	if (config.getCacheWarmingEnabled() && affinityKey && !globalForcedActive) {
		if (
			sessionPromotionTracker.observeAndShouldInject(
				affinityKey,
				now,
				requestTokenEstimate,
				config.getCacheWarmingMinTokens(),
			)
		) {
			injectCacheTtl1h(context);
		}
	}
}

/** Pre-promote a session by observing PROMOTE_AFTER_TURNS turns. */
function promote(key: string): void {
	const now = Date.now();
	for (let i = 0; i < PROMOTE_AFTER_TURNS; i++) {
		sessionPromotionTracker.observeAndShouldInject(key, now + i, 0, 0);
	}
	expect(sessionPromotionTracker.isPromoted(key)).toBe(true);
}

beforeEach(() => {
	sessionPromotionTracker.setEnabled(true);
	sessionPromotionTracker.clear();
	cacheBodyStore.setEnabled(true);
	sessionCacheStore.setEnabled(true);
	sessionCacheStore.setMinTokens(DEFAULT_MIN_CACHE_TOKENS);
	sessionCacheStore.clear();
});

afterEach(() => {
	sessionPromotionTracker.clear();
	sessionPromotionTracker.setEnabled(false);
	cacheBodyStore.setEnabled(false);
	sessionCacheStore.clear();
	sessionCacheStore.setEnabled(false);
});

describe("request-path injection decision", () => {
	it("promoted session + tokens >= min + enabled → injects ttl:1h on every breakpoint", () => {
		const key = "promoted-sess";
		promote(key);
		const ctx = new RequestBodyContext(makeBodyBuffer());
		decideAndInject(makeConfig(true, 100_000), key, ctx, 200_000, Date.now());

		const ttls = ttlValues(ctx.getBuffer());
		expect(ttls.length).toBe(2);
		expect(ttls.every((t) => t === "1h")).toBe(true);
	});

	it("non-promoted (early-turn) session → no ttl injected", () => {
		// A brand-new session: the FIRST observe (turn 1 < PROMOTE_AFTER_TURNS, no
		// idle gap) is not promoted, so nothing is injected even though it's large.
		const ctx = new RequestBodyContext(makeBodyBuffer());
		decideAndInject(
			makeConfig(true, 100_000),
			"fresh-sess",
			ctx,
			500_000,
			Date.now(),
		);

		const ttls = ttlValues(ctx.getBuffer());
		expect(ttls.length).toBe(2);
		expect(ttls.every((t) => t === undefined)).toBe(true);
		expect(ctx.isDirty).toBe(false); // injector never marked it dirty
	});

	it("promoted session but tokens < min → no ttl injected", () => {
		const key = "small-promoted";
		promote(key);
		const ctx = new RequestBodyContext(makeBodyBuffer());
		// Estimate below the min-token threshold.
		decideAndInject(makeConfig(true, 100_000), key, ctx, 50_000, Date.now());

		const ttls = ttlValues(ctx.getBuffer());
		expect(ttls.every((t) => t === undefined)).toBe(true);
	});

	it("cache_warming disabled → no injection (and the session isn't even observed)", () => {
		const key = "disabled-sess";
		const ctx = new RequestBodyContext(makeBodyBuffer());
		decideAndInject(makeConfig(false, 100_000), key, ctx, 500_000, Date.now());

		expect(ttlValues(ctx.getBuffer()).every((t) => t === undefined)).toBe(true);
		// Gate short-circuits before observe → tracker stays empty.
		expect(sessionPromotionTracker.getSize()).toBe(0);
	});

	it("no affinity key (synthetic / unkeyed) → no injection, no observe", () => {
		const ctx = new RequestBodyContext(makeBodyBuffer());
		decideAndInject(makeConfig(true, 100_000), null, ctx, 500_000, Date.now());

		expect(ttlValues(ctx.getBuffer()).every((t) => t === undefined)).toBe(true);
		expect(sessionPromotionTracker.getSize()).toBe(0);
	});

	it("GLOBAL forced account active → promoted+large request is NOT injected and is NOT observed", () => {
		// A session already promoted by prior (non-forced) turns. With a global forced
		// account active, the request routes to proxyForcedAccount, which never stages
		// a warm slot — so injecting ttl:1h would pay the 2x premium for nothing.
		const key = "forced-sess";
		promote(key);
		const sizeBefore = sessionPromotionTracker.getSize();
		const ctx = new RequestBodyContext(makeBodyBuffer());
		decideAndInject(
			makeConfig(true, 100_000),
			key,
			ctx,
			500_000,
			Date.now(),
			/* globalForcedActive */ true,
		);

		// No 1h injection despite being promoted + large.
		expect(ttlValues(ctx.getBuffer()).every((t) => t === undefined)).toBe(true);
		expect(ctx.isDirty).toBe(false);
		// The block short-circuits before observe → tracker is untouched.
		expect(sessionPromotionTracker.getSize()).toBe(sizeBefore);
	});

	it("HEADER force-route (no global forced account) → promoted+large request IS injected", () => {
		// The x-clankermux-account-id header force goes through proxyWithAccount, which
		// DOES stage a warm slot, so injection + staging are still wanted. In the gate
		// this is exactly the non-globally-forced path (globalForcedActive=false).
		const key = "header-forced-sess";
		promote(key);
		const ctx = new RequestBodyContext(makeBodyBuffer());
		decideAndInject(
			makeConfig(true, 100_000),
			key,
			ctx,
			200_000,
			Date.now(),
			/* globalForcedActive */ false,
		);

		const ttls = ttlValues(ctx.getBuffer());
		expect(ttls.length).toBe(2);
		expect(ttls.every((t) => t === "1h")).toBe(true);
	});
});

describe("staged keepalive body carries ttl:1h for a promoted session", () => {
	it("the persisted warm-body slot contains ttl:1h after injection + stageRequest + onSummary", () => {
		const key = "stage-sess";
		const accountId = "acc-stage";
		const requestId = "req-1";
		promote(key);

		// 1. Request-path: the same RequestBodyContext handleProxy mutates in place.
		const ctx = new RequestBodyContext(makeBodyBuffer());
		decideAndInject(makeConfig(true, 100_000), key, ctx, 200_000, Date.now());
		// Sanity: the request-path buffer is now 1h.
		expect(ttlValues(ctx.getBuffer()).every((t) => t === "1h")).toBe(true);

		// 2. proxyWithAccount stages baseBodyContext.getBuffer() — the SAME injected
		//    buffer. Replicate that stage call with the injected buffer.
		cacheBodyStore.stageRequest(
			requestId,
			accountId,
			ctx.getBuffer(),
			new Headers({
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
			}),
			"/v1/messages",
			key,
			"anthropic",
		);

		// 3. The inline usage collector finalizes with cache_creation > 0 → the
		//    staged body is registered as the warm slot.
		cacheBodyStore.onSummary(requestId, 150_000, 0, OPUS);

		const slot = sessionCacheStore
			.getAllSlots()
			.find((s) => s.accountId === accountId && s.sessionKey === key);
		expect(slot).toBeDefined();
		// The STORED warm body must carry ttl:1h so ~50-min replays refresh a 1h cache.
		const ttls = ttlValues(
			slot?.body.buffer.slice(
				slot.body.byteOffset,
				slot.body.byteOffset + slot.body.byteLength,
			) as ArrayBuffer,
		);
		expect(ttls.length).toBe(2);
		expect(ttls.every((t) => t === "1h")).toBe(true);
	});

	it("a non-promoted session's staged body keeps the default (no ttl) breakpoints", () => {
		const key = "stage-plain";
		const accountId = "acc-plain";
		const requestId = "req-2";

		// Early-turn session: decision injects nothing.
		const ctx = new RequestBodyContext(makeBodyBuffer());
		decideAndInject(makeConfig(true, 100_000), key, ctx, 500_000, Date.now());
		expect(ttlValues(ctx.getBuffer()).every((t) => t === undefined)).toBe(true);

		cacheBodyStore.stageRequest(
			requestId,
			accountId,
			ctx.getBuffer(),
			new Headers({ "content-type": "application/json" }),
			"/v1/messages",
			key,
			"anthropic",
		);
		cacheBodyStore.onSummary(requestId, 150_000, 0, OPUS);

		const slot = sessionCacheStore
			.getAllSlots()
			.find((s) => s.accountId === accountId && s.sessionKey === key);
		expect(slot).toBeDefined();
		const ttls = ttlValues(
			slot?.body.buffer.slice(
				slot.body.byteOffset,
				slot.body.byteOffset + slot.body.byteLength,
			) as ArrayBuffer,
		);
		expect(ttls.every((t) => t === undefined)).toBe(true);
	});
});
