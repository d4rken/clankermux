import { afterEach, beforeEach, spyOn } from "bun:test";
import { usageCache } from "../usage-fetcher";

/**
 * Grant every Anthropic usage read in this file. For suites that exercise the
 * poll loop itself with several reads of one account; the per-account read
 * gap has its own suite in usage-read-gap.test.ts.
 */
export function openUsageReadGapForEachTest(): void {
	let spy: ReturnType<typeof spyOn> | null = null;
	beforeEach(() => {
		spy = spyOn(usageCache, "tryAcquireAnthropicUsageRead").mockImplementation(
			() => ({ slot: { commit() {}, cancel() {} } }),
		);
	});
	afterEach(() => {
		spy?.mockRestore();
		spy = null;
	});
}
