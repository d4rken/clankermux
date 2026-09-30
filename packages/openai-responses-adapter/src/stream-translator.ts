import { Logger } from "@clankermux/logger";
import {
	urlCitationsOf,
	webSearchCallItem,
	webSearchQueryOf,
	webSearchResultOf,
} from "./hosted-web-search";
import {
	type ResponsesTerminalStatus,
	responsesTerminalStatus,
	withheldToolCallTerminalStatus,
} from "./terminal-status";
import {
	customToolInput,
	type ToolIdentity,
	type ToolTranslation,
} from "./tool-translation";
import type { AnthropicUsage, ResponsesError } from "./types";
import { mergeAnthropicUsage, translateAnthropicUsage } from "./usage";

const log = new Logger("openai-responses-adapter");

interface State {
	tools?: ToolTranslation;
	lineBuffer: string;
	hasSentCreated: boolean;
	responseId: string;
	model: string;
	outputIndex: number;
	sequenceNumber: number;
	blockIndexToOutput: Map<number, number>;
	ignoredBlockIndices: Set<number>;
	textByBlock: Map<number, string>;
	toolByBlock: Map<
		number,
		{ callId: string; identity: ToolIdentity; argsBuf: string }
	>;
	usage: AnthropicUsage;
	stopReason: string | null;
	clientCappedOutput: boolean;
	/** A custom tool call whose input did not parse; its item never finished. */
	withheldCustomToolCall: boolean;
	doneSent: boolean;
	/** Finished items by output index; a reserved slot stays empty until then. */
	outputItems: Array<Record<string, unknown>>;
	includeSources: boolean;
	/** Hosted searches by tool_use id, from their invocation to their result. */
	searches: Map<
		string,
		{ outputIdx: number; argsBuf: string; query: string | null; done: boolean }
	>;
	searchByBlock: Map<number, string>;
	citationsByBlock: Map<number, unknown[]>;
	/** When the client was last written to, keepalives included. */
	lastWrite: number;
	heartbeat: Timer | undefined;
	/** Nothing more may reach the client: the reply ended or the client is gone. */
	closed: boolean;
}

const encoder = new TextEncoder();

const DEFAULT_HEARTBEAT_MS = 15_000;

/** A bare SSE comment: a conformant client discards it without dispatching anything. */
function keepalive(): Uint8Array {
	return encoder.encode(": keepalive\n\n");
}

/** The one path to the client, so a write that fails always ends the output. */
function write(
	controller: TransformStreamDefaultController,
	state: State,
	chunk: Uint8Array,
): void {
	if (state.closed) return;
	try {
		controller.enqueue(chunk);
	} catch {
		log.debug("Responses stream closed before its reply finished");
		stopOutput(state);
		return;
	}
	state.lastWrite = Date.now();
}

/** Ends all output to the client, heartbeat included. Idempotent. */
function stopOutput(state: State): void {
	state.closed = true;
	if (state.heartbeat === undefined) return;
	clearInterval(state.heartbeat);
	state.heartbeat = undefined;
}

/**
 * Keeps the client connection from idling out while the upstream works
 * without producing output: suppressed blocks, withheld custom tool input, a
 * partial frame, or plain silence. A hop that buffers, or that enforces an
 * absolute rather than an idle deadline, is unaffected. Output still queued
 * unread means the reader has stalled, and another comment would only queue
 * behind it.
 */
function heartbeat(
	controller: TransformStreamDefaultController,
	state: State,
	heartbeatMs: number,
): void {
	if (Date.now() - state.lastWrite < heartbeatMs) return;
	if ((controller.desiredSize ?? 0) < 0) return;
	write(controller, state, keepalive());
}

function emitSse(
	controller: TransformStreamDefaultController,
	eventType: string,
	data: unknown,
	state: State,
): void {
	const payload = Object.assign(
		{ sequence_number: state.sequenceNumber++ },
		data as object,
	);
	write(
		controller,
		state,
		encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`),
	);
}

/** The items as the response reports them, in output order. */
function finishedItems(state: State): Array<Record<string, unknown>> {
	return state.outputItems.filter(Boolean);
}

function searchItemId(state: State, outputIdx: number): string {
	return `${state.responseId}_ws_${outputIdx}`;
}

/** Fill a search's reserved slot and close its item. */
function finishSearch(
	controller: TransformStreamDefaultController,
	state: State,
	search: { outputIdx: number; query: string | null; done: boolean },
	result:
		| { ok: true; sources: { url: string; title?: string }[] }
		| { ok: false },
): void {
	search.done = true;
	const itemId = searchItemId(state, search.outputIdx);
	if (result.ok)
		emitSse(
			controller,
			"response.web_search_call.completed",
			{
				type: "response.web_search_call.completed",
				item_id: itemId,
				output_index: search.outputIdx,
			},
			state,
		);
	const item = webSearchCallItem({
		id: itemId,
		query: search.query,
		status: result.ok ? "completed" : "failed",
		sources: result.ok ? result.sources : [],
		includeSources: state.includeSources,
	});
	state.outputItems[search.outputIdx] = item;
	emitSse(
		controller,
		"response.output_item.done",
		{
			type: "response.output_item.done",
			output_index: search.outputIdx,
			item,
		},
		state,
	);
}

function emitToolCallAdded(
	controller: TransformStreamDefaultController,
	state: State,
	outputIdx: number,
	callId: string,
	identity: ToolIdentity,
): void {
	emitSse(
		controller,
		"response.output_item.added",
		{
			type: "response.output_item.added",
			output_index: outputIdx,
			item: {
				type: identity.type === "custom" ? "custom_tool_call" : "function_call",
				id: `${state.responseId}_fc_${outputIdx}`,
				call_id: callId,
				name: identity.name,
				...(identity.namespace ? { namespace: identity.namespace } : {}),
				...(identity.type === "custom" ? { input: "" } : { arguments: "" }),
				status: "in_progress",
			},
		},
		state,
	);
}

const STREAM_TRUNCATED: ResponsesError = {
	code: "stream_truncated",
	message: "Upstream stream ended before message_stop",
};

/** Fail every search still unanswered, then close the response. */
function emitTerminal(
	controller: TransformStreamDefaultController,
	state: State,
	terminal: ResponsesTerminalStatus,
): void {
	if (state.doneSent) return;
	for (const search of state.searches.values())
		if (!search.done) finishSearch(controller, state, search, { ok: false });
	state.doneSent = true;

	const eventType = `response.${terminal.status}`;
	emitSse(
		controller,
		eventType,
		{
			type: eventType,
			response: {
				id: state.responseId,
				object: "response",
				created_at: Math.floor(Date.now() / 1000),
				model: state.model,
				...terminal,
				output: finishedItems(state),
				usage: translateAnthropicUsage(state.usage),
			},
		},
		state,
	);
	// A trailing comment is legal SSE but useless once the client has the
	// terminal event, and holding a finished connection open is how a hung
	// request stays hung.
	stopOutput(state);
}

/** The terminal for a reply that reached `message_stop`. */
function replyTerminal(state: State): ResponsesTerminalStatus {
	return (
		state.withheldCustomToolCall
			? withheldToolCallTerminalStatus
			: responsesTerminalStatus
	)(state.stopReason, state.clientCappedOutput);
}

const MAX_ERROR_LABEL = 128;

/** An upstream error's `type` or `code`: a nonblank string, trimmed and capped. */
export function errorLabel(value: unknown): string | null {
	return typeof value === "string" && value.trim()
		? value.trim().slice(0, MAX_ERROR_LABEL)
		: null;
}

function processEvent(
	eventType: string,
	data: Record<string, unknown>,
	controller: TransformStreamDefaultController,
	state: State,
): void {
	if (state.doneSent) return;
	if (eventType === "message_start") {
		const message = data.message as Record<string, unknown> | undefined;
		if (typeof message?.model === "string" && message.model)
			state.model = message.model;
		mergeAnthropicUsage(
			state.usage,
			message?.usage as Record<string, unknown> | undefined,
		);

		if (!state.hasSentCreated) {
			state.hasSentCreated = true;
			const createdAt = Math.floor(Date.now() / 1000);
			const responseShape = {
				id: state.responseId,
				object: "response",
				created_at: createdAt,
				model: state.model,
				status: "in_progress",
				output: [],
			};
			emitSse(
				controller,
				"response.created",
				{ type: "response.created", response: responseShape },
				state,
			);
			emitSse(
				controller,
				"response.in_progress",
				{ type: "response.in_progress", response: responseShape },
				state,
			);
		}
		return;
	}

	if (eventType === "content_block_start") {
		// A reply is cut off only in its last block, so a withheld call with a
		// block after it was malformed. Nothing after it may reach the client.
		if (state.withheldCustomToolCall) {
			emitTerminal(
				controller,
				state,
				withheldToolCallTerminalStatus(null, state.clientCappedOutput),
			);
			return;
		}
		const blockIndex = data.index as number;
		const contentBlock = data.content_block as Record<string, unknown>;

		if (
			contentBlock.type === "server_tool_use" &&
			contentBlock.name === "web_search"
		) {
			const outputIdx = state.outputIndex++;
			state.searches.set(String(contentBlock.id), {
				outputIdx,
				argsBuf:
					contentBlock.input && Object.keys(contentBlock.input as object).length
						? JSON.stringify(contentBlock.input)
						: "",
				query: null,
				done: false,
			});
			state.searchByBlock.set(blockIndex, String(contentBlock.id));
			state.ignoredBlockIndices.add(blockIndex);
			const itemId = searchItemId(state, outputIdx);
			emitSse(
				controller,
				"response.output_item.added",
				{
					type: "response.output_item.added",
					output_index: outputIdx,
					item: { type: "web_search_call", id: itemId, status: "in_progress" },
				},
				state,
			);
			emitSse(
				controller,
				"response.web_search_call.in_progress",
				{
					type: "response.web_search_call.in_progress",
					item_id: itemId,
					output_index: outputIdx,
				},
				state,
			);
			return;
		}
		if (contentBlock.type === "web_search_tool_result") {
			state.ignoredBlockIndices.add(blockIndex);
			const search = state.searches.get(String(contentBlock.tool_use_id));
			if (!search || search.done) {
				log.warn("web_search_tool_result for no search awaiting one; ignored");
				return;
			}
			finishSearch(
				controller,
				state,
				search,
				webSearchResultOf(contentBlock.content),
			);
			return;
		}

		// Only allocate an output slot for block types we emit events for.
		// Incrementing unconditionally (e.g. for "thinking" blocks) leaves gaps in
		// output_index that confuse clients expecting a contiguous sequence.
		if (contentBlock.type !== "text" && contentBlock.type !== "tool_use") {
			state.ignoredBlockIndices.add(blockIndex);
			return;
		}

		state.ignoredBlockIndices.delete(blockIndex);
		const outputIdx = state.outputIndex++;
		state.blockIndexToOutput.set(blockIndex, outputIdx);

		if (contentBlock.type === "text") {
			state.textByBlock.set(blockIndex, "");
			emitSse(
				controller,
				"response.output_item.added",
				{
					type: "response.output_item.added",
					output_index: outputIdx,
					item: {
						type: "message",
						id: `${state.responseId}_msg_${outputIdx}`,
						role: "assistant",
						content: [],
						status: "in_progress",
					},
				},
				state,
			);
			emitSse(
				controller,
				"response.content_part.added",
				{
					type: "response.content_part.added",
					item_id: `${state.responseId}_msg_${outputIdx}`,
					output_index: outputIdx,
					content_index: 0,
					part: { type: "output_text", text: "" },
				},
				state,
			);
		} else if (contentBlock.type === "tool_use") {
			const identity = state.tools?.identity(contentBlock.name as string) ?? {
				type: "function",
				name: contentBlock.name as string,
			};
			state.toolByBlock.set(blockIndex, {
				callId: contentBlock.id as string,
				identity,
				argsBuf:
					contentBlock.input && Object.keys(contentBlock.input as object).length
						? JSON.stringify(contentBlock.input)
						: "",
			});
			// A custom call's input streams no deltas, so it is announced whole
			// at its content_block_stop, and only if that input parses.
			if (identity.type !== "custom")
				emitToolCallAdded(
					controller,
					state,
					outputIdx,
					contentBlock.id as string,
					identity,
				);
		}
		return;
	}

	if (eventType === "content_block_delta") {
		const blockIndex = data.index as number;
		const delta = data.delta as Record<string, unknown>;
		const outputIdx = state.blockIndexToOutput.get(blockIndex);

		if (outputIdx === undefined) {
			const searchId = state.searchByBlock.get(blockIndex);
			const search = searchId ? state.searches.get(searchId) : undefined;
			if (search && delta.type === "input_json_delta")
				search.argsBuf += (delta.partial_json as string) ?? "";
			if (state.ignoredBlockIndices.has(blockIndex)) return;
			log.warn(`content_block_delta for unknown block index ${blockIndex}`);
			return;
		}

		if (delta.type === "citations_delta") {
			const cited = state.citationsByBlock.get(blockIndex) ?? [];
			cited.push(delta.citation);
			state.citationsByBlock.set(blockIndex, cited);
			return;
		}

		if (delta.type === "text_delta") {
			const text = delta.text as string;
			const current = state.textByBlock.get(blockIndex) ?? "";
			state.textByBlock.set(blockIndex, current + text);

			emitSse(
				controller,
				"response.output_text.delta",
				{
					type: "response.output_text.delta",
					item_id: `${state.responseId}_msg_${outputIdx}`,
					output_index: outputIdx,
					content_index: 0,
					delta: text,
				},
				state,
			);
		} else if (delta.type === "input_json_delta") {
			const partial = (delta.partial_json as string) ?? "";
			const tool = state.toolByBlock.get(blockIndex);
			if (tool) {
				tool.argsBuf += partial;
				if (tool.identity.type === "custom") return;
				emitSse(
					controller,
					"response.function_call_arguments.delta",
					{
						type: "response.function_call_arguments.delta",
						item_id: `${state.responseId}_fc_${outputIdx}`,
						output_index: outputIdx,
						call_id: tool.callId,
						delta: partial,
					},
					state,
				);
			}
		}
		return;
	}

	if (eventType === "content_block_stop") {
		const blockIndex = data.index as number;
		const outputIdx = state.blockIndexToOutput.get(blockIndex);

		if (outputIdx === undefined) {
			const searchId = state.searchByBlock.get(blockIndex);
			const search = searchId ? state.searches.get(searchId) : undefined;
			if (search) {
				state.searchByBlock.delete(blockIndex);
				let input: unknown = null;
				try {
					input = search.argsBuf ? JSON.parse(search.argsBuf) : null;
				} catch {}
				search.query = webSearchQueryOf(input);
				if (!search.done)
					emitSse(
						controller,
						"response.web_search_call.searching",
						{
							type: "response.web_search_call.searching",
							item_id: searchItemId(state, search.outputIdx),
							output_index: search.outputIdx,
						},
						state,
					);
				return;
			}
			if (state.ignoredBlockIndices.has(blockIndex)) return;
			log.warn(`content_block_stop for unknown block index ${blockIndex}`);
			return;
		}

		if (state.textByBlock.has(blockIndex)) {
			const fullText = state.textByBlock.get(blockIndex) ?? "";
			const annotations = urlCitationsOf(
				state.citationsByBlock.get(blockIndex),
				fullText,
			);
			const part = {
				type: "output_text",
				text: fullText,
				...(annotations.length ? { annotations } : {}),
			};
			emitSse(
				controller,
				"response.output_text.done",
				{
					type: "response.output_text.done",
					item_id: `${state.responseId}_msg_${outputIdx}`,
					output_index: outputIdx,
					content_index: 0,
					text: fullText,
				},
				state,
			);
			emitSse(
				controller,
				"response.content_part.done",
				{
					type: "response.content_part.done",
					item_id: `${state.responseId}_msg_${outputIdx}`,
					output_index: outputIdx,
					content_index: 0,
					part,
				},
				state,
			);
			const doneItem: Record<string, unknown> = {
				type: "message",
				id: `${state.responseId}_msg_${outputIdx}`,
				role: "assistant",
				content: [part],
				status: "completed",
			};
			state.outputItems[outputIdx] = doneItem;
			emitSse(
				controller,
				"response.output_item.done",
				{
					type: "response.output_item.done",
					output_index: outputIdx,
					item: doneItem,
				},
				state,
			);
		} else if (state.toolByBlock.has(blockIndex)) {
			const tool = state.toolByBlock.get(blockIndex);
			if (!tool) {
				throw new Error(`Tool state missing for block index ${blockIndex}`);
			}
			const identity = tool.identity;
			let input: string | undefined;
			if (identity.type === "custom") {
				try {
					input = customToolInput(JSON.parse(tool.argsBuf));
				} catch {
					// Only the stop reason, still to come, says whether it was cut off.
					state.withheldCustomToolCall = true;
					return;
				}
				emitToolCallAdded(controller, state, outputIdx, tool.callId, identity);
				emitSse(
					controller,
					"response.custom_tool_call_input.delta",
					{
						type: "response.custom_tool_call_input.delta",
						item_id: `${state.responseId}_fc_${outputIdx}`,
						output_index: outputIdx,
						delta: input,
					},
					state,
				);
			}
			const eventType =
				identity.type === "custom"
					? "response.custom_tool_call_input.done"
					: "response.function_call_arguments.done";
			emitSse(
				controller,
				eventType,
				{
					type: eventType,
					item_id: `${state.responseId}_fc_${outputIdx}`,
					output_index: outputIdx,
					call_id: tool.callId,
					name: identity.name,
					...(identity.namespace ? { namespace: identity.namespace } : {}),
					...(identity.type === "custom"
						? { input }
						: { arguments: tool.argsBuf }),
				},
				state,
			);
			const doneItem: Record<string, unknown> = {
				type: identity.type === "custom" ? "custom_tool_call" : "function_call",
				id: `${state.responseId}_fc_${outputIdx}`,
				call_id: tool.callId,
				name: identity.name,
				...(identity.namespace ? { namespace: identity.namespace } : {}),
				...(identity.type === "custom"
					? { input }
					: { arguments: tool.argsBuf }),
				status: "completed",
			};
			state.outputItems[outputIdx] = doneItem;
			emitSse(
				controller,
				"response.output_item.done",
				{
					type: "response.output_item.done",
					output_index: outputIdx,
					item: doneItem,
				},
				state,
			);
		}
		return;
	}

	if (eventType === "message_delta") {
		mergeAnthropicUsage(
			state.usage,
			data.usage as Record<string, unknown> | undefined,
		);
		const stopReason = (data.delta as Record<string, unknown> | undefined)
			?.stop_reason;
		if (typeof stopReason === "string") state.stopReason = stopReason;
		return;
	}

	if (eventType === "message_stop") {
		emitTerminal(controller, state, replyTerminal(state));
		return;
	}

	if (eventType === "error") {
		const err = data.error as Record<string, unknown> | undefined;
		const errType = errorLabel(err?.type) ?? "api_error";
		const errMsg =
			typeof err?.message === "string" && err.message.trim()
				? err.message
				: "An error occurred during streaming";
		emitTerminal(controller, state, {
			status: "failed",
			error: { code: errorLabel(err?.code) ?? errType, message: errMsg },
		});
		return;
	}

	// Anthropic emits `ping` during long gaps between content, most visibly
	// while an extended-thinking model reasons before its first token. `ping`
	// has no Responses counterpart, so it is forwarded as a bare SSE comment.
	// Deliberately NOT emitSse: that would consume a `sequence_number` and put
	// a junk event in a stream whose numbering the client reads as contiguous.
	//
	// Liveness does not depend on it: the heartbeat timer guarantees output
	// whenever the client has seen nothing for `heartbeatMs`. That keeps the
	// client connection open, not a stalled upstream; the proxy's upstream
	// chunk and total deadlines still apply.
	if (eventType === "ping") {
		write(controller, state, keepalive());
		return;
	}
}

function parseAndProcessEvent(
	rawEvent: string,
	controller: TransformStreamDefaultController,
	state: State,
): void {
	if (!rawEvent.trim()) return;

	const lines = rawEvent.split(/\r?\n/);
	let eventType = "";
	const dataLines: string[] = [];

	for (const line of lines) {
		if (line.startsWith("event:")) {
			eventType = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			const value = line.slice(5);
			dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
		}
	}

	const dataStr = dataLines.join("\n");
	if (!eventType || !dataStr) return;

	let data: Record<string, unknown>;
	try {
		data = JSON.parse(dataStr) as Record<string, unknown>;
	} catch {
		// Event fields, data, and SyntaxError messages can contain payloads.
		log.warn("Failed to parse upstream SSE event data");
		return;
	}
	try {
		processEvent(eventType, data, controller, state);
	} catch {
		log.warn("Failed to process upstream SSE event");
	}
}

export function translateAnthropicStreamToResponses(
	anthropicResponse: Response,
	responseId: string,
	model: string,
	tools?: ToolTranslation,
	options: {
		includeSources?: boolean;
		clientCappedOutput?: boolean;
		/** Longest silence the client sees while the stream is open. */
		heartbeatMs?: number;
	} = {},
): Response {
	if (!anthropicResponse.body && !anthropicResponse.ok) {
		return new Response(null, { status: anthropicResponse.status });
	}
	// A successful reply without a body is one that ended before it began.
	const upstreamBody =
		anthropicResponse.body ??
		new ReadableStream<Uint8Array>({ start: (c) => c.close() });

	// Per-request decoder: TextDecoder is stateful (buffers incomplete UTF-8
	// sequences across chunks), so a shared singleton would corrupt concurrent streams.
	const decoder = new TextDecoder();

	const state: State = {
		tools,
		lineBuffer: "",
		hasSentCreated: false,
		responseId,
		model,
		outputIndex: 0,
		sequenceNumber: 0,
		blockIndexToOutput: new Map(),
		ignoredBlockIndices: new Set(),
		textByBlock: new Map(),
		toolByBlock: new Map(),
		usage: { input_tokens: 0, output_tokens: 0 },
		stopReason: null,
		clientCappedOutput: options.clientCappedOutput ?? false,
		withheldCustomToolCall: false,
		doneSent: false,
		outputItems: [],
		includeSources: options.includeSources ?? false,
		searches: new Map(),
		searchByBlock: new Map(),
		citationsByBlock: new Map(),
		lastWrite: 0,
		heartbeat: undefined,
		closed: false,
	};
	const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

	// `cancel` is missing from the Transformer type, not from the runtime.
	const transformer: Transformer<Uint8Array, Uint8Array> & {
		cancel(reason: unknown): void;
	} = {
		start(controller) {
			state.lastWrite = Date.now();
			const timer = setInterval(
				() => heartbeat(controller, state, heartbeatMs),
				heartbeatMs / 3,
			);
			timer.unref();
			state.heartbeat = timer;
		},

		transform(chunk, controller) {
			try {
				state.lineBuffer += decoder.decode(chunk, { stream: true });

				// Keep partial delimiters, including a CR/LF split across chunks.
				for (;;) {
					const boundary = /\r?\n\r?\n/.exec(state.lineBuffer);
					if (!boundary || boundary.index === undefined) break;
					const end = boundary.index + boundary[0].length;
					const complete = state.lineBuffer.slice(0, boundary.index);
					state.lineBuffer = state.lineBuffer.slice(end);
					parseAndProcessEvent(complete, controller, state);
				}
			} catch (err) {
				log.warn(`Stream transform error: ${String(err)}`);
			}
		},

		flush(controller) {
			try {
				// Flush remaining buffered UTF-8 bytes and release decoder's internal buffer
				const remaining = decoder.decode();
				if (remaining) state.lineBuffer += remaining;

				// Process any remaining buffered content
				if (state.lineBuffer.trim()) {
					parseAndProcessEvent(state.lineBuffer, controller, state);
					state.lineBuffer = "";
				}
				// Only message_stop completes a reply; a body that ends before it
				// was cut off, even after a message_delta.
				emitTerminal(controller, state, {
					status: "failed",
					error: STREAM_TRUNCATED,
				});
			} catch (err) {
				log.warn(`Stream flush error: ${String(err)}`);
			} finally {
				stopOutput(state);
			}
		},

		// The reader cancelled, or an upstream error aborted the pipe.
		cancel() {
			stopOutput(state);
		},
	};

	const transformedBody = upstreamBody.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>(transformer),
	);

	return new Response(transformedBody, {
		status: anthropicResponse.status,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
