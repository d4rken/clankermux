/**
 * The keepalive of an official Anthropic account is Claude Code's own quota
 * probe: `max_tokens: 1`, content `"quota"`, and the account's recorded
 * device in `metadata.user_id` beside a fresh session id that also goes out
 * as `x-claude-code-session-id`.
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
import { CLAUDE_MODEL_IDS } from "@clankermux/core";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";
import { ClaudeDeviceRegistry } from "../claude-device-registry";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { makeAccount, makeContext } from "./fixtures/proxy-terminal-harness";

const DEVICE = "e01ccdf3".repeat(8);
const ACCOUNT_UUID = "0b7c1a52-3f0e-4d7a-9c55-2d8e6f1a9b40";
const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Row = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	custom_endpoint: string | null;
	paused: number;
	auto_pause_on_overage_enabled: number;
	pause_reason: string | null;
};

function row(patch: Partial<Row> = {}): Row {
	return {
		id: "acc-1",
		name: "backup",
		provider: "anthropic",
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
		rate_limit_reset: null,
		custom_endpoint: null,
		paused: 0,
		auto_pause_on_overage_enabled: 0,
		pause_reason: null,
		...patch,
	};
}

const db = {
	query: async () => [{ auto_refresh_enabled: 1 }],
	run: async () => {},
	runWithChanges: async () => 1,
};

type Prime = { sendTranslatedClaudePrime(row: Row): Promise<boolean> };

function scheduler(
	context: object,
	dispatch: (req: Request, ...rest: never[]) => Promise<Response>,
): Prime {
	return new AutoRefreshScheduler(
		db as never,
		context as never,
		undefined,
		dispatch as never,
	) as never as Prime;
}

async function dispatched(
	statuses: number[],
	patch: Partial<Row> = {},
	registry = new ClaudeDeviceRegistry(),
): Promise<Array<{ headers: Headers; body: string }>> {
	const seen: Array<{ headers: Headers; body: string }> = [];
	const context = {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
		claudeDevices: registry,
	};
	await scheduler(context, async (req) => {
		seen.push({ headers: req.headers, body: await req.text() });
		return new Response("", { status: statuses[seen.length - 1] ?? 500 });
	}).sendTranslatedClaudePrime(row(patch));
	return seen;
}

function recorded(accountId = "acc-1"): ClaudeDeviceRegistry {
	const registry = new ClaudeDeviceRegistry();
	registry.record(accountId, DEVICE);
	return registry;
}

describe("Anthropic keepalive quota probe", () => {
	it("is Claude Code's quota probe with the account's device", async () => {
		const [probe] = await dispatched([500], {}, recorded());
		const sessionId = probe.headers.get("x-claude-code-session-id") ?? "";
		expect(sessionId).toMatch(UUID_V4);
		expect(probe.headers.has("x-client-request-id")).toBe(false);
		expect(probe.body).toBe(
			JSON.stringify({
				model: CLAUDE_MODEL_IDS.HAIKU_4_5,
				max_tokens: 1,
				messages: [{ role: "user", content: "quota" }],
				metadata: {
					user_id: `{"device_id":"${DEVICE}","account_uuid":"","session_id":"${sessionId}"}`,
				},
			}),
		);
	});

	it("omits metadata when no device was recorded for the account", async () => {
		const [probe] = await dispatched([500], {}, recorded("other-account"));
		expect(probe.headers.get("x-claude-code-session-id")).toMatch(UUID_V4);
		expect(JSON.parse(probe.body)).toEqual({
			model: CLAUDE_MODEL_IDS.HAIKU_4_5,
			max_tokens: 1,
			messages: [{ role: "user", content: "quota" }],
		});
	});

	it("starts a new session on every probe", async () => {
		const [first] = await dispatched([500], {}, recorded());
		const [second] = await dispatched([500], {}, recorded());
		expect(first.headers.get("x-claude-code-session-id")).not.toBe(
			second.headers.get("x-claude-code-session-id"),
		);
	});

	it("keeps the session and metadata across the 404 model fallback", async () => {
		const [haiku, sonnet] = await dispatched([404, 500], {}, recorded());
		expect(sonnet.headers.get("x-claude-code-session-id")).toBe(
			haiku.headers.get("x-claude-code-session-id"),
		);
		const first = JSON.parse(haiku.body);
		const second = JSON.parse(sonnet.body);
		expect(first.model).toBe(CLAUDE_MODEL_IDS.HAIKU_4_5);
		expect(second.model).toBe(CLAUDE_MODEL_IDS.SONNET_4_5);
		expect(second.metadata).toEqual(first.metadata);
	});

	it("leaves an Anthropic account behind a custom endpoint on the canned prompt", async () => {
		const [probe] = await dispatched(
			[500],
			{ custom_endpoint: "https://relay.example" },
			recorded(),
		);
		expect(probe.headers.has("x-claude-code-session-id")).toBe(false);
		const body = JSON.parse(probe.body);
		expect(body.max_tokens).toBe(10);
		expect(body.metadata).toBeUndefined();
	});

	it("leaves Z.AI on the canned prompt", async () => {
		const [probe] = await dispatched([500], { provider: "zai" }, recorded());
		expect(probe.headers.has("x-claude-code-session-id")).toBe(false);
		const body = JSON.parse(probe.body);
		expect(Object.keys(body)).toEqual(["model", "max_tokens", "messages"]);
		expect(body.max_tokens).toBe(10);
		expect(body.messages[0].content).not.toBe("quota");
	});
});

describe("Anthropic keepalive quota probe through the pipeline", () => {
	let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | null =
		null;
	let upstream: Request[] = [];
	let harness: typeof import("./fixtures/routing-harness");

	beforeAll(async () => {
		harness = await import("./fixtures/routing-harness");
	});

	beforeEach(() => {
		upstream = [];
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: Request | string | URL,
			init?: RequestInit,
		) => {
			const outgoing = new Request(input, init);
			if (outgoing.url !== "https://api.anthropic.com/v1/messages")
				return new Response("unavailable", { status: 500 });
			upstream.push(outgoing);
			return Response.json({
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: CLAUDE_MODEL_IDS.HAIKU_4_5,
				content: [{ type: "text", text: "q" }],
				stop_reason: "max_tokens",
				usage: { input_tokens: 8, output_tokens: 1 },
			});
		}) as typeof fetch);
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		fetchSpy = null;
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
	});

	async function probeThroughPipeline(registry: ClaudeDeviceRegistry) {
		const account = makeAccount({
			id: "acc-1",
			api_key: null,
			access_token: "at",
			expires_at: Date.now() + 3_600_000,
			identity_external_id: ACCOUNT_UUID,
		});
		const ctx = Object.assign(makeContext([account]), {
			claudeDevices: registry,
		});
		// The probe's own spend row; not what this test is about.
		Object.assign(ctx.dbOps, { saveInternalDispatchSpend: async () => {} });
		const ok = await scheduler(ctx, (req, ...rest) =>
			harness.handleProxy(req, ...(rest as unknown as [URL, never])),
		).sendTranslatedClaudePrime(row());
		expect(ok).toBe(true);
		expect(upstream).toHaveLength(1);
		return upstream[0];
	}

	it("sends the routed account's uuid between the device and the session", async () => {
		const sent = await probeThroughPipeline(recorded());
		const sessionId = sent.headers.get("x-claude-code-session-id");
		expect(sessionId).toMatch(UUID_V4);
		const body = await sent.json();
		expect(body.metadata.user_id).toBe(
			`{"device_id":"${DEVICE}","account_uuid":"${ACCOUNT_UUID}","session_id":"${sessionId}"}`,
		);
		expect(body.max_tokens).toBe(1);
		expect(body.messages).toEqual([{ role: "user", content: "quota" }]);
	});

	it("sends no metadata when the account has no recorded device", async () => {
		const sent = await probeThroughPipeline(new ClaudeDeviceRegistry());
		expect(sent.headers.get("x-claude-code-session-id")).toMatch(UUID_V4);
		expect((await sent.json()).metadata).toBeUndefined();
	});
});
