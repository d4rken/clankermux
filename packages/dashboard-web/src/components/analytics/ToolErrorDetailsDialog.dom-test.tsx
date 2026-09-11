import { afterEach, expect, it, spyOn } from "bun:test";
import type { ToolErrorDetailsResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../api";
import { ToolErrorDetailsDialog } from "./ToolErrorDetailsDialog";

let root: Root;
let host: HTMLElement;
let client: QueryClient;
const mocks: ReturnType<typeof spyOn>[] = [];
const data: ToolErrorDetailsResponse = {
	scope: {
		fromMs: 100,
		toMs: 1000,
		filters: {
			accounts: [],
			accountsNone: false,
			models: [],
			apiKeys: [],
			projects: [],
			projectsNone: false,
			status: "all",
		},
	},
	toolName: "Bash",
	totalCalls: 6,
	totalErrors: 5,
	capturedTexts: 3,
	distinctGroups: 1,
	groups: [{ sampleId: 1, errorText: "failure", occurrences: 3 }],
	offset: 0,
	hasMore: false,
	detail: null,
};
const detail: ToolErrorDetailsResponse = {
	...data,
	groups: [],
	detail: {
		group: { sampleId: 1, errorText: "failure", occurrences: 3 },
		distinctRequests: 1,
		distinctProjects: 1,
		requestsWithoutProject: 0,
		knownSessions: 1,
		requestsWithoutSession: 0,
		firstObserved: 200,
		lastObserved: 200,
		projects: [{ project: "alpha", requests: 1 }],
		projectsOmitted: 0,
		requests: [
			{
				requestId: "r1",
				timestamp: 200,
				project: "alpha",
				model: "receiving",
				payloadAvailable: true,
			},
		],
		offset: 0,
		hasMore: false,
	},
};
async function settle() {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 30));
	});
}
async function mount() {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<ToolErrorDetailsDialog
					toolName="Bash"
					timeRange="24h"
					onClose={() => {}}
					onRefresh={() => {}}
				/>
			</QueryClientProvider>,
		),
	);
	await settle();
}
async function click(text: string) {
	const button = Array.from(document.querySelectorAll("button")).find((b) =>
		b.textContent?.includes(text),
	);
	expect(button).toBeDefined();
	await act(async () => button?.click());
	await settle();
}
afterEach(async () => {
	if (root) await act(async () => root.unmount());
	host?.remove();
	client?.clear();
	for (const m of mocks) m.mockRestore();
	mocks.length = 0;
});
it("loads details and selected call evidence on demand into a copy preview", async () => {
	const calls =
		mocks[
			mocks.push(
				spyOn(api, "getToolErrors").mockImplementation(async (s) =>
					s.sampleId ? detail : data,
				),
			) - 1
		];
	const example = spyOn(api, "getToolErrorExample").mockResolvedValue({
		requestId: "r1",
		state: "matched",
		totalMatches: 1,
		omittedMatches: 0,
		matches: [
			{
				toolUseId: "x",
				messageIndex: 1,
				blockIndex: 0,
				input: '{"command":"failing-command"}',
				result: "failure",
				inputTruncated: false,
				resultTruncated: false,
			},
		],
	});
	mocks.push(example);
	await mount();
	expect(calls).toHaveBeenCalledTimes(1);
	expect(example).not.toHaveBeenCalled();
	await click("failure");
	expect(document.body.textContent).toContain("5 reported errors");
	await click("Load call details");
	expect(example).toHaveBeenCalledTimes(1);
	expect(document.body.textContent).toContain("failing-command");
	expect(document.body.textContent).toContain("Copy Markdown");
	expect(document.body.textContent).toContain("Copy JSON");
});
it("does not fetch every example and surfaces failed detail reads with retry", async () => {
	mocks.push(
		spyOn(api, "getToolErrors").mockRejectedValue(new Error("read failed")),
	);
	const example = spyOn(api, "getToolErrorExample");
	mocks.push(example);
	await mount();
	expect(document.body.textContent).toContain("Unable to load");
	expect(document.body.textContent).toContain("Retry");
	expect(example).not.toHaveBeenCalled();
});
it("resets selected evidence when filters change, even if an old load completes late", async () => {
	mocks.push(
		spyOn(api, "getToolErrors").mockImplementation(async (s, filters) =>
			s.sampleId
				? detail
				: { ...data, toolName: filters?.projects?.[0] ?? "Bash" },
		),
	);
	let resolveExample:
		| ((value: Awaited<ReturnType<typeof api.getToolErrorExample>>) => void)
		| undefined;
	mocks.push(
		spyOn(api, "getToolErrorExample").mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveExample = resolve;
				}),
		),
	);
	await mount();
	await click("failure");
	const button = Array.from(document.querySelectorAll("button")).find((b) =>
		b.textContent?.includes("Load call details"),
	);
	expect(button).toBeDefined();
	await act(async () => button?.click());
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<ToolErrorDetailsDialog
					toolName="Bash"
					timeRange="24h"
					filters={{ projects: ["new-project"] }}
					onClose={() => {}}
					onRefresh={() => {}}
				/>
			</QueryClientProvider>,
		),
	);
	await settle();
	await act(async () =>
		resolveExample?.({
			requestId: "r1",
			state: "matched",
			totalMatches: 1,
			omittedMatches: 0,
			matches: [
				{
					toolUseId: "x",
					messageIndex: 1,
					blockIndex: 0,
					input: "OLD-INPUT",
					result: "failure",
					inputTruncated: false,
					resultTruncated: false,
				},
			],
		}),
	);
	await settle();
	expect(document.body.textContent).not.toContain("OLD-INPUT");
	expect(document.body.textContent).not.toContain("Copy JSON");
	expect(document.body.textContent).toContain("Select a saved message");
});
it("copies the preview from inside the dialog and displays clipboard failure", async () => {
	mocks.push(
		spyOn(api, "getToolErrors").mockImplementation(async (s) =>
			s.sampleId ? detail : data,
		),
	);
	const original = document.execCommand;
	let copied = "";
	let succeeds = true;
	document.execCommand = () => {
		copied = (document.activeElement as HTMLTextAreaElement).value;
		return succeeds;
	};
	try {
		await mount();
		await click("failure");
		await click("Copy JSON");
		expect(JSON.parse(copied).group.errorText).toBe("failure");
		expect(JSON.parse(copied).supportingRequests[0].requestId).toBe("r1");
		succeeds = false;
		await click("Copy Markdown");
		expect(document.querySelector('[title="Copy failed"]')).not.toBeNull();
	} finally {
		document.execCommand = original;
	}
});

it("warns when SQLite decoding expands a truncated message beyond 500 characters", async () => {
	const expanded = structuredClone(detail);
	if (!expanded.detail) throw new Error("Missing fixture detail");
	expanded.detail.group.errorText = `${"a".repeat(499)}���`;
	mocks.push(
		spyOn(api, "getToolErrors").mockImplementation(async (s) =>
			s.sampleId ? expanded : data,
		),
	);
	await mount();
	await click("failure");
	expect(document.body.textContent).toContain("may be truncated");
});
