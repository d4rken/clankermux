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
import type { SdkBridgeLimits } from "../../types";
import {
	foldReply,
	MODEL,
	memoryTurnRepo,
	parseSse,
	READ_TOOL,
	silentLog,
} from "./fake-sdk";
import { startMockUpstream } from "./mock-upstream";

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
): ClaudeSdkBridge {
	return createClaudeSdkBridge({
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
