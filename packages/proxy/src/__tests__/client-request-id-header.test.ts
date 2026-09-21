/**
 * `x-clankermux-request-id` has to reach the CLIENT whichever provider served
 * the request.
 *
 * The id is set on the upstream response object so providers can read it, and
 * whether it survived to the client used to be an accident of which one
 * answered: the Anthropic path kept it, because `sanitizeProxyHeaders` deletes
 * only the resolved-model header, while the Codex provider lists it among the
 * internal headers it strips from every response it returns. ClankerMux is a
 * multiplexer, so a client cannot predict which provider serves it — an id that
 * is present for some share of traffic is an id no client can build on.
 *
 * `forwardToClient` is the single client-facing wrapper, and it runs after
 * every provider's own `processResponse`, so the assertion below is that the
 * header is a property of the proxy rather than of the account that served the
 * request. The Codex strip stays: it protects the proxy's own classification
 * from a forged INBOUND header, which is a different concern.
 */
import { describe, expect, it } from "bun:test";
import { CodexProvider } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { RecordMeta } from "../request-recorder";
import { forwardToClient } from "../response-handler";

const enc = new TextEncoder();
const NOW = Date.now();

function makeAccount(provider: string): Account {
	return {
		id: `rid-${provider}`,
		name: provider,
		provider,
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: NOW + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
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
		billing_type: null,
		pause_reason: null,
		notes: null,
		refresh_token_issued_at: null,
	} as Account;
}

function makeCtx(providerName: string) {
	return {
		strategy: {},
		dbOps: {
			markAccountRateLimited: async () => 1,
			markAccountRateLimitedDeadlineOnly: async () => {},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			updateRequestUsage: async () => {},
			saveUnifiedClaimObservations: () => {},
			saveUnifiedSummaryObservation: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
		},
		runtime: { port: 8080, tlsEnabled: false },
		config: { getStorePayloads: () => false },
		provider: { name: providerName, isStreamingResponse: () => false },
		refreshInFlight: new Map<string, Promise<string>>(),
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				void job();
				return Promise.resolve();
			},
		},
		requestRecorder: {
			begin: (_meta: RecordMeta) => {},
			captureResponseChunk: () => {},
			finishTransport: () => {},
			attachUsageSummary: () => {},
			markUsageUnavailable: () => {},
		},
	} as never;
}

async function forward(
	requestId: string,
	upstream: Response,
	providerName: string,
): Promise<Response> {
	const response = await forwardToClient(
		{
			requestId,
			method: "POST",
			path: "/v1/messages",
			account: makeAccount(providerName),
			requestHeaders: new Headers({ "content-type": "application/json" }),
			requestBody: enc.encode("{}").buffer as ArrayBuffer,
			response: upstream,
			timestamp: NOW,
			retryAttempt: 0,
			failoverAttempts: 0,
		},
		makeCtx(providerName),
	);
	if (response.body) await response.text();
	return response;
}

/** What `proxy-operations` puts on the upstream response for providers to read. */
function upstreamResponse(requestId: string): Response {
	return new Response('{"ok":true}', {
		status: 200,
		headers: {
			"content-type": "application/json",
			"x-clankermux-request-id": requestId,
		},
	});
}

describe("the client-facing request id", () => {
	it("survives the Codex provider, which strips it from every response it returns", async () => {
		const requestId = "rid-codex-1";
		// The real strip, not a stand-in for it: this is the same call the proxy
		// makes before forwarding, and it is what used to lose the header.
		const processed = await new CodexProvider().processResponse(
			upstreamResponse(requestId),
			null,
		);
		expect(processed.headers.get("x-clankermux-request-id")).toBeNull();

		const response = await forward(requestId, processed, "codex");
		expect(response.headers.get("x-clankermux-request-id")).toBe(requestId);
	});

	it("is present on a provider path that never strips it", async () => {
		const requestId = "rid-anthropic-1";
		const response = await forward(
			requestId,
			upstreamResponse(requestId),
			"anthropic",
		);
		expect(response.headers.get("x-clankermux-request-id")).toBe(requestId);
	});

	// The id the CLIENT is told is the one the proxy recorded the request under,
	// never whatever an upstream happened to send back under the same name.
	it("states the proxy's own id even when upstream claims another", async () => {
		const response = await forward(
			"rid-ours",
			new Response('{"ok":true}', {
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-clankermux-request-id": "rid-forged",
				},
			}),
			"anthropic",
		);
		expect(response.headers.get("x-clankermux-request-id")).toBe("rid-ours");
	});
});
