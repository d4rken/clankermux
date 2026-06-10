import type { ContextComposition } from "@clankermux/types";
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
 */

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

export function computeContextComposition(
	body: RequestJsonBody | null,
): ContextComposition | null {
	if (!body || !Array.isArray(body.messages)) return null;

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

	return {
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
}
