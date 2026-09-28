import { describe, expect, it } from "bun:test";
import { stripEnvironmentBlocks } from "../environment-block";

// Claude Code 2.1.280's renderings, as the real binary sent them to the mock
// upstream ("never shows the model Claude Code's own directories, only the
// client's" in real-claude.integration.test.ts keeps them honest).
const ROOT = "/srv/cache/claude-agent-sdk";
const DIR = `${ROOT}/gen-abc/cwd`;
const NEW_DIR = `${ROOT}/gen-def/cwd`;
const envOf = (dir: string) =>
	[
		"# Environment",
		"You have been invoked in the following environment: ",
		` - Primary working directory: ${dir}`,
		" - Is a git repository: false",
		" - Platform: linux",
		" - Shell: unknown",
		" - OS Version: Linux 6.12.101+deb13-amd64",
	].join("\n");
const ENV = envOf(DIR);
const updateOf = (now: string, was: string) =>
	`# Environment update\n - Primary working directory: ${now} (was ${was})`;
const UPDATE = updateOf(NEW_DIR, DIR);
const MODEL =
	"You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5. Assistant knowledge cutoff is June 2026.";
const wrap = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;
const EPHEMERAL = { type: "ephemeral" };
const TOOL_USE = {
	role: "assistant",
	content: [{ type: "tool_use", id: "t1" }],
};
const TOOL_RESULT = {
	role: "user",
	content: [{ type: "tool_result", tool_use_id: "t1", content: "R" }],
};

function strip(messages: unknown[], roots: string[] = [ROOT]) {
	const body = { model: "m", messages };
	const result = stripEnvironmentBlocks(body, { roots });
	return { ...result, messages: body.messages };
}

/** `messages` must come back exactly as given. */
function expectUntouched(messages: unknown[]) {
	const before = structuredClone(messages);
	const result = strip(messages);
	expect(result.changed).toBe(false);
	expect(result.messages).toEqual(before);
	return result;
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
			TOOL_RESULT,
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
			TOOL_RESULT,
			{
				role: "system",
				content: [
					{ type: "text", text: wrap(MODEL), cache_control: EPHEMERAL },
				],
			},
		]);
	});

	it("removes an update block, bare or wrapped, when both paths are the bridge's", () => {
		for (const text of [UPDATE, wrap(UPDATE)]) {
			const { changed, messages } = strip([
				{ role: "user", content: "hi" },
				{ role: "system", content: text },
			]);
			expect(changed).toBe(true);
			expect(messages).toEqual([{ role: "user", content: "hi" }]);
		}
	});

	describe("user messages", () => {
		// Claude Code puts the block only in system messages; the real-binary
		// test "never shows the model Claude Code's own directories, only the
		// client's" covers where it lands. Text in a user message is the
		// client's, even when it names this bridge's sandboxes.
		it("are never changed, even naming this bridge's own sandboxes", () => {
			const pasted = `Explain this:\n\n${wrap(updateOf(`${ROOT}/gen-new/cwd`, `${ROOT}/gen-old/cwd`))}`;
			const result = expectUntouched([
				{ role: "user", content: pasted },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "t1", content: "R" },
						{ type: "text", text: `${wrap(ENV)}\n\n${wrap(MODEL)}` },
					],
				},
				{ role: "user", content: wrap(ENV) },
			]);
			expect(result.inUserMessages).toBe(true);
		});

		it("are reported only for a block under a root", () => {
			const result = expectUntouched([
				{ role: "user", content: wrap(envOf("/home/alice/project")) },
			]);
			expect(result.inUserMessages).toBe(false);
		});
	});

	describe("ownership", () => {
		const alice = envOf("/home/alice/project");

		it("leaves a wrapped excerpt naming another directory in a client message", () => {
			expectUntouched([
				{ role: "user", content: `look at this:\n\n${wrap(alice)}` },
			]);
			expectUntouched([{ role: "user", content: wrap(alice) }]);
			expectUntouched([{ role: "system", content: `${alice}\n\n${MODEL}` }]);
		});

		it("leaves an update unless both of its paths are the bridge's", () => {
			expectUntouched([
				{ role: "user", content: "hi" },
				{ role: "system", content: updateOf("/home/alice/project", DIR) },
				{ role: "system", content: updateOf(DIR, "/home/alice/project") },
			]);
		});

		it("leaves a flattened history holding an excerpt", () => {
			expectUntouched([
				{
					role: "user",
					content: `[user]\nwhat is this?\n\n${wrap(alice)}\n\n[assistant]\nan environment block`,
				},
			]);
		});

		it("takes only the bridge's own sandboxes, under any of its roots", () => {
			expectUntouched([
				{ role: "user", content: "hi" },
				{ role: "system", content: envOf(`${ROOT}/cwd`) },
				{ role: "system", content: envOf(`${ROOT}/gen-abc/cwd/sub`) },
				{ role: "system", content: envOf(`${ROOT}-other/gen-abc/cwd`) },
			]);
			const real = strip(
				[
					{ role: "user", content: "hi" },
					{ role: "system", content: envOf("/real/root/gen-x/cwd") },
				],
				[ROOT, "/real/root"],
			);
			expect(real.messages).toEqual([{ role: "user", content: "hi" }]);
		});
	});

	describe("never makes an invalid request", () => {
		it("keeps a system message whose removal would end the request on an assistant turn or empty it", () => {
			expectUntouched([{ role: "system", content: ENV }]);
			expectUntouched([TOOL_USE, { role: "system", content: ENV }]);
		});
	});

	describe("the breakpoint of what goes", () => {
		const updateWithBreakpoint = {
			role: "system",
			content: [{ type: "text", text: UPDATE, cache_control: EPHEMERAL }],
		};

		it("moves to the block before it, in the previous message", () => {
			const { messages } = strip([TOOL_USE, TOOL_RESULT, updateWithBreakpoint]);
			expect(messages).toEqual([
				TOOL_USE,
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

		it("moves to the block before it in the same message", () => {
			const { messages } = strip([
				{ role: "user", content: "hi" },
				{
					role: "system",
					content: [
						{ type: "text", text: MODEL },
						{ type: "text", text: ENV, cache_control: EPHEMERAL },
					],
				},
			]);
			expect(messages).toEqual([
				{ role: "user", content: "hi" },
				{
					role: "system",
					content: [{ type: "text", text: MODEL, cache_control: EPHEMERAL }],
				},
			]);
		});

		it("never turns a string message into blocks: it walks past it", () => {
			const { messages } = strip([
				TOOL_RESULT,
				{ role: "user", content: "and then" },
				updateWithBreakpoint,
			]);
			expect(messages).toEqual([
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
				{ role: "user", content: "and then" },
			]);
		});

		it("walks past thinking and empty text", () => {
			const { messages } = strip([
				{ role: "user", content: [{ type: "text", text: "go" }] },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "t", signature: "s" },
						{ type: "text", text: "" },
					],
				},
				{ role: "user", content: "next" },
				updateWithBreakpoint,
			]);
			expect(messages).toEqual([
				{
					role: "user",
					content: [{ type: "text", text: "go", cache_control: EPHEMERAL }],
				},
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "t", signature: "s" },
						{ type: "text", text: "" },
					],
				},
				{ role: "user", content: "next" },
			]);
		});

		it("is dropped at a block that already has one, or when nothing can take it", () => {
			const other = { type: "ephemeral", ttl: "1h" };
			const held = strip([
				{ role: "user", content: [{ type: "text", text: "a" }] },
				{
					role: "user",
					content: [{ type: "text", text: "b", cache_control: other }],
				},
				updateWithBreakpoint,
			]);
			expect(held.messages).toEqual([
				{ role: "user", content: [{ type: "text", text: "a" }] },
				{
					role: "user",
					content: [{ type: "text", text: "b", cache_control: other }],
				},
			]);
			const none = strip([
				{ role: "user", content: "hi" },
				updateWithBreakpoint,
			]);
			expect(none.messages).toEqual([{ role: "user", content: "hi" }]);
		});
	});

	describe("near-miss renderings", () => {
		it("takes trailing whitespace and CRLF line ends", () => {
			for (const text of [
				`${ENV}\n`,
				`${ENV} \n\t`,
				`${wrap(ENV)}\n`,
				wrap(`${ENV}\n`),
				wrap(ENV).replaceAll("\n", "\r\n"),
			]) {
				const { messages } = strip([
					{ role: "user", content: "hi" },
					{ role: "system", content: `${text}\r\n\r\n${MODEL}` },
				]);
				expect(messages).toEqual([
					{ role: "user", content: "hi" },
					{ role: "system", content: MODEL },
				]);
			}
		});

		it("takes the block out of a wrap it shares with other paragraphs", () => {
			const { messages } = strip([
				{ role: "user", content: "hi" },
				{ role: "system", content: wrap(`${ENV}\n\n${MODEL}`) },
				{ role: "system", content: wrap(`${MODEL}\n\n${UPDATE}`) },
				{ role: "system", content: wrap(`${ENV}\n\n${UPDATE}`) },
				{ role: "system", content: `${wrap(`${ENV}\n\n${MODEL}`)}\n\nhello` },
			]);
			expect(messages).toEqual([
				{ role: "user", content: "hi" },
				{ role: "system", content: wrap(MODEL) },
				{ role: "system", content: wrap(MODEL) },
				{ role: "system", content: `${wrap(MODEL)}\n\nhello` },
			]);
		});

		it("reports a block under its root that it could not take", () => {
			const drifted = ENV.replace("You have been invoked", "You run");
			const result = strip([
				{ role: "user", content: "hi" },
				{ role: "system", content: drifted },
			]);
			expect(result.changed).toBe(false);
			expect(result.drift).toBe(true);
			expect(
				strip([{ role: "user", content: envOf("/home/alice/p") }]).drift,
			).toBe(false);
		});
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
			TOOL_USE,
			TOOL_RESULT,
			{ role: "system", content: UPDATE },
		];
		expect(JSON.stringify(strip(make()).messages)).toBe(
			JSON.stringify(strip(make()).messages),
		);
	});

	it("ignores bodies without messages", () => {
		expect(
			stripEnvironmentBlocks({ model: "m" }, { roots: [ROOT] }).changed,
		).toBe(false);
		expect(stripEnvironmentBlocks(null, { roots: [ROOT] }).changed).toBe(false);
	});
});
