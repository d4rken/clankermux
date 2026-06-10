import type { ContextComposition, ToolCallStat } from "@clankermux/types";
import type { RequestJsonBody } from "./request-body-context";

/**
 * Ingest-time context-composition walk: per-bucket character counts (system
 * prompt / tool definitions / messages / tool results) computed from the
 * ALREADY-parsed /v1/messages body — no JSON.parse anywhere in this module,
 * at most one JSON.stringify per non-text content block.
 *
 * Char counts are proportions, not tokens. Defensive throughout: malformed
 * shapes contribute 0 and the walk never throws; a shapeless body (no
 * `messages` array) returns null, which is the NULL-column coverage marker.
 *
 * The same walk also yields per-tool call/error stats from the FINAL message
 * only (each request re-sends the whole conversation, so earlier messages'
 * tool_results were already counted by previous requests — the last message
 * is the one new turn). Tool names resolve via the full-history
 * tool_use_id → tool_use.name map built during the walk.
 */

/** Truncation cap for captured tool error texts. */
const ERROR_TEXT_MAX_CHARS = 500;

/** Per-tool cap on captured error samples (errors beyond this still count). */
const MAX_ERROR_SAMPLES = 3;

/** JSON.stringify length, 0 for unstringifiable values (circular refs, undefined). */
function safeJsonLength(value: unknown): number {
	try {
		const json = JSON.stringify(value);
		return typeof json === "string" ? json.length : 0;
	} catch {
		return 0;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** System prompt chars: string length, or summed text-block lengths (see
 * extractSystemPrompt in project-extraction.ts for the accepted shape). */
function computeSystemChars(system: unknown): number {
	if (typeof system === "string") return system.length;
	if (!Array.isArray(system)) return 0;
	let total = 0;
	for (const item of system) {
		if (
			isRecord(item) &&
			item.type === "text" &&
			typeof item.text === "string"
		) {
			total += item.text.length;
		}
	}
	return total;
}

/** Error text for a tool_result block: string content as-is, array content as
 * joined `type:"text"` block texts; anything else yields "" (the error still
 * counts, the sample is just skipped). Truncated to ERROR_TEXT_MAX_CHARS. */
function extractErrorText(content: unknown): string {
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const item of content) {
			if (
				isRecord(item) &&
				item.type === "text" &&
				typeof item.text === "string"
			) {
				parts.push(item.text);
			}
		}
		text = parts.join("\n");
	}
	return text.slice(0, ERROR_TEXT_MAX_CHARS);
}

/** Per-tool call/error stats for the FINAL message only. Returns null when it
 * contains no tool_result blocks (so non-tool turns produce no stats rows). */
function extractFinalMessageToolStats(
	lastMessage: unknown,
	toolNamesByUseId: Map<string, string>,
): ToolCallStat[] | null {
	if (!isRecord(lastMessage) || !Array.isArray(lastMessage.content)) {
		return null;
	}

	// Insertion-ordered (Map iteration order) per-tool accumulator.
	const statsByTool = new Map<string, ToolCallStat>();

	for (const block of lastMessage.content) {
		if (!isRecord(block) || block.type !== "tool_result") continue;

		const toolName =
			(typeof block.tool_use_id === "string"
				? toolNamesByUseId.get(block.tool_use_id)
				: undefined) ?? "unknown";

		let stat = statsByTool.get(toolName);
		if (!stat) {
			stat = { toolName, callCount: 0, errorCount: 0, errorSamples: [] };
			statsByTool.set(toolName, stat);
		}
		stat.callCount++;

		// Strict boolean check: truthy non-booleans ("true", 1) are NOT errors.
		if (block.is_error !== true) continue;
		stat.errorCount++;
		if (stat.errorSamples.length < MAX_ERROR_SAMPLES) {
			const sample = extractErrorText(block.content);
			if (sample.trim().length > 0) {
				stat.errorSamples.push(sample);
			}
		}
	}

	if (statsByTool.size === 0) return null;
	return Array.from(statsByTool.values());
}

export function computeContextAndToolStats(body: RequestJsonBody | null): {
	composition: ContextComposition | null;
	toolStats: ToolCallStat[] | null;
} {
	if (!body || !Array.isArray(body.messages)) {
		return { composition: null, toolStats: null };
	}

	let systemChars = 0;
	let toolsChars = 0;
	let toolCount = 0;
	let messagesChars = 0;
	let toolResultChars = 0;
	let largestToolResultChars = 0;
	let largestToolUseId: string | null = null;

	systemChars = computeSystemChars(body.system);

	if (Array.isArray(body.tools)) {
		toolsChars = safeJsonLength(body.tools);
		toolCount = body.tools.length;
	}

	// Single pass over messages: tool_use blocks register their id → name
	// mapping before the tool_result that references them appears (assistant
	// tool_use always precedes its tool_result in the conversation).
	const toolNamesByUseId = new Map<string, string>();

	for (const message of body.messages) {
		if (!isRecord(message)) continue;
		const content = message.content;
		if (typeof content === "string") {
			messagesChars += content.length;
			continue;
		}
		if (!Array.isArray(content)) continue;

		for (const block of content) {
			if (!isRecord(block)) continue;

			if (block.type === "text" && typeof block.text === "string") {
				messagesChars += block.text.length;
				continue;
			}

			// Non-text blocks (tool_use input, tool_result content, images):
			// JSON.stringify length — consistent, cheap, deterministic.
			const chars = safeJsonLength(block);
			messagesChars += chars;

			if (block.type === "tool_use" && typeof block.id === "string") {
				if (typeof block.name === "string") {
					toolNamesByUseId.set(block.id, block.name);
				}
			} else if (block.type === "tool_result") {
				toolResultChars += chars;
				if (chars > largestToolResultChars) {
					largestToolResultChars = chars;
					largestToolUseId =
						typeof block.tool_use_id === "string" ? block.tool_use_id : null;
				}
			}
		}
	}

	const composition: ContextComposition = {
		systemChars,
		toolsChars,
		toolCount,
		messagesChars,
		messageCount: body.messages.length,
		toolResultChars,
		largestToolResultChars,
		largestToolName:
			largestToolUseId !== null
				? (toolNamesByUseId.get(largestToolUseId) ?? null)
				: null,
	};

	return {
		composition,
		toolStats: extractFinalMessageToolStats(
			body.messages[body.messages.length - 1],
			toolNamesByUseId,
		),
	};
}
