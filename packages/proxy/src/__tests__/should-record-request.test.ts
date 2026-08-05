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
	isIngressRecordable,
	type IsIngressRecordableInput,
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
		// Probe-marker suppressions are trust-gated on the unspoofable in-process
		// dispatch flag, so the default fixture is an INTERNAL dispatch — that is
		// the only configuration in which the marker headers mean anything.
		internal: true,
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

	it("records count_tokens on a non-openai-compatible, non-codex provider (e.g. anthropic)", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					providerName: "anthropic",
					path: "/v1/messages/count_tokens",
				}),
			),
		).toBe(true);
	});

	it("does NOT record count_tokens for codex provider", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					providerName: "codex",
					path: "/v1/messages/count_tokens",
				}),
			),
		).toBe(false);
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
// Trust gate: the probe markers are plain client-settable headers, so without
// the unspoofable in-process `internal` flag they must NOT hide a request from
// Request History (and from the cost/usage metrics that table feeds).
// ---------------------------------------------------------------------------

describe("shouldRecordRequest — probe markers are trust-gated", () => {
	for (const header of [
		"x-clankermux-auto-refresh",
		"x-clankermux-keepalive",
	]) {
		it(`SPOOF GUARD: records an EXTERNAL request carrying ${header}`, () => {
			expect(
				shouldRecordRequest(
					makeInput({
						internal: false,
						getHeader: headersAccessor({ [header]: "true" }),
					}),
				),
			).toBe(true);
		});

		it(`records when internal is omitted entirely and ${header} is set (safe default)`, () => {
			expect(
				shouldRecordRequest({
					method: "POST",
					path: "/v1/messages",
					providerName: "anthropic",
					responseStatus: 200,
					getHeader: headersAccessor({ [header]: "true" }),
				}),
			).toBe(true);
		});
	}

	it("count_tokens and .well-known filters are NOT trust-gated (they are not privileges)", () => {
		expect(
			shouldRecordRequest(
				makeInput({
					internal: false,
					providerName: "codex",
					path: "/v1/messages/count_tokens",
				}),
			),
		).toBe(false);
		expect(
			shouldRecordRequest(
				makeInput({
					internal: false,
					method: "GET",
					path: "/.well-known/oauth-authorization-server",
					responseStatus: 404,
				}),
			),
		).toBe(false);
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

// ---------------------------------------------------------------------------
// Ingress-time gate
// ---------------------------------------------------------------------------

/**
 * `isIngressRecordable` runs BEFORE an account (and therefore a provider) has
 * been chosen and before any response exists, so it can only apply the
 * status-independent, provider-independent rules. It gates the dashboard's
 * ingress event; anything it lets through that `shouldRecordRequest` later
 * rejects is settled by an `ingress-end` and discarded client-side.
 */
describe("isIngressRecordable", () => {
	const ingressInput = (
		over: Partial<IsIngressRecordableInput> = {},
	): IsIngressRecordableInput => ({
		method: "POST",
		path: "/v1/messages",
		getHeader: headersAccessor(),
		...over,
	});

	it("admits normal client traffic", () => {
		expect(isIngressRecordable(ingressInput())).toBe(true);
	});

	it("rejects internal auto-refresh probes", () => {
		expect(
			isIngressRecordable(
				ingressInput({
					internal: true,
					getHeader: headersAccessor({ "x-clankermux-auto-refresh": "true" }),
				}),
			),
		).toBe(false);
	});

	it("rejects internal cache-keepalive replays", () => {
		expect(
			isIngressRecordable(
				ingressInput({
					internal: true,
					getHeader: objectAccessor({ "x-clankermux-keepalive": "true" }),
				}),
			),
		).toBe(false);
	});

	it("does not honour probe markers from a non-internal caller", () => {
		// Same trust gate as shouldRecordRequest: the markers are plain headers,
		// so a client must not be able to hide itself from the dashboard.
		expect(
			isIngressRecordable(
				ingressInput({
					internal: false,
					getHeader: headersAccessor({ "x-clankermux-auto-refresh": "true" }),
				}),
			),
		).toBe(true);
	});

	it("rejects the whole .well-known prefix, not just 404s", () => {
		// The recording gate can only skip .well-known 404s because it knows the
		// status. At ingress there is no status yet, so the prefix is skipped
		// wholesale rather than emitting marks that almost always turn out to be
		// 404s and then have to be retracted.
		expect(isIngressRecordable(ingressInput({ path: "/.well-known/foo" }))).toBe(
			false,
		);
	});

	it("still records a .well-known 200 in shouldRecordRequest", () => {
		// Guards the asymmetry above: the ingress gate's broader prefix rule must
		// NOT leak into the recording gate, which would newly drop these rows
		// from Request History.
		expect(
			shouldRecordRequest(
				makeInput({ path: "/.well-known/foo", responseStatus: 200 }),
			),
		).toBe(true);
	});
});
