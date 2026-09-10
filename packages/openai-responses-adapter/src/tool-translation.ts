import { createHash } from "node:crypto";
import { Logger } from "@clankermux/logger";
import type { AnthropicTool, ResponsesRequest, ResponsesTool } from "./types";

export class ToolTranslationError extends Error {}

export interface ToolIdentity {
	type: "function" | "custom";
	name: string;
	namespace?: string;
}
const PREFIX = "cmux_tool_";
const log = new Logger("responses-tools");
const key = (id: ToolIdentity) =>
	JSON.stringify([id.namespace ?? null, id.name, id.type]);

/** Request-scoped lookup; names never depend on declaration order or decode by splitting. */
export class ToolTranslation {
	readonly tools: AnthropicTool[] = [];
	private identities = new Map<string, ToolIdentity>();
	private definitions = new Map<string, number>();
	name(id: ToolIdentity): string {
		const name =
			id.type === "function" &&
			!id.namespace &&
			!id.name.startsWith(PREFIX) &&
			/^[a-zA-Z0-9_-]{1,64}$/.test(id.name)
				? id.name
				: PREFIX +
					createHash("sha256").update(key(id)).digest("hex").slice(0, 48);
		const existing = this.identities.get(name);
		if (existing && key(existing) !== key(id))
			throw new ToolTranslationError("Tool identity collision");
		this.identities.set(name, id);
		return name;
	}
	identity(name: string): ToolIdentity {
		return this.identities.get(name) ?? { type: "function", name };
	}
	add(
		tools: ResponsesTool[],
		namespace?: string,
		namespaceDescription?: string,
	): void {
		for (const tool of tools) {
			if (tool.type === "namespace") {
				if (namespace !== undefined)
					throw new ToolTranslationError(
						"Nested tool namespaces are not supported",
					);
				this.add(tool.tools, tool.name, tool.description);
				continue;
			}
			if (tool.type !== "function" && tool.type !== "custom") {
				log.warn(`Skipping unsupported/built-in tool type: ${tool.type}`);
				continue;
			}
			const identity: ToolIdentity = {
				type: tool.type,
				name: tool.name,
				...(namespace ? { namespace } : {}),
			};
			const name = this.name(identity);
			const description = [namespaceDescription, tool.description];
			if (tool.type === "custom") {
				description.push(
					"Supply the raw tool input as the input string. Do not wrap it in Markdown.",
				);
				if (tool.format)
					description.push(
						`Requested input format (descriptive; constrained decoding is unavailable on this translation): ${JSON.stringify(tool.format)}`,
					);
			}
			const translated: AnthropicTool = {
				name,
				description: description.filter(Boolean).join("\n\n") || undefined,
				input_schema:
					tool.type === "function"
						? (tool.parameters ?? {})
						: {
								type: "object",
								properties: { input: { type: "string" } },
								required: ["input"],
								additionalProperties: false,
							},
			};
			const index = this.definitions.get(name);
			if (index === undefined) {
				this.definitions.set(name, this.tools.length);
				this.tools.push(translated);
			} else this.tools[index] = translated;
		}
	}
}

export function createToolTranslation(req: ResponsesRequest): ToolTranslation {
	const result = new ToolTranslation();
	result.add(req.tools ?? []);
	if (Array.isArray(req.input))
		for (const item of req.input) {
			if (item.type === "additional_tools") result.add(item.tools);
			if (item.type === "function_call" || item.type === "custom_tool_call")
				result.name({
					type: item.type === "function_call" ? "function" : "custom",
					name: item.name,
					...(item.namespace ? { namespace: item.namespace } : {}),
				});
		}
	return result;
}

/** Never turn a malformed custom invocation into a successful empty tool call. */
export function customToolInput(input: unknown): string {
	if (
		!input ||
		typeof input !== "object" ||
		!("input" in input) ||
		typeof input.input !== "string"
	)
		throw new Error("Invalid custom tool arguments: expected an input string");
	return input.input;
}
