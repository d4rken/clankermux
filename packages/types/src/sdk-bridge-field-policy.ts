/** A request field a turn served through the SDK bridge cannot honour. */
export interface SdkBridgeRefusedField {
	/** The field's Messages name. */
	readonly field:
		| "stop_sequences"
		| "tool_choice"
		| "tools"
		| "output_config.format";
	/** The 400 message, naming the field. */
	readonly message: string;
}

/**
 * The largest output schema the SDK bridge takes, in UTF-8 bytes of its
 * JSON. The Agent SDK hands it to the Claude Code child as one argument
 * (`--json-schema <json>`), and Linux refuses to start a process with an
 * argument over 128 KiB (MAX_ARG_STRLEN).
 */
export const SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES = 64 * 1024;

const FORCING_TOOL_CHOICES = new Set(["any", "tool", "none"]);
const SIDE_REQUEST_FORCING_TOOL_CHOICES = new Set(["any", "tool"]);

/**
 * The field of a Messages body that the SDK bridge refuses, or null. Claude
 * Code applies no stop sequences and decides for itself when to call a tool,
 * so a bridged answer would not be the one the client asked for. The client
 * runs every tool it is shown, so a server tool has no place in the turn.
 * A structured answer ends the turn, so it cannot share one with client
 * tool calls, and its schema has to fit on Claude Code's command line:
 *
 *   { stop_sequences: ["END"] }                           → stop_sequences
 *   { tool_choice: { type: "any" } }                      → tool_choice (so are "tool" and "none")
 *   { tools: [{ type: "web_search_20250305" }] }          → tools
 *   { output_config: { format }, tools: [{ name: "a" }] } → output_config.format
 *   { output_config: { format: { schema: 65537 bytes } } } → output_config.format
 *   { tool_choice: { type: "auto" } }                     → null
 *   { stop_sequences: [] }                                → null
 *   { tools: [{ name: "a" }, { type: "custom" }] }        → null
 *   { output_config: { format }, tools: [] }              → null
 *
 * With `sideRequest` (the request declares SDK_BRIDGE_SIDE_REQUEST_FORK),
 * `tool_choice: { type: "none" }` passes.
 *
 * Route construction reads it to leave a bridged account out of a route that
 * has another candidate, and the bridge reads it again when it parses a turn.
 */
export function sdkBridgeRefusedField(
	body: unknown,
	options: { sideRequest?: boolean } = {},
): SdkBridgeRefusedField | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const {
		stop_sequences: stops,
		tool_choice: toolChoice,
		tools,
		output_config: outputConfig,
	} = body as Record<string, unknown>;
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
	const forcing = options.sideRequest
		? SIDE_REQUEST_FORCING_TOOL_CHOICES
		: FORCING_TOOL_CHOICES;
	if (typeof choice === "string" && forcing.has(choice))
		return {
			field: "tool_choice",
			message: `tool_choice "${choice}" is not supported through the SDK bridge; Claude Code decides when to call tools`,
		};
	const serverTool = Array.isArray(tools)
		? tools.find(
				(tool): tool is Record<string, unknown> =>
					!!tool &&
					typeof tool === "object" &&
					!Array.isArray(tool) &&
					(tool as Record<string, unknown>).type !== undefined &&
					(tool as Record<string, unknown>).type !== "custom",
			)
		: undefined;
	if (serverTool)
		return {
			field: "tools",
			message: `Tool type "${String(serverTool.type)}" is not supported through the SDK bridge; only custom tools are`,
		};
	const format =
		outputConfig && typeof outputConfig === "object"
			? (outputConfig as Record<string, unknown>).format
			: undefined;
	if (format != null && Array.isArray(tools) && tools.length > 0)
		return {
			field: "output_config.format",
			message:
				"output_config.format (response_format in Chat Completions) cannot be combined with tools through the SDK bridge",
		};
	const schema =
		format && typeof format === "object"
			? (format as Record<string, unknown>).schema
			: undefined;
	if (schema && typeof schema === "object") {
		const bytes = new TextEncoder().encode(JSON.stringify(schema)).length;
		if (bytes > SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES)
			return {
				field: "output_config.format",
				message: `The output_config.format schema (response_format in Chat Completions) is ${bytes} bytes as JSON; the SDK bridge takes at most ${SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES}`,
			};
	}
	return null;
}
