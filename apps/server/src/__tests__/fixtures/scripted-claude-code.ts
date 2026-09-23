/**
 * A stand-in for the Claude Code process, driven through the bridge's injected
 * `queryFn`: it makes one model call through the bridge's inner listener, the
 * way Claude Code does with retries off, and relays what came back as SDK
 * messages. The inner call goes through the real proxy to the mock upstream,
 * so the bridge sees real inner outcomes.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	assistantMessage,
	type FakeQuery,
	fakeQueryFn,
	resultMessage,
} from "../../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/fake-sdk";

export { type FakeQuery, fakeQueryFn };

let seq = 0;

function streamEvent(event: Record<string, unknown>): SDKMessage {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: null,
		uuid: `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`,
		session_id: "s",
	} as unknown as SDKMessage;
}

function parseEvents(text: string): Record<string, unknown>[] {
	return text
		.split("\n\n")
		.map((frame) =>
			frame
				.split("\n")
				.find((line) => line.startsWith("data: "))
				?.slice(6),
		)
		.filter((data): data is string => !!data)
		.map((data) => JSON.parse(data) as Record<string, unknown>);
}

/** Claude Code's model call for this query, through the inner listener. */
export async function callModel(
	query: FakeQuery,
	body: Record<string, unknown> = {},
): Promise<Response> {
	const env = query.options.env ?? {};
	return fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`,
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"user-agent": "claude-cli/2.1.280 (external, sdk-ts)",
		},
		body: JSON.stringify({
			model: query.options.model,
			max_tokens: 1024,
			stream: true,
			messages: [{ role: "user", content: "hello" }],
			...body,
		}),
	});
}

/**
 * Relay one model call's answer as Claude Code reports it: streamed events and
 * a successful result, or its give-up (an error assistant message, then an
 * error result) with `failureText` as its own wording.
 */
export async function relay(
	query: FakeQuery,
	response: Response,
	failureText = `API Error: ${response.status}`,
): Promise<void> {
	if (response.ok) {
		for (const event of parseEvents(await response.text()))
			query.emit(streamEvent(event));
		query.emit(resultMessage());
	} else {
		await response.text();
		giveUp(query, failureText);
	}
	query.end();
}

/** Claude Code ending the turn in error. */
export function giveUp(query: FakeQuery, text: string): void {
	query.emit(
		assistantMessage([{ type: "text", text }], { error: "unknown" }),
		resultMessage({ isError: true, result: text }),
	);
}

/** Output that commits the client's head, then no end. */
export function startStreaming(query: FakeQuery, model: string): void {
	query.emit(
		streamEvent({
			type: "message_start",
			message: {
				id: `msg_scripted_${++seq}`,
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 5, output_tokens: 1 },
			},
		}),
		streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "partial answer" },
		}),
	);
}
