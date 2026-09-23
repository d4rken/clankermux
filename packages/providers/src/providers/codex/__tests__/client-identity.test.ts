import { describe, expect, it } from "bun:test";
import {
	alignCodexClientUserAgent,
	applyCodexNativeProfile,
	applyCodexTranslatedProfile,
	CODEX_CLIENT_ID,
	CODEX_CLIENT_USER_AGENT_HEADER,
	CODEX_LOGIN_USER_AGENT,
	CODEX_USER_AGENT,
	codexAuthorizeUrlParams,
	codexBackendClientHeaders,
	codexInferenceHeaders,
} from "../client-identity";

describe("User-Agent constants", () => {
	it("match the real clients' format", () => {
		expect(CODEX_USER_AGENT).toBe(
			"codex_exec/0.155.1 (Debian 13.0.0; x86_64) xterm-256color (codex_exec; 0.155.1)",
		);
		expect(CODEX_LOGIN_USER_AGENT).toBe(
			"codex_cli_rs/0.155.1 (Debian 13.0.0; x86_64) xterm-256color",
		);
	});
});

describe("alignCodexClientUserAgent", () => {
	it("rewrites the build version in both places", () => {
		expect(
			alignCodexClientUserAgent(
				"codex_exec/0.160.0 (Debian 13.0.0; x86_64) xterm-256color (codex_exec; 0.160.0)",
				"codex_exec",
			),
		).toBe(CODEX_USER_AGENT);
	});

	it("keeps a trailing version that is not the build version", () => {
		expect(
			alignCodexClientUserAgent(
				"codex_vscode/0.160.0 (Windows 10.0.26100; x86_64) vscode/1.99.0 (codex_vscode; 26.5.1)",
				"codex_vscode",
			),
		).toBe(
			"codex_vscode/0.155.1 (Windows 10.0.26100; x86_64) vscode/1.99.0 (codex_vscode; 26.5.1)",
		);
	});

	it("accepts the desktop app's originator", () => {
		expect(
			alignCodexClientUserAgent(
				"Codex Desktop/0.160.0 (Mac OS 15.5.0; arm64) unknown",
				"Codex Desktop",
			),
		).toBe("Codex Desktop/0.155.1 (Mac OS 15.5.0; arm64) unknown");
	});

	it("rejects anything that is not a first-party Codex client", () => {
		const cases: Array<[string | null, string | null]> = [
			["codex-tui/0.160.0 (Mac OS 15.5.0; arm64)", null],
			[null, "codex-tui"],
			["pi/1.0 (linux)", "pi"],
			["codex-tui/0.160.0 (Mac OS 15.5.0; arm64)", "codex_exec"],
			["codex-tui/0.160.0", "codex-tui"],
			["codex-tui/ (Mac OS 15.5.0; arm64)", "codex-tui"],
		];
		for (const [userAgent, originator] of cases) {
			expect({
				userAgent,
				originator,
				aligned: alignCodexClientUserAgent(userAgent, originator),
			}).toEqual({ userAgent, originator, aligned: null });
		}
	});
});

describe("codexInferenceHeaders", () => {
	it("leaves the inbound Headers untouched", () => {
		const inbound = new Headers({ "x-api-key": "k", "x-stainless-os": "L" });
		codexInferenceHeaders(inbound, "token");
		expect(inbound.get("x-api-key")).toBe("k");
		expect(inbound.get("x-stainless-os")).toBe("L");
		expect(inbound.get("authorization")).toBeNull();
	});

	it("parks no persona for a client that names no originator", () => {
		const out = codexInferenceHeaders(
			new Headers({ "user-agent": "codex-tui/0.160.0 (Mac OS 15.5.0; arm64)" }),
		);
		expect(out.get(CODEX_CLIENT_USER_AGENT_HEADER)).toBeNull();
		expect(out.get("user-agent")).toBe(CODEX_USER_AGENT);
		expect(out.get("originator")).toBe("codex_exec");
	});
});

describe("applyCodexTranslatedProfile", () => {
	it("replaces the client's session headers with the derived id", () => {
		const headers = new Headers({
			"session-id": "client",
			"thread-id": "client-thread",
			"x-codex-turn-state": "ts",
			[CODEX_CLIENT_USER_AGENT_HEADER]: "codex-tui/0.155.1 (x)",
		});
		applyCodexTranslatedProfile(headers, "derived");
		expect([...headers.entries()]).toEqual([
			["originator", "codex_exec"],
			["session-id", "derived"],
			["thread-id", "derived"],
			["user-agent", CODEX_USER_AGENT],
			["x-client-request-id", "derived"],
		]);
	});

	it("sends no session headers without a usable id", () => {
		for (const id of [undefined, "", "  ", "é", 42]) {
			const headers = new Headers({ "session-id": "client" });
			applyCodexTranslatedProfile(headers, id);
			expect(headers.has("session-id")).toBe(false);
			expect(headers.has("thread-id")).toBe(false);
			expect(headers.has("x-client-request-id")).toBe(false);
		}
	});
});

describe("applyCodexNativeProfile", () => {
	it("keeps a usable client session-id", () => {
		const headers = new Headers({ "session-id": "client" });
		applyCodexNativeProfile(headers, "derived", true);
		expect(headers.get("session-id")).toBe("client");
	});

	it("replaces an unusable client session-id with the trimmed key", () => {
		const headers = new Headers({ "session-id": " " });
		applyCodexNativeProfile(headers, "  derived  ", true);
		expect(headers.get("session-id")).toBe("derived");
	});

	it("deletes an unusable session-id when the key is unusable too", () => {
		const headers = new Headers({ "session-id": "é" });
		applyCodexNativeProfile(headers, 42, true);
		expect(headers.has("session-id")).toBe(false);
	});

	it("derives nothing when told not to", () => {
		const headers = new Headers();
		applyCodexNativeProfile(headers, "derived", false);
		expect(headers.has("session-id")).toBe(false);
	});

	it("restores a parked Codex persona", () => {
		const headers = new Headers({
			[CODEX_CLIENT_USER_AGENT_HEADER]:
				"codex-tui/0.155.1 (Mac OS 15.5.0; arm64)",
		});
		applyCodexNativeProfile(headers, undefined, true);
		expect(headers.get("user-agent")).toBe(
			"codex-tui/0.155.1 (Mac OS 15.5.0; arm64)",
		);
		expect(headers.get("originator")).toBe("codex-tui");
		expect(headers.has(CODEX_CLIENT_USER_AGENT_HEADER)).toBe(false);
	});
});

describe("codexBackendClientHeaders", () => {
	it("omits ChatGPT-Account-ID for null, undefined and empty", () => {
		for (const id of [null, undefined, ""]) {
			expect(codexBackendClientHeaders("t", id).has("chatgpt-account-id")).toBe(
				false,
			);
		}
	});

	it("does not trim the account id itself", () => {
		expect(
			codexBackendClientHeaders("t", " id").get("chatgpt-account-id"),
		).toBe(" id");
	});
});

describe("codexAuthorizeUrlParams", () => {
	it("encodes every value", () => {
		expect(
			codexAuthorizeUrlParams({
				clientId: CODEX_CLIENT_ID,
				redirectUri: "http://localhost:1455/auth/callback",
				scopes: ["openid", "profile"],
				codeChallenge: "a+b",
				state: "s/1",
			}),
		).toEqual([
			"response_type=code",
			`client_id=${CODEX_CLIENT_ID}`,
			"redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
			"scope=openid%20profile",
			"code_challenge=a%2Bb",
			"code_challenge_method=S256",
			"id_token_add_organizations=true",
			"codex_cli_simplified_flow=true",
			"state=s%2F1",
			"originator=codex_cli_rs",
		]);
	});
});
