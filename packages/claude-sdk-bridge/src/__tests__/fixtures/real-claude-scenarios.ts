/**
 * Runs the bundled Claude Code binary through the bridge against a loopback
 * mock upstream, and writes what happened to the JSON file named by argv[2].
 *
 * Only ever run inside a network namespace with nothing but loopback:
 *   unshare -rn sh -c 'ip link set lo up && bun real-claude-scenarios.ts out.json'
 * It refuses to start when 1.1.1.1 is reachable.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkBridgeRoutePlan, SdkBridgeTurnMeta } from "@clankermux/types";
import { createClaudeSdkBridge } from "../../bridge";
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

const mock = startMockUpstream();
const repo = memoryTurnRepo();
const workRoot = mkdtempSync(join(tmpdir(), "sdk-bridge-real-"));
const bridge = createClaudeSdkBridge({
	dispatchInner: async (req, ctx) => {
		const res = await mock.handle(req);
		ctx.onInnerOutcome?.({
			requestId: crypto.randomUUID(),
			status: res.status,
			errorType: null,
			message: null,
			retryAfter: res.headers.get("retry-after"),
			accountId: ctx.plan.preferredAccountId,
		});
		return res;
	},
	turnRepo: repo,
	workRoot,
	log: silentLog,
	limits: () => ({
		maxProcesses: 4,
		parkedTimeoutMs: 60_000,
		turnDeadlineMs: 120_000,
	}),
});
results.availability = bridge.availability();

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
		clientHarness: "pi",
		clientUserAgent: "pi/test",
		project: "real-claude",
		projectAttributionSource: null,
		affinityScope: null,
		affinityKey: null,
		model: MODEL,
		reasoningEffort: null,
		...extra,
	};
}

function request(messages: Msg[], tools = [READ_TOOL]) {
	return new Request("http://bridge.test/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			max_tokens: 1024,
			stream: true,
			system: "You are pi, a coding agent.",
			tools,
			messages,
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
	const res = await response;
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
) {
	const p = plan();
	const m = meta(extra);
	const r = await read(
		bridge.startTurn({
			request: request(messages),
			plan: p,
			meta: m,
			signal: signal ?? new AbortController().signal,
		}),
	);
	return { ...r, turnId: p.turnId };
}

async function answer(turnId: string, messages: Msg[]) {
	return read(
		bridge.continueTurn({
			turnId,
			request: request(messages),
			meta: meta(),
			signal: new AbortController().signal,
		}),
	);
}

async function settled() {
	const until = Date.now() + 20_000;
	while (bridge.status().live > 0 && Date.now() < until) await Bun.sleep(50);
}

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
	const row = repo.turns.get(r.turnId);
	const upstream = mock.requests.find((q) => q.path.startsWith("/v1/messages"));
	return {
		reply: r,
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
results.upstreamPaths = [
	...new Set(mock.requests.map((q) => `${q.method} ${q.path}`)),
];
results.leftoverChildren = childPids().length;
save();
mock.stop();
rmSync(workRoot, { recursive: true, force: true });
process.exit(0);
