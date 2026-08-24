/**
 * The raw OpenAI-compatible bucket extractor.
 *
 * These readings exist only while the raw upstream response does —
 * `sanitizeHeaders` deletes the whole `x-ratelimit-*` family on the way to the
 * client — so the extractor's job is to preserve what arrived, absences and
 * malformations included, rather than to make anything usable.
 */
import { describe, expect, it } from "bun:test";
import { extractRawOpenAiBuckets } from "../rate-limit-headers";
import { sanitizeHeaders } from "../stream";

const h = (headers: Record<string, string>): Headers => new Headers(headers);

describe("extractRawOpenAiBuckets", () => {
	it("yields nothing for a response with no bucket headers", () => {
		expect(extractRawOpenAiBuckets(h({}))).toEqual([]);
		expect(
			extractRawOpenAiBuckets(h({ "content-type": "application/json" })),
		).toEqual([]);
	});

	it("extracts both buckets in a deterministic order", () => {
		expect(
			extractRawOpenAiBuckets(
				h({
					"x-ratelimit-limit-requests": "10000",
					"x-ratelimit-remaining-requests": "9999",
					"x-ratelimit-reset-requests": "6m0s",
					"x-ratelimit-limit-tokens": "2000000",
					"x-ratelimit-remaining-tokens": "1999000",
					"x-ratelimit-reset-tokens": "1.2s",
				}),
			),
		).toEqual([
			{
				bucket: "requests",
				limitValue: 10_000,
				remaining: 9_999,
				// VERBATIM: the duration grammar is undocumented and has changed, so
				// a parsed number would bake this build's guess into the series.
				resetRaw: "6m0s",
			},
			{
				bucket: "tokens",
				limitValue: 2_000_000,
				remaining: 1_999_000,
				resetRaw: "1.2s",
			},
		]);
	});

	it("keeps a remaining of zero as zero", () => {
		// The single most important reading this table can carry; a `|| null`
		// anywhere on the path would erase it.
		const [bucket] = extractRawOpenAiBuckets(
			h({ "x-ratelimit-remaining-tokens": "0" }),
		);
		expect(bucket.remaining).toBe(0);
	});

	it("emits a bucket from a single present header", () => {
		expect(
			extractRawOpenAiBuckets(h({ "x-ratelimit-reset-tokens": "3s" })),
		).toEqual([
			{ bucket: "tokens", limitValue: null, remaining: null, resetRaw: "3s" },
		]);
	});

	it("writes the row when a header is present but malformed", () => {
		// The presence of a malformed header IS the observation. Prefix-tolerant
		// parsing would be worse than nulls: "60000 tokens" must not become 60000.
		expect(
			extractRawOpenAiBuckets(
				h({
					"x-ratelimit-limit-tokens": "60000 tokens",
					"x-ratelimit-remaining-tokens": "6e4",
				}),
			),
		).toEqual([
			{
				bucket: "tokens",
				limitValue: null,
				remaining: null,
				resetRaw: null,
			},
		]);
	});

	it("captures exactly what the client sanitizer is about to delete", () => {
		// The reason this extractor has to run on the RAW response: after
		// sanitizeHeaders there is nothing left to read.
		const raw = h({
			"x-ratelimit-limit-tokens": "2000000",
			"x-ratelimit-remaining-tokens": "1999000",
			"content-type": "application/json",
		});

		expect(extractRawOpenAiBuckets(raw)).toHaveLength(1);
		expect(extractRawOpenAiBuckets(sanitizeHeaders(raw))).toEqual([]);
	});
});
