/**
 * Unit tests for the codex credits-aware auto-resume guard
 * (AutoRefreshScheduler.shouldResumeFromOverage).
 *
 * A codex account auto-paused for "overage" is actually spending paid credits
 * because its WEEKLY (seven_day) window hit 100%. Codex returns HTTP 200 while
 * on credits, so the auto-refresh success path fires on every ~5h probe.
 * Resuming on a 5h reset would immediately re-pause on the next request
 * (flapping), and each probe spends credits. The guard consults the
 * usageCache.codexCredits state (populated by the probe's own dispatch via
 * response-processor) and only permits a resume once the account is no longer
 * on credits.
 *
 * The guard is a private method; we reach it via cast. usageCache is the real
 * singleton, seeded with usageCache.set(...) and cleaned up after each test.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { CodexCreditsInfo, UsageData } from "@clankermux/providers";
import { usageCache } from "@clankermux/providers";

const seededIds = new Set<string>();

afterEach(() => {
	for (const id of seededIds) usageCache.delete(id);
	seededIds.clear();
});

function seedCredits(
	accountId: string,
	credits: CodexCreditsInfo | null,
): void {
	seededIds.add(accountId);
	const data = {
		five_hour: { utilization: 0, resets_at: null },
		seven_day: { utilization: 100, resets_at: null },
		codexCredits: credits,
	} as unknown as UsageData;
	usageCache.set(accountId, data);
}

function onCredits(weeklyUsedPct: number): CodexCreditsInfo {
	return {
		hasCredits: true,
		balance: 12.5,
		unlimited: false,
		planType: "plus",
		weeklyUsedPct,
	};
}

async function makeScheduler() {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	// Minimal stubs — shouldResumeFromOverage only touches usageCache.
	const db = {} as never;
	const ctx = { runtime: { clientId: "test" }, refreshInFlight: new Map() };
	return new AutoRefreshScheduler(db, ctx as never) as never as {
		shouldResumeFromOverage(account: {
			id: string;
			provider: string;
			pause_reason: string | null;
		}): boolean;
	};
}

describe("AutoRefreshScheduler — codex credits resume guard", () => {
	it("always allows resume for non-codex providers", async () => {
		const s = await makeScheduler();
		expect(
			s.shouldResumeFromOverage({
				id: "a",
				provider: "anthropic",
				pause_reason: "overage",
			}),
		).toBe(true);
	});

	it("allows resume for codex when not on credits (no cache entry)", async () => {
		const s = await makeScheduler();
		expect(
			s.shouldResumeFromOverage({
				id: "no-cache",
				provider: "codex",
				pause_reason: "overage",
			}),
		).toBe(true);
	});

	it("allows resume for codex when credits info is present but below weekly limit", async () => {
		const s = await makeScheduler();
		seedCredits("below", onCredits(42));
		expect(
			s.shouldResumeFromOverage({
				id: "below",
				provider: "codex",
				pause_reason: "overage",
			}),
		).toBe(true);
	});

	it("BLOCKS resume for codex still on credits past the weekly limit", async () => {
		const s = await makeScheduler();
		seedCredits("on-credits", onCredits(100));
		expect(
			s.shouldResumeFromOverage({
				id: "on-credits",
				provider: "codex",
				pause_reason: "overage",
			}),
		).toBe(false);
	});

	it("allows resume for codex with a non-overage pause reason regardless of credits", async () => {
		const s = await makeScheduler();
		seedCredits("manual", onCredits(100));
		expect(
			s.shouldResumeFromOverage({
				id: "manual",
				provider: "codex",
				pause_reason: "manual",
			}),
		).toBe(true);
	});
});
