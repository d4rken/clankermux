/**
 * Runs the bundled Claude Code binary through the bridge against a loopback
 * mock upstream, and writes what happened to the JSON file named by argv[2].
 *
 * Only ever run inside a network namespace with nothing but loopback:
 *   unshare -rn sh -c 'ip link set lo up && bun real-claude-scenarios.ts out.json'
 * It refuses to start when 1.1.1.1 is reachable.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SdkBridgeCapacityError,
	type SdkBridgeRoutePlan,
	type SdkBridgeTurnMeta,
} from "@clankermux/types";
import { type ClaudeSdkBridge, createClaudeSdkBridge } from "../../bridge";
import { buildQueryOptions, workPaths } from "../../options";
import { PromptStream } from "../../prompt-stream";
import { FileSessionStore } from "../../session-store";
import { ProcessGroupSpawner, resolveClaudeExecutable } from "../../spawn";
import {
	createToolServer,
	loadMcpSdk,
	ParkedCalls,
	ToolNames,
} from "../../tool-server";
import type { SdkBridgeLimits, SdkBridgeParkRepo } from "../../types";
import { ensurePrivateDir } from "../../work-dirs";
import {
	foldReply,
	MODEL,
	memoryParkRepo,
	memoryTurnRepo,
	parseSse,
	READ_TOOL,
	silentLog,
} from "./fake-sdk";
import { startMockUpstream } from "./mock-upstream";
import { loadPiPromptFixture } from "./pi-prompt-fixtures";

type Block = { type: string; [key: string]: unknown };
type Msg = { role: "user" | "assistant"; content: string | Block[] };

const out = process.argv[2];
if (!out) throw new Error("usage: real-claude-scenarios.ts <out.json>");

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

function childPids(): number[] {
	try {
		return execFileSync("pgrep", ["-P", String(process.pid)])
			.toString()
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(Number);
	} catch {
		return [];
	}
}

function memory(pid: number): { rss: number; hwm: number } | null {
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const kb = (key: string) =>
			Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0);
		return { rss: kb("VmRSS") * 1024, hwm: kb("VmHWM") * 1024 };
	} catch {
		return null;
	}
}

/** Every file under `dir`, relative, without following symlinks. */
function filesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (path: string, rel: string) => {
		let names: string[] = [];
		try {
			names = readdirSync(path);
		} catch {
			return;
		}
		for (const name of names) {
			const child = join(path, name);
			if (lstatSync(child).isDirectory()) walk(child, `${rel}${name}/`);
			else out.push(`${rel}${name}`);
		}
	};
	walk(dir, "");
	return out;
}

const mock = startMockUpstream();
const repo = memoryTurnRepo();
const workRoot = mkdtempSync(join(tmpdir(), "sdk-bridge-real-"));

// What an earlier bridge process left behind: its owner is long gone.
const staleGeneration = join(workRoot, "gen-earlier-process");
mkdirSync(join(staleGeneration, "claude-config", "projects", "-cwd"), {
	recursive: true,
});
writeFileSync(
	join(staleGeneration, "claude-config", "projects", "-cwd", "old.jsonl"),
	"{}\n",
);
writeFileSync(
	join(staleGeneration, "owner.json"),
	JSON.stringify({ pid: 2 ** 22 + 7, startTime: null }),
);

function makeBridge(
	limits: Partial<SdkBridgeLimits>,
	root: string = workRoot,
	parkRepo?: SdkBridgeParkRepo,
): ClaudeSdkBridge {
	return createClaudeSdkBridge({
		...(parkRepo ? { parkRepo } : {}),
		dispatchInner: async (req, ctx) => {
			const requestId = crypto.randomUUID();
			// As the proxy does: the row begins, then the call ends.
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
		workRoot: root,
		log: silentLog,
		limits: () => limits,
	});
}

const bridge = makeBridge({
	maxProcesses: 4,
	parkedTimeoutMs: 60_000,
	turnDeadlineMs: 120_000,
});
results.availability = bridge.availability();
results.staleGenerationRemoved = !existsSync(staleGeneration);

function plan(): SdkBridgeRoutePlan {
	return {
		turnId: crypto.randomUUID(),
		routeSnapshot: null,
		candidates: [
			{ accountId: "acct-a", provider: "anthropic", upstreamModel: MODEL },
		],
		preferredAccountId: "acct-a",
		apiKeyId: "key-1",
		apiKeyName: "key one",
	};
}

function meta(extra: Partial<SdkBridgeTurnMeta> = {}): SdkBridgeTurnMeta {
	return {
		legId: crypto.randomUUID(),
		apiKeyId: "key-1",
		apiKeyName: "key one",
		clientHarness: "opencode",
		clientUserAgent: "opencode/test",
		project: "real-claude",
		projectAttributionSource: null,
		affinityScope: null,
		affinityKey: null,
		model: MODEL,
		reasoningEffort: null,
		translationGaps: null,
		piPromptVersion: null,
		sideRequest: null,
		...extra,
	};
}

function request(
	messages: Msg[],
	tools = [READ_TOOL],
	fields: Record<string, unknown> = { max_tokens: 1024 },
) {
	return new Request("http://bridge.test/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			stream: true,
			system: "You are pi, a coding agent.",
			tools,
			messages,
			...fields,
		}),
	});
}

interface Reply {
	status: number;
	ms: number;
	body?: unknown;
	content?: Block[];
	stop?: unknown;
	errors?: unknown[];
}

async function read(response: Promise<Response>): Promise<Reply> {
	const t0 = performance.now();
	// A capacity refusal is thrown for the proxy to fail over on; with no
	// other candidate, its terminal response is what the client gets.
	const res = await response.catch((error: unknown) => {
		if (error instanceof SdkBridgeCapacityError)
			return error.terminalResponse();
		throw error;
	});
	if (!res.headers.get("content-type")?.includes("event-stream"))
		return {
			status: res.status,
			body: await res.json(),
			ms: Math.round(performance.now() - t0),
		};
	const reply = foldReply(parseSse(await res.text()));
	return {
		status: res.status,
		...reply,
		ms: Math.round(performance.now() - t0),
	};
}

async function turn(
	messages: Msg[],
	extra: Partial<SdkBridgeTurnMeta> = {},
	signal?: AbortSignal,
	on: ClaudeSdkBridge = bridge,
) {
	const p = plan();
	const m = meta(extra);
	const r = await read(
		on.startTurn({
			request: request(messages),
			plan: p,
			meta: m,
			signal: signal ?? new AbortController().signal,
		}),
	);
	return { ...r, turnId: p.turnId };
}

async function answer(
	turnId: string,
	messages: Msg[],
	on: ClaudeSdkBridge = bridge,
) {
	return read(
		on.continueTurn({
			turnId,
			request: request(messages),
			meta: meta(),
			signal: new AbortController().signal,
		}),
	);
}

async function settled(on: ClaudeSdkBridge = bridge) {
	const until = Date.now() + 20_000;
	while (on.status().live > 0 && Date.now() < until) await Bun.sleep(50);
}

/** Session transcripts on disk under the work root, Claude Code's own included. */
const transcriptsOnDisk = () =>
	filesUnder(workRoot).filter((f) => f.endsWith(".jsonl"));

const lastUpstreamMessages = () =>
	(
		mock.requests.filter((r) => r.path.startsWith("/v1/messages")).at(-1)
			?.body as { messages?: unknown[] }
	)?.messages ?? [];

type Shape = { role: string; blocks: Array<[string, string | null, string]> };

function blockText(b: Block): string {
	if (typeof b.content === "string") return b.content;
	if (Array.isArray(b.content))
		return (b.content as Block[])
			.filter((c) => c.type === "text")
			.map((c) => String(c.text))
			.join("");
	return typeof b.text === "string" ? b.text : "";
}

function shape(m: Msg): Shape {
	const blocks =
		typeof m.content === "string"
			? [{ type: "text", text: m.content } as Block]
			: m.content;
	return {
		role: m.role,
		blocks: blocks.map((b) => [
			b.type,
			typeof b.tool_use_id === "string" ? b.tool_use_id : null,
			blockText(b),
		]),
	};
}

/** A model request's messages. */
const messagesOf = (q: { body: unknown } | undefined): Msg[] =>
	(q?.body as { messages?: Msg[] } | undefined)?.messages ?? [];

/** Every tool_result block answering `id` in `messages`, as its text. */
const resultTexts = (messages: Msg[], id: string): string[] =>
	messages
		.flatMap((m) => shape(m).blocks)
		.filter(([type, useId]) => type === "tool_result" && useId === id)
		.map(([, , text]) => text);

/** The messages of a JSONL transcript's user and assistant entries. */
const transcriptMessages = (text: string): Msg[] =>
	text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { message?: Msg })
		.flatMap((e) =>
			e.message && typeof e.message === "object" && "content" in e.message
				? [{ role: e.message.role, content: e.message.content }]
				: [],
		);

/** tool_result blocks with empty content in a JSONL transcript. */
const emptyResults = (text: string): number =>
	transcriptMessages(text)
		.flatMap((m) => (typeof m.content === "string" ? [] : m.content))
		.filter(
			(b) =>
				b.type === "tool_result" &&
				(b.content === "" ||
					b.content === undefined ||
					(Array.isArray(b.content) && b.content.length === 0)),
		).length;

async function scenario(name: string, run: () => Promise<unknown>) {
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

await scenario("plain", async () => {
	const r = await turn([{ role: "user", content: "hello plain" }]);
	await settled();
	// Claude Code's own copy goes a moment after its process exits.
	await Bun.sleep(3_000);
	const transcriptsAfter = transcriptsOnDisk();
	const row = repo.turns.get(r.turnId);
	const upstream = mock.requests.find((q) => q.path.startsWith("/v1/messages"));
	return {
		reply: r,
		transcriptsAfter,
		innerCounters: row?.counters,
		turnStatus: row?.status,
		historyMode: row?.historyMode,
		upstreamUserAgent: upstream?.headers["user-agent"],
		upstreamAuthorization:
			upstream?.headers.authorization ?? upstream?.headers["x-api-key"] ?? null,
		upstreamSystemMentionsPi: JSON.stringify(
			(upstream?.body as { system?: unknown })?.system ?? "",
		).includes("You are pi"),
		upstreamTools: (
			(upstream?.body as { tools?: Array<{ name: string }> })?.tools ?? []
		).map((t) => t.name),
		upstreamMentionsGitStatus: JSON.stringify(upstream?.body ?? "").includes(
			"gitStatus",
		),
		upstreamThinking:
			(upstream?.body as { thinking?: unknown })?.thinking ?? null,
	};
});

await scenario("toolRoundTrip", async () => {
	const history: Msg[] = [{ role: "user", content: "TOOL read a.txt" }];
	const r1 = await turn(history);
	const tu = (r1.content as Block[] | undefined)?.find(
		(b) => b.type === "tool_use",
	);
	const parkedWhileWaiting = bridge.status().parked;
	const pids = childPids();
	const mem = pids.map((pid) => memory(pid));
	history.push({ role: "assistant", content: r1.content as Block[] });
	history.push({
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: String(tu?.id),
				content: "CONTENT-A",
			},
		],
	});
	const r2 = await answer(r1.turnId, history);
	await settled();
	return {
		r1,
		r2,
		parkedWhileWaiting,
		childMemory: mem,
		turn: {
			...repo.turns.get(r1.turnId),
			legs: repo.turns.get(r1.turnId)?.legs,
		},
	};
});

await scenario("parallelTools", async () => {
	const history: Msg[] = [{ role: "user", content: "PARALLEL read both" }];
	const r1 = await turn(history);
	const uses = ((r1.content as Block[] | undefined) ?? []).filter(
		(b) => b.type === "tool_use",
	);
	history.push({ role: "assistant", content: r1.content as Block[] });
	history.push({
		role: "user",
		content: uses.map((u, i) => ({
			type: "tool_result",
			tool_use_id: String(u.id),
			content: `P${i}`,
		})),
	});
	const r2 = await answer(r1.turnId, history);
	await settled();
	return { toolUses: uses.length, r1Stop: r1.stop, r2 };
});

await scenario("longToolName", async () => {
	// The longest name a client may send; prefixed as is it would be 72.
	const tool = { ...READ_TOOL, name: `${"x".repeat(60)}read` };
	const from = mock.requests.length;
	const history: Msg[] = [{ role: "user", content: "TOOL read a.txt" }];
	const p = plan();
	const r1 = await read(
		bridge.startTurn({
			request: request(history, [tool]),
			plan: p,
			meta: meta(),
			signal: new AbortController().signal,
		}),
	);
	const tu = (r1.content ?? []).find((b) => b.type === "tool_use");
	history.push({ role: "assistant", content: r1.content as Block[] });
	history.push({
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: String(tu?.id), content: "LONG" },
		],
	});
	const r2 = await read(
		bridge.continueTurn({
			turnId: p.turnId,
			request: request(history, [tool]),
			meta: meta(),
			signal: new AbortController().signal,
		}),
	);
	await settled();
	return {
		clientName: tool.name,
		r1,
		r2,
		upstream: mock.requests.slice(from).map((q) => ({
			status: q.status ?? null,
			tools: ((q.body as { tools?: Array<{ name: string }> })?.tools ?? []).map(
				(t) => t.name,
			),
		})),
	};
});

await scenario("outputLimit", async () => {
	const sentMaxTokens = async (
		fields: Record<string, unknown>,
		text: string,
	) => {
		const from = mock.requests.length;
		const p = plan();
		const reply = await read(
			bridge.startTurn({
				request: request(
					[{ role: "user", content: text }],
					[READ_TOOL],
					fields,
				),
				plan: p,
				meta: meta(),
				signal: new AbortController().signal,
			}),
		);
		await settled();
		return {
			reply,
			upstream: mock.requests.slice(from).map((q) => ({
				status: q.status ?? null,
				maxTokens: (q.body as { max_tokens?: unknown })?.max_tokens ?? null,
			})),
		};
	};
	return {
		client321: await sentMaxTokens({ max_tokens: 321 }, "limit 321"),
		clientNone: await sentMaxTokens({}, "no limit"),
		client200000: await sentMaxTokens({ max_tokens: 200_000 }, "limit 200000"),
		// The model stops at the client's limit: what Claude Code does next.
		stopAtLimit: await sentMaxTokens({ max_tokens: 64 }, "MAXTOK stop at 64"),
	};
});

await scenario("resumeWithHeader", async () => {
	const header = {
		affinityScope: "client_session" as const,
		affinityKey: `conv-${crypto.randomUUID()}`,
	};
	const history: Msg[] = [{ role: "user", content: "hello resume" }];
	const r1 = await turn(history, header);
	history.push(
		{ role: "assistant", content: r1.content as Block[] },
		{ role: "user", content: "second turn" },
	);
	const r2 = await turn(history, header);
	await settled();
	const row = repo.turns.get(r2.turnId);
	const sent = JSON.stringify(lastUpstreamMessages());
	return {
		r1Stop: r1.stop,
		r2,
		historyMode: row?.historyMode,
		upstreamCarriesFirstTurn:
			sent.includes("hello resume") && sent.includes("echo:"),
		upstreamCarriesSecondTurn: sent.includes("second turn"),
	};
});

await scenario("sideRequestFork", async () => {
	const calls = () =>
		mock.requests.filter((q) => q.path.startsWith("/v1/messages"));
	const start = async (
		messages: Msg[],
		tools: unknown[],
		extra: Partial<SdkBridgeTurnMeta>,
		fields: Record<string, unknown> = { max_tokens: 1024 },
	) => {
		const p = plan();
		const from = calls().length;
		const r = await read(
			bridge.startTurn({
				request: request(messages, tools as (typeof READ_TOOL)[], fields),
				plan: p,
				meta: meta(extra),
				signal: new AbortController().signal,
			}),
		);
		await settled();
		const row = repo.turns.get(p.turnId);
		const sent = calls().slice(from);
		return {
			reply: r,
			turnId: p.turnId,
			row: {
				kind: row?.kind,
				status: row?.status,
				historyMode: row?.historyMode,
				ccSessionId: row?.ccSessionId,
			},
			upstream: sent.map((q) => {
				const body = q.body as {
					tools?: Array<{ name: string }>;
					messages?: unknown[];
				};
				return {
					status: q.status,
					cacheRead: q.cache?.read ?? null,
					tools: (body.tools ?? []).map((t) => t.name),
					text: JSON.stringify(body.messages ?? []),
				};
			}),
		};
	};
	const recapFields = { max_tokens: 256, tool_choice: { type: "none" } };

	// A conversation without client tools: the copy's prompt is the
	// session's, plus the new message.
	const header = {
		affinityScope: "client_session" as const,
		affinityKey: `conv-${crypto.randomUUID()}`,
	};
	const history: Msg[] = [{ role: "user", content: "hello fork" }];
	const first = await start(history, [], header);
	history.push({ role: "assistant", content: first.reply.content as Block[] });
	const side = await start(
		[...history, { role: "user", content: "RECAP the session" }],
		[],
		{ ...header, sideRequest: "session-fork-v1" },
		recapFields,
	);
	history.push({ role: "user", content: "second main turn" });
	const next = await start(history, [], header);

	// With client tools and a tool round: the copy has the same tools.
	const toolHeader = {
		affinityScope: "client_session" as const,
		affinityKey: `conv-${crypto.randomUUID()}`,
	};
	const toolHistory: Msg[] = [{ role: "user", content: "TOOL read a.txt" }];
	const p1 = plan();
	const r1 = await read(
		bridge.startTurn({
			request: request(toolHistory),
			plan: p1,
			meta: meta(toolHeader),
			signal: new AbortController().signal,
		}),
	);
	const tu = (r1.content ?? []).find((b) => b.type === "tool_use");
	toolHistory.push(
		{ role: "assistant", content: r1.content as Block[] },
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: String(tu?.id), content: "FORK-A" },
			],
		},
	);
	const r2 = await answer(p1.turnId, toolHistory);
	await settled();
	toolHistory.push({ role: "assistant", content: r2.content as Block[] });
	const toolSide = await start(
		[...toolHistory, { role: "user", content: "RECAP the tool session" }],
		[READ_TOOL],
		{ ...toolHeader, sideRequest: "session-fork-v1" },
		recapFields,
	);
	// The model calls a tool anyway: after text, and with nothing else.
	const textThenCall = await start(
		[...toolHistory, { role: "user", content: "SAYTOOL recap" }],
		[READ_TOOL],
		{ ...toolHeader, sideRequest: "session-fork-v1" },
		recapFields,
	);
	const onlyCall = await start(
		[...toolHistory, { role: "user", content: "TOOL recap" }],
		[READ_TOOL],
		{ ...toolHeader, sideRequest: "session-fork-v1" },
		recapFields,
	);
	// A max_tokens stop ends the copy's reply; no recovery call goes out.
	const cutOff = await start(
		[...toolHistory, { role: "user", content: "MAXTOK recap" }],
		[READ_TOOL],
		{ ...toolHeader, sideRequest: "session-fork-v1" },
		recapFields,
	);
	toolHistory.push({ role: "user", content: "third main turn" });
	const toolNext = await start(toolHistory, [READ_TOOL], toolHeader);

	await Bun.sleep(3_000);
	const onDisk = transcriptsOnDisk();
	const forks = [side, toolSide, textThenCall, onlyCall, cutOff].map((t) =>
		String(t.row.ccSessionId),
	);
	return {
		first: first.row,
		firstCacheWrite: first.upstream,
		side,
		next,
		toolSide,
		textThenCall,
		onlyCall,
		cutOff,
		toolNext,
		forksLeft: onDisk.filter((f) => forks.some((id) => f.includes(id))),
	};
});

await scenario("rebuildWithoutHeader", async () => {
	const history: Msg[] = [
		{ role: "user", content: "REBUILD-FIRST question" },
		{
			role: "assistant",
			content: [{ type: "text", text: "REBUILD-FIRST answer" }],
		},
		{ role: "user", content: "REBUILD-SECOND question" },
	];
	const r = await turn(history);
	await settled();
	const row = repo.turns.get(r.turnId);
	const sent = lastUpstreamMessages() as Array<{
		role: string;
		content: unknown;
	}>;
	return {
		reply: r,
		historyMode: row?.historyMode,
		rebuildReason: row?.rebuildReason,
		upstreamRoles: sent.map((m) => m.role),
		upstreamCarriesHistory: JSON.stringify(sent).includes(
			"REBUILD-FIRST answer",
		),
	};
});

await scenario("abortCleanup", async () => {
	const before = childPids();
	const controller = new AbortController();
	const pending = turn(
		[{ role: "user", content: "SLOW hello" }],
		{},
		controller.signal,
	).catch((e) => ({
		error: String(e),
	}));
	// Abort once Claude Code's model call is waiting on the slow answer. A
	// fixed delay raced process start-up under a loaded full-suite run and
	// aborted before any upstream call existed.
	const from = mock.requests.length;
	const t = performance.now();
	while (
		!mock.requests
			.slice(from)
			.some((q) => /SLOW hello/.test(JSON.stringify(q.body))) &&
		performance.now() - t < 30_000
	)
		await Bun.sleep(50);
	await Bun.sleep(300);
	const during = childPids();
	controller.abort();
	await pending;
	const t0 = performance.now();
	let after = childPids();
	while (after.length > before.length && performance.now() - t0 < 10_000) {
		await Bun.sleep(100);
		after = childPids();
	}
	await settled();
	const slow = mock.requests.filter((q) => q.abortedAfterMs !== undefined);
	return {
		before: before.length,
		during: during.length,
		after: after.length,
		exitMs: Math.round(performance.now() - t0),
		upstreamAborted: slow.length > 0,
		live: bridge.status().live,
	};
});

await scenario("textWithToolResults", async () => {
	const history: Msg[] = [{ role: "user", content: "TOOL read a.txt" }];
	const r1 = await turn(history);
	const tu = (r1.content ?? []).find((b) => b.type === "tool_use");
	history.push({ role: "assistant", content: r1.content as Block[] });
	history.push({
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: String(tu?.id), content: "TXT-A" },
			{ type: "text", text: "ALSO-TYPED-BY-USER" },
		],
	});
	const from = mock.requests.length;
	const r2 = await answer(r1.turnId, history);
	await settled();
	const upstream = mock.requests
		.slice(from)
		.filter((q) => q.path.startsWith("/v1/messages"));
	const carrying = upstream.filter((q) =>
		JSON.stringify(q.body).includes("ALSO-TYPED-BY-USER"),
	);
	const last = (carrying.at(-1)?.body as { messages?: Msg[] })?.messages ?? [];
	return {
		r2,
		upstreamCalls: upstream.length,
		textReachedUpstream: carrying.length > 0,
		// The result is in the conversation before the text, never after it.
		resultBeforeText: (() => {
			const text = JSON.stringify(last);
			return (
				text.indexOf("TXT-A") >= 0 &&
				text.indexOf("TXT-A") < text.indexOf("ALSO-TYPED-BY-USER")
			);
		})(),
		turn: repo.turns.get(r1.turnId)?.status,
	};
});

await scenario("deadContinuation", async () => {
	// A bridge whose parked calls time out fast, so the query is gone by the
	// time the results come; the same holds after a restart.
	const shortLived = makeBridge({
		maxProcesses: 2,
		parkedTimeoutMs: 1_500,
		turnDeadlineMs: 120_000,
	});
	try {
		const history: Msg[] = [{ role: "user", content: "TOOL read dead.txt" }];
		const r1 = await turn(history, {}, undefined, shortLived);
		const tu = (r1.content ?? []).find((b) => b.type === "tool_use");
		await settled(shortLived);
		const firstStatus = repo.turns.get(r1.turnId)?.status;
		history.push({ role: "assistant", content: r1.content as Block[] });
		history.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: String(tu?.id),
					content: "DEAD-RESULT",
				},
			],
		});
		// What the proxy does with results no live query waits on: a start.
		const continued = shortLived.findContinuation([String(tu?.id)], {
			apiKeyId: "key-1",
			model: MODEL,
		});
		const from = mock.requests.length;
		const r2 = await turn(history, {}, undefined, shortLived);
		await settled(shortLived);
		const sent = (
			mock.requests.slice(from).find((q) => q.path.startsWith("/v1/messages"))
				?.body as {
				messages?: Array<{ role: string; content: unknown }>;
			}
		)?.messages;
		const row = repo.turns.get(r2.turnId);
		const lastUser = JSON.stringify(
			sent?.filter((m) => m.role === "user").at(-1) ?? null,
		);
		return {
			firstStatus,
			continued,
			r2,
			historyMode: row?.historyMode,
			rebuildReason: row?.rebuildReason,
			turnStatus: row?.status,
			// One user message: the framed history, the call, then its result.
			upstreamCarriesCall: lastUser.includes(`id=${String(tu?.id)}`),
			upstreamCarriesResult: lastUser.includes("DEAD-RESULT"),
			upstreamHasToolResultBlock: JSON.stringify(sent ?? []).includes(
				'"tool_result"',
			),
		};
	} finally {
		await shortLived.dispose();
	}
});

await scenario("releasedParkResume", async () => {
	// What release-then-resume relies on, driven on the SDK directly: the
	// bridge's options, tool server and session store, no bridge around them.
	const exe = resolveClaudeExecutable();
	if ("error" in exe) throw new Error(exe.error);
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	const mcp = await loadMcpSdk();
	const root = mkdtempSync(join(tmpdir(), "sdk-bridge-release-"));
	const paths = workPaths(root);
	for (const dir of Object.values(paths)) ensurePrivateDir(dir);
	const store = new FileSessionStore(paths.sessions);
	const spawner = new ProcessGroupSpawner();
	const names = new ToolNames([READ_TOOL.name]);
	// Only model calls reach the shared mock, as through the bridge's listener.
	const front = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/messages"
				? mock.handle(req)
				: new Response(null, { status: 404 }),
	});
	type Entry = Record<string, unknown> & { type: string; uuid?: string };
	const entries = (id: string) => (store.read(id) ?? []) as Entry[];
	const toolUseIds = (e: Entry): string[] => {
		if (e.type !== "assistant") return [];
		const content = (e.message as { content?: unknown } | undefined)?.content;
		return Array.isArray(content)
			? (content as Block[])
					.filter((b) => b.type === "tool_use")
					.map((b) => String(b.id))
			: [];
	};

	const run = (
		sessionId: string,
		resume: boolean,
		content: string | Block[],
		extra: Record<string, unknown> = {},
	) => {
		const parked = new ParkedCalls();
		const prompt = new PromptStream();
		prompt.push(content);
		const pids = new Set<number>();
		const q = query({
			prompt,
			options: {
				...buildQueryOptions({
					paths,
					baseUrl: `http://127.0.0.1:${front.port}`,
					token: crypto.randomUUID(),
					model: MODEL,
					toolNames: names.exposed,
					toolServer: createToolServer(mcp, [READ_TOOL], names, (id) =>
						parked.wait(id),
					),
					systemPrompt: { append: null, excludeDynamicSections: false },
					effort: null,
					maxOutputTokens: 1024,
					sessionId,
					resume,
					sessionStore: store,
					executablePath: exe.path,
					spawn: (o) => spawner.spawn(o, (pid) => pids.add(pid)),
					stderr: () => {},
					abortController: new AbortController(),
				}),
				...extra,
			},
		});
		const assistants: Array<{ uuid: string; content: Block[] }> = [];
		let result: { subtype: string; errors?: string[]; result?: string } | null =
			null;
		const done = (async () => {
			try {
				for await (const m of q) {
					if (m.type === "assistant")
						assistants.push({
							uuid: m.uuid,
							content: m.message.content as unknown as Block[],
						});
					if (m.type === "result") {
						result = m as never;
						prompt.end();
					}
				}
			} catch {}
		})();
		return { parked, pids, assistants, done, result: () => result };
	};
	const lastCall = (from: number) =>
		mock.requests
			.slice(from)
			.filter((r) => r.path.startsWith("/v1/messages"))
			.at(-1);
	const resumeWith = async (
		sessionId: string,
		content: string | Block[],
		extra: Record<string, unknown> = {},
	) => {
		const from = mock.requests.length;
		const leg = run(sessionId, true, content, extra);
		await Promise.race([leg.done, Bun.sleep(60_000)]);
		const call = lastCall(from);
		return {
			result: leg.result(),
			reply: leg.assistants.at(-1)?.content ?? null,
			cache: call?.cache ?? null,
			messages: (call?.body as { messages?: Msg[] } | undefined)?.messages,
		};
	};

	try {
		// A turn parked on two calls, after a signed thinking block.
		const released = crypto.randomUUID();
		const from = mock.requests.length;
		const first = run(released, false, "THINK PARALLEL read both");
		const ids = () =>
			first.assistants.flatMap((a) =>
				a.content.filter((b) => b.type === "tool_use").map((b) => String(b.id)),
			);
		const stored = () =>
			new Set(entries(released).flatMap((e) => toolUseIds(e)));
		const t0 = performance.now();
		// Claude Code runs MCP calls one at a time: only the first one parks.
		while (
			!(
				first.parked.size > 0 &&
				ids().length === 2 &&
				ids().every((id) => stored().has(id))
			) &&
			performance.now() - t0 < 30_000
		)
			await Bun.sleep(25);
		const firstCall = lastCall(from);
		const resumeAt = first.assistants.at(-1)?.uuid ?? "";
		// Release: the parked call is never answered, and nothing is interrupted.
		const before = entries(released).length;
		for (const pid of first.pids) spawner.kill(pid, "SIGTERM");
		await Promise.race([first.done, Bun.sleep(10_000)]);
		const results: Block[] = [
			{
				type: "tool_result",
				tool_use_id: ids()[0],
				content: [
					{ type: "text", text: "RELEASED-A" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
						},
					},
				],
			},
			{ type: "tool_result", tool_use_id: ids()[1], content: "RELEASED-B" },
			{ type: "text", text: "TYPED-WITH-RESULTS" },
		];
		const copy = () => {
			const id = crypto.randomUUID();
			if (!store.fork(released, id)) throw new Error("fork failed");
			return id;
		};

		const plain = await resumeWith(copy(), results);
		const resumedId = copy();
		const resumed = await resumeWith(resumedId, results, {
			resumeSessionAt: resumeAt,
		});
		const next = await resumeWith(resumedId, "NEXT after release");
		const unknownPoint = await resumeWith(copy(), results, {
			resumeSessionAt: crypto.randomUUID(),
		});
		return {
			toolUseIds: ids(),
			resumeAtIsStoredEntry:
				entries(released).find((e) => e.uuid === resumeAt) !== undefined,
			addedByRelease: entries(released)
				.slice(before)
				.map((e) => e.type),
			firstCallCacheCreation: firstCall?.cache?.creation ?? null,
			plain,
			resumed,
			next,
			unknownPoint: unknownPoint.result,
		};
	} finally {
		spawner.killAll("SIGKILL");
		front.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});

await scenario("releaseThenResume", async () => {
	// Released parks live under their own work root: one owner per directory.
	const root = mkdtempSync(join(tmpdir(), "sdk-bridge-released-"));
	const parkRepo = memoryParkRepo(repo.turns);
	const releaseLimits: Partial<SdkBridgeLimits> = {
		maxProcesses: 2,
		parkReleaseMs: 500,
		parkedTimeoutMs: 60_000,
		turnDeadlineMs: 120_000,
		releasedParkTtlMs: 600_000,
	};
	const calls = () =>
		mock.requests.filter((q) => q.path.startsWith("/v1/messages"));
	const whenReleased = async (turnId: string) => {
		const until = Date.now() + 20_000;
		while (repo.turns.get(turnId)?.status !== "released" && Date.now() < until)
			await Bun.sleep(50);
		return repo.turns.get(turnId)?.status;
	};
	const shape = (q: (typeof mock.requests)[number] | undefined) => {
		const messages = (q?.body as { messages?: Msg[] } | undefined)?.messages;
		return {
			cacheRead: q?.cache?.read ?? null,
			text: JSON.stringify(messages ?? []),
			tail: (messages ?? []).slice(-2).map((m) => ({
				role: m.role,
				blocks: (typeof m.content === "string"
					? [{ type: "text" }]
					: m.content
				).map((b) => [
					b.type,
					b.tool_use_id ?? b.id ?? null,
					Array.isArray(b.content)
						? (b.content as Block[]).map((c) => c.type)
						: typeof b.signature === "string",
				]),
			})),
		};
	};
	let a: ClaudeSdkBridge | null = makeBridge(releaseLimits, root, parkRepo);
	let b: ClaudeSdkBridge | null = null;
	try {
		await a.ready();
		// In process: released after the park, resumed by the results.
		const h1: Msg[] = [{ role: "user", content: "TOOL read released.txt" }];
		const first = calls().length;
		const r1 = await turn(h1, {}, undefined, a);
		const firstCall = calls()[first];
		const tu = (r1.content ?? []).find((x) => x.type === "tool_use");
		const statusAfterPark = await whenReleased(r1.turnId);
		const childrenWhileReleased = childPids().length;
		h1.push(
			{ role: "assistant", content: r1.content as Block[] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: String(tu?.id),
						content: "RELEASED-RESULT",
					},
				],
			},
		);
		const from = calls().length;
		const r2 = await answer(r1.turnId, h1, a);
		await settled(a);
		const inProcess = {
			r1Stop: r1.stop,
			statusAfterPark,
			childrenWhileReleased,
			r2,
			turnStatus: repo.turns.get(r1.turnId)?.status,
			firstCacheCreation: firstCall?.cache?.creation ?? null,
			resumed: shape(calls().slice(from).at(0)),
		};

		// Across a restart: released, the bridge disposed, a new one on the
		// same work root and repositories resumes it.
		const h2: Msg[] = [{ role: "user", content: "THINK PARALLEL read both" }];
		const second = calls().length;
		const p = await turn(h2, {}, undefined, a);
		const secondCall = calls()[second];
		const uses = (p.content ?? []).filter((x) => x.type === "tool_use");
		const statusBeforeRestart = await whenReleased(p.turnId);
		await a.dispose();
		a = null;
		b = makeBridge(releaseLimits, root, parkRepo);
		await b.ready();
		const recovered = b.status().releasedParks;
		const found = b.findContinuation(
			uses.map((u) => String(u.id)),
			{ apiKeyId: "key-1", model: MODEL },
		);
		h2.push(
			{ role: "assistant", content: p.content as Block[] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: String(uses[0]?.id),
						content: [
							{ type: "text", text: "RESTART-A" },
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
								},
							},
						],
					},
					{
						type: "tool_result",
						tool_use_id: String(uses[1]?.id),
						content: "RESTART-B",
					},
					{ type: "text", text: "TYPED-AFTER-RESTART" },
				],
			},
		);
		const from2 = calls().length;
		const r3 = await answer(p.turnId, h2, b);
		await settled(b);
		return {
			inProcess,
			restart: {
				stop: p.stop,
				toolUses: uses.length,
				statusBeforeRestart,
				recovered,
				found,
				r3,
				turnStatus: repo.turns.get(p.turnId)?.status,
				firstCacheCreation: secondCall?.cache?.creation ?? null,
				resumed: shape(calls().slice(from2).at(0)),
				parksLeft: parkRepo.parks.size,
				filesLeft: filesUnder(join(root, "released-parks")).filter((f) =>
					f.endsWith(".jsonl"),
				),
			},
		};
	} finally {
		await a?.dispose();
		await b?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

await scenario("releasedParkOfResumedSession", async () => {
	// Parks whose calls follow a prompt Claude Code wrote nothing after: any
	// turn that resumes a stored session, and a call with text before it.
	const root = mkdtempSync(join(tmpdir(), "sdk-bridge-released-resumed-"));
	const parkRepo = memoryParkRepo(repo.turns);
	const releaseLimits: Partial<SdkBridgeLimits> = {
		maxProcesses: 2,
		parkReleaseMs: 500,
		parkedTimeoutMs: 60_000,
		turnDeadlineMs: 120_000,
		releasedParkTtlMs: 600_000,
	};
	const calls = () =>
		mock.requests.filter((q) => q.path.startsWith("/v1/messages"));
	const whenReleased = async (turnId: string) => {
		const until = Date.now() + 20_000;
		while (repo.turns.get(turnId)?.status !== "released" && Date.now() < until)
			await Bun.sleep(50);
		return repo.turns.get(turnId)?.status;
	};
	const header = () => ({
		affinityScope: "client_session" as const,
		affinityKey: `conv-${crypto.randomUUID()}`,
	});
	let a: ClaudeSdkBridge = makeBridge(releaseLimits, root, parkRepo);
	/** One user turn that parks on a call, is released, and is then answered. */
	const parkReleaseAnswer = async (
		history: Msg[],
		conv: Partial<SdkBridgeTurnMeta>,
		prompt: string,
		result: string,
		restart = false,
	) => {
		history.push({ role: "user", content: prompt });
		const parked = await turn(history, conv, undefined, a);
		const parkedCall = calls().at(-1);
		const use = (parked.content ?? []).find((x) => x.type === "tool_use");
		const status = await whenReleased(parked.turnId);
		const historyMode = repo.turns.get(parked.turnId)?.historyMode;
		if (restart) {
			await a.dispose();
			a = makeBridge(releaseLimits, root, parkRepo);
			await a.ready();
		}
		history.push(
			{ role: "assistant", content: parked.content as Block[] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: String(use?.id),
						content: result,
					},
				],
			},
		);
		const from = calls().length;
		const reply = await answer(parked.turnId, history, a);
		await settled(a);
		if (reply.content)
			history.push({ role: "assistant", content: reply.content });
		const resumed = calls().slice(from).at(0);
		const messages = messagesOf(resumed);
		const sent = JSON.stringify(messages);
		const last = messages.at(-1);
		return {
			stop: parked.stop,
			status,
			historyMode,
			reply,
			turnStatus: repo.turns.get(parked.turnId)?.status,
			cacheRead: resumed?.cache?.read ?? null,
			parkedCallCacheCreation: parkedCall?.cache?.creation ?? null,
			parkedCallCacheRead: parkedCall?.cache?.read ?? null,
			resultReachedModel: sent.includes(result),
			resultBlocks: resultTexts(messages, String(use?.id)),
			lastMessage: last ? shape(last) : null,
			expectedLastMessage: {
				role: "user",
				blocks: [["tool_result", String(use?.id), result]],
			},
			interrupted: sent.includes("interrupted"),
		};
	};
	try {
		await a.ready();
		// One conversation: turn 1 completes, turns 2 and 3 each resume the
		// stored session, park on a call and are released; turn 4 follows.
		const conv = header();
		const history: Msg[] = [{ role: "user", content: "hello resumed park" }];
		const r1 = await turn(history, conv, undefined, a);
		history.push({ role: "assistant", content: r1.content as Block[] });
		const second = await parkReleaseAnswer(
			history,
			conv,
			"TOOL read second.txt",
			"SECOND-RESULT",
		);
		const third = await parkReleaseAnswer(
			history,
			conv,
			"TOOL read third.txt",
			"THIRD-RESULT",
		);
		history.push({ role: "user", content: "NEXT after two releases" });
		const from = calls().length;
		const r4 = await turn(history, conv, undefined, a);
		await settled(a);
		const r4Sent = JSON.stringify(
			(calls().slice(from).at(0)?.body as { messages?: unknown[] })?.messages,
		);

		// A conversation's second turn, released, resumed by a new bridge.
		const conv2 = header();
		const history2: Msg[] = [{ role: "user", content: "hello restart park" }];
		const s1 = await turn(history2, conv2, undefined, a);
		history2.push({ role: "assistant", content: s1.content as Block[] });
		const restart = await parkReleaseAnswer(
			history2,
			conv2,
			"TOOL read after-restart.txt",
			"RESTART-RESULT",
			true,
		);

		// Text before the call, on a conversation's first turn.
		const textThenCall = await parkReleaseAnswer(
			[],
			{},
			"SAYTOOL read said.txt",
			"SAID-RESULT",
		);
		return {
			r1Stop: r1.stop,
			second,
			third,
			r4,
			r4Carries: [
				"SECOND-RESULT",
				"THIRD-RESULT",
				"NEXT after two releases",
			].filter((text) => r4Sent?.includes(text)),
			r4Interrupted: r4Sent?.includes("interrupted") ?? null,
			restart,
			textThenCall,
			parksLeft: parkRepo.parks.size,
		};
	} finally {
		await a.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

await scenario("releasedTwiceInOneTurn", async () => {
	// One turn parks, is released and resumed; the model then calls again,
	// and the turn parks and is released a second time before it ends.
	const root = mkdtempSync(join(tmpdir(), "sdk-bridge-released-twice-"));
	const parkRepo = memoryParkRepo(repo.turns);
	const bridgeB = makeBridge(
		{
			maxProcesses: 2,
			parkReleaseMs: 500,
			parkedTimeoutMs: 60_000,
			turnDeadlineMs: 120_000,
			releasedParkTtlMs: 600_000,
		},
		root,
		parkRepo,
	);
	const calls = () =>
		mock.requests.filter((q) => q.path.startsWith("/v1/messages"));
	const parkFile = async (turnId: string) => {
		const until = Date.now() + 20_000;
		let park = parkRepo.parks.get(turnId);
		while (
			!(
				repo.turns.get(turnId)?.status === "released" &&
				park?.state === "released"
			) &&
			Date.now() < until
		) {
			await Bun.sleep(50);
			park = parkRepo.parks.get(turnId);
		}
		return {
			status: repo.turns.get(turnId)?.status,
			text: park ? readFileSync(park.sessionPath, "utf8") : "",
		};
	};
	/** Stored transcripts anywhere under the root holding an empty tool result. */
	const emptyAnswersOnDisk = () =>
		filesUnder(root)
			.filter((f) => f.endsWith(".jsonl"))
			.filter((f) => emptyResults(readFileSync(join(root, f), "utf8")) > 0);
	const toolUse = (reply: Reply) =>
		(reply.content ?? []).find((x) => x.type === "tool_use");
	const run = async (history: Msg[], conv: Partial<SdkBridgeTurnMeta>) => {
		const r1 = await turn(history, conv, undefined, bridgeB);
		const first = toolUse(r1);
		const park1 = await parkFile(r1.turnId);
		const historyMode = repo.turns.get(r1.turnId)?.historyMode;
		history.push(
			{ role: "assistant", content: r1.content as Block[] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: String(first?.id),
						content: "AGAIN-FIRST",
					},
				],
			},
		);
		const fromFirst = calls().length;
		const r2 = await answer(r1.turnId, history, bridgeB);
		const firstResume = messagesOf(calls().slice(fromFirst).at(0));
		const second = toolUse(r2);
		const park2 = await parkFile(r1.turnId);
		const emptyAfterSecondRelease = emptyAnswersOnDisk();
		history.push(
			{ role: "assistant", content: r2.content as Block[] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: String(second?.id),
						content: "FINAL-RESULT",
					},
				],
			},
		);
		const from = calls().length;
		const r3 = await answer(r1.turnId, history, bridgeB);
		await settled(bridgeB);
		const resumed = calls().slice(from);
		const messages = messagesOf(resumed.at(0));
		const _sent = JSON.stringify(messages);
		const park2Messages = transcriptMessages(park2.text);
		if (r3.content) history.push({ role: "assistant", content: r3.content });
		return {
			historyMode,
			statuses: [r1.status, r2.status, r3.status],
			stops: [r1.stop, r2.stop, r3.stop],
			r3,
			turnStatus: repo.turns.get(r1.turnId)?.status,
			distinctCalls: new Set([first?.id, second?.id]).size,
			firstRelease: {
				status: park1.status,
				holdsCall: park1.text.includes(String(first?.id)),
				holdsAnyResult: park1.text.includes('"tool_result"'),
			},
			secondRelease: {
				status: park2.status,
				holdsSecondCall: park2.text.includes(String(second?.id)),
				firstResults: resultTexts(park2Messages, String(first?.id)),
				emptyResults: emptyResults(park2.text),
			},
			emptyAfterSecondRelease,
			emptyAtEnd: emptyAnswersOnDisk(),
			modelCalls: resumed.length,
			firstResults: resultTexts(messages, String(first?.id)),
			secondResults: resultTexts(messages, String(second?.id)),
			lastMessages: [firstResume.at(-1), messages.at(-1)].map((m) =>
				m ? shape(m) : null,
			),
			expectedLastMessages: [
				{
					role: "user",
					blocks: [["tool_result", String(first?.id), "AGAIN-FIRST"]],
				},
				{
					role: "user",
					blocks: [["tool_result", String(second?.id), "FINAL-RESULT"]],
				},
			],
			interrupted: [firstResume, messages].some((m) =>
				JSON.stringify(m).includes("interrupted"),
			),
		};
	};
	try {
		await bridgeB.ready();
		const firstTurn = await run(
			[{ role: "user", content: "TOOL read twice.txt" }],
			{},
		);
		const conv = {
			affinityScope: "client_session" as const,
			affinityKey: `conv-${crypto.randomUUID()}`,
		};
		const history: Msg[] = [{ role: "user", content: "hello twice" }];
		const opener = await turn(history, conv, undefined, bridgeB);
		history.push(
			{ role: "assistant", content: opener.content as Block[] },
			{ role: "user", content: "TOOL read twice-resumed.txt" },
		);
		const resumedTurn = await run(history, conv);
		return {
			firstTurn,
			openerStop: opener.stop,
			resumedTurn,
			parksLeft: parkRepo.parks.size,
		};
	} finally {
		await bridgeB.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

await scenario("releasedWithUnforwardedCall", async () => {
	// The parked message also calls a tool the client was never offered, so
	// the bridge forwards only the client's call.
	const root = mkdtempSync(join(tmpdir(), "sdk-bridge-released-stray-"));
	const parkRepo = memoryParkRepo(repo.turns);
	const on = makeBridge(
		{
			maxProcesses: 2,
			parkReleaseMs: 500,
			parkedTimeoutMs: 60_000,
			turnDeadlineMs: 120_000,
			releasedParkTtlMs: 600_000,
		},
		root,
		parkRepo,
	);
	const calls = () =>
		mock.requests.filter((q) => q.path.startsWith("/v1/messages"));
	const run = async (prompt: string) => {
		const history: Msg[] = [{ role: "user", content: prompt }];
		const r1 = await turn(history, {}, undefined, on);
		const until = Date.now() + 20_000;
		while (
			repo.turns.get(r1.turnId)?.status !== "released" &&
			Date.now() < until
		)
			await Bun.sleep(50);
		const park = parkRepo.parks.get(r1.turnId);
		const parkMessages = park
			? transcriptMessages(readFileSync(park.sessionPath, "utf8"))
			: [];
		const use = (r1.content ?? []).find((x) => x.type === "tool_use");
		history.push(
			{ role: "assistant", content: r1.content as Block[] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: String(use?.id),
						content: "CLIENT-RESULT",
					},
				],
			},
		);
		const fromResume = calls().length;
		const r2 = await answer(r1.turnId, history, on);
		await settled(on);
		const resumed = messagesOf(calls().slice(fromResume).at(0));
		return {
			r1Stop: r1.stop,
			forwarded: (r1.content ?? []).map((b) => [b.type, b.name ?? null]),
			awaited: park?.awaitedToolUseIds.length ?? null,
			// Every call the model made in the parked message, and the results
			// the stored session holds for each.
			parkedCalls: parkMessages
				.flatMap((m) => (typeof m.content === "string" ? [] : m.content))
				.filter((b) => b.type === "tool_use")
				.map((b) => [
					String(b.name),
					resultTexts(parkMessages, String(b.id)).length,
				]),
			r2,
			turnStatus: repo.turns.get(r1.turnId)?.status,
			// Each call of the parked message, and what the resumed model call
			// sent as its results.
			resumedResults: parkMessages
				.flatMap((m) => (typeof m.content === "string" ? [] : m.content))
				.filter((b) => b.type === "tool_use")
				.map((b) => [String(b.name), resultTexts(resumed, String(b.id))]),
			lastBlockTypes: shape(
				resumed.at(-1) ?? { role: "user", content: [] },
			).blocks.map(([type]) => type),
			interrupted: JSON.stringify(resumed).includes("interrupted"),
		};
	};
	try {
		await on.ready();
		return {
			strayAfter: await run("STRAY read and more"),
			unmappedFirst: await run("UNMAPPED then read"),
		};
	} finally {
		await on.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

await scenario("childPathsInContext", async () => {
	// A pi conversation whose prompt names the client's own directory: a
	// fresh turn and a resumed one, each with a tool round, a released park
	// answered in process and after a restart onto a new generation, and two
	// more turns after that. Every user turn draws signed thinking, which the
	// mock refuses once the history before it changes.
	const clientCwd = "/home/user/projects/widget";
	const system = loadPiPromptFixture("0.87", "stock").system;
	const root = mkdtempSync(join(tmpdir(), "sdk-bridge-child-paths-"));
	const parkRepo = memoryParkRepo(repo.turns);
	const limits: Partial<SdkBridgeLimits> = {
		maxProcesses: 2,
		parkReleaseMs: 500,
		parkedTimeoutMs: 60_000,
		turnDeadlineMs: 120_000,
		releasedParkTtlMs: 600_000,
	};
	// A client pasting an environment block of its own: never Claude Code's.
	const excerpt = [
		"<system-reminder>",
		"# Environment",
		"You have been invoked in the following environment: ",
		" - Primary working directory: /home/alice/project",
		" - Platform: darwin",
		"</system-reminder>",
	].join("\n");
	const png =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const run = async (model: string, harness = "pi") => {
		let on = makeBridge(limits, root, parkRepo);
		await on.ready();
		const from = mock.requests.length;
		const header = {
			clientHarness: harness,
			piPromptVersion: harness === "pi" ? "0.87" : null,
			model,
			affinityScope: "client_session" as const,
			affinityKey: `conv-${crypto.randomUUID()}`,
		};
		const req = (messages: Msg[]) =>
			new Request("http://bridge.test/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model,
					stream: true,
					system: harness === "pi" ? system : "You are opencode.",
					tools: [READ_TOOL],
					messages,
					max_tokens: 1024,
				}),
			});
		const start = async (messages: Msg[]) => {
			const p = {
				...plan(),
				candidates: [
					{
						accountId: "acct-a",
						provider: "anthropic" as const,
						upstreamModel: model,
					},
				],
			};
			const r = await read(
				on.startTurn({
					request: req(messages),
					plan: p,
					meta: meta(header),
					signal: new AbortController().signal,
				}),
			);
			return { ...r, turnId: p.turnId };
		};
		const reply = (turnId: string, messages: Msg[]) =>
			read(
				on.continueTurn({
					turnId,
					request: req(messages),
					meta: meta(header),
					signal: new AbortController().signal,
				}),
			);
		const whenReleased = async (turnId: string) => {
			const until = Date.now() + 20_000;
			while (
				repo.turns.get(turnId)?.status !== "released" &&
				Date.now() < until
			)
				await Bun.sleep(50);
			return repo.turns.get(turnId)?.status;
		};
		/** Answers the reply's one call with `result`; returns the next reply. */
		const answerCall = async (
			history: Msg[],
			turnId: string,
			r: Reply,
			result: string,
		) => {
			const use = (r.content ?? []).find((b) => b.type === "tool_use");
			history.push(
				{ role: "assistant", content: r.content as Block[] },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: String(use?.id),
							content: result,
						},
					],
				},
			);
			return reply(turnId, history);
		};
		const history: Msg[] = [{ role: "user", content: "THINK TOOL where am I" }];
		const steps: Record<string, unknown> = {};
		try {
			const first = await start(history);
			const firstDone = await answerCall(
				history,
				first.turnId,
				first,
				"LIVE-RESULT",
			);
			await settled(on);
			history.push(
				{ role: "assistant", content: firstDone.content as Block[] },
				{ role: "user", content: "THINK TOOL read resumed.txt" },
			);
			const resumed = await start(history);
			steps.resumedReleased = await whenReleased(resumed.turnId);
			const resumedDone = await answerCall(
				history,
				resumed.turnId,
				resumed,
				"RELEASED-RESULT",
			);
			await settled(on);
			history.push(
				{ role: "assistant", content: resumedDone.content as Block[] },
				{ role: "user", content: "THINK TOOL read restarted.txt" },
			);
			const beforeRestart = await start(history);
			steps.restartReleased = await whenReleased(beforeRestart.turnId);
			await on.dispose();
			on = makeBridge(limits, root, parkRepo);
			await on.ready();
			// AGAIN makes the model call once more after the resume.
			const again = await answerCall(
				history,
				beforeRestart.turnId,
				beforeRestart,
				"AGAIN-RESTARTED-RESULT",
			);
			const last = await answerCall(
				history,
				beforeRestart.turnId,
				again,
				"FINAL-RESULT",
			);
			await settled(on);
			history.push(
				{ role: "assistant", content: last.content as Block[] },
				{ role: "user", content: "THINK after the restart" },
			);
			const after = await start(history);
			await settled(on);
			history.push(
				{ role: "assistant", content: after.content as Block[] },
				{ role: "user", content: `and once more\n\n${excerpt}` },
			);
			const once = await start(history);
			await settled(on);
			// Parallel calls answered with an image result, a text one and
			// typed text.
			history.push(
				{ role: "assistant", content: once.content as Block[] },
				{ role: "user", content: "PARALLEL read both" },
			);
			const parallel = await start(history);
			const uses = (parallel.content ?? []).filter(
				(b) => b.type === "tool_use",
			);
			history.push(
				{ role: "assistant", content: parallel.content as Block[] },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: String(uses[0]?.id),
							content: [
								{ type: "text", text: "IMAGE-RESULT" },
								{
									type: "image",
									source: {
										type: "base64",
										media_type: "image/png",
										data: png,
									},
								},
							],
						},
						{
							type: "tool_result",
							tool_use_id: String(uses[1]?.id),
							content: "TEXT-RESULT",
						},
						{ type: "text", text: "TYPED-WITH-RESULTS" },
					],
				},
			);
			const parallelDone = await reply(parallel.turnId, history);
			await settled(on);
			steps.stops = [
				first.stop,
				firstDone.stop,
				resumed.stop,
				resumedDone.stop,
				beforeRestart.stop,
				again.stop,
				last.stop,
				after.stop,
				once.stop,
				parallel.stop,
				parallelDone.stop,
			];
			steps.historyModes = [
				first.turnId,
				resumed.turnId,
				beforeRestart.turnId,
				after.turnId,
				once.turnId,
				parallel.turnId,
			].map((id) => repo.turns.get(id)?.historyMode);
		} finally {
			await on.dispose();
		}
		const calls = mock.requests
			.slice(from)
			.filter((q) => q.path.startsWith("/v1/messages"));
		// Control: the last call again, with its first message changed.
		const tampered = structuredClone(calls.at(-1)?.body) as {
			messages: Msg[];
		};
		tampered.messages[0] = { role: "user", content: "THINK elsewhere" };
		const refused = await mock.handle(
			new Request(`${mock.url}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(tampered),
			}),
		);
		// The control is this script's call, not Claude Code's.
		mock.requests.pop();
		return {
			...steps,
			tamperedHistory: {
				status: refused.status,
				message: ((await refused.json()) as { error?: { message?: string } })
					.error?.message,
			},
			calls: calls.map((q) => {
				const text = JSON.stringify(q.body);
				const body = q.body as { system?: Array<{ text?: string }> };
				const systemText = (body.system ?? []).map((b) => b.text).join("");
				// Each line of the body naming the child's directories.
				const leaks = [
					...new Set(
						text
							.split(/\\n|"/)
							.filter((line) => line.includes(root))
							.map((line) => line.slice(0, 300)),
					),
				];
				return {
					status: q.status ?? null,
					thinkingVerified: q.thinkingVerified ?? 0,
					excerptArrived: text.includes(JSON.stringify(excerpt).slice(1, -1)),
					leaks,
					clientCwdInSystem: systemText.includes(`<cwd>\n${clientCwd}\n</cwd>`),
				};
			}),
		};
	};
	try {
		return {
			root,
			// Claude Code renders its own context differently per model family.
			sonnet: await run(MODEL),
			opus: await run("claude-opus-5-5"),
			fable: await run("claude-fable-5-1"),
			// The drop policy: the client's system text never reaches the model.
			drop: await run("claude-opus-5-5", "opencode"),
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await scenario("thinkingCutover", async () => {
	// Thinking signed before the environment block was stripped is bound to
	// a history that held the block, so the API refuses it once the block is
	// gone: here, every signature the conversation drew before the cut is
	// refused from then on. The park is released before the cut and resumed
	// after it, as a promotion would leave it.
	const root = mkdtempSync(join(tmpdir(), "sdk-bridge-cutover-"));
	const parkRepo = memoryParkRepo(repo.turns);
	const limits: Partial<SdkBridgeLimits> = {
		maxProcesses: 2,
		parkReleaseMs: 500,
		parkedTimeoutMs: 60_000,
		turnDeadlineMs: 120_000,
		releasedParkTtlMs: 600_000,
	};
	const run = async (model: string) => {
		const on = makeBridge(limits, root, parkRepo);
		await on.ready();
		const header = {
			model,
			affinityScope: "client_session" as const,
			affinityKey: `conv-${crypto.randomUUID()}`,
		};
		const req = (messages: Msg[]) =>
			new Request("http://bridge.test/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model,
					stream: true,
					system: "You are opencode.",
					tools: [READ_TOOL],
					messages,
					max_tokens: 1024,
				}),
			});
		const start = async (messages: Msg[]) => {
			const p = {
				...plan(),
				candidates: [
					{
						accountId: "acct-a",
						provider: "anthropic" as const,
						upstreamModel: model,
					},
				],
			};
			const r = await read(
				on.startTurn({
					request: req(messages),
					plan: p,
					meta: meta(header),
					signal: new AbortController().signal,
				}),
			);
			return { ...r, turnId: p.turnId };
		};
		const from = mock.requests.length;
		const signedFrom = mock.signatures.length;
		try {
			const history: Msg[] = [
				{ role: "user", content: "THINK TOOL read cutover.txt" },
			];
			const parked = await start(history);
			const until = Date.now() + 20_000;
			while (
				repo.turns.get(parked.turnId)?.status !== "released" &&
				Date.now() < until
			)
				await Bun.sleep(50);
			const released = repo.turns.get(parked.turnId)?.status;
			const cut = mock.requests.length;
			const old = mock.signatures.slice(signedFrom);
			for (const signature of old)
				mock.addRule({
					marker: signature,
					fail: {
						status: 400,
						body: {
							type: "error",
							error: {
								type: "invalid_request_error",
								message:
									"messages.2.content.0: Invalid `signature` in `thinking` block: it is bound to a different conversation",
							},
						},
					},
				});
			const use = (parked.content ?? []).find((b) => b.type === "tool_use");
			history.push(
				{ role: "assistant", content: parked.content as Block[] },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: String(use?.id),
							content: "CUTOVER-RESULT",
						},
					],
				},
			);
			const resumed = await read(
				on.continueTurn({
					turnId: parked.turnId,
					request: req(history),
					meta: meta(header),
					signal: new AbortController().signal,
				}),
			);
			await settled(on);
			history.push(
				{ role: "assistant", content: resumed.content as Block[] },
				{ role: "user", content: "THINK and then" },
			);
			const next = await start(history);
			await settled(on);
			history.push(
				{ role: "assistant", content: next.content as Block[] },
				{ role: "user", content: "last" },
			);
			const last = await start(history);
			await settled(on);
			const row = repo.turns.get(parked.turnId);
			return {
				released,
				signedBeforeCut: old.length,
				replies: [resumed, next, last].map((r) => ({
					status: r.status,
					stop: r.stop,
					text: (r.content ?? [])
						.filter((b) => b.type === "text")
						.map((b) => String(b.text))
						.join(""),
				})),
				turn: { status: row?.status, counters: row?.counters },
				// Each model call from the cut on: its status, and whether it
				// still carried thinking signed before the cut.
				afterCut: mock.requests
					.slice(cut)
					.filter((q) => q.path.startsWith("/v1/messages"))
					.map((q) => ({
						status: q.status ?? null,
						carriesOld: old.some((sig) => JSON.stringify(q.body).includes(sig)),
						cacheRead: q.cache?.read ?? null,
					})),
				callsBeforeCut: mock.requests
					.slice(from, cut)
					.filter((q) => q.path.startsWith("/v1/messages")).length,
			};
		} finally {
			await on.dispose();
		}
	};
	try {
		return {
			opus: await run("claude-opus-5-5"),
			fable: await run("claude-fable-5-1"),
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await scenario("oversizedInnerBody", async () => {
	// The client's request fits; Claude Code's own model call, carrying its
	// system prompt and tools, does not.
	const small = makeBridge({ maxProcesses: 2, maxHistoryBytes: 8_000 });
	try {
		const from = mock.requests.length;
		const r = await turn(
			[{ role: "user", content: "hello small" }],
			{},
			undefined,
			small,
		);
		await settled(small);
		const row = repo.turns.get(r.turnId);
		return {
			reply: r,
			upstreamCalls: mock.requests.slice(from).length,
			turnStatus: row?.status,
			innerCounters: row?.counters,
		};
	} finally {
		await small.dispose();
	}
});

await scenario("rssAtCap", async () => {
	const turns = await Promise.all(
		[1, 2, 3, 4].map((i) =>
			turn([{ role: "user", content: `TOOL read file-${i}` }]),
		),
	);
	const parked = bridge.status().parked;
	await Bun.sleep(500);
	const pids = childPids();
	const mem = pids.map((pid) => ({ pid, ...memory(pid) }));
	const refused = await turn([{ role: "user", content: "fifth" }]);
	bridge.beginShutdown();
	const t0 = performance.now();
	let left = childPids();
	while (left.length && performance.now() - t0 < 10_000) {
		await Bun.sleep(100);
		left = childPids();
	}
	return {
		stops: turns.map((t) => t.stop),
		parked,
		processes: pids.length,
		perProcess: mem,
		totalRssBytes: mem.reduce((sum, m) => sum + (m.rss ?? 0), 0),
		fifthStatus: refused.status,
		leftAfterShutdown: left.length,
		shutdownMs: Math.round(performance.now() - t0),
		statusPeakRssBytes: bridge.status().peakRssBytes,
	};
});

await bridge.dispose();
// Every bridge disposed: nothing of theirs stays under the work root.
results.filesAfterDispose = filesUnder(workRoot);
results.upstreamPaths = [
	...new Set(mock.requests.map((q) => `${q.method} ${q.path}`)),
];
results.leftoverChildren = childPids().length;
save();
mock.stop();
rmSync(workRoot, { recursive: true, force: true });
process.exit(0);
