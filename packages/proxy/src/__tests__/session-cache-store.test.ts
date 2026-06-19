import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getModelCacheRates } from "@clankermux/core";
import {
	DEFAULT_MIN_CACHE_TOKENS,
	IDLE_GAP_FOR_PROMOTION_MS,
	KEEPALIVE_REFRESH_1H_MS,
	KEEPALIVE_REFRESH_MS,
	keepaliveBudgetUsd,
	keepaliveHitCostUsd,
	MAX_KEEPALIVE_FAILURES,
	MAX_SESSION_BODY_BYTES,
	MAX_SESSION_SLOTS,
	PROMOTE_AFTER_TURNS,
	RISK_FACTOR,
} from "../bridge-policy";
import { sessionCacheStore } from "../session-cache-store";
import { sessionPromotionTracker } from "../session-promotion";

// Real model ids. Opus 4.8 has a cache-write premium (read 0.5, write 6.25);
// zai/GLM-4.5 has cache_write: 0 → no premium (the provider gate must skip it).
const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-4-5-20250929";
const GLM = "glm-4.5"; // cache_write: 0 in BUNDLED_PRICING → no write premium

/** A far-future `now` so the refresh gate always passes (register uses Date.now()). */
const FUTURE = () => Date.now() + 3_600_000;

function makeHeaders(extra: Record<string, string> = {}): Headers {
	return new Headers({
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
		"user-agent": "claude-cli/test",
		...extra,
	});
}

function body(bytes: number): Uint8Array {
	return new Uint8Array(bytes);
}

/**
 * A JSON body whose ephemeral cache breakpoint carries ttl:"1h" (what the proxy
 * injects when promoting a session). register() reads the body's TTL to pick the
 * 1h vs 5m cadence/rate, so a "promoted" slot in tests is one staged with this body.
 */
function oneHourBody(): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			system: [
				{
					type: "text",
					text: "s",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
		}),
	);
}

interface RegisterOpts {
	accountId?: string;
	sessionKey?: string;
	bodyBytes?: number;
	body?: Uint8Array;
	/** Stage a body with ttl:"1h" so register() picks the 1h cadence/rate. */
	oneHour?: boolean;
	model?: string;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	headers?: Headers;
}

function register(opts: RegisterOpts = {}): void {
	sessionCacheStore.register({
		accountId: opts.accountId ?? "acc-1",
		sessionKey: opts.sessionKey ?? "sess-1",
		body:
			opts.body ??
			(opts.oneHour ? oneHourBody() : body(opts.bodyBytes ?? 1024)),
		headers: opts.headers ?? makeHeaders(),
		path: "/v1/messages",
		model: opts.model ?? OPUS,
		cacheReadTokens: opts.cacheReadTokens ?? 150_000,
		cacheCreationTokens: opts.cacheCreationTokens ?? 0,
	});
}

beforeEach(() => {
	sessionCacheStore.setEnabled(true);
	sessionCacheStore.setMinTokens(DEFAULT_MIN_CACHE_TOKENS);
	sessionCacheStore.setRiskFactor(RISK_FACTOR);
	sessionCacheStore.clear();
	// Isolate the shared promotion tracker singleton across tests.
	sessionPromotionTracker.setEnabled(true);
	sessionPromotionTracker.clear();
});

afterEach(() => {
	sessionCacheStore.clear();
	sessionCacheStore.setMinTokens(DEFAULT_MIN_CACHE_TOKENS);
	sessionCacheStore.setEnabled(false);
	sessionPromotionTracker.clear();
	sessionPromotionTracker.setEnabled(false);
});

/**
 * Drive the promotion tracker to a promoted (sticky) state for `sessionKey` by
 * observing PROMOTE_AFTER_TURNS turns. Tokens/minTokens are irrelevant to the
 * sticky flag, so we pass a clearing pair.
 */
function promote(sessionKey: string): void {
	const now = Date.now();
	for (let i = 0; i < PROMOTE_AFTER_TURNS; i++) {
		sessionPromotionTracker.observeAndShouldInject(sessionKey, now + i, 0, 0);
	}
	if (!sessionPromotionTracker.isPromoted(sessionKey)) {
		throw new Error(`expected ${sessionKey} to be promoted`);
	}
}

describe("SessionCacheStore — register provider/token gating", () => {
	it("stores a premium model session above the token threshold", () => {
		register({ cacheReadTokens: 150_000 });
		expect(sessionCacheStore.getSize()).toBe(1);
		const slot = sessionCacheStore.getAllSlots()[0];
		expect(slot.cachedTokens).toBe(150_000);
		expect(slot.cacheReadPer1M).toBe(0.5);
		expect(slot.cacheWritePer1M).toBe(6.25);
		expect(slot.budgetUsd).toBeGreaterThan(0);
		expect(slot.priorityUsd).toBeGreaterThan(0);
		expect(slot.spentUsd).toBe(0);
		expect(slot.lastKeepaliveTs).toBeNull();
	});

	it("skips a no-premium (zai/GLM) session even when huge", () => {
		// Sanity: GLM has no write premium.
		const rates = getModelCacheRates(GLM);
		expect(rates.cacheWritePer1M).toBe(0);

		register({ model: GLM, cacheReadTokens: 1_000_000 });
		expect(sessionCacheStore.getSize()).toBe(0);
	});

	it("skips a session below the token threshold", () => {
		register({ cacheReadTokens: DEFAULT_MIN_CACHE_TOKENS - 1 });
		expect(sessionCacheStore.getSize()).toBe(0);
	});

	it("counts cacheRead + cacheCreation toward the threshold", () => {
		register({ cacheReadTokens: 60_000, cacheCreationTokens: 60_000 });
		expect(sessionCacheStore.getSize()).toBe(1);
		expect(sessionCacheStore.getAllSlots()[0].cachedTokens).toBe(120_000);
	});

	it("deletes an existing slot when a re-register falls below threshold", () => {
		register({ sessionKey: "a", cacheReadTokens: 150_000 });
		expect(sessionCacheStore.getSize()).toBe(1);
		register({ sessionKey: "a", cacheReadTokens: 10_000 });
		expect(sessionCacheStore.getSize()).toBe(0);
	});

	it("deletes an existing slot when a re-register loses its premium", () => {
		register({ sessionKey: "a", model: OPUS, cacheReadTokens: 150_000 });
		expect(sessionCacheStore.getSize()).toBe(1);
		register({ sessionKey: "a", model: GLM, cacheReadTokens: 150_000 });
		expect(sessionCacheStore.getSize()).toBe(0);
	});

	it("setMinTokens changes the eligibility gate", () => {
		sessionCacheStore.setMinTokens(20_000);
		register({ cacheReadTokens: 25_000 });
		expect(sessionCacheStore.getSize()).toBe(1);

		sessionCacheStore.clear();
		sessionCacheStore.setMinTokens(200_000);
		register({ cacheReadTokens: 150_000 });
		expect(sessionCacheStore.getSize()).toBe(0);
	});

	it("setMinTokens clamps a negative floor to >= 0", () => {
		sessionCacheStore.setMinTokens(-5);
		register({ cacheReadTokens: 150_000 });
		expect(sessionCacheStore.getSize()).toBe(1);
	});
});

describe("SessionCacheStore — getEligibleSessions refresh gating", () => {
	it("is NOT due immediately after a fresh register (recently active)", () => {
		register({ cacheReadTokens: 150_000 });
		expect(sessionCacheStore.getEligibleSessions(Date.now()).length).toBe(0);
	});

	it("becomes due after KEEPALIVE_REFRESH_MS of idleness", () => {
		register({ cacheReadTokens: 150_000 });
		const lastActivity = sessionCacheStore.getAllSlots()[0].lastActivityTs;
		// Just under the refresh window: not due.
		expect(
			sessionCacheStore.getEligibleSessions(
				lastActivity + KEEPALIVE_REFRESH_MS - 1,
			).length,
		).toBe(0);
		// At/after the refresh window: due.
		expect(
			sessionCacheStore.getEligibleSessions(lastActivity + KEEPALIVE_REFRESH_MS)
				.length,
		).toBe(1);
	});

	it("is NOT due again until KEEPALIVE_REFRESH_MS after the last keepalive", () => {
		register({ cacheReadTokens: 150_000 });
		const now = FUTURE();
		expect(sessionCacheStore.getEligibleSessions(now).length).toBe(1);
		sessionCacheStore.recordKeepaliveResult("acc-1", "sess-1", true, now);
		// Right after the keepalive: not due (recently touched).
		expect(sessionCacheStore.getEligibleSessions(now + 1).length).toBe(0);
		// After the refresh window: due again (budget permitting).
		expect(
			sessionCacheStore.getEligibleSessions(now + KEEPALIVE_REFRESH_MS).length,
		).toBe(1);
	});

	it("sorts eligible sessions by priorityUsd DESC", () => {
		register({ sessionKey: "small", cacheReadTokens: 120_000 });
		register({ sessionKey: "big", cacheReadTokens: 500_000 });
		const eligible = sessionCacheStore.getEligibleSessions(FUTURE());
		expect(eligible.length).toBe(2);
		expect(eligible[0].sessionKey).toBe("big");
		expect(eligible[1].sessionKey).toBe("small");
		expect(eligible[0].priorityUsd).toBeGreaterThan(eligible[1].priorityUsd);
	});
});

describe("SessionCacheStore — spend budget exhaustion", () => {
	it("excludes a session once accumulated hit-spend reaches the budget (~4-5 hits)", () => {
		register({ cacheReadTokens: 100_000 });
		const slot = sessionCacheStore.getAllSlots()[0];
		const budget = keepaliveBudgetUsd(
			100_000,
			slot.cacheReadPer1M,
			slot.cacheWritePer1M,
		);
		const hit = keepaliveHitCostUsd(100_000, slot.cacheReadPer1M);
		expect(budget).toBeCloseTo(0.23, 10);
		expect(hit).toBeCloseTo(0.05, 10);

		let hits = 0;
		let now = FUTURE();
		// Keep recording hits while eligible, advancing past each refresh window.
		while (sessionCacheStore.getEligibleSessions(now).length > 0) {
			sessionCacheStore.recordKeepaliveResult("acc-1", "sess-1", true, now);
			hits++;
			now += KEEPALIVE_REFRESH_MS;
			if (hits > 20) break; // safety
		}
		expect(hits).toBeGreaterThanOrEqual(4);
		expect(hits).toBeLessThanOrEqual(5);
		// Now exhausted: no longer eligible.
		expect(sessionCacheStore.getEligibleSessions(now).length).toBe(0);
		expect(sessionCacheStore.getAllSlots()[0].spentUsd).toBeGreaterThanOrEqual(
			budget,
		);
	});

	it("exhausts the budget in one shot on a single MISS", () => {
		register({ cacheReadTokens: 100_000 });
		const now = FUTURE();
		expect(sessionCacheStore.getEligibleSessions(now).length).toBe(1);
		sessionCacheStore.recordKeepaliveResult("acc-1", "sess-1", false, now);
		// One miss ≈ whole budget → excluded forever (until real activity).
		expect(
			sessionCacheStore.getEligibleSessions(now + KEEPALIVE_REFRESH_MS).length,
		).toBe(0);
		const slot = sessionCacheStore.getAllSlots()[0];
		expect(slot.spentUsd).toBeGreaterThan(slot.budgetUsd);
	});

	it("recordKeepaliveResult is a no-op on a missing slot", () => {
		expect(() =>
			sessionCacheStore.recordKeepaliveResult("nope", "nope", true, Date.now()),
		).not.toThrow();
	});
});

describe("SessionCacheStore — recordKeepaliveFailure backoff + eviction", () => {
	it("sets lastKeepaliveTs (slot no longer immediately due) and increments failures", () => {
		register({ cacheReadTokens: 150_000 });
		const now = FUTURE();
		// Due before the failure.
		expect(sessionCacheStore.getEligibleSessions(now).length).toBe(1);

		sessionCacheStore.recordKeepaliveFailure("acc-1", "sess-1", now);
		const slot = sessionCacheStore.getAllSlots()[0];
		expect(slot.keepaliveFailures).toBe(1);
		expect(slot.lastKeepaliveTs).toBe(now);
		// Backed off: not immediately due again.
		expect(sessionCacheStore.getEligibleSessions(now + 1).length).toBe(0);
		// Due again after the refresh window.
		expect(
			sessionCacheStore.getEligibleSessions(now + KEEPALIVE_REFRESH_MS).length,
		).toBe(1);
	});

	it("evicts the slot after MAX_KEEPALIVE_FAILURES consecutive failures", () => {
		register({ cacheReadTokens: 150_000 });
		let now = FUTURE();
		for (let i = 0; i < MAX_KEEPALIVE_FAILURES - 1; i++) {
			sessionCacheStore.recordKeepaliveFailure("acc-1", "sess-1", now);
			now += KEEPALIVE_REFRESH_MS;
		}
		// Still present, just below the threshold.
		expect(sessionCacheStore.getSize()).toBe(1);
		expect(sessionCacheStore.getAllSlots()[0].keepaliveFailures).toBe(
			MAX_KEEPALIVE_FAILURES - 1,
		);

		// The MAX-th consecutive failure evicts the slot.
		sessionCacheStore.recordKeepaliveFailure("acc-1", "sess-1", now);
		expect(sessionCacheStore.getSize()).toBe(0);
		expect(sessionCacheStore.getTotalBytes()).toBe(0);
	});

	it("a successful keepalive between failures resets the streak", () => {
		register({ cacheReadTokens: 150_000 });
		let now = FUTURE();
		sessionCacheStore.recordKeepaliveFailure("acc-1", "sess-1", now);
		now += KEEPALIVE_REFRESH_MS;
		sessionCacheStore.recordKeepaliveFailure("acc-1", "sess-1", now);
		expect(sessionCacheStore.getAllSlots()[0].keepaliveFailures).toBe(2);

		// A success clears the streak.
		now += KEEPALIVE_REFRESH_MS;
		sessionCacheStore.recordKeepaliveResult("acc-1", "sess-1", true, now);
		expect(sessionCacheStore.getAllSlots()[0].keepaliveFailures).toBe(0);

		// MAX more failures are now required to evict (no carry-over from before).
		now += KEEPALIVE_REFRESH_MS;
		for (let i = 0; i < MAX_KEEPALIVE_FAILURES - 1; i++) {
			sessionCacheStore.recordKeepaliveFailure("acc-1", "sess-1", now);
			now += KEEPALIVE_REFRESH_MS;
		}
		expect(sessionCacheStore.getSize()).toBe(1);
		sessionCacheStore.recordKeepaliveFailure("acc-1", "sess-1", now);
		expect(sessionCacheStore.getSize()).toBe(0);
	});

	it("is a no-op on a missing slot", () => {
		expect(sessionCacheStore.getSize()).toBe(0);
		expect(() =>
			sessionCacheStore.recordKeepaliveFailure("nope", "nope", Date.now()),
		).not.toThrow();
		expect(sessionCacheStore.getSize()).toBe(0);
	});
});

describe("SessionCacheStore — touchActivity resets spend", () => {
	it("resets spend so an exhausted session bridges again after real activity", () => {
		register({ cacheReadTokens: 100_000 });
		const now = FUTURE();
		// One miss exhausts the budget.
		sessionCacheStore.recordKeepaliveResult("acc-1", "sess-1", false, now);
		expect(
			sessionCacheStore.getEligibleSessions(now + KEEPALIVE_REFRESH_MS).length,
		).toBe(0);

		// A real cache-read turn proves the cache is warm → reset budget + activity.
		const activeNow = now + KEEPALIVE_REFRESH_MS;
		sessionCacheStore.touchActivity("acc-1", "sess-1", activeNow);
		const slot = sessionCacheStore.getAllSlots()[0];
		expect(slot.spentUsd).toBe(0);
		expect(slot.lastKeepaliveTs).toBeNull();
		expect(slot.lastActivityTs).toBe(activeNow);

		// Not due right at activeNow (just active)...
		expect(sessionCacheStore.getEligibleSessions(activeNow).length).toBe(0);
		// ...but due again after the refresh window.
		expect(
			sessionCacheStore.getEligibleSessions(activeNow + KEEPALIVE_REFRESH_MS)
				.length,
		).toBe(1);
	});

	it("is a no-op on a missing slot and does NOT create one", () => {
		expect(sessionCacheStore.getSize()).toBe(0);
		expect(() =>
			sessionCacheStore.touchActivity(
				"acc-missing",
				"sess-missing",
				Date.now(),
			),
		).not.toThrow();
		expect(sessionCacheStore.getSize()).toBe(0);
	});

	it("does not replace the stored body", () => {
		register({ accountId: "acc-1", sessionKey: "sess-1", bodyBytes: 2048 });
		const before = sessionCacheStore.getAllSlots()[0].body;
		sessionCacheStore.touchActivity("acc-1", "sess-1", Date.now());
		const after = sessionCacheStore.getAllSlots()[0].body;
		expect(after).toBe(before);
		expect(after.byteLength).toBe(2048);
	});
});

describe("SessionCacheStore — per-session keying", () => {
	it("stores two sessions on the same account independently", () => {
		register({ accountId: "acc-1", sessionKey: "a" });
		register({ accountId: "acc-1", sessionKey: "b" });
		expect(sessionCacheStore.getSize()).toBe(2);
	});

	it("upserts the same key and resets spend lifecycle", () => {
		register({ accountId: "acc-1", sessionKey: "a", cacheReadTokens: 150_000 });
		const now = FUTURE();
		sessionCacheStore.recordKeepaliveResult("acc-1", "a", true, now);
		let slot = sessionCacheStore.getAllSlots()[0];
		expect(slot.spentUsd).toBeGreaterThan(0);
		expect(slot.lastKeepaliveTs).toBe(now);

		register({ accountId: "acc-1", sessionKey: "a", cacheReadTokens: 150_000 });
		expect(sessionCacheStore.getSize()).toBe(1);
		slot = sessionCacheStore.getAllSlots()[0];
		expect(slot.spentUsd).toBe(0);
		expect(slot.lastKeepaliveTs).toBeNull();
	});
});

describe("SessionCacheStore — eviction bounds", () => {
	it("never exceeds MAX_SESSION_SLOTS and evicts lowest priority first", () => {
		// Sonnet has a lower write premium than Opus → lower priorityUsd.
		register({
			sessionKey: "lowprio",
			cacheReadTokens: DEFAULT_MIN_CACHE_TOKENS,
			model: SONNET,
		});
		for (let i = 0; i < MAX_SESSION_SLOTS + 5; i++) {
			register({
				sessionKey: `high-${i}`,
				cacheReadTokens: 500_000,
				model: OPUS,
			});
		}
		expect(sessionCacheStore.getSize()).toBeLessThanOrEqual(MAX_SESSION_SLOTS);
		const keys = sessionCacheStore.getAllSlots().map((s) => s.sessionKey);
		expect(keys).not.toContain("lowprio");
	});

	it("evicts the lowest-priority slot first when over the byte budget", () => {
		const large = MAX_SESSION_BODY_BYTES; // 2 MiB each
		register({
			sessionKey: "lowprio",
			cacheReadTokens: DEFAULT_MIN_CACHE_TOKENS,
			model: SONNET,
			bodyBytes: large,
		});
		for (let i = 0; i < 40; i++) {
			register({
				sessionKey: `high-${i}`,
				cacheReadTokens: 1_000_000,
				model: OPUS,
				bodyBytes: large,
			});
		}
		expect(sessionCacheStore.getTotalBytes()).toBeLessThanOrEqual(
			64 * 1024 * 1024,
		);
		const keys = sessionCacheStore.getAllSlots().map((s) => s.sessionKey);
		expect(keys).not.toContain("lowprio");
	});
});

describe("SessionCacheStore — per-body cap", () => {
	it("does not store a body larger than MAX_SESSION_BODY_BYTES", () => {
		register({ bodyBytes: MAX_SESSION_BODY_BYTES + 1 });
		expect(sessionCacheStore.getSize()).toBe(0);
	});

	it("removes any prior slot for the key when an oversized body arrives", () => {
		register({ accountId: "acc-1", sessionKey: "a", bodyBytes: 1024 });
		expect(sessionCacheStore.getSize()).toBe(1);
		register({
			accountId: "acc-1",
			sessionKey: "a",
			bodyBytes: MAX_SESSION_BODY_BYTES + 1,
		});
		expect(sessionCacheStore.getSize()).toBe(0);
		expect(sessionCacheStore.getTotalBytes()).toBe(0);
	});
});

describe("SessionCacheStore — enable/disable", () => {
	it("clears everything and no-ops register when disabled", () => {
		register();
		expect(sessionCacheStore.getSize()).toBe(1);
		sessionCacheStore.setEnabled(false);
		expect(sessionCacheStore.getSize()).toBe(0);
		expect(sessionCacheStore.getTotalBytes()).toBe(0);

		register();
		expect(sessionCacheStore.getSize()).toBe(0);
	});
});

describe("SessionCacheStore — evictAccount", () => {
	it("removes only the given account's slots", () => {
		register({ accountId: "acc-1", sessionKey: "a" });
		register({ accountId: "acc-1", sessionKey: "b" });
		register({ accountId: "acc-2", sessionKey: "c" });
		expect(sessionCacheStore.getSize()).toBe(3);

		sessionCacheStore.evictAccount("acc-1");
		expect(sessionCacheStore.getSize()).toBe(1);
		expect(sessionCacheStore.getAllSlots()[0].accountId).toBe("acc-2");
		expect(sessionCacheStore.getTotalBytes()).toBe(
			sessionCacheStore.getAllSlots()[0].body.byteLength,
		);
	});
});

describe("SessionCacheStore — header sanitization", () => {
	it("strips auth and internal headers but keeps benign ones", () => {
		register({
			headers: makeHeaders({
				authorization: "Bearer secret",
				"x-api-key": "sk-secret",
				"x-clankermux-account-id": "acc-x",
				"x-claude-code-session-id": "sess-x",
			}),
		});
		const slot = sessionCacheStore.getAllSlots()[0];
		const keys = Object.keys(slot.headers).map((k) => k.toLowerCase());
		expect(keys).not.toContain("authorization");
		expect(keys).not.toContain("x-api-key");
		expect(keys).not.toContain("x-clankermux-account-id");
		expect(keys).not.toContain("x-claude-code-session-id");
		expect(keys).toContain("anthropic-version");
		expect(keys).toContain("content-type");
	});
});

describe("SessionCacheStore — per-slot refresh cadence (1h promotion)", () => {
	it("a non-promoted slot gets the 3-min cadence and is due at 3 min", () => {
		register({ sessionKey: "plain", cacheReadTokens: 150_000 });
		const slot = sessionCacheStore.getAllSlots()[0];
		expect(slot.refreshMs).toBe(KEEPALIVE_REFRESH_MS);

		const base = slot.lastActivityTs;
		// Not due just under 3 min.
		expect(
			sessionCacheStore.getEligibleSessions(base + KEEPALIVE_REFRESH_MS - 1)
				.length,
		).toBe(0);
		// Due at 3 min.
		expect(
			sessionCacheStore.getEligibleSessions(base + KEEPALIVE_REFRESH_MS).length,
		).toBe(1);
	});

	it("a promoted slot gets the ~50-min cadence: NOT due at 3 min, IS due at 50 min", () => {
		promote("hot");
		register({ sessionKey: "hot", cacheReadTokens: 150_000, oneHour: true });
		const slot = sessionCacheStore.getAllSlots()[0];
		expect(slot.refreshMs).toBe(KEEPALIVE_REFRESH_1H_MS);

		const base = slot.lastActivityTs;
		// A promoted slot must NOT fire on the 3-min cadence...
		expect(
			sessionCacheStore.getEligibleSessions(base + KEEPALIVE_REFRESH_MS).length,
		).toBe(0);
		// ...nor just under its own 50-min window...
		expect(
			sessionCacheStore.getEligibleSessions(base + KEEPALIVE_REFRESH_1H_MS - 1)
				.length,
		).toBe(0);
		// ...but IS due at 50 min.
		expect(
			sessionCacheStore.getEligibleSessions(base + KEEPALIVE_REFRESH_1H_MS)
				.length,
		).toBe(1);
	});

	it("an idle-gap promotion also yields the ~50-min cadence", () => {
		const key = "idler";
		const now = Date.now();
		// Two turns separated by > IDLE_GAP_FOR_PROMOTION_MS → promoted on the 2nd.
		sessionPromotionTracker.observeAndShouldInject(key, now, 0, 0);
		sessionPromotionTracker.observeAndShouldInject(
			key,
			now + IDLE_GAP_FOR_PROMOTION_MS,
			0,
			0,
		);
		expect(sessionPromotionTracker.isPromoted(key)).toBe(true);

		register({ sessionKey: key, cacheReadTokens: 150_000, oneHour: true });
		expect(sessionCacheStore.getAllSlots()[0].refreshMs).toBe(
			KEEPALIVE_REFRESH_1H_MS,
		);
	});

	it("the __account__ fallback key is never promoted → 3-min cadence", () => {
		const fallback = "__account__:acc-1";
		// Even after many observes the fallback key is promoted by turn count, BUT
		// the proxy never observes it (synthetic keepalives strip the session key),
		// so in practice it's never in the tracker. Assert the un-observed key.
		expect(sessionPromotionTracker.isPromoted(fallback)).toBe(false);
		register({ sessionKey: fallback, cacheReadTokens: 150_000 });
		expect(sessionCacheStore.getAllSlots()[0].refreshMs).toBe(
			KEEPALIVE_REFRESH_MS,
		);
	});

	it("a promoted slot's spend budget supports multiple hourly hits before exhaustion", () => {
		promote("multi");
		register({ sessionKey: "multi", cacheReadTokens: 100_000, oneHour: true });
		const slot = sessionCacheStore.getAllSlots()[0];
		expect(slot.refreshMs).toBe(KEEPALIVE_REFRESH_1H_MS);

		let hits = 0;
		let now = slot.lastActivityTs + KEEPALIVE_REFRESH_1H_MS;
		// Each iteration: due → record a hit → advance one ~50-min window.
		while (sessionCacheStore.getEligibleSessions(now).length > 0) {
			sessionCacheStore.recordKeepaliveResult("acc-1", "multi", true, now);
			hits++;
			now += KEEPALIVE_REFRESH_1H_MS;
			if (hits > 20) break; // safety
		}
		// With the TRUE 1h write rate (2x input = 10/M for Opus), the budget is
		// (10-0.5)/1e6*100000*0.4 = $0.38 and each hit is $0.05, so ~7-8 hourly
		// refreshes fit → a multi-HOUR bridge (~5h, vs ~3.3h on the 5m write rate).
		expect(hits).toBeGreaterThanOrEqual(6);
		expect(hits).toBeLessThanOrEqual(8);
		// Total wall-clock bridged spans well over the ~3.3h a 5m-rate budget gives.
		const hoursBridged = (hits * KEEPALIVE_REFRESH_1H_MS) / 3_600_000;
		expect(hoursBridged).toBeGreaterThanOrEqual(5);
	});
});

describe("SessionCacheStore — promoted slot uses the true 1h write rate (2x input)", () => {
	// Opus 4.8: input 5, cache_read 0.5, 5m cache_write 6.25. A promoted (1h) slot's
	// real write is 2x input = 10/M, which is LARGER than the 5m cache_write rate.
	it("a promoted slot's budget reflects the 2x write rate and exceeds a 5m slot's", () => {
		// 5-minute (non-promoted) slot.
		register({ sessionKey: "plain", cacheReadTokens: 100_000 });
		const plain = sessionCacheStore.getAllSlots()[0];
		expect(plain.cacheWriteEffectivePer1M).toBe(6.25); // = cacheWritePer1M
		// (6.25 - 0.5)/1e6 * 100000 * 0.4 = $0.23
		expect(plain.budgetUsd).toBeCloseTo(0.23, 10);

		sessionCacheStore.clear();

		// 1h (promoted) slot, same tokens/model.
		promote("hot");
		register({ sessionKey: "hot", cacheReadTokens: 100_000, oneHour: true });
		const hot = sessionCacheStore.getAllSlots()[0];
		// Effective write = inputPer1M (5) * 2 = 10/M, NOT the 5m cache_write 6.25.
		expect(hot.cacheWriteEffectivePer1M).toBe(10);
		expect(hot.cacheWritePer1M).toBe(6.25); // raw 5m rate is still recorded
		// (10 - 0.5)/1e6 * 100000 * 0.4 = $0.38 — larger than the 5m slot's $0.23.
		expect(hot.budgetUsd).toBeCloseTo(0.38, 10);
		expect(hot.budgetUsd).toBeGreaterThan(plain.budgetUsd);
	});

	it("a promoted slot charges a MISS at the 2x rate (not the 5m cache_write rate)", () => {
		promote("missy");
		register({ sessionKey: "missy", cacheReadTokens: 100_000, oneHour: true });
		const now = FUTURE();
		sessionCacheStore.recordKeepaliveResult("acc-1", "missy", false, now);
		const slot = sessionCacheStore.getAllSlots()[0];
		// Miss cost = effective write (10/M) * 100k = $1.00, the true 1h recreate
		// cost (a 5m-rate charge would understate it at 6.25/M = $0.625).
		expect(slot.spentUsd).toBeCloseTo(1.0, 10);
		expect(slot.spentUsd).toBeGreaterThan((6.25 / 1_000_000) * 100_000);
		// One miss still exhausts the budget in one shot.
		expect(slot.spentUsd).toBeGreaterThan(slot.budgetUsd);
	});

	it("a non-promoted slot is unchanged: effective write equals the 5m cache_write rate", () => {
		register({ sessionKey: "plain2", cacheReadTokens: 100_000 });
		const slot = sessionCacheStore.getAllSlots()[0];
		expect(slot.cacheWriteEffectivePer1M).toBe(slot.cacheWritePer1M);
		const now = FUTURE();
		sessionCacheStore.recordKeepaliveResult("acc-1", "plain2", false, now);
		// Miss charged at the 5m rate: 6.25/M * 100k = $0.625 (unchanged behavior).
		expect(sessionCacheStore.getAllSlots()[0].spentUsd).toBeCloseTo(0.625, 10);
	});
});
