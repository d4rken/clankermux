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
	SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	SdkBridgeInnerContext,
	SdkBridgeLegFinish,
	SdkBridgeLegInsert,
	SdkBridgeParkLease,
	SdkBridgeReleasedPark,
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
	SdkBridgeParkRepo,
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

	/** The session this query writes, as the SDK mirrors it into the store. */
	readonly sessionId: string;
	private lastUuid: string | null = null;
	/** The child standing in for Claude Code, when the harness gives it one. */
	pid: number | null = null;
	/** Mirror transcript entries into the session store, as the real SDK does. */
	mirrors = false;

	constructor(
		readonly options: Options,
		prompt: AsyncIterable<SDKUserMessage>,
	) {
		this.sessionId = String(options.resume ?? options.sessionId ?? "");
		if (options.resume) {
			const entries = (
				options.sessionStore as { read?: (id: string) => unknown[] | null }
			)?.read?.(this.sessionId);
			this.lastUuid =
				options.resumeSessionAt ??
				((entries ?? []) as Array<{ uuid?: string }>).findLast((e) => e.uuid)
					?.uuid ??
				null;
		}
		void (async () => {
			for await (const message of prompt) {
				this.prompts.push(message);
				this.mirror("user", message.message);
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

	/** What the SDK appends to the session store for a transcript entry. */
	private mirror(type: "user" | "assistant", message: unknown, uuid?: string) {
		const store = this.options.sessionStore as SessionStore | undefined;
		if (!this.mirrors || !store || !this.sessionId) return;
		const entry = {
			type,
			uuid: uuid ?? crypto.randomUUID(),
			parentUuid: this.lastUuid,
			sessionId: this.sessionId,
			message,
		};
		this.lastUuid = entry.uuid;
		void store.append({ projectKey: "p", sessionId: this.sessionId }, [
			entry as never,
		]);
	}

	/** The stand-in process died: the SDK's stream ends with it. */
	processExited(): void {
		this.end();
	}

	emit(...messages: SDKMessage[]): void {
		for (const message of messages) {
			const m = message as {
				type: string;
				uuid?: string;
				parent_tool_use_id?: string | null;
				message?: { model?: string };
			};
			if (
				m.type === "assistant" &&
				m.parent_tool_use_id === null &&
				m.message?.model !== "<synthetic>"
			)
				this.mirror("assistant", m.message, m.uuid);
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

/**
 * `process`: give each query a real child in its own process group, the way
 * the bridge spawns Claude Code, whose exit ends the query's stream.
 * `ignore-term` ignores SIGTERM, so only the SIGKILL ends it.
 */
export function fakeQueryFn(
	opts: { process?: "normal" | "ignore-term" } = {},
): {
	fn: QueryFn;
	queries: FakeQuery[];
	next(): Promise<FakeQuery>;
	/** Thrown by the next query() call, as a spawn failure would be. */
	throwNext: Error | null;
} {
	const queries: FakeQuery[] = [];
	const waiters: Array<(q: FakeQuery) => void> = [];
	let taken = 0;
	const api = {
		throwNext: null as Error | null,
		queries,
		fn: (({ prompt, options }) => {
			if (api.throwNext) {
				const error = api.throwNext;
				api.throwNext = null;
				throw error;
			}
			const query = new FakeQuery(options, prompt);
			query.mirrors = opts.process !== undefined;
			if (opts.process && options.spawnClaudeCodeProcess) {
				const script =
					opts.process === "ignore-term"
						? "trap '' TERM; /bin/sleep 600"
						: "exec /bin/sleep 600";
				const child = options.spawnClaudeCodeProcess({
					command: "/bin/sh",
					args: ["-c", script],
					cwd: options.cwd,
					env: {},
					signal: new AbortController().signal,
				}) as unknown as import("node:child_process").ChildProcess;
				query.pid = child.pid ?? null;
				child.once("exit", () => query.processExited());
			}
			queries.push(query);
			const waiter = waiters.shift();
			if (waiter) {
				taken++;
				waiter(query);
			}
			return query;
		}) as QueryFn,
		next(): Promise<FakeQuery> {
			if (queries.length > taken)
				return Promise.resolve(queries[taken++] as FakeQuery);
			return new Promise((resolve) => waiters.push(resolve));
		},
	};
	return api;
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
	opts: {
		id?: string;
		stopReason?: string;
		model?: string;
		usage?: Record<string, number | null>;
		deltaUsage?: Record<string, number | null>;
	} = {},
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
				usage: opts.usage ?? { input_tokens: 10, output_tokens: 1 },
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
			usage: opts.deltaUsage ?? { output_tokens: 5 },
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
		usage?: Record<string, number | null>;
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
			usage: opts.usage ?? { input_tokens: 10, output_tokens: 5 },
		},
		parent_tool_use_id: null,
		...(opts.error ? { error: opts.error } : {}),
		uuid: uuid(),
		session_id: "s",
	} as unknown as SDKMessage;
}

/**
 * The user message Claude Code reports once a tool of its own ran: the
 * tool_result it sends the model, and its structured output
 * (`tool_use_result`, a `WebSearchOutput` for WebSearch).
 */
export function toolResultMessage(
	toolUseId: string,
	toolUseResult: unknown,
	opts: { isError?: boolean; text?: string } = {},
): SDKMessage {
	return {
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					content: opts.text ?? "Web search results",
					...(opts.isError ? { is_error: true } : {}),
				},
			],
		},
		parent_tool_use_id: null,
		tool_use_result: toolUseResult,
		uuid: uuid(),
		session_id: "s",
	} as unknown as SDKMessage;
}

/** A `WebSearchOutput` with one result group per list of urls. */
export function webSearchOutput(
	query: string,
	groups: string[][],
	extra: { commentary?: string[]; searchCount?: number } = {},
): Record<string, unknown> {
	return {
		query,
		results: [
			...groups.map((urls, i) => ({
				tool_use_id: `srvtoolu_${i}`,
				content: urls.map((url) => ({ title: `title of ${url}`, url })),
			})),
			...(extra.commentary ?? []),
		],
		durationSeconds: 0.5,
		searchCount: extra.searchCount ?? groups.length,
	};
}

export function resultMessage(
	opts: {
		isError?: boolean;
		subtype?: string;
		result?: string;
		errors?: string[];
		terminalReason?: string;
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
		...(opts.terminalReason ? { terminal_reason: opts.terminalReason } : {}),
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

/** Whether a token holds the park lease, per turn map (set by memoryParkRepo). */
const leaseChecks = new WeakMap<
	Map<string, TurnRow>,
	(token: string) => boolean
>();

export function memoryTurnRepo(): SdkBridgeTurnRepo & {
	turns: Map<string, TurnRow>;
	legs: Map<string, Record<string, unknown>>;
	/** The next insertLeg waits for this first. */
	legInsertHold: { next: Promise<void> | null };
} {
	const turns = new Map<string, TurnRow>();
	const legs = new Map<string, Record<string, unknown>>();
	const legInsertHold: { next: Promise<void> | null } = { next: null };
	/** A fenced write (a park-owned turn's) applies only under the lease. */
	const fenced = (fence: string | undefined) =>
		fence !== undefined && !(leaseChecks.get(turns)?.(fence) ?? false);
	return {
		turns,
		legs,
		legInsertHold,
		async insertTurn(turn: SdkBridgeTurnInsert) {
			turns.set(turn.id, {
				...turn,
				status: turn.status ?? "running",
				legs: [],
				counters: { toolRounds: 0, innerCalls: 0, innerErrors: 0 },
			});
		},
		async finishTurn(id: string, finish: SdkBridgeTurnFinish, fence?: string) {
			if (fenced(fence)) return false;
			const turn = turns.get(id);
			if (!turn || turn.finishedAt != null) return false;
			Object.assign(turn, finish);
			return true;
		},
		async bumpTurnCounters(
			id: string,
			delta: SdkBridgeTurnCounterDelta,
			fence?: string,
		) {
			if (fenced(fence)) return;
			const turn = turns.get(id);
			if (!turn) return;
			turn.counters.toolRounds += delta.toolRounds ?? 0;
			turn.counters.innerCalls += delta.innerCalls ?? 0;
			turn.counters.innerErrors += delta.innerErrors ?? 0;
		},
		async insertLeg(leg: SdkBridgeLegInsert, fence?: string) {
			const wait = legInsertHold.next;
			if (wait) {
				legInsertHold.next = null;
				await wait;
			}
			if (fenced(fence)) return false;
			const turn = turns.get(leg.turnId);
			if (!turn) throw new Error(`FOREIGN KEY: no turn ${leg.turnId}`);
			if (legs.has(leg.id)) throw new Error(`UNIQUE: leg ${leg.id}`);
			const row = { ...leg } as Record<string, unknown>;
			legs.set(leg.id, row);
			turn.legs.push(row);
			return true;
		},
		async finishLeg(id: string, finish: SdkBridgeLegFinish, fence?: string) {
			if (fenced(fence)) return;
			const leg = legs.get(id);
			if (leg) Object.assign(leg, finish, { finished: true });
		},
	};
}

/**
 * `sdk_bridge_released_parks` and its lease in memory, with the
 * repository's fencing: every write applies only while its token holds the
 * lease, and moves the turn rows the way the repository's transactions do.
 * `failNext` makes one method throw once; `hold` makes its next call wait.
 * A call that throws does not take the hold, so both on one method fail
 * the first call and hold the second.
 */
export function memoryParkRepo(
	turns: Map<string, TurnRow>,
): SdkBridgeParkRepo & {
	parks: Map<string, SdkBridgeReleasedPark>;
	failNext: Partial<Record<keyof SdkBridgeParkRepo, Error>>;
	hold: Partial<Record<keyof SdkBridgeParkRepo, Promise<void>>>;
	calls: string[];
	/** Stands in for the database's identity: its released-parks subdirectory. */
	namespace: string;
	readonly lease: SdkBridgeParkLease | null;
} {
	const parks = new Map<string, SdkBridgeReleasedPark>();
	const failNext: Partial<Record<keyof SdkBridgeParkRepo, Error>> = {};
	const hold: Partial<Record<keyof SdkBridgeParkRepo, Promise<void>>> = {};
	const calls: string[] = [];
	let lease: SdkBridgeParkLease | null = null;
	const check = async (name: keyof SdkBridgeParkRepo) => {
		calls.push(name);
		const error = failNext[name];
		if (error) {
			delete failNext[name];
			throw error;
		}
		const wait = hold[name];
		if (wait) {
			delete hold[name];
			await wait;
		}
	};
	const leased = (token: string) => lease?.token === token;
	leaseChecks.set(turns, leased);
	const turnOpen = (id: string) => turns.get(id)?.finishedAt == null;
	const setTurn = (id: string, fields: Record<string, unknown>) => {
		const turn = turns.get(id);
		if (turn) Object.assign(turn, fields);
	};
	return {
		parks,
		failNext,
		hold,
		calls,
		namespace: `db${crypto.randomUUID().slice(0, 8)}`,
		get lease() {
			return lease;
		},
		async acquireLease(candidate, holderDead) {
			await check("acquireLease");
			if (lease && lease.token !== candidate.token && !holderDead(lease))
				return false;
			lease = { ...candidate };
			return true;
		},
		async holdsLease(token) {
			return leased(token);
		},
		async releaseLease(token) {
			if (leased(token)) lease = null;
		},
		async insertPreparing(park, token) {
			await check("insertPreparing");
			if (!leased(token)) return false;
			if (parks.has(park.turnId)) throw new Error("UNIQUE: park");
			parks.set(park.turnId, {
				...park,
				state: "preparing",
				claimOwner: null,
				claimId: null,
				claimedAt: null,
			});
			return true;
		},
		async find(turnId) {
			await check("find");
			const park = parks.get(turnId);
			return park ? { ...park } : null;
		},
		async list() {
			await check("list");
			return [...parks.values()].map((p) => ({ ...p }));
		},
		async markReleased(turnId, file, token) {
			await check("markReleased");
			const park = parks.get(turnId);
			if (park?.state !== "preparing" || !turnOpen(turnId) || !leased(token))
				return false;
			Object.assign(park, file, { state: "released" });
			setTurn(turnId, { status: "released" });
			return true;
		},
		async claim(turnId, token, claimId, at, owner) {
			await check("claim");
			const park = parks.get(turnId);
			if (park?.state !== "released" || !turnOpen(turnId) || !leased(token))
				return false;
			Object.assign(park, {
				state: "claimed",
				claimOwner: token,
				claimId,
				claimedAt: at,
			});
			setTurn(turnId, {
				status: "running",
				ownerPid: owner.pid,
				ownerStartTime: owner.startTime,
			});
			return true;
		},
		async unclaim(turnId, token, which) {
			await check("unclaim");
			const park = parks.get(turnId);
			if (park?.state !== "claimed" || !leased(token)) return false;
			if ("claimId" in which && park.claimId !== which.claimId) return false;
			Object.assign(park, {
				state: "released",
				claimOwner: null,
				claimId: null,
				claimedAt: null,
			});
			if (turnOpen(turnId)) setTurn(turnId, { status: "released" });
			return true;
		},
		async markConsumed(turnId, token, claimId) {
			await check("markConsumed");
			const park = parks.get(turnId);
			if (park?.state !== "claimed" || park.claimOwner !== token) return false;
			if (park.claimId !== claimId) return false;
			if (!leased(token)) return false;
			park.state = "consumed";
			return true;
		},
		async delete(turnId, token) {
			await check("delete");
			if (!leased(token)) return false;
			return parks.delete(turnId);
		},
		async closeTurn(turnId, finish, token) {
			await check("closeTurn");
			if (!leased(token)) return "refused";
			parks.delete(turnId);
			if (!turns.has(turnId) || !turnOpen(turnId)) return "kept";
			setTurn(turnId, { ...finish });
			return "closed";
		},
		async closeOpenTurnsWithoutPark(before, finish, token, ownerDead) {
			await check("closeOpenTurnsWithoutPark");
			if (!leased(token)) return 0;
			let n = 0;
			for (const turn of turns.values()) {
				if (
					(turn.status !== "running" && turn.status !== "released") ||
					turn.finishedAt ||
					Number(turn.startedAt) >= before ||
					parks.has(turn.id)
				)
					continue;
				const pid = turn.ownerPid as number | null | undefined;
				if (
					pid != null &&
					!ownerDead({
						pid,
						startTime: (turn.ownerStartTime as string | null) ?? null,
					})
				)
					continue;
				Object.assign(turn, finish);
				n++;
			}
			return n;
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

export interface LogEntry {
	level: keyof BridgeLog;
	message: string;
	data: unknown;
}

/** A log that keeps what it is given; `turns()` is the `sdk_bridge_turn` lines. */
export function capturingLog(): BridgeLog & {
	entries: LogEntry[];
	turns: (
		turnId?: string,
	) => Array<LogEntry & { data: Record<string, unknown> }>;
} {
	const entries: LogEntry[] = [];
	const keep =
		(level: keyof BridgeLog) =>
		(message: string, data?: unknown): void => {
			entries.push({ level, message, data });
		};
	return {
		entries,
		debug: keep("debug"),
		info: keep("info"),
		warn: keep("warn"),
		error: keep("error"),
		turns: (turnId) =>
			entries.filter(
				(e): e is LogEntry & { data: Record<string, unknown> } =>
					(e.data as { event?: unknown } | undefined)?.event ===
						"sdk_bridge_turn" &&
					(turnId === undefined ||
						(e.data as { turnId?: unknown }).turnId === turnId),
			),
	};
}

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
		clientHarness: "opencode",
		clientUserAgent: "opencode/1.14.0",
		project: "proj",
		projectAttributionSource: null,
		affinityScope: null,
		affinityKey: null,
		model: MODEL,
		reasoningEffort: null,
		translationGaps: null,
		piPromptVersion: null,
		sideRequest: null,
		hostedWebSearch: null,
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
	opts: {
		process?: "normal" | "ignore-term";
		repo?: ReturnType<typeof memoryTurnRepo>;
		workRoot?: string;
	} = {},
): Harness {
	const sdk = fakeQueryFn({ process: opts.process });
	const repo = opts.repo ?? memoryTurnRepo();
	const inner = fakeInner();
	const workRoot =
		opts.workRoot ?? mkdtempSync(join(tmpdir(), "sdk-bridge-unit-"));
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
		if (block.type === "tool_use" || block.type === "server_tool_use")
			block.input = block._json ? JSON.parse(block._json) : {};
		delete block._json;
	}
	return { content, stop, errors: events.filter((e) => e.event === "error") };
}

/** The turn a continuation lookup found; undefined for none or "recovering". */
export function turnIdOf(
	found: ReturnType<ClaudeSdkBridge["findContinuation"]>,
): string | undefined {
	return found && "turnId" in found ? found.turnId : undefined;
}

export async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error("waitFor timed out");
		await Bun.sleep(5);
	}
}
