/**
 * A model call that stops on `refusal` (Anthropic's safety classifiers) while
 * nothing of the start leg's reply has reached the client: the leg's response
 * rejects with SdkBridgeSafetyRefusalError, so the proxy moves the request on
 * to a destination that is not a Claude account. Its terminal answer is what
 * the client would have got, for the request no other destination serves.
 * Once the head is out, or on a continuation, the refusal answers as before.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	SDK_BRIDGE_HISTORY_HEADER,
	SdkBridgeSafetyRefusalError,
	type SdkBridgeTurnMeta,
} from "@clankermux/types";
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

async function start(
	h: Harness,
	body: Record<string, unknown>,
	meta: Partial<SdkBridgeTurnMeta> = {},
) {
	const plan = makePlan();
	const legMeta = makeMeta(meta);
	const response = h.bridge.startTurn({
		request: messagesRequest(body),
		plan,
		meta: legMeta,
		signal: new AbortController().signal,
	});
	const query = await h.sdk.next();
	return { response, query, plan, meta: legMeta };
}

async function rejection(response: Promise<Response>): Promise<unknown> {
	try {
		await response;
	} catch (error) {
		return error;
	}
	throw new Error("the start leg answered instead of failing over");
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

async function settled(h: Harness) {
	await waitFor(() => h.bridge.status().live === 0);
	await Bun.sleep(10);
}

const CYBER = { type: "refusal", category: "cyber" };

/**
 * What Claude Code reports after a refused call with no fallback model: its
 * notice, its own error message and an error result.
 */
function afterRefusal(): SDKMessage[] {
	return [
		{
			type: "system",
			subtype: "model_refusal_no_fallback",
			uuid: crypto.randomUUID(),
			session_id: "s",
		} as unknown as SDKMessage,
		assistantMessage(
			[{ type: "text", text: "API Error: safeguards flagged this message" }],
			{ model: "<synthetic>", error: "invalid_request", stopReason: "refusal" },
		),
		resultMessage({
			isError: true,
			result: "API Error: safeguards flagged this message",
			terminalReason: "api_error",
		}),
	];
}

const ASK = { messages: [{ role: "user", content: "scan that host" }] };
const STRUCTURED = {
	...ASK,
	output_config: {
		format: {
			type: "json_schema",
			schema: {
				type: "object",
				properties: { ports: { type: "array" } },
				required: ["ports"],
			},
		},
	},
};

describe("a structured turn refused before its head", () => {
	for (const stream of [true, false])
		it(`fails a ${stream ? "streamed" : "non-streamed"} start over, the query closed first, with today's 502 as its answer`, async () => {
			const h = harness();
			const t = await start(h, { ...STRUCTURED, stream });
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "I can't help" }], {
					stopReason: "refusal",
					stopDetails: CYBER,
				}),
				...afterRefusal(),
			);
			const error = await rejection(t.response);
			expect(h.bridge.status().live).toBe(0);
			expect(error).toBeInstanceOf(SdkBridgeSafetyRefusalError);
			const refused = error as SdkBridgeSafetyRefusalError;
			expect(refused).toMatchObject({
				reason: "safety_refusal",
				category: "cyber",
				status: 502,
				retryAfter: null,
			});
			const answer = refused.terminalResponse();
			expect(answer.status).toBe(502);
			expect(answer.headers.get(SDK_BRIDGE_HISTORY_HEADER)).toBeString();
			expect(await answer.json()).toEqual({
				type: "error",
				error: {
					type: "api_error",
					message:
						"No answer matching the response schema: the model refused to answer",
					code: "structured_output_failed",
				},
			});
			await waitFor(() => h.repo.turns.get(t.plan.turnId)?.status === "failed");
			expect(h.repo.turns.get(t.plan.turnId)?.legs[0]).toMatchObject({
				httpStatus: 502,
				errorPhase: "pre_head",
				failedOver: true,
			});
		});

	it("carries no category when the refusal named none", async () => {
		const h = harness();
		const t = await start(h, STRUCTURED);
		t.query.emit(
			initMessage(),
			...streamedMessage([], { stopReason: "refusal" }),
			...afterRefusal(),
		);
		const error = (await rejection(t.response)) as SdkBridgeSafetyRefusalError;
		expect(error).toBeInstanceOf(SdkBridgeSafetyRefusalError);
		expect(error.category).toBeNull();
	});

	it("answers through the stream once the head is out", async () => {
		const h = harness(50);
		const t = await start(h, STRUCTURED);
		t.query.emit(initMessage());
		const res = await t.response;
		expect(res.status).toBe(200);
		t.query.emit(
			...streamedMessage([{ type: "text", text: "I can't help" }], {
				stopReason: "refusal",
				stopDetails: CYBER,
			}),
			...afterRefusal(),
		);
		const r = await reply(Promise.resolve(res));
		expect(r.errors.map((e) => e.data)).toEqual([
			{
				type: "error",
				error: expect.objectContaining({ code: "structured_output_failed" }),
			},
		]);
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)?.legs[0]).toMatchObject({
			errorPhase: "mid_stream",
			failedOver: false,
		});
	});
});

describe("an ordinary turn refused before its head", () => {
	it("fails a non-streamed start over, with today's 200 refusal message as its answer", async () => {
		const h = harness();
		const t = await start(h, { ...ASK, stream: false });
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "I can't help" }], {
				id: "msg_refused",
				stopReason: "refusal",
				stopDetails: CYBER,
			}),
			...afterRefusal(),
		);
		const error = await rejection(t.response);
		expect(h.bridge.status().live).toBe(0);
		expect(error).toBeInstanceOf(SdkBridgeSafetyRefusalError);
		const refused = error as SdkBridgeSafetyRefusalError;
		expect(refused).toMatchObject({
			reason: "safety_refusal",
			category: "cyber",
			status: 200,
		});
		const answer = refused.terminalResponse();
		expect(answer.status).toBe(200);
		expect(answer.headers.get("content-type")).toContain("application/json");
		expect(answer.headers.get(SDK_BRIDGE_HISTORY_HEADER)).toBeString();
		expect(await answer.json()).toEqual({
			id: "msg_refused",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-5",
			content: [{ type: "text", text: "I can't help" }],
			stop_reason: "refusal",
			stop_sequence: null,
			usage: {
				input_tokens: 10,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
				output_tokens: 5,
			},
		});
		// A body reads once; the answer is built fresh each time.
		expect((await refused.terminalResponse().json()).stop_reason).toBe(
			"refusal",
		);
		await waitFor(() => h.repo.turns.get(t.plan.turnId)?.status === "failed");
		const turn = h.repo.turns.get(t.plan.turnId);
		expect(turn).toMatchObject({ stopReason: "refusal" });
		expect(turn?.legs[0]).toMatchObject({
			httpStatus: 200,
			errorPhase: "pre_head",
			failedOver: true,
		});
	});

	it("does the same for a message Claude Code fetched without streaming", async () => {
		const h = harness();
		const t = await start(h, { ...ASK, stream: false });
		t.query.emit(
			initMessage(),
			assistantMessage([{ type: "text", text: "No." }], {
				stopReason: "refusal",
				stopDetails: { type: "refusal", category: "bio" },
			}),
			...afterRefusal(),
		);
		const error = (await rejection(t.response)) as SdkBridgeSafetyRefusalError;
		expect(error).toBeInstanceOf(SdkBridgeSafetyRefusalError);
		expect(error.category).toBe("bio");
		expect(await error.terminalResponse().json()).toMatchObject({
			content: [{ type: "text", text: "No." }],
			stop_reason: "refusal",
		});
	});

	it("answers a streamed start as before: its head went out with the first event", async () => {
		const h = harness();
		const t = await start(h, ASK);
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "I can't help" }], {
				stopReason: "refusal",
				stopDetails: CYBER,
			}),
			...afterRefusal(),
		);
		const r = await reply(t.response);
		expect(r.status).toBe(200);
		expect(r.stop).toBe("refusal");
		expect(r.content).toEqual([{ type: "text", text: "I can't help" }]);
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)).toMatchObject({
			status: "completed",
			stopReason: "refusal",
		});
		expect(h.repo.turns.get(t.plan.turnId)?.legs[0]).toMatchObject({
			httpStatus: 200,
			failedOver: false,
		});
	});

	it("answers a refused continuation as before: the turn lives in this query alone", async () => {
		const h = harness();
		const first = { role: "user", content: "read a.txt" };
		const t = await start(h, { tools: [READ_TOOL], messages: [first] });
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
		expect(r1.stop).toBe("tool_use");
		const call = t.query.callTool("toolu_1", "read", { path: "a.txt" });
		await waitFor(() => h.bridge.status().parked === 1);
		const continued = h.bridge.continueTurn({
			turnId: t.plan.turnId,
			request: messagesRequest({
				stream: false,
				tools: [READ_TOOL],
				messages: [
					first,
					{ role: "assistant", content: r1.content },
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "toolu_1", content: "A" },
						],
					},
				],
			}),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		await call;
		continueRefused(t.query);
		const r2 = await reply(continued);
		expect(r2.status).toBe(200);
		expect(r2.body).toMatchObject({ stop_reason: "refusal" });
		await settled(h);
		expect(
			h.repo.turns.get(t.plan.turnId)?.legs.map((l) => l.failedOver),
		).toEqual([false, false]);
	});
});

function continueRefused(query: FakeQuery) {
	query.emit(
		...streamedMessage([{ type: "text", text: "I can't" }], {
			stopReason: "refusal",
			stopDetails: CYBER,
		}),
		...afterRefusal(),
	);
}

describe("a safety refusal that became the request's answer", () => {
	/** Counts the publication writes that reach the repository. */
	function countPublications(h: Harness) {
		const calls: Array<[string, string | null]> = [];
		const publish = h.repo.publishFailedOverLeg.bind(h.repo);
		h.repo.publishFailedOverLeg = async (id, stopReason, fence) => {
			calls.push([id, stopReason]);
			return publish(id, stopReason, fence);
		};
		return calls;
	}

	it("publishes the refused message's leg as the answer, once, after its finish", async () => {
		const h = harness();
		const calls = countPublications(h);
		const t = await start(h, { ...ASK, stream: false });
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "I can't help" }], {
				stopReason: "refusal",
				stopDetails: CYBER,
			}),
			...afterRefusal(),
		);
		const refused = (await rejection(
			t.response,
		)) as SdkBridgeSafetyRefusalError;
		// Building the answer publishes nothing.
		refused.terminalResponse();
		await Bun.sleep(20);
		expect(calls).toEqual([]);

		await Promise.all([refused.publishAsAnswer(), refused.publishAsAnswer()]);
		await refused.publishAsAnswer();

		expect(calls).toEqual([[t.meta.legId, "refusal"]]);
		expect(h.repo.legs.get(t.meta.legId)).toMatchObject({
			finished: true,
			failedOver: false,
			httpStatus: 200,
			stopReason: "refusal",
			errorType: null,
			errorMessage: null,
			errorPhase: null,
		});
	});

	it("keeps a structured refusal's error facts", async () => {
		const h = harness();
		const calls = countPublications(h);
		const t = await start(h, STRUCTURED);
		t.query.emit(
			initMessage(),
			...streamedMessage([], { stopReason: "refusal", stopDetails: CYBER }),
			...afterRefusal(),
		);
		const refused = (await rejection(
			t.response,
		)) as SdkBridgeSafetyRefusalError;

		await refused.publishAsAnswer();

		expect(calls).toEqual([[t.meta.legId, null]]);
		expect(h.repo.legs.get(t.meta.legId)).toMatchObject({
			failedOver: false,
			httpStatus: 502,
			errorPhase: "pre_head",
			errorType: "api_error",
			errorMessage:
				"No answer matching the response schema: the model refused to answer",
		});
	});
});
