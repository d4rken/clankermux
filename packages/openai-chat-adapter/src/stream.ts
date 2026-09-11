import type { ChatIngressContext } from "@clankermux/types";
import { upstreamFailure } from "./errors";

export interface ChatToolDelta {
	index: number;
	id?: string;
	type?: "function";
	function: { name?: string; arguments?: string };
}
export interface ChatDelta {
	role?: "assistant";
	content?: string;
	reasoning_content?: string;
	tool_calls?: ChatToolDelta[];
}
export interface ChatUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: { cached_tokens: number };
}
export interface ChatChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: { index: 0; delta: ChatDelta; finish_reason: string | null }[];
	usage?: ChatUsage | null;
}
const MAX_FRAME = 1024 * 1024;
type Json = Record<string, unknown>;
const record = (v: unknown): Json =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const count = (v: unknown): v is number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export async function* chatChunks(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	ctx: ChatIngressContext,
	names: Map<string, string>,
): AsyncGenerator<ChatChunk | null> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const id = `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
	const created = Math.floor(Date.now() / 1000);
	let buffer = "",
		model = "",
		started = false,
		stop: string | undefined,
		terminal = false;
	let input: number | undefined,
		output: number | undefined,
		cached: number | undefined,
		creation = 0;
	const blocks = new Map<
		number,
		{
			kind: string;
			tool?: number;
			args: string;
			closed: boolean;
			initial: unknown;
		}
	>();
	let tools = 0;
	const usage = (v: unknown) => {
		const u = record(v);
		if (count(u.input_tokens)) input = u.input_tokens;
		if (count(u.output_tokens)) output = u.output_tokens;
		if (count(u.cache_read_input_tokens)) cached = u.cache_read_input_tokens;
		if (count(u.cache_creation_input_tokens))
			creation = u.cache_creation_input_tokens;
	};
	const chunk = (
		delta: ChatDelta,
		finish_reason: string | null = null,
	): ChatChunk => ({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta, finish_reason }],
	});
	const process = (eventText: string): (ChatChunk | null)[] => {
		if (terminal) return [];
		const lines = eventText.split(/\r?\n/);
		const data = lines
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).replace(/^ /, ""))
			.join("\n");
		if (!data) return lines.some((l) => l.startsWith(":")) ? [null] : [];
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			throw upstreamFailure("Malformed upstream SSE event");
		}
		const e = record(parsed),
			type =
				e.type ??
				lines
					.find((l) => l.startsWith("event:"))
					?.slice(6)
					.trim();
		if (type === "error" || e.error)
			throw upstreamFailure(
				typeof record(e.error).message === "string"
					? String(record(e.error).message).slice(0, 512)
					: "Upstream stream failed",
			);
		if (type === "ping") return [null];
		if (type === "message_start") {
			if (started) throw upstreamFailure("Duplicate upstream message_start");
			const message = record(e.message);
			model =
				typeof message.model === "string" &&
				message.model.trim() &&
				message.model !== "unknown"
					? message.model
					: (ctx.outgoingModel ?? "");
			if (!model) throw upstreamFailure("Missing verified response model");
			model = ctx.reportedModel ?? model;
			started = true;
			usage(message.usage);
			return [chunk({ role: "assistant" })];
		}
		if (!started)
			throw upstreamFailure("Upstream content preceded message_start");
		if (type === "content_block_start") {
			const i = e.index,
				b = record(e.content_block);
			if (!count(i) || blocks.has(i) || blocks.size >= 1024)
				throw upstreamFailure("Invalid upstream content block index");
			const kind = String(b.type),
				block = {
					kind,
					tool: undefined as number | undefined,
					args: "",
					closed: false,
					initial: b.input,
				};
			blocks.set(i, block);
			if (kind === "text")
				return typeof b.text === "string" && b.text
					? [chunk({ content: b.text })]
					: [];
			if (kind === "thinking")
				return typeof b.thinking === "string" && b.thinking
					? [chunk({ reasoning_content: b.thinking })]
					: [];
			if (kind === "redacted_thinking") return [];
			if (
				kind !== "tool_use" ||
				typeof b.id !== "string" ||
				!b.id ||
				typeof b.name !== "string" ||
				!names.has(b.name)
			)
				throw upstreamFailure("Unsupported upstream content or function");
			block.tool = tools++;
			// Most Messages streams start with input:{} and supply incremental JSON later.
			return [
				chunk({
					tool_calls: [
						{
							index: block.tool,
							id: b.id,
							type: "function",
							function: { name: names.get(b.name), arguments: "" },
						},
					],
				}),
			];
		}
		if (type === "content_block_delta") {
			const b = count(e.index) ? blocks.get(e.index) : undefined,
				d = record(e.delta);
			if (!b || b.closed)
				throw upstreamFailure("Delta for missing or closed content block");
			if (
				d.type === "text_delta" &&
				b.kind === "text" &&
				typeof d.text === "string"
			)
				return [chunk({ content: d.text })];
			if (
				d.type === "thinking_delta" &&
				b.kind === "thinking" &&
				typeof d.thinking === "string"
			)
				return [chunk({ reasoning_content: d.thinking })];
			if (d.type === "signature_delta" && b.kind === "thinking") return [];
			if (
				d.type === "input_json_delta" &&
				b.tool !== undefined &&
				typeof d.partial_json === "string"
			) {
				b.args += d.partial_json;
				if (b.args.length > MAX_FRAME)
					throw upstreamFailure("Tool arguments exceeded the size limit");
				return [
					chunk({
						tool_calls: [
							{ index: b.tool, function: { arguments: d.partial_json } },
						],
					}),
				];
			}
			throw upstreamFailure("Unsupported upstream content delta");
		}
		if (type === "content_block_stop") {
			const b = count(e.index) ? blocks.get(e.index) : undefined;
			if (!b || b.closed) throw upstreamFailure("Invalid content block stop");
			b.closed = true;
			if (b.tool !== undefined && !b.args) {
				if (
					!b.initial ||
					typeof b.initial !== "object" ||
					Array.isArray(b.initial)
				)
					throw upstreamFailure("Missing tool arguments");
				b.args = JSON.stringify(b.initial);
				return [
					chunk({
						tool_calls: [{ index: b.tool, function: { arguments: b.args } }],
					}),
				];
			}
			return [];
		}
		if (type === "message_delta") {
			usage(e.usage);
			const reason = record(e.delta).stop_reason;
			if (reason !== null && reason !== undefined) {
				const reasons: Record<string, string> = {
					end_turn: "stop",
					stop_sequence: "stop",
					max_tokens: "length",
					model_context_window_exceeded: "length",
					tool_use: "tool_calls",
					refusal: "content_filter",
				};
				if (typeof reason !== "string" || !reasons[reason])
					throw upstreamFailure("Unsupported upstream finish reason");
				stop = reasons[reason];
			}
			return [];
		}
		if (type === "message_stop") {
			if (!stop)
				throw upstreamFailure("Upstream ended without a finish reason");
			if ([...blocks.values()].some((b) => !b.closed))
				throw upstreamFailure("Upstream ended with an open content block");
			if (stop === "tool_calls" && !tools)
				throw upstreamFailure("Tool finish without tool calls");
			if (stop !== "length" && stop !== "content_filter")
				for (const b of blocks.values())
					if (b.tool !== undefined) {
						try {
							const args = JSON.parse(b.args);
							if (!args || typeof args !== "object" || Array.isArray(args))
								throw new Error();
						} catch {
							throw upstreamFailure("Malformed upstream tool arguments");
						}
					}
			terminal = true;
			const result = chunk({}, stop);
			if (
				ctx.usageObserved !== false &&
				input !== undefined &&
				output !== undefined
			) {
				const prompt = input + (cached ?? 0) + creation; // Both supported provider legs use additive Messages usage.
				result.usage = {
					prompt_tokens: prompt,
					completion_tokens: output,
					total_tokens: prompt + output,
					...(cached !== undefined
						? { prompt_tokens_details: { cached_tokens: cached } }
						: {}),
				};
			}
			return [result];
		}
		throw upstreamFailure("Unsupported upstream SSE event");
	};
	try {
		while (!terminal) {
			const next = await reader.read();
			if (next.done) {
				buffer += decoder.decode();
				throw upstreamFailure("Upstream ended without a terminal message_stop");
			}
			buffer += decoder.decode(next.value, { stream: true });
			let boundary = /\r?\n\r?\n/.exec(buffer);
			while (boundary && !terminal) {
				if (boundary.index > MAX_FRAME)
					throw upstreamFailure("Upstream SSE frame exceeded the size limit");
				const frame = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				for (const result of process(frame)) yield result;
				boundary = /\r?\n\r?\n/.exec(buffer);
			}
			if (!terminal && buffer.length > MAX_FRAME)
				throw upstreamFailure("Upstream SSE frame exceeded the size limit");
		}
	} finally {
		void reader.cancel().catch(() => {});
	}
}
