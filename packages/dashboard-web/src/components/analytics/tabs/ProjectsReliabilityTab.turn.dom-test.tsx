import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { SdkBridgeTurnView } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { api } from "../../../api";
import { healthFixture } from "../__fixtures__/sdk-bridge-health";
import { EMPTY_FILTERS } from "../AnalyticsFilters";
import { ProjectsReliabilityTab } from "./ProjectsReliabilityTab";

/**
 * A failure row of the Agent SDK bridge card opens its turn through `?turn=`,
 * the way Request History does. The dialog is a portalled Radix dialog, which
 * `renderToStaticMarkup` cannot see.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let currentSearch = "";

function SearchProbe() {
	currentSearch = useLocation().search;
	return null;
}

async function settle(rounds = 4): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}

function turnView(id: string): SdkBridgeTurnView {
	return {
		turn: {
			id,
			kind: "turn",
			startedAt: 1_700_000_000_000,
			finishedAt: 1_700_000_000_100,
			status: "rejected",
			httpStatus: 400,
			errorType: "invalid_request_error",
			errorMessage: "refused",
			apiKeyId: null,
			apiKeyName: null,
			accountId: null,
			model: "claude-opus-5-5",
			clientHarness: "pi",
			clientUserAgent: null,
			project: null,
			conversationKeyHash: null,
			ccSessionId: null,
			historyMode: "fresh",
			rebuildReason: null,
			systemPromptPolicy: "pi-head-v1",
			systemPromptDetail: {
				outcome: "refused",
				version: "0.80.1",
				code: "sdk_bridge_prompt_refused",
				reason: "prompt_refused",
				section: null,
				promptLength: 900,
				promptSha256: "cd".repeat(32),
			},
			stopReason: null,
			legCount: 1,
			toolRoundCount: 0,
			innerCallCount: 0,
			innerErrorCount: 0,
			spawnMs: null,
			firstEventMs: null,
			durationMs: null,
			sdkNumTurns: null,
			sdkInputTokens: null,
			sdkOutputTokens: null,
			sdkCacheReadInputTokens: null,
			sdkCacheCreationInputTokens: null,
			ignoredFields: null,
		},
		legs: [],
		inner: {
			requestCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			costUsd: 0,
		},
		accountName: null,
		innerRequests: [],
		prunedInnerCalls: 0,
		matchedLegId: null,
	};
}

async function mount(initialEntry: string): Promise<void> {
	spyOn(api, "getSdkBridgeHealth").mockImplementation(async () =>
		healthFixture(),
	);
	spyOn(api, "getSdkBridgeTurn").mockImplementation(async (id: string) =>
		turnView(id),
	);
	spyOn(api, "getStopsHistory").mockImplementation(() => new Promise(() => {}));
	spyOn(api, "getAnalytics").mockImplementation(() => new Promise(() => {}));
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={queryClient}>
				<MemoryRouter initialEntries={[initialEntry]}>
					<SearchProbe />
					<ProjectsReliabilityTab
						filters={EMPTY_FILTERS}
						setFilters={() => {}}
						availableAccounts={[]}
						availableModels={[]}
						availableApiKeys={[]}
						availableProjects={[]}
						hasNoAccountBucket={false}
						hasNoProjectBucket={false}
						activeFilterCount={0}
						filterOpen={false}
						setFilterOpen={() => {}}
						range="24h"
						onRangeChange={() => {}}
					/>
				</MemoryRouter>
			</QueryClientProvider>,
		);
	});
	await settle();
}

afterEach(async () => {
	if (root) {
		const current = root;
		await act(async () => {
			current.unmount();
		});
	}
	host?.remove();
	root = null;
	host = null;
	currentSearch = "";
	mock.restore();
});

const pageText = () => document.body.textContent ?? "";
const turnIsOpen = () => pageText().includes("Agent SDK turn");

describe("ProjectsReliabilityTab — Agent SDK turns", () => {
	it("opens a failed turn from the bridge card, and closes it again", async () => {
		await mount("/analytics?tab=projects");
		expect(turnIsOpen()).toBe(false);

		const row = document.querySelector<HTMLButtonElement>(
			'button[title="turn-rejected-1"]',
		);
		expect(row).not.toBeNull();
		await act(async () => {
			row?.click();
		});
		await settle();

		expect(currentSearch).toContain("turn=turn-rejected-1");
		expect(currentSearch).toContain("tab=projects");
		expect(api.getSdkBridgeTurn).toHaveBeenCalledWith("turn-rejected-1");
		expect(turnIsOpen()).toBe(true);
		expect(pageText()).toContain("sdk_bridge_prompt_refused: prompt_refused");

		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		await settle();
		expect(turnIsOpen()).toBe(false);
		expect(currentSearch).not.toContain("turn=");
		expect(currentSearch).toContain("tab=projects");
	});

	it("opens the turn a shared ?turn= link names", async () => {
		await mount("/analytics?tab=projects&turn=turn-failed-1");
		expect(api.getSdkBridgeTurn).toHaveBeenCalledWith("turn-failed-1");
		expect(turnIsOpen()).toBe(true);
	});
});
