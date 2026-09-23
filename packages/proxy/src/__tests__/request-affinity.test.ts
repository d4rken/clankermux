import { describe, expect, it } from "bun:test";
import { extractRequestAffinity } from "../request-affinity";

describe("extractRequestAffinity", () => {
	it("uses Claude Code session id first", () => {
		const result = extractRequestAffinity(
			new Headers({
				"x-claude-code-session-id": " claude-session ",
				"thread-id": "codex-thread",
			}),
		);

		expect(result).toEqual({
			key: "claude-session",
			scope: "claude_session",
		});
	});

	// The session strategy joins a conversation key to a model with U+0000, so
	// a key must never carry a control character.
	it("strips control characters from the session key", () => {
		const result = extractRequestAffinity(
			new Headers({ "x-claude-code-session-id": "claude\tsession\u007f" }),
		);

		expect(result.key).toBe("claudesession");
	});

	it("uses Codex thread id when Claude Code session id is absent", () => {
		const result = extractRequestAffinity(
			new Headers({
				"thread-id": "codex-thread",
				"session-id": "codex-session",
				originator: "codex_cli_rs",
			}),
		);

		expect(result).toEqual({
			key: "codex-thread",
			scope: "codex_thread",
		});
	});

	it("uses Codex thread id when Codex is identified by user-agent", () => {
		const result = extractRequestAffinity(
			new Headers({
				"thread-id": "codex-thread-from-ua",
				"user-agent": "codex_cli_rs/1.2.3",
			}),
		);

		expect(result).toEqual({
			key: "codex-thread-from-ua",
			scope: "codex_thread",
		});
	});

	// The inbound header set of a real production Codex request, quoted verbatim
	// out of the payload store. `originator` is `codex-tui` here, so a check
	// pinned to the single literal `codex_cli_rs` matches nothing these clients
	// send and drops their stickiness entirely.
	it("uses Codex thread id for the production codex-tui header set", () => {
		const result = extractRequestAffinity(
			new Headers({
				originator: "codex-tui",
				"user-agent":
					"codex-tui/0.154.0 (Linux Mint 22.3.0; x86_64) gnome-terminal (codex-tui; 0.154.0)",
				"thread-id": "codex-thread-from-production",
			}),
		);

		expect(result).toEqual({
			key: "codex-thread-from-production",
			scope: "codex_thread",
		});
	});

	it("keeps Claude Code session id ahead of the production Codex headers", () => {
		const result = extractRequestAffinity(
			new Headers({
				"x-claude-code-session-id": "claude-session",
				originator: "codex-tui",
				"user-agent":
					"codex-tui/0.154.0 (Linux Mint 22.3.0; x86_64) gnome-terminal (codex-tui; 0.154.0)",
				"thread-id": "codex-thread-from-production",
			}),
		);

		expect(result).toEqual({
			key: "claude-session",
			scope: "claude_session",
		});
	});

	it("does not use broader or per-turn Codex identifiers as affinity", () => {
		const result = extractRequestAffinity(
			new Headers({
				originator: "codex_exec",
				"session-id": "codex-session",
				"x-codex-window-id": "codex-thread:2",
				"x-codex-turn-state": "turn-state",
			}),
		);

		expect(result).toEqual({ key: null, scope: null });
	});

	// Pi sends its session uuid as `session-id` or `session_id` depending on
	// version, always alongside an `x-client-request-id` carrying the same value.
	it.each([
		"session-id",
		"session_id",
	])("uses a non-Codex client's %s header as client session affinity", (header) => {
		const result = extractRequestAffinity(
			new Headers({
				"user-agent": "pi (linux 6.12.101+deb13-amd64; x64)",
				[header]: " 01a0ccd4-7cbd-778d-aac9-4151ff4fd1d9 ",
				"x-client-request-id": "01a0ccd4-7cbd-778d-aac9-4151ff4fd1d9",
			}),
		);

		expect(result).toEqual({
			key: "01a0ccd4-7cbd-778d-aac9-4151ff4fd1d9",
			scope: "client_session",
		});
	});

	const PI_HEADERS = {
		"user-agent": "pi (linux 6.12.101+deb13-amd64; x64)",
		"x-client-request-id": "01a0ccd4-7cbd-778d-aac9-4151ff4fd1d9",
	};

	it("uses a non-Codex client's prompt_cache_key when no session header arrived", () => {
		const result = extractRequestAffinity(
			new Headers(PI_HEADERS),
			" 01a0ccd4-7cbd-778d-aac9-4151ff4fd1d9 ",
		);

		expect(result).toEqual({
			key: "01a0ccd4-7cbd-778d-aac9-4151ff4fd1d9",
			scope: "client_session",
		});
	});

	it("uses any non-Codex client's prompt_cache_key, not only Pi's", () => {
		const result = extractRequestAffinity(
			new Headers({ "user-agent": "OpenAI/JS 5.0.0" }),
			"shared-bucket",
		);

		expect(result).toEqual({ key: "shared-bucket", scope: "client_session" });
	});

	it("keeps the session-id header ahead of prompt_cache_key", () => {
		const result = extractRequestAffinity(
			new Headers({ ...PI_HEADERS, "session-id": "header-session" }),
			"body-session",
		);

		expect(result).toEqual({ key: "header-session", scope: "client_session" });
	});

	it("ignores an empty prompt_cache_key", () => {
		const result = extractRequestAffinity(new Headers(PI_HEADERS), " \x00 ");

		expect(result).toEqual({ key: null, scope: null });
	});

	it("never keys Codex on prompt_cache_key", () => {
		const threadless = extractRequestAffinity(
			new Headers({ originator: "codex-tui" }),
			"codex-cache-key",
		);
		const threaded = extractRequestAffinity(
			new Headers({ originator: "codex-tui", "thread-id": "codex-thread" }),
			"codex-cache-key",
		);

		expect(threadless).toEqual({ key: null, scope: null });
		expect(threaded).toEqual({ key: "codex-thread", scope: "codex_thread" });
	});

	it("keeps Codex thread id ahead of the session-id Codex also sends", () => {
		const result = extractRequestAffinity(
			new Headers({
				originator: "codex_exec",
				"thread-id": "codex-thread",
				"session-id": "codex-session",
			}),
		);

		expect(result).toEqual({ key: "codex-thread", scope: "codex_thread" });
	});

	it("does not use x-client-request-id alone as affinity", () => {
		const result = extractRequestAffinity(
			new Headers({ "x-client-request-id": "per-request-id" }),
		);

		expect(result).toEqual({ key: null, scope: null });
	});

	it("ignores generic thread-id from non-Codex clients", () => {
		const result = extractRequestAffinity(
			new Headers({
				"thread-id": "generic-thread",
			}),
		);

		expect(result).toEqual({ key: null, scope: null });
	});
});
