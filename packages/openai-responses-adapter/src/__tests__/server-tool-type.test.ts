import { describe, expect, test } from "bun:test";
import { anthropicServerToolType } from "@clankermux/types";
import { translateRequestToAnthropic } from "../request-translator";

describe("a Responses request translated to Messages", () => {
	test("carries no Anthropic-defined tool, so routing does not hold it off Codex", () => {
		const translated = translateRequestToAnthropic({
			model: "gpt-6-astra",
			input: [{ type: "message", role: "user", content: "search and read" }],
			tools: [
				{ type: "web_search" },
				{
					type: "function",
					name: "read",
					parameters: { type: "object", properties: {} },
				},
			],
		} as Parameters<typeof translateRequestToAnthropic>[0]);
		expect(anthropicServerToolType(translated)).toBeNull();
	});
});
