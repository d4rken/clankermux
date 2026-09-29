import { describe, expect, it } from "bun:test";
import { ReplyComposer, type StreamEvent } from "../reply-composer";
import { ToolNames } from "../tool-server";

function composer(opts: { webSearch?: boolean } = {}) {
	const sent: StreamEvent[] = [];
	const forwarded: string[] = [];
	const withheld: string[] = [];
	const faults: string[] = [];
	const c = new ReplyComposer({
		toolNames: new ToolNames(["read"]),
		onToolUse: (id) => forwarded.push(id),
		onToolUseWithheld: (id) => withheld.push(id),
		onStreamFault: (why) => faults.push(why),
		newMessageId: () => "msg_leg",
		webSearch: opts.webSearch,
	});
	c.attach((event) => sent.push(event));
	return { c, sent, forwarded, withheld, faults };
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
	it("sends nothing of a tool call until its block completes, then all of it at once", () => {
		const { c, sent, forwarded } = composer();
		feed(c, [messageStart(), toolStart(0, "toolu_a"), json(0, '{"pa')]);
		expect(shown(sent)).toEqual([]);
		expect(c.legToolUseIds).toEqual([]);
		expect(forwarded).toEqual([]);
		feed(c, [json(0, 'th":"a.txt"}')]);
		expect(shown(sent)).toEqual([]);
		feed(c, [stop(0)]);
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
		expect(feed(c, messageEnd("tool_use"))).toEqual({
			kind: "end",
			stopReason: "tool_use",
		});
		expect(c.legContent()).toEqual([
			{
				type: "tool_use",
				id: "toolu_a",
				name: "read",
				input: { path: "a.txt" },
			},
		]);
	});

	it("keeps text streaming live and numbers blocks in the order they reach the client", () => {
		const { c, sent } = composer();
		feed(c, [messageStart(), textStart(0), text(0, "Reading.")]);
		expect(shown(sent)).toEqual(["text"]);
		feed(c, [stop(0), toolStart(1, "toolu_a"), json(1, "{}"), stop(1)]);
		expect(
			sent.filter((e) => e.type === "content_block_start").map((e) => e.index),
		).toEqual([0, 1]);
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

	it.each([
		["truncated JSON", '{"path":"a.t'],
		["JSON that is not an object", '["a.txt"]'],
	])("withholds a completed block with %s (a max_tokens stop mid-input)", (_label, partial) => {
		const { c, sent, forwarded, withheld } = composer();
		const end = feed(c, [
			messageStart(),
			toolStart(0, "toolu_a"),
			json(0, partial),
			stop(0),
			...messageEnd("max_tokens"),
		]);
		expect(end).toEqual({ kind: "continue", stopReason: "max_tokens" });
		expect(shown(sent)).toEqual([]);
		expect(withheld).toEqual(["toolu_a"]);
		expect(forwarded).toEqual([]);
		expect(c.legToolUseIds).toEqual([]);
		expect(c.legContent()).toEqual([]);
	});

	it("drops a call cut off mid-input and keeps the one a new streamed message makes", () => {
		const { c, sent, withheld } = composer();
		feed(c, [
			messageStart(),
			textStart(0),
			text(0, "Writing."),
			stop(0),
			toolStart(1, "toolu_a"),
			json(1, '{"path":"a.txt","content":"half'),
		]);
		const end = feed(c, [
			messageStart(),
			toolStart(0, "toolu_b"),
			json(0, '{"path":"b.txt"}'),
			stop(0),
			...messageEnd("tool_use"),
		]);
		expect(end).toEqual({ kind: "end", stopReason: "tool_use" });
		expect(withheld).toEqual(["toolu_a"]);
		expect(shown(sent)).toEqual(["text", "tool_use:toolu_b"]);
		expect(JSON.stringify(sent)).not.toContain("toolu_a");
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

	it("drops a call cut off mid-input and keeps the one the non-streamed refetch carries", () => {
		const { c, sent, withheld } = composer();
		feed(c, [messageStart(), toolStart(0, "toolu_a"), json(0, '{"pa')]);
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
		expect(withheld).toEqual(["toolu_a"]);
		expect(shown(sent)).toEqual(["tool_use:toolu_b"]);
		expect(c.legToolUseIds).toEqual(["toolu_b"]);
		expect(c.legContent()).toEqual([
			{
				type: "tool_use",
				id: "toolu_b",
				name: "read",
				input: { path: "b.txt" },
			},
		]);
	});

	it("withholds a call still buffered when the reply finishes, leaving every block balanced", () => {
		const { c, sent, withheld } = composer();
		feed(c, [
			messageStart(),
			textStart(0),
			text(0, "hi"),
			toolStart(1, "toolu_a"),
		]);
		expect(withheld).toEqual([]);
		// Text still open at the cut is closed; the tool call never went out.
		c.finish("end_turn");
		expect(withheld).toEqual(["toolu_a"]);
		expect(shown(sent)).toEqual(["text"]);
		expect(
			sent.filter((e) => e.type === "content_block_stop").map((e) => e.index),
		).toEqual([0]);
	});

	it("withholds a buffered call at message_stop when its block never stopped", () => {
		const { c, sent, withheld } = composer();
		const end = feed(c, [
			messageStart(),
			toolStart(0, "toolu_a"),
			json(0, "{}"),
			...messageEnd("tool_use"),
		]);
		expect(end).toEqual({ kind: "continue", stopReason: "tool_use" });
		expect(withheld).toEqual(["toolu_a"]);
		expect(shown(sent)).toEqual([]);
	});

	it("fails closed when a block starts while a tool call is still buffered", () => {
		const { c, sent, faults, forwarded } = composer();
		feed(c, [
			messageStart(),
			toolStart(0, "toolu_a"),
			json(0, '{"path":"a"}'),
			textStart(1),
			text(1, "interleaved"),
			stop(0),
			stop(1),
		]);
		expect(faults).toHaveLength(1);
		expect(forwarded).toEqual([]);
		expect(shown(sent)).toEqual([]);
		expect(sent.filter((e) => e.type === "content_block_delta")).toEqual([]);
	});

	it("does not flush a search result into the middle of a buffered tool call", () => {
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
			toolStart(1, "toolu_a"),
			json(1, '{"path":'),
		]);
		c.onWebSearchResult("toolu_ws", {
			status: "completed",
			sources: [{ url: "https://a.test", title: "a" }],
			searchCount: 1,
		});
		expect(shown(sent)).toEqual(["server_tool_use:toolu_ws"]);
		feed(c, [json(1, '"a"}'), stop(1)]);
		expect(shown(sent)).toEqual([
			"server_tool_use:toolu_ws",
			"tool_use:toolu_a",
			"web_search_tool_result",
		]);
	});

	it("starts a new leg with nothing buffered", () => {
		const { c, sent, withheld } = composer();
		feed(c, [messageStart(), toolStart(0, "toolu_a"), json(0, "{")]);
		const next: StreamEvent[] = [];
		c.attach((event) => next.push(event));
		expect(withheld).toEqual(["toolu_a"]);
		feed(c, [json(0, "}"), stop(0)]);
		expect(shown(sent)).toEqual([]);
		expect(shown(next)).toEqual([]);
		expect(c.legToolUseIds).toEqual([]);
	});

	it("still publishes a non-streamed message's tool call at once", () => {
		const { c, sent, forwarded } = composer();
		c.onAssistantMessage({
			id: "msg_whole",
			content: [
				{
					type: "tool_use",
					id: "toolu_f",
					name: "mcp__c__read",
					input: { path: "f" },
				},
			],
			stop_reason: null,
		});
		expect(shown(sent)).toEqual(["tool_use:toolu_f"]);
		expect(forwarded).toEqual(["toolu_f"]);
		expect(c.legToolUseIds).toEqual(["toolu_f"]);
	});
});
