import { ValidationError } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	type Account,
	isAnthropicServerTool,
	quotedToolType,
} from "@clankermux/types";
import { anthropicImageUrl, documentRemovalMarker } from "./attachments";
import { resolveReasoningEffort } from "./reasoning";
import type {
	AnthropicContent,
	AnthropicContentBlock,
	AnthropicImageContent,
	AnthropicRequest,
	AnthropicResponse,
	AnthropicTextContent,
	AnthropicThinkingContent,
	AnthropicToolResult,
	AnthropicToolUse,
	OpenAIContentPart,
	OpenAIMessage,
	OpenAIRequest,
	OpenAIResponse,
	OpenAIUsage,
} from "./types";
import { normalizeCacheInclusiveInput, readPromptTokensDetails } from "./usage";
import {
	mapOpenAIFinishReason,
	readReasoningText,
	removeUriFormat,
} from "./utils";

const log = new Logger("openai-formats/converters");

/**
 * Safely parse JSON with error handling
 */
export function safeParseJSON(jsonString: string): unknown {
	try {
		return JSON.parse(jsonString);
	} catch (error) {
		log.warn(`Failed to parse JSON: ${jsonString}`, error);
		return {};
	}
}

/**
 * Strip cache_control from all system message content blocks and user/assistant
 * message content blocks in an already-converted OpenAI request body.
 * Used for providers that reject unknown fields (e.g. GLM-5.1).
 */
export function stripCacheControlFromOpenAIRequest(body: OpenAIRequest): void {
	if (!Array.isArray(body.messages)) return;
	for (const msg of body.messages) {
		if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (typeof part === "object" && part !== null) {
					delete part.cache_control;
				}
			}
		}
	}
}

const TOOL_IMAGE_PLACEHOLDER = "[image attached in the following message]";

function toImagePart(block: AnthropicImageContent): OpenAIContentPart {
	return {
		type: "image_url",
		image_url: { url: anthropicImageUrl(block.source) },
	};
}

function contentParts(content: OpenAIMessage["content"]): OpenAIContentPart[] {
	if (Array.isArray(content)) return content;
	return content ? [{ type: "text", text: content }] : [];
}

/**
 * Convert Anthropic request format to OpenAI format
 */
export function convertAnthropicRequestToOpenAI(
	anthropicData: AnthropicRequest,
	_account?: Account,
): OpenAIRequest {
	// Routing has already resolved the model; format conversion preserves it.
	const mappedModel = anthropicData.model;

	const openaiRequest: OpenAIRequest = {
		model: mappedModel,
		messages: [],
	};

	// Map parameters
	if (anthropicData.max_tokens !== undefined) {
		openaiRequest.max_tokens = anthropicData.max_tokens;
	}
	if (anthropicData.temperature !== undefined) {
		openaiRequest.temperature = anthropicData.temperature;
	}
	if (anthropicData.top_p !== undefined) {
		openaiRequest.top_p = anthropicData.top_p;
	}
	if (anthropicData.stop_sequences !== undefined) {
		openaiRequest.stop = anthropicData.stop_sequences;
	}
	if (anthropicData.stream !== undefined) {
		openaiRequest.stream = anthropicData.stream;
		if (anthropicData.stream) {
			openaiRequest.stream_options = { include_usage: true };
		}
	}
	const reasoningResolution = resolveReasoningEffort(
		anthropicData.reasoning?.effort,
		{
			sourceModel: anthropicData.model,
			targetModel: mappedModel,
		},
	);
	if (reasoningResolution.downgrades.length > 0) {
		for (const downgrade of reasoningResolution.downgrades) {
			log.warn(
				`Downgraded reasoning effort for model ${downgrade.model}: ${downgrade.from} -> ${downgrade.to}`,
			);
		}
	}
	if (reasoningResolution.effort !== undefined) {
		openaiRequest.reasoning = { effort: reasoningResolution.effort };
	}

	// Convert tools (only if non-empty — Qwen/DashScope rejects empty tools array)
	if (
		anthropicData.tools &&
		Array.isArray(anthropicData.tools) &&
		anthropicData.tools.length > 0
	) {
		// Backstop: route construction keeps these requests away from
		// OpenAI-compatible accounts (resolved-route.test.ts).
		const serverTool = anthropicData.tools.find(isAnthropicServerTool);
		if (serverTool)
			throw new ValidationError(
				`Tool type ${quotedToolType(serverTool.type)} is not supported on OpenAI-compatible accounts; only custom tools are`,
			);
		openaiRequest.tools = anthropicData.tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: removeUriFormat(tool.input_schema) as Record<
					string,
					unknown
				>,
			},
		}));
	}

	// Convert tool_choice — only emit when tools are present (OpenAI spec requirement)
	if (anthropicData.tool_choice !== undefined && openaiRequest.tools?.length) {
		const tc = anthropicData.tool_choice;
		if (tc.type === "auto") {
			openaiRequest.tool_choice = "auto";
		} else if (tc.type === "any") {
			openaiRequest.tool_choice = "required";
		} else if (tc.type === "none") {
			openaiRequest.tool_choice = "none";
		} else if (tc.type === "tool") {
			openaiRequest.tool_choice = {
				type: "function",
				function: { name: tc.name },
			};
		}
	}

	// Handle system message (Anthropic has it as top-level, OpenAI has it in messages array)
	const messages: OpenAIMessage[] = [];
	if (anthropicData.system) {
		messages.push({
			role: "system",
			content:
				typeof anthropicData.system === "string"
					? anthropicData.system
					: anthropicData.system
							.filter(
								(
									b,
								): b is {
									type: string;
									text: string;
									cache_control?: { type: string };
								} => b.type === "text" && typeof b.text === "string",
							)
							.map((b) => {
								// Preserve cache_control for prompt caching.
								// DashScope (Qwen) uses this for ephemeral cache.
								// Other OpenAI-compatible providers that don't
								// support it should safely ignore the unknown field.
								const part: {
									type: string;
									text: string;
									cache_control?: { type: string };
								} = { type: "text", text: b.text };
								if (b.cache_control) part.cache_control = b.cache_control;
								return part;
							}),
		});
	}

	// Add user/assistant messages
	if (anthropicData.messages && Array.isArray(anthropicData.messages)) {
		for (const message of anthropicData.messages) {
			// Handle content arrays (Anthropic supports rich content)
			if (Array.isArray(message.content)) {
				// Extract tool_use blocks
				const toolUseBlocks = message.content.filter(
					(item): item is AnthropicToolUse => item.type === "tool_use",
				);

				// Extract text content, preserving cache_control if present
				const textBlocks = message.content.filter(
					(part): part is AnthropicTextContent => part.type === "text",
				);
				const hasCacheControl = textBlocks.some((part) => part.cache_control);

				// Extract thinking blocks — needed for DeepSeek/reasoning providers
				// that require reasoning_content to be passed back in conversation history
				const thinkingBlocks = message.content.filter(
					(part): part is AnthropicThinkingContent => part.type === "thinking",
				);

				const toTextPart = (part: AnthropicTextContent): OpenAIContentPart => {
					const block: OpenAIContentPart = { type: "text", text: part.text };
					if (part.cache_control) block.cache_control = part.cache_control;
					return block;
				};
				if (
					message.role !== "user" &&
					message.content.some((part) => part?.type === "image")
				) {
					throw new ValidationError(
						`image content is only supported on user messages, not ${message.role}`,
					);
				}
				const hasAttachments = message.content.some(
					(part) => part?.type === "image" || part?.type === "document",
				);

				let content: OpenAIMessage["content"];
				if (hasAttachments) {
					// Text, images and document markers keep the client's order.
					content = [];
					for (const part of message.content) {
						if (part?.type === "text") content.push(toTextPart(part));
						else if (part?.type === "image") content.push(toImagePart(part));
						else if (part?.type === "document") {
							content.push({
								type: "text",
								text: documentRemovalMarker(part.source?.media_type),
							});
						}
					}
				} else if (hasCacheControl) {
					content = textBlocks.map(toTextPart);
				} else {
					content = textBlocks.map((part) => part.text).join("") || null;
				}

				// Create OpenAI message with tool calls if present
				const openaiMessage: OpenAIMessage = {
					role: message.role,
					content,
				};

				if (toolUseBlocks.length > 0) {
					openaiMessage.tool_calls = toolUseBlocks.map((toolCall) => ({
						id: toolCall.id,
						type: "function",
						function: {
							name: toolCall.name,
							arguments: JSON.stringify(toolCall.input || {}),
						},
					}));
				}

				// Pass reasoning_content back for providers that require it (e.g. DeepSeek)
				if (thinkingBlocks.length > 0) {
					openaiMessage.reasoning_content = thinkingBlocks
						.map((b) => b.thinking)
						.join("");
				}

				// Handle tool_result blocks as separate 'tool' role messages.
				// Must be pushed BEFORE any accompanying text content so that
				// tool messages immediately follow the assistant's tool_calls message
				// (required by DeepSeek and OpenAI spec).
				const toolResults = message.content.filter(
					(item): item is AnthropicToolResult => item.type === "tool_result",
				);
				// A `tool` message is text-only, so its images travel in the user
				// message that follows this turn's tool messages.
				const toolImages: OpenAIContentPart[] = [];
				for (const toolResult of toolResults) {
					let toolContent: string;
					if (typeof toolResult.content === "string") {
						toolContent = toolResult.content;
					} else if (Array.isArray(toolResult.content)) {
						const parts: string[] = [];
						for (const block of toolResult.content as AnthropicContent[]) {
							if (block.type === "text") {
								parts.push(block.text);
							} else if (block.type === "image") {
								toolImages.push(toImagePart(block));
								parts.push(TOOL_IMAGE_PLACEHOLDER);
							} else {
								// Other structured blocks (tool_use, tool_result, etc.) — serialize as JSON
								parts.push(JSON.stringify(block));
							}
						}
						toolContent = parts.join("\n");
					} else {
						toolContent = "";
					}
					messages.push({
						role: "tool",
						content: toolContent,
						tool_call_id: toolResult.tool_use_id,
					});
				}

				if (toolImages.length > 0) {
					if (message.role === "user") {
						openaiMessage.content = [
							...toolImages,
							...contentParts(openaiMessage.content),
						];
					} else {
						messages.push({ role: "user", content: toolImages });
					}
				}

				if (
					openaiMessage.content === null &&
					!openaiMessage.tool_calls &&
					thinkingBlocks.length > 0
				) {
					// Preserve thinking-only assistant turns while keeping
					// OpenAI assistant content non-null.
					openaiMessage.content = "";
				}

				if (
					(openaiMessage.content !== null &&
						openaiMessage.content !== undefined) ||
					openaiMessage.tool_calls
				) {
					messages.push(openaiMessage);
				}
			} else {
				// Simple string content
				messages.push({
					role: message.role,
					content: message.content,
				});
			}
		}
	}

	openaiRequest.messages = messages;
	return openaiRequest;
}

/**
 * Convert OpenAI response format to Anthropic format.
 *
 * `sentModel` is what this proxy put on the wire, used only where upstream
 * names no model of its own. With neither naming one the field stays absent.
 */
export function convertOpenAIResponseToAnthropic(
	openaiData: OpenAIResponse,
	sentModel?: string,
): AnthropicResponse {
	// Handle error responses
	if (openaiData.error) {
		return {
			type: "error",
			error: {
				type: openaiData.error.type || "api_error",
				message: openaiData.error.message || "An error occurred",
			},
		};
	}

	// Handle successful responses
	const choice = openaiData.choices?.[0];
	if (!choice) {
		return {
			type: "error",
			error: {
				type: "invalid_response",
				message: "Invalid response format from OpenAI provider",
			},
		};
	}

	// Build content array with text and tool calls
	const content: AnthropicContentBlock[] = [];

	// Thinking leads per Anthropic block ordering, matching stream.ts.
	const reasoning = readReasoningText(choice.message);
	if (reasoning) {
		content.push({ type: "thinking", thinking: reasoning });
	}

	// Add text content if present
	if (choice.message?.content) {
		content.push({
			type: "text",
			text: choice.message.content,
		});
	}

	// Add tool calls if present
	const toolCalls = choice.message?.tool_calls || [];
	for (const toolCall of toolCalls) {
		content.push({
			type: "tool_use",
			id: toolCall.id,
			name: toolCall.function.name,
			input: safeParseJSON(toolCall.function.arguments || "{}") as Record<
				string,
				unknown
			>,
		});
	}

	return {
		id: openaiData.id || `msg_${Date.now()}`,
		type: "message",
		role: "assistant",
		content,
		model: openaiData.model || sentModel,
		stop_reason: mapOpenAIFinishReason(choice.finish_reason),
		stop_sequence: undefined,
		usage: {
			...normalizedInput(openaiData.usage),
			output_tokens: openaiData.usage?.completion_tokens || 0,
		},
	};
}

/**
 * The cache counters live in `prompt_tokens_details` on this path too, and the
 * streaming path publishes them, so a client must not see the same account
 * report a different convention depending on `stream`.
 */
function normalizedInput(usage: OpenAIUsage | undefined): {
	input_tokens: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
} {
	const details = readPromptTokensDetails(usage?.prompt_tokens_details);
	const input = normalizeCacheInclusiveInput(
		usage?.prompt_tokens || 0,
		details.cacheReadInputTokens ?? 0,
		details.cacheCreationInputTokens ?? 0,
	);
	// Counters that do not fit their own total are not a vector to repair: a
	// clamped figure is the proxy's arithmetic published under the provider's
	// name, and nothing downstream can tell it from a real one. Report the
	// prompt total the provider stated and no cache claim at all.
	if (input.clamped) return { input_tokens: usage?.prompt_tokens || 0 };

	// Each cache field rides on ITS OWN counter, not on the details object: a
	// body reporting `cached_tokens` alone says nothing about cache writes, and
	// publishing a 0 for the other would be a count upstream never stated.
	return {
		input_tokens: input.inputTokens,
		...(details.cacheReadInputTokens === undefined
			? {}
			: { cache_read_input_tokens: input.cacheReadInputTokens }),
		...(details.cacheCreationInputTokens === undefined
			? {}
			: { cache_creation_input_tokens: input.cacheCreationInputTokens }),
	};
}
