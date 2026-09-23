/** A request field a turn served through the SDK bridge cannot honour. */
export interface SdkBridgeRefusedField {
	/** The field's Messages name. */
	readonly field: "stop_sequences" | "tool_choice";
	/** The 400 message, naming the field. */
	readonly message: string;
}

const FORCING_TOOL_CHOICES = new Set(["any", "tool", "none"]);

/**
 * The field of a Messages body that the SDK bridge refuses, or null. Claude
 * Code applies no stop sequences and decides for itself when to call a tool,
 * so a bridged answer would not be the one the client asked for:
 *
 *   { stop_sequences: ["END"] }         → stop_sequences
 *   { tool_choice: { type: "any" } }    → tool_choice (so are "tool" and "none")
 *   { tool_choice: { type: "auto" } }   → null
 *   { stop_sequences: [] }              → null
 *
 * Route construction reads it to leave a bridged account out of a route that
 * has another candidate, and the bridge reads it again when it parses a turn.
 */
export function sdkBridgeRefusedField(
	body: unknown,
): SdkBridgeRefusedField | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const { stop_sequences: stops, tool_choice: toolChoice } = body as Record<
		string,
		unknown
	>;
	if (Array.isArray(stops) ? stops.length > 0 : stops != null)
		return {
			field: "stop_sequences",
			message:
				"stop_sequences (stop in Chat Completions) is not supported through the SDK bridge",
		};
	const choice =
		toolChoice && typeof toolChoice === "object" && !Array.isArray(toolChoice)
			? (toolChoice as Record<string, unknown>).type
			: null;
	if (typeof choice === "string" && FORCING_TOOL_CHOICES.has(choice))
		return {
			field: "tool_choice",
			message: `tool_choice "${choice}" is not supported through the SDK bridge; Claude Code decides when to call tools`,
		};
	return null;
}
