import { describe, expect, it } from "bun:test";
import {
	sanitizeProxyHeaders,
	sanitizeRequestHeaders,
	sanitizeResponseHeadersForStorage,
	stripHopByHopHeaders,
} from "../headers";

/**
 * Credentials and identifiers neither storage sanitizer may keep. Asserted
 * against BOTH so the two lists cannot drift: the response side once had no
 * sanitizer at all, and the request side has never stripped the Codex
 * continuity identifiers.
 */
const MUST_NEVER_BE_STORED: Record<string, string> = {
	authorization: "Bearer secret",
	"proxy-authorization": "Basic Zm9v",
	"x-api-key": "sk-secret",
	cookie: "sid=abc",
	"set-cookie": "sid=abc; HttpOnly",
	"x-claude-code-session-id": "ccs_1",
	"thread-id": "thr_1",
	"session-id": "sess_1",
	session_id: "raw-session",
	"x-client-request-id": "crid_1",
	"x-codex-installation-id": "inst_1",
	"x-codex-window-id": "win_1",
	"x-codex-turn-state": "ts_1",
	"x-codex-session-id": "sess_abc",
	"x-codex-conversation-id": "conv_abc",
	"chatgpt-account-id": "acct_1",
	traceparent: "00-a-b-01",
	tracestate: "vendor=1",
};

describe("stripHopByHopHeaders", () => {
	it("removes the RFC 9110 hop-by-hop set", () => {
		const h = new Headers({
			connection: "close",
			"keep-alive": "timeout=5",
			"proxy-connection": "keep-alive",
			te: "trailers",
			trailer: "Expires",
			"transfer-encoding": "chunked",
			upgrade: "h2c",
			"proxy-authenticate": "Basic",
			"proxy-authorization": "Basic Zm9v",
			"content-type": "application/json",
			authorization: "Bearer keep-me",
		});
		stripHopByHopHeaders(h);
		for (const name of [
			"connection",
			"keep-alive",
			"proxy-connection",
			"te",
			"trailer",
			"transfer-encoding",
			"upgrade",
			"proxy-authenticate",
			"proxy-authorization",
		]) {
			expect(h.has(name)).toBe(false);
		}
		// End-to-end headers survive
		expect(h.get("content-type")).toBe("application/json");
		expect(h.get("authorization")).toBe("Bearer keep-me");
	});

	it("removes headers NAMED by the Connection header (connection options)", () => {
		const h = new Headers({
			connection: "close, X-Custom-Hop , another-hop",
			"x-custom-hop": "value",
			"another-hop": "value",
			"x-unrelated": "stays",
		});
		stripHopByHopHeaders(h);
		expect(h.has("connection")).toBe(false);
		expect(h.has("x-custom-hop")).toBe(false);
		expect(h.has("another-hop")).toBe(false);
		expect(h.get("x-unrelated")).toBe("stays");
	});

	it("is a no-op on headers without any hop-by-hop entries", () => {
		const h = new Headers({
			"content-type": "text/event-stream",
			accept: "text/event-stream",
		});
		stripHopByHopHeaders(h);
		expect(h.get("content-type")).toBe("text/event-stream");
		expect(h.get("accept")).toBe("text/event-stream");
	});

	it("does not throw on a malformed Connection token and still strips the rest", () => {
		// `Headers.delete("bad name")` throws — a malformed client value must not
		// become an uncontrolled proxy failure.
		const h = new Headers({
			connection: "close, bad name, x-real-hop",
			"x-real-hop": "value",
			"content-type": "application/json",
		});
		expect(() => stripHopByHopHeaders(h)).not.toThrow();
		expect(h.has("connection")).toBe(false);
		expect(h.has("x-real-hop")).toBe(false);
		expect(h.get("content-type")).toBe("application/json");
	});

	it("a hostile Connection header cannot delete end-to-end credential fields", () => {
		// RFC 9110 forbids naming end-to-end fields in Connection; at the outbound
		// chokepoint authorization/cookie may already be PROXY-generated.
		const h = new Headers({
			connection: "authorization, cookie, host",
			authorization: "Bearer proxy-token",
			cookie: "cf=jar",
		});
		stripHopByHopHeaders(h);
		expect(h.has("connection")).toBe(false);
		expect(h.get("authorization")).toBe("Bearer proxy-token");
		expect(h.get("cookie")).toBe("cf=jar");
	});

	it("the codex_cli_rs shape: `connection: close` no longer reaches upstream", () => {
		// The observed incident vector: the Codex CLI sends `connection: close` on
		// every request; forwarding it upstream invites an abrupt post-response
		// connection close.
		const h = new Headers({
			connection: "close",
			accept: "text/event-stream",
			originator: "codex_cli_rs",
		});
		stripHopByHopHeaders(h);
		expect(h.has("connection")).toBe(false);
		expect(h.get("originator")).toBe("codex_cli_rs");
	});
});

describe("sanitizeProxyHeaders", () => {
	it("still strips the decompression trio", () => {
		const h = sanitizeProxyHeaders(
			new Headers({
				"content-encoding": "gzip",
				"content-length": "123",
				"transfer-encoding": "chunked",
				"content-type": "application/json",
			}),
		);
		expect(h.has("content-encoding")).toBe(false);
		expect(h.has("content-length")).toBe(false);
		expect(h.has("transfer-encoding")).toBe(false);
		expect(h.get("content-type")).toBe("application/json");
	});

	it("also strips hop-by-hop response headers (connection, keep-alive, upgrade)", () => {
		const h = sanitizeProxyHeaders(
			new Headers({
				connection: "keep-alive",
				"keep-alive": "timeout=5",
				upgrade: "h2c",
				"content-type": "application/json",
			}),
		);
		expect(h.has("connection")).toBe(false);
		expect(h.has("keep-alive")).toBe(false);
		expect(h.has("upgrade")).toBe(false);
		expect(h.get("content-type")).toBe("application/json");
	});
});

it("keeps adapter model metadata internal while preserving public response headers", () => {
	const original = new Headers({
		"x-clankermux-resolved-model": "gpt-6-astra",
		"x-request-id": "upstream-id",
		"content-type": "text/event-stream",
	});
	const sanitized = sanitizeProxyHeaders(original);
	expect(sanitized.has("x-clankermux-resolved-model")).toBe(false);
	expect(sanitized.get("x-request-id")).toBe("upstream-id");
	expect(sanitized.get("content-type")).toBe("text/event-stream");
	expect(original.get("x-clankermux-resolved-model")).toBe("gpt-6-astra");
});

describe("storage sanitizers: shared identity denylist", () => {
	for (const [name, value] of Object.entries(MUST_NEVER_BE_STORED)) {
		it(`drops ${name} from stored request headers`, () => {
			const h = sanitizeRequestHeaders(
				new Headers({ [name]: value, "content-type": "application/json" }),
			);
			expect(h.get(name)).toBeNull();
			expect(h.get("content-type")).toBe("application/json");
		});

		it(`drops ${name} from stored response headers`, () => {
			const h = sanitizeResponseHeadersForStorage(
				new Headers({ [name]: value, "content-type": "application/json" }),
			);
			expect(h.get(name)).toBeNull();
			expect(h.get("content-type")).toBe("application/json");
		});
	}

	// The Codex provider forwards these upstream deliberately (turn continuity);
	// the sanitizers are storage-only, so stripping them here must not be
	// mistaken for dropping them from the proxied request.
	it("leaves the caller's Headers untouched", () => {
		const original = new Headers({ "x-codex-session-id": "sess_abc" });
		sanitizeRequestHeaders(original);
		sanitizeResponseHeadersForStorage(original);
		expect(original.get("x-codex-session-id")).toBe("sess_abc");
	});

	// Accounting and routing read these back off the stored envelope.
	it("keeps the headers the usage and credits parsers read", () => {
		const kept = {
			"anthropic-ratelimit-unified-5h-utilization": "0.42",
			"anthropic-ratelimit-unified-overage-status": "off",
			"x-codex-credits-has-credits": "true",
			"x-codex-plan-type": "pro",
			"x-codex-secondary-used-percent": "12",
			"x-codex-primary-used-percent": "34",
		};
		const h = sanitizeResponseHeadersForStorage(new Headers(kept));
		for (const [name, value] of Object.entries(kept)) {
			expect(h.get(name)).toBe(value);
		}
	});
});

describe("sanitizeResponseHeadersForStorage", () => {
	it("strips session-bearing response headers", () => {
		const h = sanitizeResponseHeadersForStorage(
			new Headers({
				"set-cookie": "sid=abc; HttpOnly",
				"x-codex-turn-state": "opaque-turn-blob",
				"chatgpt-account-id": "acct_123",
				"content-type": "application/json",
			}),
		);
		expect(h.get("set-cookie")).toBeNull();
		expect(h.get("x-codex-turn-state")).toBeNull();
		expect(h.get("chatgpt-account-id")).toBeNull();
		expect(h.get("content-type")).toBe("application/json");
	});

	it("strips the high-volume keys that carry no analytic signal", () => {
		const h = sanitizeResponseHeadersForStorage(
			new Headers({
				"report-to": '{"group":"cf-nel","endpoints":[{"url":"https://x"}]}',
				traceresponse: "00-abc-def-01",
				"cf-ray": "9a1b2c3d4e5f-FRA",
				nel: '{"report_to":"cf-nel"}',
			}),
		);
		for (const name of ["report-to", "traceresponse", "cf-ray", "nel"]) {
			expect(h.get(name)).toBeNull();
		}
	});

	it("keeps the rate-limit family intact", () => {
		const h = sanitizeResponseHeadersForStorage(
			new Headers({
				"anthropic-ratelimit-unified-5h-utilization": "0.42",
				"anthropic-ratelimit-unified-7d-reset": "1758000000",
				"anthropic-ratelimit-unified-status": "allowed",
				"retry-after": "30",
			}),
		);
		expect(h.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.42");
		expect(h.get("anthropic-ratelimit-unified-7d-reset")).toBe("1758000000");
		expect(h.get("anthropic-ratelimit-unified-status")).toBe("allowed");
		expect(h.get("retry-after")).toBe("30");
	});

	it("does not mutate the caller's Headers", () => {
		const original = new Headers({ "set-cookie": "sid=abc" });
		sanitizeResponseHeadersForStorage(original);
		expect(original.get("set-cookie")).toBe("sid=abc");
	});
});
