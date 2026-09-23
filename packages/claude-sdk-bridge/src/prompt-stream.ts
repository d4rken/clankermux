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

	push(content: string | Block[]): void {
		if (this.ended) return;
		const message = {
			type: "user",
			message: { role: "user", content },
			parent_tool_use_id: null,
		} as SDKUserMessage;
		const waiter = this.waiter;
		if (waiter) {
			this.waiter = null;
			waiter({ value: message, done: false });
		} else this.queue.push(message);
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.({ value: undefined, done: true });
	}

	get isEnded(): boolean {
		return this.ended;
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: () => {
				const next = this.queue.shift();
				if (next) return Promise.resolve({ value: next, done: false });
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
