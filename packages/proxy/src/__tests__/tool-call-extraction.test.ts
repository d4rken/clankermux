/**
 * Tests for the final-message tool-call stats extraction: tool_result blocks
 * in the LAST message of the parsed /v1/messages body are counted per tool
 * (name resolved via tool_use_id → tool_use.name from the full history);
 * blocks with `is_error: true` (strict boolean) count as errors and capture a
 * truncated error-text sample. Earlier messages' tool_results are ignored —
 * only the final message represents the new turn (dedup across the
 * conversation's repeated history). Never throws; toolStats is null when the
 * final message has no tool_result blocks.
 */
import { describe, expect, it } from "bun:test";
import { computeContextAndToolStats } from "../context-composition";

/** Assistant turn declaring a tool_use so later tool_results can resolve names. */
function toolUse(id: string, name: string): Record<string, unknown> {
	return { type: "tool_use", id, name, input: {} };
}

function toolResult(
	toolUseId: string,
	content: unknown,
	isError?: unknown,
): Record<string, unknown> {
	const block: Record<string, unknown> = {
		type: "tool_result",
		tool_use_id: toolUseId,
		content,
	};
	if (isError !== undefined) block.is_error = isError;
	return block;
}

describe("computeContextAndToolStats — toolStats", () => {
	it("returns null toolStats (and null composition) for a null body", () => {
		const result = computeContextAndToolStats(null);
		expect(result.composition).toBeNull();
		expect(result.toolStats).toBeNull();
	});

	it("returns null toolStats for bodies without a messages array", () => {
		expect(computeContextAndToolStats({}).toolStats).toBeNull();
		expect(
			computeContextAndToolStats({ messages: "nope" }).toolStats,
		).toBeNull();
	});

	it("returns null toolStats for an empty messages array", () => {
		const result = computeContextAndToolStats({ messages: [] });
		expect(result.composition).not.toBeNull();
		expect(result.toolStats).toBeNull();
	});

	it("returns null toolStats when the final message has no tool_result blocks", () => {
		const result = computeContextAndToolStats({
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			],
		});
		expect(result.toolStats).toBeNull();
	});

	it("counts a tool_result without is_error as a non-error call", () => {
		const result = computeContextAndToolStats({
			messages: [
				{ role: "assistant", content: [toolUse("tu_1", "read_file")] },
				{ role: "user", content: [toolResult("tu_1", "file contents")] },
			],
		});
		expect(result.toolStats).toEqual([
			{
				toolName: "read_file",
				callCount: 1,
				errorCount: 0,
				errorSamples: [],
			},
		]);
	});

	it("counts is_error: false as a non-error call", () => {
		const result = computeContextAndToolStats({
			messages: [
				{ role: "assistant", content: [toolUse("tu_1", "bash")] },
				{ role: "user", content: [toolResult("tu_1", "ok", false)] },
			],
		});
		expect(result.toolStats?.[0]).toEqual({
			toolName: "bash",
			callCount: 1,
			errorCount: 0,
			errorSamples: [],
		});
	});

	it("captures a string-content error sample for is_error: true", () => {
		const result = computeContextAndToolStats({
			messages: [
				{ role: "assistant", content: [toolUse("tu_1", "bash")] },
				{
					role: "user",
					content: [toolResult("tu_1", "command not found: foo", true)],
				},
			],
		});
		expect(result.toolStats?.[0]).toEqual({
			toolName: "bash",
			callCount: 1,
			errorCount: 1,
			errorSamples: ["command not found: foo"],
		});
	});

	it("joins text blocks of array content into the error sample", () => {
		const result = computeContextAndToolStats({
			messages: [
				{ role: "assistant", content: [toolUse("tu_1", "bash")] },
				{
					role: "user",
					content: [
						toolResult(
							"tu_1",
							[
								{ type: "text", text: "line one" },
								{ type: "image", source: { data: "xxxx" } }, // non-text → skipped
								{ type: "text", text: "line two" },
							],
							true,
						),
					],
				},
			],
		});
		expect(result.toolStats?.[0]?.errorSamples).toEqual(["line one\nline two"]);
	});

	it("does NOT count non-boolean truthy is_error values (strict === true)", () => {
		const result = computeContextAndToolStats({
			messages: [
				{ role: "assistant", content: [toolUse("tu_1", "bash")] },
				{
					role: "user",
					content: [
						toolResult("tu_1", "boom", "true"),
						toolResult("tu_1", "boom", 1),
					],
				},
			],
		});
		expect(result.toolStats?.[0]).toEqual({
			toolName: "bash",
			callCount: 2,
			errorCount: 0,
			errorSamples: [],
		});
	});

	it("truncates error samples to exactly 500 chars", () => {
		const longError = "e".repeat(800);
		const result = computeContextAndToolStats({
			messages: [
				{ role: "assistant", content: [toolUse("tu_1", "bash")] },
				{ role: "user", content: [toolResult("tu_1", longError, true)] },
			],
		});
		const samples = result.toolStats?.[0]?.errorSamples;
		expect(samples).toHaveLength(1);
		expect(samples?.[0]).toHaveLength(500);
		expect(samples?.[0]).toBe("e".repeat(500));
	});

	it("caps errorSamples at 3 while still counting all errors", () => {
		const errors = Array.from({ length: 5 }, (_, i) =>
			toolResult("tu_1", `error ${i}`, true),
		);
		const result = computeContextAndToolStats({
			messages: [
				{ role: "assistant", content: [toolUse("tu_1", "bash")] },
				{ role: "user", content: errors },
			],
		});
		expect(result.toolStats?.[0]?.callCount).toBe(5);
		expect(result.toolStats?.[0]?.errorCount).toBe(5);
		expect(result.toolStats?.[0]?.errorSamples).toEqual([
			"error 0",
			"error 1",
			"error 2",
		]);
	});

	it("produces one ToolCallStat per distinct tool, in insertion order", () => {
		const result = computeContextAndToolStats({
			messages: [
				{
					role: "assistant",
					content: [
						toolUse("tu_1", "read_file"),
						toolUse("tu_2", "bash"),
						toolUse("tu_3", "read_file"),
					],
				},
				{
					role: "user",
					content: [
						toolResult("tu_1", "contents"),
						toolResult("tu_2", "exit 1", true),
						toolResult("tu_3", "more contents"),
					],
				},
			],
		});
		expect(result.toolStats).toEqual([
			{
				toolName: "read_file",
				callCount: 2,
				errorCount: 0,
				errorSamples: [],
			},
			{
				toolName: "bash",
				callCount: 1,
				errorCount: 1,
				errorSamples: ["exit 1"],
			},
		]);
	});

	it("dedup: only the FINAL message's tool_results are counted", () => {
		const result = computeContextAndToolStats({
			messages: [
				{ role: "assistant", content: [toolUse("tu_1", "bash")] },
				// Earlier turn already contained tool_results (including an error)
				// — these were counted on a previous request and must NOT recount.
				{
					role: "user",
					content: [toolResult("tu_1", "old error", true)],
				},
				{ role: "assistant", content: [toolUse("tu_2", "read_file")] },
				{ role: "user", content: [toolResult("tu_2", "fresh contents")] },
			],
		});
		expect(result.toolStats).toEqual([
			{
				toolName: "read_file",
				callCount: 1,
				errorCount: 0,
				errorSamples: [],
			},
		]);
	});

	it("resolves tool names from tool_use blocks in earlier assistant messages", () => {
		const result = computeContextAndToolStats({
			messages: [
				{ role: "user", content: "do the thing" },
				{ role: "assistant", content: [toolUse("tu_early", "grep_tool")] },
				{ role: "user", content: [toolResult("tu_early", "no matches", true)] },
			],
		});
		expect(result.toolStats?.[0]?.toolName).toBe("grep_tool");
	});

	it('falls back to "unknown" for orphan tool_use_ids', () => {
		const result = computeContextAndToolStats({
			messages: [
				{ role: "user", content: [toolResult("tu_missing", "orphaned", true)] },
			],
		});
		expect(result.toolStats).toEqual([
			{
				toolName: "unknown",
				callCount: 1,
				errorCount: 1,
				errorSamples: ["orphaned"],
			},
		]);
	});

	it("counts an error with unusable content but skips the empty sample", () => {
		const result = computeContextAndToolStats({
			messages: [
				{ role: "assistant", content: [toolUse("tu_1", "bash")] },
				{
					role: "user",
					content: [
						toolResult("tu_1", { weird: "object" }, true), // non-string/array
						toolResult("tu_1", "   ", true), // whitespace-only → empty after trim
						toolResult("tu_1", [], true), // empty array → empty join
					],
				},
			],
		});
		expect(result.toolStats?.[0]).toEqual({
			toolName: "bash",
			callCount: 3,
			errorCount: 3,
			errorSamples: [],
		});
	});

	it("handles malformed blocks safely without throwing", () => {
		const noUseId: Record<string, unknown> = {
			type: "tool_result",
			content: "no id here",
			is_error: true,
		};
		const result = computeContextAndToolStats({
			messages: [
				{
					role: "user",
					content: [
						null,
						42,
						"just a string",
						{ type: "text" },
						noUseId, // tool_result without tool_use_id → "unknown"
						toolResult(
							"tu_x",
							[null, 42, { type: "text", text: 7 }, { type: "text" }],
							true,
						), // garbage array entries → empty sample
					],
				},
			],
		});
		expect(result.toolStats).toEqual([
			{
				toolName: "unknown",
				callCount: 2,
				errorCount: 2,
				errorSamples: ["no id here"],
			},
		]);
	});

	it("never throws on a non-record final message", () => {
		expect(() =>
			computeContextAndToolStats({
				messages: [{ role: "user", content: "hi" }, null],
			}),
		).not.toThrow();
		expect(
			computeContextAndToolStats({
				messages: [{ role: "user", content: "hi" }, null],
			}).toolStats,
		).toBeNull();
	});
});
