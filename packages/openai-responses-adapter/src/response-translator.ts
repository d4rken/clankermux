import {
	urlCitationsOf,
	webSearchCallItem,
	webSearchQueryOf,
	webSearchResultOf,
} from "./hosted-web-search";
import { responsesTerminalStatus } from "./terminal-status";
import { customToolInput, type ToolTranslation } from "./tool-translation";
import type {
	AnthropicResponse,
	OutputFunctionCallItem,
	OutputMessageItem,
	OutputWebSearchCallItem,
	ResponsesResponse,
} from "./types";
import { translateAnthropicUsage } from "./usage";

export function translateAnthropicResponseToResponses(
	resp: AnthropicResponse,
	responseId: string,
	model: string,
	tools?: ToolTranslation,
	options: { includeSources?: boolean; clientCappedOutput?: boolean } = {},
): ResponsesResponse {
	const output: ResponsesResponse["output"] = [];
	/** Hosted searches by tool_use id, until their result fills their slot. */
	const searches = new Map<string, { index: number; query: string | null }>();

	let outputIdx = 0;
	for (const block of resp.content) {
		if (block.type === "text") {
			const annotations = urlCitationsOf(
				(block as { citations?: unknown }).citations,
				block.text,
			);
			const msgItem: OutputMessageItem = {
				type: "message",
				id: `${responseId}_msg_${outputIdx}`,
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: block.text,
						...(annotations.length ? { annotations } : {}),
					},
				],
				status: "completed",
			};
			output.push(msgItem);
			outputIdx++;
		} else if (block.type === "server_tool_use") {
			if (block.name !== "web_search") continue;
			const query = webSearchQueryOf(block.input);
			searches.set(block.id, { index: output.length, query });
			output.push(
				webSearchCallItem({
					id: `${responseId}_ws_${outputIdx}`,
					query,
					status: "failed",
					sources: [],
					includeSources: options.includeSources ?? false,
				}) as unknown as OutputWebSearchCallItem,
			);
			outputIdx++;
		} else if (block.type === "web_search_tool_result") {
			const search = searches.get(block.tool_use_id);
			if (!search) continue;
			searches.delete(block.tool_use_id);
			const result = webSearchResultOf(block.content);
			const placed = output[search.index] as OutputWebSearchCallItem;
			output[search.index] = webSearchCallItem({
				id: placed.id,
				query: search.query,
				status: result.ok ? "completed" : "failed",
				sources: result.ok ? result.sources : [],
				includeSources: options.includeSources ?? false,
			}) as unknown as OutputWebSearchCallItem;
		} else if (block.type === "tool_use") {
			const identity = tools?.identity(block.name) ?? {
				type: "function",
				name: block.name,
			};
			if (identity.type === "custom") {
				output.push({
					type: "custom_tool_call",
					id: `${responseId}_fc_${outputIdx}`,
					call_id: block.id,
					name: identity.name,
					...(identity.namespace ? { namespace: identity.namespace } : {}),
					input: customToolInput(block.input),
					status: "completed",
				});
				outputIdx++;
				continue;
			}
			const fcItem: OutputFunctionCallItem = {
				type: "function_call",
				id: `${responseId}_fc_${outputIdx}`,
				call_id: block.id,
				name: identity.name,
				...(identity.namespace ? { namespace: identity.namespace } : {}),
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
		model: resp.model || model,
		...responsesTerminalStatus(
			resp.stop_reason,
			options.clientCappedOutput ?? false,
		),
		output,
		usage: translateAnthropicUsage(resp.usage),
	};
}
