import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { IMAGE_REMOVED_MARKER } from "@clankermux/openai-formats";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type { Account, RequestMeta } from "@clankermux/types";
import { proxyWithAccount } from "../../__tests__/fixtures/routing-harness";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import type { ProxyContext } from "../proxy-types";

/**
 * A text-only OpenAI-chat model refuses image_url parts. The attempt retries
 * once on the same account with the images replaced by a marker, building on
 * whatever body it last sent so a cache_control repair is never undone.
 */

const MODEL = "deepseek-chat";

let accountSeq = 0;
function makeAccount(): Account {
	const id = `image-repair-${++accountSeq}`;
	return canonicalAccount({
		id,
		name: id,
		provider: "openai-compatible",
		api_key: "test-key",
		refresh_token: "",
		created_at: Date.now(),
		custom_endpoint: "https://openrouter.ai/api/v1",
	});
}

function makeContext(account: Account): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			getAllAccounts: mock(async () => [account]),
			getAccount: mock(async (id: string) =>
				id === account.id ? account : null,
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
			name: "openai-compatible",
			canHandle: () => true,
			buildUrl: () => "https://openrouter.ai/api/v1/chat/completions",
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
		config: { getStorePayloads: () => false } as never,
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

function body(opts: { image: boolean; cacheControl: boolean }): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: MODEL,
			max_tokens: 10,
			messages: [
				{
					role: "user",
					content: [
						...(opts.image
							? [
									{
										type: "image",
										source: {
											type: "base64",
											media_type: "image/png",
											data: "iVBORw0KGgo=",
										},
									},
								]
							: []),
						{
							type: "text",
							text: "what is this?",
							...(opts.cacheControl
								? { cache_control: { type: "ephemeral" } }
								: {}),
						},
					],
				},
			],
		}),
	).buffer;
}

const refusal = (status: number, message: string) =>
	new Response(JSON.stringify({ error: { message } }), {
		status,
		headers: { "content-type": "application/json" },
	});
const IMAGE_REFUSAL = () =>
	refusal(400, "messages[0]: unknown variant `image_url`, expected `text`");
const CACHE_REFUSAL = () =>
	refusal(400, "cache_control: Extra inputs are not permitted");
const OK = () =>
	new Response(
		JSON.stringify({
			id: "c1",
			object: "chat.completion",
			model: MODEL,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "a cat" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

/** Answers the queued responses in order and records every sent body. */
function upstream(responses: Array<() => Response>) {
	const sent: string[] = [];
	globalThis.fetch = mock(
		async (input: Request | string | URL, init?: RequestInit) => {
			sent.push(
				input instanceof Request
					? await input.clone().text()
					: String(init?.body),
			);
			const next = responses.shift();
			if (!next) throw new Error("unexpected extra upstream send");
			return next();
		},
	) as unknown as typeof fetch;
	return sent;
}

async function run(account: Account, payload: ArrayBuffer) {
	const meta: RequestMeta = {
		id: `req-${account.id}-${Math.random()}`,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
	return proxyWithAccount(
		new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: payload,
			headers: { "Content-Type": "application/json" },
		}),
		new URL("https://proxy.local/v1/messages"),
		account,
		meta,
		payload,
		() => undefined,
		0,
		makeContext(account),
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		{ onOutcome: () => {} },
	);
}

const hasImage = (text: string) => text.includes('"image_url"');
const hasCacheControl = (text: string) => text.includes('"cache_control"');

describe("proxyWithAccount — image input repair", () => {
	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("retries once without images when the model refuses them", async () => {
		const sent = upstream([IMAGE_REFUSAL, OK]);
		const res = await run(
			makeAccount(),
			body({ image: true, cacheControl: false }),
		);
		expect(res?.status).toBe(200);
		expect(sent).toHaveLength(2);
		expect(hasImage(sent[0] ?? "")).toBe(true);
		expect(hasImage(sent[1] ?? "")).toBe(false);
		expect(sent[1]).toContain(IMAGE_REMOVED_MARKER);
	});

	it("retries on OpenRouter's 404 for image input", async () => {
		const sent = upstream([
			() => refusal(404, "No endpoints found that support image input"),
			OK,
		]);
		const res = await run(
			makeAccount(),
			body({ image: true, cacheControl: false }),
		);
		expect(res?.status).toBe(200);
		expect(hasImage(sent[1] ?? "")).toBe(false);
	});

	it.each([
		["image refusal first", [IMAGE_REFUSAL, CACHE_REFUSAL, OK]],
		["cache_control refusal first", [CACHE_REFUSAL, IMAGE_REFUSAL, OK]],
	])("applies both repairs cumulatively: %s", async (_label, responses) => {
		const sent = upstream(responses);
		const res = await run(
			makeAccount(),
			body({ image: true, cacheControl: true }),
		);
		expect(res?.status).toBe(200);
		expect(sent).toHaveLength(3);
		expect(hasImage(sent[2] ?? "")).toBe(false);
		expect(hasCacheControl(sent[2] ?? "")).toBe(false);
	});

	it("keeps a memoized cache_control strip when it removes images", async () => {
		const account = makeAccount();
		upstream([CACHE_REFUSAL, OK]);
		await run(account, body({ image: false, cacheControl: true }));
		const sent = upstream([IMAGE_REFUSAL, OK]);
		const res = await run(account, body({ image: true, cacheControl: true }));
		expect(res?.status).toBe(200);
		expect(sent).toHaveLength(2);
		expect(hasCacheControl(sent[0] ?? "")).toBe(false);
		expect(hasCacheControl(sent[1] ?? "")).toBe(false);
		expect(hasImage(sent[1] ?? "")).toBe(false);
	});

	it("retries at most once per repair", async () => {
		const sent = upstream([IMAGE_REFUSAL, IMAGE_REFUSAL]);
		const res = await run(
			makeAccount(),
			body({ image: true, cacheControl: false }),
		);
		expect(res?.status).not.toBe(200);
		expect(sent).toHaveLength(2);
	});

	it("does not retry a request that carried no image", async () => {
		const sent = upstream([IMAGE_REFUSAL]);
		await run(makeAccount(), body({ image: false, cacheControl: false }));
		expect(sent).toHaveLength(1);
	});

	it("does not retry a malformed-image refusal", async () => {
		const sent = upstream([
			() => refusal(400, "Invalid image_url: invalid base64 data"),
		]);
		await run(makeAccount(), body({ image: true, cacheControl: false }));
		expect(sent).toHaveLength(1);
	});
});
