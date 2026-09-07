import { afterEach, describe, expect, it } from "bun:test";
import { getRepresentativeUtilizationForProvider } from "../usage-fetcher";
import {
	fetchZaiUsageData,
	getRepresentativeZaiUtilization,
	getRepresentativeZaiWindow,
} from "../zai-usage-fetcher";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

const short = {
	type: "TOKENS_LIMIT",
	unit: 3,
	number: 5,
	percentage: 20,
	nextResetTime: 20000,
};
const weekly = {
	type: "TOKENS_LIMIT",
	unit: 6,
	number: 1,
	percentage: 90,
	nextResetTime: 10000,
};
async function fetchLimits(limits: unknown[]) {
	globalThis.fetch = (async () =>
		Response.json({ success: true, data: { limits } })) as typeof fetch;
	return fetchZaiUsageData("test-key");
}

describe("Zai token quotas", () => {
	it("keeps duration identities even when the weekly reset is sooner and entries are reversed", async () => {
		for (const limits of [
			[short, weekly],
			[weekly, short],
		]) {
			const data = await fetchLimits(limits);
			expect(data?.tokens_limit).toMatchObject({
				percentage: 20,
				resetAt: 20000,
			});
			expect(data?.tokens_limit_weekly).toMatchObject({
				percentage: 90,
				resetAt: 10000,
			});
			expect(getRepresentativeZaiUtilization(data)).toBe(90);
			expect(getRepresentativeZaiWindow(data)).toBe("seven_day");
		}
	});
	it("identifies weekly-only plans and windows without reset timestamps", async () => {
		const data = await fetchLimits([{ ...weekly, nextResetTime: null }]);
		expect(data?.tokens_limit).toBeNull();
		expect(data?.tokens_limit_weekly?.resetAt).toBeNull();
		expect(getRepresentativeZaiWindow(data)).toBe("seven_day");
	});
	it("supports the legacy single token window without duration metadata", async () => {
		const data = await fetchLimits([{ type: "TOKENS_LIMIT", percentage: 50 }]);
		expect(data?.tokens_limit?.percentage).toBe(50);
		expect(data?.tokens_limit_weekly).toBeNull();
	});
	it("rejects ambiguous or unknown token durations instead of inventing five-hour quotas", async () => {
		expect(
			await fetchLimits([{ type: "TOKENS_LIMIT" }, { type: "TOKENS_LIMIT" }]),
		).toBeNull();
		expect(await fetchLimits([{ ...short, unit: 99 }])).toBeNull();
		expect(await fetchLimits([short, short])).toBeNull();
		expect(
			await fetchLimits([short, weekly, { ...short, unit: 99 }]),
		).toBeNull();
	});
	it("excludes web-tool TIME_LIMIT from model utilization", async () => {
		const data = await fetchLimits([
			short,
			weekly,
			{ type: "TIME_LIMIT", percentage: 100 },
		]);
		expect(data?.time_limit?.percentage).toBe(100);
		expect(getRepresentativeZaiUtilization(data)).toBe(90);
		if (!data) throw new Error("missing Zai quotas");
		expect(getRepresentativeUtilizationForProvider(data, "zai")).toBe(90);
	});
	it("breaks utilization ties by the later reset, preferring an unknown reset conservatively", async () => {
		const data = await fetchLimits([
			{ ...short, percentage: 100 },
			{ ...weekly, percentage: 100 },
		]);
		expect(getRepresentativeZaiWindow(data)).toBe("five_hour");
		const unknown = await fetchLimits([
			{ ...short, percentage: 100 },
			{ ...weekly, percentage: 100, nextResetTime: null },
		]);
		expect(getRepresentativeZaiWindow(unknown)).toBe("seven_day");
	});
});
