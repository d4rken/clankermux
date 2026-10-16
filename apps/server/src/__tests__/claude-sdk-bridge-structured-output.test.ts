/**
 * Structured output served by the SDK bridge, as a client sees it: Chat
 * Completions' response_format on /wire/openai and a native Messages
 * client's output_config.format on /wire/anthropic. Claude Code is a
 * scripted stand-in reporting its StructuredOutput call and result.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	resultMessage,
	streamedMessage,
} from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/fake-sdk";
import { startMockUpstream } from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/mock-upstream";
import { type FakeQuery, fakeQueryFn } from "./fixtures/scripted-claude-code";
import { type Gateway, startGateway } from "./fixtures/sdk-bridge-gateway";

const MODEL = "claude-sonnet-5";
const SCHEMA = {
	type: "object",
	properties: { city: { type: "string" }, temps: { type: "array" } },
	required: ["city"],
	additionalProperties: false,
};
const RESPONSE_FORMAT = {
	type: "json_schema",
	json_schema: { name: "weather", schema: SCHEMA, strict: true },
};
const ANSWER = { city: "Zürich", temps: [0, -1.5] };

const mock = startMockUpstream();
afterAll(() => mock.stop());

interface Harness {
	gw: Gateway;
	sdk: ReturnType<typeof fakeQueryFn>;
	root: string;
}

let current: Harness | null = null;
afterEach(async () => {
	if (!current) return;
	const { gw, root } = current;
	current = null;
	await gw.stop();
	expect(gw.blockedEgress.filter((h) => /anthropic|claude/i.test(h))).toEqual(
		[],
	);
	rmSync(root, { recursive: true, force: true });
});

/** `headHoldMs`: how long a streamed head waits for the bridge's first event. */
async function harness(headHoldMs = 2_000): Promise<Harness> {
	const sdk = fakeQueryFn();
	const root = mkdtempSync(join(tmpdir(), "cmx-bridge-structured-"));
	const n = crypto.randomUUID().slice(0, 8);
	const gw = await startGateway({
		root,
		upstreamUrl: mock.url,
		accounts: [
			{
				id: `acct-a-${n}`,
				name: `claude-a-${n}`,
				token: `sk-ant-oat01-ACCT-A-${n}`,
			},
		],
		models: [MODEL],
		bridge: {
			queryFn: sdk.fn,
			claudeExecutablePath: "/opt/fake/claude",
			timing: {
				headHoldMs,
				pingIntervalMs: 50,
				settleWaitMs: 500,
				idleTimeoutMs: 20_000,
				exitGraceMs: 50,
			},
		},
	});
	current = { gw, sdk, root };
	return current;
}

function chat(gw: Gateway, fields: Record<string, unknown>): Promise<Response> {
	return fetch(`${gw.url}/wire/openai/v1/chat/completions`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${gw.apiKey}`,
			"content-type": "application/json",
			"user-agent": "openai-python/2.1.0",
		},
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "weather in Zürich?" }],
			response_format: RESPONSE_FORMAT,
			...fields,
		}),
	});
}

function messages(
	gw: Gateway,
	fields: Record<string, unknown>,
): Promise<Response> {
	return fetch(`${gw.url}/wire/anthropic/v1/messages`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${gw.apiKey}`,
			"content-type": "application/json",
			"user-agent": "curl/8.5.0",
		},
		body: JSON.stringify({
			model: MODEL,
			max_tokens: 256,
			messages: [{ role: "user", content: "weather in Zürich?" }],
			output_config: { format: { type: "json_schema", schema: SCHEMA } },
			...fields,
		}),
	});
}

/** Claude Code's StructuredOutput call, after the prose the client never sees. */
function structuredTurn(value: unknown = ANSWER): SDKMessage[] {
	return [
		...streamedMessage([
			{ type: "thinking", text: "reasoning" },
			{ type: "text", text: "Sure! Here is the weather." },
		]),
		...streamedMessage([
			{
				type: "tool_use",
				id: "toolu_so",
				name: "StructuredOutput",
				input: value,
			},
		]),
		resultMessage({ structuredOutput: value }),
	];
}

const RETRIES_EXHAUSTED = resultMessage({
	isError: true,
	subtype: "error_max_structured_output_retries",
	terminalReason: "structured_output_retry_exhausted",
});

function tokenLimited(): SDKMessage[] {
	return [
		...streamedMessage(
			[
				{
					type: "tool_use",
					id: "toolu_so",
					name: "StructuredOutput",
					input: { city: "Zü" },
				},
			],
			{ stopReason: "max_tokens" },
		),
		RETRIES_EXHAUSTED,
	];
}

async function run(
	h: Harness,
	pending: Promise<Response>,
	script: (query: FakeQuery) => Promise<void> | void,
): Promise<Response> {
	const query = await h.sdk.next();
	await query.nextPrompt();
	await script(query);
	query.end();
	return pending;
}

/** Chat SSE payloads, `[DONE]` excluded. */
async function chunks(res: Response): Promise<Record<string, unknown>[]> {
	expect(res.headers.get("content-type")).toContain("text/event-stream");
	return (await res.text())
		.split("\n")
		.filter((line) => line.startsWith("data: {"))
		.map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

type Choice = {
	delta?: {
		content?: string;
		tool_calls?: unknown;
		reasoning_content?: string;
	};
	message?: {
		content: string | null;
		tool_calls?: unknown;
		reasoning_content?: string;
	};
	finish_reason: string | null;
};
const choiceOf = (c: Record<string, unknown>) =>
	(c.choices as Choice[] | undefined)?.[0];

describe("Chat response_format through the SDK bridge", () => {
	it("hands Claude Code the schema as its outputFormat", async () => {
		const h = await harness();
		const pending = chat(h.gw, {});
		const query = await h.sdk.next();
		expect(query.options.outputFormat).toEqual({
			type: "json_schema",
			schema: SCHEMA,
		});
		expect(query.options.tools).toEqual([]);
		query.emit(...structuredTurn());
		query.end();
		expect((await pending).status).toBe(200);
	});

	it("answers stream:false with the JSON as the message content and finish_reason stop", async () => {
		const h = await harness();
		const res = await run(h, chat(h.gw, {}), (q) =>
			q.emit(...structuredTurn()),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { choices: Choice[] };
		const choice = body.choices[0];
		expect(choice?.finish_reason).toBe("stop");
		expect(choice?.message?.content).toBe(JSON.stringify(ANSWER));
		expect(JSON.parse(String(choice?.message?.content))).toEqual(ANSWER);
		expect(choice?.message?.tool_calls).toBeUndefined();
		expect(choice?.message?.reasoning_content).toBeUndefined();
	});

	it("streams the JSON as content and finishes with stop", async () => {
		const h = await harness();
		const res = await run(h, chat(h.gw, { stream: true }), (q) =>
			q.emit(...structuredTurn()),
		);
		expect(res.status).toBe(200);
		const all = await chunks(res);
		const content = all.map((c) => choiceOf(c)?.delta?.content ?? "").join("");
		expect(content).toBe(JSON.stringify(ANSWER));
		expect(all.some((c) => choiceOf(c)?.delta?.tool_calls)).toBe(false);
		expect(all.some((c) => choiceOf(c)?.delta?.reasoning_content)).toBe(false);
		expect(all.map((c) => choiceOf(c)?.finish_reason).filter(Boolean)).toEqual([
			"stop",
		]);
	});

	it("passes a large answer whole through the Chat reader's frame bound", async () => {
		const h = await harness();
		const big = { city: "x".repeat(3 * 1024 * 1024), temps: [] };
		const res = await run(h, chat(h.gw, {}), (q) =>
			q.emit(...structuredTurn(big)),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { choices: Choice[] };
		expect(body.choices[0]?.message?.content).toBe(JSON.stringify(big));
	});

	for (const stream of [false, true])
		it(`ends a turn cut by the token limit with finish_reason length and no content (stream ${stream})`, async () => {
			const h = await harness();
			const res = await run(h, chat(h.gw, { stream, max_tokens: 16 }), (q) =>
				q.emit(...tokenLimited()),
			);
			expect(res.status).toBe(200);
			if (!stream) {
				const choice = ((await res.json()) as { choices: Choice[] }).choices[0];
				expect(choice?.finish_reason).toBe("length");
				expect(choice?.message?.content).toBe("");
				expect(choice?.message?.tool_calls).toBeUndefined();
				return;
			}
			const all = await chunks(res);
			expect(all.map((c) => choiceOf(c)?.delta?.content ?? "").join("")).toBe(
				"",
			);
			expect(
				all.map((c) => choiceOf(c)?.finish_reason).filter(Boolean),
			).toEqual(["length"]);
		});

	describe("an answer Claude Code could not produce", () => {
		it("answers 502 structured_output_failed before the head", async () => {
			const h = await harness();
			for (const stream of [false, true]) {
				const res = await run(h, chat(h.gw, { stream }), (q) =>
					q.emit(
						...streamedMessage([{ type: "text", text: "prose" }]),
						RETRIES_EXHAUSTED,
					),
				);
				expect(res.status).toBe(502);
				const body = (await res.json()) as {
					error: { code: string; type: string };
				};
				expect(body.error).toMatchObject({
					code: "structured_output_failed",
					type: "api_error",
				});
			}
		});

		it("answers stream:false with a 502, not a 200, after the head was committed", async () => {
			const h = await harness(50);
			const res = await run(h, chat(h.gw, {}), async (q) => {
				q.emit(...streamedMessage([{ type: "text", text: "prose" }]));
				// The bridge's hold timer commits its head meanwhile.
				await Bun.sleep(300);
				q.emit(RETRIES_EXHAUSTED);
			});
			expect(res.status).toBe(502);
			const body = (await res.json()) as {
				error: { code: string; message: string };
			};
			expect(body.error.code).toBe("structured_output_failed");
			expect(JSON.stringify(body)).not.toContain("prose");
		});

		it("ends a committed stream with an error chunk and no content", async () => {
			const h = await harness(50);
			const res = await run(h, chat(h.gw, { stream: true }), async (q) => {
				q.emit(...streamedMessage([{ type: "text", text: "prose" }]));
				await Bun.sleep(300);
				q.emit(resultMessage({ result: "prose" }));
			});
			expect(res.status).toBe(200);
			const all = await chunks(res);
			expect(all.at(-1)).toMatchObject({
				error: { code: "structured_output_failed" },
			});
			expect(all.some((c) => choiceOf(c)?.finish_reason)).toBe(false);
			expect(JSON.stringify(all)).not.toContain("prose");
		});
	});
});

describe("output_config.format from a native Messages client", () => {
	it("answers with one text block holding the JSON", async () => {
		const h = await harness();
		const res = await run(h, messages(h.gw, {}), (q) =>
			q.emit(...structuredTurn()),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			content: Array<{ type: string; text?: string }>;
			stop_reason: string;
		};
		expect(body.stop_reason).toBe("end_turn");
		expect(body.content).toEqual([
			{ type: "text", text: JSON.stringify(ANSWER) },
		]);
	});

	it("streams the same reply as SSE", async () => {
		const h = await harness();
		const res = await run(h, messages(h.gw, { stream: true }), (q) =>
			q.emit(...structuredTurn()),
		);
		const text = await res.text();
		expect(text).toContain('"stop_reason":"end_turn"');
		expect(text).not.toContain("Sure! Here is the weather.");
		expect(text).not.toContain("thinking");
	});

	it("refuses a schema next to tools with the bridge's 400 naming the field", async () => {
		const h = await harness();
		const res = await messages(h.gw, {
			tools: [{ name: "read", input_schema: { type: "object" } }],
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { message: string; param?: string };
		};
		expect(body.error.message).toContain("cannot be combined with tools");
		expect(h.sdk.queries).toHaveLength(0);
	});
});
