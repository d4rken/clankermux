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
				requestedModel: "claude-opus-5-5",
				statusCode: 529,
				success: false,
				errorMessage: "provider_overloaded",
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

	it("names a resume that appended the client's own turns", () => {
		const base = view();
		const html = renderToStaticMarkup(
			<SdkBridgeTurnDetails
				view={{
					...base,
					turn: {
						...base.turn,
						historyMode: "resume_extended",
						rebuildReason: "continuation",
					},
				}}
			/>,
		);
		expect(html).toContain("Resumed, client turns appended (continuation)");
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

	it("shows what a forwarded system prompt kept, never its text", () => {
		const base = view();
		const html = renderToStaticMarkup(
			<SdkBridgeTurnDetails
				view={{
					...base,
					turn: {
						...base.turn,
						systemPromptPolicy: "pi-head-v1",
						systemPromptDetail: {
							outcome: "forwarded",
							version: "0.80.1",
							headStripped: true,
							forwardedLength: 4_210,
							sectionsSeen: ["<cwd>", "<advertised_subagents>"],
						},
					},
				}}
			/>,
		);
		const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		expect(text).toContain("System prompt policy pi-head-v1");
		expect(text).toContain("Prompt layout 0.80.1");
		expect(text).toContain("pi head removed · 4,210 characters appended");
		expect(text).toContain(
			"Sections seen &lt;cwd&gt;, &lt;advertised_subagents&gt;",
		);
	});

	it("shows a refused system prompt's reason, section and digest", () => {
		const base = view();
		const html = renderToStaticMarkup(
			<SdkBridgeTurnDetails
				view={{
					...base,
					turn: {
						...base.turn,
						status: "rejected",
						systemPromptPolicy: "pi-head-v1",
						systemPromptDetail: {
							outcome: "refused",
							version: null,
							code: "sdk_bridge_prompt_unsupported",
							reason: "missing_version",
							section: "tools",
							promptLength: 12_000,
							promptSha256: "ab".repeat(32),
						},
					},
				}}
			/>,
		);
		const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		expect(text).toContain("Prompt layout None declared");
		expect(text).toContain(
			"Refused sdk_bridge_prompt_unsupported: missing_version (section tools)",
		);
		expect(text).toContain("12,000 characters · SHA-256 abababababab");
	});

	it("names an outcome it does not know instead of calling it a refusal", () => {
		const base = view();
		const html = renderToStaticMarkup(
			<SdkBridgeTurnDetails
				view={{
					...base,
					turn: {
						...base.turn,
						systemPromptPolicy: "pi-head-v2",
						systemPromptDetail: {
							outcome: "rewritten",
							version: "0.90.0",
						} as unknown as SdkBridgeTurnView["turn"]["systemPromptDetail"],
					},
				}}
			/>,
		);
		const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		expect(text).toContain("Prompt layout 0.90.0");
		expect(text).toContain("Prompt outcome rewritten, not shown");
		expect(text).not.toContain("Refused");
	});

	for (const [name, detail] of [
		[
			"a forwarded detail without its lengths",
			{ outcome: "forwarded", version: "0.80.1" },
		],
		[
			"a refused detail without its digest",
			{ outcome: "refused", version: null, code: "c", reason: "r" },
		],
	] as const)
		it(`renders ${name} as unavailable`, () => {
			const base = view();
			const html = renderToStaticMarkup(
				<SdkBridgeTurnDetails
					view={{
						...base,
						turn: {
							...base.turn,
							systemPromptPolicy: "pi-head-v1",
							systemPromptDetail:
								detail as unknown as SdkBridgeTurnView["turn"]["systemPromptDetail"],
						},
					}}
				/>,
			);
			const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
			expect(text).toContain("Prompt detail unavailable");
			expect(text).not.toContain("undefined");
		});

	it("labels an expired turn", () => {
		const base = view();
		const html = renderToStaticMarkup(
			<SdkBridgeTurnDetails
				view={{ ...base, turn: { ...base.turn, status: "expired" } }}
			/>,
		);
		expect(html).toContain("Expired, tool results never came");
		expect(html).toContain("bg-warning");
	});

	it("shows no prompt detail for the drop policy", () => {
		const html = renderToStaticMarkup(<SdkBridgeTurnDetails view={view()} />);
		expect(html).not.toContain("Prompt layout");
		expect(html).not.toContain("Refused");
	});

	it("marks a side request", () => {
		const base = view();
		const html = renderToStaticMarkup(
			<SdkBridgeTurnDetails
				view={{ ...base, turn: { ...base.turn, kind: "side_request" } }}
			/>,
		);
		expect(html).toContain("Side request");
		expect(
			renderToStaticMarkup(<SdkBridgeTurnDetails view={view()} />),
		).not.toContain("Side request");
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

	it("draws a model call whose client left before the response as neutral", () => {
		const base = view();
		const call = base.innerRequests[0];
		const html = renderToStaticMarkup(
			<SdkBridgeTurnDetails
				view={{
					...base,
					innerRequests: [
						{
							...call,
							id: "pre-head",
							statusCode: 499,
							errorMessage: "client_closed_request",
						},
						{
							...call,
							id: "post-head",
							statusCode: 200,
							errorMessage: "client disconnected",
						},
						{
							...call,
							id: "upstream-499",
							statusCode: 499,
							errorMessage: "499 upstream text",
						},
					],
				}}
			/>,
		);
		const cellOf = (id: string) => {
			const row = html.slice(html.indexOf(`title="${id}"`));
			return row.slice(0, row.indexOf("</tr>"));
		};
		expect(cellOf("pre-head")).toContain("text-muted-foreground");
		expect(cellOf("pre-head")).not.toContain("text-destructive-strong");
		expect(cellOf("post-head")).toContain("text-destructive-strong");
		expect(cellOf("upstream-499")).toContain("text-destructive-strong");
	});

	it("labels the requested model for a call that reported none", () => {
		const base = view();
		const call = base.innerRequests[0];
		const html = renderToStaticMarkup(
			<SdkBridgeTurnDetails
				view={{
					...base,
					innerRequests: [
						{
							...call,
							id: "served",
							model: "claude-opus-5-5",
							requestedModel: "claude-opus-5-5[1m]",
						},
						{
							...call,
							id: "pre-head",
							statusCode: 499,
							errorMessage: "client_closed_request",
							model: null,
							requestedModel: "claude-fable-5-1",
						},
						{ ...call, id: "neither", model: null, requestedModel: null },
					],
				}}
			/>,
		);
		// Time, account, model: the model is the third cell of the row.
		const modelCellOf = (id: string) => {
			const row = html.slice(html.indexOf(`title="${id}"`));
			const cells = row.slice(0, row.indexOf("</tr>")).split("</td>");
			return cells[2]?.slice(cells[2].lastIndexOf(">") + 1);
		};
		expect(modelCellOf("served")).toBe("claude-opus-5-5");
		expect(modelCellOf("pre-head")).toBe("claude-fable-5-1 · requested");
		expect(modelCellOf("neither")).toBe("—");
	});
});
