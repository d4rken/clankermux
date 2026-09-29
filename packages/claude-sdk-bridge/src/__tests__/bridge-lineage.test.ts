/**
 * How a turn's history relates to what the bridge stored for its client
 * session: a compaction that rewrote the first message, and a history that
 * carries the stored conversation plus turns another model answered.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import {
	SDK_BRIDGE_HISTORY_HEADER,
	SdkBridgeCapacityError,
	type SdkBridgeRoutePlan,
	type SdkBridgeTurnMeta,
} from "@clankermux/types";
import {
	type FakeQuery,
	foldReply,
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

type Msg = { role: string; content: unknown };
type Entry = Record<string, unknown> & { uuid?: string; parentUuid?: unknown };

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

function sessionsDir(h: Harness): string {
	const [name] = readdirSync(h.workRoot).filter((n) => n.startsWith("gen-"));
	if (!name) throw new Error("no generation directory");
	return join(h.workRoot, name, "sessions");
}

const sessionFile = (h: Harness, sessionId: string) =>
	join(sessionsDir(h), `${sessionId}.jsonl`);

const entriesOf = (text: string): Entry[] =>
	text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Entry);

async function start(
	h: Harness,
	messages: Msg[],
	opts: {
		meta?: Partial<SdkBridgeTurnMeta>;
		plan?: Partial<SdkBridgeRoutePlan>;
	} = {},
) {
	const plan = makePlan(opts.plan);
	const response = h.bridge.startTurn({
		request: messagesRequest({ tools: [READ_TOOL], messages }),
		plan,
		meta: makeMeta(opts.meta),
		signal: new AbortController().signal,
	});
	const query = await h.sdk.next();
	return { response, query, plan };
}

async function reply(response: Promise<Response>) {
	const res = await response;
	const events = parseSse(await res.text());
	return {
		status: res.status,
		history: res.headers.get(SDK_BRIDGE_HISTORY_HEADER),
		...foldReply(events),
	};
}

async function settled(h: Harness) {
	await waitFor(() => h.bridge.status().live === 0);
	await Bun.sleep(10);
}

/** What the real CLI does through `sessionStore.append`: mirror its transcript. */
async function mirror(query: FakeQuery, entries: Entry[]) {
	const store = query.options.sessionStore as SessionStore;
	const sessionId = (query.options.sessionId ?? query.options.resume) as string;
	await store.append(
		{ projectKey: "p", sessionId },
		entries.map((e) => ({ sessionId, ...e })) as never,
	);
}

/** The last entry with a uuid in the session file a query runs on, if any. */
function lastUuid(h: Harness, query: FakeQuery): string | null {
	const sessionId = (query.options.sessionId ?? query.options.resume) as string;
	let text: string;
	try {
		text = readFileSync(sessionFile(h, sessionId), "utf8");
	} catch {
		return null;
	}
	return (
		entriesOf(text)
			.filter((e) => typeof e.uuid === "string")
			.at(-1)?.uuid ?? null
	);
}

/**
 * One user turn answered `answer`, with Claude Code's transcript of it
 * mirrored after the session's last entry: the prompt, a date attachment,
 * the reply and a metadata line without a uuid.
 */
async function answered(
	h: Harness,
	messages: Msg[],
	answer: string,
	opts: {
		meta?: Partial<SdkBridgeTurnMeta>;
		plan?: Partial<SdkBridgeRoutePlan>;
	} = {},
) {
	const t = await start(h, messages, opts);
	const tag = t.plan.turnId.slice(0, 8);
	await mirror(t.query, [
		{
			type: "user",
			uuid: `${tag}-u`,
			parentUuid: lastUuid(h, t.query),
			message: { role: "user", content: "prompt" },
		},
		{
			type: "attachment",
			uuid: `${tag}-date`,
			parentUuid: `${tag}-u`,
			attachment: { type: "date" },
		},
		{
			type: "assistant",
			uuid: `${tag}-a`,
			parentUuid: `${tag}-date`,
			message: {
				id: `msg_${tag}`,
				role: "assistant",
				content: [{ type: "text", text: answer }],
			},
		},
		{ type: "last-prompt" },
	]);
	t.query.emit(
		initMessage(),
		...streamedMessage([{ type: "text", text: answer }]),
		resultMessage(),
	);
	const r = await reply(t.response);
	await settled(h);
	return { ...t, r, leaf: `${tag}-a` };
}

const session = {
	affinityScope: "client_session",
	affinityKey: "sess-lineage",
} as const;

const said = (text: string): Msg => ({
	role: "assistant",
	content: [{ type: "text", text }],
});

describe("a history whose first message changed under the same client session", () => {
	/** A main conversation of two turns: four messages stored. */
	async function mainConversation(h: Harness) {
		await answered(h, [{ role: "user", content: "hello" }], "a1", {
			meta: session,
		});
		const messages: Msg[] = [
			{ role: "user", content: "hello" },
			said("a1"),
			{ role: "user", content: "more" },
		];
		const two = await answered(h, messages, "a2", { meta: session });
		expect(two.r.history).toBe("resume");
		return [...messages, said("a2")];
	}

	const compacted: Msg[] = [
		{
			role: "user",
			content:
				"The conversation history before this point was compacted into the following summary:\n\nhello, more",
		},
		said("kept"),
		{ role: "user", content: "next" },
	];

	it("is a compaction when it is shorter than a conversation stored under that session", async () => {
		const h = harness();
		await mainConversation(h);
		const t = await answered(h, compacted, "after", { meta: session });
		expect(t.r.history).toBe("rebuild_transcript; reason=compaction");
		expect(h.repo.turns.get(t.plan.turnId)).toMatchObject({
			historyMode: "rebuild_transcript",
			rebuildReason: "compaction",
		});
	});

	it("stays a compaction when a helper call of the session settled after the main conversation", async () => {
		const h = harness();
		await mainConversation(h);
		// OpenCode's title helper: no history, so it is fresh and takes no reason.
		const helper = await answered(
			h,
			[{ role: "user", content: "Generate a title for this conversation" }],
			"A title",
			{ meta: session },
		);
		expect(helper.r.history).toBe("fresh");
		expect(h.repo.turns.get(helper.plan.turnId)).toMatchObject({
			historyMode: "fresh",
			rebuildReason: null,
		});
		const t = await answered(h, compacted, "after", { meta: session });
		expect(t.r.history).toBe("rebuild_transcript; reason=compaction");
	});

	it("stays unknown when no conversation stored under the session is longer", async () => {
		const h = harness();
		await answered(h, [{ role: "user", content: "hello" }], "a1", {
			meta: session,
		});
		const t = await answered(
			h,
			[
				{ role: "user", content: "an unrelated start" },
				said("x"),
				{ role: "user", content: "y" },
				said("z"),
				{ role: "user", content: "next" },
			],
			"after",
			{ meta: session },
		);
		expect(t.r.history).toBe("rebuild_transcript; reason=unknown");
	});

	it("stays unknown under a session nothing was stored for", async () => {
		const h = harness();
		await mainConversation(h);
		const t = await answered(h, compacted, "after", {
			meta: { ...session, affinityKey: "sess-other" },
		});
		expect(t.r.history).toBe("rebuild_transcript; reason=unknown");
	});
});

describe("a history that is the stored conversation plus the client's own turns", () => {
	const hello: Msg = { role: "user", content: "hello" };
	/** A turn another model answered, with a tool call in pi's call id shape. */
	const gptRound = (n: number): Msg[] => [
		{ role: "user", content: `and file ${n}?` },
		{
			role: "assistant",
			content: [
				{ type: "text", text: `Reading ${n}.` },
				{
					type: "tool_use",
					id: `call_${n}|fc_${n}`,
					name: "read",
					input: { path: `${n}.txt` },
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: `call_${n}|fc_${n}`,
					content: `FILE-${n}`,
				},
			],
		},
		said(`File ${n} read.`),
	];

	async function stored(h: Harness, opts: { raw?: string } = {}) {
		const one = await answered(h, [hello], "echo: hello", { meta: session });
		const path = sessionFile(h, one.query.options.sessionId as string);
		if (opts.raw !== undefined) writeFileSync(path, opts.raw);
		return { ...one, path, bytes: readFileSync(path, "utf8") };
	}

	it("resumes the stored session with those turns appended after its leaf", async () => {
		const h = harness();
		const one = await stored(h);
		const messages = [
			hello,
			said("echo: hello"),
			...gptRound(1),
			{ role: "user", content: "back to you" },
		];
		const two = await start(h, messages, { meta: session });
		const resumed = two.query.options.resume as string;
		expect(resumed).toBeTruthy();
		expect(two.query.prompts[0]?.message.content).toEqual([
			{ type: "text", text: "back to you" },
		]);

		// The stored bytes, under the new id, then the appended entries.
		const oldId = one.query.options.sessionId as string;
		const copy = readFileSync(sessionFile(h, resumed), "utf8");
		const prefix = one.bytes.replaceAll(
			`"sessionId":"${oldId}"`,
			`"sessionId":"${resumed}"`,
		);
		expect(copy.startsWith(prefix)).toBe(true);
		const added = entriesOf(copy.slice(prefix.length));
		expect(added.map((e) => e.type)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(added[0]?.parentUuid).toBe(one.leaf);
		expect(added.slice(1).map((e) => e.parentUuid)).toEqual(
			added.slice(0, -1).map((e) => e.uuid),
		);
		expect(added.every((e) => e.sessionId === resumed)).toBe(true);
		expect(
			(added[1]?.message as { content: unknown[] }).content[1],
		).toMatchObject({
			type: "tool_use",
			id: "call_1|fc_1",
			name: "mcp__c__read",
		});
		expect((added[1]?.message as { id: string }).id).toBe(
			`msg_sdk_bridge_${two.plan.turnId}_1`,
		);
		// The stored session is left as it was.
		expect(readFileSync(one.path, "utf8")).toBe(one.bytes);

		two.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "echo: back" }]),
			resultMessage(),
		);
		const r2 = await reply(two.response);
		expect(r2.history).toBe("resume_extended; reason=continuation");
		expect(h.repo.turns.get(two.plan.turnId)).toMatchObject({
			historyMode: "resume_extended",
			rebuildReason: "continuation",
		});
		expect(h.bridge.status().counters).toMatchObject({
			resumes: 1,
			rebuilds: 0,
		});
	});

	it("extends a session it extended before, never repeating a message id", async () => {
		const h = harness();
		const one = await stored(h);
		const first = [
			hello,
			said("echo: hello"),
			...gptRound(1),
			{ role: "user", content: "back to you" },
		];
		const two = await answered(h, first, "echo: back", { meta: session });
		expect(two.r.history).toBe("resume_extended; reason=continuation");

		const second = [
			...first,
			said("echo: back"),
			...gptRound(2),
			{ role: "user", content: "back again" },
		];
		const three = await start(h, second, { meta: session });
		three.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "echo: again" }]),
			resultMessage(),
		);
		expect((await reply(three.response)).history).toBe(
			"resume_extended; reason=continuation",
		);
		const entries = entriesOf(
			readFileSync(
				sessionFile(h, three.query.options.resume as string),
				"utf8",
			),
		);
		const ids = entries.flatMap((e) =>
			e.type === "assistant" ? [(e.message as { id: string }).id] : [],
		);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain(`msg_sdk_bridge_${two.plan.turnId}_1`);
		expect(ids).toContain(`msg_sdk_bridge_${three.plan.turnId}_1`);
		// The second tail follows the reply Claude Code wrote for the first.
		const tail = entries.slice(-4);
		expect(tail[0]?.parentUuid).toBe(two.leaf);
		expect(one.leaf).not.toBe(two.leaf);
	});

	it("records an account change on the resume", async () => {
		const h = harness();
		await stored(h);
		const t = await answered(
			h,
			[
				hello,
				said("echo: hello"),
				...gptRound(1),
				{ role: "user", content: "back to you" },
			],
			"echo: back",
			{
				meta: session,
				plan: {
					candidates: [
						{
							accountId: "acct-b",
							provider: "anthropic",
							upstreamModel: MODEL,
						},
					],
					preferredAccountId: "acct-b",
				},
			},
		);
		expect(t.r.history).toBe("resume_extended; reason=account_change");
	});

	it("rebuilds the whole history when the added turns call a tool this turn lacks", async () => {
		const h = harness();
		await stored(h);
		const foreign = gptRound(1).map((m) =>
			m.role === "assistant" && Array.isArray(m.content)
				? {
						...m,
						content: (m.content as Array<Record<string, unknown>>).map((b) =>
							b.type === "tool_use" ? { ...b, name: "write" } : b,
						),
					}
				: m,
		);
		const t = await answered(
			h,
			[
				hello,
				said("echo: hello"),
				...foreign,
				{ role: "user", content: "back" },
			],
			"x",
			{ meta: session },
		);
		expect(t.r.history).toBe("rebuild_flattened; reason=continuation");
	});

	it("rebuilds the whole history when the added turns carry thinking", async () => {
		const h = harness();
		await stored(h);
		const t = await answered(
			h,
			[
				hello,
				said("echo: hello"),
				{ role: "user", content: "think about it" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "t", signature: "sig-elsewhere" },
						{ type: "text", text: "Thought." },
					],
				},
				{ role: "user", content: "back" },
			],
			"x",
			{ meta: session },
		);
		expect(t.r.history).toBe("rebuild_transcript; reason=continuation");
	});

	describe("rebuilds the whole history, leaving the stored session, when it cannot extend", () => {
		const extended = () => [
			hello,
			said("echo: hello"),
			...gptRound(1),
			{ role: "user", content: "back" },
		];

		it("because the stored transcript has no leaf to append to", async () => {
			const h = harness();
			const raw = `${JSON.stringify({ type: "user", uuid: "u1", parentUuid: null })}\n{not json\n`;
			const one = await stored(h, { raw });
			const t = await start(h, extended(), { meta: session });
			const rebuilt = readFileSync(
				sessionFile(h, t.query.options.resume as string),
				"utf8",
			);
			// A transcript of the whole history, not a copy of the stored one.
			expect(entriesOf(rebuilt).map((e) => e.type)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
				"user",
				"assistant",
			]);
			expect(rebuilt).not.toContain('"uuid":"u1"');
			expect(readFileSync(one.path, "utf8")).toBe(raw);
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "x" }]),
				resultMessage(),
			);
			expect((await reply(t.response)).history).toBe(
				"rebuild_transcript; reason=continuation",
			);
			expect(h.bridge.status().counters).toMatchObject({
				resumes: 0,
				rebuilds: 1,
			});
		});

		it("because the stored transcript is gone", async () => {
			const h = harness();
			const one = await stored(h);
			rmSync(one.path);
			const t = await answered(h, extended(), "x", { meta: session });
			expect(t.r.history).toBe("rebuild_transcript; reason=continuation");
		});

		it("and refuses that rebuild at the rebuild cap", async () => {
			const h = harness({ limits: () => ({ maxConcurrentRebuilds: 1 }) });
			const one = await stored(h);
			rmSync(one.path);
			// Without a session header, a history always rebuilds.
			await start(h, [
				hello,
				said("echo: hello"),
				{ role: "user", content: "q" },
			]);
			const outcome = await Promise.race([
				h.bridge
					.startTurn({
						request: messagesRequest({
							tools: [READ_TOOL],
							messages: extended(),
						}),
						plan: makePlan(),
						meta: makeMeta(session),
						signal: new AbortController().signal,
					})
					.then(
						() => "answered",
						(e: unknown) => e,
					),
				Bun.sleep(1_000).then(() => "launched"),
			]);
			expect(outcome).toBeInstanceOf(SdkBridgeCapacityError);
			expect(h.bridge.status().counters.rejected).toEqual({ rebuild_cap: 1 });
		});
	});
});
