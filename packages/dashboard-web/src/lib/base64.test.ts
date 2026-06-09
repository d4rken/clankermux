import { describe, expect, it, spyOn } from "bun:test";
import { decodeBase64Utf8 } from "./base64";

// Encode a JS string to base64 the same way the proxy does on the server:
// UTF-8 bytes → binary string → base64. Lets us assert a true round-trip.
const toBase64Utf8 = (s: string): string =>
	btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe("decodeBase64Utf8", () => {
	it("returns 'No data' for null or empty input", () => {
		expect(decodeBase64Utf8(null)).toBe("No data");
		expect(decodeBase64Utf8("")).toBe("No data");
	});

	it("maps the '[streamed]' sentinel to a friendly message", () => {
		expect(decodeBase64Utf8("[streamed]")).toBe(
			"[Streaming data not captured]",
		);
	});

	it("round-trips plain ASCII", () => {
		expect(decodeBase64Utf8(toBase64Utf8("hello world"))).toBe("hello world");
	});

	it("decodes multi-byte UTF-8 without garbling (the bug this fixes)", () => {
		const original = 'héllo 世界 🌍 — "quoté"';
		expect(decodeBase64Utf8(toBase64Utf8(original))).toBe(original);
	});

	it("preserves a JSON body with non-ASCII content", () => {
		const body = JSON.stringify({ text: "Café — naïve 日本語 😀" });
		expect(decodeBase64Utf8(toBase64Utf8(body))).toBe(body);
	});

	it("falls back to an error string on undecodable input", () => {
		const spy = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(decodeBase64Utf8("not%valid%base64")).toBe(
				"Failed to decode: not%valid%base64",
			);
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
