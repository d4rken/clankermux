import { Logger } from "@clankermux/logger";
import {
	createToolTranslation,
	type ToolTranslation,
} from "./tool-translation";
import type {
	AnthropicContent,
	AnthropicMessage,
	AnthropicRequest,
	AnthropicToolChoice,
	AnthropicToolResultContent,
	ResponseItem,
	ResponsesRequest,
} from "./types";

const logger = new Logger("openai-responses-adapter");

/** JSON text for a value, or "" if it cannot be stringified (circular refs). */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

function parseArguments(args: string): unknown {
	try {
		return JSON.parse(args);
	} catch {
		return {};
	}
}

function translateToolChoice(
	choice: ResponsesRequest["tool_choice"],
	tools: ToolTranslation,
): AnthropicToolChoice | undefined {
	if (choice === undefined) return undefined;
	if (choice === "auto") return { type: "auto" };
	if (choice === "required") return { type: "any" };
	if (choice === "none") return { type: "none" };
	if (
		typeof choice === "object" &&
		(choice.type === "function" || choice.type === "custom")
	) {
		return { type: "tool", name: tools.name(choice) };
	}
	return undefined;
}

function translateContentItem(c: {
	type: string;
	text?: string;
	refusal?: string;
	image_url?: string;
	file_id?: string;
}): AnthropicContent {
	if (c.type === "input_text" || c.type === "output_text") {
		return { type: "text", text: c.text ?? "" };
	}

	if (c.type === "refusal") {
		return { type: "text", text: c.refusal ?? "" };
	}

	if (c.type === "input_image") {
		const imageUrl = c.image_url;
		if (typeof imageUrl === "string") {
			const trimmed = imageUrl.trim();
			const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(trimmed);
			if (dataUrlMatch) {
				return {
					type: "image",
					source: {
						type: "base64",
						media_type: dataUrlMatch[1],
						data: dataUrlMatch[2],
					},
				};
			}
			if (trimmed.length > 0) {
				return { type: "image", source: { type: "url", url: trimmed } };
			}
		}

		if (typeof c.file_id === "string" && c.file_id.length > 0) {
			return { type: "text", text: `[image file_id: ${c.file_id}]` };
		}

		return { type: "text", text: "[image content omitted]" };
	}

	// Preserve an unrecognised block instead of erasing it. Whatever it is still
	// occupies real context upstream — native passthrough forwards the ORIGINAL
	// Responses body verbatim — so returning "" would make the routing estimate
	// too SMALL and admit the request to an account it does not fit. That is the
	// same class of error as counting a screenshot's base64 as prompt text, just
	// in the opposite direction. Carrying the block's JSON keeps it measurable.
	logger.warn(`Unknown content type "${c.type}" — preserved verbatim as text`);
	return { type: "text", text: safeStringify(c) };
}

function mergeConsecutiveSameRole(
	messages: AnthropicMessage[],
): AnthropicMessage[] {
	const merged: AnthropicMessage[] = [];
	for (const msg of messages) {
		const last = merged[merged.length - 1];
		if (last && last.role === msg.role) {
			last.content.push(...msg.content);
		} else {
			merged.push({ role: msg.role, content: [...msg.content] });
		}
	}
	return merged;
}

export function translateRequestToAnthropic(
	req: ResponsesRequest & { input: ResponseItem[] },
	tools = createToolTranslation(req),
): AnthropicRequest {
	const messages: AnthropicMessage[] = [];
	const instructionBlocks: string[] = [];

	for (const item of req.input) {
		if (!item || typeof item !== "object")
			throw new Error("Invalid Responses message");
		if (item.type === "message" || item.type === undefined) {
			if (
				!["user", "assistant", "system", "developer"].includes(item.role) ||
				(typeof item.content !== "string" && !Array.isArray(item.content))
			)
				throw new Error("Invalid Responses message");
			const content: AnthropicContent[] =
				typeof item.content === "string"
					? [{ type: "text", text: item.content }]
					: item.content.map((c) => translateContentItem(c));
			// Easy input messages may omit type and use string content. Both
			// instruction roles belong in the Anthropic system prompt.
			if (item.role === "developer" || item.role === "system") {
				for (const c of content) {
					if (c.type === "text") instructionBlocks.push(c.text);
				}
				continue;
			}
			messages.push({ role: item.role, content });
			continue;
		}

		if (item.type === "function_call" || item.type === "custom_tool_call") {
			const toolUseBlock: AnthropicContent = {
				type: "tool_use",
				id: item.call_id,
				name: tools.name({
					type: item.type === "function_call" ? "function" : "custom",
					name: item.name,
					...(item.namespace ? { namespace: item.namespace } : {}),
				}),
				input:
					item.type === "custom_tool_call"
						? { input: item.input }
						: parseArguments(item.arguments),
			};
			const last = messages[messages.length - 1];
			if (last && last.role === "assistant") {
				last.content.push(toolUseBlock);
			} else {
				messages.push({ role: "assistant", content: [toolUseBlock] });
			}
			continue;
		}

		if (
			item.type === "function_call_output" ||
			item.type === "custom_tool_call_output"
		) {
			// `output` is a plain string for ordinary tool results, but an ARRAY of
			// Responses content items when the result carries an attachment — Codex
			// CLI returns a screenshot as [{input_text}, {input_image}]. Those items
			// go through the same translation as message content: forwarding them
			// verbatim leaves `input_image` blocks inside an Anthropic tool_result,
			// where measureContentBlock cannot recognise the attachment and prices
			// its base64 as prompt text.
			const content = Array.isArray(item.output)
				? item.output.map((c) => translateContentItem(c))
				: item.output;
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: item.call_id,
						content: content as AnthropicToolResultContent["content"],
					},
				],
			});
		}
	}

	const mergedMessages = mergeConsecutiveSameRole(messages);

	const result: AnthropicRequest = {
		// Routing owns model selection; preserve the requested identity here.
		model: req.model,
		messages: mergedMessages,
		max_tokens: req.max_output_tokens ?? 4096,
	};

	// Merge instruction messages and req.instructions into the system prompt.
	const systemParts: string[] = [];
	if (instructionBlocks.length > 0)
		systemParts.push(instructionBlocks.join("\n\n"));
	if (req.instructions !== undefined) systemParts.push(req.instructions);
	if (systemParts.length > 0) result.system = systemParts.join("\n\n");

	if (req.stream !== undefined) {
		result.stream = req.stream;
	}

	const translatedTools = tools.tools;
	if (translatedTools.length > 0) {
		result.tools = translatedTools;
		const toolChoice = translateToolChoice(req.tool_choice, tools);
		if (toolChoice !== undefined) {
			result.tool_choice = toolChoice;
		}
	}

	return result;
}
