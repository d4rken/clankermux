/**
 * Unit tests for `ingestProxyRequest` — the request-ingest prologue extracted
 * from handleProxy. These call the function directly (no routing, no upstream)
 * and assert the EXACT values it hands back, so the contract of every returned
 * field is pinned independently of the proxy pipeline that consumes it.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	GATE_CHARS_PER_TOKEN,
	GATE_OUTPUT_RESERVE_CAP,
	NETWORK,
} from "@clankermux/core";
import type { ProxyContext } from "../handlers";
import { setForcedAccount } from "../handlers";
import { ingestProxyRequest } from "../request-ingress";
import { sessionProjectCache } from "../session-project-cache";
import { sessionPromotionTracker } from "../session-promotion";

const MODEL = "claude-sonnet-4-5";

let idCounter = 0;
function uniqueId(prefix: string): string {
	idCounter++;
	return `${prefix}-${idCounter}`;
}

interface CtxOptions {
	canHandle?: (path: string) => boolean;
	cacheWarmingEnabled?: boolean;
	cacheWarmingMinTokens?: number;
	timeout?: (req: unknown, seconds: unknown) => void;
	withServer?: boolean;
}

/**
 * Minimal ProxyContext: the prologue only reads `provider.canHandle`, the two
 * cache-warming config getters, and the optional `server.timeout`.
 */
function makeCtx(options: CtxOptions = {}): ProxyContext {
	return {
		provider: {
			name: "anthropic",
			canHandle: options.canHandle ?? (() => true),
		} as never,
		config: {
			getCacheWarmingEnabled: () => options.cacheWarmingEnabled === true,
			getCacheWarmingMinTokens: () => options.cacheWarmingMinTokens ?? 100_000,
		} as never,
		server:
			options.withServer === false
				? undefined
				: ({ timeout: mock(options.timeout ?? (() => {})) } as never),
	} as ProxyContext;
}

function serverTimeoutMock(ctx: ProxyContext): ReturnType<typeof mock> {
	return (ctx.server as unknown as { timeout: ReturnType<typeof mock> })
		.timeout;
}

function jsonRequest(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Request {
	return new Request(`https://proxy.local${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

function urlFor(path: string): URL {
	return new URL(`https://proxy.local${path}`);
}

function resetSingletons(): void {
	setForcedAccount(null);
	sessionPromotionTracker.setMode("off");
	sessionPromotionTracker.clear();
	sessionProjectCache.clear();
}

describe("ingestProxyRequest", () => {
	beforeEach(resetSingletons);
	afterEach(resetSingletons);

	describe("§0 internal-endpoint short-circuit", () => {
		for (const path of [
			"/api/event_logging/batch",
			"/api/system/package-manager",
		]) {
			it(`answers ${path} with a 200 {success:true} response result`, async () => {
				const result = await ingestProxyRequest(
					jsonRequest(path, { events: [] }),
					urlFor(path),
					makeCtx(),
					null,
					false,
				);

				expect(result.kind).toBe("response");
				if (result.kind !== "response") throw new Error("unreachable");
				expect(result.response.status).toBe(200);
				expect(result.response.headers.get("Content-Type")).toBe(
					"application/json",
				);
				expect(await result.response.json()).toEqual({ success: true });
			});
		}
	});

	describe("§3a /v1/messages validation", () => {
		it("returns the exact 400 invalid_request_error body for a body without messages", async () => {
			const result = await ingestProxyRequest(
				jsonRequest("/v1/messages", {
					model: MODEL,
					event_type: "tengu_api_query",
					event_data: { event_name: "startup" },
				}),
				urlFor("/v1/messages"),
				makeCtx(),
				null,
				false,
			);

			expect(result.kind).toBe("response");
			if (result.kind !== "response") throw new Error("unreachable");
			expect(result.response.status).toBe(400);
			expect(result.response.headers.get("Content-Type")).toBe(
				"application/json",
			);
			expect(await result.response.json()).toEqual({
				type: "error",
				error: {
					type: "invalid_request_error",
					message:
						"messages: Field required for /v1/messages endpoint. Internal events should not be proxied.",
				},
			});
		});
	});

	describe("the returned context", () => {
		const SYSTEM_TEXT = "Primary working directory: /home/tester/ingressproj";
		const USER_TEXT = "hello there";
		const MAX_TOKENS = 32_000;
		const CONTENT_CHARS = SYSTEM_TEXT.length + USER_TEXT.length;

		function contextBody(sessionId?: string): Record<string, unknown> {
			const body: Record<string, unknown> = {
				model: MODEL,
				system: [{ type: "text", text: SYSTEM_TEXT }],
				messages: [{ role: "user", content: USER_TEXT }],
				max_tokens: MAX_TOKENS,
			};
			if (sessionId) {
				body.metadata = {
					user_id: JSON.stringify({
						device_id: "device-1",
						account_uuid: "",
						session_id: sessionId,
					}),
				};
			}
			return body;
		}

		it("reports the context-window estimate, not the promotion estimate", async () => {
			// The two estimators must provably disagree on this fixture, or the
			// assertion below could not tell them apart: the gate divides content by
			// 3.0 and caps its output reservation at 4k, the promotion path divides
			// by 4.0 and adds the full max_tokens.
			const expectedGate =
				Math.ceil(CONTENT_CHARS / GATE_CHARS_PER_TOKEN) +
				Math.min(MAX_TOKENS, GATE_OUTPUT_RESERVE_CAP);
			const promotionEstimate = Math.ceil(CONTENT_CHARS / 4.0) + MAX_TOKENS;
			expect(expectedGate).not.toBe(promotionEstimate);

			const result = await ingestProxyRequest(
				jsonRequest("/v1/messages", contextBody()),
				urlFor("/v1/messages"),
				makeCtx(),
				null,
				false,
			);

			expect(result.kind).toBe("context");
			if (result.kind !== "context") throw new Error("unreachable");
			expect(result.context.gateTokenEstimate).toBe(expectedGate);
		});

		it("resolves the model, project, and attribution source", async () => {
			const result = await ingestProxyRequest(
				jsonRequest("/v1/messages", contextBody()),
				urlFor("/v1/messages"),
				makeCtx(),
				null,
				false,
			);

			if (result.kind !== "context") throw new Error("expected a context");
			expect(result.context.effectiveRequestModel).toBe(MODEL);
			expect(result.context.project).toBe("ingressproj");
			expect(result.context.projectAttributionSource).toBe("wd_primary");
			expect(result.context.requestMeta.project).toBe("ingressproj");
			expect(result.context.requestMeta.projectAttributionSource).toBe(
				"wd_primary",
			);
			expect(result.context.requestMeta.requestedModel).toBe(MODEL);
		});

		it("captures sessionKey and cachePrefixHashes on the request meta", async () => {
			const body = contextBody("11111111-2222-3333-4444-555555555555");
			(body.system as Record<string, unknown>[])[0].cache_control = {
				type: "ephemeral",
			};
			const result = await ingestProxyRequest(
				jsonRequest("/v1/messages", body),
				urlFor("/v1/messages"),
				makeCtx(),
				null,
				false,
			);

			if (result.kind !== "context") throw new Error("expected a context");
			expect(result.context.requestMeta.sessionKey).toBe(
				"anon:11111111-2222-3333-4444-555555555555",
			);
			const capture = result.context.requestMeta.cachePrefixHashes;
			expect(capture?.v).toBe(2);
			expect(capture?.bp).toHaveLength(1);
			expect(capture?.bp[0]).toMatch(/^[0-9a-f]{16}$/);
			expect(capture?.n).toBe(1);
			expect(capture?.tail).toHaveLength(1);
		});

		it("records null hashes for a breakpoint-less body but keeps the session key", async () => {
			const result = await ingestProxyRequest(
				jsonRequest(
					"/v1/messages",
					contextBody("11111111-2222-3333-4444-555555555555"),
				),
				urlFor("/v1/messages"),
				makeCtx(),
				null,
				false,
			);

			if (result.kind !== "context") throw new Error("expected a context");
			expect(result.context.requestMeta.sessionKey).toBe(
				"anon:11111111-2222-3333-4444-555555555555",
			);
			expect(result.context.requestMeta.cachePrefixHashes).toBeNull();
		});

		it("derives the request metadata from the api key, headers, and internal flag", async () => {
			const apiKeyId = uniqueId("key");
			const sessionId = uniqueId("session");
			const req = jsonRequest("/v1/messages", contextBody(), {
				"x-claude-code-session-id": sessionId,
				"x-clankermux-deny-official-anthropic": "1",
			});

			const result = await ingestProxyRequest(
				req,
				urlFor("/v1/messages"),
				makeCtx(),
				apiKeyId,
				true,
			);

			if (result.kind !== "context") throw new Error("expected a context");
			const meta = result.context.requestMeta;
			expect(meta.method).toBe("POST");
			expect(meta.path).toBe("/v1/messages");
			expect(meta.internal).toBe(true);
			expect(meta.affinityKey).toBe(sessionId);
			expect(meta.affinityScope).toBe("claude_session");
			expect(meta.affinityPartition).toBe(`api_key:${apiKeyId}`);
			expect(meta.excludeOfficialAnthropic).toBe(true);
		});

		it("leaves the affinity partition and the official-Anthropic floor unset without them", async () => {
			const result = await ingestProxyRequest(
				jsonRequest("/v1/messages", contextBody()),
				urlFor("/v1/messages"),
				makeCtx(),
				null,
				false,
			);

			if (result.kind !== "context") throw new Error("expected a context");
			const meta = result.context.requestMeta;
			expect(meta.internal).toBe(false);
			expect(meta.affinityKey).toBeNull();
			expect(meta.affinityScope).toBeNull();
			expect(meta.affinityPartition).toBeNull();
			expect(meta.excludeOfficialAnthropic).toBe(false);
		});

		it('returns a finalBodyBuffer carrying the injected ttl:"1h" once the session is promoted', async () => {
			// Promotion preconditions: the feature switch on, no token floor, the
			// tracker in its production (turn-count) mode, and a session-keyed
			// request with ephemeral cache breakpoints to rewrite.
			sessionPromotionTracker.setMode("dynamic");
			const ctx = makeCtx({
				cacheWarmingEnabled: true,
				cacheWarmingMinTokens: 0,
			});
			const sessionId = uniqueId("session");
			const cacheableBody = {
				model: MODEL,
				system: [
					{
						type: "text",
						text: "you are helpful",
						cache_control: { type: "ephemeral" },
					},
				],
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: USER_TEXT,
								cache_control: { type: "ephemeral" },
							},
						],
					},
				],
				max_tokens: 16,
			};

			const buffers: Array<string> = [];
			for (let turn = 0; turn < 3; turn++) {
				const result = await ingestProxyRequest(
					jsonRequest("/v1/messages", cacheableBody, {
						"x-claude-code-session-id": sessionId,
					}),
					urlFor("/v1/messages"),
					ctx,
					null,
					false,
				);
				if (result.kind !== "context") throw new Error("expected a context");
				const buffer = result.context.finalBodyBuffer;
				expect(buffer).not.toBeNull();
				buffers.push(new TextDecoder().decode(buffer as ArrayBuffer));
			}

			// Turns 1–2 are below the promotion threshold; turn 3 promotes, and the
			// mutation is visible in the BYTES the caller forwards upstream.
			expect(buffers[0]).not.toContain('"ttl":"1h"');
			expect(buffers[1]).not.toContain('"ttl":"1h"');
			const promoted = JSON.parse(buffers[2]) as {
				system: Array<{ cache_control: { ttl?: string } }>;
				messages: Array<{
					content: Array<{ cache_control: { ttl?: string } }>;
				}>;
			};
			expect(promoted.system[0].cache_control.ttl).toBe("1h");
			expect(promoted.messages[0].content[0].cache_control.ttl).toBe("1h");
		});
	});

	describe("finalCreateBodyStream", () => {
		it("hands out a fresh, independently readable stream on every call", async () => {
			const body = {
				model: MODEL,
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			};
			const result = await ingestProxyRequest(
				jsonRequest("/v1/messages", body),
				urlFor("/v1/messages"),
				makeCtx(),
				null,
				false,
			);

			if (result.kind !== "context") throw new Error("expected a context");
			const first = result.context.finalCreateBodyStream();
			const second = result.context.finalCreateBodyStream();
			expect(first).toBeDefined();
			expect(second).toBeDefined();
			expect(first).not.toBe(second);

			const firstBytes = await new Response(first).text();
			const secondBytes = await new Response(second).text();
			const expected = new TextDecoder().decode(
				result.context.finalBodyBuffer as ArrayBuffer,
			);
			expect(firstBytes).toBe(expected);
			expect(secondBytes).toBe(expected);
		});

		it("returns undefined for a request with no body", async () => {
			const result = await ingestProxyRequest(
				new Request("https://proxy.local/v1/models", { method: "GET" }),
				urlFor("/v1/models"),
				makeCtx(),
				null,
				false,
			);

			if (result.kind !== "context") throw new Error("expected a context");
			expect(result.context.finalBodyBuffer).toBeNull();
			expect(result.context.finalCreateBodyStream()).toBeUndefined();
		});
	});

	describe("provider-path validation", () => {
		it("THROWS (does not return a response) when the provider cannot handle the path", async () => {
			await expect(
				ingestProxyRequest(
					jsonRequest("/v1/unsupported", { model: MODEL }),
					urlFor("/v1/unsupported"),
					makeCtx({ canHandle: () => false }),
					null,
					false,
				),
			).rejects.toThrow("Provider cannot handle path: /v1/unsupported");
		});
	});

	describe("bumpIdleTimeout", () => {
		it("re-arms the idle timer with the exact request and timeout constant", async () => {
			const ctx = makeCtx();
			const req = jsonRequest("/v1/messages", {
				model: MODEL,
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			});

			const result = await ingestProxyRequest(
				req,
				urlFor("/v1/messages"),
				ctx,
				null,
				false,
			);

			if (result.kind !== "context") throw new Error("expected a context");
			const timeout = serverTimeoutMock(ctx);
			expect(timeout).not.toHaveBeenCalled();
			result.context.bumpIdleTimeout();
			expect(timeout).toHaveBeenCalledTimes(1);
			expect(timeout).toHaveBeenLastCalledWith(
				req,
				NETWORK.SERVER_IDLE_TIMEOUT_SECONDS,
			);
		});

		it("swallows a throwing server.timeout", async () => {
			const ctx = makeCtx({
				timeout: () => {
					throw new Error("not a tracked connection");
				},
			});

			const result = await ingestProxyRequest(
				jsonRequest("/v1/messages", {
					model: MODEL,
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
				urlFor("/v1/messages"),
				ctx,
				null,
				false,
			);

			if (result.kind !== "context") throw new Error("expected a context");
			expect(() => {
				result.context.bumpIdleTimeout();
			}).not.toThrow();
			expect(serverTimeoutMock(ctx)).toHaveBeenCalledTimes(1);
		});

		it("is a no-op when the context has no server", async () => {
			const result = await ingestProxyRequest(
				jsonRequest("/v1/messages", {
					model: MODEL,
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
				urlFor("/v1/messages"),
				makeCtx({ withServer: false }),
				null,
				false,
			);

			if (result.kind !== "context") throw new Error("expected a context");
			expect(() => {
				result.context.bumpIdleTimeout();
			}).not.toThrow();
		});
	});
});
