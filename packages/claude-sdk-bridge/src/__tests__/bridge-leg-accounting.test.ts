/**
 * What each leg records for the client API: the outer request's identity,
 * the inner calls admitted under it, whether the proxy failed over from it,
 * and when no further call can be counted toward it (settled). A call keeps
 * the leg it was admitted under, so a later leg never claims it, and a leg
 * settles only once its own dispatches have ended.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import {
	SdkBridgeCapacityError,
	SdkBridgeExtraUsageError,
	type SdkBridgeTurnMeta,
} from "@clankermux/types";
import {
	type FakeQuery,
	type Harness,
	initMessage,
	MODEL,
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

function harness(overrides: Parameters<typeof makeHarness>[0] = {}): Harness {
	const h = makeHarness(overrides);
	harnesses.push(h);
	return h;
}

const OWNER_META = {
	correlationTag: "run-7",
	model: "alias:balanced",
	project: "client-project",
} satisfies Partial<SdkBridgeTurnMeta>;

/**
 * Every inner call reports its row as begun under the leg it was admitted
 * with, then answers 200; `hold` keeps the next call in flight, row not yet
 * begun, until released.
 */
function reportingInner(h: Harness) {
	const held: Array<() => void> = [];
	let holdNext = false;
	h.inner.respond = async (_req, ctx) => {
		if (holdNext) {
			holdNext = false;
			await new Promise<void>((resolve) => held.push(resolve));
		}
		ctx.onInnerRequestStarted?.(crypto.randomUUID(), ctx.legId);
		return new Response("ok");
	};
	return {
		hold: () => {
			holdNext = true;
		},
		release: () => held.shift()?.(),
	};
}

async function innerCall(query: FakeQuery): Promise<Response> {
	const env = query.options.env ?? {};
	return fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ model: MODEL, messages: [], stream: true }),
	});
}

async function startTurn(
	h: Harness,
	body: Record<string, unknown>,
	meta: Partial<SdkBridgeTurnMeta> = OWNER_META,
) {
	const p = makePlan();
	const m = makeMeta(meta);
	const response = h.bridge.startTurn({
		request: messagesRequest(body),
		plan: p,
		meta: m,
		signal: new AbortController().signal,
	});
	const query = await h.sdk.next();
	return { response, query, plan: p, meta: m };
}

async function text(response: Promise<Response>) {
	const res = await response;
	return { status: res.status, events: parseSse(await res.text()) };
}

const legOf = (h: Harness, id: string) => h.repo.legs.get(id);

describe("a start leg", () => {
	it("records the outer request's identity and its own calls, and settles once they are dispatched", async () => {
		const h = harness();
		reportingInner(h);
		const t = await startTurn(h, {
			messages: [{ role: "user", content: "hello" }],
		});
		await innerCall(t.query);
		await innerCall(t.query);
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "hi" }]),
			resultMessage(),
		);
		expect((await text(t.response)).status).toBe(200);
		await waitFor(() => legOf(h, t.meta.legId)?.settledAt != null);
		expect(legOf(h, t.meta.legId)).toMatchObject({
			kind: "start",
			apiKeyId: "key-1",
			correlationTag: "run-7",
			requestedModel: "alias:balanced",
			project: "client-project",
			innerCallCount: 2,
		});
		expect(legOf(h, t.meta.legId)?.failedOver).toBeFalsy();
		expect(h.repo.turns.get(t.plan.turnId)?.counters.innerCalls).toBe(2);
	});

	it("records a rebuilt start the same way", async () => {
		const h = harness();
		reportingInner(h);
		const t = await startTurn(h, {
			messages: [
				{ role: "user", content: "earlier" },
				{ role: "assistant", content: "answer" },
				{ role: "user", content: "and now" },
			],
		});
		await innerCall(t.query);
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "ok" }]),
			resultMessage(),
		);
		await text(t.response);
		await waitFor(() => legOf(h, t.meta.legId)?.settledAt != null);
		expect(h.repo.turns.get(t.plan.turnId)?.historyMode).toStartWith("rebuild");
		expect(legOf(h, t.meta.legId)).toMatchObject({
			correlationTag: "run-7",
			innerCallCount: 1,
		});
	});
});

describe("a tool round", () => {
	const tools = [READ_TOOL];
	const first = { role: "user", content: "TOOL read a.txt" };
	const toolUse = {
		type: "tool_use" as const,
		id: "toolu_1",
		name: "mcp__c__read",
		input: { path: "a.txt" },
	};

	it("keeps a call admitted before the park on the first leg, which settles only once it is dispatched", async () => {
		const h = harness();
		const inner = reportingInner(h);
		const t = await startTurn(h, { tools, messages: [first] });
		await innerCall(t.query);
		inner.hold();
		const late = innerCall(t.query);
		await waitFor(() => h.inner.calls.length === 2);
		t.query.emit(initMessage(), ...streamedMessage([toolUse]));
		const r1 = await text(t.response);
		expect(r1.status).toBe(200);
		const call = t.query.callTool("toolu_1", "read", { path: "a.txt" });
		await waitFor(() => h.bridge.status().parked === 1);
		await waitFor(() => legOf(h, t.meta.legId)?.finished === true);
		await Bun.sleep(30);
		expect(legOf(h, t.meta.legId)).toMatchObject({ innerCallCount: 1 });
		expect(legOf(h, t.meta.legId)?.settledAt).toBeUndefined();

		inner.release();
		await late;
		await waitFor(() => legOf(h, t.meta.legId)?.settledAt != null);
		expect(legOf(h, t.meta.legId)?.innerCallCount).toBe(2);

		const continuation = makeMeta({
			...OWNER_META,
			correlationTag: "run-8",
		});
		const response = h.bridge.continueTurn({
			turnId: t.plan.turnId,
			request: messagesRequest({
				tools,
				messages: [
					first,
					{ role: "assistant", content: [toolUse] },
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "toolu_1", content: "A" },
							{ type: "text", text: "and keep going" },
						],
					},
				],
			}),
			meta: continuation,
			signal: new AbortController().signal,
		});
		await call;
		await innerCall(t.query);
		t.query.emit(
			...streamedMessage([{ type: "text", text: "done" }]),
			resultMessage(),
		);
		expect((await text(response)).status).toBe(200);
		await waitFor(() => legOf(h, continuation.legId)?.settledAt != null);
		expect(legOf(h, continuation.legId)).toMatchObject({
			kind: "continue",
			correlationTag: "run-8",
			requestedModel: "alias:balanced",
			innerCallCount: 1,
		});
		expect(legOf(h, t.meta.legId)?.innerCallCount).toBe(2);
		expect(h.repo.turns.get(t.plan.turnId)?.counters.innerCalls).toBe(3);
	});

	it("settles another key's refused continuation with its own identity", async () => {
		const h = harness();
		const t = await startTurn(h, { tools, messages: [first] });
		t.query.emit(initMessage(), ...streamedMessage([toolUse]));
		await text(t.response);
		const refused = makeMeta({
			apiKeyId: "key-2",
			project: "key-2-project",
			correlationTag: "theirs",
		});
		const res = await h.bridge.continueTurn({
			turnId: t.plan.turnId,
			request: messagesRequest({
				tools,
				messages: [
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "toolu_1", content: "x" },
						],
					},
				],
			}),
			meta: refused,
			signal: new AbortController().signal,
		});
		expect(res.status).toBe(409);
		await waitFor(() => legOf(h, refused.legId)?.finished === true);
		expect(legOf(h, refused.legId)).toMatchObject({
			kind: "continue",
			apiKeyId: "key-2",
			project: "key-2-project",
			correlationTag: "theirs",
			innerCallCount: 0,
		});
		expect(legOf(h, refused.legId)?.settledAt).toBeNumber();
	});
});

describe("a start refused before Claude Code runs", () => {
	it("is settled with its finish", async () => {
		const h = harness();
		const meta = makeMeta({ ...OWNER_META, sideRequest: "bogus" });
		const res = await h.bridge.startTurn({
			request: messagesRequest({
				messages: [{ role: "user", content: "hi" }],
			}),
			plan: makePlan(),
			meta,
			signal: new AbortController().signal,
		});
		expect(res.status).toBe(400);
		await waitFor(() => legOf(h, meta.legId)?.finished === true);
		expect(legOf(h, meta.legId)).toMatchObject({
			correlationTag: "run-7",
			settledAt: expect.any(Number),
		});
		expect(legOf(h, meta.legId)?.failedOver).toBeFalsy();
	});

	it("at the process cap is marked failed over: the proxy answers it elsewhere", async () => {
		const h = harness({ limits: () => ({ maxProcesses: 1 }) });
		await startTurn(h, { messages: [{ role: "user", content: "one" }] });
		const meta = makeMeta(OWNER_META);
		await expect(
			h.bridge.startTurn({
				request: messagesRequest({
					messages: [{ role: "user", content: "two" }],
				}),
				plan: makePlan(),
				meta,
				signal: new AbortController().signal,
			}),
		).rejects.toBeInstanceOf(SdkBridgeCapacityError);
		await waitFor(() => legOf(h, meta.legId)?.finished === true);
		expect(legOf(h, meta.legId)).toMatchObject({ failedOver: true });
	});
});

describe("a start leg that fails over", () => {
	it("is marked failed over", async () => {
		const h = harness();
		const message = "You're out of extra usage. Add more and keep going.";
		h.inner.respond = (_req, ctx) => {
			const requestId = crypto.randomUUID();
			ctx.onInnerRequestStarted?.(requestId, ctx.legId);
			ctx.onInnerOutcome?.({
				requestId,
				status: 400,
				errorType: "invalid_request_error",
				message,
				retryAfter: null,
				accountId: "acct-a",
			});
			return Response.json(
				{ type: "error", error: { type: "invalid_request_error", message } },
				{ status: 400 },
			);
		};
		const t = await startTurn(h, {
			messages: [{ role: "user", content: "hello" }],
		});
		await innerCall(t.query);
		t.query.emit(
			initMessage(),
			resultMessage({
				isError: true,
				subtype: "success",
				result: `API Error: 400 ${message}`,
			}),
		);
		await expect(t.response).rejects.toBeInstanceOf(SdkBridgeExtraUsageError);
		await waitFor(() => legOf(h, t.meta.legId)?.finished === true);
		expect(legOf(h, t.meta.legId)).toMatchObject({
			failedOver: true,
			innerCallCount: 1,
		});
	});
});
