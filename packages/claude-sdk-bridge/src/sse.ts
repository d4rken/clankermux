import {
	type BridgeError,
	bridgeErrors,
	errorBody,
	errorResponse,
} from "./errors";
import type { Block } from "./turn-request";

const encoder = new TextEncoder();

export function sseFrame(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

type SseEvent = { type: string; [key: string]: unknown };

/**
 * Folds the events of one reply into the Messages API's non-streaming shape,
 * for an outer request that asked for `stream: false`.
 */
export class MessageReducer {
	private message: Record<string, unknown> | null = null;
	private readonly blocks: Array<Block & { _json?: string }> = [];

	apply(event: SseEvent): void {
		switch (event.type) {
			case "message_start":
				this.message = { ...(event.message as Record<string, unknown>) };
				break;
			case "content_block_start":
				this.blocks[event.index as number] = {
					...(event.content_block as Block),
				};
				break;
			case "content_block_delta": {
				const block = this.blocks[event.index as number];
				const delta = event.delta as Record<string, unknown>;
				if (!block) break;
				if (delta.type === "text_delta")
					block.text = String(block.text ?? "") + String(delta.text ?? "");
				else if (delta.type === "input_json_delta")
					block._json = (block._json ?? "") + String(delta.partial_json ?? "");
				else if (delta.type === "thinking_delta")
					block.thinking =
						String(block.thinking ?? "") + String(delta.thinking ?? "");
				else if (delta.type === "signature_delta")
					block.signature = String(delta.signature ?? "");
				break;
			}
			case "message_delta": {
				if (!this.message) break;
				const delta = event.delta as Record<string, unknown>;
				this.message.stop_reason = delta.stop_reason ?? null;
				this.message.stop_sequence = delta.stop_sequence ?? null;
				const usage = event.usage as Record<string, unknown> | undefined;
				if (usage)
					this.message.usage = {
						...((this.message.usage as Record<string, unknown>) ?? {}),
						...usage,
					};
				break;
			}
		}
	}

	result(): Record<string, unknown> {
		const content = this.blocks.filter(Boolean).map(({ _json, ...block }) => {
			if (block.type !== "tool_use") return block;
			let input: unknown = block.input ?? {};
			if (_json) {
				try {
					input = JSON.parse(_json);
				} catch {
					input = {};
				}
			}
			return { ...block, input };
		});
		return {
			...(this.message ?? { type: "message", role: "assistant" }),
			content,
		};
	}
}

export interface LegResponseOptions {
	/** The client asked for SSE; otherwise the reply is reduced to one JSON Message. */
	stream: boolean;
	headHoldMs: number;
	pingIntervalMs: number;
	signal: AbortSignal;
	/** The client went away (disconnect or abort) before the reply ended. */
	onClientGone: () => void;
	bumpIdleTimeout?: () => void;
}

/**
 * The HTTP response of one leg. A streaming head is held until the first
 * event (or `headHoldMs`), so a failure before any output still gets its real
 * status as JSON; once committed, failures become an SSE `error` event, and
 * silences longer than `pingIntervalMs` get a `ping`.
 */
export class LegResponse {
	readonly response: Promise<Response>;
	private resolveResponse!: (response: Response) => void;
	private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	private readonly buffered: Uint8Array[] = [];
	private readonly reducer: MessageReducer | null;
	private state: "holding" | "streaming" | "done" = "holding";
	private headSent = false;
	private holdTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private lastWrite = 0;
	private readonly abortListener: () => void;

	constructor(private readonly opts: LegResponseOptions) {
		this.response = new Promise((resolve) => {
			this.resolveResponse = resolve;
		});
		this.reducer = opts.stream ? null : new MessageReducer();
		if (opts.stream)
			this.holdTimer = setTimeout(() => this.commit(), opts.headHoldMs);
		this.pingTimer = setInterval(
			() => this.tick(),
			Math.max(50, Math.min(opts.pingIntervalMs, 5_000)),
		);
		this.abortListener = () => this.clientGone();
		if (opts.signal.aborted) queueMicrotask(this.abortListener);
		else
			opts.signal.addEventListener("abort", this.abortListener, { once: true });
	}

	/** Whether the head has gone out, so errors can only be SSE events now. */
	get committed(): boolean {
		return this.headSent;
	}

	get done(): boolean {
		return this.state === "done";
	}

	private tick(): void {
		if (this.state === "done") return;
		this.opts.bumpIdleTimeout?.();
		if (
			this.state === "streaming" &&
			Date.now() - this.lastWrite >= this.opts.pingIntervalMs
		)
			this.write(sseFrame("ping", { type: "ping" }));
	}

	private clientGone(): void {
		if (this.state === "done") return;
		const holding = this.state === "holding";
		this.cleanup();
		this.state = "done";
		// Whoever awaits the response must not wait forever for a client that left.
		if (holding) this.resolveResponse(errorResponse(bridgeErrors.clientGone()));
		else
			try {
				this.controller?.close();
			} catch {}
		this.opts.onClientGone();
	}

	private commit(): void {
		if (this.state !== "holding" || !this.opts.stream) return;
		this.state = "streaming";
		this.headSent = true;
		if (this.holdTimer) clearTimeout(this.holdTimer);
		this.holdTimer = null;
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.controller = controller;
				const chunks = this.buffered.splice(0);
				// A head committed by the hold timer carries a ping, so the client
				// sees bytes and not just headers.
				if (!chunks.length) chunks.push(sseFrame("ping", { type: "ping" }));
				for (const chunk of chunks) controller.enqueue(chunk);
				this.lastWrite = Date.now();
			},
			cancel: () => this.clientGone(),
		});
		this.resolveResponse(
			new Response(stream, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				},
			}),
		);
	}

	private write(chunk: Uint8Array): void {
		this.lastWrite = Date.now();
		if (this.controller) {
			try {
				this.controller.enqueue(chunk);
			} catch {
				this.clientGone();
			}
		} else this.buffered.push(chunk);
	}

	/** One Anthropic stream event of the reply. */
	send(event: SseEvent): void {
		if (this.state === "done") return;
		this.opts.bumpIdleTimeout?.();
		if (this.reducer) {
			this.reducer.apply(event);
			return;
		}
		this.write(sseFrame(event.type, event));
		if (this.state === "holding") this.commit();
	}

	/** The reply is complete. */
	end(): void {
		if (this.state === "done") return;
		if (this.reducer) {
			this.state = "done";
			this.cleanup();
			this.resolveResponse(Response.json(this.reducer.result()));
			return;
		}
		if (this.state === "holding") this.commit();
		this.state = "done";
		this.cleanup();
		try {
			this.controller?.close();
		} catch {}
	}

	/** The reply failed: a JSON error with its status if nothing went out yet. */
	fail(error: BridgeError): void {
		if (this.state === "done") return;
		if (this.state === "holding") {
			this.state = "done";
			this.cleanup();
			this.resolveResponse(errorResponse(error));
			return;
		}
		this.write(sseFrame("error", errorBody(error)));
		this.state = "done";
		this.cleanup();
		try {
			this.controller?.close();
		} catch {}
	}

	private cleanup(): void {
		if (this.holdTimer) clearTimeout(this.holdTimer);
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.holdTimer = null;
		this.pingTimer = null;
		this.opts.signal.removeEventListener("abort", this.abortListener);
	}
}
