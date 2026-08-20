/**
 * The sniffer gates its marker regex behind `buffer.includes("error")`. That
 * gate is a necessary condition of the pattern itself (which requires
 * `event:\s*error`), so it cannot change any outcome — it is strictly weaker
 * than the regex, never an additional filter. These pin that claim against the
 * shapes most likely to break a naive pre-filter.
 *
 * It exists because the regex ran on EVERY chunk across the whole rolling
 * buffer, searching for something a normal stream never contains: at 5000
 * chunks, decode+trim alone is ~10 ms while adding the per-chunk regex takes
 * the total to ~97 ms. The gate brings that to ~33 ms.
 */

import { describe, expect, it } from "bun:test";
import { createSseRateLimitSniffer } from "../sse-rate-limit-sniffer";

const encode = (s: string) => new TextEncoder().encode(s);

const frameWith = (eventLine: string) =>
	encode(
		`${eventLine}\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"x"}}\n\n`,
	);

describe("SseRateLimitSniffer — regex pre-filter cannot mask a frame", () => {
	it("fires with no whitespace after 'event:'", () => {
		const s = createSseRateLimitSniffer({ provider: "anthropic" });
		expect(s.feed(frameWith("event:error"))).toBe(true);
	});

	it("fires with extra spaces after 'event:'", () => {
		const s = createSseRateLimitSniffer({ provider: "anthropic" });
		expect(s.feed(frameWith("event:   error"))).toBe(true);
	});

	it("fires with a tab after 'event:'", () => {
		const s = createSseRateLimitSniffer({ provider: "anthropic" });
		expect(s.feed(frameWith("event:\terror"))).toBe(true);
	});

	it("does not fire on prose containing the word error, but still fires after", () => {
		const s = createSseRateLimitSniffer({ provider: "anthropic" });
		// Content legitimately mentioning "error" passes the gate and reaches the
		// regex, which must still decline to match. This is the case where the
		// gate buys nothing and correctness is carried by the regex alone.
		expect(
			s.feed(
				encode(
					'event: content_block_delta\ndata: {"delta":{"text":"handle the error case"}}\n\n',
				),
			),
		).toBe(false);
		expect(s.feed(frameWith("event: error"))).toBe(true);
	});

	it("detects a frame arriving after the rolling buffer has already trimmed", () => {
		const s = createSseRateLimitSniffer({ provider: "anthropic" });
		// Push well past MAX_BUFFER_BYTES of error-free content first, so the
		// frame lands in a buffer that has been sliced at least once.
		const filler = encode(
			`event: content_block_delta\ndata: {"delta":{"text":"${"z".repeat(400)}"}}\n\n`,
		);
		for (let i = 0; i < 80; i++) expect(s.feed(filler)).toBe(false);
		expect(s.feed(frameWith("event: error"))).toBe(true);
	});

	it("detects a frame completed by a chunk that contains no 'error' substring", () => {
		const s = createSseRateLimitSniffer({ provider: "anthropic" });
		// THE discriminating case for buffer-gating vs chunk-gating, and the whole
		// reason the gate reads `buffer` and not the incoming chunk.
		//
		// The split is placed inside the TYPE token, so the chunk that finally
		// completes the match carries only `ror"}` — no "error" substring at all.
		// A chunk-level gate would skip the regex on exactly the feed where the
		// buffer first becomes matchable, and because the sniffer is one-shot it
		// would then never fire: a provider incident would silently fail to trip
		// the family overload breaker.
		//
		// Splitting anywhere else does not test this. Cut the frame earlier and
		// the completing chunk still contains `"type":"error"` or the `error` key,
		// so a chunk gate passes and the test succeeds against a broken
		// implementation.
		expect(s.feed(encode('event: error\ndata: {"type":"rate_limit_er'))).toBe(
			false,
		);
		expect(s.feed(encode('ror"}\n\n'))).toBe(true);
		expect(s.firedReason).toBe("rate_limit_error");
	});

	it("still ignores non-matching error types after the gate passes", () => {
		const s = createSseRateLimitSniffer({ provider: "anthropic" });
		expect(
			s.feed(
				encode(
					'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"x"}}\n\n',
				),
			),
		).toBe(false);
	});
});
