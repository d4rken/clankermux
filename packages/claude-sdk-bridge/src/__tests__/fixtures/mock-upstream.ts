// Loopback stand-in for the Anthropic Messages API. Records every request it
// receives and answers /v1/messages with a scripted SSE stream:
//
//   last user turn carries tool_result      -> text "done: <first result text>"
//   last user text contains "PARALLEL"      -> two tool_use blocks
//   last user text contains "TOOL"          -> one tool_use for the *read tool
//   anything else                           -> text "echo: <last user text>"
//   last user text contains "SLOW"          -> any of the above, 3 s late

type Block = { type: string; [k: string]: unknown };
type Msg = { role: string; content: string | Block[] };

export interface MockRequest {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
	at: number;
	status?: number;
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
	tools?: Array<{ name: string }>;
	stream?: boolean;
}

function script(body: ScriptBody): string {
	const user = blocksOf(lastUser(body.messages));
	const toolResults = user.filter((b) => b.type === "tool_result");
	const text = textOf(user);
	// A Chat client's tools arrive under opaque encoded names; any tool will do.
	const readTool = (
		body.tools?.find((t) => t.name.endsWith("read")) ?? body.tools?.[0]
	)?.name;

	const content: Block[] = [];
	if (toolResults.length > 0) {
		const first = toolResults[0] as Block;
		const inner = Array.isArray(first.content)
			? textOf(first.content as Block[])
			: String(first.content);
		content.push({ type: "text", text: `done: ${inner}` });
	} else if (readTool && /PARALLEL/.test(text)) {
		for (const path of ["a.txt", "b.txt"]) {
			content.push({
				type: "tool_use",
				id: `toolu_mock_${++toolSeq}`,
				name: readTool,
				input: { path },
			});
		}
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
		: "end_turn";
	const usage = {
		input_tokens: 100,
		output_tokens: 20,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
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
			return new Response(script(b), {
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
