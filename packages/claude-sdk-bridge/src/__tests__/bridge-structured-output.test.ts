import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkBridgeTurnMeta } from "@clankermux/types";
import { INPUT_JSON_CHUNK } from "../reply-composer";
import {
	assistantMessage,
	type FakeQuery,
	foldReply,
	type Harness,
	initMessage,
	makeHarness,
	makeMeta,
	makePlan,
	messagesRequest,
	parseSse,
	READ_TOOL,
	resultMessage,
	streamedMessage,
	waitFor,
} from "./fixtures/fake-sdk";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.bridge.dispose();
		rmSync(h.workRoot, { recursive: true, force: true });
	}
});

function harness(headHoldMs = 1_000): Harness {
	const h = makeHarness({
		timing: {
			headHoldMs,
			pingIntervalMs: 100,
			settleWaitMs: 500,
			idleTimeoutMs: 5_000,
			exitGraceMs: 50,
		},
	});
	harnesses.push(h);
	return h;
}

const SCHEMA = {
	type: "object",
	properties: { city: { type: "string" } },
	required: ["city"],
};
const FORMAT = { type: "json_schema" as const, schema: SCHEMA };
const ask = {
	messages: [{ role: "user", content: "weather?" }],
	output_config: { format: FORMAT },
};

async function start(
	h: Harness,
	body: Record<string, unknown> = ask,
	meta: Partial<SdkBridgeTurnMeta> = {},
) {
	const plan = makePlan();
	const response = h.bridge.startTurn({
		request: messagesRequest(body),
		plan,
		meta: makeMeta(meta),
		signal: new AbortController().signal,
	});
	const query = await h.sdk.next();
	return { response, query, plan };
}

async function reply(response: Promise<Response>) {
	const res = await response;
	const text = await res.text();
	const events = res.headers.get("content-type")?.includes("event-stream")
		? parseSse(text)
		: [];
	return {
		status: res.status,
		body: events.length ? null : (JSON.parse(text) as Record<string, unknown>),
		events,
		...foldReply(events),
	};
}

/** Claude Code's StructuredOutput call: a tool of its own, never the client's. */
function structuredCall(input: unknown, stopReason = "tool_use") {
	return streamedMessage(
		[{ type: "tool_use", id: "toolu_so", name: "StructuredOutput", input }],
		{ stopReason },
	);
}

function answered(query: FakeQuery, value: unknown, before: SDKMessage[] = []) {
	query.emit(
		initMessage(),
		...before,
		...structuredCall(value),
		resultMessage({ structuredOutput: value }),
	);
}

async function pending(response: Promise<Response>): Promise<boolean> {
	return (await Promise.race([
		response.then(() => false),
		Bun.sleep(80).then(() => true),
	])) as boolean;
}

describe("structured output through the bridge", () => {
	it("gives Claude Code the client's schema as its outputFormat, and no tools", async () => {
		const h = harness();
		const t = await start(h);
		expect(t.query.options.outputFormat).toEqual(FORMAT);
		expect(t.query.options.tools).toEqual([]);
		expect(t.query.options.allowedTools).toEqual([]);
		const plain = await start(h, { messages: ask.messages });
		expect(plain.query.options.outputFormat).toBeUndefined();
	});

	it("answers the structured output as one text block and nothing the model said on the way", async () => {
		const h = harness();
		const t = await start(h);
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{ type: "thinking", text: "let me think" },
				{ type: "text", text: "Here is prose the client must not see." },
			]),
		);
		// An end_turn before the StructuredOutput call does not end the reply,
		// and nothing has gone out: the head is still held.
		expect(await pending(t.response)).toBe(true);
		const value = { city: "Zürich", nested: { list: [1, { deep: true }] } };
		t.query.emit(
			...structuredCall(value),
			resultMessage({ structuredOutput: value }),
		);
		const r = await reply(t.response);
		expect(r.status).toBe(200);
		expect(r.stop).toBe("end_turn");
		expect(r.content).toEqual([{ type: "text", text: JSON.stringify(value) }]);
		expect(r.events.map((e) => e.event)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		expect(JSON.parse(String(r.content[0]?.text))).toEqual(value);
		await waitFor(
			() => h.repo.turns.get(t.plan.turnId)?.status === "completed",
		);
		expect(h.repo.turns.get(t.plan.turnId)?.stopReason).toBe("end_turn");
	});

	it("answers stream:false with the JSON as the message's only content", async () => {
		const h = harness();
		const t = await start(h, { ...ask, stream: false });
		answered(t.query, { city: "Oslo" }, [
			...streamedMessage([{ type: "text", text: "prose" }]),
		]);
		const r = await reply(t.response);
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({
			type: "message",
			role: "assistant",
			stop_reason: "end_turn",
			content: [{ type: "text", text: '{"city":"Oslo"}' }],
		});
	});

	for (const [label, value, text] of [
		["0", 0, "0"],
		["false", false, "false"],
		["null", null, "null"],
		['""', "", '""'],
	] as const)
		it(`answers the falsy value ${label}`, async () => {
			const h = harness();
			const t = await start(h);
			answered(t.query, value);
			const r = await reply(t.response);
			expect(r.status).toBe(200);
			expect(r.content).toEqual([{ type: "text", text }]);
		});

	it("splits a large answer into text deltas of at most 64 KiB, never inside a surrogate pair", async () => {
		const h = harness();
		const t = await start(h);
		const value = { text: "ü😀".repeat(70_000) };
		answered(t.query, value);
		const r = await reply(t.response);
		const deltas = r.events
			.filter((e) => e.data.type === "content_block_delta")
			.map((e) => String((e.data.delta as { text: string }).text));
		expect(deltas.length).toBeGreaterThan(1);
		for (const d of deltas) {
			expect(d.length).toBeLessThanOrEqual(INPUT_JSON_CHUNK);
			expect(
				d.charCodeAt(d.length - 1) >= 0xd800 &&
					d.charCodeAt(d.length - 1) <= 0xdbff,
			).toBe(false);
		}
		expect(deltas.join("")).toBe(JSON.stringify(value));
		expect(r.content).toHaveLength(1);
	});

	it("does not offer the session to the conversation's next turn", async () => {
		const h = harness();
		const conv = { affinityScope: "client_session", affinityKey: "so" };
		const t = await start(h, ask, conv);
		answered(t.query, { city: "Rome" });
		const r = await reply(t.response);
		await waitFor(() => h.bridge.status().live === 0);
		const next = await start(
			h,
			{
				messages: [
					...ask.messages,
					{ role: "assistant", content: r.content },
					{ role: "user", content: "and tomorrow?" },
				],
			},
			conv,
		);
		// Rebuilt from the client's history, never a resume of the stored session.
		expect(String(h.repo.turns.get(next.plan.turnId)?.historyMode)).toMatch(
			/^rebuild_/,
		);
	});

	describe("a turn that ends without an answer", () => {
		it("answers 502 structured_output_failed before the head when the retries ran out", async () => {
			const h = harness();
			const t = await start(h);
			t.query.emit(
				initMessage(),
				...structuredCall({ town: "x" }),
				...structuredCall({ town: "y" }),
				resultMessage({
					isError: true,
					subtype: "error_max_structured_output_retries",
					errors: [
						"Failed to provide valid structured output after 5 attempts",
					],
					terminalReason: "structured_output_retry_exhausted",
				}),
			);
			const r = await reply(t.response);
			expect(r.status).toBe(502);
			expect(r.body).toMatchObject({
				error: {
					type: "api_error",
					code: "structured_output_failed",
					message: expect.stringContaining("did not match"),
				},
			});
			await waitFor(() => h.repo.turns.get(t.plan.turnId)?.status === "failed");
		});

		it("ends a committed stream with an SSE error, never prose", async () => {
			const h = harness(50);
			const t = await start(h);
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "Sorry, here is prose." }]),
			);
			const res = await t.response;
			expect(res.headers.get("content-type")).toContain("event-stream");
			t.query.emit(
				resultMessage({
					isError: true,
					subtype: "error_max_structured_output_retries",
				}),
			);
			const events = parseSse(await res.text());
			const folded = foldReply(events);
			expect(folded.content).toEqual([]);
			expect(folded.errors).toHaveLength(1);
			expect(folded.errors[0]?.data).toMatchObject({
				error: { code: "structured_output_failed" },
			});
			expect(JSON.stringify(events)).not.toContain("prose");
		});

		it("fails a success result without structured_output", async () => {
			const h = harness();
			const t = await start(h);
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "prose answer" }]),
				resultMessage({ result: "prose answer" }),
			);
			const r = await reply(t.response);
			expect(r.status).toBe(502);
			expect(r.body).toMatchObject({
				error: {
					code: "structured_output_failed",
					message: expect.stringContaining("without a structured answer"),
				},
			});
		});

		it("fails a refusal", async () => {
			const h = harness();
			const t = await start(h);
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "I can't" }], {
					stopReason: "refusal",
				}),
				resultMessage({ isError: true, subtype: "error_during_execution" }),
			);
			const r = await reply(t.response);
			expect(r.status).toBe(502);
			expect(r.body).toMatchObject({
				error: {
					code: "structured_output_failed",
					message: expect.stringContaining("refused"),
				},
			});
		});

		it("fails Claude Code's exit without a result", async () => {
			const h = harness();
			const t = await start(h);
			t.query.emit(initMessage());
			t.query.end();
			const r = await reply(t.response);
			expect(r.status).toBe(502);
			expect(r.body).toMatchObject({
				error: { code: "structured_output_failed" },
			});
		});
	});

	describe("the token limit", () => {
		it("ends with no content and max_tokens when the last model call stopped on it", async () => {
			const h = harness();
			const t = await start(h, { ...ask, max_tokens: 16 });
			t.query.emit(
				initMessage(),
				...structuredCall({ city: "Zü" }, "max_tokens"),
				resultMessage({
					isError: true,
					subtype: "error_max_structured_output_retries",
				}),
			);
			const r = await reply(t.response);
			expect(r.status).toBe(200);
			expect(r.content).toEqual([]);
			expect(r.stop).toBe("max_tokens");
			expect(r.errors).toEqual([]);
			await waitFor(
				() => h.repo.turns.get(t.plan.turnId)?.status === "completed",
			);
			expect(h.repo.turns.get(t.plan.turnId)?.stopReason).toBe("max_tokens");
		});

		it("does the same for stream:false, and after Claude Code's max_output_tokens error", async () => {
			const h = harness();
			const t = await start(h, { ...ask, stream: false, max_tokens: 16 });
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "partial" }], {
					stopReason: "max_tokens",
				}),
				assistantMessage([{ type: "text", text: "API Error: output limit" }], {
					error: "max_output_tokens",
				}),
				resultMessage({ isError: true, subtype: "error_during_execution" }),
			);
			const r = await reply(t.response);
			expect(r.status).toBe(200);
			expect(r.body).toMatchObject({ stop_reason: "max_tokens", content: [] });
		});

		it("answers a success after a recovered max_tokens stop", async () => {
			const h = harness();
			const t = await start(h);
			answered(t.query, { city: "Bern" }, [
				...streamedMessage([{ type: "text", text: "cut" }], {
					stopReason: "max_tokens",
				}),
			]);
			const r = await reply(t.response);
			expect(r.content).toEqual([{ type: "text", text: '{"city":"Bern"}' }]);
			expect(r.stop).toBe("end_turn");
		});

		it("is not the cause when a later model call ended otherwise", async () => {
			const h = harness();
			const t = await start(h);
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "cut" }], {
					stopReason: "max_tokens",
				}),
				...streamedMessage([{ type: "text", text: "prose instead" }]),
				resultMessage({
					isError: true,
					subtype: "error_max_structured_output_retries",
				}),
			);
			const r = await reply(t.response);
			expect(r.status).toBe(502);
			expect(r.body).toMatchObject({
				error: { code: "structured_output_failed" },
			});
		});
	});

	describe("refusals", () => {
		it("refuses a schema next to client tools before anything runs", async () => {
			const h = harness();
			const res = await h.bridge.startTurn({
				request: messagesRequest({ ...ask, tools: [READ_TOOL] }),
				plan: makePlan(),
				meta: makeMeta(),
				signal: new AbortController().signal,
			});
			expect(res.status).toBe(400);
			expect(
				((await res.json()) as { error: { message: string } }).error.message,
			).toContain("output_config.format");
			expect(h.sdk.queries).toHaveLength(0);
		});

		it("refuses a malformed format", async () => {
			const h = harness();
			for (const format of [
				{ type: "json_object" },
				{ type: "json_schema" },
				{ type: "json_schema", schema: [] },
				"json",
			]) {
				const res = await h.bridge.startTurn({
					request: messagesRequest({ ...ask, output_config: { format } }),
					plan: makePlan(),
					meta: makeMeta(),
					signal: new AbortController().signal,
				});
				expect(res.status).toBe(400);
			}
			expect(h.sdk.queries).toHaveLength(0);
		});

		it("refuses a side request carrying a schema", async () => {
			const h = harness();
			const res = await h.bridge.startTurn({
				request: messagesRequest({ ...ask, tool_choice: { type: "none" } }),
				plan: makePlan(),
				meta: makeMeta({ sideRequest: "session-fork-v1" }),
				signal: new AbortController().signal,
			});
			expect(res.status).toBe(400);
			expect(
				((await res.json()) as { error: { message: string } }).error.message,
			).toContain("side request");
			expect(h.sdk.queries).toHaveLength(0);
		});

		it("refuses a schema on tool results continuing a parked turn, with or without tools, and leaves it parked", async () => {
			const h = harness();
			const t = await start(h, {
				messages: [{ role: "user", content: "read it" }],
				tools: [READ_TOOL],
			});
			const call = {
				type: "tool_use",
				id: "toolu_p",
				name: "mcp__c__read",
				input: { path: "a" },
			} as const;
			t.query.emit(initMessage(), ...streamedMessage([call]));
			const first = await reply(t.response);
			expect(first.stop).toBe("tool_use");
			void t.query.callTool("toolu_p", "read", { path: "a" });
			await waitFor(() => h.bridge.status().parked === 1);
			const messages = [
				{ role: "user", content: "read it" },
				{ role: "assistant", content: first.content },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_p", content: "A" },
					],
				},
			];
			for (const tools of [[], [READ_TOOL]]) {
				const res = await h.bridge.continueTurn({
					turnId: t.plan.turnId,
					request: messagesRequest({
						messages,
						tools,
						output_config: { format: FORMAT },
					}),
					meta: makeMeta(),
					signal: new AbortController().signal,
				});
				expect(res.status).toBe(400);
				expect(
					((await res.json()) as { error: { message: string } }).error.message,
				).toContain("output_config.format");
			}
			expect(h.bridge.status().parked).toBe(1);
		});
	});
});
