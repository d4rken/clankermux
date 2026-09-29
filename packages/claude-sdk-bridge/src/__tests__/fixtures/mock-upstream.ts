// Loopback stand-in for the Anthropic Messages API. Records every request it
// receives and answers /v1/messages with a scripted SSE stream:
//
//   last user turn carries tool_result      -> text "done: <first result text>"
//   ... whose first result text starts "AGAIN" -> one tool_use for the *read tool
//   ... or a flattened "[tool result id=…]" -> the same, from its first line
//   last user text contains "PARALLEL"      -> two tool_use blocks
//   last user text contains "FANOUT<n>"     -> n tool_use blocks
//   last user text contains "STRAY"         -> tool_use for the *read tool, then one for a tool not offered
//   last user text contains "UNMAPPED"      -> tool_use for an unoffered mcp__c__ tool, then the *read tool
//   last user text contains "SAYTOOL"       -> "echo: <last user text>", then that tool_use
//   last user text contains "TOOL"          -> one tool_use for the *read tool
//   anything else                           -> text "echo: <last user text>"
//   tools offer WebSearch and the last user text contains "SEARCH"
//                                           -> one WebSearch tool_use whose query is the
//                                              text after "SEARCH "; "SEARCHWIDE" adds
//                                              allowed_domains ["evil.test"] to its input
//   a tools[] entry of type web_search_*    -> Claude Code's search sub-request, answered
//                                              as the API's server tool: server_tool_use,
//                                              a web_search_tool_result with two results
//                                              (on the first allowed domain, else
//                                              results.example), then a text; a query with
//                                              "SEARCHFAIL" gets a web_search_tool_result_error
//   last user text contains "SLOW"          -> any of the above, 3 s late
//   last user text contains "MAXTOK"        -> the text ends with stop_reason max_tokens
//   last user text contains "THINK"         -> a signed thinking block before the rest
//
// A thinking block's signature binds it to the messages before it, as the
// API's preserved-thinking check does: a later call whose history before
// that block differs (cache breakpoints and string-or-block content aside)
// is refused with a 400 "bound to a different conversation".
//   a user text contains "LOOP<n>"          -> one tool_use per call until the
//                                              conversation holds n tool_results
//   last user text asks for a "detailed summary" (Claude Code's compaction
//   prompt)                                 -> text "<summary>MOCK-SUMMARY</summary>"
//   a tools[].name outside ^[a-zA-Z0-9_-]{1,64}$ -> the API's 400
//
// A rule (`addRule`) keyed on a marker string in the body can fail a call or
// reshape its reply (usage, stop reason, reported model), for the calls of
// one conversation only.
//
// /v1/messages/count_tokens answers bytes / 4.
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
	/** Signed thinking blocks in the history that matched their conversation. */
	thinkingVerified?: number;
}

/** What a rule changes about a scripted 200 reply. */
export interface ReplyShape {
	usage?: Partial<{
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens: number;
		cache_creation_input_tokens: number;
	}>;
	stopReason?: string;
	stopDetails?: unknown;
	/** The model message_start reports instead of the requested one. */
	model?: string;
}

export interface MockRule {
	/** Applies only to calls whose raw body contains this string. */
	marker: string;
	/**
	 * Which of the marker's calls it applies to; `index` counts the earlier
	 * calls carrying the marker. Absent: every one.
	 */
	when?: (call: { index: number; body: unknown }) => boolean;
	/** How many calls it applies to at most; absent: unlimited. */
	times?: number;
	fail?: { status: number; body: unknown; headers?: Record<string, string> };
	shape?: ReplyShape;
}

export interface MockUpstream {
	url: string;
	requests: MockRequest[];
	/** Every thinking signature issued, in order. */
	signatures: string[];
	addRule(rule: MockRule): void;
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
const issuedSignatures: string[] = [];

/** The messages as the signature check compares them. */
function conversationDigest(messages: Msg[]): string {
	const normalized = messages.map((m) => ({
		role: m.role,
		content: blocksOf(m).map((block) => {
			const { cache_control, ...rest } = block;
			return rest;
		}),
	}));
	return createHash("sha256")
		.update(JSON.stringify(normalized))
		.digest("hex")
		.slice(0, 16);
}

const SIGNATURE = /^sig_mock_\d+_([0-9a-f]{16})$/;

/** The API's 400 for signed thinking whose history changed, at `at` ("messages.2.content.0"). */
export function thinkingBindingRefusal(at: string) {
	return {
		type: "error",
		error: {
			type: "invalid_request_error",
			message: `${at}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block".`,
		},
	};
}

/** How many signed thinking blocks match; a refusal names the first that does not. */
function checkThinking(messages: Msg[]): {
	verified: number;
	/** Where the first refused block is. */
	refusal?: string;
} {
	let verified = 0;
	for (const [i, m] of messages.entries()) {
		if (m.role !== "assistant") continue;
		for (const [j, block] of blocksOf(m).entries()) {
			if (block.type !== "thinking") continue;
			const bound = SIGNATURE.exec(String(block.signature))?.[1];
			if (!bound) continue;
			if (bound !== conversationDigest(messages.slice(0, i)))
				return { verified, refusal: `messages.${i}.content.${j}` };
			verified++;
		}
	}
	return { verified };
}

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
	tools?: Array<{ name: string; type?: string; allowed_domains?: string[] }>;
	stream?: boolean;
}

/** The API's answer to a request offering its web_search server tool. */
function webSearchReply(
	body: ScriptBody,
	tool: { allowed_domains?: string[] },
): Block[] {
	const asked = textOf(blocksOf(lastUser(body.messages)));
	const query =
		/Perform a web search for the query: (.*)/.exec(asked)?.[1]?.trim() ??
		asked;
	const id = `srvtoolu_mock_${++toolSeq}`;
	const host = tool.allowed_domains?.[0] ?? "results.example";
	const slug = encodeURIComponent(query.toLowerCase().replace(/\s+/g, "-"));
	return [
		{ type: "server_tool_use", id, name: "web_search", input: { query } },
		{
			type: "web_search_tool_result",
			tool_use_id: id,
			content: /SEARCHFAIL/.test(query)
				? { type: "web_search_tool_result_error", error_code: "unavailable" }
				: [1, 2].map((n) => ({
						type: "web_search_result",
						url: `https://${host}/${slug}/${n}`,
						title: `Result ${n} for ${query}`,
						encrypted_content: `enc_${n}`,
						page_age: null,
					})),
		},
		{ type: "text", text: `Found results for ${query}.` },
	];
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

function userTexts(messages: Msg[]): string {
	return messages
		.filter((m) => m.role === "user")
		.map((m) => textOf(blocksOf(m)))
		.join("\n");
}

function script(
	body: ScriptBody,
	cache: { read: number; creation: number },
	shape: ReplyShape = {},
): string {
	const user = blocksOf(lastUser(body.messages));
	const toolResults = user.filter((b) => b.type === "tool_result");
	const text = textOf(user);
	// A Chat client's tools arrive under opaque encoded names; any tool will do.
	const readTool = (
		body.tools?.find((t) => t.name.endsWith("read")) ?? body.tools?.[0]
	)?.name;

	const content: Block[] = [];
	const searchTool = body.tools?.find((t) =>
		String(t.type ?? "").startsWith("web_search_"),
	);
	const offersWebSearch = body.tools?.some((t) => t.name === "WebSearch");
	const flattenedResult = /\[tool result id=[^\]]*\]\n([^\n]*)/.exec(text);
	const loop = /LOOP(\d+)/.exec(userTexts(body.messages));
	const resultsSoFar = body.messages
		.flatMap((m) => blocksOf(m))
		.filter((b) => b.type === "tool_result").length;
	if (searchTool) {
		content.push(...webSearchReply(body, searchTool));
	} else if (
		offersWebSearch &&
		toolResults.length === 0 &&
		/SEARCH/.test(text)
	) {
		const query = /SEARCH\w*\s+(.*)/.exec(text)?.[1]?.trim() || "nothing";
		content.push({
			type: "tool_use",
			id: `toolu_mock_${++toolSeq}`,
			name: "WebSearch",
			input: /SEARCHWIDE/.test(text)
				? { query, allowed_domains: ["evil.test"] }
				: { query },
		});
	} else if (/create a detailed summary/.test(JSON.stringify(user))) {
		content.push({ type: "text", text: "<summary>MOCK-SUMMARY</summary>" });
	} else if (readTool && loop && resultsSoFar < Number(loop[1])) {
		content.push({
			type: "tool_use",
			id: `toolu_mock_${++toolSeq}`,
			name: readTool,
			input: { path: `loop-${resultsSoFar}.txt` },
		});
	} else if (toolResults.length > 0) {
		const first = toolResults[0] as Block;
		const inner = Array.isArray(first.content)
			? textOf(first.content as Block[])
			: String(first.content);
		if (readTool && inner.startsWith("AGAIN"))
			content.push({
				type: "tool_use",
				id: `toolu_mock_${++toolSeq}`,
				name: readTool,
				input: { path: "again.txt" },
			});
		else content.push({ type: "text", text: `done: ${inner}` });
	} else if (flattenedResult) {
		content.push({ type: "text", text: `done: ${flattenedResult[1]}` });
	} else if (readTool && /FANOUT(\d+)/.test(text)) {
		const n = Number(/FANOUT(\d+)/.exec(text)?.[1]);
		for (let i = 0; i < n; i++)
			content.push({
				type: "tool_use",
				id: `toolu_mock_${++toolSeq}`,
				name: readTool,
				input: { path: `fan-${i}.txt` },
			});
	} else if (readTool && /STRAY|UNMAPPED/.test(text)) {
		const stray = /UNMAPPED/.test(text)
			? "mcp__c__unmapped_tool"
			: "no_such_tool";
		const calls = [
			{ name: readTool, input: { path: "a.txt" } },
			{ name: stray, input: {} },
		];
		if (/UNMAPPED/.test(text)) calls.reverse();
		for (const call of calls)
			content.push({
				type: "tool_use",
				id: `toolu_mock_${++toolSeq}`,
				...call,
			});
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

	if (toolResults.length === 0 && /THINK/.test(text)) {
		const signature = `sig_mock_${toolSeq}_${conversationDigest(body.messages)}`;
		issuedSignatures.push(signature);
		content.unshift({
			type: "thinking",
			thinking: "mock reasoning",
			signature,
		});
	}

	const stopReason =
		shape.stopReason ??
		(content.some((b) => b.type === "tool_use")
			? "tool_use"
			: /MAXTOK/.test(text)
				? "max_tokens"
				: "end_turn");
	const usage = {
		input_tokens: 100,
		output_tokens: 20,
		cache_read_input_tokens: cache.read,
		cache_creation_input_tokens: cache.creation,
		...(searchTool ? { server_tool_use: { web_search_requests: 1 } } : {}),
		...shape.usage,
	};
	let out = sse("message_start", {
		type: "message_start",
		message: {
			id: `msg_mock_${Date.now()}_${toolSeq}`,
			type: "message",
			role: "assistant",
			model: shape.model ?? body.model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage,
		},
	});
	content.forEach((block, index) => {
		if (block.type === "thinking") {
			out += sse("content_block_start", {
				type: "content_block_start",
				index,
				content_block: { type: "thinking", thinking: "", signature: "" },
			});
			out += sse("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "thinking_delta", thinking: block.thinking },
			});
			out += sse("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "signature_delta", signature: block.signature },
			});
		} else if (block.type === "text") {
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
		} else if (block.type === "web_search_tool_result") {
			out += sse("content_block_start", {
				type: "content_block_start",
				index,
				content_block: block,
			});
		} else {
			out += sse("content_block_start", {
				type: "content_block_start",
				index,
				content_block: {
					type: block.type,
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
		delta: {
			stop_reason: stopReason,
			stop_sequence: null,
			...(shape.stopDetails !== undefined
				? { stop_details: shape.stopDetails }
				: {}),
		},
		usage: {
			output_tokens: usage.output_tokens,
			...(searchTool ? { server_tool_use: usage.server_tool_use } : {}),
		},
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
	const rules: Array<MockRule & { used: number }> = [];
	const markerCalls = new Map<string, number>();
	const promptCache = createPromptCache();

	/** The rules that apply to this call, each counted once it applies. */
	function rulesFor(raw: string, body: unknown): MockRule[] {
		const markers = new Set(
			rules.filter((r) => raw.includes(r.marker)).map((r) => r.marker),
		);
		const index = new Map<string, number>();
		for (const marker of markers) {
			index.set(marker, markerCalls.get(marker) ?? 0);
			markerCalls.set(marker, (markerCalls.get(marker) ?? 0) + 1);
		}
		const applied: MockRule[] = [];
		for (const rule of rules) {
			if (!markers.has(rule.marker)) continue;
			if (rule.times !== undefined && rule.used >= rule.times) continue;
			if (rule.when && !rule.when({ index: index.get(rule.marker) ?? 0, body }))
				continue;
			rule.used++;
			applied.push(rule);
		}
		return applied;
	}

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
			const applied = rulesFor(raw, body);
			const ruleFailure = applied.find((r) => r.fail)?.fail;
			if (ruleFailure) {
				record.status = ruleFailure.status;
				return Response.json(ruleFailure.body, {
					status: ruleFailure.status,
					headers: ruleFailure.headers ?? {},
				});
			}
			const shape = Object.assign(
				{},
				...applied.flatMap((r) => (r.shape ? [r.shape] : [])),
			) as ReplyShape;
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
			const thinking = checkThinking(b.messages);
			record.thinkingVerified = thinking.verified;
			if (thinking.refusal) {
				record.status = 400;
				return Response.json(thinkingBindingRefusal(thinking.refusal), {
					status: 400,
				});
			}
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
			return new Response(script(b, record.cache, shape), {
				headers: { "content-type": "text/event-stream" },
			});
		}
		if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
			// Tokens are bytes / 4, as for prompt caching above.
			record.status = 200;
			return Response.json({
				input_tokens: Math.ceil(Buffer.byteLength(raw) / 4),
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
		signatures: issuedSignatures,
		addRule(rule) {
			rules.push({ ...rule, used: 0 });
		},
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
