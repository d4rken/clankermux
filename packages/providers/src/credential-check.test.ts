import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { baseUrlShapeProblem } from "@clankermux/core";
import { mockFetch } from "@clankermux/test-support";
import {
	CREDENTIAL_CHECK_TIMEOUT_MS,
	type CredentialCheckOutcome,
	catalogueCheck,
	GROK_MODELS_ENDPOINT,
	mimoCatalogueUrl,
	openRouterKeyCheck,
} from "./credential-check";
import {
	fetchOpenRouterMetadata,
	OPENROUTER_KEY_ENDPOINT,
} from "./providers/openrouter/metadata";

const KEY = "sk-secret-credential";
const input = { apiKey: KEY, customEndpoint: null };
const grok = catalogueCheck("xAI model catalogue", GROK_MODELS_ENDPOINT);
const mimo = catalogueCheck("MiMo model catalogue", mimoCatalogueUrl);

let spies: { mockRestore(): void }[] = [];
afterEach(() => {
	for (const spy of spies) spy.mockRestore();
	spies = [];
});

function stubFetch(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
) {
	const spy = spyOn(globalThis, "fetch").mockImplementation(mockFetch(impl));
	spies.push(spy);
	return spy;
}

/** A fetch that never answers on its own, only rejecting when its signal aborts. */
function hangingFetch() {
	return stubFetch(
		(_input, init) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return;
				if (signal.aborted) reject(signal.reason);
				signal.addEventListener("abort", () => reject(signal.reason));
			}),
	);
}

function expectNoLeak(outcome: CredentialCheckOutcome) {
	if (outcome.status === "valid") return;
	expect(outcome.detail).not.toContain(KEY);
	expect(outcome.detail).not.toContain("http");
	expect(outcome.detail).not.toContain("echoed-body");
}

describe("catalogueCheck status classification", () => {
	for (const [status, expected] of [
		[200, "valid"],
		[204, "valid"],
		[401, "rejected"],
		[403, "rejected"],
		[404, "rejected"],
		[429, "unverified"],
		[400, "unverified"],
		[500, "unverified"],
		[502, "unverified"],
	] as const) {
		it(`classifies HTTP ${status} as ${expected}`, async () => {
			stubFetch(
				async () =>
					new Response(status === 204 ? null : `echoed-body ${KEY}`, {
						status,
					}),
			);
			const outcome = await grok.run(input, new AbortController().signal);
			expect(outcome.status).toBe(expected);
			expectNoLeak(outcome);
		});
	}

	it("GETs the resolved URL with a Bearer key, no redirects and a signal", async () => {
		const fetchSpy = stubFetch(async () => new Response("{}"));
		await grok.run(input, new AbortController().signal);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.x.ai/v1/models");
		expect(new Headers(init.headers).get("authorization")).toBe(
			`Bearer ${KEY}`,
		);
		expect(init.redirect).toBe("error");
		expect(init.method ?? "GET").toBe("GET");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("cancels the response body on success and on failure", async () => {
		for (const status of [200, 401, 500]) {
			let cancelled = false;
			stubFetch(
				async () =>
					new Response(
						new ReadableStream({
							cancel() {
								cancelled = true;
							},
						}),
						{ status },
					),
			);
			await grok.run(input, new AbortController().signal);
			expect(cancelled).toBe(true);
			for (const spy of spies) spy.mockRestore();
			spies = [];
		}
	});

	it("classifies a thrown network error as unverified without echoing it", async () => {
		stubFetch(async () => {
			throw new TypeError(`getaddrinfo ENOTFOUND https://api.x.ai ${KEY}`);
		});
		const outcome = await grok.run(input, new AbortController().signal);
		expect(outcome.status).toBe("unverified");
		expectNoLeak(outcome);
	});

	it("classifies a refused redirect as unverified", async () => {
		const fetchSpy = stubFetch(async (_input, init) => {
			if (init?.redirect === "error")
				throw new TypeError("unexpected redirect to https://elsewhere");
			return new Response(null, { status: 200 });
		});
		const outcome = await grok.run(input, new AbortController().signal);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(outcome.status).toBe("unverified");
		expectNoLeak(outcome);
	});

	it(`classifies a ${CREDENTIAL_CHECK_TIMEOUT_MS}ms timeout as unverified`, async () => {
		const timer = new AbortController();
		const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(
			timer.signal,
		);
		spies.push(timeoutSpy);
		hangingFetch();
		const pending = grok.run(input, new AbortController().signal);
		timer.abort(new DOMException("The operation timed out.", "TimeoutError"));
		const outcome = await pending;
		expect(timeoutSpy).toHaveBeenCalledWith(5_000);
		expect(outcome).toEqual({
			status: "unverified",
			detail: expect.stringContaining("5s"),
		});
	});

	it("classifies a caller abort mid-probe as unverified", async () => {
		hangingFetch();
		const caller = new AbortController();
		const pending = grok.run(input, caller.signal);
		caller.abort();
		const outcome = await pending;
		expect(outcome.status).toBe("unverified");
		expect(outcome).not.toEqual(
			expect.objectContaining({ detail: expect.stringContaining("5s") }),
		);
	});

	it("classifies an already-aborted caller signal as unverified", async () => {
		hangingFetch();
		const outcome = await grok.run(input, AbortSignal.abort());
		expect(outcome.status).toBe("unverified");
	});

	it("classifies an endpoint that is not a URL as unverified without dialling", async () => {
		const fetchSpy = stubFetch(async () => new Response(null));
		const outcome = await mimo.run(
			{ apiKey: KEY, customEndpoint: `not a url ${KEY}` },
			new AbortController().signal,
		);
		expect(outcome.status).toBe("unverified");
		expectNoLeak(outcome);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("exposes the surface name for the refusal message", () => {
		expect(mimo.surface).toBe("MiMo model catalogue");
		expect(openRouterKeyCheck.surface).toBeString();
	});
});

describe("api.anthropic.com guard", () => {
	for (const endpoint of [
		"https://api.anthropic.com/anthropic",
		"https://API.ANTHROPIC.COM/v1",
		"https://api.anthropic.com./anthropic",
	]) {
		it(`skips the probe for ${endpoint}`, async () => {
			const fetchSpy = stubFetch(async () => new Response(null));
			const outcome = await mimo.run(
				{ apiKey: KEY, customEndpoint: endpoint },
				new AbortController().signal,
			);
			expect(outcome.status).toBe("skipped");
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	}
});

describe("mimoCatalogueUrl", () => {
	for (const [endpoint, expected] of [
		[
			"https://token-plan-cn.xiaomimimo.com/anthropic",
			"https://token-plan-cn.xiaomimimo.com/v1/models",
		],
		[
			"https://token-plan-cn.xiaomimimo.com/anthropic/v1",
			"https://token-plan-cn.xiaomimimo.com/v1/models",
		],
		[
			"https://token-plan-cn.xiaomimimo.com",
			"https://token-plan-cn.xiaomimimo.com/v1/models",
		],
		["https://h/dep/anthropic", "https://h/dep/v1/models"],
		["https://h/dep/anthropic/v1/", "https://h/dep/v1/models"],
		[
			"https://token-plan-ams.xiaomimimo.com/anthropic//",
			"https://token-plan-ams.xiaomimimo.com/v1/models",
		],
		[null, "https://token-plan-sgp.xiaomimimo.com/v1/models"],
	] as const) {
		it(`maps ${endpoint} to ${expected}`, () => {
			expect(mimoCatalogueUrl(endpoint).toString()).toBe(expected);
		});
	}

	it("returns a URL for a base the shape guard rejects, leaving the decision to the caller", () => {
		const base = "https://h/anthropic?region=cn";
		expect(baseUrlShapeProblem(new URL(base))).toBe(
			"must not carry a query string",
		);
		let url: URL | undefined;
		expect(() => {
			url = mimoCatalogueUrl(base);
		}).not.toThrow();
		expect(url).toBeInstanceOf(URL);
	});
});

describe("OpenRouter key check", () => {
	it("returns valid with the parsed, redacted metadata on 200", async () => {
		const fetchSpy = stubFetch(async () =>
			Response.json({
				data: { label: KEY, creator_user_id: "user_123", usage: 2 },
			}),
		);
		const outcome = await openRouterKeyCheck.run(
			input,
			new AbortController().signal,
		);
		expect(outcome).toMatchObject({
			status: "valid",
			metadata: { label: null, creatorUserId: "user_123", usageUsd: 2 },
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(OPENROUTER_KEY_ENDPOINT);
		expect(init.redirect).toBe("error");
	});

	it("stays valid, without metadata, when a 200 body is not JSON", async () => {
		stubFetch(async () => new Response("not json"));
		const outcome = await openRouterKeyCheck.run(
			input,
			new AbortController().signal,
		);
		expect(outcome.status).toBe("valid");
		expect(outcome).not.toHaveProperty("metadata");
	});

	it("rejects on 401", async () => {
		stubFetch(async () => new Response(`echoed-body ${KEY}`, { status: 401 }));
		const outcome = await openRouterKeyCheck.run(
			input,
			new AbortController().signal,
		);
		expect(outcome.status).toBe("rejected");
		expectNoLeak(outcome);
	});

	it("is unverified on 500 and on a network error", async () => {
		stubFetch(async () => new Response("echoed-body", { status: 500 }));
		expect(
			(await openRouterKeyCheck.run(input, new AbortController().signal))
				.status,
		).toBe("unverified");
		for (const spy of spies) spy.mockRestore();
		spies = [];
		stubFetch(async () => {
			throw new Error(`network ${KEY}`);
		});
		const outcome = await openRouterKeyCheck.run(
			input,
			new AbortController().signal,
		);
		expect(outcome.status).toBe("unverified");
		expectNoLeak(outcome);
	});

	it("leaves fetchOpenRouterMetadata failing open with its own timeout", async () => {
		const timeoutSpy = spyOn(AbortSignal, "timeout");
		spies.push(timeoutSpy);
		stubFetch(async () => Response.json({ data: { label: "work", usage: 1 } }));
		expect(await fetchOpenRouterMetadata(KEY)).toMatchObject({
			label: "work",
			usageUsd: 1,
		});
		expect(timeoutSpy).toHaveBeenCalledWith(5_000);
		for (const spy of spies) spy.mockRestore();
		spies = [];
		stubFetch(async () => new Response(null, { status: 500 }));
		expect(await fetchOpenRouterMetadata(KEY)).toBeNull();
	});
});
