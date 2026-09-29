import type { ToolNames, WithheldReason } from "./tool-server";
import type { Block } from "./turn-request";
import { WEB_SEARCH_TOOL, type WebSearchOutcome } from "./web-search";

export type StreamEvent = { type: string; [key: string]: unknown };

/**
 * What one upstream model message's end means for the client's reply:
 * - `end`: the reply is complete (a final answer, or tool calls the client runs);
 * - `continue`: Claude Code carries on without the client (it answered a tool
 *   call that is not the client's, or may recover from max_tokens), so later
 *   model messages stream on as part of the same reply.
 */
export type UpstreamMessageEnd =
	| { kind: "end"; stopReason: string | null }
	| { kind: "continue"; stopReason: string | null };

const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "refusal"]);
const FORWARDED_BLOCKS = new Set(["text", "thinking", "redacted_thinking"]);
/**
 * UTF-16 units of a tool call's input per `input_json_delta`. A client's SSE
 * reader bounds its frames (the Chat adapter at 1 MiB); escaped, a chunk
 * this size stays well under that.
 */
export const INPUT_JSON_CHUNK = 64 * 1024;
/** A model call's input and cache counts before it reports any. */
const NO_INPUT_USAGE = {
	input_tokens: 0,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
} as const;
const INPUT_USAGE_FIELDS = Object.keys(NO_INPUT_USAGE) as Array<
	keyof typeof NO_INPUT_USAGE
>;

/** The input and cache counts `usage` reports, overlaid on `onto`. */
function withInputUsage(
	onto: Record<string, number>,
	usage: unknown,
): Record<string, number> {
	const out = { ...onto };
	if (!usage || typeof usage !== "object") return out;
	for (const field of INPUT_USAGE_FIELDS) {
		const value = (usage as Record<string, unknown>)[field];
		if (typeof value === "number") out[field] = value;
	}
	return out;
}

interface Accumulated {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

/** A tool call's input as the model completed it, or why it cannot go out. */
type ToolInput =
	| { ok: true; input: Record<string, unknown>; json: string }
	| { ok: false; reason: WithheldReason };

const CUT_OFF: ToolInput = { ok: false, reason: { kind: "cut_off" } };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function streamedToolInput(json: string): ToolInput {
	// A call without arguments streams no input, or an empty delta.
	if (json === "") return { ok: true, input: {}, json: "{}" };
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return CUT_OFF;
	}
	return isPlainObject(value)
		? { ok: true, input: value, json }
		: { ok: false, reason: { kind: "not_object" } };
}

/**
 * A model message's client tool calls go out all together or not at all:
 * a call the client runs must be one Claude Code runs too, and a partial set
 * would park on calls whose siblings never got an answer from the client.
 * Null when they go out; otherwise each call's reason.
 */
function withheldReasons(
	inputs: ToolInput[],
	stopAllows: boolean,
	stopReason: string | null,
): WithheldReason[] | null {
	if (stopAllows && inputs.every((i) => i.ok)) return null;
	return inputs.map((i): WithheldReason => {
		if (!i.ok) return i.reason;
		if (!stopAllows)
			return { kind: "stop_reason", stopReason: stopReason ?? "none" };
		return { kind: "sibling" };
	});
}

/**
 * `json` in pieces of at most `size` UTF-16 units, never between the halves
 * of a surrogate pair.
 */
export function inputJsonChunks(
	json: string,
	size = INPUT_JSON_CHUNK,
): string[] {
	const chunks: string[] = [];
	let at = 0;
	while (at < json.length) {
		let end = Math.min(at + size, json.length);
		const last = json.charCodeAt(end - 1);
		if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
		chunks.push(json.slice(at, end));
		at = end;
	}
	return chunks;
}

/** One of Claude Code's WebSearch calls, shown to the client as Anthropic's server tool. */
interface Search {
	id: string;
	json: string;
	/** Its result is queued or sent. */
	answered: boolean;
}

/**
 * A block of a streamed message held back from its first client tool call
 * to its message_stop, in upstream order.
 */
type Held =
	| {
			kind: "tool";
			index: number;
			block: Block;
			/** The client's name for the tool. */
			name: string;
			json: string;
			stopped: boolean;
	  }
	| {
			kind: "block";
			index: number;
			block: Block;
			deltas: Record<string, unknown>[];
			stopped: boolean;
	  }
	| { kind: "search"; index: number; search: Search; stopped: boolean };

/**
 * Turns Claude Code's model messages into one Anthropic reply per leg. Every
 * model call Claude Code makes arrives as its own message; the client must see
 * a single message per request, so later messages of the same leg are merged
 * in with continued block indexes. Only the client's own tools are forwarded,
 * renamed back to the client's names: forwarding any other tool_use would
 * leave the client waiting on a call it cannot answer.
 *
 * The client runs every tool call it is shown, so a streamed message's calls
 * are held, with every block after the first of them, until its message_stop,
 * and go out only when it stops on `tool_use` with every input a JSON object.
 * Claude Code discards a message whose stream fails and fetches it again, so
 * a call shown before that would run twice.
 */
export class ReplyComposer {
	private sink: ((event: StreamEvent) => void) | null = null;
	private legStarted = false;
	private nextIndex = 0;
	private indexMap = new Map<number, number | null>();
	private heldDelta: Record<string, unknown> | null = null;
	private outputTokens = 0;
	/** Input and cache counts of the leg's latest model call. */
	private lastInputUsage: Record<string, number> = {};
	private forwardedThisMessage = 0;
	private withheldThisMessage = 0;
	private readonly streamedIds = new Set<string>();
	private streaming = false;
	private accumulated = new Map<number, Accumulated>();
	/** tool_use ids handed to the client in the current leg. */
	legToolUseIds: string[] = [];
	lastStopReason: string | null = null;
	/** The last model message to end withheld client tool calls. */
	lastMessageWithheldCalls = false;
	/** The leg's WebSearch calls the client was shown, by tool_use id. */
	private searches = new Map<string, Search>();
	/**
	 * Upstream block index to a WebSearch call whose input is still
	 * streaming; the client sees nothing of it until its block completes.
	 */
	private searchBlocks = new Map<number, Search>();
	/** Results waiting for the output blocks open now to close. */
	private queuedResults: Block[] = [];
	/** Forwarded output blocks started and not yet stopped. */
	private openOutputs = new Set<number>();
	/** Searches of this leg whose result was a completed search. */
	completedSearches = 0;
	/** The streamed message's blocks held back; see the class comment. */
	private held: Held[] = [];
	/** The model stream broke its one-block-at-a-time order; nothing more goes out. */
	private faulted = false;

	constructor(
		private readonly opts: {
			toolNames: ToolNames;
			/** A client tool_use was forwarded; its id now names this turn. */
			onToolUse: (id: string) => void;
			/**
			 * A client tool_use was not forwarded; Claude Code's call of it,
			 * if it makes one, must not wait for the client.
			 */
			onToolUseWithheld?: (id: string, reason: WithheldReason) => void;
			/** Blocks overlapped around a client tool call: the reply cannot be composed. */
			onStreamFault?: (why: string) => void;
			newMessageId: () => string;
			/** False for a side request, whose tool calls no client runs. */
			forwardToolUse?: boolean;
			/** Claude Code's WebSearch serves the client's hosted web search. */
			webSearch?: boolean;
			/** A WebSearch call started. */
			onWebSearch?: (id: string) => void;
		},
	) {}

	get attached(): boolean {
		return this.sink !== null;
	}

	get started(): boolean {
		return this.legStarted;
	}

	/**
	 * Between a streamed message's `message_start` and `message_stop`. Claude
	 * Code starts a tool as soon as its block is complete, so a tool call
	 * during a streamed message does not mean the message has ended.
	 */
	get streamingMessage(): boolean {
		return this.streaming;
	}

	/** Start a new leg writing to `sink`. */
	attach(sink: (event: StreamEvent) => void): void {
		// Calls an earlier leg left held never reach this one's client.
		this.dropHeld();
		this.faulted = false;
		this.sink = sink;
		this.streaming = false;
		this.legStarted = false;
		this.nextIndex = 0;
		this.indexMap = new Map();
		this.heldDelta = null;
		this.outputTokens = 0;
		this.lastInputUsage = {};
		this.forwardedThisMessage = 0;
		this.withheldThisMessage = 0;
		this.accumulated = new Map();
		this.legToolUseIds = [];
		this.lastStopReason = null;
		this.lastMessageWithheldCalls = false;
		this.searches = new Map();
		this.searchBlocks = new Map();
		this.queuedResults = [];
		this.openOutputs = new Set();
		this.completedSearches = 0;
	}

	detach(): void {
		this.sink = null;
	}

	/**
	 * The leg's reply as content blocks, the way the client will store it.
	 * The search blocks are not: a Responses client's history carries them
	 * as `web_search_call` items, which its translation drops.
	 */
	legContent(): Block[] {
		return [...this.accumulated.entries()]
			.sort(([a], [b]) => a - b)
			.flatMap(([, block]): Block[] => {
				if (block.type === "text")
					return [{ type: "text", text: block.text ?? "" }];
				if (block.type === "tool_use")
					return [
						{
							type: "tool_use",
							id: block.id,
							name: block.name,
							input: block.input,
						},
					];
				return [];
			});
	}

	private emit(event: StreamEvent): void {
		if (!this.faulted) this.sink?.(event);
	}

	private startMessage(message: Record<string, unknown>): void {
		if (this.legStarted) return;
		this.legStarted = true;
		this.emit({
			type: "message_start",
			message: {
				id: message.id ?? this.opts.newMessageId(),
				type: "message",
				role: "assistant",
				model: message.model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: message.usage ?? { input_tokens: 0, output_tokens: 0 },
			},
		});
	}

	private isWebSearch(block: Block): boolean {
		return (
			this.opts.webSearch === true &&
			block.type === "tool_use" &&
			block.name === WEB_SEARCH_TOOL
		);
	}

	/** Whether `id` is a WebSearch call of this leg still waiting on its result. */
	awaitsWebSearch(id: string): boolean {
		const search = this.searches.get(id);
		return !!search && !search.answered;
	}

	private newSearch(block: Block): Search {
		return { id: String(block.id), json: "", answered: false };
	}

	/** A complete WebSearch call is the leg's, and its result is taken. */
	private registerSearch(search: Search): void {
		this.searches.set(search.id, search);
		this.opts.onWebSearch?.(search.id);
	}

	/**
	 * A complete WebSearch call goes out as a `server_tool_use` block. Only
	 * the query goes out: Claude Code's input may also carry the domain
	 * lists the bridge set.
	 */
	private emitSearch(search: Search): void {
		let input: unknown = null;
		try {
			input = search.json ? JSON.parse(search.json) : null;
		} catch {}
		const query = (input as { query?: unknown } | null)?.query;
		const index = this.nextIndex++;
		this.emit({
			type: "content_block_start",
			index,
			content_block: {
				type: "server_tool_use",
				id: search.id,
				name: "web_search",
				input: {},
			},
		});
		this.emit({
			type: "content_block_delta",
			index,
			delta: {
				type: "input_json_delta",
				partial_json: JSON.stringify(
					typeof query === "string" ? { query } : {},
				),
			},
		});
		this.emit({ type: "content_block_stop", index });
		this.flushResults();
	}

	private closeSearch(search: Search): void {
		this.registerSearch(search);
		this.emitSearch(search);
	}

	/**
	 * A WebSearch call's result, as a `web_search_tool_result` block. It goes
	 * out once no other block is open or held; a call not of this leg, or
	 * answered already (a replayed envelope), is ignored.
	 */
	onWebSearchResult(id: string, outcome: WebSearchOutcome): boolean {
		const search = this.searches.get(id);
		if (!search || search.answered) return false;
		search.answered = true;
		if (outcome.status === "completed") this.completedSearches++;
		this.queuedResults.push({
			type: "web_search_tool_result",
			tool_use_id: id,
			content:
				outcome.status === "completed"
					? outcome.sources.map((s) => ({
							type: "web_search_result",
							url: s.url,
							title: s.title,
						}))
					: {
							type: "web_search_tool_result_error",
							error_code: outcome.errorCode,
						},
		});
		this.flushResults();
		return true;
	}

	private flushResults(): void {
		if (this.openOutputs.size > 0 || this.held.length > 0 || !this.sink) return;
		for (const block of this.queuedResults.splice(0)) {
			const index = this.nextIndex++;
			this.emit({ type: "content_block_start", index, content_block: block });
			this.emit({ type: "content_block_stop", index });
		}
	}

	/** The client's name for a tool_use block it is to see; null for any other block. */
	private clientToolName(block: Block): string | null {
		if (block.type !== "tool_use" || this.opts.forwardToolUse === false)
			return null;
		return this.opts.toolNames.clientName(String(block.name ?? ""));
	}

	/** A client tool call goes out whole, and only then is it the leg's. */
	private publishToolUse(
		block: Block,
		name: string,
		input: Record<string, unknown>,
		json: string,
	): void {
		const id = String(block.id);
		this.forwardedThisMessage++;
		this.legToolUseIds.push(id);
		this.opts.onToolUse(id);
		const index = this.nextIndex++;
		this.accumulated.set(index, { type: "tool_use", id, name, input });
		this.emit({
			type: "content_block_start",
			index,
			content_block: { ...block, name, input: {} },
		});
		for (const partial of inputJsonChunks(json))
			this.emit({
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: partial },
			});
		this.emit({ type: "content_block_stop", index });
		this.flushResults();
	}

	private withhold(id: string, reason: WithheldReason): void {
		this.withheldThisMessage++;
		this.opts.onToolUseWithheld?.(id, reason);
	}

	/**
	 * The held blocks go out in order, the client tool calls among them only
	 * when the message stopped on `tool_use` with every input an object. A
	 * message cut off (no message_stop) withholds all its calls.
	 */
	private releaseHeld(
		end: { cutOff: true } | { cutOff: false; stopReason: string | null },
	): void {
		const held = this.held;
		if (!held.length) return;
		const tools = held.filter((h) => h.kind === "tool");
		const inputs = tools.map((t) =>
			t.stopped && !end.cutOff ? streamedToolInput(t.json) : CUT_OFF,
		);
		const reasons = withheldReasons(
			inputs,
			!end.cutOff && end.stopReason === "tool_use",
			end.cutOff ? null : end.stopReason,
		);
		let call = 0;
		for (const item of held) {
			if (item.kind === "tool") {
				const input = inputs[call] as ToolInput;
				const reason = reasons?.[call];
				call++;
				if (reason || !input.ok)
					this.withhold(String(item.block.id), reason ?? { kind: "cut_off" });
				else
					this.publishToolUse(item.block, item.name, input.input, input.json);
			} else if (item.kind === "block") {
				const out = this.openBlock(item.block);
				if (out === null) continue;
				for (const delta of item.deltas) this.applyDelta(out, delta);
				this.closeBlock(out);
			} else if (item.stopped) this.emitSearch(item.search);
		}
		this.held = [];
		this.flushResults();
	}

	/** Held blocks that will never reach the client go; their calls are withheld. */
	private dropHeld(): void {
		const held = this.held;
		this.held = [];
		for (const item of held)
			if (item.kind === "tool")
				this.withhold(String(item.block.id), { kind: "cut_off" });
	}

	/** The model's blocks overlapped around a client tool call: nothing more goes out. */
	private fault(why: string): null {
		this.faulted = true;
		this.dropHeld();
		this.opts.onStreamFault?.(why);
		return null;
	}

	/** Open an output block for an upstream text or thinking block; null when it is not forwarded. */
	private openBlock(block: Block): number | null {
		if (!FORWARDED_BLOCKS.has(block.type)) return null;
		const index = this.nextIndex++;
		this.accumulated.set(index, { type: block.type, text: "" });
		this.emit({ type: "content_block_start", index, content_block: block });
		this.openOutputs.add(index);
		return index;
	}

	private closeBlock(index: number): void {
		if (!this.openOutputs.delete(index)) return;
		this.emit({ type: "content_block_stop", index });
		this.flushResults();
	}

	/**
	 * A new upstream message, or the reply's end, while the last one was cut
	 * off mid-block (a stream that failed, which Claude Code fetches again).
	 * A forwarded block it left open, or held, is closed with what it
	 * carried; its client tool calls and a WebSearch call cut off in its
	 * input were never shown, and go.
	 */
	private endCutOffBlocks(): void {
		this.releaseHeld({ cutOff: true });
		this.searchBlocks.clear();
		for (const index of [...this.openOutputs].sort((a, b) => a - b))
			this.closeBlock(index);
	}

	private applyDelta(index: number, delta: Record<string, unknown>): void {
		const acc = this.accumulated.get(index);
		if (acc && delta.type === "text_delta")
			acc.text = (acc.text ?? "") + String(delta.text ?? "");
		this.emit({ type: "content_block_delta", index, delta });
	}

	private endOfUpstreamMessage(stopReason: string | null): UpstreamMessageEnd {
		this.lastStopReason = stopReason;
		this.lastMessageWithheldCalls = this.withheldThisMessage > 0;
		this.withheldThisMessage = 0;
		const forwarded = this.forwardedThisMessage;
		this.forwardedThisMessage = 0;
		if (stopReason === "tool_use")
			return forwarded > 0
				? { kind: "end", stopReason }
				: { kind: "continue", stopReason };
		if (stopReason !== null && TERMINAL_STOP_REASONS.has(stopReason))
			return { kind: "end", stopReason };
		return { kind: "continue", stopReason };
	}

	private heldAt(index: number): Held | undefined {
		return this.held.find((h) => h.index === index && !h.stopped);
	}

	/** One `stream_event` of the main thread. */
	onStreamEvent(event: StreamEvent): UpstreamMessageEnd | null {
		if (this.faulted) return null;
		switch (event.type) {
			case "message_start": {
				const message = (event.message ?? {}) as Record<string, unknown>;
				if (typeof message.id === "string") this.streamedIds.add(message.id);
				this.endCutOffBlocks();
				this.streaming = true;
				this.indexMap = new Map();
				this.heldDelta = null;
				this.forwardedThisMessage = 0;
				this.withheldThisMessage = 0;
				this.lastInputUsage = withInputUsage(NO_INPUT_USAGE, message.usage);
				this.startMessage(message);
				return null;
			}
			case "content_block_start":
				return this.onBlockStart(
					event.index as number,
					event.content_block as Block,
				);
			case "content_block_delta": {
				const index = event.index as number;
				const delta = event.delta as Record<string, unknown>;
				const search = this.searchBlocks.get(index);
				if (search && delta.type === "input_json_delta")
					search.json += String(delta.partial_json ?? "");
				const held = this.heldAt(index);
				if (held?.kind === "tool" && delta.type === "input_json_delta")
					held.json += String(delta.partial_json ?? "");
				else if (held?.kind === "block") held.deltas.push(delta);
				const out = this.indexMap.get(index);
				if (out !== undefined && out !== null) this.applyDelta(out, delta);
				return null;
			}
			case "content_block_stop": {
				const index = event.index as number;
				const held = this.heldAt(index);
				if (held) {
					held.stopped = true;
					if (held.kind === "search") {
						this.searchBlocks.delete(index);
						this.registerSearch(held.search);
					}
					return null;
				}
				const search = this.searchBlocks.get(index);
				if (search) {
					this.searchBlocks.delete(index);
					this.closeSearch(search);
					return null;
				}
				const out = this.indexMap.get(index);
				if (out !== undefined && out !== null) this.closeBlock(out);
				return null;
			}
			case "message_delta": {
				this.heldDelta = event;
				this.lastInputUsage = withInputUsage(this.lastInputUsage, event.usage);
				const usage = event.usage as { output_tokens?: number } | undefined;
				if (typeof usage?.output_tokens === "number")
					this.outputTokens += usage.output_tokens;
				return null;
			}
			case "message_stop": {
				const delta = (this.heldDelta?.delta ?? {}) as {
					stop_reason?: string | null;
				};
				const stopReason = delta.stop_reason ?? null;
				// Before the stop decides the leg: the calls it releases end it.
				this.releaseHeld({ cutOff: false, stopReason });
				this.streaming = false;
				return this.endOfUpstreamMessage(stopReason);
			}
			default:
				return null;
		}
	}

	private onBlockStart(index: number, block: Block): null {
		// A model streams one block at a time. Anything overlapping a client
		// tool call would have to be reordered around it.
		const open = this.held.find((h) => !h.stopped);
		if (open?.kind === "tool")
			return this.fault(
				`block ${index} started while the client tool call in block ${open.index} was still streaming`,
			);
		const toolName = this.clientToolName(block);
		if (
			toolName !== null &&
			(open || this.openOutputs.size > 0 || this.searchBlocks.size > 0)
		) {
			this.held.push({
				kind: "tool",
				index,
				block,
				name: toolName,
				json: "",
				stopped: false,
			});
			return this.fault(
				`a client tool call started in block ${index} while another block was still open`,
			);
		}
		this.startMessage({});
		this.indexMap.set(index, null);
		if (toolName !== null) {
			this.held.push({
				kind: "tool",
				index,
				block,
				name: toolName,
				json: "",
				stopped: false,
			});
			return null;
		}
		if (this.isWebSearch(block)) {
			const search = this.newSearch(block);
			this.searchBlocks.set(index, search);
			if (this.held.length)
				this.held.push({ kind: "search", index, search, stopped: false });
			return null;
		}
		if (this.held.length) {
			if (FORWARDED_BLOCKS.has(block.type))
				this.held.push({
					kind: "block",
					index,
					block,
					deltas: [],
					stopped: false,
				});
			return null;
		}
		this.indexMap.set(index, this.openBlock(block));
		return null;
	}

	/**
	 * A complete assistant message. Streamed messages were already forwarded
	 * event by event; one Claude Code fetched without streaming (its fallback
	 * when a stream fails) is replayed as events here. Its client tool calls
	 * go out together when it stops on `tool_use`, or on no stop reason at
	 * all (the fallback's envelope, where Claude Code's call of the tool ends
	 * the leg), with every input an object.
	 */
	onAssistantMessage(
		message: Record<string, unknown>,
	): UpstreamMessageEnd | null {
		const id = typeof message.id === "string" ? message.id : null;
		if (id && this.streamedIds.has(id)) return null;
		this.endCutOffBlocks();
		this.withheldThisMessage = 0;
		this.streaming = false;
		this.startMessage(message);
		const content = Array.isArray(message.content)
			? (message.content as Block[])
			: [];
		const stopReason =
			typeof message.stop_reason === "string" ? message.stop_reason : null;
		const inputs = content
			.filter((block) => this.clientToolName(block) !== null)
			.map((block): ToolInput => {
				const input = block.input ?? {};
				return isPlainObject(input)
					? { ok: true, input, json: JSON.stringify(input) }
					: { ok: false, reason: { kind: "not_object" } };
			});
		const reasons = withheldReasons(
			inputs,
			stopReason === null || stopReason === "tool_use",
			stopReason,
		);
		let call = 0;
		for (const block of content) {
			let start: Block = block;
			let delta: Record<string, unknown> | null = null;
			if (this.isWebSearch(block)) {
				const search = this.newSearch(block);
				search.json = JSON.stringify(block.input ?? {});
				this.closeSearch(search);
				continue;
			}
			const name = this.clientToolName(block);
			if (name !== null) {
				const input = inputs[call] as ToolInput;
				const reason = reasons?.[call];
				call++;
				if (reason || !input.ok)
					this.withhold(String(block.id), reason ?? { kind: "not_object" });
				else this.publishToolUse(block, name, input.input, input.json);
				continue;
			}
			if (block.type === "tool_use") continue;
			if (block.type === "text") {
				start = { type: "text", text: "" };
				delta = { type: "text_delta", text: block.text ?? "" };
			} else if (block.type === "thinking") {
				start = { type: "thinking", thinking: "", signature: "" };
				this.openAndReplay(start, [
					{ type: "thinking_delta", thinking: block.thinking ?? "" },
					{ type: "signature_delta", signature: block.signature ?? "" },
				]);
				continue;
			}
			this.openAndReplay(start, delta ? [delta] : []);
		}
		const usage = message.usage as { output_tokens?: number } | undefined;
		// A client tool call can end the leg on a message without a stop reason.
		this.lastInputUsage = withInputUsage(NO_INPUT_USAGE, usage);
		if (message.stop_reason === null || message.stop_reason === undefined)
			return null;
		if (typeof usage?.output_tokens === "number")
			this.outputTokens += usage.output_tokens;
		this.heldDelta = {
			type: "message_delta",
			delta: {
				stop_reason: message.stop_reason,
				stop_sequence: message.stop_sequence ?? null,
			},
			usage: message.usage,
		};
		return this.endOfUpstreamMessage(String(message.stop_reason));
	}

	private openAndReplay(start: Block, deltas: Record<string, unknown>[]): void {
		const out = this.openBlock(start);
		if (out === null) return;
		for (const delta of deltas) this.applyDelta(out, delta);
		this.closeBlock(out);
	}

	/**
	 * Close the leg's reply with `message_delta` and `message_stop`. Its usage
	 * is the leg's: the input and cache counts of its last model call (the
	 * `message_start` went out with the first call's), and the output of all.
	 *
	 *   call 1: input 10, cache read 0,   output 50 (max_tokens)
	 *   call 2: input 20, cache read 100, output 7
	 *   delta:  input 20, cache read 100, output 57
	 */
	finish(stopReason: string | null): void {
		if (!this.sink) return;
		this.startMessage({});
		// A search still unanswered never completed.
		for (const search of this.searches.values())
			if (!search.answered)
				this.onWebSearchResult(search.id, {
					status: "failed",
					errorCode: "unavailable",
					searchCount: 0,
				});
		this.endCutOffBlocks();
		this.flushResults();
		const held = (this.heldDelta ?? {}) as {
			delta?: Record<string, unknown>;
			usage?: Record<string, unknown>;
		};
		this.emit({
			type: "message_delta",
			delta: {
				stop_reason: stopReason ?? this.lastStopReason ?? "end_turn",
				stop_sequence: held.delta?.stop_sequence ?? null,
			},
			usage: {
				...(held.usage ?? {}),
				...this.lastInputUsage,
				output_tokens: this.outputTokens,
			},
		});
		this.emit({ type: "message_stop" });
		this.sink = null;
	}
}
