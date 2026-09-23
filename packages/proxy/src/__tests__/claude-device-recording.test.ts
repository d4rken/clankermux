/**
 * The Claude Code device_id is remembered per account only once a request
 * that carried it finished as a successful client stream, against the account
 * that served it.
 */
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
} from "bun:test";
import type { Account } from "@clankermux/types";
import { ClaudeDeviceRegistry } from "../claude-device-registry";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { forwardToClient } from "../response-handler";
import {
	callHandleProxy,
	makeAccount,
	makeContext,
} from "./fixtures/proxy-terminal-harness";

const enc = new TextEncoder();
const MODEL = "claude-haiku-4-5";
const DEVICE = "e01ccdf3".repeat(8);
const CLI_UA = "claude-cli/2.1.280 (external, cli)";

const MESSAGE_START = `event: message_start\ndata: {"type":"message_start","message":{"model":"${MODEL}","usage":{"input_tokens":5}}}\n\n`;
const MESSAGE_DELTA =
	'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';
const MESSAGE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const RATE_LIMIT_FRAME =
	'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n';

function sse(chunks: string[], status = 200): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
				controller.close();
			},
		}),
		{ status, headers: { "content-type": "text/event-stream" } },
	);
}

function forwardCtx(registry: ClaudeDeviceRegistry) {
	return {
		strategy: {},
		dbOps: {
			markAccountRateLimited: async () => 1,
			markAccountRateLimitedDeadlineOnly: async () => {},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			updateRequestUsage: async () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
		},
		runtime: { port: 8080, tlsEnabled: false },
		config: { getStorePayloads: () => false },
		provider: { name: "anthropic", isStreamingResponse: () => true },
		refreshInFlight: new Map<string, Promise<string>>(),
		asyncWriter: { enqueue: async (job: () => unknown) => void job() },
		requestRecorder: {
			begin: () => {},
			captureResponseChunk: () => {},
			finishTransport: () => {},
			attachUsageSummary: () => {},
			markUsageUnavailable: () => {},
		},
		claudeDevices: registry,
	} as never;
}

async function forward(
	registry: ClaudeDeviceRegistry,
	response: Response,
	options: { internal?: boolean; claudeDeviceId?: string | null } = {},
): Promise<void> {
	const forwarded = await forwardToClient(
		{
			requestId: `req-${Math.random()}`,
			method: "POST",
			path: "/v1/messages",
			account: makeAccount({ id: "served" }) as Account,
			requestHeaders: new Headers({ "user-agent": CLI_UA }),
			requestBody: enc.encode("{}").buffer as ArrayBuffer,
			internal: options.internal ?? false,
			claudeDeviceId:
				options.claudeDeviceId === undefined ? DEVICE : options.claudeDeviceId,
			response,
			timestamp: Date.now(),
			retryAttempt: 0,
			failoverAttempts: 0,
		},
		forwardCtx(registry),
	);
	await forwarded.text();
}

describe("device_id recording at the client stream outcome", () => {
	it("records on a successful stream, against the serving account", async () => {
		const registry = new ClaudeDeviceRegistry();
		await forward(registry, sse([MESSAGE_START, MESSAGE_DELTA, MESSAGE_STOP]));
		expect(registry.deviceIdFor("served")).toBe(DEVICE);
	});

	it("does not record a 200 stream that carried an error frame", async () => {
		const registry = new ClaudeDeviceRegistry();
		await forward(registry, sse([MESSAGE_START, RATE_LIMIT_FRAME]));
		expect(registry.deviceIdFor("served")).toBeNull();
	});

	it("does not record a non-2xx response", async () => {
		const registry = new ClaudeDeviceRegistry();
		await forward(registry, sse([RATE_LIMIT_FRAME], 429));
		expect(registry.deviceIdFor("served")).toBeNull();
	});

	it("does not record an internal dispatch", async () => {
		const registry = new ClaudeDeviceRegistry();
		await forward(registry, sse([MESSAGE_START, MESSAGE_DELTA, MESSAGE_STOP]), {
			internal: true,
		});
		expect(registry.deviceIdFor("served")).toBeNull();
	});

	it("keeps the known device when a request carried none", async () => {
		const registry = new ClaudeDeviceRegistry();
		registry.record("served", DEVICE);
		await forward(registry, sse([MESSAGE_START, MESSAGE_DELTA, MESSAGE_STOP]), {
			claudeDeviceId: null,
		});
		expect(registry.deviceIdFor("served")).toBe(DEVICE);
	});
});

describe("device_id recording through the pipeline", () => {
	let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | null =
		null;

	beforeAll(async () => {
		await import("./fixtures/routing-harness");
	});

	beforeEach(() => {
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		fetchSpy = null;
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
	});

	it("records only the account that served the stream after a failover", async () => {
		const failing = makeAccount({ id: "failing", api_key: "key-failing" });
		const serving = makeAccount({
			id: "serving",
			api_key: "key-serving",
			priority: 1,
		});
		const ctx = Object.assign(makeContext([failing, serving]), {
			claudeDevices: new ClaudeDeviceRegistry(),
		});
		const keys: string[] = [];
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: Request | string | URL,
			init?: RequestInit,
		) => {
			const outgoing = new Request(input, init);
			if (!outgoing.url.includes("api.anthropic.com"))
				return new Response("unavailable", { status: 500 });
			const key = outgoing.headers.get("x-api-key") ?? "";
			keys.push(key);
			return key === "key-failing"
				? Response.json(
						{ type: "error", error: { type: "api_error", message: "boom" } },
						{ status: 500 },
					)
				: sse([MESSAGE_START, MESSAGE_DELTA, MESSAGE_STOP]);
		}) as typeof fetch);

		const response = await callHandleProxy(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json", "user-agent": CLI_UA },
				body: JSON.stringify({
					model: MODEL,
					max_tokens: 16,
					stream: true,
					messages: [{ role: "user", content: "hello" }],
					metadata: {
						user_id: JSON.stringify({
							device_id: DEVICE,
							account_uuid: "",
							session_id: "8644f453-0000-4000-8000-000000000000",
						}),
					},
				}),
			}),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(response.status).toBe(200);
		await response.text();

		expect(keys).toContain("key-failing");
		expect(keys.at(-1)).toBe("key-serving");
		expect(ctx.claudeDevices.deviceIdFor("serving")).toBe(DEVICE);
		expect(ctx.claudeDevices.deviceIdFor("failing")).toBeNull();
	});
});
