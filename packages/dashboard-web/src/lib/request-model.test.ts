import { describe, expect, it } from "bun:test";
import {
	getRefusalFallbackBadge,
	getRequestModelPresentation,
} from "./request-model";

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

describe("getRefusalFallbackBadge", () => {
	it("names the refusal category on a refused request", () => {
		expect(getRefusalFallbackBadge({ refusalCategory: "cyber" })).toEqual({
			label: "refused · cyber",
			title:
				"The provider's safety filter declined this request (stop_reason: refusal)",
		});
	});

	it("names the refused model on a fallback retry", () => {
		expect(
			getRefusalFallbackBadge({
				fallbackCreditClaimed: true,
				fallbackFromModel: "claude-fable-5-1",
			}),
		).toEqual({
			label: "fallback retry · for claude-fable-5-1",
			title:
				"Re-sent by Claude Code to a fallback model with a fallback credit after a refusal",
		});
	});

	it("omits the origin when the credit could not be traced to a refusal", () => {
		expect(
			getRefusalFallbackBadge({ fallbackCreditClaimed: true })?.label,
		).toBe("fallback retry");
	});

	it("prefers the refusal when a retry was itself refused", () => {
		expect(
			getRefusalFallbackBadge({
				refusalCategory: "unknown",
				fallbackCreditClaimed: true,
				fallbackFromModel: "claude-fable-5-1",
			})?.label,
		).toBe("refused · unknown");
	});

	it("returns null for an ordinary request and for no summary at all", () => {
		expect(getRefusalFallbackBadge({})).toBeNull();
		expect(getRefusalFallbackBadge(undefined)).toBeNull();
		expect(
			getRefusalFallbackBadge({ fallbackCreditClaimed: false }),
		).toBeNull();
	});
});
