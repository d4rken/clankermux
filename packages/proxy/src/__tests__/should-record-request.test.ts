/**
 * Unit tests for the canonical `shouldRecordRequest` predicate — the union of
 * the two historical filter sets:
 *
 *   - response-handler.ts `shouldProcessRequest`
 *       (count_tokens-on-openai-compatible + auto-refresh probe)
 *   - post-processor.worker.ts `shouldLogRequest`
 *       (.well-known 404s)
 *
 * The predicate is pure, so these tests exercise the boolean logic directly.
 * We deliberately drive `getHeader` from BOTH call-site styles — a real
 * `Headers` object (response-handler) and a plain lower-cased object
 * (worker `msg.requestHeaders`) — to prove the input shape fits both.
 */
import { describe, expect, it } from "bun:test";
import {
	type ShouldRecordRequestInput,
	shouldRecordRequest,
} from "../should-record-request";

// ---------------------------------------------------------------------------
// Header accessors mirroring the two call sites
// ---------------------------------------------------------------------------

/** Response-handler style: a real `Headers` object. */
function headersAccessor(
	init?: Record<string, string>,
): ShouldRecordRequestInput["getHeader"] {
	const headers = new Headers(init);
	return (name) => headers.get(name);
}

/** Worker style: a plain object keyed by lower-case header name. */
function objectAccessor(
	obj: Record<string, string> = {},
): ShouldRecordRequestInput["getHeader"] {
	return (name) => obj[name.toLowerCase()] ?? null;
}

/** A normal, recordable request with sensible defaults. */
function makeInput(
	overrides: Partial<ShouldRecordRequestInput> = {},
): ShouldRecordRequestInput {
	return {
		method: "POST",
		path: "/v1/messages",
		providerName: "anthropic",
		responseStatus: 200,
		getHeader: headersAccessor(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Excluded: count_tokens on openai-compatible
// ---------------------------------------------------------------------------

describe("shouldRecordRequest — count_tokens on openai-compatible", () => {
	it("excludes count_tokens on the openai-compatible provider", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					providerName: "openai-compatible",
					path: "/v1/messages/count_tokens",
				}),
			),
		).toBe(false);
	});

	it("records count_tokens on a NON-openai-compatible provider", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					providerName: "anthropic",
					path: "/v1/messages/count_tokens",
				}),
			),
		).toBe(true);
	});

	it("records a normal /v1/messages request on openai-compatible", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					providerName: "openai-compatible",
					path: "/v1/messages",
				}),
			),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Excluded: synthetic auto-refresh probe
// ---------------------------------------------------------------------------

describe("shouldRecordRequest — auto-refresh probe header", () => {
	it("excludes a probe when x-clankermux-auto-refresh === 'true' (Headers)", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					getHeader: headersAccessor({
						"x-clankermux-auto-refresh": "true",
					}),
				}),
			),
		).toBe(false);
	});

	it("excludes a probe when x-clankermux-auto-refresh === 'true' (plain object / worker style)", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					getHeader: objectAccessor({
						"x-clankermux-auto-refresh": "true",
					}),
				}),
			),
		).toBe(false);
	});

	it("matches the header case-insensitively (mixed-case lookup name)", () => {
		// Headers.get is already case-insensitive; assert the predicate asks for
		// the canonical lower-case name and still resolves a mixed-case value.
		const headers = new Headers({ "X-Clankermux-Auto-Refresh": "true" });
		expect(
			shouldRecordRequest(makeInput({ getHeader: (n) => headers.get(n) })),
		).toBe(false);
	});

	it("records when the probe header is absent", () => {
		expect(shouldRecordRequest(makeInput())).toBe(true);
	});

	it("excludes a synthetic cache-keepalive replay (x-clankermux-keepalive === 'true')", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					getHeader: headersAccessor({ "x-clankermux-keepalive": "true" }),
				}),
			),
		).toBe(false);
		expect(
			shouldRecordRequest(
				makeInput({
					getHeader: objectAccessor({ "x-clankermux-keepalive": "true" }),
				}),
			),
		).toBe(false);
	});

	it("records when the probe header has a non-'true' value", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					getHeader: headersAccessor({
						"x-clankermux-auto-refresh": "false",
					}),
				}),
			),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Excluded: worker ignored paths (.well-known 404s)
// ---------------------------------------------------------------------------

describe("shouldRecordRequest — .well-known 404s", () => {
	it("excludes a /.well-known/ path that returned 404", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					method: "GET",
					path: "/.well-known/oauth-authorization-server",
					responseStatus: 404,
				}),
			),
		).toBe(false);
	});

	it("records a /.well-known/ path that returned 200 (only 404s are skipped)", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					method: "GET",
					path: "/.well-known/oauth-authorization-server",
					responseStatus: 200,
				}),
			),
		).toBe(true);
	});

	it("records a non-.well-known path that returned 404", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					path: "/v1/messages",
					responseStatus: 404,
				}),
			),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Normal recordable traffic
// ---------------------------------------------------------------------------

describe("shouldRecordRequest — normal traffic", () => {
	it("records a standard anthropic POST /v1/messages 200", () => {
		expect(shouldRecordRequest(makeInput())).toBe(true);
	});

	it("records a standard openai-compatible chat completion", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					providerName: "openai-compatible",
					path: "/v1/chat/completions",
					responseStatus: 200,
				}),
			),
		).toBe(true);
	});

	it("records a 429 rate-limited response (real user traffic worth logging)", () => {
		expect(shouldRecordRequest(makeInput({ responseStatus: 429 }))).toBe(true);
	});
});
