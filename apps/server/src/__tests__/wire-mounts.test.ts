/**
 * The agent-traffic mounts: classification and the per-dialect route gate.
 *
 * Two properties carry the weight here.
 *
 * Classification must be SEGMENT-BOUNDED. Everything downstream of the strip
 * — some forty exact-match path predicates in the proxy — assumes it is looking
 * at a canonical root-relative path. A mount that matched a same-stem
 * neighbour (`/wire/anthropicevil`) would push a path nobody classified into
 * that pipeline, and none of those predicates would say so out loud; they would
 * simply stop matching.
 *
 * The gate must survive NORMALIZATION. `/v1/responses` is OpenAI-only, and the
 * Anthropic mount forwards blindly by design, so the denylist is the only thing
 * standing between an OpenAI-shaped body and a Claude account. An `===`
 * comparison against a raw pathname is defeated by a trailing slash or a
 * percent-encoded letter, so the gate compares canonical forms.
 */

import { describe, expect, it } from "bun:test";
import { isDialectAllowed, matchWireMount, WIRE_MOUNTS } from "../wire-mounts";

describe("matchWireMount", () => {
	it("mounts both dialects and hands back the logical path", () => {
		expect(matchWireMount("/wire/anthropic/v1/messages")).toEqual({
			kind: "mounted",
			dialect: "anthropic",
			logicalPath: "/v1/messages",
		});
		expect(matchWireMount("/wire/openai/v1/responses")).toEqual({
			kind: "mounted",
			dialect: "openai",
			logicalPath: "/v1/responses",
		});
	});

	it("keeps a deep path intact, including its own encoded bytes", () => {
		expect(
			matchWireMount("/wire/anthropic/api/event_logging/v2/batch"),
		).toEqual({
			kind: "mounted",
			dialect: "anthropic",
			logicalPath: "/api/event_logging/v2/batch",
		});
		// The mount match is literal; nothing below it is decoded on the way
		// through, so the identity-bound refusal still sees what the client sent.
		expect(matchWireMount("/wire/anthropic/v1/%63ode/sessions")).toEqual({
			kind: "mounted",
			dialect: "anthropic",
			logicalPath: "/v1/%63ode/sessions",
		});
	});

	it("gives a bare mount the root logical path", () => {
		for (const pathname of [
			"/wire/anthropic",
			"/wire/anthropic/",
			"/wire/openai",
			"/wire/openai/",
		]) {
			const match = matchWireMount(pathname);
			expect(match.kind).toBe("mounted");
			if (match.kind !== "mounted") throw new Error("unreachable");
			expect(match.logicalPath).toBe("/");
		}
	});

	// The whole `/wire` namespace is ours. A client that lands anywhere in it
	// without hitting a dialect has misconfigured its base URL, and must be told
	// so — not handed the dashboard's index.html, which is what an unclassified
	// path gets at root.
	it("reserves the namespace root and unknown dialects", () => {
		for (const pathname of [
			"/wire",
			"/wire/",
			"/wire/gemini",
			"/wire/gemini/v1/models",
			"/wire/anthropicevil",
			"/wire/ANTHROPIC/v1/messages",
			"/wire/%61nthropic/v1/messages",
		]) {
			expect(matchWireMount(pathname)).toEqual({ kind: "reserved" });
		}
	});

	// Segment boundaries, from the other side: a path that merely starts with
	// the same bytes is not in the namespace at all and must reach the legacy
	// root flow untouched.
	it("does not claim same-stem neighbours of the namespace root", () => {
		for (const pathname of [
			"/wireanthropic",
			"/wireless",
			"/wire-tap/v1/messages",
			"/v1/messages",
			"/api/system/status",
			"/",
		]) {
			expect(matchWireMount(pathname)).toEqual({ kind: "unmounted" });
		}
	});

	it("exposes the mount prefixes it matches", () => {
		expect(WIRE_MOUNTS.anthropic).toBe("/wire/anthropic");
		expect(WIRE_MOUNTS.openai).toBe("/wire/openai");
		for (const [dialect, mount] of Object.entries(WIRE_MOUNTS)) {
			const match = matchWireMount(`${mount}/v1/thing`);
			expect(match).toEqual({
				kind: "mounted",
				// biome-ignore lint/suspicious/noExplicitAny: table-driven over the map
				dialect: dialect as any,
				logicalPath: "/v1/thing",
			});
		}
	});
});

describe("isDialectAllowed: openai is a strict allowlist", () => {
	it("admits exactly the three routes the mount can serve", () => {
		expect(isDialectAllowed("openai", "POST", "/v1/responses")).toBe(true);
		expect(isDialectAllowed("openai", "POST", "/v1/responses/compact")).toBe(
			true,
		);
		expect(isDialectAllowed("openai", "GET", "/v1/models")).toBe(true);
	});

	// Anything else would enter a pipeline whose Anthropic provider accepts
	// EVERY path, where an OpenAI-compatible account applies an
	// Anthropic→OpenAI body conversion — so a blind-forwarded
	// `/v1/chat/completions` could reach a Claude account, or have an
	// already-OpenAI body mistransformed. Blind forwarding is not available here.
	it("refuses everything else, including Anthropic's own routes", () => {
		for (const [method, path] of [
			["POST", "/v1/messages"],
			["POST", "/v1/messages/count_tokens"],
			["POST", "/v1/chat/completions"],
			["POST", "/v1/completions"],
			["POST", "/api/event_logging/v2/batch"],
			["GET", "/v1/responses"],
			["POST", "/v1/models"],
			["GET", "/"],
			["POST", "/v1/responses/compact/extra"],
		] as const) {
			expect(isDialectAllowed("openai", method, path)).toBe(false);
		}
	});

	it("matches the method case-insensitively", () => {
		expect(isDialectAllowed("openai", "post", "/v1/responses")).toBe(true);
		expect(isDialectAllowed("openai", "get", "/v1/models")).toBe(true);
	});
});

describe("isDialectAllowed: anthropic forwards blindly, minus the OpenAI routes", () => {
	// The forward-compatibility prize: a path Anthropic ships tomorrow reaches
	// them instead of collecting our 404. `/api/event_logging/v2/batch` is the
	// live instance — Claude Code 2.1.241 posts telemetry there.
	it("admits paths we have never heard of", () => {
		for (const [method, path] of [
			["POST", "/v1/messages"],
			["POST", "/api/event_logging/v2/batch"],
			["POST", "/api/event_logging/v9/whatever"],
			["GET", "/api/oauth/usage"],
			["POST", "/api/system/package-manager"],
			["GET", "/v1/organizations/me"],
			["GET", "/"],
		] as const) {
			expect(isDialectAllowed("anthropic", method, path)).toBe(true);
		}
	});

	it("refuses the OpenAI-only routes", () => {
		expect(isDialectAllowed("anthropic", "POST", "/v1/responses")).toBe(false);
		expect(isDialectAllowed("anthropic", "POST", "/v1/responses/compact")).toBe(
			false,
		);
		// Any method: `/v1/responses` is not an Anthropic endpoint under any verb.
		expect(isDialectAllowed("anthropic", "GET", "/v1/responses")).toBe(false);
	});

	// `GET /v1/models` is answered locally, in OpenAI's list format, for Codex's
	// startup probe. Serving that under the Anthropic mount would hand a Claude
	// client a catalogue in the wrong shape for a request that should have gone
	// upstream.
	it("refuses GET /v1/models but forwards other verbs on it", () => {
		expect(isDialectAllowed("anthropic", "GET", "/v1/models")).toBe(false);
		expect(isDialectAllowed("anthropic", "POST", "/v1/models")).toBe(true);
	});
});

describe("isDialectAllowed normalizes before comparing", () => {
	// Each of these reads as `/v1/responses` to something. The Anthropic mount
	// forwards whatever it does not recognize, so a spelling that slips past the
	// denylist is not a 404 — it is an OpenAI-shaped request on a Claude account.
	for (const path of [
		"/v1/responses/",
		"/v1/%72esponses",
		"//v1/responses",
		"/v1/./responses",
		"/v1/foo/../responses",
		"/v1\\responses",
		"/v1/responses/.",
	]) {
		it(`refuses ${JSON.stringify(path)} under the anthropic mount`, () => {
			expect(isDialectAllowed("anthropic", "POST", path)).toBe(false);
		});
	}

	it("refuses normalized spellings of GET /v1/models under anthropic", () => {
		expect(isDialectAllowed("anthropic", "GET", "/v1/models/")).toBe(false);
		expect(isDialectAllowed("anthropic", "GET", "//v1/%6dodels")).toBe(false);
	});

	// The allowlist side refuses those same spellings instead of admitting them.
	// What the gate says yes to is dispatched VERBATIM, and every handler past
	// it matches its path with `===`, so admitting `/v1/responses/` would mean
	// the Responses adapter declines it and the request falls through to the
	// ordinary proxy — an OpenAI-shaped body on a pooled Claude account, the one
	// thing this mount exists to prevent. A visible 404 is the right answer.
	it("refuses unnormalized spellings under the openai mount too", () => {
		expect(isDialectAllowed("openai", "POST", "/v1/responses/")).toBe(false);
		expect(isDialectAllowed("openai", "POST", "/v1/%72esponses")).toBe(false);
		expect(isDialectAllowed("openai", "POST", "//v1/responses/compact")).toBe(
			false,
		);
	});

	it("does not sweep in same-stem neighbours through normalization", () => {
		expect(isDialectAllowed("anthropic", "POST", "/v1/responsesx")).toBe(true);
		expect(isDialectAllowed("anthropic", "POST", "/v1/responses-log")).toBe(
			true,
		);
		expect(isDialectAllowed("openai", "POST", "/v1/responsesx")).toBe(false);
	});

	it("does not throw on malformed escapes", () => {
		expect(() =>
			isDialectAllowed("anthropic", "POST", "/v1/%zz"),
		).not.toThrow();
		expect(() => isDialectAllowed("openai", "POST", "/v1/%")).not.toThrow();
	});
});
