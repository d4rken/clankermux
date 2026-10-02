import { describe, expect, it } from "bun:test";
import {
	decodeReasoningEffortAdaptation,
	encodeReasoningEffortAdaptation,
} from "./reasoning-adaptation";
import {
	decodeServiceTierAdaptation,
	encodeServiceTierAdaptation,
} from "./service-tier-adaptation";

const raw = (value: unknown) => {
	let binary = "";
	for (const byte of new TextEncoder().encode(JSON.stringify(value)))
		binary += String.fromCharCode(byte);
	return btoa(binary);
};

describe("attempt audit header codec", () => {
	it("round-trips both channels", () => {
		const effort = { requested: "minimal", effective: "low", reason: "x" };
		expect(
			decodeReasoningEffortAdaptation(encodeReasoningEffortAdaptation(effort)),
		).toEqual(effort);
		const tier = {
			requested: "default",
			sent: "priority",
			reason: "account_fast_mode",
		};
		expect(
			decodeServiceTierAdaptation(encodeServiceTierAdaptation(tier)),
		).toEqual(tier);
	});

	it("keeps 64 characters and truncates the 65th with an ellipsis", () => {
		const exact = "a".repeat(64);
		const over = "b".repeat(65);
		expect(
			decodeServiceTierAdaptation(
				encodeServiceTierAdaptation({
					requested: exact,
					sent: over,
					reason: null,
				}),
			),
		).toEqual({
			requested: exact,
			sent: `${"b".repeat(64)}…`,
			reason: null,
		});
	});

	it("carries non-Latin-1 and control characters intact", () => {
		const odd = "ü\u0001😀";
		const encoded = encodeReasoningEffortAdaptation({
			requested: odd,
			effective: null,
			reason: null,
		});
		// A valid header value: base64 only.
		expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
		expect(decodeReasoningEffortAdaptation(encoded)?.requested).toBe(odd);
	});

	it("encodes an all-null record as no header at all", () => {
		expect(
			encodeServiceTierAdaptation({
				requested: null,
				sent: null,
				reason: null,
			}),
		).toBeNull();
		expect(
			decodeServiceTierAdaptation(
				raw({ requested: null, sent: null, reason: null }),
			),
		).toBeNull();
	});

	it("reads anything malformed as no record", () => {
		for (const value of [
			null,
			undefined,
			"",
			"not base64!",
			btoa("{not json"),
			raw([1, 2]),
			raw("text"),
			raw(42),
			raw(null),
		]) {
			expect(decodeReasoningEffortAdaptation(value)).toBeNull();
			expect(decodeServiceTierAdaptation(value)).toBeNull();
		}
	});

	it("drops non-string fields but keeps the string ones", () => {
		expect(
			decodeServiceTierAdaptation(
				raw({ requested: 1, sent: "priority", reason: { x: 1 } }),
			),
		).toEqual({ requested: null, sent: "priority", reason: null });
	});
});
