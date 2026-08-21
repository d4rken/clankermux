import { describe, expect, it } from "bun:test";
import { CODEX_USER_AGENT, CodexProvider } from "../provider";

const provider = new CodexProvider();

describe("CodexProvider.prepareHeaders — SDK fingerprint stripping", () => {
	it("strips every x-stainless-* header regardless of suffix", () => {
		// The suffix set is open-ended and versioned by the SDK generator, so the
		// strip has to be by prefix. These are the ones our own Anthropic prime
		// emits (auto-refresh-scheduler.ts), plus an invented one to prove the
		// rule is not an enumeration of known names.
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

	it("strips the five x-openai-client-* SDK identity headers", () => {
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

	it("keeps x-codex-* continuity headers — they are what the backend needs", () => {
		// The strip must be an exact/prefix denylist, never a blanket x-openai-
		// or x-* sweep: the native passthrough path carries the Codex CLI's own
		// continuity headers and dropping them would break turn continuity.
		const headers = new Headers({
			"x-codex-turn-state": "ts_abc",
			"x-codex-session-id": "sess_abc",
			"x-codex-conversation-id": "conv_abc",
			"x-codex-installation-id": "inst_abc",
			session_id: "raw-session",
			"content-type": "application/json",
		});

		const prepared = provider.prepareHeaders(headers, "token");

		expect(prepared.get("x-codex-turn-state")).toBe("ts_abc");
		expect(prepared.get("x-codex-session-id")).toBe("sess_abc");
		expect(prepared.get("x-codex-conversation-id")).toBe("conv_abc");
		expect(prepared.get("x-codex-installation-id")).toBe("inst_abc");
		expect(prepared.get("session_id")).toBe("raw-session");
		expect(prepared.get("content-type")).toBe("application/json");
	});

	it("keeps non-identity x-openai-* headers the Codex backend defines", () => {
		// `x-openai-client-*` is the SDK identity family; other `x-openai-*`
		// headers are Codex protocol surface and must survive.
		const headers = new Headers({
			"x-openai-internal-codex-responses-lite": "1",
			"x-openai-subagent": "review",
		});

		const prepared = provider.prepareHeaders(headers, "token");

		expect(prepared.get("x-openai-internal-codex-responses-lite")).toBe("1");
		expect(prepared.get("x-openai-subagent")).toBe("review");
	});

	it("still applies the Codex CLI persona after stripping", () => {
		const prepared = provider.prepareHeaders(
			new Headers({ "x-stainless-lang": "js" }),
			"token",
		);

		expect(prepared.get("user-agent")).toBe(CODEX_USER_AGENT);
		expect(prepared.get("originator")).toBe("codex_cli_rs");
		expect(prepared.get("authorization")).toBe("Bearer token");
	});

	it("overwrites a client-supplied originator rather than forwarding it", () => {
		// A downstream SDK that sets its own originator would otherwise contradict
		// the User-Agent we set, which is the same mismatch the strip exists to
		// remove.
		const prepared = provider.prepareHeaders(
			new Headers({ originator: "some_sdk", "user-agent": "some-sdk/1.0" }),
			"token",
		);

		expect(prepared.get("originator")).toBe("codex_cli_rs");
		expect(prepared.get("user-agent")).toBe(CODEX_USER_AGENT);
	});
});
