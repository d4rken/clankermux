import { describe, expect, it } from "bun:test";
import { sanitizeHeadersForReplay } from "../cache-header-strip";
import { extractGatewayHints } from "../gateway-hint-headers";

describe("Claude Code gateway hints", () => {
	it("keeps opaque values, trims whitespace and accepts mixed-case names", () => {
		expect(
			extractGatewayHints({
				"X-Claude-Code-Request-Class": " \tpri\u0000mary\u007f ",
				"x-claude-code-agent-type": "future-agent",
				"x-claude-code-prev-tool-durations": "[12,34]",
				"x-claude-code-compaction": "false",
				"x-claude-code-context-compacted": "0",
			}),
		).toEqual({
			gatewayHintRequestClass: "primary",
			gatewayHintAgentType: "future-agent",
			gatewayHintPrevToolDurations: "[12,34]",
			gatewayHintCompaction: "false",
			gatewayHintContextCompacted: "0",
		});
	});
	it("omits absent and blank hints and bounds retained values", () => {
		expect(extractGatewayHints({})).toEqual({});
		expect(extractGatewayHints({ "x-claude-code-agent-type": "  " })).toEqual(
			{},
		);
		expect(
			extractGatewayHints({
				"x-claude-code-agent-type": "a".repeat(1000),
				"x-claude-code-prev-tool-durations": "x".repeat(10000),
			}),
		).toEqual({
			gatewayHintAgentType: "a".repeat(256),
			gatewayHintPrevToolDurations: "x".repeat(2048),
		});
	});
	it("removes every hint from warm replays while retaining ordinary headers", () => {
		const headers = new Headers({
			"X-Claude-Code-Request-Class": "primary",
			"X-Claude-Code-Agent-Type": "explore",
			"X-Claude-Code-Prev-Tool-Durations": "[42]",
			"X-Claude-Code-Compaction": "true",
			"X-Claude-Code-Context-Compacted": "true",
			"anthropic-version": "2023-06-01",
		});
		expect(sanitizeHeadersForReplay(headers)).toEqual({
			"anthropic-version": "2023-06-01",
		});
		expect(headers.get("x-claude-code-agent-type")).toBe("explore");
	});
});
