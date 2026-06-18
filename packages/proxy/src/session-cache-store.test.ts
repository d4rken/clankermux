import { beforeEach, describe, expect, it } from "bun:test";
import { KEEPALIVE_REFRESH_1H_MS } from "./bridge-policy";
import { bridgeStats } from "./bridge-stats";
import { sessionCacheStore } from "./session-cache-store";
import { sessionPromotionTracker } from "./session-promotion";

function register(
	accountId: string,
	sessionKey: string,
	cachedTokens: number,
	oneHour = false,
	model = "claude-sonnet-4-5-20250929",
): void {
	// A slot's TTL is read from the body's cache_control: ttl:"1h" → 1h slot,
	// otherwise the 5m default (this mirrors what the proxy actually wrote upstream).
	const cache_control = oneHour
		? { type: "ephemeral", ttl: "1h" }
		: { type: "ephemeral" };
	const body = {
		model,
		system: [{ type: "text", text: "sys", cache_control }],
	};
	sessionCacheStore.register({
		accountId,
		sessionKey,
		body: new TextEncoder().encode(JSON.stringify(body)),
		headers: new Headers({ "content-type": "application/json" }),
		path: "/v1/messages",
		model,
		cacheReadTokens: cachedTokens,
		cacheCreationTokens: 0,
	});
}

// Models a real resume turn: it READS the warm prefix (cacheReadTokens) AND appends
// a new breakpoint (cacheCreationTokens) — the common shape onSummary routes through
// register(). `bodyText` lets a test inflate the body past the per-body size cap.
function registerTurn(
	accountId: string,
	sessionKey: string,
	readTokens: number,
	creationTokens: number,
	bodyText = "sys",
): void {
	const body = {
		model: "claude-sonnet-4-5-20250929",
		system: [
			{ type: "text", text: bodyText, cache_control: { type: "ephemeral" } },
		],
	};
	sessionCacheStore.register({
		accountId,
		sessionKey,
		body: new TextEncoder().encode(JSON.stringify(body)),
		headers: new Headers({ "content-type": "application/json" }),
		path: "/v1/messages",
		model: "claude-sonnet-4-5-20250929",
		cacheReadTokens: readTokens,
		cacheCreationTokens: creationTokens,
	});
}

describe("sessionCacheStore telemetry", () => {
	beforeEach(() => {
		sessionCacheStore.setEnabled(false);
		sessionPromotionTracker.setMode("off");
		sessionCacheStore.setEnabled(true);
		sessionCacheStore.setMinTokens(100_000);
		bridgeStats.reset();
	});

	it("recordKeepaliveResult increments keepaliveCount and bridgeStats", () => {
		register("acc1", "sess1", 200_000);
		const now = Date.now();

		sessionCacheStore.recordKeepaliveResult("acc1", "sess1", true, now);
		sessionCacheStore.recordKeepaliveResult("acc1", "sess1", true, now + 1);

		const slot = sessionCacheStore
			.getAllSlots()
			.find((s) => s.sessionKey === "sess1");
		expect(slot?.keepaliveCount).toBe(2);

		const s = bridgeStats.snapshot();
		expect(s.keepalivesSent).toBe(2);
		expect(s.hits).toBe(2);
		expect(s.spentUsd).toBeGreaterThan(0);
	});

	it("touchActivity on a slot with spentUsd>0 records a warm resume and resets keepaliveCount", () => {
		register("acc1", "sess2", 200_000);
		const now = Date.now();
		sessionCacheStore.recordKeepaliveResult("acc1", "sess2", true, now);

		const before = sessionCacheStore
			.getAllSlots()
			.find((s) => s.sessionKey === "sess2");
		expect(before?.keepaliveCount).toBe(1);
		expect((before?.spentUsd ?? 0) > 0).toBe(true);
		const expectedSaved = before?.priorityUsd ?? 0;

		bridgeStats.reset();
		sessionCacheStore.touchActivity("acc1", "sess2", now + 5);

		const s = bridgeStats.snapshot();
		expect(s.warmResumes).toBe(1);
		expect(s.savedUsd).toBeCloseTo(expectedSaved, 10);

		const after = sessionCacheStore
			.getAllSlots()
			.find((s) => s.sessionKey === "sess2");
		expect(after?.spentUsd).toBe(0);
		expect(after?.keepaliveCount).toBe(0);
		expect(after?.lastKeepaliveTs).toBeNull();
	});

	it("touchActivity with no prior spend does not record a warm resume", () => {
		register("acc1", "sess3", 200_000);
		bridgeStats.reset();
		sessionCacheStore.touchActivity("acc1", "sess3", Date.now());
		expect(bridgeStats.snapshot().warmResumes).toBe(0);
	});

	it("recordKeepaliveFailure increments bridgeStats failures", () => {
		register("acc1", "sess4", 200_000);
		bridgeStats.reset();
		sessionCacheStore.recordKeepaliveFailure("acc1", "sess4", Date.now());
		expect(bridgeStats.snapshot().failures).toBe(1);
	});

	it("getPromotedSessions counts only 1h-refresh slots", () => {
		// 5m slot: body carries no ttl:1h → default 5-minute cadence.
		register("acc1", "sessA", 200_000);
		// 1h slot: body carries ttl:"1h" (what the proxy injects when promoting) →
		// register reads that and uses the ~50-min cadence.
		register("acc1", "sessB", 200_000, true);

		const promoted = sessionCacheStore.getPromotedSessions();
		const slotB = sessionCacheStore
			.getAllSlots()
			.find((s) => s.sessionKey === "sessB");
		expect(slotB?.refreshMs).toBe(KEEPALIVE_REFRESH_1H_MS);
		expect(promoted).toBe(1);
	});

	it("recordKeepaliveResult drops a stale result when lastActivityTs changed", () => {
		register("acc1", "sessStale", 200_000);
		const slot = sessionCacheStore
			.getAllSlots()
			.find((s) => s.sessionKey === "sessStale");
		const dispatchedTs = slot?.lastActivityTs ?? 0;

		// A real request resumes the session mid-flight (bumps lastActivityTs, resets).
		sessionCacheStore.touchActivity("acc1", "sessStale", dispatchedTs + 5);
		bridgeStats.reset();

		// The in-flight keepalive's outcome now references the OLD activity stamp →
		// it must be dropped rather than charged against the fresh idle period.
		sessionCacheStore.recordKeepaliveResult(
			"acc1",
			"sessStale",
			false,
			dispatchedTs + 6,
			dispatchedTs,
		);

		const after = sessionCacheStore
			.getAllSlots()
			.find((s) => s.sessionKey === "sessStale");
		expect(after?.spentUsd).toBe(0);
		expect(bridgeStats.snapshot().misses).toBe(0);
		expect(bridgeStats.snapshot().keepalivesSent).toBe(0);
	});

	it("setMinTokens prunes slots that no longer clear a raised threshold", () => {
		register("acc1", "sessLow", 150_000);
		register("acc1", "sessHigh", 250_000);
		expect(sessionCacheStore.getSize()).toBe(2);

		sessionCacheStore.setMinTokens(200_000);

		expect(
			sessionCacheStore.getAllSlots().find((s) => s.sessionKey === "sessLow"),
		).toBeUndefined();
		expect(
			sessionCacheStore.getAllSlots().find((s) => s.sessionKey === "sessHigh"),
		).toBeDefined();
	});

	it("a 1h slot's warm-resume saved uses the higher effective (2x) write rate", () => {
		register("acc1", "sess1h", 200_000, true);
		const now = Date.now();
		sessionCacheStore.recordKeepaliveResult("acc1", "sess1h", true, now);
		const slot = sessionCacheStore
			.getAllSlots()
			.find((s) => s.sessionKey === "sess1h");
		const expectedSaved =
			(((slot?.cacheWriteEffectivePer1M ?? 0) - (slot?.cacheReadPer1M ?? 0)) /
				1_000_000) *
			(slot?.cachedTokens ?? 0);

		bridgeStats.reset();
		sessionCacheStore.touchActivity("acc1", "sess1h", now + 5);

		const s = bridgeStats.snapshot();
		expect(s.warmResumes).toBe(1);
		expect(s.savedUsd).toBeCloseTo(expectedSaved, 10);
		// The 1h effective rate (2x input) exceeds the 5m-rate LRU priority.
		expect(s.savedUsd).toBeGreaterThan(slot?.priorityUsd ?? 0);
	});

	it("register books a warm resume on the common read+create resume after keepalive spend", () => {
		register("acc1", "resume1", 200_000);
		const now = Date.now();
		sessionCacheStore.recordKeepaliveResult("acc1", "resume1", true, now);
		const before = sessionCacheStore
			.getAllSlots()
			.find((s) => s.sessionKey === "resume1");
		expect((before?.spentUsd ?? 0) > 0).toBe(true);

		bridgeStats.reset();
		// Real resume turn: reads the warm prefix AND appends a small new breakpoint.
		registerTurn("acc1", "resume1", 200_000, 5_000);

		const s = bridgeStats.snapshot();
		expect(s.warmResumes).toBe(1);
		expect(s.savedUsd).toBeGreaterThan(0);
		// The slot was replaced fresh, so the spend budget reset for the next gap.
		const after = sessionCacheStore
			.getAllSlots()
			.find((s) => s.sessionKey === "resume1");
		expect(after?.spentUsd).toBe(0);
	});

	it("register does not book a warm resume without prior keepalive spend", () => {
		register("acc1", "noresume", 200_000);
		bridgeStats.reset();
		// A normal active turn (read+create) that never went idle / never cost us.
		registerTurn("acc1", "noresume", 200_000, 5_000);
		expect(bridgeStats.snapshot().warmResumes).toBe(0);
	});

	it("register does not book a warm resume on a pure-creation turn (no read)", () => {
		register("acc1", "create1", 200_000);
		const now = Date.now();
		sessionCacheStore.recordKeepaliveResult("acc1", "create1", true, now);
		bridgeStats.reset();
		// cacheReadTokens=0 → nothing was read warm → no win.
		registerTurn("acc1", "create1", 0, 200_000);
		expect(bridgeStats.snapshot().warmResumes).toBe(0);
	});

	it("register books the resume win even when the new (grown) body is rejected by the size cap", () => {
		register("acc1", "big1", 200_000);
		const now = Date.now();
		sessionCacheStore.recordKeepaliveResult("acc1", "big1", true, now);
		expect(
			(sessionCacheStore.getAllSlots().find((s) => s.sessionKey === "big1")
				?.spentUsd ?? 0) > 0,
		).toBe(true);

		bridgeStats.reset();
		// Resume reads the warm prefix, but its new body exceeds MAX_SESSION_BODY_BYTES
		// (2 MiB) so it can't keep bridging — the WIN already happened regardless.
		registerTurn("acc1", "big1", 200_000, 5_000, "x".repeat(2_200_000));

		expect(bridgeStats.snapshot().warmResumes).toBe(1);
		// Oversized body was not stored — the slot is dropped.
		expect(
			sessionCacheStore.getAllSlots().find((s) => s.sessionKey === "big1"),
		).toBeUndefined();
	});

	it("warm-resume valuation caps read tokens at the slot's stored cachedTokens", () => {
		register("acc1", "cap1", 200_000);
		const now = Date.now();
		sessionCacheStore.recordKeepaliveResult("acc1", "cap1", true, now);
		const slot = sessionCacheStore
			.getAllSlots()
			.find((s) => s.sessionKey === "cap1");
		// Capped at the stored prefix (200k), NOT the inflated 500k read count.
		const expectedSaved =
			(((slot?.cacheWriteEffectivePer1M ?? 0) - (slot?.cacheReadPer1M ?? 0)) /
				1_000_000) *
			200_000;

		bridgeStats.reset();
		sessionCacheStore.touchActivity("acc1", "cap1", now + 5, 500_000);

		const s = bridgeStats.snapshot();
		expect(s.warmResumes).toBe(1);
		expect(s.savedUsd).toBeCloseTo(expectedSaved, 10);
	});

	it("register books the resume win even when the resume turn is dropped by the min-token gate", () => {
		register("acc1", "min1", 200_000);
		const now = Date.now();
		sessionCacheStore.recordKeepaliveResult("acc1", "min1", true, now);
		expect(
			(sessionCacheStore.getAllSlots().find((s) => s.sessionKey === "min1")
				?.spentUsd ?? 0) > 0,
		).toBe(true);

		bridgeStats.reset();
		// Resume re-reads a (partial) warm prefix, but this turn's total tokens
		// (50k + 5k) fall below the 100k min → the slot is dropped. The WIN already
		// happened on the read, so it must still be booked (before the gate).
		registerTurn("acc1", "min1", 50_000, 5_000);

		expect(bridgeStats.snapshot().warmResumes).toBe(1);
		expect(
			sessionCacheStore.getAllSlots().find((s) => s.sessionKey === "min1"),
		).toBeUndefined();
	});
});
