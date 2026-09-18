import { describe, expect, it } from "bun:test";
import type { ClientEfficiencyRow } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientEfficiencySummary } from "./ClientEfficiencySummary";

function row(
	harness: string,
	inputTokens: number,
	outputTokens: number,
): ClientEfficiencyRow {
	return {
		apiKeyId: `${harness}-key`,
		apiKey: `${harness}-key`,
		harness,
		declaredApplication: harness,
		requests: 10,
		successfulRequests: 10,
		observedRequests: 10,
		inferredSessionRequests: 0,
		inferredDeclaredRequests: 0,
		inputTokens,
		outputTokens,
		cacheReadTokens: 100,
		cacheCreationTokens: 0,
		costUsd: 1,
		pricedRequests: 10,
		unpricedRequests: 0,
		contextCoveredRequests: 10,
		contextTokensSum: 1000,
		contextToolsCharsSum: 0,
		contextSystemCharsSum: 0,
		contextToolCountSum: 0,
	};
}

describe("ClientEfficiencySummary", () => {
	it("compares pi and Claude Code on tokens per request", () => {
		const html = renderToStaticMarkup(
			<ClientEfficiencySummary
				rows={[row("claude-code", 900, 100), row("pi", 400, 100)]}
			/>,
		);

		expect(html).toContain("Token efficiency");
		expect(html).toContain("pi uses 45.5% fewer tokens per request");
		expect(html).toContain("avg tokens / request");
	});
});
