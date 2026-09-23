import { describe, expect, it } from "bun:test";
import {
	buildSyntheticTranscript,
	classifyRebuild,
	FLATTENED_HISTORY_NOTE,
	firstUserDigest,
	flattenHistory,
	messageDigests,
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
					id: "msg_sdk_bridge_rebuild_1",
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
					id: "msg_sdk_bridge_rebuild_3",
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
