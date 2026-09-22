import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { CapacityRestoredEvidence } from "@clankermux/providers";
import { usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import {
	startUsagePollingFor,
	type UsagePollingStarters,
} from "./usage-polling-dispatch";

/**
 * The dispatcher is the single answer to "how is polling started for provider
 * X". Boot and the runtime restarter both go through it, so these pin the
 * per-provider differences that used to live in two places and drift: which
 * providers are started at all, which one gets the session-reset callback,
 * which one gets the capacity-restored callback, and that the API-key path
 * re-reads the stored key instead of capturing it.
 */

/** One report, shaped as an account-wide poll reports it. */
const evidence = (accountId: string): CapacityRestoredEvidence => ({
	accountId,
	utilization: 20,
	extraUsageUtilization: null,
	fetchStartedAt: 1_700_000_000_000,
	observedWindows: [],
});

const account = (patch: Partial<Account>): Account =>
	({
		id: "acc",
		name: "Acc",
		provider: "zai",
		api_key: "key",
		...patch,
	}) as Account;

let started: {
	accountId: string;
	provider?: string;
	onWindowReset?: (accountId: string) => void;
	onCapacityRestored?: (evidence: CapacityRestoredEvidence) => void;
	tokenProvider: () => Promise<string>;
}[] = [];
let anthropicStarts: { id: string; delay: number }[] = [];
let devinStarts: string[] = [];
let tokenProviderFor: string[] = [];
let sessionResets: string[] = [];
let capacityReports: string[] = [];
let keys: Record<string, string | null> = {};
let realStartPolling: typeof usageCache.startPolling;
let realStopPolling: typeof usageCache.stopPolling;
let stopped: string[] = [];

const starters = (): UsagePollingStarters => ({
	startAnthropic: (a, delay) => anthropicStarts.push({ id: a.id, delay }),
	startDevin: (a) => {
		devinStarts.push(a.id);
		return true;
	},
	createTokenProvider: (a) => async () => {
		tokenProviderFor.push(a.id);
		return `token-for-${a.id}`;
	},
	resetAccountSession: (id) => sessionResets.push(id),
	onCapacityRestored: (evidence) => capacityReports.push(evidence.accountId),
	getApiKey: async (id) => keys[id] ?? null,
	intervalMs: () => 60_000,
});

beforeEach(() => {
	started = [];
	anthropicStarts = [];
	devinStarts = [];
	tokenProviderFor = [];
	sessionResets = [];
	capacityReports = [];
	stopped = [];
	keys = { acc: "key" };
	// Save the raw methods, NOT bound copies: restoring a bound copy would leave
	// a permanently rebound own property on the singleton instead of the
	// original prototype methods.
	realStartPolling = usageCache.startPolling;
	realStopPolling = usageCache.stopPolling;
	// Capture the call instead of arming a real timer: these assert the wiring,
	// and a live poller would fire network reads inside the suite.
	usageCache.startPolling = ((
		accountId: string,
		tokenProvider: () => Promise<string>,
		provider?: string,
		_intervalMs?: number,
		_customEndpoint?: string | null,
		onWindowReset?: (accountId: string) => void,
		onCapacityRestored?: (evidence: CapacityRestoredEvidence) => void,
	) => {
		started.push({
			accountId,
			provider,
			onWindowReset,
			onCapacityRestored,
			tokenProvider,
		});
	}) as typeof usageCache.startPolling;
	usageCache.stopPolling = ((accountId: string) => {
		stopped.push(accountId);
	}) as typeof usageCache.stopPolling;
});

afterEach(() => {
	usageCache.startPolling = realStartPolling;
	usageCache.stopPolling = realStopPolling;
});

describe("startUsagePollingFor", () => {
	it("starts a Z.AI poller and gives it the session-reset callback", () => {
		expect(startUsagePollingFor(account({ provider: "zai" }), starters())).toBe(
			true,
		);
		expect(started).toHaveLength(1);
		expect(started[0].provider).toBe("zai");
		// Without this the rolled window never resets session tracking, and the
		// dashboard keeps showing the previous window until a request lands.
		started[0].onWindowReset?.("acc");
		expect(sessionResets).toEqual(["acc"]);
	});

	it("gives Z.AI the capacity-restored callback", () => {
		startUsagePollingFor(account({ provider: "zai" }), starters());
		started[0].onCapacityRestored?.(evidence("acc"));
		expect(capacityReports).toEqual(["acc"]);
	});

	it("does not give Kilo a session reset", () => {
		// Kilo is credit-based: it has no session window to roll.
		startUsagePollingFor(account({ provider: "kilo" }), starters());
		expect(started).toHaveLength(1);
		expect(started[0].onWindowReset).toBeUndefined();
	});

	it("does not give Kilo the capacity-restored callback either", () => {
		// A credit balance is not a window: it says nothing about whether a lock
		// still holds, so a remaining balance must not become release evidence.
		startUsagePollingFor(account({ provider: "kilo" }), starters());
		expect(started[0].onCapacityRestored).toBeUndefined();
	});

	it("re-reads the stored key on every poll rather than capturing it", async () => {
		startUsagePollingFor(account({ provider: "zai" }), starters());
		keys.acc = "rotated-key";
		// A captured key would still be the original after an edit, and the
		// poller would keep authenticating with a credential the operator replaced.
		expect(await started[0].tokenProvider()).toBe("rotated-key");
	});

	it("fails the poll rather than sending an empty credential when the key is gone", async () => {
		startUsagePollingFor(account({ provider: "zai" }), starters());
		keys.acc = null;
		await expect(started[0].tokenProvider()).rejects.toThrow(
			/credentials unavailable/,
		);
	});

	it("delegates Anthropic to its refresh-aware starter, preserving the stagger", () => {
		const a = account({ provider: "anthropic", refresh_token: "r" });
		expect(startUsagePollingFor(a, starters(), 5000)).toBe(true);
		expect(anthropicStarts).toEqual([{ id: "acc", delay: 5000 }]);
		// It must NOT take the generic API-key path.
		expect(started).toHaveLength(0);
	});

	it("refuses an Anthropic account with no tokens", () => {
		const a = account({
			provider: "anthropic",
			api_key: null,
			access_token: undefined,
			refresh_token: undefined,
		});
		expect(startUsagePollingFor(a, starters())).toBe(false);
		expect(anthropicStarts).toEqual([]);
	});

	it("delegates Devin to its own starter and stops any prior poller first", () => {
		const a = account({ provider: "devin" });
		expect(startUsagePollingFor(a, starters())).toBe(true);
		expect(devinStarts).toEqual(["acc"]);
		expect(stopped).toEqual(["acc"]);
		expect(started).toHaveLength(0);
	});

	it("starts a grok-subscription poller on its tokens, not on an API key", async () => {
		// Created the Qwen/Codex way: `api_key` is NULL. Before this branch existed
		// the account fell through to the API-key path, which refused it on the
		// missing key — so boot, re-auth, account-add priming and the manual
		// refresh button all installed no poller at all.
		const a = account({
			provider: "grok-subscription",
			api_key: null,
			access_token: "grok-access",
		});
		expect(startUsagePollingFor(a, starters())).toBe(true);
		expect(started).toHaveLength(1);
		expect(started[0].provider).toBe("grok-subscription");
		// The refresh-aware provider, so a rotated or re-authenticated token is
		// picked up without a restart.
		expect(await started[0].tokenProvider()).toBe("token-for-acc");
		expect(tokenProviderFor).toEqual(["acc"]);
		// It must NOT take the Anthropic path: that would send a Grok token to a
		// host that is not xAI.
		expect(anthropicStarts).toEqual([]);
	});

	it("starts a grok-subscription poller on a refresh token alone", () => {
		// A stored access token can be expired; the refresh token is what the
		// provider actually needs to produce a live one.
		const a = account({
			provider: "grok-subscription",
			api_key: null,
			access_token: undefined,
			refresh_token: "grok-refresh",
		});
		expect(startUsagePollingFor(a, starters())).toBe(true);
		expect(started).toHaveLength(1);
	});

	it("gives grok-subscription no session reset", () => {
		// One weekly pool across Chat, Imagine, Voice, Build and API: no session
		// window to roll.
		startUsagePollingFor(
			account({
				provider: "grok-subscription",
				api_key: null,
				access_token: "grok-access",
			}),
			starters(),
		);
		expect(started[0].onWindowReset).toBeUndefined();
	});

	it("gives grok-subscription the capacity-restored callback", () => {
		// The weekly pool is account-wide — Chat, Imagine, Voice, Build and API
		// all draw on it — so a poll that sees headroom is evidence the account
		// as a whole recovered. Without this the listener never hears from the
		// only channel that observes a locked account coming back, and every
		// cooldown here runs to its deadline.
		startUsagePollingFor(
			account({
				provider: "grok-subscription",
				api_key: null,
				access_token: "grok-access",
			}),
			starters(),
		);
		started[0].onCapacityRestored?.(evidence("acc"));
		expect(capacityReports).toEqual(["acc"]);
	});

	it("keeps a grok-subscription poller cached reading in place", () => {
		// Unlike Devin, this branch does not stopPolling() first. `startPolling`
		// supersedes the old poller on its own, so the only other effect would be
		// dropping a good weekly reading — which a re-auth has no reason to
		// invalidate, since replacing a token does not change the account quota.
		startUsagePollingFor(
			account({
				provider: "grok-subscription",
				api_key: null,
				access_token: "grok-access",
			}),
			starters(),
		);
		expect(stopped).toEqual([]);
	});

	it("refuses a grok-subscription account with no tokens", () => {
		const a = account({
			provider: "grok-subscription",
			api_key: null,
			access_token: undefined,
			refresh_token: undefined,
		});
		expect(startUsagePollingFor(a, starters())).toBe(false);
		expect(started).toHaveLength(0);
	});

	it("refuses an API-key account with no key", () => {
		const a = account({ provider: "zai", api_key: null });
		expect(startUsagePollingFor(a, starters())).toBe(false);
		expect(started).toHaveLength(0);
	});

	it.each([
		"qwen",
		"codex",
		"minimax",
		"openai-compatible",
		"ollama",
	])("starts nothing for %s", (provider) => {
		const a = account({ provider, api_key: "key", refresh_token: "r" });
		expect(startUsagePollingFor(a, starters())).toBe(false);
		expect(started).toHaveLength(0);
		expect(anthropicStarts).toEqual([]);
		expect(devinStarts).toEqual([]);
	});

	it("never routes a non-Anthropic provider through the Anthropic starter", () => {
		// The failure this guards: a qwen account polled through the default
		// branch would send its token to api.anthropic.com.
		startUsagePollingFor(account({ provider: "qwen" }), starters());
		expect(anthropicStarts).toEqual([]);
		expect(started).toHaveLength(0);
	});
});

it.each([
	"anthropic",
	"codex",
	"devin",
	"zai",
	"kilo",
	"grok-subscription",
])("never starts polling a disabled %s account", (provider) => {
	expect(
		startUsagePollingFor(
			account({
				provider,
				disabled: true,
				access_token: "token",
				refresh_token: "refresh",
			}),
			starters(),
		),
	).toBe(false);
	expect(started).toHaveLength(0);
	expect(anthropicStarts).toHaveLength(0);
	expect(devinStarts).toHaveLength(0);
});
