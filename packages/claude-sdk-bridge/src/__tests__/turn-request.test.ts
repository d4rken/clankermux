import { describe, expect, it } from "bun:test";
import { parseTurnBody, parseTurnRequest } from "../turn-request";

const base = {
	model: "claude-sonnet-5",
	messages: [{ role: "user", content: "hi" }],
};

describe("parseTurnRequest", () => {
	it("splits history from the final user message and reads the client system text", () => {
		const parsed = parseTurnRequest(
			{
				...base,
				stream: true,
				system: [{ type: "text", text: "be terse" }],
				messages: [
					{ role: "user", content: "a" },
					{ role: "assistant", content: [{ type: "text", text: "b" }] },
					{ role: "user", content: "c" },
					{ role: "system", content: "effort changed" },
				],
			},
			null,
			100,
		);
		if (!parsed.ok) throw new Error(parsed.error.message);
		expect(parsed.turn.history).toHaveLength(2);
		expect(parsed.turn.last.content).toBe("c");
		expect(parsed.turn.systemText).toBe("be terse");
		expect(parsed.turn.stream).toBe(true);
		expect(parsed.turn.toolResults).toEqual([]);
	});

	it("marks tool_result blocks in the last user message as a continuation", () => {
		const parsed = parseTurnRequest(
			{
				...base,
				messages: [
					{ role: "user", content: "a" },
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
					},
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }],
					},
				],
			},
			null,
			1,
		);
		expect(
			parsed.ok && parsed.turn.toolResults.map((b) => b.tool_use_id),
		).toEqual(["t1"]);
	});

	it("reads consecutive trailing user messages as the one final message", () => {
		// How Chat Completions sends text typed alongside tool results: the
		// results, then a user message of its own.
		const parsed = parseTurnRequest(
			{
				...base,
				messages: [
					{ role: "user", content: "a" },
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
					},
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }],
					},
					{ role: "system", content: "effort changed" },
					{ role: "user", content: "and also this" },
				],
			},
			null,
			1,
		);
		if (!parsed.ok) throw new Error(parsed.error.message);
		expect(parsed.turn.toolResults.map((b) => b.tool_use_id)).toEqual(["t1"]);
		expect(parsed.turn.last.content).toEqual([
			{ type: "tool_result", tool_use_id: "t1", content: "x" },
			{ type: "text", text: "and also this" },
		]);
		expect(parsed.turn.history.map((m) => m.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(parsed.turn.messages).toHaveLength(5);
	});

	it("rejects a final assistant message", () => {
		const parsed = parseTurnRequest(
			{
				...base,
				messages: [
					{ role: "user", content: "a" },
					{ role: "assistant", content: "b" },
				],
			},
			null,
			1,
		);
		expect(!parsed.ok && parsed.error.status).toBe(400);
	});

	it.each([
		["web_search_20250305"],
		["bash_20250124"],
		["text_editor_20250728"],
		["computer_20250124"],
	])("rejects server tool type %s with 400", (type) => {
		const parsed = parseTurnRequest(
			{ ...base, tools: [{ type, name: "x" }] },
			null,
			1,
		);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.error.status).toBe(400);
			expect(parsed.error.message).toContain(type);
		}
	});

	it("accepts custom tools with or without an explicit type", () => {
		const parsed = parseTurnRequest(
			{
				...base,
				tools: [
					{ name: "read", input_schema: { type: "object" } },
					{ type: "custom", name: "write", input_schema: { type: "object" } },
				],
			},
			null,
			1,
		);
		expect(parsed.ok && parsed.turn.tools.map((t) => t.name)).toEqual([
			"read",
			"write",
		]);
		expect(parsed.ok && parsed.turn.schemaBytes).toBeGreaterThan(0);
	});

	it("rejects duplicate tool names and tools without a schema", () => {
		const dup = parseTurnRequest(
			{
				...base,
				tools: [
					{ name: "a", input_schema: { type: "object" } },
					{ name: "a", input_schema: { type: "object" } },
				],
			},
			null,
			1,
		);
		expect(!dup.ok && dup.error.status).toBe(400);
		const noSchema = parseTurnRequest(
			{ ...base, tools: [{ name: "a" }] },
			null,
			1,
		);
		expect(!noSchema.ok && noSchema.error.status).toBe(400);
	});
});

describe("field policy", () => {
	const parse = (
		patch: Record<string, unknown>,
		gaps: Parameters<typeof parseTurnRequest>[3] = null,
	) => parseTurnRequest({ ...base, ...patch }, null, 1, gaps);
	const turnOf = (parsed: ReturnType<typeof parseTurnRequest>) => {
		if (!parsed.ok) throw new Error(parsed.error.message);
		return parsed.turn;
	};

	it("honours the client's max_tokens", () => {
		expect(turnOf(parse({ max_tokens: 300 })).maxOutputTokens).toBe(300);
		expect(turnOf(parse({})).maxOutputTokens).toBeNull();
	});

	it("leaves Claude Code's own limit when max_tokens is the adapter's default", () => {
		const turn = turnOf(
			parse(
				{ max_tokens: 4096 },
				{ maxTokensDefaulted: true, droppedFields: [] },
			),
		);
		expect(turn.maxOutputTokens).toBeNull();
	});

	it("refuses a max_tokens that is not a positive integer", () => {
		for (const max_tokens of [0, 1.5, "10"]) {
			const parsed = parse({ max_tokens });
			expect(!parsed.ok && parsed.error.message).toContain("max_tokens");
		}
	});

	it("accepts temperature and top_p and records them as ignored", () => {
		expect(
			turnOf(parse({ temperature: 0.2, top_p: 0.9 })).ignoredFields,
		).toEqual(["temperature", "top_p"]);
		expect(turnOf(parse({})).ignoredFields).toEqual([]);
		// What the Responses translation dropped still counts.
		expect(
			turnOf(parse({}, { maxTokensDefaulted: false, droppedFields: ["top_p"] }))
				.ignoredFields,
		).toEqual(["top_p"]);
	});

	it("refuses stop sequences with a 400 naming the field", () => {
		const parsed = parse({ stop_sequences: ["END"] });
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error.status).toBe(400);
		expect(parsed.error.message).toContain("stop_sequences");
		expect(turnOf(parse({ stop_sequences: [] })).ignoredFields).toEqual([]);
	});

	it("refuses a tool_choice that forces or forbids tool use, and takes auto", () => {
		for (const tool_choice of [
			{ type: "any" },
			{ type: "tool", name: "read" },
			{ type: "none" },
		]) {
			const parsed = parse({ tool_choice });
			expect(!parsed.ok && parsed.error.status).toBe(400);
			expect(!parsed.ok && parsed.error.message).toContain(
				`tool_choice "${tool_choice.type}"`,
			);
		}
		expect(parse({ tool_choice: { type: "auto" } }).ok).toBe(true);
	});
});

describe("a side request's body", () => {
	const side = (patch: Record<string, unknown>) =>
		parseTurnBody({ ...base, ...patch }, null, 1, null, "side_request");

	it("takes tool_choice none, and still refuses one that forces a tool", () => {
		expect(side({ tool_choice: { type: "none" } }).ok).toBe(true);
		for (const tool_choice of [{ type: "any" }, { type: "tool", name: "read" }])
			expect(side({ tool_choice }).ok).toBe(false);
		expect(side({ stop_sequences: ["END"] }).ok).toBe(false);
		// An ordinary turn keeps the refusal.
		expect(
			parseTurnBody({ ...base, tool_choice: { type: "none" } }, null, 1).ok,
		).toBe(false);
	});

	it("keeps the tools the replayed body declares", () => {
		const parsed = side({
			tools: [
				{
					name: "read",
					input_schema: { type: "object", properties: {} },
				},
			],
			tool_choice: { type: "none" },
		});
		if (!parsed.ok) throw new Error(parsed.error.message);
		expect(parsed.body.tools.map((t) => t.name)).toEqual(["read"]);
	});

	it("keeps the output cap and the effort", () => {
		const parsed = parseTurnBody(
			{ ...base, max_tokens: 128, tool_choice: { type: "none" } },
			"high",
			1,
			null,
			"side_request",
		);
		if (!parsed.ok) throw new Error(parsed.error.message);
		expect(parsed.body.maxOutputTokens).toBe(128);
		expect(parsed.body.effort).toBe("high");
	});

	it("does not require a final user message", () => {
		expect(
			side({
				messages: [
					{ role: "user", content: "a" },
					{ role: "assistant", content: "b" },
				],
			}).ok,
		).toBe(true);
	});
});
