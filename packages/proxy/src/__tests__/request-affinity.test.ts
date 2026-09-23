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
