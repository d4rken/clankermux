import { describe, expect, it } from "bun:test";
import {
	INPUT_JSON_CHUNK,
	inputJsonChunks,
	ReplyComposer,
	type StreamEvent,
} from "../reply-composer";
import { sseFrame } from "../sse";
import { ToolNames, type WithheldReason } from "../tool-server";

function composer(opts: { webSearch?: boolean } = {}) {
	const sent: StreamEvent[] = [];
	const forwarded: string[] = [];
	const withheld: Array<[string, WithheldReason]> = [];
	const calls: string[] = [];
	const c = new ReplyComposer({
		toolNames: new ToolNames(["read"]),
		onToolUse: (id) => {
			forwarded.push(id);
			calls.push(`forward ${id}`);
		},
		onToolUseWithheld: (id, reason) => {
			withheld.push([id, reason]);
			calls.push(`withhold ${id}`);
		},
		onStreamFault: () => calls.push("fault"),
		newMessageId: () => "msg_leg",
		webSearch: opts.webSearch,
	});
	c.attach((event) => sent.push(event));
	return { c, sent, forwarded, withheld, calls };
}

const messageStart = (id = `msg_${crypto.randomUUID()}`): StreamEvent => ({
	type: "message_start",
	message: { id, model: "m", usage: { input_tokens: 1, output_tokens: 1 } },
});
const toolStart = (index: number, id: string, name = "mcp__c__read") => ({
	type: "content_block_start",
	index,
	content_block: { type: "tool_use", id, name, input: {} },
});
const json = (index: number, partial: string) => ({
	type: "content_block_delta",
	index,
	delta: { type: "input_json_delta", partial_json: partial },
});
const textStart = (index: number) => ({
	type: "content_block_start",
	index,
	content_block: { type: "text", text: "" },
});
const text = (index: number, t: string) => ({
	type: "content_block_delta",
	index,
	delta: { type: "text_delta", text: t },
});
const stop = (index: number) => ({ type: "content_block_stop", index });
const messageEnd = (stopReason: string): StreamEvent[] => [
	{
		type: "message_delta",
		delta: { stop_reason: stopReason, stop_sequence: null },
		usage: { output_tokens: 3 },
	},
	{ type: "message_stop" },
];
/** A whole client tool call block at `index`. */
const call = (index: number, id: string, input: string) => [
	toolStart(index, id),
	json(index, input),
	stop(index),
];
const CUT: WithheldReason = { kind: "cut_off" };

function feed(c: ReplyComposer, events: StreamEvent[]) {
	let end: ReturnType<ReplyComposer["onStreamEvent"]> = null;
	for (const event of events) end = c.onStreamEvent(event) ?? end;
	return end;
}

/** The blocks the client saw, `type:id` for tool_use and `type` otherwise. */
const shown = (sent: StreamEvent[]) =>
	sent
		.filter((e) => e.type === "content_block_start")
		.map((e) => {
			const block = e.content_block as { type: string; id?: string };
			return block.id ? `${block.type}:${block.id}` : block.type;
		});

describe("ReplyComposer: client tool calls in streamed messages", () => {
	it("holds a tool call until its message stops on tool_use, then sends it whole", () => {
		const { c, sent, forwarded } = composer();
		feed(c, [messageStart(), ...call(0, "toolu_a", '{"path":"a.txt"}')]);
		expect(shown(sent)).toEqual([]);
		expect(c.legToolUseIds).toEqual([]);
		feed(c, [messageEnd("tool_use")[0] as StreamEvent]);
		expect(shown(sent)).toEqual([]);
		const end = feed(c, [messageEnd("tool_use")[1] as StreamEvent]);
		expect(end).toEqual({ kind: "end", stopReason: "tool_use" });
		expect(sent.slice(1)).toEqual([
			{
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_a",
					name: "read",
					input: {},
				},
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
			},
			{ type: "content_block_stop", index: 0 },
		]);
		expect(c.legToolUseIds).toEqual(["toolu_a"]);
		expect(forwarded).toEqual(["toolu_a"]);
		expect(c.legContent()).toEqual([
			{
				type: "tool_use",
				id: "toolu_a",
				name: "read",
				input: { path: "a.txt" },
			},
		]);
	});

	it("streams text before the first call live and holds text after it, keeping upstream order", () => {
		const { c, sent } = composer();
		feed(c, [messageStart(), textStart(0), text(0, "Reading.")]);
		expect(shown(sent)).toEqual(["text"]);
		feed(c, [
			stop(0),
			...call(1, "toolu_a", "{}"),
			textStart(2),
			text(2, "And then."),
			stop(2),
			...call(3, "toolu_b", "{}"),
		]);
		expect(shown(sent)).toEqual(["text"]);
		feed(c, messageEnd("tool_use"));
		expect(shown(sent)).toEqual([
			"text",
			"tool_use:toolu_a",
			"text",
			"tool_use:toolu_b",
		]);
		expect(
			sent.filter((e) => e.type === "content_block_start").map((e) => e.index),
		).toEqual([0, 1, 2, 3]);
		expect(c.legContent().map((b) => b.id ?? b.text)).toEqual([
			"Reading.",
			"toolu_a",
			"And then.",
			"toolu_b",
		]);
	});

	it.each([
		["an empty input", [""]],
		["no input delta at all", []],
	])("takes %s as a call without arguments", (_label, partials) => {
		const { c, sent } = composer();
		feed(c, [
			messageStart(),
			toolStart(0, "toolu_a"),
			...partials.map((p) => json(0, p)),
			stop(0),
			...messageEnd("tool_use"),
		]);
		expect(shown(sent)).toEqual(["tool_use:toolu_a"]);
		expect(sent.find((e) => e.type === "content_block_delta")?.delta).toEqual({
			type: "input_json_delta",
			partial_json: "{}",
		});
		expect(c.legContent()).toEqual([
			{ type: "tool_use", id: "toolu_a", name: "read", input: {} },
		]);
	});

	it("withholds a call whose block ended truncated on a max_tokens stop", () => {
		const { c, sent, forwarded, withheld } = composer();
		const end = feed(c, [
			messageStart(),
			...call(0, "toolu_a", '{"path":"a.t'),
			...messageEnd("max_tokens"),
		]);
		expect(end).toEqual({ kind: "continue", stopReason: "max_tokens" });
		expect(shown(sent)).toEqual([]);
		expect(withheld).toEqual([["toolu_a", CUT]]);
		expect(forwarded).toEqual([]);
		expect(c.legToolUseIds).toEqual([]);
		expect(c.legContent()).toEqual([]);
		expect(c.lastMessageWithheldCalls).toBe(true);
	});

	it("withholds a call whose input is JSON but not an object", () => {
		const { c, sent, withheld } = composer();
		const end = feed(c, [
			messageStart(),
			...call(0, "toolu_a", '["a.txt"]'),
			...messageEnd("tool_use"),
		]);
		expect(end).toEqual({ kind: "continue", stopReason: "tool_use" });
		expect(shown(sent)).toEqual([]);
		expect(withheld).toEqual([["toolu_a", { kind: "not_object" }]]);
	});

	it("withholds complete calls when their message stops on max_tokens", () => {
		const { c, sent, withheld } = composer();
		const end = feed(c, [
			messageStart(),
			...call(0, "toolu_a", '{"path":"a"}'),
			...call(1, "toolu_b", '{"path":"b"}'),
			...messageEnd("max_tokens"),
		]);
		expect(end).toEqual({ kind: "continue", stopReason: "max_tokens" });
		expect(shown(sent)).toEqual([]);
		const reason: WithheldReason = {
			kind: "stop_reason",
			stopReason: "max_tokens",
		};
		expect(withheld).toEqual([
			["toolu_a", reason],
			["toolu_b", reason],
		]);
	});

	it("withholds a valid call with a truncated sibling, whatever the stop reason", () => {
		for (const stopReason of ["max_tokens", "tool_use"]) {
			const { c, sent, withheld } = composer();
			feed(c, [
				messageStart(),
				...call(0, "toolu_a", '{"path":"a"}'),
				...call(1, "toolu_b", '{"path":"b'),
				...messageEnd(stopReason),
			]);
			expect(shown(sent)).toEqual([]);
			expect(withheld).toEqual([
				[
					"toolu_a",
					stopReason === "tool_use"
						? { kind: "sibling" }
						: { kind: "stop_reason", stopReason },
				],
				["toolu_b", CUT],
			]);
		}
	});

	it("never shows a complete call of a message cut off later: only the refetched calls go out", () => {
		const { c, sent, withheld } = composer();
		feed(c, [
			messageStart(),
			...call(0, "toolu_a", '{"path":"a"}'),
			toolStart(1, "toolu_b"),
			json(1, '{"path":"b'),
		]);
		const end = feed(c, [
			messageStart(),
			...call(0, "toolu_a2", '{"path":"a"}'),
			...call(1, "toolu_b2", '{"path":"b"}'),
			...messageEnd("tool_use"),
		]);
		expect(end).toEqual({ kind: "end", stopReason: "tool_use" });
		expect(withheld).toEqual([
			["toolu_a", CUT],
			["toolu_b", CUT],
		]);
		expect(shown(sent)).toEqual(["tool_use:toolu_a2", "tool_use:toolu_b2"]);
		expect(JSON.stringify(sent)).not.toContain('"toolu_a"');
		expect(c.legToolUseIds).toEqual(["toolu_a2", "toolu_b2"]);
	});

	it("drops a call cut off mid-input and keeps the one the non-streamed refetch carries", () => {
		const { c, sent, withheld } = composer();
		feed(c, [
			messageStart(),
			textStart(0),
			text(0, "Writing."),
			stop(0),
			toolStart(1, "toolu_a"),
			json(1, '{"pa'),
		]);
		const end = c.onAssistantMessage({
			id: "msg_refetch",
			content: [
				{
					type: "tool_use",
					id: "toolu_b",
					name: "mcp__c__read",
					input: { path: "b.txt" },
				},
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 1, output_tokens: 4 },
		});
		expect(end).toEqual({ kind: "end", stopReason: "tool_use" });
		expect(withheld).toEqual([["toolu_a", CUT]]);
		expect(shown(sent)).toEqual(["text", "tool_use:toolu_b"]);
		expect(c.legToolUseIds).toEqual(["toolu_b"]);
		expect(c.legContent()).toEqual([
			{ type: "text", text: "Writing." },
			{
				type: "tool_use",
				id: "toolu_b",
				name: "read",
				input: { path: "b.txt" },
			},
		]);
	});

	it("withholds held calls at the reply's finish and still closes the text held after them", () => {
		const { c, sent, withheld } = composer();
		feed(c, [
			messageStart(),
			...call(0, "toolu_a", "{}"),
			textStart(1),
			text(1, "after"),
		]);
		c.finish("end_turn");
		expect(withheld).toEqual([["toolu_a", CUT]]);
		expect(shown(sent)).toEqual(["text"]);
		expect(
			sent.filter((e) => e.type === "content_block_start").map((e) => e.index),
		).toEqual(
			sent.filter((e) => e.type === "content_block_stop").map((e) => e.index),
		);
	});

	it("withholds a call whose block never stopped before message_stop", () => {
		const { c, sent, withheld } = composer();
		const end = feed(c, [
			messageStart(),
			toolStart(0, "toolu_a"),
			json(0, "{}"),
			...messageEnd("tool_use"),
		]);
		expect(end).toEqual({ kind: "continue", stopReason: "tool_use" });
		expect(withheld).toEqual([["toolu_a", CUT]]);
		expect(shown(sent)).toEqual([]);
	});

	describe("blocks that overlap a client tool call", () => {
		it("faults on a block starting inside a tool call, withholding the call first", () => {
			const { c, sent, calls } = composer();
			feed(c, [
				messageStart(),
				toolStart(0, "toolu_a"),
				json(0, '{"path":"a"}'),
				textStart(1),
				text(1, "interleaved"),
				stop(0),
				stop(1),
				...messageEnd("tool_use"),
			]);
			expect(calls).toEqual(["withhold toolu_a", "fault"]);
			expect(shown(sent)).toEqual([]);
			expect(sent.filter((e) => e.type === "content_block_delta")).toEqual([]);
		});

		it("faults on a tool call starting inside text that already streamed, which stays", () => {
			const { c, sent, calls } = composer();
			feed(c, [
				messageStart(),
				textStart(0),
				text(0, "streamed"),
				...call(1, "toolu_a", "{}"),
				stop(0),
				...messageEnd("tool_use"),
			]);
			expect(calls).toEqual(["withhold toolu_a", "fault"]);
			expect(shown(sent)).toEqual(["text"]);
			expect(sent.at(-1)).toEqual({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "streamed" },
			});
		});

		it("faults on a tool call starting inside held text, withholding the earlier call", () => {
			const { c, calls } = composer();
			feed(c, [
				messageStart(),
				...call(0, "toolu_a", "{}"),
				textStart(1),
				...call(2, "toolu_b", "{}"),
			]);
			expect(calls).toEqual(["withhold toolu_a", "withhold toolu_b", "fault"]);
		});
	});

	it("does not flush a search result into held calls, and flushes it once they are withheld", () => {
		const { c, sent } = composer({ webSearch: true });
		feed(c, [
			messageStart(),
			{
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_ws",
					name: "WebSearch",
					input: {},
				},
			},
			json(0, '{"query":"q"}'),
			stop(0),
			...call(1, "toolu_a", '{"path":'),
		]);
		c.onWebSearchResult("toolu_ws", {
			status: "completed",
			sources: [{ url: "https://a.test", title: "a" }],
			searchCount: 1,
		});
		expect(shown(sent)).toEqual(["server_tool_use:toolu_ws"]);
		feed(c, messageEnd("max_tokens"));
		expect(shown(sent)).toEqual([
			"server_tool_use:toolu_ws",
			"web_search_tool_result",
		]);
	});

	it("withholds a held call exactly once when a new leg attaches", () => {
		const { c, sent, withheld } = composer();
		feed(c, [messageStart(), ...call(0, "toolu_a", "{}"), textStart(1)]);
		const next: StreamEvent[] = [];
		c.attach((event) => next.push(event));
		c.finish("end_turn");
		expect(withheld).toEqual([["toolu_a", CUT]]);
		expect(shown(sent)).toEqual([]);
		expect(shown(next)).toEqual([]);
		expect(c.legToolUseIds).toEqual([]);
	});

	it("sends a large input in chunks, each frame under the Chat adapter's 1 MiB limit", () => {
		const MiB = 1024 * 1024;
		// Quotes and backslashes: every character doubles when escaped again.
		const content = '\\"'.repeat(400_000);
		const input = JSON.stringify({ path: "big", content });
		const single = sseFrame("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: input },
		});
		expect(single.byteLength).toBeGreaterThan(MiB);
		const { c, sent } = composer();
		feed(c, [
			messageStart(),
			...call(0, "toolu_big", input),
			...messageEnd("tool_use"),
		]);
		const deltas = sent.filter((e) => e.type === "content_block_delta");
		expect(deltas.length).toBeGreaterThan(1);
		for (const delta of deltas)
			expect(sseFrame("content_block_delta", delta).byteLength).toBeLessThan(
				MiB,
			);
		const joined = deltas
			.map((e) => (e.delta as { partial_json: string }).partial_json)
			.join("");
		expect(JSON.parse(joined)).toEqual({ path: "big", content });
	});

	it("never splits a surrogate pair across chunks", () => {
		const json = `{"e":"${"a".repeat(INPUT_JSON_CHUNK - 7)}😀"}`;
		expect(json.charCodeAt(INPUT_JSON_CHUNK - 1)).toBe(0xd83d);
		const chunks = inputJsonChunks(json);
		expect(chunks.join("")).toBe(json);
		expect(chunks[0]?.length).toBe(INPUT_JSON_CHUNK - 1);
		expect(chunks[1]?.startsWith("😀")).toBe(true);
	});
});

describe("ReplyComposer: client tool calls in non-streamed messages", () => {
	const envelope = (
		content: unknown[],
		stopReason: string | null,
	): Record<string, unknown> => ({
		id: `msg_${crypto.randomUUID()}`,
		content,
		stop_reason: stopReason,
		usage: { input_tokens: 1, output_tokens: 4 },
	});
	const read = (id: string, input: unknown) => ({
		type: "tool_use",
		id,
		name: "mcp__c__read",
		input,
	});

	it("publishes the calls of an envelope without a stop reason at once", () => {
		const { c, sent, forwarded } = composer();
		c.onAssistantMessage(envelope([read("toolu_f", { path: "f" })], null));
		expect(shown(sent)).toEqual(["tool_use:toolu_f"]);
		expect(forwarded).toEqual(["toolu_f"]);
		expect(c.legToolUseIds).toEqual(["toolu_f"]);
	});

	it("withholds every call of an envelope that stops on anything but tool_use", () => {
		const { c, sent, withheld } = composer();
		const end = c.onAssistantMessage(
			envelope(
				[{ type: "text", text: "No." }, read("toolu_f", { path: "f" })],
				"refusal",
			),
		);
		expect(end).toEqual({ kind: "end", stopReason: "refusal" });
		expect(shown(sent)).toEqual(["text"]);
		expect(withheld).toEqual([
			["toolu_f", { kind: "stop_reason", stopReason: "refusal" }],
		]);
		expect(c.lastMessageWithheldCalls).toBe(true);
	});

	it("withholds every call of an envelope with an input that is not an object", () => {
		const { c, sent, withheld } = composer();
		const end = c.onAssistantMessage(
			envelope(
				[read("toolu_a", { path: "a" }), read("toolu_b", "b")],
				"tool_use",
			),
		);
		expect(end).toEqual({ kind: "continue", stopReason: "tool_use" });
		expect(shown(sent)).toEqual([]);
		expect(withheld).toEqual([
			["toolu_a", { kind: "sibling" }],
			["toolu_b", { kind: "not_object" }],
		]);
	});
});
