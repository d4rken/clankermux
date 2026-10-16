import { describe, expect, it } from "bun:test";
import type { ChatField } from "@clankermux/types";
import {
	chatFieldCapability,
	ignoredChatFields,
	refusedChatField,
} from "./chat-capabilities";

const every: readonly ChatField[] = [
	"max_tokens",
	"temperature",
	"top_p",
	"stop",
	"reasoning_content",
	"response_format",
];
const verdict = (provider: string, viaSdkBridge = false) => {
	const capability = chatFieldCapability(provider, viaSdkBridge);
	if (!capability) return null;
	return Object.fromEntries(
		every.map((field) => {
			const requirements = { fields: [field] };
			if (refusedChatField(capability, requirements)) return [field, "refused"];
			return [
				field,
				ignoredChatFields(capability, requirements).length
					? "ignored"
					: "passed",
			];
		}),
	);
};

describe("Chat field capability", () => {
	it("Codex ignores the sampling and limit fields, refuses stop and reasoning history, and passes a schema", () => {
		expect(verdict("codex")).toEqual({
			max_tokens: "ignored",
			temperature: "ignored",
			top_p: "ignored",
			stop: "refused",
			reasoning_content: "refused",
			response_format: "passed",
		});
	});
	it("OpenRouter passes every field on", () => {
		expect(verdict("openrouter")).toEqual({
			max_tokens: "passed",
			temperature: "passed",
			top_p: "passed",
			stop: "passed",
			reasoning_content: "passed",
			response_format: "passed",
		});
	});
	it("the SDK bridge ignores temperature and top_p, refuses a schema, and leaves other refusals to its own field policy", () => {
		expect(verdict("anthropic", true)).toEqual({
			max_tokens: "passed",
			temperature: "ignored",
			top_p: "ignored",
			stop: "passed",
			reasoning_content: "passed",
			response_format: "refused",
		});
	});
	it("has no Chat ingress for other providers, or for a direct send to an official Anthropic account", () => {
		expect(chatFieldCapability("anthropic")).toBeNull();
		expect(chatFieldCapability("zai")).toBeNull();
		expect(chatFieldCapability("devin")).toBeNull();
	});
	it("reports the first refused field and the ignored ones in request order", () => {
		const codex = chatFieldCapability("codex");
		if (!codex) throw new Error("Codex has Chat ingress");
		const requirements = {
			fields: ["top_p", "max_tokens", "reasoning_content", "stop"] as const,
		};
		expect(refusedChatField(codex, requirements)).toBe("reasoning_content");
		expect(ignoredChatFields(codex, requirements)).toEqual([
			"top_p",
			"max_tokens",
		]);
		expect(refusedChatField(codex, { fields: [] })).toBeNull();
		expect(ignoredChatFields(codex, { fields: [] })).toEqual([]);
	});
});
