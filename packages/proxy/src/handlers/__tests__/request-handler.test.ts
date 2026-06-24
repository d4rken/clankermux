/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CodexProvider, OpenAICompatibleProvider } from "@clankermux/providers";
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
