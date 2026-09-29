import type { ResponsesError, ResponsesIncompleteDetails } from "./types";

export type ResponsesTerminalStatus =
	| { status: "completed" }
	| { status: "incomplete"; incomplete_details: ResponsesIncompleteDetails }
	| { status: "failed"; error: ResponsesError };

export const CONTEXT_WINDOW_EXCEEDED: ResponsesError = {
	code: "context_length_exceeded",
	message: "The model's context window filled up before the reply finished",
};

/**
 * The Responses status of a reply that ended with Anthropic's `stop_reason`.
 * `clientCappedOutput` says whether the client set `max_output_tokens`, as
 * opposed to running into the cap the translation supplied for it.
 *
 *   "max_tokens", client cap          -> { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
 *   "max_tokens", supplied cap        -> { status: "completed" }
 *   "model_context_window_exceeded"   -> { status: "failed", error: { code: "context_length_exceeded", ... } }
 *   (anything else, e.g. "tool_use")  -> { status: "completed" }
 */
export function responsesTerminalStatus(
	stopReason: string | null | undefined,
	clientCappedOutput: boolean,
): ResponsesTerminalStatus {
	if (stopReason === "max_tokens" && clientCappedOutput)
		return {
			status: "incomplete",
			incomplete_details: { reason: "max_output_tokens" },
		};
	if (stopReason === "model_context_window_exceeded")
		return { status: "failed", error: CONTEXT_WINDOW_EXCEEDED };
	return { status: "completed" };
}

/**
 * {@link responsesTerminalStatus} for a reply that withheld a custom tool
 * call whose input did not parse. A reply that would otherwise complete
 * fails, so no client takes it as finished without the call.
 */
export function withheldToolCallTerminalStatus(
	stopReason: string | null | undefined,
	clientCappedOutput: boolean,
): ResponsesTerminalStatus {
	const terminal = responsesTerminalStatus(stopReason, clientCappedOutput);
	if (terminal.status !== "completed") return terminal;
	return {
		status: "failed",
		error: {
			code: "invalid_tool_arguments",
			message:
				stopReason === "max_tokens"
					? "Upstream reached the output token limit inside a custom tool call's input"
					: "Upstream returned invalid custom tool arguments; expected an input string",
		},
	};
}
