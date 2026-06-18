import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getModelCacheRates } from "@clankermux/core";
import {
	DEFAULT_MIN_CACHE_TOKENS,
	KEEPALIVE_REFRESH_MS,
	keepaliveBudgetUsd,
	keepaliveHitCostUsd,
	MAX_SESSION_BODY_BYTES,
	MAX_SESSION_SLOTS,
} from "../bridge-policy";
import { sessionCacheStore } from "../session-cache-store";

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

interface RegisterOpts {
	accountId?: string;
	sessionKey?: string;
	bodyBytes?: number;
	body?: Uint8Array;
	model?: string;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	headers?: Headers;
}

function register(opts: RegisterOpts = {}): void {
	sessionCacheStore.register({
		accountId: opts.accountId ?? "acc-1",
		sessionKey: opts.sessionKey ?? "sess-1",
		body: opts.body ?? body(opts.bodyBytes ?? 1024),
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
	sessionCacheStore.clear();
});

afterEach(() => {
	sessionCacheStore.clear();
	sessionCacheStore.setMinTokens(DEFAULT_MIN_CACHE_TOKENS);
	sessionCacheStore.setEnabled(false);
});

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
