// Nothing here reaches the network: every test stubs global fetch.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import { usageCache } from "../usage-fetcher";

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

	it("does not fire on the first reading, with nothing to compare", async () => {
		expect(await pollSequence("anthropic", [reading(100, 100)])).toEqual([0]);
	});

	it("ignores a non-Anthropic account", async () => {
		expect(
			await pollSequence("qwen", [reading(40, 60), reading(100, 100)]),
		).toEqual([0, 0]);
	});
});
