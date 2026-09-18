import { describe, expect, it } from "bun:test";
import type { ClientEfficiencyRow } from "@clankermux/types";
import { rollUpClientEfficiency } from "./client-efficiency-rollup";
import { contextParts, tokenDifference, tokenParts } from "./harness-breakdown";

export function breakdownRow(
	overrides: Partial<ClientEfficiencyRow> = {},
): ClientEfficiencyRow {
	return {
		apiKeyId: "a",
		apiKey: "a",
		harness: "claude-code",
		declaredApplication: null,
		requests: 10,
		successfulRequests: 10,
		observedRequests: 10,
		inferredSessionRequests: 0,
		inferredDeclaredRequests: 0,
		inputTokens: 100,
		cacheReadTokens: 800,
		cacheCreationTokens: 50,
		outputTokens: 50,
		costUsd: 1,
		pricedRequests: 10,
		unpricedRequests: 0,
		contextCoveredRequests: 2,
		contextTokensSum: 200,
		contextSystemCharsSum: 20,
		contextToolsCharsSum: 40,
		contextToolCountSum: 4,
		contextBreakdown: {
			coveredRequests: 2,
			systemCharsSum: 20,
			toolsCharsSum: 40,
			toolResultCharsSum: 80,
			otherMessagesCharsSum: 60,
			messageCountSum: 12,
		},
		...overrides,
	};
}

describe("harness breakdown", () => {
	it("divides summed traffic by requests and context by measured requests", () => {
		const [group] = rollUpClientEfficiency(
			[
				breakdownRow(),
				breakdownRow({
					apiKeyId: "b",
					requests: 90,
					inputTokens: 900,
					cacheReadTokens: 7200,
					cacheCreationTokens: 450,
					outputTokens: 450,
					contextBreakdown: undefined,
				}),
			],
			"harness",
		);
		expect(tokenParts(group).map((p) => p.value)).toEqual([10, 80, 5, 5]);
		expect(contextParts(group).map((p) => p.value)).toEqual([10, 20, 40, 30]);
		expect(group.contextBreakdown?.coveredRequests).toBe(2);
	});

	it("keeps missing composition distinct from measured zero", () => {
		const [missing] = rollUpClientEfficiency(
			[breakdownRow({ contextBreakdown: undefined })],
			"harness",
		);
		const [zero] = rollUpClientEfficiency(
			[
				breakdownRow({
					contextBreakdown: {
						coveredRequests: 1,
						systemCharsSum: 0,
						toolsCharsSum: 0,
						toolResultCharsSum: 0,
						otherMessagesCharsSum: 0,
						messageCountSum: 0,
					},
				}),
			],
			"harness",
		);
		expect(contextParts(missing).every((p) => p.value === null)).toBe(true);
		expect(contextParts(zero).map((p) => p.value)).toEqual([0, 0, 0, 0]);
	});

	it("explains the signed gap, including opposing contributions", () => {
		const [baseline, comparison] = rollUpClientEfficiency(
			[
				breakdownRow(),
				breakdownRow({
					harness: "pi",
					cacheReadTokens: 200,
					outputTokens: 150,
				}),
			],
			"harness",
		);
		expect(tokenDifference(baseline, comparison)).toEqual({
			delta: -50,
			driver: "Cache reads",
			driverDelta: -60,
		});
		expect(tokenDifference(comparison, baseline)).toEqual({
			delta: 50,
			driver: "Cache reads",
			driverDelta: 60,
		});
		expect(tokenDifference(baseline, baseline)?.delta).toBe(0);
	});
});
