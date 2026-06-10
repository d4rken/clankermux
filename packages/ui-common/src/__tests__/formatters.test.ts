import { describe, expect, it } from "bun:test";
import {
	formatBytes,
	formatReasoningEffort,
	formatTokensPerSecond,
} from "../formatters";

describe("formatBytes", () => {
	it("returns '0 B' for zero, negative, and undefined", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(-5)).toBe("0 B");
		expect(formatBytes(undefined)).toBe("0 B");
	});

	it("formats raw bytes without decimals", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("formats KB / MB / GB with one decimal by default", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
		expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
	});

	it("respects a custom decimal count", () => {
		expect(formatBytes(1536, 2)).toBe("1.50 KB");
	});

	it("caps at TB for very large values", () => {
		expect(formatBytes(5 * 1024 ** 4)).toBe("5.0 TB");
		// Beyond TB still reports in TB rather than an unlabeled unit.
		expect(formatBytes(1024 ** 5)).toBe("1024.0 TB");
	});
});

describe("formatTokensPerSecond", () => {
	it("returns '0 tok/s' for zero, undefined, and null", () => {
		expect(formatTokensPerSecond(0)).toBe("0 tok/s");
		expect(formatTokensPerSecond(undefined)).toBe("0 tok/s");
		expect(formatTokensPerSecond(null)).toBe("0 tok/s");
	});

	it("formats with one decimal place", () => {
		expect(formatTokensPerSecond(12.5)).toBe("12.5 tok/s");
		expect(formatTokensPerSecond(36)).toBe("36.0 tok/s");
	});

	it("prefixes a tilde when the value is approximate", () => {
		expect(formatTokensPerSecond(36, true)).toBe("~36.0 tok/s");
		expect(formatTokensPerSecond(12.5, true)).toBe("~12.5 tok/s");
	});

	it("does not prefix a tilde when approximate is false or omitted", () => {
		expect(formatTokensPerSecond(36, false)).toBe("36.0 tok/s");
		expect(formatTokensPerSecond(36)).toBe("36.0 tok/s");
	});

	it("keeps the zero placeholder tilde-free even when approximate", () => {
		expect(formatTokensPerSecond(0, true)).toBe("0 tok/s");
		expect(formatTokensPerSecond(undefined, true)).toBe("0 tok/s");
	});
});

describe("formatReasoningEffort", () => {
	it("formats Anthropic thinking budgets compactly", () => {
		expect(formatReasoningEffort("thinking:32000")).toBe("32k thinking");
		expect(formatReasoningEffort("thinking:8000")).toBe("8k thinking");
		expect(formatReasoningEffort("thinking:1024")).toBe("1k thinking");
		expect(formatReasoningEffort("thinking:1500")).toBe("1.5k thinking");
		expect(formatReasoningEffort("thinking:1000000")).toBe("1M thinking");
	});

	it("keeps sub-thousand budgets as plain numbers", () => {
		expect(formatReasoningEffort("thinking:500")).toBe("500 thinking");
	});

	it("passes through budget-less thinking", () => {
		expect(formatReasoningEffort("thinking")).toBe("thinking");
	});

	it("passes through raw OpenAI effort strings", () => {
		expect(formatReasoningEffort("high")).toBe("high");
		expect(formatReasoningEffort("medium")).toBe("medium");
		expect(formatReasoningEffort("xhigh")).toBe("xhigh");
	});

	it("passes through malformed thinking budgets unchanged", () => {
		expect(formatReasoningEffort("thinking:abc")).toBe("thinking:abc");
	});
});
