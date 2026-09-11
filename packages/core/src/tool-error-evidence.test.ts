import { expect, it } from "bun:test";
import {
	extractToolErrorEvidence,
	extractToolErrorText,
	truncateToolEvidence,
} from "./tool-error-evidence";

it("preserves ingest text semantics", () => {
	expect(
		extractToolErrorText([
			{ type: "text", text: "one" },
			{ type: "image" },
			{ type: "text", text: "two" },
		]),
	).toBe("one\ntwo");
	expect(extractToolErrorText("x".repeat(700))).toHaveLength(500);
	expect(extractToolErrorText({ text: "not a text block" })).toBe("");
});
it("shows ambiguous matching calls and excludes historical results and false errors", () => {
	const body = {
		messages: [
			{
				content: [
					{
						type: "tool_use",
						id: "a",
						name: "Bash",
						input: { command: "first" },
					},
					{
						type: "tool_use",
						id: "b",
						name: "Bash",
						input: { command: "second" },
					},
				],
			},
			{
				content: [
					{
						type: "tool_result",
						tool_use_id: "a",
						is_error: true,
						content: "old",
					},
				],
			},
			{
				content: [
					{
						type: "tool_result",
						tool_use_id: "a",
						is_error: true,
						content: "same",
					},
					{
						type: "tool_result",
						tool_use_id: "b",
						is_error: true,
						content: "same",
					},
					{
						type: "tool_result",
						tool_use_id: "b",
						is_error: "true",
						content: "same",
					},
				],
			},
		],
	};
	const result = extractToolErrorEvidence(body, "Bash", "same");
	expect(result.state).toBe("ambiguous");
	expect(result.totalMatches).toBe(2);
	expect(result.matches[1]?.input).toContain("second");
	expect(extractToolErrorEvidence(body, "Bash", "old").state).toBe("no-match");
});
it("clips unicode without breaking characters", () => {
	expect(truncateToolEvidence("😀😀", 5)).toEqual({
		text: "😀",
		truncated: true,
	});
});
it("reports prefix collisions and bounds returned candidates and UTF8 excerpts", () => {
	const content = "😀".repeat(10000);
	const body = {
		messages: [
			{
				content: [
					{
						type: "tool_use",
						id: "x",
						name: "Bash",
						input: { command: content },
					},
				],
			},
			{
				content: Array.from({ length: 5 }, (_, i) => ({
					type: "tool_result",
					tool_use_id: "x",
					is_error: true,
					content: content + String(i),
				})),
			},
		],
	};
	const result = extractToolErrorEvidence(
		body,
		"Bash",
		extractToolErrorText(content),
	);
	expect(result.state).toBe("ambiguous");
	expect(result.totalMatches).toBe(5);
	expect(result.omittedMatches).toBe(2);
	expect(result.matches).toHaveLength(3);
	for (const match of result.matches) {
		expect(
			new TextEncoder().encode(match.input ?? "").length,
		).toBeLessThanOrEqual(8192);
		expect(new TextEncoder().encode(match.result).length).toBeLessThanOrEqual(
			8192,
		);
		expect(match.resultTruncated).toBe(true);
	}
});
