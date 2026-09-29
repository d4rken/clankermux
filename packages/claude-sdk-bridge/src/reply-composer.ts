import type { ToolNames } from "./tool-server";
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
	json?: string;
}

/** One of Claude Code's WebSearch calls, shown to the client as Anthropic's server tool. */
interface Search {
	id: string;
	json: string;
	/** Its result is queued or sent. */
	answered: boolean;
}

/**
 * Turns Claude Code's model messages into one Anthropic reply per leg. Every
 * model call Claude Code makes arrives as its own message; the client must see
 * a single message per request, so later messages of the same leg are merged
 * in with continued block indexes. Only the client's own tools are forwarded,
 * renamed back to the client's names: forwarding any other tool_use would
 * leave the client waiting on a call it cannot answer.
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
	private readonly streamedIds = new Set<string>();
	private streaming = false;
	private accumulated = new Map<number, Accumulated>();
	/** tool_use ids handed to the client in the current leg. */
	legToolUseIds: string[] = [];
	lastStopReason: string | null = null;
	/** The leg's WebSearch calls, by tool_use id. */
	private searches = new Map<string, Search>();
	/** Upstream block index to the search whose input it streams. */
	private searchBlocks = new Map<number, Search>();
	/** Results waiting for the output block open now to close. */
	private queuedResults: Block[] = [];
	private openOutputBlocks = 0;
	/** Searches of this leg whose result was a completed search. */
	completedSearches = 0;

	constructor(
		private readonly opts: {
			toolNames: ToolNames;
			/** A client tool_use was forwarded; its id now names this turn. */
			onToolUse: (id: string) => void;
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
		this.sink = sink;
		this.streaming = false;
		this.legStarted = false;
		this.nextIndex = 0;
		this.indexMap = new Map();
		this.heldDelta = null;
		this.outputTokens = 0;
		this.lastInputUsage = {};
		this.forwardedThisMessage = 0;
		this.accumulated = new Map();
		this.legToolUseIds = [];
		this.lastStopReason = null;
		this.searches = new Map();
		this.searchBlocks = new Map();
		this.queuedResults = [];
		this.openOutputBlocks = 0;
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
				if (block.type === "tool_use") {
					let input: unknown = {};
					try {
						input = block.json ? JSON.parse(block.json) : {};
					} catch {}
					return [{ type: "tool_use", id: block.id, name: block.name, input }];
				}
				return [];
			});
	}

	private emit(event: StreamEvent): void {
		this.sink?.(event);
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

	/** A WebSearch call opens as a `server_tool_use` block; its input follows at its end. */
	private openSearch(block: Block): Search {
		this.startMessage({});
		const search: Search = { id: String(block.id), json: "", answered: false };
		this.searches.set(search.id, search);
		this.opts.onWebSearch?.(search.id);
		return search;
	}

	/**
	 * Only the query goes out: Claude Code's input may also carry the domain
	 * lists the bridge set.
	 */
	private closeSearch(search: Search): void {
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

	/**
	 * A WebSearch call's result, as a `web_search_tool_result` block. It goes
	 * out once no other block is open; a call not of this leg, or answered
	 * already (a replayed envelope), is ignored.
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
		if (this.openOutputBlocks > 0 || !this.sink) return;
		for (const block of this.queuedResults.splice(0)) {
			const index = this.nextIndex++;
			this.emit({ type: "content_block_start", index, content_block: block });
			this.emit({ type: "content_block_stop", index });
		}
	}

	/** Open an output block for an upstream block; null when it is not forwarded. */
	private openBlock(block: Block): number | null {
		let out: Block;
		if (block.type === "tool_use") {
			if (this.opts.forwardToolUse === false) return null;
			const name = this.opts.toolNames.clientName(String(block.name ?? ""));
			if (name === null) return null;
			const id = String(block.id);
			out = { ...block, name };
			this.forwardedThisMessage++;
			this.legToolUseIds.push(id);
			this.opts.onToolUse(id);
			const index = this.nextIndex++;
			this.accumulated.set(index, { type: "tool_use", id, name, json: "" });
			this.emit({ type: "content_block_start", index, content_block: out });
			this.openOutputBlocks++;
			return index;
		}
		if (!FORWARDED_BLOCKS.has(block.type)) return null;
		const index = this.nextIndex++;
		this.accumulated.set(index, { type: block.type, text: "" });
		this.emit({ type: "content_block_start", index, content_block: block });
		this.openOutputBlocks++;
		return index;
	}

	private closeBlock(index: number): void {
		this.emit({ type: "content_block_stop", index });
		this.openOutputBlocks = Math.max(0, this.openOutputBlocks - 1);
		this.flushResults();
	}

	private applyDelta(index: number, delta: Record<string, unknown>): void {
		const acc = this.accumulated.get(index);
		if (acc && delta.type === "text_delta")
			acc.text = (acc.text ?? "") + String(delta.text ?? "");
		if (acc && delta.type === "input_json_delta")
			acc.json = (acc.json ?? "") + String(delta.partial_json ?? "");
		this.emit({ type: "content_block_delta", index, delta });
	}

	private endOfUpstreamMessage(stopReason: string | null): UpstreamMessageEnd {
		this.lastStopReason = stopReason;
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

	/** One `stream_event` of the main thread. */
	onStreamEvent(event: StreamEvent): UpstreamMessageEnd | null {
		switch (event.type) {
			case "message_start": {
				const message = (event.message ?? {}) as Record<string, unknown>;
				if (typeof message.id === "string") this.streamedIds.add(message.id);
				this.streaming = true;
				this.indexMap = new Map();
				this.heldDelta = null;
				this.forwardedThisMessage = 0;
				this.lastInputUsage = withInputUsage(NO_INPUT_USAGE, message.usage);
				this.startMessage(message);
				return null;
			}
			case "content_block_start": {
				this.startMessage({});
				const block = event.content_block as Block;
				if (this.isWebSearch(block)) {
					this.searchBlocks.set(event.index as number, this.openSearch(block));
					this.indexMap.set(event.index as number, null);
					return null;
				}
				const out = this.openBlock(block);
				this.indexMap.set(event.index as number, out);
				return null;
			}
			case "content_block_delta": {
				const search = this.searchBlocks.get(event.index as number);
				const delta = event.delta as Record<string, unknown>;
				if (search && delta.type === "input_json_delta")
					search.json += String(delta.partial_json ?? "");
				const out = this.indexMap.get(event.index as number);
				if (out !== undefined && out !== null) this.applyDelta(out, delta);
				return null;
			}
			case "content_block_stop": {
				const search = this.searchBlocks.get(event.index as number);
				if (search) {
					this.searchBlocks.delete(event.index as number);
					this.closeSearch(search);
					return null;
				}
				const out = this.indexMap.get(event.index as number);
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
				this.streaming = false;
				const delta = (this.heldDelta?.delta ?? {}) as {
					stop_reason?: string | null;
				};
				return this.endOfUpstreamMessage(delta.stop_reason ?? null);
			}
			default:
				return null;
		}
	}

	/**
	 * A complete assistant message. Streamed messages were already forwarded
	 * event by event; one Claude Code fetched without streaming (its fallback
	 * when a stream fails) is replayed as events here.
	 */
	onAssistantMessage(
		message: Record<string, unknown>,
	): UpstreamMessageEnd | null {
		const id = typeof message.id === "string" ? message.id : null;
		if (id && this.streamedIds.has(id)) return null;
		this.startMessage(message);
		const content = Array.isArray(message.content)
			? (message.content as Block[])
			: [];
		for (const block of content) {
			let start: Block = block;
			let delta: Record<string, unknown> | null = null;
			if (this.isWebSearch(block)) {
				const search = this.openSearch(block);
				search.json = JSON.stringify(block.input ?? {});
				this.closeSearch(search);
				continue;
			}
			if (block.type === "text") {
				start = { type: "text", text: "" };
				delta = { type: "text_delta", text: block.text ?? "" };
			} else if (block.type === "tool_use") {
				start = { ...block, input: {} };
				delta = {
					type: "input_json_delta",
					partial_json: JSON.stringify(block.input ?? {}),
				};
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
		this.openOutputBlocks = 0;
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
