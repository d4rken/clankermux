import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ACCOUNT_UTILIZATION_SORT_STORAGE_KEY } from "../../lib/account-utilization-sort";
import { AccountUtilizationCard } from "./AccountUtilizationCard";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Restored in afterEach so a patched storage cannot leak into the next test. */
const realGetItem = window.localStorage.getItem;
const realSetItem = window.localStorage.setItem;

function makeAccount(overrides: Partial<AccountResponse>): AccountResponse {
	return {
		id: "acct",
		name: "acct",
		provider: "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: "2026-01-01T00:00:00Z",
		paused: false,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "",
		priority: 0,
		autoFallbackEnabled: false,
		autoRefreshEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		staleUsage: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		// No refresh token: OAuthTokenStatus then short-circuits instead of firing
		// a token-health fetch from the test process.
		hasRefreshToken: false,
		notes: null,
		sessionStats: null,
		isPrimary: false,
		...overrides,
	} as AccountResponse;
}

/** Anthropic-shaped live reading at the given 5-hour utilization. */
function usageAt(pct: number, resetOffsetMs = 3 * HOUR) {
	return {
		five_hour: {
			utilization: pct,
			resets_at: new Date(NOW + resetOffsetMs).toISOString(),
		},
		seven_day: { utilization: 1, resets_at: null },
	};
}

const ZULU = makeAccount({
	id: "a-zulu",
	name: "zulu",
	usageData: usageAt(90),
});
const ALPHA = makeAccount({
	id: "a-alpha",
	name: "alpha",
	usageData: usageAt(10),
});
const MIKE = makeAccount({
	id: "a-mike",
	name: "mike",
	usageData: usageAt(50),
});
const ACCOUNTS = [ALPHA, MIKE, ZULU];
const FIXTURE_NAMES = new Set(["zulu", "alpha", "mike", "stale-only"]);

async function mount(
	props: Partial<Parameters<typeof AccountUtilizationCard>[0]> = {},
) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<AccountUtilizationCard accounts={ACCOUNTS} now={NOW} {...props} />,
		);
	});
}

/** The account-name spans in document order — i.e. the rendered row order. */
function renderedOrder(): string[] {
	return Array.from(host?.querySelectorAll<HTMLElement>("span[title]") ?? [])
		.map((span) => span.getAttribute("title") ?? "")
		.filter((title) => FIXTURE_NAMES.has(title));
}

function sortTrigger(): HTMLElement | null {
	return document.querySelector<HTMLElement>("#account-utilization-sort");
}

async function chooseSortOption(label: string) {
	await act(async () => sortTrigger()?.click());
	const option = Array.from(
		document.querySelectorAll<HTMLElement>('[role="option"]'),
	).find((item) => item.textContent?.includes(label));
	expect(option).toBeDefined();
	await act(async () => option?.click());
}

beforeEach(() => {
	window.localStorage.getItem = realGetItem;
	window.localStorage.setItem = realSetItem;
	window.localStorage.removeItem(ACCOUNT_UTILIZATION_SORT_STORAGE_KEY);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	window.localStorage.getItem = realGetItem;
	window.localStorage.setItem = realSetItem;
	window.localStorage.removeItem(ACCOUNT_UTILIZATION_SORT_STORAGE_KEY);
});

describe("AccountUtilizationCard sort control", () => {
	it("defaults to utilization high to low", async () => {
		await mount();
		expect(renderedOrder()).toEqual(["zulu", "mike", "alpha"]);
		expect(sortTrigger()).not.toBeNull();
	});

	it("reorders the rows when a different mode is chosen", async () => {
		await mount();
		await chooseSortOption("Name (A-Z)");
		expect(renderedOrder()).toEqual(["alpha", "mike", "zulu"]);
	});

	it("persists the chosen mode to localStorage", async () => {
		await mount();
		await chooseSortOption("Name (A-Z)");
		expect(
			window.localStorage.getItem(ACCOUNT_UTILIZATION_SORT_STORAGE_KEY),
		).toBe("name");
	});

	it("honours a pre-seeded preference on mount", async () => {
		window.localStorage.setItem(
			ACCOUNT_UTILIZATION_SORT_STORAGE_KEY,
			"utilization-asc",
		);
		await mount();
		expect(renderedOrder()).toEqual(["alpha", "mike", "zulu"]);
	});

	it("falls back to the default order when reading storage throws", async () => {
		window.localStorage.getItem = () => {
			throw new Error("SecurityError");
		};
		await mount();
		expect(renderedOrder()).toEqual(["zulu", "mike", "alpha"]);
	});

	it("still re-sorts in memory when writing storage throws", async () => {
		window.localStorage.setItem = () => {
			throw new Error("QuotaExceededError");
		};
		await mount();
		await chooseSortOption("Name (A-Z)");
		expect(renderedOrder()).toEqual(["alpha", "mike", "zulu"]);
	});
});

describe("AccountUtilizationCard sort control visibility", () => {
	it("is absent while the first accounts read is in flight", async () => {
		await mount({ loading: true });
		expect(sortTrigger()).toBeNull();
	});

	it("is absent when the accounts read failed", async () => {
		await mount({ unavailableReason: "Accounts unavailable" });
		expect(sortTrigger()).toBeNull();
		expect(host?.textContent).toContain("Accounts unavailable");
	});

	it("is absent on the empty state", async () => {
		await mount({ accounts: [] });
		expect(sortTrigger()).toBeNull();
		expect(host?.textContent).toContain("No windowed accounts reporting usage");
	});

	it("is absent with a single row", async () => {
		await mount({ accounts: [MIKE] });
		expect(sortTrigger()).toBeNull();
		expect(renderedOrder()).toEqual(["mike"]);
	});
});

describe("AccountUtilizationCard row filter", () => {
	it("renders an account whose only reading is a stale snapshot", async () => {
		const staleOnly = makeAccount({
			id: "a-stale",
			name: "stale-only",
			staleUsage: {
				fiveHour: {
					utilization: 40,
					resetIso: new Date(NOW + HOUR).toISOString(),
				},
				sevenDay: {
					utilization: 55,
					resetIso: new Date(NOW + 20 * HOUR).toISOString(),
				},
				asOfIso: new Date(NOW - 2 * HOUR).toISOString(),
			},
		});
		await mount({ accounts: [MIKE, staleOnly] });
		expect(renderedOrder()).toContain("stale-only");
		expect(host?.textContent).toContain("last known as of");
	});
});
