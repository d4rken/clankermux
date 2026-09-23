import { clientToolName } from "./tool-server";
import type { Block } from "./turn-request";

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

interface Accumulated {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	json?: string;
}

/**
 * Turns Claude Code's model messages into one Anthropic reply per leg. Every
 * model call Claude Code makes arrives as its own message; the client must see
 * a single message per request, so later messages of the same leg are merged
 * in with continued block indexes. Only the client's own tools are forwarded,
 * renamed back from `mcp__client__<name>`: forwarding any other tool_use would
 * leave the client waiting on a call it cannot answer.
 */
export class ReplyComposer {
	private sink: ((event: StreamEvent) => void) | null = null;
	private legStarted = false;
	private nextIndex = 0;
	private indexMap = new Map<number, number | null>();
	private heldDelta: Record<string, unknown> | null = null;
	private outputTokens = 0;
	private forwardedThisMessage = 0;
	private readonly streamedIds = new Set<string>();
	private streaming = false;
	private accumulated = new Map<number, Accumulated>();
	/** tool_use ids handed to the client in the current leg. */
	legToolUseIds: string[] = [];
	lastStopReason: string | null = null;

	constructor(
		private readonly opts: {
			knownTools: ReadonlySet<string>;
			/** A client tool_use was forwarded; its id now names this turn. */
			onToolUse: (id: string) => void;
			newMessageId: () => string;
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
		this.forwardedThisMessage = 0;
		this.accumulated = new Map();
		this.legToolUseIds = [];
		this.lastStopReason = null;
	}

	detach(): void {
		this.sink = null;
	}

	/** The leg's reply as content blocks, the way the client will store it. */
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

	/** Open an output block for an upstream block; null when it is not forwarded. */
	private openBlock(block: Block): number | null {
		let out: Block;
		if (block.type === "tool_use") {
			const name = clientToolName(
				String(block.name ?? ""),
				this.opts.knownTools,
			);
			if (name === null) return null;
			const id = String(block.id);
			out = { ...block, name };
			this.forwardedThisMessage++;
			this.legToolUseIds.push(id);
			this.opts.onToolUse(id);
			const index = this.nextIndex++;
			this.accumulated.set(index, { type: "tool_use", id, name, json: "" });
			this.emit({ type: "content_block_start", index, content_block: out });
			return index;
		}
		if (!FORWARDED_BLOCKS.has(block.type)) return null;
		const index = this.nextIndex++;
		this.accumulated.set(index, { type: block.type, text: "" });
		this.emit({ type: "content_block_start", index, content_block: block });
		return index;
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
				this.startMessage(message);
				return null;
			}
			case "content_block_start": {
				this.startMessage({});
				const out = this.openBlock(event.content_block as Block);
				this.indexMap.set(event.index as number, out);
				return null;
			}
			case "content_block_delta": {
				const out = this.indexMap.get(event.index as number);
				if (out !== undefined && out !== null)
					this.applyDelta(out, event.delta as Record<string, unknown>);
				return null;
			}
			case "content_block_stop": {
				const out = this.indexMap.get(event.index as number);
				if (out !== undefined && out !== null)
					this.emit({ type: "content_block_stop", index: out });
				return null;
			}
			case "message_delta": {
				this.heldDelta = event;
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
		this.emit({ type: "content_block_stop", index: out });
	}

	/** Close the leg's reply with `message_delta` and `message_stop`. */
	finish(stopReason: string | null): void {
		if (!this.sink) return;
		this.startMessage({});
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
			usage: { ...(held.usage ?? {}), output_tokens: this.outputTokens },
		});
		this.emit({ type: "message_stop" });
		this.sink = null;
	}
}
