/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CodexProvider, OpenAICompatibleProvider } from "@clankermux/providers";
import { chatGptCloudflareCookieJar } from "../../chatgpt-cloudflare-cookies";
import { makeProxyRequest, validateProviderPath } from "../request-handler";

describe("validateProviderPath", () => {
	it("accepts count_tokens for OpenAI-compatible provider", () => {
		expect(() =>
			validateProviderPath(
				new OpenAICompatibleProvider(),
				"/v1/messages/count_tokens",
			),
		).not.toThrow();
	});

	it("accepts count_tokens for Codex provider", () => {
		expect(() =>
			validateProviderPath(new CodexProvider(), "/v1/messages/count_tokens"),
		).not.toThrow();
	});
});

describe("makeProxyRequest — signal composition (Finding 3)", () => {
	it("retains cancellation carried by a transformed Request", async () => {
		let seen: AbortSignal | undefined;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			seen = (input as Request).signal;
			return Response.json({});
		}) as typeof fetch;
		const abort = new AbortController();
		await makeProxyRequest(
			new Request("https://example.invalid/v1/messages", {
				signal: abort.signal,
			}),
		);
		abort.abort();
		expect(seen?.aborted).toBe(true);
	});
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("composes the caller signal with the internal timeout (fetch gets a derived signal, not the raw caller signal)", async () => {
		// Capture the signal fetch receives. With composition, it must be a NEW
		// AbortSignal (from AbortSignal.any) — never the raw caller signal — so the
		// internal PROXY_REQUEST_TIMEOUT can still abort even when the caller passes
		// req.signal (the burst-retry paths do).
		let seenSignal: AbortSignal | null | undefined;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			seenSignal =
				input instanceof Request ? input.signal : (init?.signal ?? null);
			return new Response("{}", { status: 200 });
		}) as typeof globalThis.fetch;

		const caller = new AbortController();
		await makeProxyRequest(
			"https://example.invalid/v1/messages",
			"POST",
			new Headers(),
			() => undefined,
			false,
			caller.signal,
		);

		expect(seenSignal).toBeInstanceOf(AbortSignal);
		// Composition: the fetch-bound signal is derived, NOT the raw caller signal.
		expect(seenSignal).not.toBe(caller.signal);
	});

	it("a caller-signal abort still aborts the composed fetch", async () => {
		// Composition must not break caller-disconnect propagation: aborting the
		// caller signal aborts the in-flight fetch.
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const signal =
				input instanceof Request ? input.signal : (init?.signal ?? undefined);
			return new Promise<Response>((_resolve, reject) => {
				if (signal?.aborted) {
					reject(new DOMException("Aborted", "AbortError"));
					return;
				}
				signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
			});
		}) as typeof globalThis.fetch;

		const caller = new AbortController();
		const promise = makeProxyRequest(
			"https://example.invalid/v1/messages",
			"POST",
			new Headers(),
			() => undefined,
			false,
			caller.signal,
		);
		caller.abort();
		await expect(promise).rejects.toThrow();
	});
});

describe("makeProxyRequest — internal control header sweep", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function captureOutboundHeaders(): () => Headers {
		let seen: Headers = new Headers();
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			seen =
				input instanceof Request
					? new Headers(input.headers)
					: new Headers(init?.headers);
			return new Response("{}", { status: 200 });
		}) as typeof globalThis.fetch;
		return () => seen;
	}

	// Three ADJACENT prefixed headers: deleting from a live Headers iterator can
	// advance past neighbours, so a naive sweep leaves some of them on the wire.
	function withInternalMarkers(headers: Headers): Headers {
		headers.set("content-type", "application/json");
		headers.set("x-clankermux-account-id", "acct-1");
		headers.set("x-clankermux-keepalive", "true");
		headers.set("x-clankermux-request-stream", "true");
		headers.set("x-clankermux-skip-cache", "true");
		headers.set("x-better-ccflare-account-id", "acct-legacy");
		headers.set("accept", "application/json");
		return headers;
	}

	function expectSwept(sent: Headers): void {
		const surviving = [...sent.keys()].filter((k) =>
			/^x-(clankermux|better-ccflare)-/i.test(k),
		);
		expect(surviving).toEqual([]);
		// Ordinary headers must be untouched.
		expect(sent.get("content-type")).toBe("application/json");
		expect(sent.get("accept")).toBe("application/json");
	}

	it("strips every internal header on the headers-param branch", async () => {
		const getSeen = captureOutboundHeaders();
		await makeProxyRequest(
			"https://example.invalid/v1/messages",
			"POST",
			withInternalMarkers(new Headers()),
			() => undefined,
			false,
		);
		expectSwept(getSeen());
	});

	it("strips every internal header on the Request-target branch", async () => {
		const getSeen = captureOutboundHeaders();
		const req = new Request("https://example.invalid/v1/responses", {
			method: "POST",
			headers: withInternalMarkers(new Headers()),
			body: "{}",
		});
		await makeProxyRequest(req);
		expectSwept(getSeen());
	});
});

describe("makeProxyRequest — client hop metadata sweep", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function captureOutboundHeaders(): () => Headers {
		let seen: Headers = new Headers();
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			seen =
				input instanceof Request
					? new Headers(input.headers)
					: new Headers(init?.headers);
			return new Response("{}", { status: 200 });
		}) as typeof globalThis.fetch;
		return () => seen;
	}

	// Caddy sets the x-forwarded-* trio on everything it proxies, and a browser
	// on the dashboard's own origin sends its session cookie to any path,
	// /v1/* included. None of it describes the proxy→upstream hop.
	function withClientHopMetadata(headers: Headers): Headers {
		headers.set("content-type", "application/json");
		headers.set("cookie", "cmx_session=secret-session-token");
		headers.set("x-forwarded-for", "192.168.1.50");
		headers.set("x-forwarded-proto", "http");
		headers.set("x-forwarded-host", "clankermux.lan:8080");
		headers.set("forwarded", "for=192.168.1.50;proto=http");
		headers.set("x-real-ip", "192.168.1.50");
		headers.set("true-client-ip", "192.168.1.50");
		headers.set("cf-connecting-ip", "192.168.1.50");
		headers.set("cf-ray", "8d0-LHR");
		headers.set("cdn-loop", "cloudflare");
		headers.set("accept", "application/json");
		return headers;
	}

	function expectHopMetadataSwept(sent: Headers): void {
		expect(sent.get("cookie")).toBeNull();
		for (const name of [
			"x-forwarded-for",
			"x-forwarded-proto",
			"x-forwarded-host",
			"forwarded",
			"x-real-ip",
			"true-client-ip",
			"cf-connecting-ip",
			"cf-ray",
			"cdn-loop",
		]) {
			expect(sent.get(name)).toBeNull();
		}
		// Ordinary headers must be untouched.
		expect(sent.get("content-type")).toBe("application/json");
		expect(sent.get("accept")).toBe("application/json");
	}

	it("strips client hop metadata on the headers-param branch", async () => {
		const getSeen = captureOutboundHeaders();
		await makeProxyRequest(
			"https://example.invalid/v1/messages",
			"POST",
			withClientHopMetadata(new Headers()),
			() => undefined,
			false,
		);
		expectHopMetadataSwept(getSeen());
	});

	it("strips client hop metadata on the Request-target branch", async () => {
		const getSeen = captureOutboundHeaders();
		const req = new Request("https://example.invalid/v1/responses", {
			method: "POST",
			headers: withClientHopMetadata(new Headers()),
			body: "{}",
		});
		await makeProxyRequest(req);
		expectHopMetadataSwept(getSeen());
	});

	it("keeps the jar's own cookies while dropping the client's", async () => {
		chatGptCloudflareCookieJar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			new Response("{}", {
				headers: { "set-cookie": "cf_clearance=jar-value; Path=/" },
			}),
		);
		const getSeen = captureOutboundHeaders();
		const req = new Request("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST",
			headers: withClientHopMetadata(new Headers()),
			body: "{}",
		});
		await makeProxyRequest(req);

		const cookie = getSeen().get("cookie");
		expect(cookie).toContain("cf_clearance=jar-value");
		expect(cookie).not.toContain("cmx_session");
	});
});

describe("makeProxyRequest — synthetic local response", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("unwraps synthetic response without calling fetch", async () => {
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return new Response("{}", { status: 200 });
		}) as typeof globalThis.fetch;

		const syntheticHeaders = new Headers();
		syntheticHeaders.set("content-type", "application/json");
		syntheticHeaders.set("x-clankermux-synthetic-response", "true");
		syntheticHeaders.set("x-clankermux-synthetic-status", "200");
		const req = new Request("https://clankermux.local/codex/count_tokens", {
			method: "POST",
			headers: syntheticHeaders,
			body: JSON.stringify({ input_tokens: 42 }),
		});
		const resp = await makeProxyRequest(req);
		expect(fetchCalled).toBeFalse();
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as { input_tokens: number };
		expect(body.input_tokens).toBe(42);
	});

	it("does NOT unwrap a non-clankermux.local request even with synthetic markers", async () => {
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return new Response("{}", { status: 200 });
		}) as typeof globalThis.fetch;

		const headers = new Headers();
		headers.set("content-type", "application/json");
		headers.set("x-clankermux-synthetic-response", "true");
		headers.set("x-clankermux-synthetic-status", "200");
		const req = new Request("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers,
			body: "{}",
		});
		await makeProxyRequest(req).catch(() => {}); // may throw on network; we just want to verify fetch was called
		expect(fetchCalled).toBeTrue();
	});

	it("does NOT unwrap a host that merely prefixes the trusted origin", async () => {
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return new Response("{}", { status: 200 });
		}) as typeof globalThis.fetch;

		const headers = new Headers();
		headers.set("content-type", "application/json");
		headers.set("x-clankermux-synthetic-response", "true");
		headers.set("x-clankermux-synthetic-status", "200");
		// clankermux.local.evil begins with the trusted string but is a different
		// (attacker-controlled) host — exact-origin matching must reject it.
		const req = new Request(
			"https://clankermux.local.evil/codex/count_tokens",
			{
				method: "POST",
				headers,
				body: "{}",
			},
		);
		await makeProxyRequest(req).catch(() => {});
		expect(fetchCalled).toBeTrue();
	});

	it("clamps invalid synthetic-status to 200", async () => {
		const headers = new Headers();
		headers.set("content-type", "application/json");
		headers.set("x-clankermux-synthetic-response", "true");
		headers.set("x-clankermux-synthetic-status", "999");
		const req = new Request("https://clankermux.local/codex/count_tokens", {
			method: "POST",
			headers,
			body: "{}",
		});
		const resp = await makeProxyRequest(req);
		expect(resp.status).toBe(200);
	});
});
