import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	refreshAnthropicBankedResetsSpaced,
	registerAnthropicBankedResetRefresher,
	resetAnthropicBankedResetSweepForTests,
	unregisterAnthropicBankedResetRefresher,
} from "../handlers/token-manager";

const REFRESHER_ID = "banked-reset-sweep-test";
let reads: Array<[string, number]> = [];

beforeEach(() => {
	resetAnthropicBankedResetSweepForTests();
	reads = [];
	registerAnthropicBankedResetRefresher(REFRESHER_ID, async (id) => {
		reads.push([id, performance.now()]);
		return { success: true, message: "ok" };
	});
});

afterEach(() => {
	unregisterAnthropicBankedResetRefresher(REFRESHER_ID);
});

describe("refreshAnthropicBankedResetsSpaced", () => {
	it("reads the first account at once and the rest one at a time, spaced", async () => {
		const sweep = refreshAnthropicBankedResetsSpaced(["a", "b", "c"], 30);
		expect(reads.map(([id]) => id)).toEqual(["a"]);
		await sweep;
		expect(reads.map(([id]) => id)).toEqual(["a", "b", "c"]);
		for (let i = 1; i < reads.length; i++)
			expect(reads[i][1] - reads[i - 1][1]).toBeGreaterThanOrEqual(25);
	});

	it("folds a second caller into the running sweep without reading an id twice", async () => {
		const first = refreshAnthropicBankedResetsSpaced(["a", "b"], 30);
		const second = refreshAnthropicBankedResetsSpaced(["b", "c"], 30);
		expect(second).toBe(first);
		await first;
		expect(reads.map(([id]) => id)).toEqual(["a", "b", "c"]);
	});

	it("keeps the spacing for an id queued just after the queue ran dry", async () => {
		const sweep = refreshAnthropicBankedResetsSpaced(["a"], 30);
		// "a" was already taken off the queue, so "b" arrives at an empty one.
		void refreshAnthropicBankedResetsSpaced(["b"], 30);
		await sweep;
		expect(reads.map(([id]) => id)).toEqual(["a", "b"]);
		expect(reads[1][1] - reads[0][1]).toBeGreaterThanOrEqual(25);
	});

	it("a call with nothing stale leaves later calls free to start", async () => {
		await refreshAnthropicBankedResetsSpaced([], 30);
		await refreshAnthropicBankedResetsSpaced(["a"], 30);
		expect(reads.map(([id]) => id)).toEqual(["a"]);
	});

	it("starts a fresh sweep once the previous one has drained", async () => {
		await refreshAnthropicBankedResetsSpaced(["a"], 30);
		await refreshAnthropicBankedResetsSpaced(["b"], 30);
		expect(reads.map(([id]) => id)).toEqual(["a", "b"]);
	});
});
