import { describe, expect, it } from "bun:test";
import {
	CHATGPT_BACKEND_REASONING_EFFORTS,
	clampChatGptBackendReasoningEffort,
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
