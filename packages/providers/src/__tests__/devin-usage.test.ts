import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { DevinUsageData } from "@clankermux/types";
import {
	DevinSessionAuthenticationError,
	devinClient,
} from "../providers/devin/client";
import { DevinRpcError } from "../providers/devin/connect";
import {
	extractWindowResetTime,
	getAccountCapacitySignal,
	getRepresentativeDevinWindow,
	getRepresentativeUtilizationForProvider,
	usageCache,
} from "../usage-fetcher";

const now = Date.now();
const usage: DevinUsageData = {
	kind: "devin",
	quotaBased: true,
	daily: { utilization: 70, resetAt: now + 86_400_000 },
	weekly: { utilization: 30, resetAt: now + 604_800_000 },
	planName: "Pro",
	email: null,
	accountId: null,
	canUseCli: true,
	overageBalanceUsd: 10,
	includedCreditsRemaining: null,
};
const accountId = "devin-usage-test";
let getAccountSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
	usageCache.stopPolling(accountId);
	usageCache.delete(accountId);
	getAccountSpy?.mockRestore();
	getAccountSpy = null;
});

describe("Devin confirmed authentication failures", () => {
	it("notifies only confirmed session rejection, not entitlement or transient failures", async () => {
		for (const error of [
			new DevinSessionAuthenticationError(),
			new DevinRpcError("permission_denied", "denied"),
			new Error("network unavailable"),
		]) {
			let called = 0;
			getAccountSpy = spyOn(devinClient, "getAccount").mockRejectedValue(error);
			usageCache.startPolling(
				accountId,
				"session",
				"devin",
				3_600_000,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					onAuthenticationFailure: (token, isCurrent) => {
						expect(token).toBe("session");
						expect(isCurrent()).toBe(true);
						called++;
					},
				},
			);
			await usageCache.refreshNow(accountId);
			expect(called).toBe(
				error instanceof DevinSessionAuthenticationError ? 1 : 0,
			);
			usageCache.stopPolling(accountId);
			getAccountSpy.mockRestore();
		}
	});
	it("does not apply a rejected old credential result to a replacement generation", async () => {
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let rejected = 0;
		getAccountSpy = spyOn(devinClient, "getAccount").mockImplementation(
			async (token) => {
				if (token === "old") {
					entered();
					await gate;
					throw new DevinSessionAuthenticationError();
				}
				return {
					userJwt: "jwt",
					endpoint: "https://server.codeium.com",
					models: [],
					usage,
				};
			},
		);
		usageCache.startPolling(
			accountId,
			"old",
			"devin",
			3_600_000,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				onAuthenticationFailure: () => {
					rejected++;
				},
			},
		);
		await started;
		usageCache.startPolling(accountId, "new", "devin", 3_600_000);
		await usageCache.refreshNow(accountId);
		release();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(rejected).toBe(0);
	});
});

describe("Devin calendar quota", () => {
	it("ranks the daily hard constraint without inventing a five-hour session", () => {
		expect(getRepresentativeDevinWindow(usage)).toBe("daily");
		expect(getRepresentativeUtilizationForProvider(usage, "devin")).toBe(70);
		expect(extractWindowResetTime(usage, "devin")).toBe(usage.daily?.resetAt);
		expect(getAccountCapacitySignal(usage, "devin", now)).toEqual({
			minHeadroom: 30,
			sessionHeadroom: 100,
			soonestResetMs: usage.daily?.resetAt,
			bindingUtilization: 70,
			weeklyResetMs: usage.weekly?.resetAt,
			bindingWeeklyResetMs: usage.weekly?.resetAt,
			weeklyHeadroom: 70,
			sessionResetMs: null,
			extraUsageUtilization: null,
		});
	});
	it("supports Max weekly-only quota and excludes prepaid credit balances from headroom", () => {
		const max = {
			...usage,
			daily: null,
			weekly: { utilization: 100, resetAt: now + 604_800_000 },
		};
		expect(getRepresentativeDevinWindow(max)).toBe("weekly");
		expect(getAccountCapacitySignal(max, "devin", now)?.minHeadroom).toBe(0);
	});
	it("treats missing, invalid, and elapsed-window data as unknown", () => {
		expect(
			getRepresentativeUtilizationForProvider(
				{ ...usage, daily: null, weekly: null },
				"devin",
			),
		).toBeNull();
		expect(
			getAccountCapacitySignal(
				{ ...usage, daily: { utilization: 100, resetAt: now } },
				"devin",
				now,
			),
		).toBeNull();
		expect(
			getRepresentativeUtilizationForProvider(
				{
					...usage,
					daily: { utilization: Number.NaN, resetAt: null },
					weekly: null,
				},
				"devin",
			),
		).toBeNull();
	});
	it("compares like windows when detecting quota resets", () => {
		usageCache.set(accountId, {
			...usage,
			daily: { utilization: 90, resetAt: now - 1 },
		});
		let resets = 0;
		usageCache.notifyWindowReset(
			accountId,
			{
				...usage,
				daily: { utilization: 10, resetAt: now - 1 },
				weekly: { utilization: 95, resetAt: now + 604_800_000 },
			},
			"devin",
			() => resets++,
			now,
		);
		expect(resets).toBe(0);
		usageCache.notifyWindowReset(
			accountId,
			usage,
			"devin",
			() => resets++,
			now,
		);
		expect(resets).toBe(1);
	});
	it("polls with fresh credentials and rejects results from replaced generations", async () => {
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		getAccountSpy = spyOn(devinClient, "getAccount").mockImplementation(
			async (token) => {
				if (token === "old") {
					entered();
					await gate;
				}
				return {
					userJwt: "private",
					endpoint: "https://server.codeium.com",
					models: [],
					usage: { ...usage, planName: token },
				};
			},
		);
		usageCache.startPolling(accountId, "old", "devin", 3_600_000);
		await started;
		usageCache.startPolling(
			accountId,
			"new",
			"devin",
			3_600_000,
			"http://localhost:4321",
		);
		await usageCache.refreshNow(accountId);
		release();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect((usageCache.get(accountId) as DevinUsageData).planName).toBe("new");
		expect(getAccountSpy).toHaveBeenCalledWith("new", "http://localhost:4321");
	});
});

describe("Devin metadata callback isolation", () => {
	function start(
		token: string,
		callback: (
			data: DevinUsageData,
			token: string,
			isCurrent: () => boolean,
		) => Promise<void>,
	) {
		usageCache.startPolling(
			accountId,
			token,
			"devin",
			3_600_000,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			callback,
		);
	}
	function metadata() {
		getAccountSpy = spyOn(devinClient, "getAccount").mockImplementation(
			async (token) => ({
				userJwt: "private",
				endpoint: "https://server.codeium.com",
				models: [],
				usage: { ...usage, planName: token },
			}),
		);
	}
	it("preserves a successful usage read when metadata persistence rejects", async () => {
		metadata();
		let calls = 0;
		start("new", async (data, token, isCurrent) => {
			calls++;
			expect(data.planName).toBe("new");
			expect(token).toBe("new");
			expect(isCurrent()).toBe(true);
			throw new Error("database busy");
		});
		expect(await usageCache.refreshNow(accountId)).toBe(true);
		expect(calls).toBeGreaterThan(0);
		expect((usageCache.get(accountId) as DevinUsageData).planName).toBe("new");
	});
	it("rechecks generation after an asynchronous metadata callback", async () => {
		metadata();
		let entered!: () => void;
		let release!: () => void;
		let isOldCurrent!: () => boolean;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		start("old", async (_data, _token, isCurrent) => {
			isOldCurrent = isCurrent;
			entered();
			await gate;
		});
		await started;
		start("new", async () => {});
		await usageCache.refreshNow(accountId);
		expect(isOldCurrent()).toBe(false);
		release();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect((usageCache.get(accountId) as DevinUsageData).planName).toBe("new");
	});
});
