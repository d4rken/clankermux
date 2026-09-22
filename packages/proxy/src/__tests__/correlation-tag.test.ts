/**
 * Tests for the `x-clankermux-correlation-tag` validator.
 *
 * The property under test is that it NEVER TRANSFORMS. Every rejection case
 * here has an obvious "repair" available — strip the TAB, drop the DEL,
 * truncate to 128 — and every one of those repairs would mint a tag that looks
 * valid, is not the one the client holds, and comes back matched to a different
 * request. So the assertions are on `null`, not on a cleaned-up string.
 */
import { describe, expect, it } from "bun:test";
import {
	CORRELATION_TAG_HEADER,
	CORRELATION_TAG_MAX_BYTES,
	extractCorrelationTag,
	validateCorrelationTag,
} from "../correlation-tag";

const MAX = "a".repeat(CORRELATION_TAG_MAX_BYTES);

describe("validateCorrelationTag", () => {
	it("accepts a 128-byte all-printable tag unchanged", () => {
		expect(MAX).toHaveLength(128);
		expect(validateCorrelationTag(MAX)).toBe(MAX);
	});

	it("accepts the full printable range, including space and the delimiters", () => {
		const printable = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
			String.fromCharCode(0x20 + i),
		).join("");
		expect(printable).toHaveLength(95);
		expect(validateCorrelationTag(printable)).toBe(printable);
	});

	it("accepts a single byte", () => {
		expect(validateCorrelationTag("x")).toBe("x");
	});

	it("refuses a 129-byte tag instead of truncating it", () => {
		expect(validateCorrelationTag(`${MAX}a`)).toBeNull();
	});

	it("refuses a tag containing TAB instead of stripping it", () => {
		expect(validateCorrelationTag("run\t42")).toBeNull();
	});

	it("refuses a tag containing DEL", () => {
		expect(validateCorrelationTag("run\x7f42")).toBeNull();
	});

	it("refuses NUL, newline and carriage return", () => {
		expect(validateCorrelationTag("run\x0042")).toBeNull();
		expect(validateCorrelationTag("run\n42")).toBeNull();
		expect(validateCorrelationTag("run\r42")).toBeNull();
	});

	it("refuses an empty tag — an empty value is absent, not a tag", () => {
		expect(validateCorrelationTag("")).toBeNull();
	});

	it("refuses a non-ASCII tag rather than transcoding it", () => {
		expect(validateCorrelationTag("café")).toBeNull();
	});

	it("does NOT trim surrounding spaces — HTTP already stripped the OWS", () => {
		// A space INSIDE the field value is part of the value, so a tag the
		// client deliberately padded round-trips as it was sent.
		expect(validateCorrelationTag(" run 42 ")).toBe(" run 42 ");
	});

	it("refuses a missing value", () => {
		expect(validateCorrelationTag(undefined)).toBeNull();
		expect(validateCorrelationTag(null)).toBeNull();
	});
});

describe("extractCorrelationTag", () => {
	it("reads the header off a captured header record", () => {
		expect(
			extractCorrelationTag({
				"content-type": "application/json",
				[CORRELATION_TAG_HEADER]: "run-42",
			}),
		).toBe("run-42");
	});

	it("matches the header name case-insensitively", () => {
		expect(
			extractCorrelationTag({ "X-ClankerMux-Correlation-Tag": "run-42" }),
		).toBe("run-42");
	});

	it("returns null for a header that is absent", () => {
		expect(extractCorrelationTag({ "content-type": "text/plain" })).toBeNull();
	});

	it("returns null for a header whose value is refused", () => {
		expect(
			extractCorrelationTag({ [CORRELATION_TAG_HEADER]: "run\t42" }),
		).toBeNull();
	});
});
