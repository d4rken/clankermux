/**
 * What Claude Code does on its own to a bridged conversation's context and
 * model: compaction (automatic, reactive, micro), server-side context editing,
 * tool-result persistence, and model fallback. Runs the bundled binary with
 * the bridge's own options against a loopback mock upstream, and writes what
 * happened to the JSON file named by argv[2].
 *
 * Only ever run inside a network namespace with nothing but loopback:
 *   unshare -rn sh -c 'ip link set lo up && bun real-claude-context-scenarios.ts out.json'
 * It refuses to start when 1.1.1.1 is reachable.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkBridgeRoutePlan, SdkBridgeTurnMeta } from "@clankermux/types";
import { type ClaudeSdkBridge, createClaudeSdkBridge } from "../../bridge";
import { buildQueryOptions, workPaths } from "../../options";
import { PromptStream } from "../../prompt-stream";
import { FileSessionStore } from "../../session-store";
import { ProcessGroupSpawner, resolveClaudeExecutable } from "../../spawn";
import {
	createToolServer,
	loadMcpSdk,
	type McpContent,
	ToolNames,
} from "../../tool-server";
import type { SdkBridgeLimits, SdkBridgeParkRepo } from "../../types";
import { ensurePrivateDir } from "../../work-dirs";
import {
	MODEL,
	memoryParkRepo,
	memoryTurnRepo,
	parseSse,
	READ_TOOL,
	silentLog,
} from "./fake-sdk";
import {
	type MockRequest,
	type MockRule,
	startMockUpstream,
} from "./mock-upstream";

type Block = { type: string; [key: string]: unknown };
type Msg = { role: "user" | "assistant"; content: string | Block[] };

const out = process.argv[2];
if (!out) throw new Error("usage: real-claude-context-scenarios.ts <out.json>");

const results: Record<string, unknown> = {};
const save = () => writeFileSync(out, JSON.stringify(results, null, 2));

let egressBlocked = false;
try {
	await fetch("https://1.1.1.1", { signal: AbortSignal.timeout(2_000) });
} catch {
	egressBlocked = true;
}
results.egressBlocked = egressBlocked;
save();
if (!egressBlocked) {
	console.error("network is reachable; refusing to start Claude Code");
	process.exit(2);
}

const resolved = resolveClaudeExecutable();
if ("error" in resolved) throw new Error(resolved.error);
const executablePath = resolved.path;
const { query } = await import("@anthropic-ai/claude-agent-sdk");
const mcp = await loadMcpSdk();
const mock = startMockUpstream();
const root = mkdtempSync(join(tmpdir(), "sdk-bridge-context-"));
const paths = workPaths(root);
for (const dir of Object.values(paths)) ensurePrivateDir(dir);
const store = new FileSessionStore(paths.sessions);
const spawner = new ProcessGroupSpawner();
// Only what the bridge's listener serves reaches the mock.
const front = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (req) =>
		["/v1/messages", "/v1/messages/count_tokens"].includes(
			new URL(req.url).pathname,
		)
			? mock.handle(req)
			: new Response(null, { status: 404 }),
});

/** A model call, not a token count. */
const isModelCall = (r: MockRequest) => r.path.split("?")[0] === "/v1/messages";

/** Environments to compare with the bridge's own (`childEnv`). */
type EnvName =
	| "bridge"
	| "bridgePlusDisableCompact"
	| "autoCompactOn"
	| "disableCompactOnly"
	| "modelFallbackOn"
	| "mcpTokensDefault";

function envFor(name: EnvName, base: Record<string, string>) {
	const env = { ...base };
	if (name === "bridgePlusDisableCompact") env.DISABLE_COMPACT = "1";
	if (name === "autoCompactOn" || name === "disableCompactOnly")
		delete env.DISABLE_AUTO_COMPACT;
	if (name === "disableCompactOnly") env.DISABLE_COMPACT = "1";
	if (name === "modelFallbackOn") delete env.CLAUDE_CODE_NO_MODEL_FALLBACK;
	if (name === "mcpTokensDefault") delete env.MAX_MCP_OUTPUT_TOKENS;
	return env;
}

const ANTHROPIC_PROMPT_TOO_LONG = {
	type: "error",
	error: {
		type: "invalid_request_error",
		message: "prompt is too long: 1050000 tokens > 1000000 maximum",
	},
	request_id: "req_mock_prompt_too_long",
};

const ANTHROPIC_OVERLOADED = {
	type: "error",
	error: { type: "overloaded_error", message: "Overloaded" },
	request_id: "req_mock_overloaded",
};

function describeCall(q: MockRequest) {
	const body = q.body as {
		model?: string;
		messages?: Array<{ role: string; content: unknown; clear_at?: unknown }>;
		context_management?: unknown;
		thinking?: unknown;
		max_tokens?: unknown;
	};
	const raw = JSON.stringify(body);
	const results = (body.messages ?? []).flatMap((m) =>
		Array.isArray(m.content)
			? (m.content as Block[]).filter((b) => b.type === "tool_result")
			: [],
	);
	return {
		status: q.status ?? null,
		session: q.headers["x-claude-code-session-id"] ?? null,
		model: body.model ?? null,
		betas: (q.headers["anthropic-beta"] ?? "")
			.split(",")
			.map((b) => b.trim())
			.filter(Boolean),
		bodyKeys: Object.keys(body ?? {}).sort(),
		messageCount: body.messages?.length ?? 0,
		roles: (body.messages ?? []).map((m) => m.role).join(","),
		contextManagement: body.context_management ?? null,
		thinking: body.thinking ?? null,
		clearAt: (body.messages ?? []).some((m) => m.clear_at !== undefined),
		summaryRequest: raw.includes("create a detailed summary"),
		carriesSummary: raw.includes("MOCK-SUMMARY"),
		clearedToolResult: raw.includes("[Old tool result content cleared]"),
		persistedOutput: raw.includes("<persisted-output>"),
		truncatedOutput: raw.includes("<truncated-output>"),
		conversation: (body.messages ?? [])
			.filter((m) => m.role !== "system")
			.map((m) => [
				m.role,
				(typeof m.content === "string"
					? [{ type: "text", text: m.content }]
					: (m.content as Block[])
				)
					.filter(
						(b) =>
							b.type !== "text" ||
							!String(b.text).startsWith("<system-reminder>"),
					)
					.map((b) => (b.type === "text" ? String(b.text) : `[${b.type}]`))
					.join("\n"),
			]),
		lastUserChars: JSON.stringify(
			(body.messages ?? []).filter((m) => m.role === "user").at(-1) ?? null,
		).length,
		toolResults: results.length,
		toolResultChars: results.map((b) =>
			typeof b.content === "string"
				? b.content.length
				: JSON.stringify(b.content ?? "").length,
		),
	};
}

/** What Claude Code emitted, without the stream events. */
function describeMessage(m: SDKMessage): Record<string, unknown> | null {
	const any = m as unknown as Record<string, unknown>;
	if (m.type === "stream_event") return null;
	if (m.type === "assistant")
		return {
			type: "assistant",
			model: m.message.model,
			error: (any.error as string | undefined) ?? null,
			stop: m.message.stop_reason,
		};
	if (m.type === "result")
		return {
			type: "result",
			subtype: m.subtype,
			isError: m.is_error,
			terminalReason: any.terminal_reason ?? null,
			errors: any.errors ?? null,
			result: typeof any.result === "string" ? any.result.slice(0, 300) : null,
			numTurns: m.num_turns,
		};
	if (m.type === "system")
		return {
			type: "system",
			subtype: m.subtype,
			...(m.subtype === "init" ? { model: any.model } : {}),
			...(any.compact_metadata
				? { compactMetadata: any.compact_metadata }
				: {}),
			...(m.subtype !== "init" && m.subtype !== "status"
				? { detail: JSON.stringify(any).slice(0, 500) }
				: {}),
		};
	return { type: m.type, subtype: (any.subtype as string) ?? null };
}

interface RunInput {
	marker: string;
	env: EnvName;
	prompt: string;
	model?: string;
	sessionId?: string;
	resume?: boolean;
	/** What every client tool call answers. */
	toolResult?: string;
	/** What every client tool call answers, as MCP content; wins over `toolResult`. */
	toolContent?: McpContent[];
	extraOptions?: Partial<Options>;
	extraEnv?: Record<string, string>;
	/** Every listed tool's `_meta`, in place of the bridge's own. */
	toolMeta?: Record<string, unknown>;
}

/**
 * One Claude Code query on the bridge's options, with every tool call answered
 * at once. Returns the calls the mock saw for this conversation's marker and
 * the SDK messages Claude Code emitted.
 */
async function runQuery(input: RunInput) {
	const sessionId = input.sessionId ?? crypto.randomUUID();
	const names = new ToolNames([READ_TOOL.name]);
	const prompt = new PromptStream();
	prompt.push(input.prompt);
	const base = buildQueryOptions({
		paths,
		baseUrl: `http://127.0.0.1:${front.port}`,
		token: crypto.randomUUID(),
		model: input.model ?? MODEL,
		toolNames: names.exposed,
		toolServer: createToolServer(mcp, [READ_TOOL], names, async () => ({
			content: input.toolContent ?? [
				{ type: "text", text: input.toolResult ?? "R" },
			],
		})),
		systemPrompt: { append: null, excludeDynamicSections: false },
		effort: null,
		maxOutputTokens: 1024,
		sessionId,
		resume: input.resume ?? false,
		sessionStore: store,
		executablePath,
		spawn: (o) => spawner.spawn(o),
		stderr: () => {},
		abortController: new AbortController(),
	});
	if (input.toolMeta) {
		// The bridge's own listing, with extra `_meta` on every tool.
		const server = (
			base.mcpServers?.c as unknown as {
				instance: {
					server: {
						setRequestHandler(schema: unknown, handler: () => unknown): void;
					};
				};
			}
		).instance.server;
		server.setRequestHandler(mcp.ListToolsRequestSchema, () => ({
			tools: [
				{
					name: names.exposedName(READ_TOOL.name),
					description: READ_TOOL.description,
					inputSchema: {
						type: "object",
						properties: { path: { type: "string" } },
					},
					_meta: input.toolMeta,
				},
			],
		}));
	}
	const options: Options = {
		...base,
		env: {
			...envFor(input.env, base.env as Record<string, string>),
			...input.extraEnv,
		},
		...input.extraOptions,
	};
	const messages: Record<string, unknown>[] = [];
	const t0 = performance.now();
	const q = query({ prompt, options });
	const done = (async () => {
		try {
			for await (const m of q) {
				const d = describeMessage(m);
				if (d) messages.push(d);
				if (m.type === "result") prompt.end();
			}
		} catch (error) {
			messages.push({ type: "exception", message: String(error) });
		}
	})();
	const timedOut = await Promise.race([
		done.then(() => false),
		Bun.sleep(90_000).then(() => true),
	]);
	if (timedOut) {
		prompt.end();
		messages.push({ type: "timeout" });
	}
	// A compacted history no longer carries the marker; the session header does.
	const mine = mock.requests.filter(
		(r) =>
			JSON.stringify(r.body).includes(input.marker) ||
			r.headers["x-claude-code-session-id"] === sessionId,
	);
	const calls = mine.filter(isModelCall).map(describeCall);
	const tokenCounts = mine.filter((r) => !isModelCall(r)).length;
	return {
		env: input.env,
		sessionId,
		ms: Math.round(performance.now() - t0),
		calls,
		tokenCounts,
		messages,
		result: messages.find((m) => m.type === "result") ?? null,
		systemSubtypes: messages
			.filter((m) => m.type === "system")
			.map((m) => m.subtype),
	};
}

/** argv[3], a comma-separated list, runs only those scenarios. */
const only = process.argv[3]?.split(",") ?? null;

async function scenario(name: string, run: () => Promise<unknown>) {
	if (only && !only.includes(name)) return;
	const t0 = performance.now();
	try {
		const detail = (await run()) as object;
		results[name] = {
			ok: true,
			ms: Math.round(performance.now() - t0),
			...detail,
		};
	} catch (error) {
		results[name] = {
			ok: false,
			error: error instanceof Error ? error.stack : String(error),
		};
	}
	save();
}

const ENVS: EnvName[] = [
	"bridge",
	"bridgePlusDisableCompact",
	"autoCompactOn",
	"disableCompactOnly",
];

/** Rules for one conversation, scoped by its marker. */
function rule(marker: string, r: Omit<MockRule, "marker">) {
	mock.addRule({ marker, ...r });
}

// (a) Usage past the window: the tool call's reply reports 250k input tokens
// on a bare model id, which Claude Code gives a 200k window. The call that
// would answer the tool result, and the next user turn resumed from the
// session, show whether Claude Code summarized or rewrote anything.
await scenario("autoCompact", async () => {
	const runs = await Promise.all(
		ENVS.map(async (env) => {
			const marker = `[S:ac-${env}]`;
			rule(marker, {
				when: ({ index }) => index === 0,
				shape: {
					usage: {
						input_tokens: 250_000,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			});
			const first = await runQuery({
				marker,
				env,
				prompt: `${marker} LOOP1 read one file`,
			});
			const second = await runQuery({
				marker,
				env,
				prompt: `${marker} second user turn`,
				sessionId: first.sessionId,
				resume: true,
			});
			return [env, { first, second }] as const;
		}),
	);
	return Object.fromEntries(runs);
});

// (b) Reactive compaction: the fourth model call of a tool loop answers the
// API's 400 prompt_too_long.
await scenario("reactiveCompact", async () => {
	const runs = await Promise.all(
		ENVS.map(async (env) => {
			const marker = `[S:rc-${env}]`;
			rule(marker, {
				when: ({ index }) => index === 3,
				times: 1,
				fail: { status: 400, body: ANTHROPIC_PROMPT_TOO_LONG },
			});
			return [
				env,
				await runQuery({ marker, env, prompt: `${marker} LOOP3 read three` }),
			] as const;
		}),
	);
	return Object.fromEntries(runs);
});

// (c) Microcompaction: twelve tool rounds with 20 KB results each and 150k
// reported input tokens on every call, and separately a 422 (the status
// Claude Code's context-hint path answers by clearing old tool results).
await scenario("microcompact", async () => {
	const marker = "[S:mc]";
	rule(marker, {
		shape: {
			usage: {
				input_tokens: 150_000,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	});
	const manyRounds = await runQuery({
		marker,
		env: "bridge",
		prompt: `${marker} LOOP12 read twelve files`,
		toolResult: `${"tool output line\n".repeat(1_200)}`,
	});
	const hintMarker = "[S:hint]";
	rule(hintMarker, {
		when: ({ index }) => index === 2,
		times: 1,
		fail: {
			status: 422,
			body: {
				type: "error",
				error: { type: "invalid_request_error", message: "context hint" },
			},
		},
	});
	const hint422 = await runQuery({
		marker: hintMarker,
		env: "bridge",
		prompt: `${hintMarker} LOOP3 read three`,
	});
	return { manyRounds, hint422 };
});

function bigText(size: number): string {
	const line = "0123456789abcdef0123456789abcdef0123456789abcdef012345678\n";
	return line.repeat(Math.ceil(size / line.length)).slice(0, size);
}

// Tool results of growing size: whether the model receives them whole, with
// the bridge's tool listing, and with the listing it had before it declared
// Claude Code's largest result size.
await scenario("largeToolResult", async () => {
	const variants: Array<{
		name: string;
		sizes: number[];
		env?: EnvName;
		toolMeta?: Record<string, unknown>;
	}> = [
		{ name: "bridge", sizes: [51_000, 120_000, 499_000, 501_000] },
		// The listing and environment the bridge had before either limit was set.
		{
			name: "undeclared",
			sizes: [49_000, 51_000, 120_000],
			env: "mcpTokensDefault",
			toolMeta: { "anthropic/alwaysLoad": true },
		},
		// Raising MAX_MCP_OUTPUT_TOKENS alone.
		{
			name: "undeclaredMaxMcpOutputTokens",
			sizes: [120_000],
			toolMeta: { "anthropic/alwaysLoad": true },
		},
	];
	const runs = await Promise.all(
		variants.flatMap((v) =>
			v.sizes.map(async (size) => {
				const marker = `[S:big-${v.name}-${size}]`;
				const r = await runQuery({
					marker,
					env: v.env ?? "bridge",
					prompt: `${marker} TOOL read the big file`,
					toolResult: bigText(size),
					toolMeta: v.toolMeta,
				});
				return [`${v.name} ${size}`, r] as const;
			}),
		),
	);
	// Five results of 45 KB each in one message: no aggregate budget.
	const fanMarker = "[S:fan]";
	const fanout = await runQuery({
		marker: fanMarker,
		env: "bridge",
		prompt: `${fanMarker} FANOUT5 read five`,
		toolResult: bigText(45_000),
	});
	return { ...Object.fromEntries(runs), fanout };
});

// A client message that reads as a slash command.
await scenario("slashCompact", async () => {
	const runs = await Promise.all(
		(["bridge", "bridgePlusDisableCompact", "autoCompactOn"] as EnvName[]).map(
			async (env) => {
				const marker = `[S:slash-${env}]`;
				const first = await runQuery({
					marker,
					env,
					prompt: `${marker} hello`,
				});
				const second = await runQuery({
					marker,
					env,
					prompt: `/compact ${marker}`,
					sessionId: first.sessionId,
					resume: true,
				});
				return [env, { first, second }] as const;
			},
		),
	);
	return Object.fromEntries(runs);
});

// Control for the bridge's CLAUDE_CODE_NO_MODEL_FALLBACK: without it, a
// refusal on Fable 5.1 or Opus 5.5 is retried on Opus 4.8.
await scenario("refusalFallbackOn", async () => {
	const runs = await Promise.all(
		["claude-fable-5-1", "claude-opus-5-5"].map(async (model) => {
			const marker = `[S:refon-${model}]`;
			rule(marker, {
				when: ({ index }) => index === 0,
				times: 1,
				shape: {
					stopReason: "refusal",
					stopDetails: {
						type: "refusal",
						category: "cyber",
						explanation: null,
					},
				},
			});
			const r = await runQuery({
				marker,
				env: "modelFallbackOn",
				model,
				prompt: `${marker} hi`,
			});
			return [model, r] as const;
		}),
	);
	return Object.fromEntries(runs);
});

// Where Claude Code refuses a call itself: the tool call's reply reports
// this many input tokens.
await scenario("window", async () => {
	const cases: Array<[string, number]> = [
		["claude-sonnet-5", 150_000],
		["claude-sonnet-5", 250_000],
		["claude-opus-5-5[1m]", 900_000],
		["claude-opus-5-5[1m]", 1_020_000],
	];
	const runs = await Promise.all(
		cases.map(async ([model, tokens]) => {
			const marker = `[S:w-${model}-${tokens}]`;
			rule(marker, {
				when: ({ index }) => index === 0,
				shape: {
					usage: {
						input_tokens: tokens,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			});
			const r = await runQuery({
				marker,
				env: "bridge",
				model,
				prompt: `${marker} LOOP1 go`,
			});
			return [`${model} ${tokens}`, r] as const;
		}),
	);
	return Object.fromEntries(runs);
});

// Q2: what model Claude Code asks for after an overload or a refusal.
const FALLBACK_MODELS = [
	"claude-sonnet-5",
	"claude-fable-5-1",
	"claude-opus-5-5",
	"claude-opus-5-5[1m]",
];

await scenario("overloaded", async () => {
	const runs = await Promise.all(
		FALLBACK_MODELS.map(async (model) => {
			const marker = `[S:ovl-${model}]`;
			rule(marker, {
				when: ({ index }) => index === 0,
				times: 1,
				fail: { status: 529, body: ANTHROPIC_OVERLOADED },
			});
			return [
				model,
				await runQuery({
					marker,
					env: "bridge",
					model,
					prompt: `${marker} hi`,
				}),
			] as const;
		}),
	);
	return Object.fromEntries(runs);
});

await scenario("refusal", async () => {
	const runs = await Promise.all(
		FALLBACK_MODELS.map(async (model) => {
			const marker = `[S:ref-${model}]`;
			rule(marker, {
				when: ({ index }) => index === 0,
				times: 1,
				shape: {
					stopReason: "refusal",
					stopDetails: {
						type: "refusal",
						category: "cyber",
						explanation: null,
					},
				},
			});
			return [
				model,
				await runQuery({
					marker,
					env: "bridge",
					model,
					prompt: `${marker} hi`,
				}),
			] as const;
		}),
	);
	return Object.fromEntries(runs);
});

// `[1m]`: the id and betas of every call of a tool round and a resumed turn.
await scenario("oneMillion", async () => {
	const marker = "[S:1m]";
	const first = await runQuery({
		marker,
		env: "bridge",
		model: "claude-opus-5-5[1m]",
		prompt: `${marker} LOOP1 read one`,
	});
	const second = await runQuery({
		marker,
		env: "bridge",
		model: "claude-opus-5-5[1m]",
		prompt: `${marker} next turn`,
		sessionId: first.sessionId,
		resume: true,
	});
	return { first, second };
});

// ---- Through the bridge: what the client sees. ----

const repo = memoryTurnRepo();
function makeBridge(
	name: string,
	limits: Partial<SdkBridgeLimits> = {},
	parkRepo?: SdkBridgeParkRepo,
): ClaudeSdkBridge {
	return createClaudeSdkBridge({
		...(parkRepo ? { parkRepo } : {}),
		dispatchInner: async (req, ctx) => {
			const requestId = crypto.randomUUID();
			ctx.onInnerRequestStarted?.(requestId);
			const res = await mock.handle(req);
			ctx.onInnerOutcome?.({
				requestId,
				status: res.status,
				errorType: null,
				message: null,
				retryAfter: res.headers.get("retry-after"),
				accountId: ctx.plan.preferredAccountId,
			});
			return res;
		},
		turnRepo: repo,
		workRoot: join(root, name),
		log: silentLog,
		limits: () => ({
			maxProcesses: 8,
			parkedTimeoutMs: 60_000,
			turnDeadlineMs: 120_000,
			...limits,
		}),
	});
}
const bridge = makeBridge("bridge");

function plan(model: string, account = "acct-a"): SdkBridgeRoutePlan {
	return {
		turnId: crypto.randomUUID(),
		routeSnapshot: null,
		candidates: [
			{ accountId: "acct-a", provider: "anthropic", upstreamModel: model },
			{ accountId: "acct-b", provider: "anthropic", upstreamModel: model },
		],
		preferredAccountId: account,
		apiKeyId: "key-1",
		apiKeyName: "key one",
	};
}

function meta(
	model: string,
	extra: Partial<SdkBridgeTurnMeta> = {},
): SdkBridgeTurnMeta {
	return {
		legId: crypto.randomUUID(),
		apiKeyId: "key-1",
		apiKeyName: "key one",
		clientHarness: "opencode",
		clientUserAgent: "opencode/test",
		project: "real-claude-context",
		projectAttributionSource: null,
		affinityScope: null,
		affinityKey: null,
		model,
		reasoningEffort: null,
		translationGaps: null,
		piPromptVersion: null,
		sideRequest: null,
		...extra,
	};
}

async function bridgedTurn(input: {
	model: string;
	messages: Msg[];
	account?: string;
	extra?: Partial<SdkBridgeTurnMeta>;
	marker: string;
	/** Answer this parked turn instead of starting one. */
	continues?: string;
	on?: ClaudeSdkBridge;
}) {
	const on = input.on ?? bridge;
	const p = plan(input.model, input.account);
	const turnId = input.continues ?? p.turnId;
	const request = new Request("http://bridge.test/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: input.model,
			stream: true,
			max_tokens: 1024,
			system: "You are a coding agent.",
			tools: [READ_TOOL],
			messages: input.messages,
		}),
	});
	const res = input.continues
		? await on.continueTurn({
				turnId,
				request,
				meta: meta(input.model, input.extra),
				signal: new AbortController().signal,
			})
		: await on.startTurn({
				request,
				plan: p,
				meta: meta(input.model, input.extra),
				signal: new AbortController().signal,
			});
	const headers = Object.fromEntries(res.headers.entries());
	const text = await res.text();
	const events = res.headers.get("content-type")?.includes("event-stream")
		? parseSse(text)
		: [];
	const start = events.find((e) => e.event === "message_start")?.data as
		| { message?: { model?: unknown } }
		| undefined;
	const delta = events.filter((e) => e.event === "message_delta").at(-1)
		?.data as { delta?: { stop_reason?: unknown } } | undefined;
	const errors = events.filter((e) => e.event === "error").map((e) => e.data);
	const stop = delta?.delta?.stop_reason ?? null;
	// A parked turn stays live until its results come.
	const until = Date.now() + 20_000;
	while (
		stop !== "tool_use" &&
		repo.turns.get(turnId)?.status === "running" &&
		Date.now() < until
	)
		await Bun.sleep(50);
	const row = repo.turns.get(turnId);
	return {
		turnId,
		status: res.status,
		headers,
		body: events.length ? null : text.slice(0, 600),
		replyModel: start?.message?.model ?? null,
		stop,
		content: events
			.filter((e) => e.event === "content_block_start")
			.map((e) => (e.data as { content_block?: Block }).content_block),
		text: events
			.filter((e) => e.event === "content_block_delta")
			.map((e) => (e.data as { delta?: { text?: string } }).delta?.text ?? "")
			.join(""),
		errors,
		row: row
			? {
					status: row.status,
					historyMode: row.historyMode,
					rebuildReason: row.rebuildReason,
					accountId: row.accountId,
					counters: row.counters,
				}
			: null,
		calls: mock.requests
			.filter(
				(r) => isModelCall(r) && JSON.stringify(r.body).includes(input.marker),
			)
			.map(describeCall),
	};
}

await scenario("bridged", async () => {
	const blockMarker = "[S:b-block]";
	rule(blockMarker, {
		when: ({ index }) => index === 0,
		shape: {
			usage: {
				input_tokens: 250_000,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	});
	const rcMarker = "[S:b-rc]";
	rule(rcMarker, {
		when: ({ index }) => index === 0,
		times: 1,
		fail: { status: 400, body: ANTHROPIC_PROMPT_TOO_LONG },
	});
	const refusals = await Promise.all(
		["claude-sonnet-5", "claude-fable-5-1", "claude-opus-5-5"].map(
			async (model) => {
				const marker = `[S:b-ref-${model}]`;
				rule(marker, {
					when: ({ index }) => index === 0,
					times: 1,
					shape: {
						stopReason: "refusal",
						stopDetails: {
							type: "refusal",
							category: "cyber",
							explanation: null,
						},
					},
				});
				return [
					model,
					await bridgedTurn({
						model,
						marker,
						messages: [{ role: "user", content: `${marker} hi` }],
					}),
				] as const;
			},
		),
	);
	const reportedMarker = "[S:b-reported]";
	rule(reportedMarker, { shape: { model: "claude-haiku-4-5" } });

	// The same conversation resumed on another account.
	const acMarker = "[S:b-acct]";
	const header = {
		affinityScope: "client_session" as const,
		affinityKey: `conv-${crypto.randomUUID()}`,
	};
	const history: Msg[] = [{ role: "user", content: `${acMarker} first` }];
	const acFirst = await bridgedTurn({
		model: MODEL,
		marker: acMarker,
		messages: history,
		extra: header,
	});
	history.push(
		{ role: "assistant", content: [{ type: "text", text: acFirst.text }] },
		{ role: "user", content: "second on another account" },
	);
	const acSecond = await bridgedTurn({
		model: MODEL,
		marker: acMarker,
		messages: history,
		extra: header,
		account: "acct-b",
	});

	const [blocking, reactive, reported] = await Promise.all([
		bridgedTurn({
			model: MODEL,
			marker: blockMarker,
			messages: [{ role: "user", content: `${blockMarker} LOOP1 read` }],
		}),
		bridgedTurn({
			model: MODEL,
			marker: rcMarker,
			messages: [
				{ role: "user", content: `${rcMarker} earlier question` },
				{ role: "assistant", content: [{ type: "text", text: "earlier" }] },
				{ role: "user", content: `${rcMarker} now this` },
			],
		}),
		bridgedTurn({
			model: MODEL,
			marker: reportedMarker,
			messages: [{ role: "user", content: `${reportedMarker} hi` }],
		}),
	]);
	// A 60 KB client tool result, answered live and replayed in a rebuild.
	const bigMarker = "[S:b-bigtool]";
	const bigStart = await bridgedTurn({
		model: MODEL,
		marker: bigMarker,
		messages: [{ role: "user", content: `${bigMarker} TOOL read` }],
	});
	const bigUse = (bigStart.content as Block[]).find(
		(b) => b?.type === "tool_use",
	);
	const bigLive = await bridgedTurn({
		model: MODEL,
		marker: bigMarker,
		continues: bigStart.turnId,
		messages: [
			{ role: "user", content: `${bigMarker} TOOL read` },
			{ role: "assistant", content: [bigUse as Block] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: String(bigUse?.id),
						content: bigText(60_000),
					},
				],
			},
		],
	});
	// A result past Claude Code's ceiling is refused, and the turn waits on.
	const hugeMarker = "[S:b-hugetool]";
	const hugeStart = await bridgedTurn({
		model: MODEL,
		marker: hugeMarker,
		messages: [{ role: "user", content: `${hugeMarker} TOOL read` }],
	});
	const hugeUse = (hugeStart.content as Block[]).find(
		(b) => b?.type === "tool_use",
	);
	const hugeRefused = await bridgedTurn({
		model: MODEL,
		marker: hugeMarker,
		continues: hugeStart.turnId,
		messages: [
			{ role: "user", content: `${hugeMarker} TOOL read` },
			{ role: "assistant", content: [hugeUse as Block] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: String(hugeUse?.id),
						content: bigText(600_000),
					},
				],
			},
		],
	});
	const hugeStillWaits =
		repo.turns.get(hugeStart.turnId)?.status === "running" &&
		bridge.findContinuation([String(hugeUse?.id)], {
			apiKeyId: "key-1",
			model: MODEL,
		}) !== null;
	const rebuildMarker = "[S:b-bigrebuild]";
	const bigRebuild = await bridgedTurn({
		model: MODEL,
		marker: rebuildMarker,
		messages: [
			{ role: "user", content: `${rebuildMarker} read it` },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_prior_1",
						name: "read",
						input: { path: "a" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_prior_1",
						content: bigText(60_000),
					},
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "read it" }] },
			{ role: "user", content: `${rebuildMarker} next question` },
		],
	});

	// The tool call reached the client; its result meets the blocking limit.
	const blockingUse = (blocking.content as Block[]).find(
		(b) => b?.type === "tool_use",
	);
	const blockingResult = await bridgedTurn({
		model: MODEL,
		marker: blockMarker,
		continues: blocking.turnId,
		messages: [
			{ role: "user", content: `${blockMarker} LOOP1 read` },
			{ role: "assistant", content: [blockingUse as Block] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: String(blockingUse?.id),
						content: "R",
					},
				],
			},
		],
	});
	return {
		bigLive,
		hugeRefused,
		hugeStillWaits,
		bigRebuild,
		blocking,
		blockingResult,
		reactive,
		refusal: Object.fromEntries(refusals),
		reported,
		accountChange: { first: acFirst, second: acSecond },
	};
});

// Results over Claude Code's 500,000-character persistence ceiling, in the
// paths that do not go through a parked MCP call: a history rebuilt as a
// transcript, a flattened one, a dead continuation and a released park.
await scenario("bigHistory", async () => {
	const big = bigText(600_000);
	// A 1M window, so the size alone never meets Claude Code's blocking limit.
	const model = "claude-opus-5-5[1m]";
	const toolTurn = (marker: string, id: string, name = "read"): Msg[] => [
		{ role: "user", content: `${marker} read it` },
		{
			role: "assistant",
			content: [{ type: "tool_use", id, name, input: { path: "a" } }],
		},
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: id, content: big }],
		},
	];
	const transcriptMarker = "[S:h-transcript]";
	const transcript = await bridgedTurn({
		model,
		marker: transcriptMarker,
		messages: [
			...toolTurn(transcriptMarker, "toolu_h_1"),
			{ role: "assistant", content: [{ type: "text", text: "read it" }] },
			{ role: "user", content: `${transcriptMarker} next` },
		],
	});
	// A call to a tool the turn does not offer makes the history ineligible
	// for a transcript.
	const flatMarker = "[S:h-flat]";
	const flattened = await bridgedTurn({
		model,
		marker: flatMarker,
		messages: [
			...toolTurn(flatMarker, "toolu_h_2", "gone"),
			{ role: "assistant", content: [{ type: "text", text: "read it" }] },
			{ role: "user", content: `${flatMarker} next` },
		],
	});
	const deadMarker = "[S:h-dead]";
	const dead = await bridgedTurn({
		model,
		marker: deadMarker,
		messages: toolTurn(deadMarker, "toolu_h_3"),
	});

	const parkRoot = "released";
	const released = makeBridge(
		parkRoot,
		{ maxProcesses: 2, parkReleaseMs: 500, releasedParkTtlMs: 600_000 },
		memoryParkRepo(repo.turns),
	);
	try {
		await released.ready();
		const parkMarker = "[S:h-park]";
		const history: Msg[] = [
			{ role: "user", content: `${parkMarker} TOOL read` },
		];
		const start = await bridgedTurn({
			model,
			marker: parkMarker,
			messages: history,
			on: released,
		});
		const use = (start.content as Block[]).find((b) => b?.type === "tool_use");
		const until = Date.now() + 20_000;
		while (
			repo.turns.get(start.turnId)?.status !== "released" &&
			Date.now() < until
		)
			await Bun.sleep(50);
		const statusBefore = repo.turns.get(start.turnId)?.status;
		const resumed = await bridgedTurn({
			model,
			marker: parkMarker,
			continues: start.turnId,
			on: released,
			messages: [
				...history,
				{ role: "assistant", content: [use as Block] },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: String(use?.id), content: big },
					],
				},
			],
		});
		return { transcript, flattened, dead, statusBefore, resumed };
	} finally {
		await released.dispose();
	}
});

// A result with an image and 600,000 characters of text, which Claude Code
// never previews: on the bridge's options, without its MAX_MCP_OUTPUT_TOKENS,
// and through the bridge, whose size check lets it through. A 1M model, so
// the size never meets the blocking limit.
await scenario("imageToolResult", async () => {
	const model = "claude-opus-5-5[1m]";
	const png =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const direct = await Promise.all(
		(["bridge", "mcpTokensDefault"] as EnvName[]).map(async (env) => {
			const marker = `[S:img-${env}]`;
			const r = await runQuery({
				marker,
				env,
				model,
				prompt: `${marker} TOOL read the picture`,
				toolContent: [
					{ type: "image", data: png, mimeType: "image/png" },
					{ type: "text", text: bigText(600_000) },
				],
			});
			return [env, r] as const;
		}),
	);
	const marker = "[S:b-img]";
	const start = await bridgedTurn({
		model,
		marker,
		messages: [{ role: "user", content: `${marker} TOOL read` }],
	});
	const use = (start.content as Block[]).find((b) => b?.type === "tool_use");
	const bridged = await bridgedTurn({
		model,
		marker,
		continues: start.turnId,
		messages: [
			{ role: "user", content: `${marker} TOOL read` },
			{ role: "assistant", content: [use as Block] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: String(use?.id),
						content: [
							{
								type: "image",
								source: { type: "base64", media_type: "image/png", data: png },
							},
							{ type: "text", text: bigText(600_000) },
						],
					},
				],
			},
		],
	});
	return { ...Object.fromEntries(direct), bridged };
});

// A refused turn, then the conversation's next turn with the client's
// history: the question, the refused answer as the client got it, and a new
// message.
await scenario("refusalThenResume", async () => {
	const marker = "[S:rr]";
	rule(marker, {
		when: ({ index }) => index === 0,
		times: 1,
		shape: {
			stopReason: "refusal",
			stopDetails: { type: "refusal", category: "cyber", explanation: null },
		},
	});
	const header = {
		affinityScope: "client_session" as const,
		affinityKey: `conv-${crypto.randomUUID()}`,
	};
	const history: Msg[] = [
		{ role: "user", content: `${marker} REFUSED-QUESTION` },
	];
	const refused = await bridgedTurn({
		model: MODEL,
		marker,
		messages: history,
		extra: header,
	});
	history.push(
		{ role: "assistant", content: [{ type: "text", text: refused.text }] },
		{ role: "user", content: `${marker} NEXT-QUESTION` },
	);
	const next = await bridgedTurn({
		model: MODEL,
		marker,
		messages: history,
		extra: header,
	});
	return { refused, next, clientHistory: history };
});

// A reply that ends with stop_reason refusal after a tool_use block: Claude
// Code starts the call, and nobody answers it. Then the conversation's next
// turn, whose history holds that reply.
await scenario("toolThenRefusal", async () => {
	const marker = "[S:tr]";
	rule(marker, {
		when: ({ index }) => index === 0,
		times: 1,
		shape: {
			stopReason: "refusal",
			stopDetails: { type: "refusal", category: "cyber", explanation: null },
		},
	});
	const header = {
		affinityScope: "client_session" as const,
		affinityKey: `conv-${crypto.randomUUID()}`,
	};
	const history: Msg[] = [{ role: "user", content: `${marker} TOOL read` }];
	const t0 = performance.now();
	const r = await bridgedTurn({
		model: MODEL,
		marker,
		messages: history,
		extra: header,
	});
	const until = Date.now() + 20_000;
	while (repo.turns.get(r.turnId)?.status === "running" && Date.now() < until)
		await Bun.sleep(50);
	const settled = {
		settledMs: Math.round(performance.now() - t0),
		status: repo.turns.get(r.turnId)?.status ?? null,
	};
	history.push(
		{ role: "assistant", content: r.content as Block[] },
		{ role: "user", content: `${marker} after the refusal` },
	);
	const next = await bridgedTurn({
		model: MODEL,
		marker,
		messages: history,
		extra: header,
	});
	return { reply: r, ...settled, next };
});

// Calls that carry no scenario marker: requests Claude Code makes on its own.
results.unmarked = mock.requests
	.filter((r) => !JSON.stringify(r.body).includes("[S:"))
	.map((r) => {
		const body = r.body as {
			model?: string;
			messages?: Msg[];
			max_tokens?: unknown;
		};
		return {
			path: r.path,
			model: body.model ?? null,
			status: r.status ?? null,
			session: r.headers["x-claude-code-session-id"] ?? null,
			maxTokens: body.max_tokens ?? null,
			text: JSON.stringify(body.messages?.at(-1) ?? null).slice(0, 300),
		};
	});

await bridge.dispose();
spawner.killAll("SIGKILL");
front.stop(true);
mock.stop();
rmSync(root, { recursive: true, force: true });
save();
process.exit(0);
