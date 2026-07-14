import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sendCodexNativePing } from "../native-ping";
import { CODEX_PING_MODEL, CODEX_USER_AGENT, CODEX_VERSION } from "../provider";

describe("sendCodexNativePing", () => {
	let originalFetch: typeof fetch;
	let recorded: { url: string; init: RequestInit } | null;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		recorded = null;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const makeMockFetch = (response: Response) => {
		return (async (input: RequestInfo | URL, init?: RequestInit) => {
			recorded = { url: String(input), init: init ?? {} };
			return response;
		}) as unknown as typeof fetch;
	};

	it("builds the exact minimal Codex ping request", async () => {
		globalThis.fetch = makeMockFetch(
			new Response("event: ignored\n\n", { status: 200 }),
		);

		await sendCodexNativePing(
			"test-token",
			"https://example.test/codex/responses",
		);

		expect(recorded).not.toBeNull();
		expect(recorded?.url).toBe("https://example.test/codex/responses");
		expect(recorded?.init.method).toBe("POST");

		const body = JSON.parse(recorded?.init.body as string);
		expect(body.model).toBe(CODEX_PING_MODEL);
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(body.max_output_tokens).toBe(1);
		expect(body.reasoning).toEqual({ effort: "minimal" });
		expect(body.instructions).toBe("ping");
		expect(body.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "." }] },
		]);

		const headers = new Headers(recorded?.init.headers as HeadersInit);
		expect(headers.get("Authorization")).toBe("Bearer test-token");
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(headers.get("Version")).toBe(CODEX_VERSION);
		expect(headers.get("Openai-Beta")).toBe("responses=experimental");
		expect(headers.get("User-Agent")).toBe(CODEX_USER_AGENT);
		expect(headers.get("originator")).toBe("codex_cli_rs");
		expect(headers.get("Accept")).toBe("text/event-stream");
	});

	it("returns a header-only bodyless response and cancels the upstream body", async () => {
		let cancelled = false;
		const upstreamBody = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		globalThis.fetch = makeMockFetch(
			new Response(upstreamBody, {
				status: 200,
				statusText: "OK",
				headers: {
					"x-codex-primary-used-percent": "11",
					"x-codex-primary-window-minutes": "10080",
					"x-codex-primary-reset-at": "1775000000",
				},
			}),
		);

		const response = await sendCodexNativePing(
			"test-token",
			"https://example.test/codex/responses",
		);

		expect(cancelled).toBe(true);
		// Synthetic response is bodyless.
		expect(response.body).toBeNull();
		expect(response.status).toBe(200);
		expect(response.statusText).toBe("OK");
		// All snapshotted headers survive.
		expect(response.headers.get("x-codex-primary-used-percent")).toBe("11");
		expect(response.headers.get("x-codex-primary-window-minutes")).toBe(
			"10080",
		);
		expect(response.headers.get("x-codex-primary-reset-at")).toBe("1775000000");
	});

	it("preserves status and all headers on a 429", async () => {
		globalThis.fetch = makeMockFetch(
			new Response("rate limited", {
				status: 429,
				statusText: "Too Many Requests",
				headers: {
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": "1775000000",
					"x-codex-secondary-used-percent": "82",
					"x-codex-secondary-window-minutes": "10080",
					"x-codex-secondary-reset-at": "1774700000",
				},
			}),
		);

		const response = await sendCodexNativePing(
			"test-token",
			"https://example.test/codex/responses",
		);

		expect(response.status).toBe(429);
		expect(response.statusText).toBe("Too Many Requests");
		expect(response.headers.get("x-codex-primary-used-percent")).toBe("100");
		expect(response.headers.get("x-codex-secondary-reset-at")).toBe(
			"1774700000",
		);
		expect(response.body).toBeNull();
	});

	it("throws before issuing any fetch on an empty token", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		await expect(sendCodexNativePing("")).rejects.toThrow(
			/non-empty access token/,
		);
		expect(called).toBe(false);
	});

	it("throws before issuing any fetch on a whitespace-only token", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		await expect(sendCodexNativePing("   ")).rejects.toThrow(
			/non-empty access token/,
		);
		expect(called).toBe(false);
	});
});
