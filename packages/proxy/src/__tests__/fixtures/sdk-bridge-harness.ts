/** Shared setup for the SDK bridge proxy tests: a fake transport, a context
 * whose accounts and routing are fully in memory, and an upstream fetch stub
 * that records every model call instead of reaching the network. */
import { mock } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type {
	Account,
	SdkBridgeAvailability,
	SdkBridgeRoutePlan,
	SdkBridgeTransport,
	SdkBridgeTurnMeta,
} from "@clankermux/types";
import type { ProxyContext } from "../../handlers";
import { provisionRouting } from "./routing-harness";

export function makeBridgeAccount(overrides: Partial<Account> = {}): Account {
	return canonicalAccount({
		provider: "anthropic",
		api_key: `key-${overrides.id ?? "account"}`,
		refresh_token: "",
		created_at: Date.now(),
		...overrides,
	});
}

export interface FakeBridge extends SdkBridgeTransport {
	state: SdkBridgeAvailability;
	starts: Array<{
		request: Request;
		body: Record<string, unknown>;
		plan: SdkBridgeRoutePlan;
		meta: SdkBridgeTurnMeta;
	}>;
	continues: Array<{
		turnId: string;
		body: Record<string, unknown>;
		meta: SdkBridgeTurnMeta;
	}>;
	/** What startTurn answers; throwing is how a test models infrastructure failure. */
	respond: (plan: SdkBridgeRoutePlan) => Response | Promise<Response>;
	continuation: { turnId: string; ownerApiKeyId: string | null } | null;
	lookups: string[][];
}

export function makeFakeBridge(
	respond: FakeBridge["respond"] = () =>
		Response.json({
			id: "msg_bridge",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "from the bridge" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
): FakeBridge {
	const bridge: FakeBridge = {
		state: { state: "available" },
		starts: [],
		continues: [],
		respond,
		continuation: null,
		lookups: [],
		availability: () => bridge.state,
		async startTurn({ request, plan, meta }) {
			bridge.starts.push({
				request,
				body: await request.clone().json(),
				plan,
				meta,
			});
			return bridge.respond(plan);
		},
		findContinuation(ids) {
			bridge.lookups.push([...ids]);
			return bridge.continuation;
		},
		async continueTurn({ turnId, request, meta }) {
			bridge.continues.push({
				turnId,
				body: await request.clone().json(),
				meta,
			});
			return Response.json({ continued: turnId });
		},
	};
	return bridge;
}

export interface BridgeHarness {
	ctx: ProxyContext;
	/** The account each upstream model call carried, by its API key. */
	upstreamKeys: string[];
	restore: () => void;
}

/**
 * `accounts` in the order the strategy ranks them. Every upstream call is
 * answered by `upstream`, keyed on the account's API key.
 */
export async function makeBridgeHarness(
	accounts: Account[],
	opts: {
		bridge?: SdkBridgeTransport;
		model?: string;
		upstream?: (apiKey: string) => Response | undefined;
		pin?: { pinnedAccountId: string | null; pinnedProviders: string[] | null };
	} = {},
): Promise<BridgeHarness> {
	const upstreamKeys: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			if (!new URL(request.url).pathname.endsWith("/v1/messages"))
				return new Response(null, { status: 404 });
			const key = request.headers.get("x-api-key") ?? "";
			upstreamKeys.push(key);
			return (
				opts.upstream?.(key) ??
				Response.json({
					id: "msg_direct",
					type: "message",
					role: "assistant",
					model: opts.model ?? "claude-sonnet-4-5",
					content: [{ type: "text", text: "direct" }],
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				})
			);
		},
	) as unknown as typeof fetch;
	const ctx: ProxyContext = {
		strategy: {
			select: (accs: Account[]) =>
				accs.filter(
					(a) =>
						!a.paused &&
						(!a.rate_limited_until || a.rate_limited_until <= Date.now()),
				),
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(
				async (id: string) => accounts.find((a) => a.id === id) ?? null,
			),
			getApiKeyPin: mock(async () =>
				opts.pin ? opts.pin : { pinnedAccountId: null, pinnedProviders: null },
			),
			markAccountRateLimited: mock(async () => {}),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => {}),
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
			getStorePayloads: () => true,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://upstream.local/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		requestRecorder: {
			begin: mock(() => {}),
			hasRecord: mock(() => false),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			onWorkerGone: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
		...(opts.bridge ? { sdkBridge: opts.bridge } : {}),
	};
	await provisionRouting(ctx, opts.model ?? "claude-sonnet-4-5");
	return {
		ctx,
		upstreamKeys,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

export function messagesRequest(
	body: Record<string, unknown> = {},
	headers: Record<string, string> = {},
): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			max_tokens: 16,
			messages: [{ role: "user", content: "hello" }],
			...body,
		}),
	});
}
