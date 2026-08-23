import { describe, expect, it } from "bun:test";
import {
	CHATGPT_BACKEND_REASONING_EFFORTS,
	clampChatGptBackendReasoningEffort,
	sanitizeChatGptBackendBody,
} from "../backend-params";

describe("clampChatGptBackendReasoningEffort", () => {
	it("preserves every value the backend accepts, including none", () => {
		for (const effort of CHATGPT_BACKEND_REASONING_EFFORTS) {
			expect(clampChatGptBackendReasoningEffort(effort)).toBe(effort);
		}
		// Called out explicitly: `none` is a real, cheapest-accepted value (the
		// native ping relies on it), never an "absent effort" to be replaced.
		expect(clampChatGptBackendReasoningEffort("none")).toBe("none");
	});

	it("maps minimal to none (nearest in intent: least reasoning)", () => {
		expect(clampChatGptBackendReasoningEffort("minimal")).toBe("none");
	});

	it("clamps an above-ceiling value down to xhigh", () => {
		expect(clampChatGptBackendReasoningEffort("max")).toBe("xhigh");
	});

	it("leaves an unrecognised value untouched without throwing", () => {
		expect(clampChatGptBackendReasoningEffort("ludicrous")).toBe("ludicrous");
		expect(clampChatGptBackendReasoningEffort("")).toBe("");
		expect(clampChatGptBackendReasoningEffort("LOW")).toBe("LOW");
	});
});

describe("sanitizeChatGptBackendBody", () => {
	// The four names are spelled out literally rather than derived from the
	// module's own list: a test that iterates the list it is testing stays green
	// when an entry goes missing.
	it("drops every top-level parameter the backend rejects", () => {
		const body: Record<string, unknown> = {
			model: "gpt-5.5-codex",
			max_output_tokens: 4096,
			metadata: { trace: "abc" },
			temperature: 0.7,
			user: "user-123",
		};

		const result = sanitizeChatGptBackendBody(body);

		expect(Object.keys(body)).toEqual(["model"]);
		expect([...result.droppedParams].sort()).toEqual([
			"max_output_tokens",
			"metadata",
			"temperature",
			"user",
		]);
		expect(result.clampedEffort).toBeUndefined();
	});

	it("drops a rejected parameter by PRESENCE, not truthiness", () => {
		// `temperature: 0` is a deliberate, meaningful client choice (greedy
		// sampling) and `user: ""` is falsy — the backend 400s on the parameter
		// being present at all, so a truthiness test would forward both.
		const body: Record<string, unknown> = {
			temperature: 0,
			user: "",
			metadata: null,
			max_output_tokens: 0,
		};

		const result = sanitizeChatGptBackendBody(body);

		expect(Object.keys(body)).toEqual([]);
		expect(result.droppedParams).toHaveLength(4);
	});

	it("reports nothing and mutates nothing for a clean body", () => {
		const body: Record<string, unknown> = {
			model: "gpt-5.5-codex",
			input: [{ role: "user", content: "hi" }],
			reasoning: { effort: "medium", summary: "auto" },
		};

		const result = sanitizeChatGptBackendBody(body);

		expect(result.droppedParams).toEqual([]);
		expect(result.clampedEffort).toBeUndefined();
		expect(body).toEqual({
			model: "gpt-5.5-codex",
			input: [{ role: "user", content: "hi" }],
			reasoning: { effort: "medium", summary: "auto" },
		});
	});

	it("forwards unknown top-level fields untouched (denylist, not allowlist)", () => {
		// The point of the denylist: a Responses field the backend learns to
		// accept before we learn it exists must reach it, not be eaten.
		const body: Record<string, unknown> = {
			model: "gpt-5.5-codex",
			include: ["reasoning.encrypted_content"],
			service_tier: "priority",
			text: { verbosity: "low" },
			some_field_invented_next_quarter: true,
			tools: [{ type: "web_search" }, { type: "not_a_real_tool" }],
		};
		const snapshot = structuredClone(body);

		const result = sanitizeChatGptBackendBody(body);

		expect(body).toEqual(snapshot);
		expect(result.droppedParams).toEqual([]);
	});

	it("does NOT drop max_tokens or max_completion_tokens", () => {
		// Chat-Completions-era names, never verified against this backend. They
		// are not valid Responses fields, so a client sending one has a genuine
		// request-shape bug that the backend's own 400 names precisely; guessing
		// on its behalf would hide it.
		const body: Record<string, unknown> = {
			max_tokens: 100,
			max_completion_tokens: 200,
		};

		const result = sanitizeChatGptBackendBody(body);

		expect(body).toEqual({ max_tokens: 100, max_completion_tokens: 200 });
		expect(result.droppedParams).toEqual([]);
	});

	it("clamps reasoning.effort in place and reports the rewrite", () => {
		const body: Record<string, unknown> = {
			reasoning: { effort: "minimal", summary: "auto" },
		};

		const result = sanitizeChatGptBackendBody(body);

		expect(body.reasoning).toEqual({ effort: "none", summary: "auto" });
		expect(result.clampedEffort).toEqual({ from: "minimal", to: "none" });
	});

	it("reports no clamp when the effort was already accepted", () => {
		const body: Record<string, unknown> = { reasoning: { effort: "high" } };

		const result = sanitizeChatGptBackendBody(body);

		expect(body.reasoning).toEqual({ effort: "high" });
		expect(result.clampedEffort).toBeUndefined();
	});

	it("leaves a non-object or array reasoning value alone", () => {
		const stringReasoning: Record<string, unknown> = { reasoning: "minimal" };
		expect(
			sanitizeChatGptBackendBody(stringReasoning).clampedEffort,
		).toBeUndefined();
		expect(stringReasoning.reasoning).toBe("minimal");

		const arrayReasoning: Record<string, unknown> = {
			reasoning: [{ effort: "minimal" }],
		};
		expect(
			sanitizeChatGptBackendBody(arrayReasoning).clampedEffort,
		).toBeUndefined();
		expect(arrayReasoning.reasoning).toEqual([{ effort: "minimal" }]);
	});

	it("reports a drop and a clamp from the same body", () => {
		const body: Record<string, unknown> = {
			temperature: 1,
			reasoning: { effort: "max" },
		};

		const result = sanitizeChatGptBackendBody(body);

		expect(result.droppedParams).toEqual(["temperature"]);
		expect(result.clampedEffort).toEqual({ from: "max", to: "xhigh" });
		expect(body).toEqual({ reasoning: { effort: "xhigh" } });
	});
});
