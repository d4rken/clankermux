/**
 * The SDK bridge's error mapping as a client sees it at the public
 * /wire/openai endpoints, Responses and Chat Completions. Claude Code is a
 * scripted stand-in that makes its model call through the bridge's inner
 * listener, so every inner outcome comes from the real proxy answering a
 * loopback mock upstream. Each case checks the status, Retry-After, JSON
 * before the head versus SSE after it, the message (never Claude Code's
 * credential wording) and the request id the client can look the turn up by.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkBridgeLimits } from "@clankermux/claude-sdk-bridge";
import { clearProviderOverloadCooldown } from "@clankermux/proxy";
import {
	resultMessage,
	streamedMessage,
} from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/fake-sdk";
import { startMockUpstream } from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/mock-upstream";
import {
	callModel,
	type FakeQuery,
	fakeQueryFn,
	giveUp,
	relay,
	startStreaming,
} from "./fixtures/scripted-claude-code";
import { type Gateway, startGateway } from "./fixtures/sdk-bridge-gateway";

const MODEL = "claude-sonnet-5";
const OTHER_MODEL = "claude-opus-5";
/**
 * Fresh account ids per case: the proxy keeps per-account state in memory
 * (cooldown memos, probe gates, affinity), which would outlive a gateway.
 */
function accounts() {
	const n = crypto.randomUUID().slice(0, 8);
	return [
		{
			id: `acct-a-${n}`,
			name: `claude-a-${n}`,
			token: `sk-ant-oat01-ACCT-A-${n}`,
		},
		{
			id: `acct-b-${n}`,
			name: `claude-b-${n}`,
			token: `sk-ant-oat01-ACCT-B-${n}`,
		},
	];
}
const CREDENTIAL_WORDING = /failed to authenticate|x-api-key|\/login/i;

const mock = startMockUpstream();
afterAll(() => mock.stop());

type Endpoint = "responses" | "chat";

interface Harness {
	gw: Gateway;
	sdk: ReturnType<typeof fakeQueryFn>;
	limits: Partial<SdkBridgeLimits>;
	root: string;
}

let current: Harness | null = null;
afterEach(async () => {
	mock.clearFailures();
	if (!current) return;
	const { gw, root } = current;
	current = null;
	await gw.stop();
	expect(gw.blockedEgress.filter((h) => /anthropic|claude/i.test(h))).toEqual(
		[],
	);
	rmSync(root, { recursive: true, force: true });
});

async function harness(
	limits: Partial<SdkBridgeLimits> = {},
): Promise<Harness> {
	// A 529 opens the process-wide provider breaker; no case may inherit one.
	clearProviderOverloadCooldown();
	const sdk = fakeQueryFn();
	const root = mkdtempSync(join(tmpdir(), "cmx-bridge-errors-"));
	const gw = await startGateway({
		root,
		upstreamUrl: mock.url,
		accounts: accounts(),
		models: [MODEL, OTHER_MODEL],
		bridge: {
			queryFn: sdk.fn,
			claudeExecutablePath: "/opt/fake/claude",
			limits: () => limits,
			timing: {
				headHoldMs: 2_000,
				pingIntervalMs: 500,
				settleWaitMs: 500,
				idleTimeoutMs: 20_000,
				exitGraceMs: 50,
			},
		},
	});
	current = { gw, sdk, limits, root };
	return current;
}

function send(
	gw: Gateway,
	endpoint: Endpoint,
	signal?: AbortSignal,
	fields: Record<string, unknown> = {},
): Promise<Response> {
	const path =
		endpoint === "chat"
			? "/wire/openai/v1/chat/completions"
			: "/wire/openai/v1/responses";
	const body =
		endpoint === "chat"
			? {
					model: MODEL,
					stream: true,
					messages: [{ role: "user", content: "hello" }],
					...fields,
				}
			: { model: MODEL, stream: true, input: "hello", ...fields };
	return fetch(`${gw.url}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${gw.apiKey}`,
			"content-type": "application/json",
			"user-agent": "pi/0.86.0",
			session_id: `errors-${crypto.randomUUID()}`,
		},
		body: JSON.stringify(body),
		...(signal ? { signal } : {}),
	});
}

interface Seen {
	status: number;
	retryAfter: string | null;
	requestId: string | null;
	contentType: string;
	text: string;
}

async function read(response: Response): Promise<Seen> {
	return {
		status: response.status,
		retryAfter: response.headers.get("retry-after"),
		requestId: response.headers.get("x-clankermux-request-id"),
		contentType: response.headers.get("content-type") ?? "",
		text: await response.text(),
	};
}

/** A JSON error before the head: the error envelope's message, type and code. */
function jsonError(seen: Seen): {
	message: string;
	type: string;
	code?: string;
} {
	expect(seen.contentType).toContain("application/json");
	const body = JSON.parse(seen.text) as {
		error: { message: string; type: string; code?: string };
	};
	expect(seen.text).not.toMatch(CREDENTIAL_WORDING);
	return body.error;
}

/**
 * The error an SSE stream ended with: Responses' `response.failed` error, or
 * Chat's error envelope.
 */
function streamedError(
	seen: Seen,
	endpoint: Endpoint,
): Record<string, unknown> {
	expect(seen.status).toBe(200);
	expect(seen.contentType).toContain("text/event-stream");
	expect(seen.text).not.toMatch(CREDENTIAL_WORDING);
	const payloads = seen.text
		.split("\n")
		.filter((line) => line.startsWith("data: {"))
		.map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
	const last =
		endpoint === "responses"
			? payloads.find((p) => p.type === "response.failed")?.response
			: payloads.at(-1);
	return (last as { error: Record<string, unknown> }).error;
}

/** The turn's leg the client's request id names. */
async function legOf(gw: Gateway, requestId: string | null) {
	expect(requestId).toBeTruthy();
	const [leg] = await gw.query<{
		turn_id: string;
		http_status: number | null;
		error_phase: string | null;
		error_type: string | null;
	}>("SELECT * FROM sdk_bridge_turn_legs WHERE id = ?", [requestId]);
	return leg;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 5_000) {
	const until = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > until) throw new Error("waitFor timed out");
		await Bun.sleep(20);
	}
}

/** Run one turn: the client's request, and Claude Code's single model call. */
async function turn(
	h: Harness,
	endpoint: Endpoint,
	script: (query: FakeQuery) => Promise<void> = async (query) =>
		relay(query, await callModel(query)),
): Promise<Seen> {
	const pending = send(h.gw, endpoint);
	const query = await h.sdk.next();
	await query.nextPrompt();
	await script(query);
	return read(await pending);
}

const OVERFLOW_MESSAGE = "prompt is too long: 215012 tokens > 200000 maximum";
const OVERFLOW = {
	type: "error",
	error: { type: "invalid_request_error", message: OVERFLOW_MESSAGE },
};

const RATE_LIMITED = {
	type: "error",
	error: { type: "rate_limit_error", message: "mock 429" },
};

for (const endpoint of ["responses", "chat"] as const) {
	describe(`SDK bridge errors at /wire/openai ${endpoint}`, () => {
		it("every account 429: the proxy's pool-exhausted 503 with Retry-After, fast", async () => {
			const h = await harness();
			mock.failNext(
				429,
				RATE_LIMITED,
				{
					"retry-after": "600",
					"anthropic-ratelimit-unified-status": "rejected",
				},
				10,
			);
			const t0 = Date.now();
			const seen = await turn(h, endpoint);

			expect(Date.now() - t0).toBeLessThan(5_000);
			expect(seen.status).toBe(503);
			expect(Number(seen.retryAfter)).toBeGreaterThan(0);
			jsonError(seen);
			const leg = await legOf(h.gw, seen.requestId);
			expect(leg).toMatchObject({ http_status: 503, error_phase: "pre_head" });
		});

		it("inner 503: 503 with Retry-After", async () => {
			const h = await harness();
			mock.failNext(
				503,
				{ type: "error", error: { type: "api_error", message: "mock 503" } },
				{},
				10,
			);
			const seen = await turn(h, endpoint);

			expect(seen.status).toBe(503);
			expect(seen.retryAfter).toBe("30");
			expect(jsonError(seen).message).toBe("mock 503");
			expect((await legOf(h.gw, seen.requestId))?.http_status).toBe(503);
		});

		it("inner 529: 529 with Retry-After", async () => {
			const h = await harness();
			mock.failNext(
				529,
				{
					type: "error",
					error: { type: "overloaded_error", message: "mock 529" },
				},
				{},
				10,
			);
			const seen = await turn(h, endpoint);

			expect(seen.status).toBe(529);
			expect(seen.retryAfter).toBe("30");
			expect(jsonError(seen)).toMatchObject({
				message: "mock 529",
				type: "overloaded_error",
			});
			expect((await legOf(h.gw, seen.requestId))?.http_status).toBe(529);
		});

		it("inner 400 (out of extra usage): the 400 verbatim, accounts left as direct traffic leaves them", async () => {
			const h = await harness();
			mock.failNext(
				400,
				{
					type: "error",
					error: {
						type: "invalid_request_error",
						message: "You're out of extra usage.",
					},
				},
				{
					"anthropic-ratelimit-unified-overage-disabled-reason":
						"out_of_credits",
				},
				10,
			);
			const seen = await turn(h, endpoint);

			expect(seen.status).toBe(400);
			expect(seen.retryAfter).toBeNull();
			expect(jsonError(seen)).toMatchObject({
				message: "You're out of extra usage.",
				type: "invalid_request_error",
			});
			const accounts = await h.gw.query<{
				paused: number;
				rate_limited_until: number | null;
			}>("SELECT paused, rate_limited_until FROM accounts");
			expect(accounts).toEqual([
				{ paused: 0, rate_limited_until: null },
				{ paused: 0, rate_limited_until: null },
			]);
		});

		it("inner 403: permission_error for the client, a 400 for Claude Code", async () => {
			const h = await harness();
			let innerStatus = 0;
			const seen = await turn(h, endpoint, async (query) => {
				// The plan was frozen with both accounts; neither may serve now.
				await h.gw.dbOps.getAdapter().run("UPDATE accounts SET disabled = 1");
				const inner = await callModel(query);
				innerStatus = inner.status;
				await relay(query, inner, "Failed to authenticate. API Error: 403");
			});

			expect(innerStatus).toBe(400);
			expect(seen.status).toBe(403);
			expect(jsonError(seen).type).toBe("permission_error");
			expect(mock.requests.filter((r) => r.status === 200)).toEqual([]);
		});

		it("inner 5xx: 502", async () => {
			const h = await harness();
			mock.failNext(
				500,
				{ type: "error", error: { type: "api_error", message: "mock 500" } },
				{},
				10,
			);
			const seen = await turn(h, endpoint);

			expect(seen.status).toBe(502);
			expect(seen.retryAfter).toBeNull();
			expect(jsonError(seen).message).toBe("mock 500");
		});

		it("Claude Code error with no inner outcome: 502 without its credential wording", async () => {
			const h = await harness();
			const seen = await turn(h, endpoint, async (query) => {
				giveUp(
					query,
					"Failed to authenticate. API Error: 401 invalid x-api-key",
				);
				query.end();
			});

			expect(seen.status).toBe(502);
			expect(jsonError(seen).message).toContain(
				"Claude Code ended the turn with an error",
			);
		});

		it("deadline before any output: 504", async () => {
			const h = await harness({ turnDeadlineMs: 300 });
			const seen = await turn(h, endpoint, async () => {});

			expect(seen.status).toBe(504);
			expect(jsonError(seen).type).toBe("timeout_error");
			expect(await legOf(h.gw, seen.requestId)).toMatchObject({
				http_status: 504,
				error_phase: "pre_head",
			});
		});

		it("process cap: 529 with Retry-After while the cap is held; the held turn's disconnect is recorded and its query ends", async () => {
			const h = await harness({ maxProcesses: 1 });
			const abort = new AbortController();
			const held = send(h.gw, endpoint, abort.signal).catch(() => null);
			const heldQuery = await h.sdk.next();

			const seen = await read(await send(h.gw, endpoint));
			expect(seen.status).toBe(529);
			expect(seen.retryAfter).toBe("10");
			expect(jsonError(seen).type).toBe("overloaded_error");
			expect(await legOf(h.gw, seen.requestId)).toMatchObject({
				http_status: 529,
			});

			abort.abort();
			await held;
			await waitFor(() => h.gw.bridge.status().live === 0);
			expect(heldQuery.interrupted || heldQuery.closed).toBe(true);
			await waitFor(async () => {
				const rows = await h.gw.query<{ error_type: string | null }>(
					"SELECT error_type FROM sdk_bridge_turn_legs WHERE http_status = 499",
				);
				return rows.length === 1;
			});
		});

		it("error after the head: an SSE error event on a 200 stream", async () => {
			const h = await harness();
			mock.failNext(
				500,
				{
					type: "error",
					error: { type: "api_error", message: "mock 500 mid-stream" },
				},
				{},
				10,
			);
			const seen = await turn(h, endpoint, async (query) => {
				startStreaming(query, MODEL);
				await Bun.sleep(100);
				await relay(query, await callModel(query));
			});

			expect(seen.status).toBe(200);
			expect(seen.contentType).toContain("text/event-stream");
			expect(seen.requestId).toBeTruthy();
			expect(seen.text).toContain("partial answer");
			expect(seen.text).not.toMatch(CREDENTIAL_WORDING);
			if (endpoint === "responses") {
				expect(seen.text).toContain("event: response.failed");
				expect(streamedError(seen, endpoint)).toEqual({
					code: "api_error",
					message: "mock 500 mid-stream",
				});
			} else {
				expect(streamedError(seen, endpoint)).toEqual({
					message: "mock 500 mid-stream",
					type: "api_error",
					param: null,
					code: "api_error",
				});
			}
			expect(await legOf(h.gw, seen.requestId)).toMatchObject({
				http_status: 502,
				error_phase: "mid_stream",
			});
		});

		it("inner context overflow before the head: 400 context_length_exceeded with the token counts", async () => {
			const h = await harness();
			mock.failNext(400, OVERFLOW, {}, 10);
			const seen = await turn(h, endpoint, async (query) =>
				relay(query, await callModel(query), "Prompt is too long"),
			);

			expect(seen.status).toBe(400);
			expect(seen.retryAfter).toBeNull();
			expect(jsonError(seen)).toEqual({
				message: OVERFLOW_MESSAGE,
				type: "invalid_request_error",
				code: "context_length_exceeded",
				...(endpoint === "chat" ? { param: null } : {}),
			});
			expect(await legOf(h.gw, seen.requestId)).toMatchObject({
				http_status: 400,
				error_phase: "pre_head",
				error_type: "invalid_request_error",
			});
		});

		it("Claude Code's own context-limit refusal: 400 context_length_exceeded", async () => {
			const h = await harness();
			const upstreamCalls = mock.requests.length;
			const seen = await turn(h, endpoint, async (query) => {
				giveUp(query, "Prompt is too long", "blocking_limit");
				query.end();
			});

			expect(seen.status).toBe(400);
			expect(jsonError(seen)).toMatchObject({
				message: "prompt is too long",
				type: "invalid_request_error",
				code: "context_length_exceeded",
			});
			expect(mock.requests.length).toBe(upstreamCalls);
		});

		it("context overflow after the head: the SSE error keeps its code", async () => {
			const h = await harness();
			mock.failNext(400, OVERFLOW, {}, 10);
			const seen = await turn(h, endpoint, async (query) => {
				startStreaming(query, MODEL);
				await Bun.sleep(100);
				await relay(query, await callModel(query), "Prompt is too long");
			});

			expect(seen.text).toContain("partial answer");
			expect(streamedError(seen, endpoint)).toEqual(
				endpoint === "responses"
					? { code: "context_length_exceeded", message: OVERFLOW_MESSAGE }
					: {
							message: OVERFLOW_MESSAGE,
							type: "invalid_request_error",
							param: null,
							code: "context_length_exceeded",
						},
			);
			expect(await legOf(h.gw, seen.requestId)).toMatchObject({
				http_status: 400,
				error_phase: "mid_stream",
			});
		});

		it("shutdown during an admitted turn: 503 with Retry-After", async () => {
			const h = await harness();
			const pending = send(h.gw, endpoint);
			await h.sdk.next();
			await h.gw.bridge.dispose();

			const seen = await read(await pending);
			expect(seen.status).toBe(503);
			expect(seen.retryAfter).toBe("30");
			expect(jsonError(seen).message).toContain("shutting down");
			expect(await legOf(h.gw, seen.requestId)).toMatchObject({
				http_status: 503,
			});
		});
	});
}

/**
 * A client that switches model in the middle of a tool loop: the parked turn
 * cannot serve the new model, so its tool results start a fresh turn on it
 * instead of a 409 the client would get on every retry.
 */
for (const endpoint of ["responses", "chat"] as const) {
	const chat = endpoint === "chat";
	const tools = chat
		? [
				{
					type: "function",
					function: {
						name: "read",
						parameters: { type: "object", properties: {} },
					},
				},
			]
		: [
				{
					type: "function",
					name: "read",
					parameters: { type: "object", properties: {} },
				},
			];
	const user = chat
		? { role: "user", content: "read a" }
		: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "read a" }],
			};

	async function post(gw: Gateway, model: string, history: unknown[]) {
		const response = await fetch(
			`${gw.url}/wire/openai/v1/${chat ? "chat/completions" : "responses"}`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${gw.apiKey}`,
					"content-type": "application/json",
					"user-agent": "pi/0.86.0",
				},
				body: JSON.stringify({
					model,
					stream: false,
					tools,
					...(chat ? { messages: history } : { input: history }),
				}),
			},
		);
		return { status: response.status, body: await response.json() };
	}

	describe(`SDK bridge continuation under another model at /wire/openai ${endpoint}`, () => {
		it("starts a fresh turn on the new model and frees the parked one", async () => {
			const h = await harness();
			const first = post(h.gw, MODEL, [user]);
			const parked = await h.sdk.next();
			await parked.nextPrompt();
			parked.emit(
				...streamedMessage([
					{
						type: "tool_use",
						id: "toolu_gw_1",
						name: String(parked.options.allowedTools?.[0]),
						input: {},
					},
				]),
			);
			const r1 = await first;
			expect(r1.status).toBe(200);
			await waitFor(() => h.gw.bridge.status().parked === 1);

			const history = chat
				? [
						user,
						r1.body.choices[0].message,
						{ role: "tool", tool_call_id: "toolu_gw_1", content: "A" },
					]
				: [
						user,
						...r1.body.output,
						{
							type: "function_call_output",
							call_id: "toolu_gw_1",
							output: "A",
						},
					];
			const second = post(h.gw, OTHER_MODEL, history);
			const fresh = await h.sdk.next();
			expect(fresh).not.toBe(parked);
			expect(parked.interrupted).toBe(true);
			expect(h.gw.bridge.status().parked).toBe(0);
			await fresh.nextPrompt();
			fresh.emit(
				...streamedMessage([{ type: "text", text: "done" }], {
					model: OTHER_MODEL,
				}),
				resultMessage(),
			);
			fresh.end();
			const r2 = await second;

			expect(r2.status).toBe(200);
			expect(JSON.stringify(r2.body)).toContain("done");
			await waitFor(async () => {
				const rows = await h.gw.query<{ status: string }>(
					"SELECT status FROM sdk_bridge_turns WHERE status = 'completed'",
				);
				return rows.length === 1;
			});
			expect(
				await h.gw.query(
					"SELECT status, rebuild_reason FROM sdk_bridge_turns ORDER BY started_at",
				),
			).toEqual([
				{ status: "aborted", rebuild_reason: null },
				{ status: "completed", rebuild_reason: "dead_continuation" },
			]);
		});
	});
}

/**
 * One field policy for bridged turns, whichever endpoint the client used: the
 * output limit is honoured, sampling is accepted and recorded as ignored, and
 * what would change the answer's shape is refused before Claude Code starts.
 */
for (const endpoint of ["responses", "chat"] as const) {
	const tools =
		endpoint === "chat"
			? [
					{
						type: "function",
						function: {
							name: "read",
							description: "Read a file",
							parameters: { type: "object", properties: {} },
						},
					},
				]
			: [
					{
						type: "function",
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: {} },
					},
				];
	const limit =
		endpoint === "chat" ? { max_tokens: 321 } : { max_output_tokens: 321 };

	/** A turn that runs: Claude Code's one model call succeeds. */
	async function served(h: Harness, fields: Record<string, unknown>) {
		const pending = send(h.gw, endpoint, undefined, fields);
		const query = await h.sdk.next();
		await query.nextPrompt();
		await relay(query, await callModel(query));
		return { seen: await read(await pending), query };
	}

	async function finishedTurn(gw: Gateway) {
		let rows: Array<{ status: string; ignored_fields: string | null }> = [];
		await waitFor(async () => {
			rows = await gw.query(
				"SELECT status, ignored_fields FROM sdk_bridge_turns WHERE status != 'running'",
			);
			return rows.length === 1;
		});
		return rows[0];
	}

	describe(`SDK bridge field policy at /wire/openai ${endpoint}`, () => {
		it("honours the client's output limit as Claude Code's own", async () => {
			const h = await harness();
			const { seen, query } = await served(h, limit);

			expect(seen.status).toBe(200);
			expect(query.options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("321");
		});

		it("leaves Claude Code's limit alone when the client sets none", async () => {
			const h = await harness();
			const { seen, query } = await served(h, {});

			expect(seen.status).toBe(200);
			expect(query.options.env).not.toHaveProperty(
				"CLAUDE_CODE_MAX_OUTPUT_TOKENS",
			);
		});

		it("accepts temperature and top_p and records them as ignored", async () => {
			const h = await harness();
			const { seen } = await served(h, { temperature: 0.2, top_p: 0.9 });

			expect(seen.status).toBe(200);
			expect(await finishedTurn(h.gw)).toEqual({
				status: "completed",
				ignored_fields: '["temperature","top_p"]',
			});
		});

		it("refuses a tool_choice that forces a tool, naming it, while routing", async () => {
			const h = await harness();
			const seen = await read(
				await send(h.gw, endpoint, undefined, {
					tools,
					tool_choice: "required",
				}),
			);

			expect(seen.status).toBe(400);
			expect(jsonError(seen).message).toContain('tool_choice "any"');
			// Route construction refused it: no turn was admitted, so there is
			// no leg, and the refusal is the request's routing attempt.
			expect(h.sdk.queries).toEqual([]);
			expect(await h.gw.query("SELECT id FROM sdk_bridge_turns", [])).toEqual(
				[],
			);
			expect(
				await h.gw.query(
					"SELECT kind, status FROM routing_attempts WHERE kind = 'local_reject'",
					[],
				),
			).toEqual([{ kind: "local_reject", status: 400 }]);
		});

		if (endpoint === "chat")
			it("refuses stop sequences, naming the field, before Claude Code starts", async () => {
				const h = await harness();
				const seen = await read(
					await send(h.gw, endpoint, undefined, { stop: ["END"] }),
				);

				expect(seen.status).toBe(400);
				expect(jsonError(seen).message).toContain("stop_sequences");
				expect(h.sdk.queries).toEqual([]);
			});
	});
}
