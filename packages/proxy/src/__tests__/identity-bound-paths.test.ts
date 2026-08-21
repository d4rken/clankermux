/**
 * Unit tests for the identity-bound endpoint refusal.
 *
 * These endpoints belong to ONE Anthropic OAuth identity: a file belongs to the
 * account that uploaded it, and the Remote Control surface is bound to the
 * paired claude.ai session. Serving any of them with a pooled account token
 * would make Anthropic observe account A's credential reading account B's data
 * — a cross-account access pattern no unmodified CLI produces. The refusal is
 * deliberate, so its shape is pinned here rather than left to whatever generic
 * 404 the router happens to emit.
 */

import { describe, expect, it } from "bun:test";
import {
	createIdentityBoundRefusalResponse,
	IDENTITY_BOUND_PATH_PREFIXES,
	isIdentityBoundPath,
} from "../identity-bound-paths";

describe("isIdentityBoundPath", () => {
	for (const path of [
		// Namespace roots themselves, not just their children.
		"/api/oauth/files",
		"/v1/code",
		"/api/oauth/files/",
		"/api/oauth/files/abc123",
		"/api/oauth/file_upload",
		"/v1/code/",
		"/v1/code/sessions",
		"/v1/code/auth/refresh",
		"/v1/code/runners/self-hosted/register",
	]) {
		it(`matches ${path}`, () => {
			expect(isIdentityBoundPath(path)).toBe(true);
		});
	}

	for (const path of [
		"/v1/messages",
		"/v1/messages/count_tokens",
		"/v1/models",
		"/api/oauth/usage",
		"/api/oauth/profile",
		"/api/event_logging/batch",
		"/api/system/package-manager",
	]) {
		it(`does not match ${path}`, () => {
			expect(isIdentityBoundPath(path)).toBe(false);
		});
	}

	// `/api/oauth/file_upload` is matched as an exact path, so a longer path that
	// merely shares those bytes must not be swept in.
	it("does not match a path that only shares a prefix with file_upload", () => {
		expect(isIdentityBoundPath("/api/oauth/file_uploads_report")).toBe(false);
	});

	// A namespace root must match itself and its children, never a same-stem
	// neighbour — `/v1/codex/*` is a different namespace that has to keep working.
	it("does not match same-stem neighbours", () => {
		expect(isIdentityBoundPath("/v1/codex")).toBe(false);
		expect(isIdentityBoundPath("/v1/codex/responses")).toBe(false);
		expect(isIdentityBoundPath("/api/oauth/filestore")).toBe(false);
	});

	// `URL` normalizes dot-segments but leaves percent-escapes intact, so these
	// arrive looking like ordinary `/v1/…` proxy paths. If the raw form alone
	// were checked they would be forwarded upstream on a pooled token, and
	// whether Anthropic's edge decodes them is not ours to assume.
	describe("percent-encoded evasions", () => {
		for (const path of [
			"/v1/%63ode/sessions",
			"/v1/code%2Fsessions",
			"/api/oauth/files%2Fabc",
			"/api/oauth/%66ile_upload",
			"/%76%31/code/sessions",
		]) {
			it(`matches ${path}`, () => {
				expect(isIdentityBoundPath(path)).toBe(true);
			});
		}

		it("still does not match an encoded same-stem neighbour", () => {
			expect(isIdentityBoundPath("/v1/%63odex/responses")).toBe(false);
		});

		// A single decode is not enough: %2563 -> %63 -> c. Some hop between us
		// and Anthropic may decode more than once, and the guarantee is about
		// what we send, so every reading that resolves to one of these is refused.
		for (const path of ["/v1/%2563ode/sessions", "/v1/code%252Fsessions"]) {
			it(`matches double-encoded ${path}`, () => {
				expect(isIdentityBoundPath(path)).toBe(true);
			});
		}
	});

	describe("normalization evasions", () => {
		for (const path of [
			// Dot-segments reintroduced by decoding, after URL already resolved its own.
			"/v1/foo%2F..%2Fcode/sessions",
			// Repeated separators, commonly collapsed upstream.
			"/v1//code/sessions",
			"//v1/code/sessions",
			// Backslash as a separator.
			"/v1\\code\\sessions",
			// Trailing slash on an exact-match path.
			"/api/oauth/file_upload/",
			"/api/oauth/file_upload/.",
		]) {
			it(`matches ${JSON.stringify(path)}`, () => {
				expect(isIdentityBoundPath(path)).toBe(true);
			});
		}

		it("leaves ordinary paths alone through the same normalization", () => {
			expect(isIdentityBoundPath("/v1//messages")).toBe(false);
			expect(isIdentityBoundPath("/v1/codex//responses")).toBe(false);
			expect(isIdentityBoundPath("/v1/messages/../models")).toBe(false);
		});

		// A bounded decode loop: a long %25 chain must terminate, not spin.
		it("terminates on a deep percent-encoding chain", () => {
			const deep = `/v1/${"%25".repeat(40)}63ode/sessions`;
			expect(() => isIdentityBoundPath(deep)).not.toThrow();
		});

		// Undecodable input cannot be a legitimate request for these endpoints
		// either; it falls through to the normal 404/400 rather than throwing.
		it("does not throw on malformed escapes", () => {
			expect(() => isIdentityBoundPath("/v1/%zz/code")).not.toThrow();
			expect(isIdentityBoundPath("/v1/%")).toBe(false);
		});
	});

	it("matches every exported namespace root and its children", () => {
		expect(IDENTITY_BOUND_PATH_PREFIXES.length).toBeGreaterThan(0);
		for (const root of IDENTITY_BOUND_PATH_PREFIXES) {
			expect(isIdentityBoundPath(root)).toBe(true);
			expect(isIdentityBoundPath(`${root}/anything`)).toBe(true);
			expect(isIdentityBoundPath(`${root}-neighbour`)).toBe(false);
		}
	});
});

describe("createIdentityBoundRefusalResponse", () => {
	it("refuses with 501 and the Anthropic error envelope", async () => {
		const response = createIdentityBoundRefusalResponse("/v1/code/sessions");

		expect(response.status).toBe(501);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(response.headers.get("x-clankermux-refusal")).toBe(
			"identity-bound-endpoint",
		);

		const body = (await response.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("proxy_error");
		expect(body.error.message).toContain("/v1/code/sessions");
	});

	// 403 is what Claude Code reads as a dead session — it answers with a
	// re-login prompt. 404 is indistinguishable from an unrouted URL. Neither
	// may be used for a refusal that is a deliberate policy decision.
	it("uses neither 403 nor 404", () => {
		const status =
			createIdentityBoundRefusalResponse("/api/oauth/files/x").status;
		expect(status).not.toBe(403);
		expect(status).not.toBe(404);
	});
});
