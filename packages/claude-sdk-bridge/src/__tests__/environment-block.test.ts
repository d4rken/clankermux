import { describe, expect, it } from "bun:test";
import { stripEnvironmentBlocks } from "../environment-block";

// Claude Code 2.1.280's renderings, as the real binary sent them to the mock
// upstream (`real-claude.integration.test.ts` keeps them honest).
const DIR = "/srv/cache/claude-agent-sdk/gen-abc/cwd";
const ENV = [
	"# Environment",
	"You have been invoked in the following environment: ",
	` - Primary working directory: ${DIR}`,
	" - Is a git repository: false",
	" - Platform: linux",
	" - Shell: unknown",
	" - OS Version: Linux 6.12.101+deb13-amd64",
].join("\n");
const UPDATE = `# Environment update\n - Primary working directory: /srv/gen-new/cwd (was ${DIR})`;
const MODEL =
	"You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5. Assistant knowledge cutoff is June 2026.";
const wrap = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;
const EPHEMERAL = { type: "ephemeral" };

function strip(messages: unknown[]) {
	const body = { model: "m", messages };
	const changed = stripEnvironmentBlocks(body);
	return { changed, messages: body.messages };
}

describe("stripEnvironmentBlocks", () => {
	it("removes the bare block from a system message and keeps the model reminder", () => {
		const { changed, messages } = strip([
			{ role: "user", content: "hi" },
			{ role: "system", content: `${ENV}\n\n${MODEL}` },
		]);
		expect(changed).toBe(true);
		expect(messages).toEqual([
			{ role: "user", content: "hi" },
			{ role: "system", content: MODEL },
		]);
	});

	it("removes the wrapped block and keeps the wrapped model reminder", () => {
		const { messages } = strip([
			{
				role: "system",
				content: [
					{
						type: "text",
						text: `${wrap(ENV)}\n\n${wrap(MODEL)}`,
						cache_control: EPHEMERAL,
					},
				],
			},
		]);
		expect(messages).toEqual([
			{
				role: "system",
				content: [
					{ type: "text", text: wrap(MODEL), cache_control: EPHEMERAL },
				],
			},
		]);
	});

	it("removes an update block, bare or wrapped", () => {
		for (const text of [UPDATE, wrap(UPDATE)]) {
			const { changed, messages } = strip([
				{ role: "user", content: "hi" },
				{ role: "system", content: text },
			]);
			expect(changed).toBe(true);
			expect(messages).toEqual([{ role: "user", content: "hi" }]);
		}
	});

	it("removes a wrapped block Claude Code folded into a user message", () => {
		const { messages } = strip([
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1", content: "R" },
					{ type: "text", text: `${wrap(ENV)}\n\n${wrap(MODEL)}` },
				],
			},
		]);
		expect(messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1", content: "R" },
					{ type: "text", text: wrap(MODEL) },
				],
			},
		]);
	});

	it("moves the breakpoint of an emptied message to the block before it", () => {
		const { messages } = strip([
			{ role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "R" }],
			},
			{
				role: "system",
				content: [{ type: "text", text: UPDATE, cache_control: EPHEMERAL }],
			},
		]);
		expect(messages).toEqual([
			{ role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "R",
						cache_control: EPHEMERAL,
					},
				],
			},
		]);
	});

	it("moves the breakpoint of an emptied block to the block before it in the same message", () => {
		const { messages } = strip([
			{
				role: "system",
				content: [
					{ type: "text", text: MODEL },
					{ type: "text", text: ENV, cache_control: EPHEMERAL },
				],
			},
		]);
		expect(messages).toEqual([
			{
				role: "system",
				content: [{ type: "text", text: MODEL, cache_control: EPHEMERAL }],
			},
		]);
	});

	it("turns a string message into a block to carry a moved breakpoint", () => {
		const { messages } = strip([
			{ role: "user", content: "hi" },
			{
				role: "system",
				content: [{ type: "text", text: ENV, cache_control: EPHEMERAL }],
			},
		]);
		expect(messages).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "hi", cache_control: EPHEMERAL }],
			},
		]);
	});

	it("never adds a breakpoint to a block that has one or cannot take one", () => {
		const other = { type: "ephemeral", ttl: "1h" };
		const kept = strip([
			{
				role: "user",
				content: [{ type: "text", text: "hi", cache_control: other }],
			},
			{
				role: "system",
				content: [{ type: "text", text: ENV, cache_control: EPHEMERAL }],
			},
		]);
		expect(kept.messages).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "hi", cache_control: other }],
			},
		]);
		const thinking = strip([
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "t", signature: "s" }],
			},
			{
				role: "system",
				content: [{ type: "text", text: ENV, cache_control: EPHEMERAL }],
			},
		]);
		expect(thinking.messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "t", signature: "s" }],
			},
		]);
	});

	it("leaves client text that mentions a working directory untouched", () => {
		const messages = [
			{ role: "user", content: `Primary working directory: ${DIR}` },
			// Bare in a user message: the client may have written it.
			{ role: "user", content: `${ENV}\n\nwhat is this?` },
			{ role: "assistant", content: [{ type: "text", text: wrap(ENV) }] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: [{ type: "text", text: wrap(ENV) }],
					},
				],
			},
			// Not Claude Code's shape: a line that is no list item follows.
			{ role: "system", content: `${ENV}\nand more` },
			{ role: "system", content: `x${wrap(ENV)}` },
		];
		const before = structuredClone(messages);
		const result = strip(messages);
		expect(result.changed).toBe(false);
		expect(result.messages).toEqual(before);
	});

	it("gives the same output for the same input", () => {
		const make = () => [
			{ role: "user", content: "hi" },
			{
				role: "system",
				content: [
					{
						type: "text",
						text: `${ENV}\n\n${MODEL}`,
						cache_control: EPHEMERAL,
					},
				],
			},
			{ role: "system", content: UPDATE },
		];
		expect(JSON.stringify(strip(make()).messages)).toBe(
			JSON.stringify(strip(make()).messages),
		);
	});

	it("ignores bodies without messages", () => {
		expect(stripEnvironmentBlocks({ model: "m" })).toBe(false);
		expect(stripEnvironmentBlocks(null)).toBe(false);
	});
});
