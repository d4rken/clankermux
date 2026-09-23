/** A scripted stand-in for the Agent SDK's `query()`, plus the other fakes the
 * bridge's unit tests inject: an in-memory turn repository and inner dispatch. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	McpSdkServerConfigWithInstance,
	Options,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	SdkBridgeInnerContext,
	SdkBridgeLegFinish,
	SdkBridgeLegInsert,
	SdkBridgeRoutePlan,
	SdkBridgeTurnCounterDelta,
	SdkBridgeTurnFinish,
	SdkBridgeTurnInsert,
	SdkBridgeTurnMeta,
} from "@clankermux/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type ClaudeSdkBridge, createClaudeSdkBridge } from "../../bridge";
import { MCP_SERVER_NAME } from "../../tool-server";
import type {
	BridgeLog,
	BridgeQuery,
	ClaudeSdkBridgeDeps,
	QueryFn,
	SdkBridgeTurnRepo,
} from "../../types";

type Block = { type: string; [key: string]: unknown };

export class FakeQuery implements BridgeQuery {
	readonly prompts: SDKUserMessage[] = [];
	interrupted = false;
	closed = false;
	private readonly queue: SDKMessage[] = [];
	private waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null;
	private ended = false;
	private failure: Error | null = null;
	private client: Promise<Client> | null = null;
	private promptWaiters: Array<() => void> = [];

	constructor(
		readonly options: Options,
		prompt: AsyncIterable<SDKUserMessage>,
	) {
		void (async () => {
			for await (const message of prompt) {
				this.prompts.push(message);
				for (const w of this.promptWaiters.splice(0)) w();
			}
			this.promptEnded = true;
			for (const w of this.promptWaiters.splice(0)) w();
		})();
	}

	promptEnded = false;

	async nextPrompt(): Promise<void> {
		if (this.prompts.length) return;
		await new Promise<void>((resolve) => this.promptWaiters.push(resolve));
	}

	emit(...messages: SDKMessage[]): void {
		for (const message of messages) {
			const waiter = this.waiter;
			if (waiter) {
				this.waiter = null;
				waiter({ value: message, done: false });
			} else this.queue.push(message);
		}
	}

	end(): void {
		this.ended = true;
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.({ value: undefined, done: true });
	}

	fail(error: Error): void {
		this.failure = error;
		this.end();
	}

	async interrupt(): Promise<unknown> {
		this.interrupted = true;
		return undefined;
	}

	close(): void {
		this.closed = true;
		this.end();
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return {
			next: () => {
				const next = this.queue.shift();
				if (next) return Promise.resolve({ value: next, done: false });
				if (this.failure) return Promise.reject(this.failure);
				if (this.ended || this.closed)
					return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => {
					this.waiter = resolve;
				});
			},
		};
	}

	/** The MCP client Claude Code would be, connected to the bridge's tool server. */
	mcp(): Promise<Client> {
		this.client ??= (async () => {
			const server = this.options.mcpServers?.[MCP_SERVER_NAME] as
				| McpSdkServerConfigWithInstance
				| undefined;
			if (!server) throw new Error("no tool server");
			const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
			await server.instance.connect(serverSide);
			const client = new Client({ name: "fake-claude-code", version: "0" });
			await client.connect(clientSide);
			return client;
		})();
		return this.client;
	}

	/** Claude Code calling a client tool: resolves when the bridge answers. */
	async callTool(id: string, name: string, args: Record<string, unknown> = {}) {
		const client = await this.mcp();
		return client.callTool({
			name,
			arguments: args,
			_meta: { "claudecode/toolUseId": id },
		});
	}
}

export function fakeQueryFn(): {
	fn: QueryFn;
	queries: FakeQuery[];
	next(): Promise<FakeQuery>;
} {
	const queries: FakeQuery[] = [];
	const waiters: Array<(q: FakeQuery) => void> = [];
	let taken = 0;
	return {
		queries,
		fn: ({ prompt, options }) => {
			const query = new FakeQuery(options, prompt);
			queries.push(query);
			const waiter = waiters.shift();
			if (waiter) {
				taken++;
				waiter(query);
			}
			return query;
		},
		next() {
			if (queries.length > taken)
				return Promise.resolve(queries[taken++] as FakeQuery);
			return new Promise((resolve) => waiters.push(resolve));
		},
	};
}

// ── SDK message builders ────────────────────────────────────────────────

let uuidSeq = 0;
const uuid = () =>
	`00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, "0")}`;

function streamEvent(
	event: Record<string, unknown>,
	parent: string | null = null,
): SDKMessage {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: parent,
		uuid: uuid(),
		session_id: "s",
	} as unknown as SDKMessage;
}

export function initMessage(sessionId = "s"): SDKMessage {
	return {
		type: "system",
		subtype: "init",
		session_id: sessionId,
		uuid: uuid(),
	} as unknown as SDKMessage;
}

export interface ScriptBlock {
	type: "text" | "tool_use" | "thinking";
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

/** One streamed model message, as Claude Code relays it with includePartialMessages. */
export function streamedMessage(
	blocks: ScriptBlock[],
	opts: { id?: string; stopReason?: string; model?: string } = {},
): SDKMessage[] {
	const id = opts.id ?? `msg_${uuid()}`;
	const out: SDKMessage[] = [
		streamEvent({
			type: "message_start",
			message: {
				id,
				type: "message",
				role: "assistant",
				model: opts.model ?? "claude-sonnet-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 1 },
			},
		}),
	];
	blocks.forEach((block, index) => {
		if (block.type === "text") {
			out.push(
				streamEvent({
					type: "content_block_start",
					index,
					content_block: { type: "text", text: "" },
				}),
			);
			out.push(
				streamEvent({
					type: "content_block_delta",
					index,
					delta: { type: "text_delta", text: block.text },
				}),
			);
		} else if (block.type === "thinking") {
			out.push(
				streamEvent({
					type: "content_block_start",
					index,
					content_block: { type: "thinking", thinking: "", signature: "" },
				}),
			);
			out.push(
				streamEvent({
					type: "content_block_delta",
					index,
					delta: { type: "thinking_delta", thinking: block.text },
				}),
			);
			out.push(
				streamEvent({
					type: "content_block_delta",
					index,
					delta: { type: "signature_delta", signature: "sig" },
				}),
			);
		} else {
			out.push(
				streamEvent({
					type: "content_block_start",
					index,
					content_block: {
						type: "tool_use",
						id: block.id,
						name: block.name,
						input: {},
					},
				}),
			);
			out.push(
				streamEvent({
					type: "content_block_delta",
					index,
					delta: {
						type: "input_json_delta",
						partial_json: JSON.stringify(block.input ?? {}),
					},
				}),
			);
		}
		out.push(streamEvent({ type: "content_block_stop", index }));
	});
	const stopReason =
		opts.stopReason ??
		(blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
	out.push(
		streamEvent({
			type: "message_delta",
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: { output_tokens: 5 },
		}),
	);
	out.push(streamEvent({ type: "message_stop" }));
	return out;
}

/** An assistant message Claude Code fetched without streaming (its fallback path). */
export function assistantMessage(
	content: Block[],
	opts: {
		id?: string;
		stopReason?: string | null;
		error?: string;
		model?: string;
	} = {},
): SDKMessage {
	return {
		type: "assistant",
		message: {
			id: opts.id ?? `msg_${uuid()}`,
			type: "message",
			role: "assistant",
			model: opts.model ?? "claude-sonnet-5",
			content,
			stop_reason: opts.stopReason ?? null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 5 },
		},
		parent_tool_use_id: null,
		...(opts.error ? { error: opts.error } : {}),
		uuid: uuid(),
		session_id: "s",
	} as unknown as SDKMessage;
}

export function resultMessage(
	opts: {
		isError?: boolean;
		subtype?: string;
		result?: string;
		errors?: string[];
	} = {},
): SDKMessage {
	return {
		type: "result",
		subtype: opts.subtype ?? "success",
		is_error: opts.isError ?? false,
		result: opts.result ?? "",
		errors: opts.errors ?? [],
		num_turns: 1,
		duration_ms: 1,
		duration_api_ms: 1,
		stop_reason: "end_turn",
		total_cost_usd: 0,
		usage: {
			input_tokens: 10,
			output_tokens: 5,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		modelUsage: {},
		permission_denials: [],
		uuid: uuid(),
		session_id: "s",
	} as unknown as SDKMessage;
}

// ── in-memory turn repository ───────────────────────────────────────────

export interface TurnRow extends Record<string, unknown> {
	id: string;
	status: string;
	legs: Array<Record<string, unknown>>;
	counters: { toolRounds: number; innerCalls: number; innerErrors: number };
}

export function memoryTurnRepo(): SdkBridgeTurnRepo & {
	turns: Map<string, TurnRow>;
	legs: Map<string, Record<string, unknown>>;
} {
	const turns = new Map<string, TurnRow>();
	const legs = new Map<string, Record<string, unknown>>();
	return {
		turns,
		legs,
		async insertTurn(turn: SdkBridgeTurnInsert) {
			turns.set(turn.id, {
				...turn,
				status: turn.status ?? "running",
				legs: [],
				counters: { toolRounds: 0, innerCalls: 0, innerErrors: 0 },
			});
		},
		async finishTurn(id: string, finish: SdkBridgeTurnFinish) {
			const turn = turns.get(id);
			if (turn) Object.assign(turn, finish);
		},
		async bumpTurnCounters(id: string, delta: SdkBridgeTurnCounterDelta) {
			const turn = turns.get(id);
			if (!turn) return;
			turn.counters.toolRounds += delta.toolRounds ?? 0;
			turn.counters.innerCalls += delta.innerCalls ?? 0;
			turn.counters.innerErrors += delta.innerErrors ?? 0;
		},
		async insertLeg(leg: SdkBridgeLegInsert) {
			const turn = turns.get(leg.turnId);
			if (!turn) throw new Error(`FOREIGN KEY: no turn ${leg.turnId}`);
			if (legs.has(leg.id)) throw new Error(`UNIQUE: leg ${leg.id}`);
			const row = { ...leg } as Record<string, unknown>;
			legs.set(leg.id, row);
			turn.legs.push(row);
		},
		async finishLeg(id: string, finish: SdkBridgeLegFinish) {
			const leg = legs.get(id);
			if (leg) Object.assign(leg, finish, { finished: true });
		},
	};
}

// ── bridge, plan and request helpers ────────────────────────────────────

export const silentLog: BridgeLog = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

export const MODEL = "claude-sonnet-5";

export function makePlan(
	overrides: Partial<SdkBridgeRoutePlan> = {},
): SdkBridgeRoutePlan {
	return Object.freeze({
		turnId: crypto.randomUUID(),
		routeSnapshot: null,
		candidates: Object.freeze([
			Object.freeze({
				accountId: "acct-a",
				provider: "anthropic",
				upstreamModel: MODEL,
			}),
		]),
		preferredAccountId: "acct-a",
		apiKeyId: "key-1",
		apiKeyName: "key one",
		...overrides,
	});
}

export function makeMeta(
	overrides: Partial<SdkBridgeTurnMeta> = {},
): SdkBridgeTurnMeta {
	return {
		legId: crypto.randomUUID(),
		apiKeyId: "key-1",
		apiKeyName: "key one",
		clientHarness: "pi",
		clientUserAgent: "pi/0.86",
		project: "proj",
		projectAttributionSource: null,
		affinityScope: null,
		affinityKey: null,
		model: MODEL,
		reasoningEffort: null,
		translationGaps: null,
		...overrides,
	};
}

export const READ_TOOL = {
	name: "read",
	description: "Read a file",
	input_schema: {
		$schema: "http://json-schema.org/draft-07/schema#",
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
};

export function messagesRequest(body: Record<string, unknown>): Request {
	return new Request("http://bridge.test/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			max_tokens: 1024,
			stream: true,
			...body,
		}),
	});
}

export interface FakeInner {
	calls: Array<{ req: Request; body: unknown; ctx: SdkBridgeInnerContext }>;
	respond: (
		req: Request,
		ctx: SdkBridgeInnerContext,
	) => Response | Promise<Response>;
	dispatch: ClaudeSdkBridgeDeps["dispatchInner"];
}

export function fakeInner(): FakeInner {
	const inner: FakeInner = {
		calls: [],
		respond: () => new Response("ok"),
		dispatch: async (req, ctx) => {
			const body = await req
				.clone()
				.json()
				.catch(() => null);
			inner.calls.push({ req, body, ctx });
			return inner.respond(req, ctx);
		},
	};
	return inner;
}

export interface Harness {
	bridge: ClaudeSdkBridge;
	sdk: ReturnType<typeof fakeQueryFn>;
	repo: ReturnType<typeof memoryTurnRepo>;
	inner: FakeInner;
	workRoot: string;
}

export function makeHarness(
	overrides: Partial<ClaudeSdkBridgeDeps> = {},
): Harness {
	const sdk = fakeQueryFn();
	const repo = memoryTurnRepo();
	const inner = fakeInner();
	const workRoot = mkdtempSync(join(tmpdir(), "sdk-bridge-unit-"));
	const bridge = createClaudeSdkBridge({
		queryFn: sdk.fn,
		dispatchInner: inner.dispatch,
		turnRepo: repo,
		workRoot,
		claudeExecutablePath: "/opt/fake/claude",
		log: silentLog,
		timing: {
			headHoldMs: 1_000,
			pingIntervalMs: 100,
			settleWaitMs: 500,
			idleTimeoutMs: 5_000,
			exitGraceMs: 50,
		},
		...overrides,
	});
	return { bridge, sdk, repo, inner, workRoot };
}

export interface SseEvent {
	event: string;
	data: Record<string, unknown>;
}

export function parseSse(text: string): SseEvent[] {
	return text
		.split("\n\n")
		.filter((chunk) => chunk.trim())
		.map((chunk) => {
			const lines = chunk.split("\n");
			const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "";
			const data = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "{}";
			return { event, data: JSON.parse(data) as Record<string, unknown> };
		});
}

/** Fold a reply's SSE into content blocks, the way a client does. */
export function foldReply(events: SseEvent[]): {
	content: Block[];
	stop: unknown;
	errors: SseEvent[];
} {
	const content: Array<Block & { _json?: string }> = [];
	let stop: unknown = null;
	for (const { data } of events) {
		if (data.type === "content_block_start")
			content[data.index as number] = {
				...(data.content_block as Block),
				_json: "",
			};
		if (data.type === "content_block_delta") {
			const block = content[data.index as number] as Block & { _json?: string };
			const delta = data.delta as Record<string, string>;
			if (delta.type === "text_delta")
				block.text = String(block.text ?? "") + delta.text;
			if (delta.type === "input_json_delta")
				block._json = (block._json ?? "") + delta.partial_json;
		}
		if (data.type === "message_delta")
			stop = (data.delta as Record<string, unknown>).stop_reason;
	}
	for (const block of content) {
		if (block.type === "tool_use")
			block.input = block._json ? JSON.parse(block._json) : {};
		delete block._json;
	}
	return { content, stop, errors: events.filter((e) => e.event === "error") };
}

export async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error("waitFor timed out");
		await Bun.sleep(5);
	}
}
