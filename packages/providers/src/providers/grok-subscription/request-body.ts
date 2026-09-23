import { hoistConversationEffortUpdates } from "../../conversation-effort";

type Block = Record<string, unknown>;
type Message = { role?: unknown; content?: unknown; [key: string]: unknown };

/**
 * The proxy's schema validator rejects a tool whose `input_schema` has no
 * top-level `required` (400 `/required: null is not of type "array"`), which
 * Anthropic accepts and Claude Code sends for tools without mandatory
 * arguments. `required: []` means the same thing and passes.
 */
function fillToolSchemaRequired(body: Record<string, unknown>): number {
	if (!Array.isArray(body.tools)) return 0;
	let patched = 0;
	for (const tool of body.tools) {
		const schema = (tool as { input_schema?: unknown })?.input_schema;
		if (
			!schema ||
			typeof schema !== "object" ||
			Array.isArray((schema as { required?: unknown }).required)
		)
			continue;
		(schema as { required: unknown[] }).required = [];
		patched++;
	}
	return patched;
}

function asBlocks(content: unknown): Block[] {
	if (typeof content === "string")
		return content ? [{ type: "text", text: content }] : [];
	return Array.isArray(content) ? (content as Block[]) : [];
}

function reminderBlocks(content: unknown): Block[] {
	return asBlocks(content).map((block) =>
		block.type === "text" && typeof block.text === "string"
			? {
					...block,
					text: `<system-reminder>\n${block.text}\n</system-reminder>`,
				}
			: block,
	);
}

/**
 * The proxy intermittently answers any request holding a `role: "system"`
 * message with 400 "Invalid message role", wherever the message sits. Each one
 * is moved, in order, into the adjacent user turn as a `<system-reminder>`
 * block: appended to the user turn before it, else prepended to the user turn
 * after it, else sent as a user turn of its own. Effort updates carried on such
 * messages move to the request's `output_config` first.
 */
function foldSystemMessages(body: Record<string, unknown>): number {
	if (!Array.isArray(body.messages)) return 0;
	const messages = body.messages as Message[];
	if (!messages.some((m) => m?.role === "system")) return 0;
	hoistConversationEffortUpdates(body);
	const out: Message[] = [];
	let pending: Block[] = [];
	let folded = 0;
	for (const message of body.messages as Message[]) {
		if (message?.role === "system") {
			folded++;
			const blocks = reminderBlocks(message.content);
			const last = out.at(-1);
			if (last?.role === "user" && !pending.length)
				last.content = [...asBlocks(last.content), ...blocks];
			else pending.push(...blocks);
			continue;
		}
		if (pending.length) {
			if (message?.role === "user") {
				// Tool results must stay first in the turn that answers a tool call.
				const content = asBlocks(message.content);
				const results = content.findIndex((b) => b.type !== "tool_result");
				const split = results === -1 ? content.length : results;
				out.push({
					...message,
					content: [
						...content.slice(0, split),
						...pending,
						...content.slice(split),
					],
				});
			} else out.push({ role: "user", content: pending }, message);
			pending = [];
			continue;
		}
		out.push(message);
	}
	if (pending.length) out.push({ role: "user", content: pending });
	body.messages = out;
	return folded;
}

/** Rewrite a Messages request into the shape the Grok chat proxy accepts. */
export function normalizeGrokRequestBody(
	body: Record<string, unknown>,
): boolean {
	const tools = fillToolSchemaRequired(body);
	const system = foldSystemMessages(body);
	return tools + system > 0;
}
