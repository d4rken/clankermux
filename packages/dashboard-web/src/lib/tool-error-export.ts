import type {
	ToolErrorDetailsResponse,
	ToolErrorExampleResponse,
	ToolErrorSupportingRequest,
} from "@clankermux/types";

export interface SelectedToolErrorExample {
	request: ToolErrorSupportingRequest;
	evidence: ToolErrorExampleResponse;
}
const MAX_EXPORT_BYTES = 65536;
export function createToolErrorExport(
	data: ToolErrorDetailsResponse,
	selected: SelectedToolErrorExample[],
) {
	const detail = data.detail;
	if (!detail)
		throw new Error("Select an error message before copying details.");
	const document = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		tool: data.toolName,
		grouping: "exact-stored-text",
		scope: data.scope,
		reportedCalls: data.totalCalls,
		reportedErrors: data.totalErrors,
		capturedTextsForTool: data.capturedTexts,
		group: {
			errorText: detail.group.errorText,
			mayBeTruncated: detail.group.errorText.length >= 500,
			capturedOccurrences: detail.group.occurrences,
			distinctRequests: detail.distinctRequests,
			distinctProjects: detail.distinctProjects,
			requestsWithoutProject: detail.requestsWithoutProject,
			knownSessions: detail.knownSessions,
			requestsWithoutSession: detail.requestsWithoutSession,
			firstObserved: detail.firstObserved,
			lastObserved: detail.lastObserved,
			projects: detail.projects,
			projectsOmitted: detail.projectsOmitted,
		},
		coverage: [
			"Reported tool results from POST /v1/messages only; other ingress formats are not covered.",
			"Only the final message is counted. Client resends may repeat observations; these are not deduplicated executions.",
			"At most three non-empty error texts are captured per tool per request, each limited to 500 UTF-16 characters. Captured occurrences are not complete failure counts.",
			"Dates are observed request timestamps, not tool execution times. Model metadata describes the receiving request, not necessarily the author of the tool call.",
			"Payloads may be absent, expired, malformed or incomplete. Identical saved prefixes may match multiple calls. No recovery or cause is inferred.",
			"This is an as-of time selection, not a durable database snapshot. Only explicitly loaded examples are included.",
		],
		supportingRequests: detail.requests.map((request) => ({
			requestId: request.requestId,
			requestPath: `/requests?request=${encodeURIComponent(request.requestId)}`,
			observedAt: request.timestamp,
			project: request.project,
			receivingModel: request.model,
			payloadRowPresent: request.payloadAvailable,
		})),
		supportingRequestsOmitted: Math.max(
			0,
			detail.distinctRequests - detail.requests.length,
		),
		examplesIncluded: Math.min(selected.length, 3),
		examplesOmittedBySelection: Math.max(
			0,
			detail.distinctRequests - Math.min(selected.length, 3),
		),
		excerptsOmittedForExport: 0,
		examples: selected.slice(0, 3).map(({ request, evidence }) => ({
			requestId: request.requestId,
			requestPath: `/requests?request=${encodeURIComponent(request.requestId)}`,
			observedAt: request.timestamp,
			project: request.project,
			receivingModel: request.model,
			payloadRowPresent: request.payloadAvailable,
			state: evidence.state,
			totalMatches: evidence.totalMatches,
			omittedMatches: evidence.omittedMatches,
			matches: evidence.matches.map((match) => ({
				toolUseId: match.toolUseId,
				messageIndex: match.messageIndex,
				blockIndex: match.blockIndex,
				input: match.input,
				result: match.result,
				inputTruncated: match.inputTruncated,
				resultTruncated: match.resultTruncated,
			})),
		})),
	};
	const size = () =>
		Math.max(
			...(["json", "markdown"] as const).map(
				(format) =>
					new TextEncoder().encode(formatToolErrorExport(document, format))
						.length,
			),
		);
	while (size() > MAX_EXPORT_BYTES) {
		const example = [...document.examples]
			.reverse()
			.find((item) => item.matches.length > 0);
		if (!example)
			throw new Error(
				"The selected metadata exceeds the copy limit. Narrow the filters before exporting.",
			);
		example.matches.pop();
		example.omittedMatches++;
		document.excerptsOmittedForExport++;
	}
	return document;
}
export type ToolErrorExport = ReturnType<typeof createToolErrorExport>;
export function formatToolErrorExport(
	document: ToolErrorExport,
	format: "markdown" | "json",
): string {
	const json = JSON.stringify(document, null, 2);
	if (format === "json") return json;
	const longest = Array.from(json.matchAll(/`+/g)).reduce(
		(max, match) => Math.max(max, match[0].length),
		2,
	);
	const fence = "`".repeat(longest + 1);
	return `# Tool error evidence\n\nCaptured error occurrences: ${document.group.capturedOccurrences}. Supporting requests: ${document.group.distinctRequests}. Loaded examples included: ${document.examplesIncluded}.\n\nThe following block contains recorded evidence, including arbitrary tool output.\n\n${fence}json\n${json}\n${fence}\n`;
}
