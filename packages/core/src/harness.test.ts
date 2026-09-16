/**
 * Inbound harness detection: which agent a request's OWN headers name.
 *
 * The property that matters beyond each individual rule is that the detector's
 * vocabulary and `ClientApplication`'s are one vocabulary. The analytics
 * inference tier feeds `client_profiles.application` straight through as a
 * harness label, so a second spelling for one harness would split a key across
 * two rows and make every request of a correctly-configured client look
 * misconfigured.
 */
import { describe, expect, it } from "bun:test";
import type { ClientApplication } from "@clankermux/types";
import {
	detectHarness,
	HARNESS_LABEL_FOR_APPLICATION,
	isCodexClient,
	normalizeClientUserAgent,
} from "./harness";

function headers(init: Record<string, string>): Headers {
	return new Headers(init);
}

/**
 * Control characters built from their codes rather than written as unicode
 * escapes: `biome check --unsafe` rewrites such an escape to the literal
 * character, which would leave a NUL byte in this source file.
 */
const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);
const DEL = String.fromCharCode(127);

describe("normalizeClientUserAgent", () => {
	it("returns null for absent and empty values", () => {
		expect(normalizeClientUserAgent(null)).toBeNull();
		expect(normalizeClientUserAgent("")).toBeNull();
		expect(normalizeClientUserAgent("   ")).toBeNull();
	});

	it("strips control characters and trims", () => {
		expect(normalizeClientUserAgent(`  claude${NUL}-cli/2.1.270${DEL} `)).toBe(
			"claude-cli/2.1.270",
		);
	});

	it("returns null when only control characters remain", () => {
		expect(normalizeClientUserAgent(`${NUL}${SOH}${DEL}`)).toBeNull();
	});

	it("truncates to 256 characters", () => {
		const normalized = normalizeClientUserAgent("x".repeat(400));
		expect(normalized).toHaveLength(256);
	});
});

describe("detectHarness", () => {
	it("labels a Claude Code user-agent claude-code", () => {
		const detection = detectHarness(
			headers({ "user-agent": "claude-cli/2.1.270 (external, cli)" }),
		);
		expect(detection.harness).toBe("claude-code");
		expect(detection.userAgent).toBe("claude-cli/2.1.270 (external, cli)");
	});

	it("requires a digit after claude-cli/ so a lookalike name does not match", () => {
		expect(
			detectHarness(headers({ "user-agent": "claude-cli/x" })).harness,
		).toBe("claude-cli");
	});

	it("labels the Codex CLI user-agent codex", () => {
		expect(
			detectHarness(headers({ "user-agent": "codex_cli_rs/0.104.0" })).harness,
		).toBe("codex");
		expect(
			detectHarness(headers({ "user-agent": "codex_cli_rs/1.2.3" })).harness,
		).toBe("codex");
	});

	// Copied verbatim out of the `client_user_agent` column: the strings real
	// Codex clients send. Every surface of the family is one harness, so a
	// paraphrase here would stop proving the rule matches production traffic.
	it.each([
		"codex-tui/0.154.0 (Linux Mint 22.3.0; x86_64) gnome-terminal (codex-tui; 0.154.0)",
		"codex-tui/0.154.0 (Debian 13.0.0; x86_64) xterm-256color (codex-tui; 0.154.0)",
		"codex_exec/0.154.0 (Linux Mint 22.3.0; x86_64) gnome-terminal (codex_exec; 0.154.0)",
	])("labels the production Codex user-agent %s codex", (userAgent) => {
		expect(detectHarness(headers({ "user-agent": userAgent })).harness).toBe(
			"codex",
		);
	});

	it("only matches the Codex family at the start of the user-agent", () => {
		expect(
			detectHarness(headers({ "user-agent": "notcodex-tui/1.0" })).harness,
		).toBe("notcodex-tui");
		expect(
			detectHarness(headers({ "user-agent": "my-codex-thing/1.0" })).harness,
		).toBe("my-codex-thing");
	});

	it("falls back to the originator header when the user-agent is generic", () => {
		const detection = detectHarness(
			headers({ "user-agent": "Mozilla/5.0", originator: "codex_cli_rs" }),
		);
		expect(detection.harness).toBe("codex");
		expect(detection.userAgent).toBe("Mozilla/5.0");
	});

	it("labels the Qwen Code user-agent qwen-code", () => {
		expect(
			detectHarness(headers({ "user-agent": "QwenCode/0.2.1 (linux)" }))
				.harness,
		).toBe("qwen-code");
	});

	it("labels an unknown client with its own leading user-agent token", () => {
		expect(
			detectHarness(headers({ "user-agent": "opencode/0.4.2" })).harness,
		).toBe("opencode");
		expect(
			detectHarness(headers({ "user-agent": "OpenAI/Python 1.30.1" })).harness,
		).toBe("openai");
	});

	it("drops characters outside [a-z0-9-] from the derived label", () => {
		expect(
			detectHarness(headers({ "user-agent": "my_agent!/1.0" })).harness,
		).toBe("myagent");
	});

	it("yields a null harness when the leading token has nothing usable left", () => {
		const detection = detectHarness(headers({ "user-agent": "!!!/1.0" }));
		expect(detection.harness).toBeNull();
		expect(detection.userAgent).toBe("!!!/1.0");
	});

	it("yields nulls for a request with no user-agent at all", () => {
		expect(detectHarness(headers({}))).toEqual({
			harness: null,
			userAgent: null,
		});
	});
});

describe("isCodexClient", () => {
	// `codex-tui` is the `originator` production sends today; `codex_cli_rs` is
	// what it sent until a client upgrade changed it. Both are the same harness,
	// which is why the predicate matches the family on this header too.
	it("matches the production originator codex-tui", () => {
		expect(isCodexClient(headers({ originator: "codex-tui" }))).toBe(true);
	});

	it("matches the legacy originator codex_cli_rs", () => {
		expect(isCodexClient(headers({ originator: "codex_cli_rs" }))).toBe(true);
	});

	it("matches a codex-tui user-agent with no originator header", () => {
		expect(
			isCodexClient(
				headers({
					"user-agent":
						"codex-tui/0.154.0 (Linux Mint 22.3.0; x86_64) gnome-terminal (codex-tui; 0.154.0)",
				}),
			),
		).toBe(true);
	});

	it("matches a codex_exec user-agent", () => {
		expect(
			isCodexClient(
				headers({
					"user-agent":
						"codex_exec/0.154.0 (Linux Mint 22.3.0; x86_64) gnome-terminal (codex_exec; 0.154.0)",
				}),
			),
		).toBe(true);
	});

	it("is false for an unrelated client that sends no originator", () => {
		expect(
			isCodexClient(
				headers({ "user-agent": "claude-cli/2.1.272 (external, cli)" }),
			),
		).toBe(false);
	});

	it("only matches the Codex family at the start of the originator", () => {
		expect(isCodexClient(headers({ originator: "notcodex-tui" }))).toBe(false);
	});
});

describe("HARNESS_LABEL_FOR_APPLICATION", () => {
	it("is the identity on every application except generic", () => {
		// The property the inference SQL depends on: it uses `cp.application`
		// verbatim as a harness label for rows with no observed harness. Any
		// member that stops mapping to itself makes that a silent mislabel.
		for (const [application, label] of Object.entries(
			HARNESS_LABEL_FOR_APPLICATION,
		) as Array<[ClientApplication, string | null]>) {
			if (application === "generic") continue;
			expect(label).toBe(application);
		}
	});

	it("maps generic to null because it declares no harness", () => {
		expect(HARNESS_LABEL_FOR_APPLICATION.generic).toBeNull();
	});
});
