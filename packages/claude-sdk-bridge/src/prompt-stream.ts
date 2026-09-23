import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Block } from "./turn-request";

/**
 * Claude Code's input. It stays open until the turn's `result`: closing it
 * early ends the child's stdin, which kills MCP calls still parked on the
 * client.
 */
export class PromptStream implements AsyncIterable<SDKUserMessage> {
	private readonly queue: SDKUserMessage[] = [];
	private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | null =
		null;
	private ended = false;
	/** Resolvers for messages Claude Code has not read yet, in queue order. */
	private readonly unread: Array<() => void> = [];

	/**
	 * Push `content` and resolve once Claude Code has read it off the stream
	 * (or the stream ended first). Messages are read in the order pushed.
	 */
	enqueue(content: string | Block[]): Promise<void> {
		return new Promise((resolve) => this.add(content, resolve));
	}

	push(content: string | Block[]): void {
		this.add(content, () => {});
	}

	private add(content: string | Block[], onRead: () => void): void {
		if (this.ended) {
			onRead();
			return;
		}
		const message = {
			type: "user",
			message: { role: "user", content },
			parent_tool_use_id: null,
		} as SDKUserMessage;
		const waiter = this.waiter;
		if (waiter) {
			this.waiter = null;
			waiter({ value: message, done: false });
			onRead();
			return;
		}
		this.queue.push(message);
		this.unread.push(onRead);
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.({ value: undefined, done: true });
		for (const resolve of this.unread.splice(0)) resolve();
	}

	get isEnded(): boolean {
		return this.ended;
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: () => {
				const next = this.queue.shift();
				if (next) {
					this.unread.shift()?.();
					return Promise.resolve({ value: next, done: false });
				}
				if (this.ended)
					return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => {
					this.waiter = resolve;
				});
			},
			return: () => {
				this.end();
				return Promise.resolve({ value: undefined, done: true });
			},
		};
	}
}
