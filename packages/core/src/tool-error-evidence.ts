import type {
	ToolErrorCallExcerpt,
	ToolErrorEvidence,
} from "@clankermux/types";

export const TOOL_ERROR_TEXT_MAX_CHARS = 500;
export const TOOL_ERROR_MAX_SAMPLES = 3;
export const TOOL_ERROR_EXCERPT_BYTES = 8192;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/** The stored sample uses UTF-16 slicing, preserving the ingestion identity. */
export function extractToolErrorText(
	content: unknown,
	maxChars = TOOL_ERROR_TEXT_MAX_CHARS,
): string {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content))
		text = content
			.filter(
				(item) =>
					isRecord(item) &&
					item.type === "text" &&
					typeof item.text === "string",
			)
			.map((item) => item.text)
			.join("\n");
	return text.slice(0, maxChars);
}

export function truncateToolEvidence(
	text: string,
	maxBytes = TOOL_ERROR_EXCERPT_BYTES,
): { text: string; truncated: boolean } {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= maxBytes) return { text, truncated: false };
	return {
		text: new TextDecoder().decode(bytes.subarray(0, maxBytes), {
			stream: true,
		}),
		truncated: true,
	};
}

/** Encode the WTF-8 text bytes used for SQLite bindings, including lone surrogates. */
export function toolErrorStorageHex(text: string): string {
	const bytes: number[] = [];
	for (const character of text) {
		const point = character.codePointAt(0) ?? 0;
		if (point < 0x80) bytes.push(point);
		else if (point < 0x800)
			bytes.push(0xc0 | (point >> 6), 0x80 | (point & 63));
		else if (point < 0x10000)
			bytes.push(
				0xe0 | (point >> 12),
				0x80 | ((point >> 6) & 63),
				0x80 | (point & 63),
			);
		else
			bytes.push(
				0xf0 | (point >> 18),
				0x80 | ((point >> 12) & 63),
				0x80 | ((point >> 6) & 63),
				0x80 | (point & 63),
			);
	}
	return bytes
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();
}

export function extractToolErrorEvidence(
	body: unknown,
	toolName: string,
	errorText: string,
	storedTextHex?: string,
): ToolErrorEvidence {
	const empty: ToolErrorEvidence = {
		state: "malformed",
		totalMatches: 0,
		matches: [],
		omittedMatches: 0,
	};
	if (!isRecord(body) || !Array.isArray(body.messages)) return empty;
	const uses = new Map<string, Record<string, unknown>>();
	for (const message of body.messages) {
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		for (const block of message.content)
			if (
				isRecord(block) &&
				block.type === "tool_use" &&
				typeof block.id === "string" &&
				typeof block.name === "string"
			)
				uses.set(block.id, block);
	}
	const messageIndex = body.messages.length - 1;
	const last = body.messages[messageIndex];
	const matches: ToolErrorCallExcerpt[] = [];
	let totalMatches = 0;
	if (isRecord(last) && Array.isArray(last.content)) {
		for (const [blockIndex, block] of last.content.entries()) {
			if (
				!isRecord(block) ||
				block.type !== "tool_result" ||
				block.is_error !== true
			)
				continue;
			const id =
				typeof block.tool_use_id === "string" ? block.tool_use_id : null;
			const use = id === null ? undefined : uses.get(id);
			if (
				(use?.name ?? "unknown") !== toolName ||
				(storedTextHex !== undefined
					? toolErrorStorageHex(extractToolErrorText(block.content)) !==
						storedTextHex
					: extractToolErrorText(block.content) !== errorText)
			)
				continue;
			totalMatches++;
			if (matches.length >= 3) continue;
			const input =
				use && "input" in use
					? truncateToolEvidence(JSON.stringify(use.input))
					: null;
			const result = truncateToolEvidence(
				extractToolErrorText(block.content, Number.MAX_SAFE_INTEGER),
			);
			matches.push({
				toolUseId: id,
				messageIndex,
				blockIndex,
				input: input?.text ?? null,
				result: result.text,
				inputTruncated: input?.truncated ?? false,
				resultTruncated: result.truncated,
			});
		}
	}
	return {
		state:
			totalMatches === 0
				? "no-match"
				: totalMatches === 1
					? "matched"
					: "ambiguous",
		matches,
		totalMatches,
		omittedMatches: totalMatches - matches.length,
	};
}
