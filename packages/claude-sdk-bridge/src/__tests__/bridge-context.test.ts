/**
 * What the bridge does so a client's conversation reaches the model as the
 * client sent it: tool results Claude Code would have shortened, and context
 * rewrites it reports.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkBridgeRoutePlan, SdkBridgeTurnMeta } from "@clankermux/types";
import { MAX_TOOL_RESULT_CHARS } from "../tool-server";
import {
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

type Msg = { role: string; content: unknown };

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.bridge.dispose();
		rmSync(h.workRoot, { recursive: true, force: true });
	}
});

function harness(): Harness {
	const h = makeHarness();
	harnesses.push(h);
	return h;
}

async function start(
	h: Harness,
	body: Record<string, unknown>,
	opts: {
		meta?: Partial<SdkBridgeTurnMeta>;
		plan?: Partial<SdkBridgeRoutePlan>;
	} = {},
) {
	const plan = makePlan(opts.plan);
	const meta = makeMeta(opts.meta);
	const response = h.bridge.startTurn({
		request: messagesRequest(body),
		plan,
		meta,
		signal: new AbortController().signal,
	});
	const query = await h.sdk.next();
	return { response, query, plan, meta };
}

function continueTurn(
	h: Harness,
	turnId: string,
	body: Record<string, unknown>,
	meta: Partial<SdkBridgeTurnMeta> = {},
) {
	const m = makeMeta(meta);
	return {
		meta: m,
		response: h.bridge.continueTurn({
			turnId,
			request: messagesRequest(body),
			meta: m,
			signal: new AbortController().signal,
		}),
	};
}

async function reply(response: Promise<Response>) {
	const res = await response;
	const text = await res.text();
	const events = res.headers.get("content-type")?.includes("event-stream")
		? parseSse(text)
		: [];
	return {
		status: res.status,
		json: events.length ? null : (JSON.parse(text) as Record<string, unknown>),
		events,
		...foldReply(events),
	};
}

async function settled(h: Harness) {
	await waitFor(() => h.bridge.status().live === 0);
	await Bun.sleep(10);
}

const tools = [READ_TOOL];
const first: Msg = { role: "user", content: "TOOL read a.txt" };

/** A turn parked on one client call, `toolu_1`. */
async function parked(h: Harness) {
	const t = await start(h, { tools, messages: [first] });
	t.query.emit(
		initMessage(),
		...streamedMessage([
			{
				type: "tool_use",
				id: "toolu_1",
				name: "mcp__c__read",
				input: { path: "a.txt" },
			},
		]),
	);
	const r1 = await reply(t.response);
	const call = t.query.callTool("toolu_1", "read", { path: "a.txt" });
	await waitFor(() => h.bridge.status().parked === 1);
	const answer = (content: unknown): Msg[] => [
		first,
		{ role: "assistant", content: r1.content },
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_1", content }],
		},
	];
	return { t, r1, call, answer };
}

describe("client tool results Claude Code would replace", () => {
	it("lists every tool with Claude Code's largest result size, so results arrive whole", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		const listed = await (await t.query.mcp()).listTools();
		expect(MAX_TOOL_RESULT_CHARS).toBe(500_000);
		expect(listed.tools.map((tool) => tool._meta)).toEqual([
			{
				"anthropic/alwaysLoad": true,
				"anthropic/maxResultSizeChars": 500_000,
			},
		]);
	});

	it("delivers a result of exactly the limit, counted over its text blocks", async () => {
		const h = harness();
		const { t, call, answer } = await parked(h);
		const half = "x".repeat(MAX_TOOL_RESULT_CHARS / 2);
		const c = continueTurn(h, t.plan.turnId, {
			tools,
			messages: answer([
				{ type: "text", text: half },
				{ type: "text", text: half },
			]),
		});
		const delivered = await call;
		expect(
			(delivered.content as Array<{ text: string }>).map((b) => b.text.length),
		).toEqual([half.length, half.length]);
		t.query.emit(
			...streamedMessage([{ type: "text", text: "ok" }]),
			resultMessage(),
		);
		expect((await reply(c.response)).status).toBe(200);
	});

	it("refuses a larger result with a named 400, delivers nothing, and keeps the turn parked", async () => {
		const h = harness();
		const { t, call, answer } = await parked(h);
		const tooBig = "x".repeat(MAX_TOOL_RESULT_CHARS + 1);
		const refused = continueTurn(h, t.plan.turnId, {
			tools,
			messages: answer([{ type: "text", text: tooBig }]),
		});
		const r = await reply(refused.response);
		expect(r.status).toBe(400);
		expect(r.json).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				code: "sdk_bridge_tool_result_too_large",
				message:
					"The result for tool call toolu_1 is 500,001 characters; Claude Code passes at most 500,000 to the model whole",
			},
		});
		await waitFor(() => h.repo.legs.get(refused.meta.legId)?.finished === true);
		expect(h.repo.legs.get(refused.meta.legId)).toMatchObject({
			turnId: t.plan.turnId,
			kind: "continue",
			httpStatus: 400,
			errorType: "invalid_request_error",
		});
		expect(h.bridge.status().parked).toBe(1);

		// A result within the limit still continues the turn.
		const retry = continueTurn(h, t.plan.turnId, {
			tools,
			messages: answer("SHORTER"),
		});
		expect(await call).toEqual({
			content: [{ type: "text", text: "SHORTER" }],
			isError: false,
		});
		t.query.emit(
			...streamedMessage([{ type: "text", text: "done" }]),
			resultMessage(),
		);
		expect((await reply(retry.response)).status).toBe(200);
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)?.status).toBe("completed");
	});
});

describe("a context Claude Code rewrote", () => {
	const rewrites: Array<[string, SDKMessage]> = [
		[
			"compact_boundary",
			{
				type: "system",
				subtype: "compact_boundary",
				compact_metadata: { trigger: "auto", pre_tokens: 190_000 },
				uuid: crypto.randomUUID(),
				session_id: "s",
			} as unknown as SDKMessage,
		],
		[
			"microcompact_boundary",
			{
				type: "system",
				subtype: "microcompact_boundary",
				uuid: crypto.randomUUID(),
				session_id: "s",
			} as unknown as SDKMessage,
		],
		[
			"hint_clears",
			{
				type: "hint_clears",
				ids: ["toolu_old"],
				content_by_id: {},
				uuid: crypto.randomUUID(),
				session_id: "s",
			} as unknown as SDKMessage,
		],
	];

	for (const [name, message] of rewrites)
		it(`fails the turn on ${name} with a named 502, and records it`, async () => {
			const h = harness();
			const t = await start(h, { messages: [{ role: "user", content: "hi" }] });
			t.query.emit(initMessage(), message);
			const r = await reply(t.response);
			expect(r.status).toBe(502);
			expect(r.json).toEqual({
				type: "error",
				error: {
					type: "api_error",
					code: "sdk_bridge_context_rewritten",
					message: `Claude Code rewrote the conversation's context (${name}); the model no longer sees it as the client sent it`,
				},
			});
			await settled(h);
			expect(t.query.interrupted || t.query.closed).toBe(true);
			expect(h.repo.turns.get(t.plan.turnId)).toMatchObject({
				status: "failed",
				httpStatus: 502,
				errorType: "api_error",
			});
			expect(String(h.repo.turns.get(t.plan.turnId)?.errorMessage)).toContain(
				name,
			);
		});

	it("ends a reply already streaming with an SSE error", async () => {
		const h = harness();
		const t = await start(h, { messages: [{ role: "user", content: "hi" }] });
		const [, message] = rewrites[0] as [string, SDKMessage];
		const streamed = streamedMessage([{ type: "text", text: "partial" }]);
		// Everything up to message_stop: the reply is open, not finished.
		t.query.emit(initMessage(), ...streamed.slice(0, -1), message);
		const r = await reply(t.response);
		expect(r.status).toBe(200);
		expect(r.errors.map((e) => e.data)).toEqual([
			{
				type: "error",
				error: expect.objectContaining({
					type: "api_error",
					code: "sdk_bridge_context_rewritten",
				}),
			},
		]);
	});
});
