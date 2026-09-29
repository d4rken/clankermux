import type { ResponsesIncompleteDetails } from "./types";

export type ResponsesTerminalStatus =
	| { status: "completed" }
	| { status: "incomplete"; incomplete_details: ResponsesIncompleteDetails };

const INCOMPLETE_REASONS: ReadonlyMap<
	string,
	ResponsesIncompleteDetails["reason"]
> = new Map([
	["max_tokens", "max_output_tokens"],
	["model_context_window_exceeded", "max_output_tokens"],
	["refusal", "content_filter"],
]);

/**
 * The Responses status of a reply that ended with Anthropic's `stop_reason`.
 *
 *   "max_tokens" -> { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
 *   "refusal"    -> { status: "incomplete", incomplete_details: { reason: "content_filter" } }
 *   "tool_use"   -> { status: "completed" }
 */
export function responsesTerminalStatus(
	stopReason: string | null | undefined,
): ResponsesTerminalStatus {
	const reason =
		typeof stopReason === "string"
			? INCOMPLETE_REASONS.get(stopReason)
			: undefined;
	return reason
		? { status: "incomplete", incomplete_details: { reason } }
		: { status: "completed" };
}
