import { describe, expect, it } from "bun:test";
import {
	answersFinalToolCalls,
	buildSyntheticTranscript,
	classifyRebuild,
	extensionTail,
	FLATTENED_HISTORY_NOTE,
	firstUserDigest,
	flattenHistory,
	messageDigests,
	messagesAfter,
	normalizeHistory,
	transcriptEligible,
} from "../history";
import type { ClientMessage } from "../turn-request";

const conversation: ClientMessage[] = [
	{ role: "user", content: "read a.txt and b.txt" },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "plan", signature: "sig-1" },
			{ type: "text", text: "Reading both." },
			{ type: "tool_use", id: "t1", name: "read", input: { path: "a.txt" } },
			{ type: "tool_use", id: "t2", name: "read", input: { path: "b.txt" } },
		],
	},
	// pi sends a turn's parallel results as separate user messages.
	{
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "t1", content: "A" }],
	},
	{
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "t2", content: "B" }],
	},
	{ role: "assistant", content: [{ type: "text", text: "A and B." }] },
];

describe("normalizeHistory", () => {
	it("merges parallel tool results into one user message after their assistant message", () => {
		const normalized = normalizeHistory(conversation);
		expect(normalized.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(normalized[2]?.content.map((b) => b.tool_use_id)).toEqual([
			"t1",
			"t2",
		]);
	});

	it("drops system messages, cache_control and thinking without a signature", () => {
		const normalized = normalizeHistory([
			{ role: "system", content: "effort: high" },
			{
				role: "user",
				content: [
					{ type: "text", text: "q", cache_control: { type: "ephemeral" } },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "x", signature: "" },
					{ type: "text", text: "a" },
				],
			},
		]);
		expect(normalized).toEqual([
			{ role: "user", content: [{ type: "text", text: "q" }] },
			{ role: "assistant", content: [{ type: "text", text: "a" }] },
		]);
	});

	it("puts tool_result blocks first in a user message", () => {
		const [message] = normalizeHistory([
			{
				role: "user",
				content: [
					{ type: "text", text: "and also" },
					{ type: "tool_result", tool_use_id: "t", content: "r" },
				],
			},
		]);
		expect(message?.content.map((b) => b.type)).toEqual([
			"tool_result",
			"text",
		]);
	});
});

describe("messageDigests", () => {
	it("ignores thinking signatures, cache_control and system-role messages", () => {
		const reencoded: ClientMessage[] = conversation.map((m) =>
			m.role === "assistant" && Array.isArray(m.content)
				? {
						...m,
						content: m.content.map((b) =>
							b.type === "thinking" ? { ...b, signature: "different" } : b,
						),
					}
				: m,
		);
		reencoded.splice(1, 0, { role: "system", content: "effort: xhigh" });
		reencoded[0] = {
			role: "user",
			content: [
				{
					type: "text",
					text: "read a.txt and b.txt",
					cache_control: { type: "ephemeral" },
				},
			],
		};
		expect(messageDigests(reencoded)).toEqual(messageDigests(conversation));
	});

	it("changes when a message's text or a tool input changes", () => {
		const edited = structuredClone(conversation);
		edited[4] = {
			role: "assistant",
			content: [{ type: "text", text: "B and A." }],
		};
		expect(messageDigests(edited)).not.toEqual(messageDigests(conversation));
		const otherInput = structuredClone(conversation);
		otherInput[1] = {
			role: "assistant",
			content: [
				{ type: "tool_use", id: "t1", name: "read", input: { path: "c.txt" } },
			],
		};
		expect(messageDigests(otherInput)[1]).not.toBe(
			messageDigests(conversation)[1],
		);
	});

	it("keys the first user message on its content only", () => {
		expect(firstUserDigest(conversation)).toBe(
			firstUserDigest([
				{
					role: "user",
					content: [{ type: "text", text: "read a.txt and b.txt" }],
				},
			]),
		);
	});
});

describe("messagesAfter", () => {
	const stored = messageDigests(conversation);

	it("gives the messages that follow the stored conversation, normalized", () => {
		expect(
			messagesAfter(
				[
					...conversation,
					{ role: "system", content: "effort: low" },
					{ role: "user", content: "recap" },
				],
				stored,
			),
		).toEqual([{ role: "user", content: [{ type: "text", text: "recap" }] }]);
		expect(messagesAfter(conversation, stored)).toEqual([]);
	});

	it("is null when the messages do not start with the stored conversation", () => {
		const edited = structuredClone(conversation);
		edited[4] = { role: "assistant", content: "something else" };
		expect(
			messagesAfter([...edited, { role: "user", content: "recap" }], stored),
		).toBeNull();
		expect(messagesAfter(conversation.slice(0, 3), stored)).toBeNull();
	});

	it("takes an empty replayed reply for an empty stored one", () => {
		// An empty reply is stored as nothing; replayed, it would merge the
		// prompt into the user message before it.
		const asked: ClientMessage[] = [{ role: "user", content: "a" }];
		const digests = messageDigests([
			...asked,
			{ role: "assistant", content: [] },
		]);
		expect(
			messagesAfter(
				[
					...asked,
					{ role: "assistant", content: [] },
					{ role: "user", content: "recap" },
				],
				digests,
			),
		).toEqual([{ role: "user", content: [{ type: "text", text: "recap" }] }]);
		// A reply that was not empty is not the stored one: it stays in the tail.
		expect(
			messagesAfter(
				[
					...asked,
					{ role: "assistant", content: "not empty" },
					{ role: "user", content: "recap" },
				],
				digests,
			)?.map((m) => m.role),
		).toEqual(["assistant", "user"]);
	});

	it("skips a message that digests empty, as the digests do", () => {
		const withThinkingOnly: ClientMessage[] = [
			{ role: "user", content: "a" },
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "t", signature: "s" }],
			},
		];
		const digests = messageDigests(withThinkingOnly);
		expect(digests).toHaveLength(1);
		expect(
			messagesAfter(
				[...withThinkingOnly, { role: "user", content: "b" }],
				digests,
			),
		).toEqual([{ role: "user", content: [{ type: "text", text: "b" }] }]);
	});
});

describe("classifyRebuild", () => {
	const stored = messageDigests(conversation);

	it("reports each lineage", () => {
		expect(classifyRebuild(null, stored, "a")).toBe("unknown");
		expect(
			classifyRebuild({ digests: stored, accountId: "a" }, stored, "a"),
		).toBe("continuation");
		expect(
			classifyRebuild({ digests: stored, accountId: "a" }, stored, "b"),
		).toBe("account_change");
		expect(
			classifyRebuild(
				{ digests: stored, accountId: "a" },
				stored.slice(0, 2),
				"a",
			),
		).toBe("compaction");
		expect(
			classifyRebuild(
				{ digests: stored, accountId: "a" },
				[...stored, "extra"],
				"a",
			),
		).toBe("continuation");
		expect(
			classifyRebuild(
				{ digests: stored, accountId: "a" },
				["x", ...stored.slice(1)],
				"a",
			),
		).toBe("edit");
	});
});

describe("transcriptEligible", () => {
	it("accepts a well-formed tool conversation and refuses unknown tools or dangling calls", () => {
		const normalized = normalizeHistory(conversation);
		expect(transcriptEligible(normalized, new Set(["read"]))).toBe(true);
		expect(transcriptEligible(normalized, new Set(["write"]))).toBe(false);
		expect(transcriptEligible(normalized.slice(0, 2), new Set(["read"]))).toBe(
			false,
		);
		expect(transcriptEligible(normalized.slice(1), new Set(["read"]))).toBe(
			false,
		);
	});
});

describe("buildSyntheticTranscript (golden)", () => {
	it("writes Claude Code's transcript shape with prefixed tool names", () => {
		let n = 0;
		const entries = buildSyntheticTranscript(normalizeHistory(conversation), {
			sessionId: "11111111-1111-4111-8111-111111111111",
			cwd: "/work/cwd",
			model: "claude-sonnet-5",
			upstreamToolName: (name) => `mcp__c__${name}`,
			version: "2.1.280",
			randomId: () => `uuid-${++n}`,
			now: () => Date.UTC(2026, 8, 23),
			turnId: "turn-1",
		});
		const common = {
			isSidechain: false,
			userType: "external",
			cwd: "/work/cwd",
			sessionId: "11111111-1111-4111-8111-111111111111",
			version: "2.1.280",
			timestamp: "2026-09-23T00:00:00.000Z",
		};
		expect(entries).toEqual([
			{
				...common,
				type: "user",
				parentUuid: null,
				uuid: "uuid-1",
				message: {
					role: "user",
					content: [{ type: "text", text: "read a.txt and b.txt" }],
				},
			},
			{
				...common,
				type: "assistant",
				parentUuid: "uuid-1",
				uuid: "uuid-2",
				message: {
					id: "msg_sdk_bridge_turn-1_1",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-5",
					content: [
						{ type: "thinking", thinking: "plan", signature: "sig-1" },
						{ type: "text", text: "Reading both." },
						{
							type: "tool_use",
							id: "t1",
							name: "mcp__c__read",
							input: { path: "a.txt" },
						},
						{
							type: "tool_use",
							id: "t2",
							name: "mcp__c__read",
							input: { path: "b.txt" },
						},
					],
					stop_reason: "tool_use",
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			},
			{
				...common,
				type: "user",
				parentUuid: "uuid-2",
				uuid: "uuid-3",
				message: {
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "t1", content: "A" },
						{ type: "tool_result", tool_use_id: "t2", content: "B" },
					],
				},
			},
			{
				...common,
				type: "assistant",
				parentUuid: "uuid-3",
				uuid: "uuid-4",
				message: {
					id: "msg_sdk_bridge_turn-1_3",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-5",
					content: [{ type: "text", text: "A and B." }],
					stop_reason: "end_turn",
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			},
		]);
	});
});

describe("buildSyntheticTranscript after an existing transcript", () => {
	const ctx = (turnId: string, parentUuid: string) => {
		let n = 0;
		return {
			sessionId: "11111111-1111-4111-8111-111111111111",
			cwd: "/work/cwd",
			model: "claude-sonnet-5",
			upstreamToolName: (name: string) => `mcp__c__${name}`,
			version: "2.1.280",
			randomId: () => `${turnId}-uuid-${++n}`,
			now: () => Date.UTC(2026, 8, 29),
			turnId,
			parentUuid,
		};
	};
	const tail = normalizeHistory([
		{ role: "user", content: "q" },
		{ role: "assistant", content: "a" },
	]);

	it("chains its first entry to the given parent", () => {
		const entries = buildSyntheticTranscript(tail, ctx("turn-2", "leaf-1"));
		expect(entries.map((e) => [e.parentUuid, e.uuid])).toEqual([
			["leaf-1", "turn-2-uuid-1"],
			["turn-2-uuid-1", "turn-2-uuid-2"],
		]);
	});

	it("gives each turn's assistant messages ids of their own", () => {
		// Claude Code merges transcript entries that share a message id.
		const first = buildSyntheticTranscript(tail, ctx("turn-2", "leaf-1"));
		const second = buildSyntheticTranscript(
			tail,
			ctx("turn-3", String(first.at(-1)?.uuid)),
		);
		const ids = [...first, ...second].flatMap((e) =>
			e.type === "assistant" ? [(e.message as { id: string }).id] : [],
		);
		expect(ids).toEqual(["msg_sdk_bridge_turn-2_1", "msg_sdk_bridge_turn-3_1"]);
	});
});

describe("extensionTail", () => {
	const stored = messageDigests(conversation);
	const tools = new Set(["read"]);
	const gptRound: ClientMessage[] = [
		{ role: "user", content: "and c.txt?" },
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "call_c1|fc_c1",
					name: "read",
					input: { path: "c.txt" },
				},
			],
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "call_c1|fc_c1", content: "C" },
			],
		},
		{ role: "assistant", content: "C." },
	];

	it("gives the client's messages after the stored conversation", () => {
		expect(
			extensionTail([...conversation, ...gptRound], stored, tools),
		).toEqual(normalizeHistory(gptRound));
	});

	it("is null when nothing follows, or the history is not the stored one plus more", () => {
		expect(extensionTail(conversation, stored, tools)).toBeNull();
		const edited = structuredClone(conversation);
		edited[4] = { role: "assistant", content: "something else" };
		expect(extensionTail([...edited, ...gptRound], stored, tools)).toBeNull();
	});

	it("is null for a tail that starts with an assistant message", () => {
		const history: ClientMessage[] = [
			{ role: "user", content: "q" },
			{ role: "assistant", content: "a" },
		];
		// The stored conversation ended on the user's message.
		const digests = messageDigests(history.slice(0, 1));
		expect(extensionTail(history, digests, tools)).toBeNull();
	});

	it("is null for a tail that ends in open calls", () => {
		expect(
			extensionTail([...conversation, ...gptRound.slice(0, 2)], stored, tools),
		).toBeNull();
	});

	it("is null for a call to a tool this turn does not have", () => {
		expect(
			extensionTail([...conversation, ...gptRound], stored, new Set(["write"])),
		).toBeNull();
	});

	it("is null for a tail carrying signed thinking", () => {
		const thinking: ClientMessage[] = [
			gptRound[0] as ClientMessage,
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "t", signature: "sig-other" },
					{ type: "text", text: "C." },
				],
			},
		];
		const redacted: ClientMessage[] = [
			gptRound[0] as ClientMessage,
			{
				role: "assistant",
				content: [
					{ type: "redacted_thinking", data: "opaque" },
					{ type: "text", text: "C." },
				],
			},
		];
		expect(
			extensionTail([...conversation, ...thinking], stored, tools),
		).toBeNull();
		expect(
			extensionTail([...conversation, ...redacted], stored, tools),
		).toBeNull();
	});
});

describe("flattenHistory", () => {
	it("frames the history with a provenance note and never uses Human:/Assistant: labels", () => {
		const text = flattenHistory(normalizeHistory(conversation));
		expect(text.startsWith(FLATTENED_HISTORY_NOTE)).toBe(true);
		expect(text).toContain('<turn role="user">');
		expect(text).toContain("[tool call read id=t1]");
		expect(text).toContain("[tool result id=t2]\nB");
		expect(text).not.toMatch(/^(Human|Assistant):/m);
		expect(text).not.toContain("plan");
	});

	it("names a tool call the way the turn's tools are named inside Claude Code", () => {
		const text = flattenHistory(normalizeHistory(conversation), (name) =>
			name === "read" ? "t_0123456789abcdef" : name,
		);
		expect(text).toContain("[tool call t_0123456789abcdef id=t1]");
	});
});

/** An object nested `depth` levels deep, built without recursion. */
function nested(depth: number, leaf: unknown = "leaf"): unknown {
	let value: unknown = leaf;
	for (let i = 0; i < depth; i++) value = { a: value };
	return value;
}

function deepHistory(depth: number, leaf: unknown = "leaf"): ClientMessage[] {
	return [
		{ role: "user", content: "go" },
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "d1",
					name: "read",
					input: nested(depth, leaf),
				},
			],
		},
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "d1", content: "r" }],
		},
	];
}

describe("content nested deeper than any serializer's stack", () => {
	// 100 000 levels overflow JSON.stringify and plain recursion in Bun.
	const DEPTH = 100_000;

	it("digests without recursing through the whole depth, and deterministically", () => {
		const a = messageDigests(deepHistory(DEPTH));
		expect(a).toHaveLength(3);
		expect(messageDigests(deepHistory(DEPTH))).toEqual(a);
		// What lies below the cap still counts, by its size.
		expect(messageDigests(deepHistory(DEPTH + 1))[1]).not.toBe(a[1]);
		// Shallow content digests in full.
		expect(messageDigests(deepHistory(3))[1]).not.toBe(
			messageDigests(deepHistory(3, "other"))[1],
		);
	});

	it("flattens a call whose input cannot be serialized", () => {
		const text = flattenHistory(normalizeHistory(deepHistory(DEPTH)));
		expect(text).toContain("[tool call read id=d1] [input omitted");
	});
});

describe("answersFinalToolCalls", () => {
	const history = normalizeHistory(conversation.slice(0, 2));

	it("holds when the prompt answers every call of the final assistant message", () => {
		expect(answersFinalToolCalls(history, ["t1", "t2"])).toBe(true);
		expect(answersFinalToolCalls(history, ["t2", "t1"])).toBe(true);
	});

	it("does not hold for a partial, a foreign or an earlier round's answer", () => {
		expect(answersFinalToolCalls(history, ["t1"])).toBe(false);
		expect(answersFinalToolCalls(history, ["t1", "t2", "t9"])).toBe(false);
		expect(
			answersFinalToolCalls(normalizeHistory(conversation), ["t1", "t2"]),
		).toBe(false);
		expect(answersFinalToolCalls([], ["t1"])).toBe(false);
	});
});
