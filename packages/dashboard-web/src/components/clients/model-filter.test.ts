import { describe, expect, it } from "bun:test";
import type { ClientModel } from "@clankermux/types";
import { matchesModelQuery } from "./model-filter";

const model: ClientModel = {
	id: "claude-fable-5-1[1m]",
	displayName: "Fable 5.1 long context",
	targetModel: "claude-fable-5-1",
	accountIds: ["acct-one"],
};

describe("matchesModelQuery", () => {
	it("matches every model on an empty or whitespace-only query", () => {
		expect(matchesModelQuery(model, "")).toBe(true);
		expect(matchesModelQuery(model, "   ")).toBe(true);
	});

	it("matches the id, the display name and the target, case-insensitively", () => {
		expect(matchesModelQuery(model, "[1M]")).toBe(true);
		expect(matchesModelQuery(model, "LONG context")).toBe(true);
		expect(
			matchesModelQuery(
				{ ...model, id: "long-window", displayName: "Long window" },
				"claude-fable-5-1",
			),
		).toBe(true);
		expect(matchesModelQuery(model, "opus")).toBe(false);
	});

	it("requires every term, and matches each one inside a single field", () => {
		expect(matchesModelQuery(model, "fable long")).toBe(true);
		expect(matchesModelQuery(model, "fable opus")).toBe(false);
		expect(matchesModelQuery(model, "1m]fable")).toBe(false);
	});
});
