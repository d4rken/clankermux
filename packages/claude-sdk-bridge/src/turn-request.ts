import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import {
	type SdkBridgeTranslationGaps,
	sdkBridgeRefusedField,
} from "@clankermux/types";
import { type BridgeError, bridgeErrors } from "./errors";

export type Block = { type: string; [key: string]: unknown };

export interface ClientMessage {
	role: "user" | "assistant" | "system";
	content: string | Block[];
}

export interface ClientTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

/** An outer Anthropic Messages request, as the bridge needs it. */
export interface TurnRequest {
	model: string;
	stream: boolean;
	/** The client's own system prompt text, for the system-prompt policy. */
	systemText: string;
	/** Every message the client sent, in order. */
	messages: ClientMessage[];
	/** The conversation before the final user message. */
	history: ClientMessage[];
	/** The final user message: the trailing user messages, merged. */
	last: ClientMessage & { role: "user" };
	/** tool_result blocks of the final user message: a continuation when non-empty. */
	toolResults: Block[];
	tools: ClientTool[];
	effort: EffortLevel | null;
	/** The client's output limit; null when it set none. */
	maxOutputTokens: number | null;
	/** Fields accepted but not applied, by their Messages name. */
	ignoredFields: string[];
	/** Size of the whole request body. */
	bodyBytes: number;
	schemaBytes: number;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const EFFORTS: Record<string, EffortLevel> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function blocksOf(message: ClientMessage): Block[] {
	return typeof message.content === "string"
		? [{ type: "text", text: message.content }]
		: message.content;
}

function systemTextOf(system: unknown): string {
	if (typeof system === "string") return system;
	if (!Array.isArray(system)) return "";
	return system
		.filter((b) => isRecord(b) && b.type === "text")
		.map((b) => String((b as Block).text ?? ""))
		.join("\n\n");
}

/**
 * The SDK effort for the client's reasoning effort. `reasoningEffort` is the
 * proxy's reading of the outer body; `thinking:<budget>` and unknown names
 * leave Claude Code's default in place.
 */
export function mapEffort(
	reasoningEffort: string | null | undefined,
	body?: Record<string, unknown>,
): EffortLevel | null {
	const fromBody = isRecord(body?.output_config)
		? (body.output_config as { effort?: unknown }).effort
		: undefined;
	const raw =
		reasoningEffort ?? (typeof fromBody === "string" ? fromBody : null);
	if (!raw) return null;
	return EFFORTS[raw.trim().toLowerCase()] ?? null;
}

function parseMessage(value: unknown): ClientMessage | null {
	if (!isRecord(value)) return null;
	const { role, content } = value;
	if (role !== "user" && role !== "assistant" && role !== "system") return null;
	if (typeof content === "string") return { role, content };
	if (!Array.isArray(content)) return null;
	if (!content.every((b) => isRecord(b) && typeof b.type === "string"))
		return null;
	return { role, content: content as Block[] };
}

function parseTools(
	value: unknown,
): { tools: ClientTool[]; schemaBytes: number } | BridgeError {
	if (value === undefined || value === null)
		return { tools: [], schemaBytes: 0 };
	if (!Array.isArray(value))
		return bridgeErrors.invalid("tools must be an array");
	const tools: ClientTool[] = [];
	const names = new Set<string>();
	let schemaBytes = 0;
	for (const raw of value) {
		if (!isRecord(raw)) return bridgeErrors.invalid("tools[] must be objects");
		// Server tools (web search, code execution, bash, editor, computer use)
		// run on Anthropic's side or in Claude Code; the client cannot execute
		// them, so they have no place in a bridged turn.
		if (raw.type !== undefined && raw.type !== "custom")
			return bridgeErrors.invalid(
				`Tool type "${String(raw.type)}" is not supported through the SDK bridge; only custom tools are`,
			);
		const name = raw.name;
		if (typeof name !== "string" || !TOOL_NAME.test(name))
			return bridgeErrors.invalid(
				`Tool name ${JSON.stringify(name)} is not a valid tool name`,
			);
		if (names.has(name))
			return bridgeErrors.invalid(`Tool "${name}" is defined twice`);
		names.add(name);
		const schema = raw.input_schema;
		if (!isRecord(schema))
			return bridgeErrors.invalid(`Tool "${name}" has no input_schema object`);
		schemaBytes += JSON.stringify(schema).length;
		tools.push({
			name,
			description: typeof raw.description === "string" ? raw.description : "",
			input_schema: schema,
		});
	}
	return { tools, schemaBytes };
}

const IGNORED_FIELDS = ["temperature", "top_p"] as const;

/**
 * What a bridged turn does with the request fields Claude Code sets itself:
 * - `max_tokens` is honoured, as Claude Code's own output limit;
 * - `temperature` and `top_p` are accepted and not applied;
 * - the fields `sdkBridgeRefusedField` names are refused.
 * `gaps` names what the body cannot show: an adapter's default `max_tokens`
 * is no limit of the client's, and a dropped field was still asked for.
 */
function applyFieldPolicy(
	body: Record<string, unknown>,
	gaps: SdkBridgeTranslationGaps | null,
	mode: TurnRequestMode,
): { maxOutputTokens: number | null; ignoredFields: string[] } | BridgeError {
	const refused = sdkBridgeRefusedField(body, {
		sideRequest: mode === "side_request",
	});
	if (refused) return bridgeErrors.invalid(refused.message);
	let maxOutputTokens: number | null = null;
	if (body.max_tokens !== undefined && !gaps?.maxTokensDefaulted) {
		const limit = body.max_tokens;
		if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)
			return bridgeErrors.invalid("max_tokens must be a positive integer");
		maxOutputTokens = limit;
	}
	const dropped = new Set(gaps?.droppedFields ?? []);
	const ignoredFields = IGNORED_FIELDS.filter(
		(field) => body[field] != null || dropped.has(field),
	);
	return { maxOutputTokens, ignoredFields };
}

/** `side_request` parses a side request, where `tool_choice: none` passes. */
export type TurnRequestMode = "turn" | "side_request";

export function parseTurnRequest(
	body: unknown,
	reasoningEffort: string | null,
	bodyBytes: number,
	gaps: SdkBridgeTranslationGaps | null = null,
	mode: TurnRequestMode = "turn",
): { ok: true; turn: TurnRequest } | { ok: false; error: BridgeError } {
	const fail = (error: BridgeError) => ({ ok: false as const, error });
	if (!isRecord(body))
		return fail(bridgeErrors.invalid("Body must be a JSON object"));
	if (typeof body.model !== "string" || !body.model.trim())
		return fail(bridgeErrors.invalid("model is required"));
	if (!Array.isArray(body.messages) || body.messages.length === 0)
		return fail(bridgeErrors.invalid("messages must be a non-empty array"));
	const messages: ClientMessage[] = [];
	for (const raw of body.messages) {
		const message = parseMessage(raw);
		if (!message)
			return fail(
				bridgeErrors.invalid(
					"Every message needs a user, assistant or system role and string or block content",
				),
			);
		messages.push(message);
	}
	// Clients such as pi put system-role messages (effort changes, notes) into
	// the history; the turn's own final message is the last non-system one.
	let lastIndex = messages.length - 1;
	while (lastIndex >= 0 && messages[lastIndex]?.role === "system") lastIndex--;
	const final = messages[lastIndex];
	if (!final || final.role !== "user")
		return fail(
			bridgeErrors.invalid("The last message must be a user message"),
		);
	// Consecutive user messages are one message to the Messages API, and Chat
	// sends text typed with tool results as a user message after them.
	let firstIndex = lastIndex;
	for (let i = lastIndex - 1; i >= 0; i--) {
		const role = messages[i]?.role;
		if (role === "user") firstIndex = i;
		else if (role !== "system") break;
	}
	const run = messages
		.slice(firstIndex, lastIndex + 1)
		.filter((m) => m.role === "user");
	const last: ClientMessage =
		run.length === 1 ? final : { role: "user", content: run.flatMap(blocksOf) };
	const tools = parseTools(body.tools);
	if ("status" in tools) return fail(tools);
	const fields = applyFieldPolicy(body, gaps, mode);
	if ("status" in fields) return fail(fields);
	const toolResults = blocksOf(last).filter((b) => b.type === "tool_result");
	return {
		ok: true,
		turn: {
			model: body.model,
			stream: body.stream === true,
			systemText: systemTextOf(body.system),
			messages,
			history: messages.slice(0, firstIndex),
			last: last as ClientMessage & { role: "user" },
			toolResults,
			tools: tools.tools,
			effort: mapEffort(reasoningEffort, body),
			maxOutputTokens: fields.maxOutputTokens,
			ignoredFields: fields.ignoredFields,
			bodyBytes,
			schemaBytes: tools.schemaBytes,
		},
	};
}
