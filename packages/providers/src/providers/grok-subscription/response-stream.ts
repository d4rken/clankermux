/**
 * The proxy omits `index` on `content_block_delta` events, which the Anthropic
 * stream format carries on every delta. Consumers that key deltas by block, such
 * as the Responses translation pi and Codex go through, drop every delta that
 * lacks one, so both harnesses saw empty text and empty tool arguments. A delta
 * always belongs to the block the latest `content_block_start` opened, so that
 * index is filled in. Every other line passes through byte for byte.
 */
export function indexContentBlockDeltas(
	body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffered = "";
	let openBlock: number | null = null;

	const rewrite = (line: string): string => {
		if (!line.startsWith("data:")) return line;
		const isStart = line.includes('"content_block_start"');
		const isDelta = line.includes('"content_block_delta"');
		if (!isStart && !isDelta) return line;
		const carriageReturn = line.endsWith("\r") ? "\r" : "";
		const json = line.slice(5, line.length - carriageReturn.length).trimStart();
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(json);
		} catch {
			return line;
		}
		if (event.type === "content_block_start") {
			if (typeof event.index === "number") openBlock = event.index;
			return line;
		}
		if (
			event.type !== "content_block_delta" ||
			"index" in event ||
			openBlock === null
		)
			return line;
		const { type, ...rest } = event;
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
