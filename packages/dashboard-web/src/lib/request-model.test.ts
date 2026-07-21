import { describe, expect, it } from "bun:test";
import { getRequestModelPresentation } from "./request-model";

describe("getRequestModelPresentation", () => {
	it("prefers the provider-reported model", () => {
		expect(
			getRequestModelPresentation({
				model: "served-model",
				requestedModel: "claude-haiku-4-5-20251001",
			}),
		).toEqual({ value: "served-model", requestedOnly: false });
	});

	it("falls back to the requested model for usage-less errors", () => {
		expect(
			getRequestModelPresentation({
				requestedModel: "claude-haiku-4-5-20251001",
			}),
		).toEqual({
			value: "claude-haiku-4-5-20251001",
			requestedOnly: true,
		});
	});

	it("returns null when neither model is known", () => {
		expect(getRequestModelPresentation(undefined)).toBeNull();
		expect(getRequestModelPresentation({})).toBeNull();
	});
});
