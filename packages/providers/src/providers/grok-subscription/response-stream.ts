const BLOCK_EVENTS = new Set([
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

/**
 * The proxy's content-block numbering does not follow the Anthropic stream
 * format: every block starts and stops as index 0, and deltas carry no index
 * at all. Consumers that key blocks by index, such as the Responses translation
 * pi and Codex go through, then drop the deltas, and merge a tool call into the
 * text block before it, so the call never reaches the client.
 *
 * Blocks stream one after another, so each `content_block_start` is numbered
 * in order from 0, and each delta and stop gets the number of the block
 * currently open. A stream that already numbers its blocks this way passes
 * through unchanged, and every other line passes through byte for byte.
 */
export function numberContentBlocks(
	body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffered = "";
	let nextBlock = 0;
	let openBlock: number | null = null;

	const rewrite = (line: string): string => {
		if (!line.startsWith("data:") || !line.includes('"content_block_'))
			return line;
		const carriageReturn = line.endsWith("\r") ? "\r" : "";
		const json = line.slice(5, line.length - carriageReturn.length).trimStart();
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(json);
		} catch {
			return line;
		}
		if (typeof event.type !== "string" || !BLOCK_EVENTS.has(event.type))
			return line;
		if (event.type === "content_block_start") openBlock = nextBlock++;
		if (openBlock === null || event.index === openBlock) return line;
		const { type, index: _upstream, ...rest } = event;
		return `data: ${JSON.stringify({ type, index: openBlock, ...rest })}${carriageReturn}`;
	};

	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffered += decoder.decode(chunk, { stream: true });
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				if (lines.length)
					controller.enqueue(
						encoder.encode(`${lines.map(rewrite).join("\n")}\n`),
					);
			},
			flush(controller) {
				buffered += decoder.decode();
				if (buffered) controller.enqueue(encoder.encode(rewrite(buffered)));
			},
		}),
	);
}
