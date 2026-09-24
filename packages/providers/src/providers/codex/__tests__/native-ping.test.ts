import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
import { CODEX_USER_AGENT, CODEX_VERSION } from "../client-identity";
import { sendCodexNativePing } from "../native-ping";
import { CODEX_PING_MODEL } from "../provider";

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
		// The Codex backend rejects `max_output_tokens` and `reasoning.effort:
		// "minimal"` (both 400) — the ping must omit the former and use "none".
		expect(body.max_output_tokens).toBeUndefined();
		expect(body.reasoning).toEqual({ effort: "none" });
		expect(body.instructions).toBe("ping");
		expect(body.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "." }] },
		]);

		const headers = new Headers(recorded?.init.headers as HeadersInit);
		expect(headers.get("Authorization")).toBe("Bearer test-token");
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(headers.get("Version")).toBe(CODEX_VERSION);
		expect(headers.get("Openai-Beta")).toBeNull();
		expect(headers.get("User-Agent")).toBe(CODEX_USER_AGENT);
		expect(headers.get("originator")).toBe("codex_exec");
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

	describe("rejected ping", () => {
		let warn: ReturnType<typeof spyOn>;

		beforeEach(() => {
			warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		});

		afterEach(() => {
			warn.mockRestore();
		});

		/** The rejection is logged in the background; wait for it. */
		async function until(condition: () => boolean): Promise<void> {
			const deadline = Date.now() + 3_000;
			while (!condition()) {
				if (Date.now() > deadline) throw new Error("condition never held");
				await Bun.sleep(5);
			}
		}

		it("logs the upstream error body with the status", async () => {
			const error = JSON.stringify({
				detail: "The 'gpt-5.4-mini' model is not supported.",
			});
			globalThis.fetch = makeMockFetch(
				new Response(error, { status: 400, statusText: "Bad Request" }),
			);

			const response = await sendCodexNativePing(
				"test-token",
				"https://example.test/codex/responses",
			);

			expect(response.status).toBe(400);
			expect(response.body).toBeNull();
			await until(() => warn.mock.calls.length > 0);
			expect(warn).toHaveBeenCalledTimes(1);
			const logged = warn.mock.calls[0].join(" ");
			expect(logged).toContain("400");
			expect(logged).toContain(error);
		});

		it("reads at most a bounded prefix of the error body, then cancels it", async () => {
			let cancelled = false;
			const chunk = new TextEncoder().encode("x".repeat(1024));
			const endless = new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(chunk);
				},
				cancel() {
					cancelled = true;
				},
			});
			globalThis.fetch = makeMockFetch(
				new Response(endless, { status: 400, statusText: "Bad Request" }),
			);

			await sendCodexNativePing(
				"test-token",
				"https://example.test/codex/responses",
			);

			await until(() => cancelled);
			const logged = warn.mock.calls[0].join(" ");
			expect(logged.length).toBeLessThan(4 * 1024);
		});

		it("returns without waiting for an error body that never arrives, then gives it up", async () => {
			let cancelled = false;
			const stalled = new ReadableStream<Uint8Array>({
				cancel() {
					cancelled = true;
				},
			});
			globalThis.fetch = makeMockFetch(
				new Response(stalled, { status: 400, statusText: "Bad Request" }),
			);

			const startedAt = Date.now();
			const response = await sendCodexNativePing(
				"test-token",
				"https://example.test/codex/responses",
			);

			expect(response.status).toBe(400);
			expect(Date.now() - startedAt).toBeLessThan(200);
			expect(cancelled).toBe(false);

			await until(() => cancelled);
			expect(warn).toHaveBeenCalledTimes(1);
		});

		it("still logs the status when the error body cannot be read", async () => {
			const response = new Response("locked", {
				status: 400,
				statusText: "Bad Request",
			});
			response.body?.getReader();
			globalThis.fetch = makeMockFetch(response);

			const result = await sendCodexNativePing(
				"test-token",
				"https://example.test/codex/responses",
			);

			expect(result.status).toBe(400);
			await until(() => warn.mock.calls.length > 0);
			expect(warn.mock.calls[0].join(" ")).toContain("400");
		});

		it("does not read or log a successful ping's body", async () => {
			let pulled = false;
			const body = new ReadableStream<Uint8Array>(
				{
					pull() {
						pulled = true;
					},
				},
				{ highWaterMark: 0 },
			);
			globalThis.fetch = makeMockFetch(new Response(body, { status: 200 }));

			await sendCodexNativePing(
				"test-token",
				"https://example.test/codex/responses",
			);

			expect(pulled).toBe(false);
			expect(warn).not.toHaveBeenCalled();
		});
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
