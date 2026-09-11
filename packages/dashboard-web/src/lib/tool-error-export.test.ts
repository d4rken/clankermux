import { expect, it } from "bun:test";
import type { ToolErrorDetailsResponse } from "@clankermux/types";
import {
	createToolErrorExport,
	formatToolErrorExport,
} from "./tool-error-export";
export const detailFixture: ToolErrorDetailsResponse = {
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
	totalCalls: 10,
	totalErrors: 5,
	capturedTexts: 3,
	distinctGroups: 1,
	groups: [],
	offset: 0,
	hasMore: false,
	detail: {
		group: { sampleId: 1, errorText: "```\nfailure\n```", occurrences: 3 },
		distinctRequests: 1,
		distinctProjects: 1,
		requestsWithoutProject: 0,
		knownSessions: 1,
		requestsWithoutSession: 0,
		firstObserved: 200,
		lastObserved: 200,
		projects: [{ project: "project", requests: 1 }],
		projectsOmitted: 0,
		requests: [
			{
				requestId: "r1",
				timestamp: 200,
				project: "project",
				model: "model",
				payloadAvailable: true,
			},
		],
		offset: 0,
		hasMore: false,
	},
};
it("exports factual metadata, selected excerpts, and explicit coverage", () => {
	const data = createToolErrorExport(detailFixture, []);
	expect(data.reportedErrors).toBe(5);
	expect(data.group.capturedOccurrences).toBe(3);
	expect(data.coverage.join(" ")).toContain("/v1/messages");
	expect(data.examplesIncluded).toBe(0);
	const markdown = formatToolErrorExport(data, "markdown");
	expect(markdown).toContain("Tool error evidence");
	expect(markdown).toContain("failure");
	expect(JSON.parse(formatToolErrorExport(data, "json")).schemaVersion).toBe(1);
});
it("bounds both serialized formats and discloses omitted excerpts", () => {
	const examples = Array.from({ length: 3 }, (_, i) => ({
		request: {
			requestId: `r${i}`,
			timestamp: 200,
			project: "project",
			model: null,
			payloadAvailable: true,
		},
		evidence: {
			requestId: `r${i}`,
			state: "ambiguous" as const,
			totalMatches: 3,
			omittedMatches: 0,
			matches: Array.from({ length: 3 }, () => ({
				toolUseId: "x",
				messageIndex: 1,
				blockIndex: 1,
				input: '\\"😀'.repeat(8192),
				result: '\\"😀'.repeat(8192),
				inputTruncated: false,
				resultTruncated: false,
			})),
		},
	}));
	const data = createToolErrorExport(detailFixture, examples);
	for (const format of ["markdown", "json"] as const)
		expect(
			new TextEncoder().encode(formatToolErrorExport(data, format)).length,
		).toBeLessThanOrEqual(65536);
	expect(data.excerptsOmittedForExport).toBeGreaterThan(0);
});

it("marks SQLite-expanded capture boundaries as possibly truncated", () => {
	const expanded = structuredClone(detailFixture);
	if (!expanded.detail) throw new Error("Missing fixture detail");
	expanded.detail.group.errorText = `${"a".repeat(499)}���`;
	expect(createToolErrorExport(expanded, []).group.mayBeTruncated).toBe(true);
});
