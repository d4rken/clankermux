import { describe, expect, it } from "bun:test";
import {
	applyCodexSessionIdHeader,
	CODEX_CLIENT_ID,
	CODEX_ORIGINATOR,
	CODEX_USER_AGENT,
	CODEX_VERSION,
	codexAuthorizeUrlParams,
	codexInferenceHeaders,
	codexSideCallHeaders,
	codexUserAgent,
} from "../client-identity";

describe("codexUserAgent", () => {
	it("defaults to the pinned version and platform", () => {
		expect(codexUserAgent()).toBe(CODEX_USER_AGENT);
		expect(CODEX_USER_AGENT).toStartWith(`codex-cli/${CODEX_VERSION} (`);
	});

	it("formats an explicit version and platform", () => {
		expect(codexUserAgent("1.2.3", "Linux 6.12; x86_64")).toBe(
			"codex-cli/1.2.3 (Linux 6.12; x86_64)",
		);
	});
});

describe("codexInferenceHeaders", () => {
	it("overrides a client's own Codex identity", () => {
		const out = codexInferenceHeaders(
			new Headers({
				originator: "codex-tui",
				"user-agent": "codex-tui/9.9.9",
				version: "9.9.9",
			}),
		);
		expect(out.get("originator")).toBe(CODEX_ORIGINATOR);
		expect(out.get("user-agent")).toBe(CODEX_USER_AGENT);
		expect(out.get("version")).toBe(CODEX_VERSION);
	});

	it("leaves the inbound Headers untouched", () => {
		const inbound = new Headers({ "x-api-key": "k", "x-stainless-os": "L" });
		codexInferenceHeaders(inbound, "token");
		expect(inbound.get("x-api-key")).toBe("k");
		expect(inbound.get("x-stainless-os")).toBe("L");
		expect(inbound.get("authorization")).toBeNull();
	});
});

describe("codexSideCallHeaders", () => {
	it("omits ChatGPT-Account-ID for null, undefined and empty", () => {
		for (const id of [null, undefined, ""]) {
			expect(codexSideCallHeaders("t", id).has("chatgpt-account-id")).toBe(
				false,
			);
		}
	});

	it("does not trim the account id itself", () => {
		expect(codexSideCallHeaders("t", " id").get("chatgpt-account-id")).toBe(
			" id",
		);
	});
});

describe("applyCodexSessionIdHeader", () => {
	it("keeps a usable client session-id", () => {
		const headers = new Headers({ "session-id": "client" });
		applyCodexSessionIdHeader(headers, "derived");
		expect(headers.get("session-id")).toBe("client");
	});

	it("replaces an unusable client session-id with the trimmed key", () => {
		const headers = new Headers({ "session-id": " " });
		applyCodexSessionIdHeader(headers, "  derived  ");
		expect(headers.get("session-id")).toBe("derived");
	});

	it("deletes an unusable session-id when the key is unusable too", () => {
		const headers = new Headers({ "session-id": "é" });
		applyCodexSessionIdHeader(headers, 42);
		expect(headers.has("session-id")).toBe(false);
	});
});

describe("codexAuthorizeUrlParams", () => {
	it("ends with the originator", () => {
		expect(codexAuthorizeUrlParams().at(-1)).toBe(
			`originator=${CODEX_ORIGINATOR}`,
		);
	});

	it("does not carry the client id, which comes from the OAuth config", () => {
		expect(codexAuthorizeUrlParams().join("&")).not.toContain(CODEX_CLIENT_ID);
	});
});
