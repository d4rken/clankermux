import { describe, expect, it } from "bun:test";
import { CODEX_USER_AGENT } from "../client-identity";
import { CodexProvider } from "../provider";

const provider = new CodexProvider();

describe("CodexProvider.prepareHeaders — header allowlist", () => {
	it("drops every x-stainless-* header regardless of suffix", () => {
		const headers = new Headers({
			"x-stainless-arch": "x64",
			"x-stainless-lang": "js",
			"x-stainless-os": "Linux",
			"x-stainless-package-version": "0.60.0",
			"x-stainless-retry-count": "0",
			"x-stainless-runtime": "node",
			"x-stainless-runtime-version": "v24.9.0",
			"x-stainless-timeout": "600",
			"x-stainless-not-a-real-header-yet": "1",
		});

		const prepared = provider.prepareHeaders(headers, "token");

		for (const [name] of headers) {
			expect(prepared.get(name)).toBeNull();
		}
	});

	it("drops the five x-openai-client-* SDK identity headers", () => {
		const headers = new Headers({
			"x-openai-client-version": "1.2.3",
			"x-openai-client-os": "Linux",
			"x-openai-client-arch": "x64",
			"x-openai-client-id": "some-client",
			"x-openai-client-user-agent": '{"lang":"js"}',
		});

		const prepared = provider.prepareHeaders(headers, "token");

		for (const [name] of headers) {
			expect(prepared.get(name)).toBeNull();
		}
	});

	it("keeps the Codex continuity headers by exact name, not by prefix", () => {
		// The native passthrough carries the Codex CLI's own turn and thread
		// state; names the real client does not send are dropped with everything
		// else that is not allowlisted.
		const headers = new Headers({
			"x-codex-turn-state": "ts_abc",
			"x-codex-window-id": "thread:0",
			"x-codex-session-id": "sess_abc",
			"x-codex-installation-id": "inst_abc",
			"session-id": "session",
			"thread-id": "thread",
			session_id: "raw-session",
		});

		const prepared = provider.prepareHeaders(headers, "token");

		expect(prepared.get("x-codex-turn-state")).toBe("ts_abc");
		expect(prepared.get("x-codex-window-id")).toBe("thread:0");
		expect(prepared.get("session-id")).toBe("session");
		expect(prepared.get("thread-id")).toBe("thread");
		expect(prepared.get("x-codex-session-id")).toBeNull();
		expect(prepared.get("x-codex-installation-id")).toBeNull();
		expect(prepared.get("session_id")).toBeNull();
	});

	it("keeps the x-openai-* headers the Codex client sends", () => {
		const headers = new Headers({
			"x-openai-internal-codex-responses-lite": "1",
			"x-openai-subagent": "review",
		});

		const prepared = provider.prepareHeaders(headers, "token");

		expect(prepared.get("x-openai-internal-codex-responses-lite")).toBe("1");
		expect(prepared.get("x-openai-subagent")).toBe("review");
	});

	it("applies the codex_exec persona", () => {
		const prepared = provider.prepareHeaders(
			new Headers({ "x-stainless-lang": "js" }),
			"token",
		);

		expect(prepared.get("user-agent")).toBe(CODEX_USER_AGENT);
		expect(prepared.get("originator")).toBe("codex_exec");
		expect(prepared.get("authorization")).toBe("Bearer token");
	});

	it("overwrites a non-Codex client's originator rather than forwarding it", () => {
		const prepared = provider.prepareHeaders(
			new Headers({ originator: "some_sdk", "user-agent": "some-sdk/1.0" }),
			"token",
		);

		expect(prepared.get("originator")).toBe("codex_exec");
		expect(prepared.get("user-agent")).toBe(CODEX_USER_AGENT);
	});
});
