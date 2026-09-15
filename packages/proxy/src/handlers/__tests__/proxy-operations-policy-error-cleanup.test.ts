import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type { Account, RequestMeta } from "@clankermux/types";
import type { ProxyAttemptOutcome } from "../../__tests__/fixtures/routing-harness";
import { proxyWithAccount } from "../../__tests__/fixtures/routing-harness";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	inspectProviderOverload,
} from "../../provider-overload-cooldown";
import { RoutingPolicyError } from "../../resolved-route";
import type { ProxyContext } from "../proxy-types";

/**
 * `sendAuthorizedRequest` re-checks account identity, model exclusion and
 * permissions on EVERY send, and a failed check throws a RoutingPolicyError that
 * ends the request rather than failing over. That throw used to escape
 * `proxyWithAccount` before any cleanup ran, because the cleanup lived in
 * `fail()` and a policy error must not go through `fail()` (it carries its own
 * audit row and must not emit a second outcome).
 *
 * Two things were live at that point. The worse one is the half-open
 * overload-probe lease: it is single-flight, so while it is held every other
 * request is refused admission and fails over — for the lease TTL (request
 * timeout + stream timeout + margin), and precisely while the breaker is
 * half-open and trying to recover. The other is any upstream body already
 * owned, which a body-repair retry can be holding when the retry is rejected.
 *
 * These tests pin the LEASE. The body disposal is not separately observable on
 * the repair paths that exist today: both classifiers (`cache_control` and the
 * thinking signature) reach their verdict through `response.clone().json()`,
 * and reading that tee branch to EOF already pulls the source stream to
 * completion — so a drain assertion here would pass with or without the fix.
 */

const MODEL = "claude-sonnet-4-5";
const PROVIDER = "openai-compatible";

function makeAccount(id: string): Account {
	return canonicalAccount({
		id,
		name: id,
		provider: PROVIDER,
		api_key: "test-key",
		refresh_token: "",
		created_at: Date.now(),
		custom_endpoint: "https://openrouter.ai/api/v1",
	});
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-policy-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeRequestBody(withCacheControl: boolean) {
	return new TextEncoder().encode(
		JSON.stringify({
			model: MODEL,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "hello",
							...(withCacheControl
								? { cache_control: { type: "ephemeral" } }
								: {}),
						},
					],
				},
			],
			max_tokens: 10,
		}),
	).buffer;
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * `sendAuthorizedRequest` re-reads the account by id before every send and
 * throws when it is gone, and nothing else in this path calls `getAccount`
 * (routing resolution reads `getAllAccounts`). So `allowedSends` is exactly the
 * number of sends that survive the identity re-check: 0 rejects the first send,
 * 1 lets the first through and rejects the repair retry.
 */
function makeProxyContext(
	account: Account,
	allowedSends: number,
): ProxyContext {
	let sends = 0;
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			getAllAccounts: mock(async () => [account]),
			getAccount: mock(async (id: string) =>
				++sends <= allowedSends && id === account.id ? account : null,
			),
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			markAccountRateLimitedDeadlineOnly: mock(() => Promise.resolve()),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: PROVIDER,
			canHandle: () => true,
			buildUrl: () => "https://openrouter.ai/api/v1/messages",
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
}

async function run(
	account: Account,
	ctx: ProxyContext,
	body: ArrayBuffer,
	outcomes: ProxyAttemptOutcome[] = [],
): Promise<Response | null> {
	return proxyWithAccount(
		makeRequest(body),
		new URL("https://proxy.local/v1/messages"),
		account,
		makeRequestMeta(),
		body,
		() => undefined,
		0,
		ctx,
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		{ onOutcome: (o) => outcomes.push(o) },
	);
}

/** Leave the breaker half-open, which is the only state that issues a lease. */
async function openThenLapseBreaker() {
	applyProviderOverloadCooldown(PROVIDER, Date.now() + 15, MODEL);
	await new Promise((resolve) => setTimeout(resolve, 40));
	const before = inspectProviderOverload(PROVIDER, MODEL);
	expect(before.state).toBe("half-open");
	expect(before.probeActive).toBe(false);
}

describe("proxyWithAccount — RoutingPolicyError cleanup", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	it("releases the half-open overload probe lease when the first send is rejected", async () => {
		await openThenLapseBreaker();
		const account = makeAccount("policy-lease");
		const fetcher = mock(async () => new Response("{}", { status: 200 }));
		globalThis.fetch = fetcher as unknown as typeof fetch;
		// The lease is acquired before the send, so rejecting the first send is
		// enough to leave it held if nothing settles it.
		const ctx = makeProxyContext(account, 0);
		const outcomes: ProxyAttemptOutcome[] = [];

		await expect(
			run(account, ctx, makeRequestBody(false), outcomes),
		).rejects.toBeInstanceOf(RoutingPolicyError);

		expect(fetcher).not.toHaveBeenCalled();
		const after = inspectProviderOverload(PROVIDER, MODEL);
		expect(after.probeActive).toBe(false);
		// Released, not resolved: the breaker still needs a real probe, so the
		// bucket must not have been deleted ("recovered") or re-tripped.
		expect(after.state).toBe("half-open");
		// A policy rejection ends the request; it is not a failover, so it must
		// not be reported as an attempt outcome.
		expect(outcomes).toEqual([]);
	});

	it("releases the lease when a repair retry is rejected mid-attempt", async () => {
		// The lease is acquired once per attempt, so a rejection on a REPAIR send
		// leaks it just as a rejection on the first send does — and here the
		// attempt also owns the response it is repairing.
		await openThenLapseBreaker();
		const account = makeAccount("policy-repair");
		const fetcher = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: { message: "Extra inputs are not permitted: cache_control" },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		);
		globalThis.fetch = fetcher as unknown as typeof fetch;
		const ctx = makeProxyContext(account, 1);
		const outcomes: ProxyAttemptOutcome[] = [];

		await expect(
			run(account, ctx, makeRequestBody(true), outcomes),
		).rejects.toBeInstanceOf(RoutingPolicyError);

		expect(fetcher).toHaveBeenCalledTimes(1);
		const after = inspectProviderOverload(PROVIDER, MODEL);
		expect(after.probeActive).toBe(false);
		expect(after.state).toBe("half-open");
		expect(outcomes).toEqual([]);
	});
});
