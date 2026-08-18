import { describe, expect, it } from "bun:test";
import { CodexProvider } from "../provider";

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];

// An upstream body the test drives by hand: it never closes on its own, so a
// translator that keeps reading past the point of no return simply hangs.
const controlledUpstream = () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		cancel() {
			cancelled = true;
		},
	});
	const encoder = new TextEncoder();
	return {
		stream,
		push: (text: string) => controller.enqueue(encoder.encode(text)),
		get cancelled() {
			return cancelled;
		},
	};
};

const streamingResponse = (body: ReadableStream<Uint8Array>) =>
	new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});

const waitFor = async (predicate: () => boolean) => {
	for (let i = 0; i < 400; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition was never met");
};

describe("CodexProvider streaming upstream disposal", () => {
	it("cancels the upstream body once the terminal events have been sent", async () => {
		const provider = new CodexProvider();
		const upstream = controlledUpstream();
		const transformed = await provider.processResponse(
			streamingResponse(upstream.stream),
			null,
		);

		upstream.push(
			sseBody([
				...eventLine("response.created", {
					response: { id: "resp_test", model: "gpt-5.4" },
				}),
				...eventLine("response.completed", {
					response: {
						model: "gpt-5.4",
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				}),
			]),
		);

		// Resolves only because the translator stops reading an upstream that
		// never closes.
		const body = await transformed.text();
		expect(body).toContain("event: message_stop");
		expect(upstream.cancelled).toBeTrue();
	});

	it("cancels the upstream body when upstream reports a stream error", async () => {
		const provider = new CodexProvider();
		const upstream = controlledUpstream();
		const transformed = await provider.processResponse(
			streamingResponse(upstream.stream),
			null,
		);

		upstream.push(
			sseBody([
				...eventLine("response.created", {
					response: { id: "resp_test", model: "gpt-5.4" },
				}),
				...eventLine("response.failed", {
					response: {
						error: { type: "server_error", message: "upstream exploded" },
					},
				}),
			]),
		);

		const body = await transformed.text();
		expect(body).toContain("event: error");
		expect(upstream.cancelled).toBeTrue();
	});

	it("cancels the upstream body when the client hangs up mid-stream", async () => {
		const provider = new CodexProvider();
		const upstream = controlledUpstream();
		const transformed = await provider.processResponse(
			streamingResponse(upstream.stream),
			null,
		);

		const reader = (transformed.body as ReadableStream<Uint8Array>).getReader();
		upstream.push(
			sseBody([
				...eventLine("response.created", {
					response: { id: "resp_test", model: "gpt-5.4" },
				}),
				...eventLine("response.output_text.delta", {
					delta: "hello",
					output_index: 0,
				}),
			]),
		);
		await reader.read();
		await reader.cancel();

		// The failing downstream write is the only signal that the client is gone;
		// the upstream body must not keep streaming after it.
		upstream.push(
			sseBody([
				...eventLine("response.output_text.delta", {
					delta: " world",
					output_index: 0,
				}),
			]),
		);

		await waitFor(() => upstream.cancelled);
		expect(upstream.cancelled).toBeTrue();
	});

	it("cancels the upstream body when the client hangs up while upstream is silent", async () => {
		const provider = new CodexProvider();
		const upstream = controlledUpstream();
		const transformed = await provider.processResponse(
			streamingResponse(upstream.stream),
			null,
		);

		const reader = (transformed.body as ReadableStream<Uint8Array>).getReader();
		upstream.push(
			sseBody([
				...eventLine("response.created", {
					response: { id: "resp_test", model: "gpt-5.4" },
				}),
			]),
		);
		await reader.read();
		// No further upstream bytes: the translator is parked in reader.read(),
		// so nothing is awaiting a downstream write when the client leaves.
		await reader.cancel();

		await waitFor(() => upstream.cancelled);
		expect(upstream.cancelled).toBeTrue();
	});

	it("closes the client stream when the upstream body is already locked", async () => {
		const provider = new CodexProvider();
		const upstream = controlledUpstream();
		const response = streamingResponse(upstream.stream);
		// Something else holds the body: getReader() throws TypeError. That must
		// still terminate the client stream rather than hang it.
		(response.body as ReadableStream<Uint8Array>).getReader();

		const transformed = await provider.processResponse(response, null);
		expect(await transformed.text()).toBe("");
	});
});
