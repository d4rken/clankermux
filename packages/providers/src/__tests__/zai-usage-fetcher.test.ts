import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
import { mockFetch } from "@clankermux/test-support";
import type { ZaiUsageData } from "@clankermux/types";
import {
	getRepresentativeUtilizationForProvider,
	usageCache,
} from "../usage-fetcher";
import {
	fetchZaiUsage,
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
	globalThis.fetch = mockFetch(async () =>
		Response.json({ success: true, data: { limits } }),
	);
	return fetchZaiUsage("test-key");
}
/** The parsed windows, or null for any outcome that carries none. */
async function parseLimits(limits: unknown[]): Promise<ZaiUsageData | null> {
	const outcome = await fetchLimits(limits);
	return outcome.status === "ok" ? outcome.data : null;
}
/** Run `body`, returning its value alongside every `log.warn` it emitted. */
async function withWarnings<T>(
	body: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
	const warnings: string[] = [];
	const spy = spyOn(Logger.prototype, "warn").mockImplementation(((
		message: string,
	) => {
		warnings.push(message);
	}) as never);
	try {
		return { result: await body(), warnings };
	} finally {
		spy.mockRestore();
	}
}

describe("Zai token quotas", () => {
	it("keeps duration identities even when the weekly reset is sooner and entries are reversed", async () => {
		for (const limits of [
			[short, weekly],
			[weekly, short],
		]) {
			const data = await parseLimits(limits);
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
		const data = await parseLimits([{ ...weekly, nextResetTime: null }]);
		expect(data?.tokens_limit).toBeNull();
		expect(data?.tokens_limit_weekly?.resetAt).toBeNull();
		expect(getRepresentativeZaiWindow(data)).toBe("seven_day");
	});
	it("supports the legacy single token window without duration metadata", async () => {
		const data = await parseLimits([{ type: "TOKENS_LIMIT", percentage: 50 }]);
		expect(data?.tokens_limit?.percentage).toBe(50);
		expect(data?.tokens_limit_weekly).toBeNull();
	});
	it("rejects ambiguous or unknown token durations instead of inventing five-hour quotas", async () => {
		for (const limits of [
			[{ type: "TOKENS_LIMIT" }, { type: "TOKENS_LIMIT" }],
			[{ ...short, unit: 99 }],
			[short, short],
			[short, weekly, { ...short, unit: 99 }],
		]) {
			expect((await fetchLimits(limits)).status).toBe("failed");
		}
	});
	it("excludes web-tool TIME_LIMIT from model utilization", async () => {
		const data = await parseLimits([
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
		const data = await parseLimits([
			{ ...short, percentage: 100 },
			{ ...weekly, percentage: 100 },
		]);
		expect(getRepresentativeZaiWindow(data)).toBe("five_hour");
		const unknown = await parseLimits([
			{ ...short, percentage: 100 },
			{ ...weekly, percentage: 100, nextResetTime: null },
		]);
		expect(getRepresentativeZaiWindow(unknown)).toBe("seven_day");
	});
});

/**
 * The `lite` plan tier serves both model quotas as `CREDIT_LIMIT`, so a parser
 * matching only `TOKENS_LIMIT` reads an account with two live windows as having
 * none. Payload captured from a live account on 2026-09-15.
 */
describe("Zai renamed quota types", () => {
	const LIVE_LIMITS = [
		{
			type: "CREDIT_LIMIT",
			unit: 3,
			number: 5,
			usage: 2000,
			currentValue: 0,
			remaining: 1999,
			percentage: 1,
			nextResetTime: 1789501206913,
		},
		{
			type: "CREDIT_LIMIT",
			unit: 6,
			number: 1,
			usage: 10000,
			currentValue: 0,
			remaining: 9999,
			percentage: 1,
			nextResetTime: 1790073168979,
		},
	];

	it("reads both windows out of the live CREDIT_LIMIT payload", async () => {
		const data = await parseLimits(LIVE_LIMITS);
		expect(data?.tokens_limit).toMatchObject({
			percentage: 1,
			resetAt: 1789501206913,
			type: "tokens_limit",
		});
		expect(data?.tokens_limit_weekly).toMatchObject({
			percentage: 1,
			resetAt: 1790073168979,
			type: "tokens_limit_weekly",
		});
	});

	it("counts consumption from usage minus remaining, not from currentValue", async () => {
		const data = await parseLimits(LIVE_LIMITS);
		expect(data?.tokens_limit?.used).toBe(1);
		expect(data?.tokens_limit_weekly?.used).toBe(1);
	});

	it("derives used identically for every recognised type alias", async () => {
		const row = {
			unit: 3,
			number: 5,
			usage: 2000,
			currentValue: 0,
			remaining: 1999,
			percentage: 1,
			nextResetTime: 20000,
		};
		for (const type of ["CREDIT_LIMIT", "TOKENS_LIMIT"]) {
			const data = await parseLimits([{ ...row, type }]);
			expect(data?.tokens_limit?.used).toBe(1);
		}
		for (const type of ["MCP_LIMIT", "TIME_LIMIT"]) {
			const data = await parseLimits([{ ...row, type }]);
			expect(data?.time_limit?.used).toBe(1);
		}
	});

	it("falls back to currentValue when the payload carries no usage total", async () => {
		const data = await parseLimits([
			{ ...short, type: "CREDIT_LIMIT", currentValue: 7, remaining: 3 },
		]);
		expect(data?.tokens_limit?.used).toBe(7);
	});

	it("treats MCP_LIMIT as the web-tool quota, outside model utilization", async () => {
		const data = await parseLimits([
			{ ...short, type: "CREDIT_LIMIT" },
			{ ...weekly, type: "CREDIT_LIMIT" },
			{ type: "MCP_LIMIT", percentage: 100 },
		]);
		expect(data?.time_limit?.percentage).toBe(100);
		expect(getRepresentativeZaiUtilization(data)).toBe(90);
	});
});

/**
 * "We asked and there are no windows" and "we asked and could not read the
 * answer" used to collapse into the same all-null reading.
 */
describe("Zai unreadable quota payloads", () => {
	it("names every unmatched type, even beside a window it did read", async () => {
		const { result, warnings } = await withWarnings(() =>
			parseLimits([
				{ ...short, type: "CREDIT_LIMIT" },
				{ type: "SOMETHING_NEW", percentage: 50 },
			]),
		);
		expect(result?.tokens_limit?.percentage).toBe(20);
		expect(warnings.join("\n")).toContain("SOMETHING_NEW");
	});

	it("reports an all-unknown payload as unreadable rather than as no quota", async () => {
		const { result, warnings } = await withWarnings(() =>
			fetchLimits([{ type: "SOMETHING_NEW", percentage: 50 }]),
		);
		expect(result).toEqual({ status: "unrecognized" });
		expect(warnings.join("\n")).toContain("SOMETHING_NEW");
	});

	it("reports an empty limits array as a real reading with no windows", async () => {
		expect(await fetchLimits([])).toEqual({
			status: "ok",
			data: {
				time_limit: null,
				tokens_limit: null,
				tokens_limit_weekly: null,
			},
		});
	});
});

/**
 * A parser gap is not a network failure. Counting one as a failed poll backs the
 * account off toward the 30-minute ceiling, which spaces out the very warning
 * the gap needs to surface and ages the cache entry past its TTL.
 */
describe("Zai unreadable payloads and the poll loop", () => {
	const ACCOUNT_ID = "zai-unreadable";

	afterEach(() => {
		usageCache.stopPolling(ACCOUNT_ID);
		usageCache.delete(ACCOUNT_ID);
	});

	it("counts an unreadable payload as a successful poll that writes no cache entry", async () => {
		globalThis.fetch = mockFetch(async () =>
			Response.json({
				success: true,
				data: { limits: [{ type: "SOMETHING_NEW", percentage: 50 }] },
			}),
		);
		const spy = spyOn(Logger.prototype, "warn").mockImplementation((() => {
			// The unmatched-type warning is what the payload is for; silence it.
		}) as never);
		try {
			usageCache.startPolling(ACCOUNT_ID, "test-key", "zai", 3_600_000);
			expect(await usageCache.refreshNow(ACCOUNT_ID)).toBe(true);
		} finally {
			spy.mockRestore();
		}
		expect(usageCache.peek(ACCOUNT_ID)).toBeNull();
	});
});
