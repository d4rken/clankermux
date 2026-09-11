import { randomUUID } from "node:crypto";
import { TIME_CONSTANTS } from "@clankermux/core";
import { DevinRpcError, decodeConnect } from "./connect";
import { GetChatMessageResponseSchema, StopReason } from "./vendor/devin-proto";
import { fromBinary } from "./vendor/protobuf";

export interface DevinResponseContext {
	model: string;
	stream: boolean;
	signal?: AbortSignal;
}
type Event = Record<string, unknown> & { type: string };
type Block = {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
	id?: string;
	name?: string;
	input?: unknown;
};

export function devinErrorResponse(error: unknown): Response {
	const rpc =
		error instanceof DevinRpcError
			? error
			: new DevinRpcError(
					error instanceof Error && error.name === "TimeoutError"
						? "deadline_exceeded"
						: "data_loss",
					error instanceof Error && error.name === "TimeoutError"
						? "Devin response timed out"
						: "Devin response could not be decoded",
				);
	return Response.json(
		{
			type: "error",
			error: { type: errorType(rpc.status), message: rpc.message },
		},
		{
			status: rpc.status,
			headers:
				rpc.status === 429
					? { "retry-after": String(rpc.retryAfterSeconds ?? 60) }
					: undefined,
		},
	);
}
function errorType(status: number): string {
	return status === 429
		? "rate_limit_error"
		: status === 401
			? "authentication_error"
			: status === 403
				? "permission_error"
				: status === 400
					? "invalid_request_error"
					: "api_error";
}
export function wrapDevinSignature(model: string, signature: string): string {
	return `devin:${Buffer.from(JSON.stringify({ model, signature })).toString("base64url")}`;
}
export function unwrapDevinSignature(model: string, value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("devin:")) return "";
	try {
		const parsed = JSON.parse(
			Buffer.from(value.slice(6), "base64url").toString(),
		);
		return parsed.model === model && typeof parsed.signature === "string"
			? parsed.signature
			: "";
	} catch {
		return "";
	}
}

async function* translate(
	body: ReadableStream<Uint8Array>,
	context: DevinResponseContext,
	signal: AbortSignal,
): AsyncGenerator<Event> {
	let started = false;
	let id = `msg_${randomUUID()}`;
	let model = context.model;
	let index = 0;
	let textIndex: number | null = null;
	let thinkingIndex: number | null = null;
	let thinkingSignature = "";
	const tools = new Map<
		string,
		{ index: number; name: string; json: string }
	>();
	let activeTool: string | null = null;
	let stop = StopReason.UNSPECIFIED;
	let usage = {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
	};
	let totalBytes = 0;
	for await (const payload of decodeConnect(body, signal)) {
		totalBytes += payload.length;
		if (totalBytes > 128 * 1024 * 1024)
			throw new DevinRpcError("data_loss", "Devin stream exceeds size limit");
		const msg = fromBinary(GetChatMessageResponseSchema, payload);
		if (!started) {
			if (msg.messageId) id = msg.messageId;
			if (msg.actualModelUid) model = msg.actualModelUid;
		}
		if (msg.usage)
			usage = {
				input_tokens: Number(msg.usage.inputTokens),
				output_tokens: Number(msg.usage.outputTokens),
				cache_read_input_tokens: Number(msg.usage.cacheReadTokens),
				cache_creation_input_tokens: Number(msg.usage.cacheWriteTokens),
			};
		if (msg.stopReason !== StopReason.UNSPECIFIED) stop = msg.stopReason;
		if (msg.redact || msg.thinkingRedacted)
			throw new DevinRpcError(
				"permission_denied",
				"Devin withheld this completion",
			);
		const meaningful = !!(
			msg.deltaText ||
			msg.deltaThinking ||
			msg.deltaToolCalls.length ||
			msg.stopReason !== StopReason.UNSPECIFIED
		);
		if (!started && meaningful) {
			started = true;
			yield {
				type: "message_start",
				message: {
					id,
					type: "message",
					role: "assistant",
					model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage,
				},
			};
		}
		if (msg.deltaThinking) {
			if (textIndex !== null) {
				yield { type: "content_block_stop", index: textIndex };
				textIndex = null;
			}
			if (thinkingIndex === null) {
				thinkingIndex = index++;
				thinkingSignature = "";
				yield {
					type: "content_block_start",
					index: thinkingIndex,
					content_block: { type: "thinking", thinking: "" },
				};
			}
			yield {
				type: "content_block_delta",
				index: thinkingIndex,
				delta: { type: "thinking_delta", thinking: msg.deltaThinking },
			};
		}
		if (msg.deltaSignature && thinkingIndex !== null)
			thinkingSignature += msg.deltaSignature;
		if (
			(msg.deltaText || msg.deltaToolCalls.length) &&
			thinkingIndex !== null
		) {
			if (thinkingSignature)
				yield {
					type: "content_block_delta",
					index: thinkingIndex,
					delta: {
						type: "signature_delta",
						signature: wrapDevinSignature(model, thinkingSignature),
					},
				};
			yield { type: "content_block_stop", index: thinkingIndex };
			thinkingIndex = null;
		}
		if (msg.deltaText) {
			if (textIndex === null) {
				textIndex = index++;
				yield {
					type: "content_block_start",
					index: textIndex,
					content_block: { type: "text", text: "" },
				};
			}
			yield {
				type: "content_block_delta",
				index: textIndex,
				delta: { type: "text_delta", text: msg.deltaText },
			};
		}
		if (msg.deltaToolCalls.length && textIndex !== null) {
			yield { type: "content_block_stop", index: textIndex };
			textIndex = null;
		}
		for (const call of msg.deltaToolCalls) {
			const toolId: string | null = call.id || activeTool;
			if (!toolId)
				throw new DevinRpcError("data_loss", "Devin tool delta has no call ID");
			activeTool = toolId;
			let tool = tools.get(toolId);
			if (!tool) {
				if (!call.name)
					throw new DevinRpcError("data_loss", "Devin tool call has no name");
				tool = { index: index++, name: call.name, json: "" };
				tools.set(toolId, tool);
				yield {
					type: "content_block_start",
					index: tool.index,
					content_block: {
						type: "tool_use",
						id: toolId,
						name: call.name,
						input: {},
					},
				};
			}
			if (call.name && call.name !== tool.name)
				throw new DevinRpcError(
					"data_loss",
					"Devin changed a streamed tool name",
				);
			if (call.argumentsJson) {
				const next = call.argumentsJson.startsWith(tool.json)
					? call.argumentsJson
					: tool.json + call.argumentsJson;
				const delta = next.slice(tool.json.length);
				tool.json = next;
				if (delta)
					yield {
						type: "content_block_delta",
						index: tool.index,
						delta: { type: "input_json_delta", partial_json: delta },
					};
			}
		}
	}
	if (
		stop === StopReason.ERROR ||
		stop === StopReason.INCOMPLETE ||
		stop === StopReason.PARTIAL ||
		stop === StopReason.NONFINITE_LOGIT_OR_PROB
	)
		throw new DevinRpcError(
			"data_loss",
			"Devin did not finish this completion",
		);
	if (!started)
		throw new DevinRpcError("data_loss", "Devin returned an empty completion");
	if (thinkingIndex !== null) {
		if (thinkingSignature)
			yield {
				type: "content_block_delta",
				index: thinkingIndex,
				delta: {
					type: "signature_delta",
					signature: wrapDevinSignature(model, thinkingSignature),
				},
			};
		yield { type: "content_block_stop", index: thinkingIndex };
	}
	if (textIndex !== null)
		yield { type: "content_block_stop", index: textIndex };
	for (const tool of tools.values()) {
		try {
			const args = JSON.parse(tool.json || "{}");
			if (!args || typeof args !== "object" || Array.isArray(args))
				throw new Error();
		} catch {
			throw new DevinRpcError(
				"data_loss",
				"Devin returned invalid tool arguments",
			);
		}
		yield { type: "content_block_stop", index: tool.index };
	}
	if (stop === StopReason.CONTENT_FILTER)
		throw new DevinRpcError(
			"permission_denied",
			"Devin filtered this completion",
		);
	yield {
		type: "message_delta",
		delta: {
			stop_reason: tools.size
				? "tool_use"
				: stop === StopReason.MAX_TOKENS
					? "max_tokens"
					: "end_turn",
			stop_sequence: null,
		},
		usage,
	};
	yield { type: "message_stop" };
}

/** Normalize before the proxy classifies status; bound the initial peek to 500ms. */
export async function convertDevinResponse(
	response: Response,
	context: DevinResponseContext,
): Promise<Response> {
	if (!response.ok) {
		await response.body?.cancel();
		return devinErrorResponse(
			new DevinRpcError(
				response.status === 429
					? "resource_exhausted"
					: response.status === 401
						? "unauthenticated"
						: response.status === 403
							? "permission_denied"
							: "unavailable",
				`Devin request failed (${response.status})`,
			),
		);
	}
	if (!response.body)
		return devinErrorResponse(
			new DevinRpcError("data_loss", "Empty Devin response"),
		);
	const cancellation = new AbortController();
	const events = translate(
		response.body,
		context,
		AbortSignal.any([
			cancellation.signal,
			...(context.signal ? [context.signal] : []),
			AbortSignal.timeout(TIME_CONSTANTS.STREAM_FORWARD_TOTAL_TIMEOUT_MS),
		]),
	);
	if (!context.stream) {
		try {
			let message: Record<string, unknown> = {};
			const blocks: Block[] = [];
			const json = new Map<number, string>();
			for await (const event of events) {
				const idx = event.index as number;
				if (event.type === "message_start")
					message = event.message as Record<string, unknown>;
				else if (event.type === "content_block_start")
					blocks[idx] = event.content_block as Block;
				else if (event.type === "content_block_delta") {
					const delta = event.delta as Record<string, string>;
					const block = blocks[idx];
					if (!block) throw new Error();
					if (delta.type === "text_delta")
						block.text = (block.text ?? "") + delta.text;
					if (delta.type === "thinking_delta")
						block.thinking = (block.thinking ?? "") + delta.thinking;
					if (delta.type === "signature_delta")
						block.signature = (block.signature ?? "") + delta.signature;
					if (delta.type === "input_json_delta")
						json.set(idx, (json.get(idx) ?? "") + delta.partial_json);
				} else if (event.type === "message_delta") {
					Object.assign(message, event.delta);
					message.usage = event.usage;
				}
			}
			for (const [idx, value] of json) {
				const block = blocks[idx];
				if (!block) throw new Error("Missing tool block");
				block.input = JSON.parse(value);
			}
			return Response.json({ ...message, content: blocks });
		} catch (error) {
			context.signal?.throwIfAborted();
			return devinErrorResponse(error);
		}
	}
	let pending = events.next();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const first = await Promise.race([
			pending,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), 500);
			}),
		]);
		if (first) pending = Promise.resolve(first);
	} catch (error) {
		context.signal?.throwIfAborted();
		return devinErrorResponse(error);
	} finally {
		clearTimeout(timer);
	}
	const encoder = new TextEncoder();
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const event = await pending;
				if (cancelled) return;
				if (event.done) {
					controller.close();
					return;
				}
				controller.enqueue(
					encoder.encode(
						`event: ${event.value.type}\ndata: ${JSON.stringify(event.value)}\n\n`,
					),
				);
				pending = events.next();
				// Attach rejection handling immediately; the consumer may pause between pulls.
				pending.catch(() => {});
			} catch (error) {
				if (cancelled) return;
				const errorResponse = devinErrorResponse(error);
				controller.enqueue(
					encoder.encode(
						`event: error\ndata: ${JSON.stringify(await errorResponse.json())}\n\n`,
					),
				);
				controller.close();
			}
		},
		async cancel() {
			cancelled = true;
			cancellation.abort();
			await events.return(undefined);
		},
	});
	return new Response(body, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		},
	});
}
