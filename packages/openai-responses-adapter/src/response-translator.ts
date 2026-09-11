import type {
	AnthropicResponse,
	OutputFunctionCallItem,
	OutputMessageItem,
	ResponsesResponse,
} from "./types";
import { translateAnthropicUsage } from "./usage";

export function translateAnthropicResponseToResponses(
	resp: AnthropicResponse,
	responseId: string,
	model: string,
): ResponsesResponse {
	const output: ResponsesResponse["output"] = [];

	let outputIdx = 0;
	for (const block of resp.content) {
		if (block.type === "text") {
			const msgItem: OutputMessageItem = {
				type: "message",
				id: `${responseId}_msg_${outputIdx}`,
				role: "assistant",
				content: [{ type: "output_text", text: block.text }],
				status: "completed",
			};
			output.push(msgItem);
			outputIdx++;
		} else if (block.type === "tool_use") {
			const fcItem: OutputFunctionCallItem = {
				type: "function_call",
				id: `${responseId}_fc_${outputIdx}`,
				call_id: block.id,
				name: block.name,
				arguments: JSON.stringify(block.input),
				status: "completed",
			};
			output.push(fcItem);
			outputIdx++;
		}
	}

	return {
		id: responseId,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		model,
		status: "completed",
		output,
		usage: translateAnthropicUsage(resp.usage),
	};
}
