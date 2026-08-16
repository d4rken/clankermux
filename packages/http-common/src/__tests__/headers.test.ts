import { describe, expect, it } from "bun:test";
import { sanitizeProxyHeaders, stripHopByHopHeaders } from "../headers";

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
