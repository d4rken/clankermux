import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
} from "bun:test";
import { usageCache } from "@clankermux/providers";
import {
	makeAccount as canonicalAccount,
	mockFetch,
} from "@clankermux/test-support";
import type { Account, RequestMeta } from "@clankermux/types";
import {
	type ProxyAttemptOutcome,
	proxyWithAccount,
	routingAttempts,
} from "../../__tests__/fixtures/routing-harness";
import { invalidateCodexObservations } from "../../codex-observation-fence";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import { clearAnthropicBurstThrottle } from "../burst-cooldown";
import type { ProxyContext } from "../proxy-types";
import {
	hasCapacityRestoredProbePending,
	resetRateLimitProbeGatesForTests,
} from "../rate-limit-cooldown";

/**
 * A 429 cooldown is written as a server-directed deadline only when the 429
 * named one. The proxy's own fallbacks (the 60s default, the usage endpoint's
 * throttle deadline, a provider parser's invented reset) take the adaptive
 * no-reset ramp, which starts at 30s and escalates.
 */
const NOW = Date.UTC(2026, 9, 21, 7, 35, 41);
const WEEKLY_RESET = NOW + 515_526_000;
const PARSER_INVENTED_RESET = NOW + 60 * 60 * 1000;

type CooldownCall = { accountId: string; until: number; reason: string };

function makeAccount(overrides: Partial<Account> = {}): Account {
	return canonicalAccount({
		id: "acc-1",
		name: "acc-1",
		refresh_token: "rt-token",
		access_token: "at-token",
		expires_at: NOW + 3_600_000,
		created_at: NOW,
		...overrides,
	});
}

function makeProxyContext() {
	const deadlineCalls: CooldownCall[] = [];
	const escalatingCalls: CooldownCall[] = [];
	const ctx = {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(accountId: string, until: number, reason: string) => {
					escalatingCalls.push({ accountId, until, reason });
					return Promise.resolve(1);
				},
			),
			markAccountRateLimitedDeadlineOnly: mock(
				(accountId: string, until: number, reason: string) => {
					deadlineCalls.push({ accountId, until, reason });
					return Promise.resolve();
				},
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock(() => Promise.resolve()),
			saveCodexWindowObservations: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
				runTransaction: mock(async () => 0),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			// Mirrors both real parsers' habit of inventing a reset for a 429
			// that named none.
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 429,
				resetTime: response.status === 429 ? PARSER_INVENTED_RESET : undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		config: { getStorePayloads: () => true } as never,
		requestRecorder: {
			begin: mock(() => {}),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
	} as unknown as ProxyContext;
	return { ctx, deadlineCalls, escalatingCalls };
}

function rl429(headers: Record<string, string> = {}) {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "Too many requests" },
		}),
		{
			status: 429,
			headers: { "content-type": "application/json", ...headers },
		},
	);
}

/** Header shape of a weekly-exhausted ChatGPT-backend 429 (2026-10-21). */
function codexWeekly429(overrides: Record<string, string> = {}) {
	return rl429({
		"x-codex-active-limit": "premium",
		"x-codex-plan-type": "prolite",
		"x-codex-primary-used-percent": "100",
		"x-codex-primary-window-minutes": "10080",
		"x-codex-primary-reset-at": String(WEEKLY_RESET / 1000),
		"x-codex-secondary-used-percent": "0",
		"x-codex-secondary-window-minutes": "0",
		"x-codex-secondary-reset-at": "",
		...overrides,
	});
}

async function drive(
	ctx: ProxyContext,
	account: Account,
	onFetch?: () => void,
	model = "totally-unknown-model",
	outcomes: ProxyAttemptOutcome[] = [],
) {
	const body = new TextEncoder().encode(
		JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer;
	const requestMeta: RequestMeta = {
		id: "req-provenance-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: NOW,
		officialAnthropicVia: "direct",
		headers: new Headers(),
	};
	const fetchImpl = globalThis.fetch;
	if (onFetch) {
		globalThis.fetch = mockFetch(
			mock(async (...args: Parameters<typeof fetch>) => {
				const response = await fetchImpl(...args);
				onFetch();
				return response;
			}),
		);
	}
	return proxyWithAccount(
		new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body,
			headers: { "Content-Type": "application/json" },
		}),
		new URL("https://proxy.local/v1/messages"),
		account,
		requestMeta,
		body,
		() => undefined,
		0,
		ctx,
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		{ onOutcome: (outcome) => outcomes.push(outcome) },
	);
}

describe("proxyWithAccount — 429 cooldown provenance", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		setSystemTime(new Date(NOW));
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		usageCache.delete("acc-1");
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		setSystemTime();
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		usageCache.delete("acc-1");
		resetRateLimitProbeGatesForTests();
	});

	it("residual rung: a 429 naming no reset takes the ramp, not our 60s default", async () => {
		globalThis.fetch = mockFetch(mock(async () => rl429()));
		const { ctx, deadlineCalls, escalatingCalls } = makeProxyContext();
		const account = makeAccount();
		const outcomes: ProxyAttemptOutcome[] = [];

		expect(
			await drive(ctx, account, undefined, undefined, outcomes),
		).toBeNull();

		expect(deadlineCalls).toEqual([]);
		expect(escalatingCalls).toEqual([
			{ accountId: "acc-1", until: NOW + 30_000, reason: "model_fallback_429" },
		]);
		expect(account.consecutive_rate_limits).toBe(1);
		// The ramp still single-flights the account's recovery.
		expect(hasCapacityRestoredProbePending(account.id)).toBe(true);
		expect(routingAttempts(ctx)[0]?.error).toBe("model_fallback_429");
		// The outcome reports the deadline written, not the 60s it replaced.
		expect(outcomes).toEqual([
			{ kind: "hard_429", cooldownUntil: NOW + 30_000 },
		]);
	});

	it("residual rung: a 429 naming its own reset is still honoured verbatim", async () => {
		globalThis.fetch = mockFetch(
			mock(async () => rl429({ "retry-after": "600" })),
		);
		const { ctx, deadlineCalls, escalatingCalls } = makeProxyContext();
		const account = makeAccount();

		await drive(ctx, account);

		expect(escalatingCalls).toEqual([]);
		expect(deadlineCalls).toEqual([
			{
				accountId: "acc-1",
				until: NOW + 600_000,
				reason: "model_fallback_429",
			},
		]);
		expect(account.consecutive_rate_limits).toBe(0);
	});

	it("residual rung: the usage endpoint's throttle deadline is not a reset", async () => {
		globalThis.fetch = mockFetch(mock(async () => rl429()));
		usageCache.noteRateLimited("acc-1", NOW + 15 * 60_000);
		const { ctx, deadlineCalls, escalatingCalls } = makeProxyContext();

		await drive(ctx, makeAccount());

		expect(deadlineCalls).toEqual([]);
		expect(escalatingCalls.map((c) => c.until)).toEqual([NOW + 30_000]);
	});

	it("Codex: a weekly-exhausted 429 cools down until the weekly reset", async () => {
		globalThis.fetch = mockFetch(mock(async () => codexWeekly429()));
		const { ctx, deadlineCalls, escalatingCalls } = makeProxyContext();
		const account = makeAccount({ provider: "codex" });
		const outcomes: ProxyAttemptOutcome[] = [];

		expect(
			await drive(ctx, account, undefined, "gpt-6-sol", outcomes),
		).toBeNull();

		expect(escalatingCalls).toEqual([]);
		expect(deadlineCalls).toEqual([
			{
				accountId: "acc-1",
				until: WEEKLY_RESET,
				reason: "weekly_exhausted_429",
			},
		]);
		expect(account.rate_limited_until).toBe(WEEKLY_RESET);
		expect(routingAttempts(ctx)[0]?.error).toBe("weekly_exhausted_429");
		expect(outcomes).toEqual([
			{ kind: "hard_429", cooldownUntil: WEEKLY_RESET },
		]);
	});

	it("Codex: a 429 with no spent window takes the ramp, not the parser's invented reset", async () => {
		globalThis.fetch = mockFetch(
			mock(async () =>
				codexWeekly429({ "x-codex-primary-used-percent": "40" }),
			),
		);
		const { ctx, deadlineCalls, escalatingCalls } = makeProxyContext();
		const account = makeAccount({ provider: "codex" });

		await drive(ctx, account, undefined, "gpt-6-sol");

		expect(deadlineCalls).toEqual([]);
		expect(escalatingCalls).toEqual([
			{ accountId: "acc-1", until: NOW + 30_000, reason: "model_fallback_429" },
		]);
		// Codex is never armed for the OAuth-Anthropic burst probe.
		expect(hasCapacityRestoredProbePending(account.id)).toBe(false);
	});

	it("Codex: an observation superseded by a newer reset writes no cooldown", async () => {
		globalThis.fetch = mockFetch(mock(async () => codexWeekly429()));
		const { ctx, deadlineCalls, escalatingCalls } = makeProxyContext();
		// An earlier cooldown's expired deadline is still on the account.
		const earlierUntil = NOW - 1_000;
		const account = makeAccount({
			provider: "codex",
			rate_limited_until: earlierUntil,
		});
		const outcomes: ProxyAttemptOutcome[] = [];

		// A window reset lands while the request is in flight.
		await drive(
			ctx,
			account,
			() => invalidateCodexObservations(account.id),
			"gpt-6-sol",
			outcomes,
		);

		expect(deadlineCalls).toEqual([]);
		expect(escalatingCalls).toEqual([]);
		expect(account.rate_limited_until).toBe(earlierUntil);
		// No deadline is reported, least of all the stale one.
		expect(outcomes).toEqual([{ kind: "hard_429", cooldownUntil: undefined }]);
		// No cooldown reason was written, so the attempt carries the generic one.
		expect(routingAttempts(ctx)[0]?.error).toBe("rate_limited");
	});
});
