import { describe, expect, it } from "bun:test";
import {
	peekServedModel,
	SERVED_MODEL_JSON_MAX_BYTES,
} from "../served-model-peek";

function sse(body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", ...headers },
	});
}

/** A body delivered in caller-chosen pieces, to exercise frame reassembly. */
function chunked(
	pieces: string[],
	headers: Record<string, string> = {},
): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const piece of pieces) controller.enqueue(encoder.encode(piece));
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers });
}

const ANTHROPIC_START =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5"}}\n\n';
const CODEX_CREATED =
	'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.6-luna"}}\n\n';

describe("peekServedModel", () => {
	it("reads Anthropic's model from message_start", async () => {
		const peek = await peekServedModel(sse(ANTHROPIC_START));
		expect(peek.servedModel).toBe("claude-opus-5");
	});

	it("reads Codex's model from response.created", async () => {
		const peek = await peekServedModel(sse(CODEX_CREATED));
		expect(peek.servedModel).toBe("gpt-5.6-luna");
	});

	it("reads a top-level model, the chat-completions shape", async () => {
		const peek = await peekServedModel(sse('data: {"model":"glm-5.3"}\n\n'));
		expect(peek.servedModel).toBe("glm-5.3");
	});

	it("steps over a leading comment keepalive", async () => {
		const peek = await peekServedModel(sse(`: keepalive\n\n${CODEX_CREATED}`));
		expect(peek.servedModel).toBe("gpt-5.6-luna");
	});

	// The default budget is 2 substantive frames, so counting keepalives would
	// spend it before the opening frame ever arrived.
	it("does not spend the frame budget on repeated keepalives", async () => {
		const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
		const peek = await peekServedModel(
			sse(`${ping}${ping}${ping}${ANTHROPIC_START}`),
		);
		expect(peek.servedModel).toBe("claude-opus-5");
	});

	it("steps over a ping frame", async () => {
		const peek = await peekServedModel(
			sse(`event: ping\ndata: {"type":"ping"}\n\n${ANTHROPIC_START}`),
		);
		expect(peek.servedModel).toBe("claude-opus-5");
	});

	it("reassembles a frame split across chunks", async () => {
		const half = Math.floor(CODEX_CREATED.length / 2);
		const peek = await peekServedModel(
			chunked([CODEX_CREATED.slice(0, half), CODEX_CREATED.slice(half)], {
				"content-type": "text/event-stream",
			}),
		);
		expect(peek.servedModel).toBe("gpt-5.6-luna");
	});

	// The Codex backend routinely omits the content-type, which is why the
	// reader sniffs rather than trusting the header.
	it("recognises SSE with no content-type at all", async () => {
		const peek = await peekServedModel(chunked([CODEX_CREATED]));
		expect(peek.servedModel).toBe("gpt-5.6-luna");
	});

	it("recognises comment-prefixed SSE with no content-type, split mid-comment", async () => {
		const peek = await peekServedModel(
			chunked([": keep", `alive\n\n${CODEX_CREATED}`]),
		);
		expect(peek.servedModel).toBe("gpt-5.6-luna");
	});

	it("gives up on a framing it does not recognise", async () => {
		const peek = await peekServedModel(
			new Response("\x00\x01binary", {
				status: 200,
				headers: { "content-type": "application/connect+proto" },
			}),
		);
		expect(peek.servedModel).toBeNull();
	});

	it("reads a non-stream JSON body", async () => {
		const peek = await peekServedModel(
			new Response(JSON.stringify({ id: "msg_1", model: "claude-opus-5" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		expect(peek.servedModel).toBe("claude-opus-5");
	});

	it("refuses a declared-oversize JSON body rather than reading it", async () => {
		const peek = await peekServedModel(
			new Response(JSON.stringify({ model: "claude-opus-5" }), {
				status: 200,
				headers: {
					"content-type": "application/json",
					"content-length": String(SERVED_MODEL_JSON_MAX_BYTES + 1),
				},
			}),
		);
		expect(peek.servedModel).toBeNull();
	});

	it("does not answer from a truncated JSON body", async () => {
		// Cut off before EOF: a head regex would happily match the echoed
		// `instructions` string, so nothing is committed without the whole body.
		const peek = await peekServedModel(
			new Response('{"instructions":"model: gpt-9-fake", "model":"cl', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
			{ maxBytes: 16 },
		);
		expect(peek.servedModel).toBeNull();
	});

	it("says nothing on a non-200", async () => {
		const peek = await peekServedModel(
			new Response(ANTHROPIC_START, {
				status: 500,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		expect(peek.servedModel).toBeNull();
	});

	it("says nothing when the budget is already spent", async () => {
		const peek = await peekServedModel(sse(ANTHROPIC_START), { timeoutMs: 0 });
		expect(peek.servedModel).toBeNull();
	});

	it("gives up rather than waiting past its deadline", async () => {
		const never = new ReadableStream<Uint8Array>({ start() {} });
		const peek = await peekServedModel(
			new Response(never, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
			{ timeoutMs: 20 },
		);
		expect(peek.servedModel).toBeNull();
	});

	it("propagates an abort", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			peekServedModel(sse(ANTHROPIC_START), { signal: controller.signal }),
		).rejects.toThrow();
	});

	it("stops looking once the frame budget is spent", async () => {
		const filler = 'data: {"type":"noise"}\n\n';
		const peek = await peekServedModel(
			sse(`${filler}${filler}${filler}${ANTHROPIC_START}`),
			{ maxFrames: 2 },
		);
		expect(peek.servedModel).toBeNull();
	});

	it("leaves the forwarded twin readable", async () => {
		const response = sse(ANTHROPIC_START);
		const peek = await peekServedModel(response);
		expect(peek.servedModel).toBe("claude-opus-5");
		expect(await response.text()).toBe(ANTHROPIC_START);
	});
});

describe("peekServedModel, Codex failure question", () => {
	const FAILURE =
		'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_error"}}}\n\n';

	it("reports a transient in-band failure", async () => {
		const peek = await peekServedModel(sse(`${CODEX_CREATED}${FAILURE}`), {
			codexFailure: true,
		});
		expect(peek.codexFailureCode).toBe("server_error");
	});

	// The regression this whole merge exists to avoid: response.created carries
	// the model, the failure arrives later, and an early stop would miss it.
	it("keeps reading for the failure after the model is already known", async () => {
		const peek = await peekServedModel(sse(`${CODEX_CREATED}${FAILURE}`), {
			codexFailure: true,
		});
		expect(peek.servedModel).toBe("gpt-5.6-luna");
		expect(peek.codexFailureCode).toBe("server_error");
	});

	it("reports no failure code when it was not asked for one", async () => {
		const peek = await peekServedModel(sse(`${CODEX_CREATED}${FAILURE}`));
		expect(peek.codexFailureCode).toBeNull();
	});

	it("commits on generated content rather than discarding it", async () => {
		const delta =
			'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n';
		const peek = await peekServedModel(
			sse(`${CODEX_CREATED}${delta}${FAILURE}`),
			{ codexFailure: true },
		);
		expect(peek.codexFailureCode).toBeNull();
		expect(peek.servedModel).toBe("gpt-5.6-luna");
	});
});
