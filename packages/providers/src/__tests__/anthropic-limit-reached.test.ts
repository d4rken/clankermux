// Nothing here reaches the network: every test stubs global fetch.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import { usageCache } from "../usage-fetcher";
import { openUsageReadGapForEachTest } from "./open-usage-read-gap";

openUsageReadGapForEachTest();

const ACCOUNT = "anthropic-limit-reached";
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
	usageCache.stopPolling(ACCOUNT);
	usageCache.delete(ACCOUNT);
	fetchSpy?.mockRestore();
});

const resetsAt = () => new Date(Date.now() + 3_600_000).toISOString();

function reading(
	fiveHour: number,
	sevenDay: number,
	scoped: number | null = null,
) {
	return {
		five_hour: { utilization: fiveHour, resets_at: resetsAt() },
		seven_day: { utilization: sevenDay, resets_at: resetsAt() },
		...(scoped === null
			? {}
			: {
					limits: [
						{
							kind: "weekly",
							group: "model",
							percent: scoped,
							resets_at: resetsAt(),
							scope: { model: { id: "fable", display_name: "Fable" } },
							is_active: true,
						},
					],
				}),
	};
}

/** Polls `readings` in order and returns the reached-limit count after each. */
async function pollSequence(
	provider: string,
	readings: unknown[],
): Promise<number[]> {
	let next = 0;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		mockFetch(async () => Response.json(readings[next++])),
	);
	let reached = 0;
	usageCache.startPolling(
		ACCOUNT,
		"token",
		provider,
		3_600_000,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			initialDelayMs: 3_600_000,
			onAnthropicLimitReached: (accountId) => {
				expect(accountId).toBe(ACCOUNT);
				reached++;
			},
		},
		undefined,
	);
	const counts: number[] = [];
	for (let i = 0; i < readings.length; i++) {
		await usageCache.refreshNow(ACCOUNT);
		counts.push(reached);
	}
	return counts;
}

describe("Anthropic limit-reached notification", () => {
	it("fires once when a window newly reaches its limit, not while it stays there", async () => {
		expect(
			await pollSequence("anthropic", [
				reading(40, 60),
				reading(100, 60),
				reading(100, 60),
				reading(20, 60),
				reading(20, 100),
				reading(100, 100),
			]),
		).toEqual([0, 1, 1, 1, 2, 3]);
	});

	it("fires for a scoped weekly limit reaching 100%", async () => {
		expect(
			await pollSequence("anthropic", [
				reading(10, 50, 90),
				reading(10, 50, 100),
				reading(10, 50, 100),
			]),
		).toEqual([0, 1, 1]);
	});

	it("tells scoped limits without a model id apart by display name, in any order", async () => {
		const scoped = (name: string, percent: number) => ({
			kind: "weekly",
			group: "model",
			percent,
			resets_at: resetsAt(),
			scope: { model: { id: null, display_name: name } },
			is_active: true,
		});
		const withLimits = (...limits: unknown[]) => ({
			...reading(10, 50),
			limits,
		});
		expect(
			await pollSequence("anthropic", [
				withLimits(scoped("Fable", 100), scoped("Opus", 50)),
				withLimits(scoped("Opus", 50), scoped("Fable", 100)),
				withLimits(scoped("Opus", 100), scoped("Fable", 100)),
			]),
		).toEqual([0, 0, 1]);
	});

	it("counts scoped limits with no identity at all, so another one reaching 100% fires", async () => {
		const anonymous = (percent: number) => ({
			kind: "weekly",
			group: "model",
			percent,
			resets_at: resetsAt(),
			scope: null,
			is_active: true,
		});
		const withLimits = (...limits: unknown[]) => ({
			...reading(10, 50),
			limits,
		});
		expect(
			await pollSequence("anthropic", [
				withLimits(anonymous(100), anonymous(50)),
				withLimits(anonymous(50), anonymous(100)),
				withLimits(anonymous(100), anonymous(100)),
			]),
		).toEqual([0, 0, 1]);
	});

	it("does not fire on the first reading, with nothing to compare", async () => {
		expect(await pollSequence("anthropic", [reading(100, 100)])).toEqual([0]);
	});

	it("ignores a non-Anthropic account", async () => {
		expect(
			await pollSequence("qwen", [reading(40, 60), reading(100, 100)]),
		).toEqual([0, 0]);
	});
});
