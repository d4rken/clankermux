/**
 * Shared harness for the `handleProxy` give-up terminal tests.
 *
 * Every terminal test needs the same three things: a fully-populated `Account`
 * (the type has ~35 required fields, none of which the assertions care about),
 * a `ProxyContext` whose `requestRecorder` is a mock the test can read the
 * synthetic row back out of, and a `fetch` stub that answers only the upstream
 * hosts so the pricing-catalog fetch cannot reach the handler.
 *
 * It lives in a fixture rather than being copied per file because the mock
 * `ProxyContext` is ~70 lines of provider/dbOps/config surface that drifts
 * whenever the real context gains a method — one copy fails loudly, three
 * copies fail in whichever file was edited last.
 */

import { mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../../handlers";

let idCounter = 0;
function uniqueId(prefix: string): string {
	idCounter++;
	return `${prefix}-${idCounter}`;
}

/** Older than the refresh-token max age, so the token reads as expired. */
export const LONG_AGO = Date.now() - 400 * 24 * 60 * 60 * 1000;

export function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: uniqueId("acc"),
		name: "Main-me",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

export type RecorderMock = {
	begin: ReturnType<typeof mock>;
	hasRecord: ReturnType<typeof mock>;
	recordSynthetic: ReturnType<typeof mock>;
	captureResponseChunk: ReturnType<typeof mock>;
	finishTransport: ReturnType<typeof mock>;
	attachUsageSummary: ReturnType<typeof mock>;
	markUsageUnavailable: ReturnType<typeof mock>;
	sweep: ReturnType<typeof mock>;
	dispose: ReturnType<typeof mock>;
};

export function makeContext(
	accounts: Account[],
	recorderOverrides: Partial<Record<"hasRecord", () => boolean>> = {},
): ProxyContext & { recorder: RecorderMock } {
	const recorder: RecorderMock = {
		begin: mock(() => {}),
		hasRecord: mock(recorderOverrides.hasRecord ?? (() => false)),
		recordSynthetic: mock(() => {}),
		captureResponseChunk: mock(() => {}),
		finishTransport: mock(() => {}),
		attachUsageSummary: mock(() => {}),
		markUsageUnavailable: mock(() => {}),
		sweep: mock(() => {}),
		dispose: mock(() => {}),
	};
	const ctx = {
		strategy: {
			select: (accs: Account[]) => {
				const now = Date.now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= now),
				);
			},
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(
				async (id: string) => accounts.find((a) => a.id === id) ?? null,
			),
			getActiveComboForFamily: mock(async () => null),
			getApiKeyPin: mock(async () => null),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
			updateAccountRateLimitMeta: mock(async () => {}),
			resetConsecutiveRateLimits: mock(async () => {}),
			getAdapter: mock(() => ({
				run: mock(async () => {}),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
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
		requestRecorder: recorder as never,
	} as unknown as ProxyContext;
	return Object.assign(ctx, { recorder });
}

/** Keep unrelated background fetches (pricing catalog) off the handler. */
export function upstreamOnlyFetch(
	handler: (input: Request | string | URL) => Response | Promise<Response>,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.includes("api.anthropic.com") && !url.includes("chatgpt.com")) {
			return new Response("unavailable", { status: 500 });
		}
		return handler(input);
	}) as never;
}

/** The RecordMeta of the single synthetic row written, plus its label. */
export function syntheticCall(recorder: RecorderMock): {
	meta: { responseStatus: number; failoverAttempts: number };
	label: string;
} {
	const calls = recorder.recordSynthetic.mock.calls as unknown[][];
	if (calls.length !== 1) {
		throw new Error(`expected exactly one synthetic row, got ${calls.length}`);
	}
	return {
		meta: calls[0][0] as { responseStatus: number; failoverAttempts: number },
		label: calls[0][2] as string,
	};
}

export async function callHandleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
): Promise<Response> {
	const { handleProxy } = await import("../../proxy");
	return handleProxy(req, url, ctx);
}
