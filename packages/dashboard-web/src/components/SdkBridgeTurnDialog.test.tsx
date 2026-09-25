import { describe, expect, it } from "bun:test";
import type { SdkBridgeTurnView } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { SdkBridgeTurnChip, SdkBridgeTurnDetails } from "./SdkBridgeTurnDialog";

function view(over: Partial<SdkBridgeTurnView> = {}): SdkBridgeTurnView {
	return {
		turn: {
			id: "turn-1",
			kind: "turn",
			startedAt: 1_700_000_000_000,
			finishedAt: 1_700_000_004_000,
			status: "failed",
			httpStatus: 529,
			errorType: "overloaded_error",
			errorMessage: "Overloaded",
			apiKeyId: "key-1",
			apiKeyName: "pi-laptop",
			accountId: "acct-a",
			model: "claude-opus-5-5",
			clientHarness: "pi",
			clientUserAgent: null,
			project: null,
			conversationKeyHash: null,
			ccSessionId: null,
			historyMode: "resume",
			rebuildReason: null,
			systemPromptPolicy: "drop",
			systemPromptDetail: null,
			stopReason: null,
			legCount: 2,
			toolRoundCount: 1,
			innerCallCount: 3,
			innerErrorCount: 1,
			spawnMs: 1_500,
			firstEventMs: 2_000,
			durationMs: 4_000,
			sdkNumTurns: null,
			sdkInputTokens: null,
			sdkOutputTokens: null,
			sdkCacheReadInputTokens: null,
			sdkCacheCreationInputTokens: null,
			ignoredFields: ["temperature", "top_p"],
		},
		legs: [
			{
				id: "leg-aaaaaaaa-1",
				turnId: "turn-1",
				kind: "start",
				startedAt: 1_700_000_000_000,
				finishedAt: 1_700_000_001_000,
				httpStatus: 200,
				errorPhase: null,
				stopReason: "tool_use",
				errorType: null,
				errorMessage: null,
				toolUseIds: ["toolu_1"],
			},
			{
				id: "leg-bbbbbbbb-2",
				turnId: "turn-1",
				kind: "continue",
				startedAt: 1_700_000_002_000,
				finishedAt: 1_700_000_004_000,
				httpStatus: 200,
				errorPhase: "mid_stream",
				stopReason: null,
				errorType: "overloaded_error",
				errorMessage: "Overloaded",
				toolUseIds: null,
			},
		],
		inner: {
			requestCount: 2,
			inputTokens: 1_200,
			outputTokens: 300,
			cacheReadInputTokens: 40_000,
			cacheCreationInputTokens: 0,
			costUsd: 0.1234,
		},
		accountName: "Claude A",
		innerRequests: [
			{
				id: "inner-1",
				timestamp: 1_700_000_000_500,
				accountId: "acct-b",
				accountName: "Claude B",
				model: "claude-opus-5-5",
				statusCode: 529,
				success: false,
				inputTokens: null,
				outputTokens: null,
				cacheReadInputTokens: null,
				cacheCreationInputTokens: null,
				costUsd: null,
			},
		],
		prunedInnerCalls: 1,
		matchedLegId: null,
		...over,
	};
}

describe("SdkBridgeTurnChip", () => {
	it("is a plain labelled button", () => {
		const html = renderToStaticMarkup(<SdkBridgeTurnChip onOpen={() => {}} />);
		expect(html).toContain("<button");
		expect(html).toContain(">Agent SDK</button>");
	});
});

describe("SdkBridgeTurnDetails", () => {
	it("shows the turn's status, history, prompt policy and ignored fields", () => {
		const html = renderToStaticMarkup(<SdkBridgeTurnDetails view={view()} />);
		expect(html).toContain("Failed");
		expect(html).toContain("529");
		expect(html).toContain("overloaded_error: Overloaded");
		expect(html).toContain("Resumed session");
		expect(html).toContain("drop");
		expect(html).toContain("temperature, top_p");
		expect(html).toContain("Claude A");
		expect(html).toContain("pi-laptop · pi");
	});

	it("names a rebuild's reason", () => {
		const base = view();
		const html = renderToStaticMarkup(
			<SdkBridgeTurnDetails
				view={{
					...base,
					turn: {
						...base.turn,
						historyMode: "rebuild_flattened",
						rebuildReason: "account_change",
					},
				}}
			/>,
		);
		expect(html).toContain("Rebuilt from history, flattened (account change)");
	});

	it("names the rebuild of tool results whose query had ended", () => {
		const base = view();
		const html = renderToStaticMarkup(
			<SdkBridgeTurnDetails
				view={{
					...base,
					turn: {
						...base.turn,
						historyMode: "rebuild_flattened",
						rebuildReason: "dead_continuation",
					},
				}}
			/>,
		);
		expect(html).toContain(
			"Rebuilt from history, flattened (tool results after their query ended)",
		);
	});

	it("lists legs with their error phase and the inner calls with accounts", () => {
		const html = renderToStaticMarkup(<SdkBridgeTurnDetails view={view()} />);
		expect(html).toContain("continue");
		expect(html).toContain("mid-stream: Overloaded");
		expect(html).toContain("Claude B");
		expect(html).toContain("2 recorded, 1 pruned");
		expect(html).toContain("$0.1234");
	});

	it("says there were no ignored fields", () => {
		const base = view();
		const html = renderToStaticMarkup(
			<SdkBridgeTurnDetails
				view={{ ...base, turn: { ...base.turn, ignoredFields: null } }}
			/>,
		);
		expect(html).toContain("None");
	});
});
