// Loopback stand-in for the Anthropic Messages API. Records every request it
// receives and answers /v1/messages with a scripted SSE stream:
//
//   last user turn carries tool_result      -> text "done: <first result text>"
//   ... or a flattened "[tool result id=…]" -> the same, from its first line
//   last user text contains "PARALLEL"      -> two tool_use blocks
//   last user text contains "SAYTOOL"       -> "echo: <last user text>", then that tool_use
//   last user text contains "TOOL"          -> one tool_use for the *read tool
//   anything else                           -> text "echo: <last user text>"
//   last user text contains "SLOW"          -> any of the above, 3 s late
//   last user text contains "MAXTOK"        -> the text ends with stop_reason max_tokens
//   a tools[].name outside ^[a-zA-Z0-9_-]{1,64}$ -> the API's 400
//
// Usage reports prompt caching the way the API does it: a cache_control
// breakpoint writes the prefix up to it (tools, then system, then messages),
// and a later request reads the longest written prefix that ends at one of
// its own breakpoints or up to 20 blocks before one. Tokens are bytes / 4;
// input_tokens stays 100.

import { createHash } from "node:crypto";

type Block = { type: string; [k: string]: unknown };
type Msg = { role: string; content: string | Block[] };

export interface MockRequest {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
	at: number;
	status?: number;
	/** The prompt-cache usage a scripted answer reported. */
	cache?: { read: number; creation: number };
	/** Set when the caller dropped the connection while a SLOW answer was pending. */
	abortedAfterMs?: number;
}

export interface MockUpstream {
	url: string;
	requests: MockRequest[];
	/**
	 * The next `times` /v1/messages calls answer with this status and body;
	 * with `match`, only calls whose authorization header contains it.
	 */
	failNext(
		status: number,
		body: unknown,
		headers?: Record<string, string>,
		times?: number,
		match?: string,
	): void;
	clearFailures(): void;
	/** Forward a request as if it had arrived over HTTP. */
	handle(req: Request): Promise<Response>;
	stop(): void;
}

let toolSeq = 0;

function lastUser(messages: Msg[]): Msg | undefined {
	return [...messages].reverse().find((m) => m.role === "user");
}

function blocksOf(m: Msg | undefined): Block[] {
	if (!m) return [];
	return typeof m.content === "string"
		? [{ type: "text", text: m.content }]
		: m.content;
}

function textOf(blocks: Block[]): string {
	return blocks
		.filter((b) => b.type === "text")
		.map((b) => String(b.text))
		.join("\n");
}

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface ScriptBody {
	model: string;
	messages: Msg[];
	system?: string | Block[];
	tools?: Array<{ name: string }>;
	stream?: boolean;
}

const LOOKBACK_BLOCKS = 20;

/** The prompt's cacheable blocks in the API's order, and which carry a breakpoint. */
function promptBlocks(body: ScriptBody): { keys: string[]; marks: number[] } {
	const units: Array<{ where: string; block: unknown }> = [];
	for (const tool of body.tools ?? [])
		units.push({ where: "tool", block: tool });
	const system =
		typeof body.system === "string"
			? [{ type: "text", text: body.system }]
			: (body.system ?? []);
	for (const block of system) units.push({ where: "system", block });
	body.messages.forEach((m, i) => {
		for (const block of blocksOf(m))
			units.push({ where: `${i}:${m.role}`, block });
	});
	const keys: string[] = [];
	const marks: number[] = [];
	units.forEach(({ where, block }, i) => {
		const { cache_control, ...rest } = block as Record<string, unknown>;
		if (cache_control) marks.push(i);
		keys.push(JSON.stringify([where, rest]));
	});
	return { keys, marks };
}

function createPromptCache() {
	/** Written prefixes: their digest and size in tokens. */
	const written = new Map<string, number>();
	const prefix = (model: string, keys: string[], end: number) => {
		const text = [model, ...keys.slice(0, end + 1)].join("\n");
		return {
			digest: createHash("sha256").update(text).digest("hex"),
			tokens: Math.ceil(Buffer.byteLength(text) / 4),
		};
	};
	return (body: ScriptBody): { read: number; creation: number } => {
		const { keys, marks } = promptBlocks(body);
		let read = 0;
		for (const mark of marks)
			for (let end = mark; end >= 0 && end >= mark - LOOKBACK_BLOCKS; end--) {
				const hit = written.get(prefix(body.model, keys, end).digest);
				if (hit !== undefined) {
					read = Math.max(read, hit);
					break;
				}
			}
		let longest = 0;
		for (const mark of marks) {
			const { digest, tokens } = prefix(body.model, keys, mark);
			written.set(digest, tokens);
			longest = Math.max(longest, tokens);
		}
		return { read, creation: Math.max(0, longest - read) };
	};
}

function script(
	body: ScriptBody,
	cache: { read: number; creation: number },
): string {
	const user = blocksOf(lastUser(body.messages));
	const toolResults = user.filter((b) => b.type === "tool_result");
	const text = textOf(user);
	// A Chat client's tools arrive under opaque encoded names; any tool will do.
	const readTool = (
		body.tools?.find((t) => t.name.endsWith("read")) ?? body.tools?.[0]
	)?.name;

	const content: Block[] = [];
	const flattenedResult = /\[tool result id=[^\]]*\]\n([^\n]*)/.exec(text);
	if (toolResults.length > 0) {
		const first = toolResults[0] as Block;
		const inner = Array.isArray(first.content)
			? textOf(first.content as Block[])
			: String(first.content);
		content.push({ type: "text", text: `done: ${inner}` });
	} else if (flattenedResult) {
		content.push({ type: "text", text: `done: ${flattenedResult[1]}` });
	} else if (readTool && /PARALLEL/.test(text)) {
		for (const path of ["a.txt", "b.txt"]) {
			content.push({
				type: "tool_use",
				id: `toolu_mock_${++toolSeq}`,
				name: readTool,
				input: { path },
			});
		}
	} else if (readTool && /SAYTOOL/.test(text)) {
		content.push({ type: "text", text: `echo: ${text.slice(-200)}` });
		content.push({
			type: "tool_use",
			id: `toolu_mock_${++toolSeq}`,
			name: readTool,
			input: { path: "a.txt" },
		});
	} else if (readTool && /TOOL/.test(text)) {
		content.push({
			type: "tool_use",
			id: `toolu_mock_${++toolSeq}`,
			name: readTool,
			input: { path: "a.txt" },
		});
	} else {
		content.push({ type: "text", text: `echo: ${text.slice(-200)}` });
	}

	const stopReason = content.some((b) => b.type === "tool_use")
		? "tool_use"
		: /MAXTOK/.test(text)
			? "max_tokens"
			: "end_turn";
	const usage = {
		input_tokens: 100,
		output_tokens: 20,
		cache_read_input_tokens: cache.read,
		cache_creation_input_tokens: cache.creation,
	};
	let out = sse("message_start", {
		type: "message_start",
		message: {
			id: `msg_mock_${Date.now()}_${toolSeq}`,
			type: "message",
			role: "assistant",
			model: body.model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage,
		},
	});
	content.forEach((block, index) => {
		if (block.type === "text") {
			out += sse("content_block_start", {
				type: "content_block_start",
				index,
				content_block: { type: "text", text: "" },
			});
			out += sse("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "text_delta", text: block.text },
			});
		} else {
			out += sse("content_block_start", {
				type: "content_block_start",
				index,
				content_block: {
					type: "tool_use",
					id: block.id,
					name: block.name,
					input: {},
				},
			});
			out += sse("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify(block.input),
				},
			});
		}
		out += sse("content_block_stop", { type: "content_block_stop", index });
	});
	out += sse("message_delta", {
		type: "message_delta",
		delta: { stop_reason: stopReason, stop_sequence: null },
		usage: { output_tokens: 20 },
	});
	out += sse("message_stop", { type: "message_stop" });
	return out;
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** The Messages API's 400 for a tool name outside its pattern, as it words it. */
function invalidToolName(body: unknown): unknown {
	const tools = (body as { tools?: unknown } | null)?.tools;
	if (!Array.isArray(tools)) return null;
	const index = tools.findIndex(
		(t) => !TOOL_NAME.test(String((t as { name?: unknown })?.name ?? "")),
	);
	if (index < 0) return null;
	return {
		type: "error",
		error: {
			type: "invalid_request_error",
			message: `tools.${index}.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'`,
		},
	};
}

export function startMockUpstream(): MockUpstream {
	const requests: MockRequest[] = [];
	type Failure = {
		status: number;
		body: unknown;
		headers: Record<string, string>;
		times: number;
		match: string | null;
	};
	let failures: Failure[] = [];
	const promptCache = createPromptCache();

	async function handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const raw = await req.text();
		let body: unknown = raw;
		try {
			body = raw ? JSON.parse(raw) : null;
		} catch {}
		const record: MockRequest = {
			method: req.method,
			path: url.pathname + url.search,
			headers: Object.fromEntries(req.headers.entries()),
			body,
			at: Date.now(),
		};
		requests.push(record);

		if (req.method === "POST" && url.pathname === "/v1/messages") {
			const invalid = invalidToolName(body);
			if (invalid) {
				record.status = 400;
				return Response.json(invalid, { status: 400 });
			}
			const auth = req.headers.get("authorization") ?? "";
			const f = failures.find(
				(x) => x.times > 0 && (x.match === null || auth.includes(x.match)),
			);
			if (f) {
				f.times--;
				failures = failures.filter((x) => x.times > 0);
				record.status = f.status;
				return Response.json(f.body, { status: f.status, headers: f.headers });
			}
			const b = body as ScriptBody;
			if (/SLOW/.test(textOf(blocksOf(lastUser(b.messages))))) {
				const t0 = Date.now();
				const aborted = await Promise.race([
					Bun.sleep(3000).then(() => false),
					new Promise<boolean>((resolve) =>
						req.signal.addEventListener("abort", () => resolve(true)),
					),
				]);
				if (aborted) {
					record.abortedAfterMs = Date.now() - t0;
					return new Response(null, { status: 499 });
				}
			}
			record.status = 200;
			if (!b.stream) {
				return Response.json(
					{
						type: "error",
						error: {
							type: "invalid_request_error",
							message: "mock only streams",
						},
					},
					{ status: 400 },
				);
			}
			record.cache = promptCache(b);
			return new Response(script(b, record.cache), {
				headers: { "content-type": "text/event-stream" },
			});
		}
		record.status = 404;
		return Response.json(
			{
				type: "error",
				error: { type: "not_found_error", message: `mock: ${url.pathname}` },
			},
			{ status: 404 },
		);
	}

	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });

	return {
		url: `http://127.0.0.1:${server.port}`,
		requests,
		failNext(status, body, headers = {}, times = 1, match) {
			if (times > 0)
				failures.push({ status, body, headers, times, match: match ?? null });
		},
		clearFailures() {
			failures = [];
		},
		handle,
		stop() {
			server.stop(true);
		},
	};
}
