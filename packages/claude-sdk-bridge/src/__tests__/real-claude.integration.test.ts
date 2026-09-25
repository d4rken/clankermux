/**
 * The bundled Claude Code binary, driven through the bridge against a loopback
 * mock upstream. The scenarios run in a child process inside a fresh network
 * namespace that has nothing but loopback (`unshare -rn`), so the binary cannot
 * reach Anthropic whatever it tries. Where user namespaces are unavailable
 * (for example Ubuntu 24.04 with AppArmor restricting them) the suite is
 * skipped with the reason printed; it never runs with egress.
 */
import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudeExecutable } from "../spawn";

const SCRIPT = join(import.meta.dir, "fixtures", "real-claude-scenarios.ts");
const TIMEOUT = 300_000;

function skipReason(): string | null {
	const probe = spawnSync("unshare", ["-rn", "sh", "-c", "ip link set lo up"], {
		encoding: "utf8",
	});
	if (probe.error) return `unshare is not available (${probe.error.message})`;
	if (probe.status !== 0)
		return `user network namespaces are unavailable (unshare -rn: ${probe.stderr.trim() || `exit ${probe.status}`})`;
	const executable = resolveClaudeExecutable();
	if ("error" in executable) return executable.error;
	return null;
}

const reason = skipReason();
if (reason)
	console.warn(
		`[claude-sdk-bridge] real Claude Code integration SKIPPED: ${reason}`,
	);

type Results = Record<string, Record<string, unknown> & { ok?: boolean }> & {
	egressBlocked?: unknown;
	upstreamPaths?: unknown;
	leftoverChildren?: unknown;
	staleGenerationRemoved?: unknown;
	filesAfterDispose?: unknown;
};

let pending: Promise<Results> | null = null;

function results(): Promise<Results> {
	pending ??= new Promise((resolve, reject) => {
		const dir = mkdtempSync(join(tmpdir(), "sdk-bridge-it-"));
		const out = join(dir, "results.json");
		const child = spawn(
			"unshare",
			["-rn", "sh", "-c", `ip link set lo up && bun '${SCRIPT}' '${out}'`],
			{ stdio: ["ignore", "inherit", "inherit"] },
		);
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT - 10_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			try {
				const parsed = JSON.parse(readFileSync(out, "utf8")) as Results;
				if (code !== 0) parsed.exit = { code } as never;
				resolve(parsed);
			} catch (error) {
				reject(
					new Error(`scenario runner exited ${code} without results: ${error}`),
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
	return pending;
}

function scenario(r: Results, name: string): Record<string, unknown> {
	const s = r[name];
	if (!s?.ok) throw new Error(`${name} failed: ${JSON.stringify(s)}`);
	return s;
}

const MB = 1024 * 1024;

describe.skipIf(reason !== null)(
	"real Claude Code in a loopback-only namespace",
	() => {
		it(
			"cannot reach the network, and the bridge is available",
			async () => {
				const r = await results();
				expect(r.egressBlocked).toBe(true);
				expect(r.availability).toEqual({ state: "available" });
			},
			TIMEOUT,
		);

		it(
			"answers a plain turn with Claude Code's own prompt, honestly labelled",
			async () => {
				const s = scenario(await results(), "plain");
				expect(s.reply).toMatchObject({ status: 200, stop: "end_turn" });
				expect(JSON.stringify(s.reply)).toContain("echo: hello plain");
				expect(s.turnStatus).toBe("completed");
				expect(s.upstreamUserAgent).toContain("sdk-ts");
				// The listener strips the per-turn token before dispatch.
				expect(s.upstreamAuthorization).toBeNull();
				// The drop policy: the client's system prompt never reaches the model.
				expect(s.upstreamSystemMentionsPi).toBe(false);
				expect(s.upstreamTools).toEqual(["mcp__c__read"]);
			},
			TIMEOUT,
		);

		it(
			"round-trips a client tool call",
			async () => {
				const s = scenario(await results(), "toolRoundTrip");
				expect(s.r1).toMatchObject({ status: 200, stop: "tool_use" });
				expect((s.r1 as { content: unknown[] }).content).toEqual([
					{
						type: "tool_use",
						id: expect.any(String),
						name: "read",
						input: { path: "a.txt" },
					},
				]);
				expect(s.parkedWhileWaiting).toBe(1);
				expect(s.r2).toMatchObject({
					status: 200,
					stop: "end_turn",
					content: [{ type: "text", text: "done: CONTENT-A" }],
				});
				expect((s.turn as { status: string; legs: unknown[] }).status).toBe(
					"completed",
				);
				expect((s.turn as { legs: unknown[] }).legs).toHaveLength(2);
			},
			TIMEOUT,
		);

		it(
			"round-trips parallel tool calls",
			async () => {
				const s = scenario(await results(), "parallelTools");
				expect(s.toolUses).toBe(2);
				expect(s.r1Stop).toBe("tool_use");
				expect(s.r2).toMatchObject({ status: 200, stop: "end_turn" });
			},
			TIMEOUT,
		);

		it(
			"gives a 64-character client tool a short alias upstream and its own name back",
			async () => {
				const s = scenario(await results(), "longToolName");
				const upstream = s.upstream as Array<{
					status: number;
					tools: string[];
				}>;
				expect(upstream.length).toBeGreaterThanOrEqual(2);
				for (const call of upstream) {
					expect(call.status).toBe(200);
					expect(call.tools).toEqual([expect.stringMatching(/^mcp__c__t_/)]);
					for (const name of call.tools)
						expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
				}
				expect(s.r1).toMatchObject({ status: 200, stop: "tool_use" });
				expect((s.r1 as { content: unknown[] }).content).toEqual([
					expect.objectContaining({ type: "tool_use", name: s.clientName }),
				]);
				expect(s.r2).toMatchObject({
					status: 200,
					stop: "end_turn",
					content: [{ type: "text", text: "done: LONG" }],
				});
			},
			TIMEOUT,
		);

		it(
			"sends the client's max_tokens upstream as Claude Code's output limit",
			async () => {
				const s = scenario(await results(), "outputLimit");
				type Case = {
					reply: { status: number; stop: unknown };
					upstream: Array<{ status: number; maxTokens: unknown }>;
				};
				const sent = (name: string) =>
					(s[name] as Case).upstream.map((u) => u.maxTokens);
				console.log(
					`[claude-sdk-bridge] upstream max_tokens: client 321 -> ${sent("client321")}, none -> ${sent("clientNone")}, 200000 -> ${sent("client200000")}, 64 with a max_tokens stop -> ${sent("stopAtLimit")}`,
				);
				for (const name of [
					"client321",
					"clientNone",
					"client200000",
					"stopAtLimit",
				])
					expect((s[name] as Case).reply.status).toBe(200);
				expect(sent("client321")).toEqual([321]);
				expect(sent("clientNone")).not.toContain(321);
				// The limit bounds each model call, not the turn: after a max_tokens
				// stop Claude Code asks the model to resume, under the same limit.
				const stopped = sent("stopAtLimit");
				expect(stopped.length).toBeGreaterThan(1);
				expect(new Set(stopped)).toEqual(new Set([64]));
				expect((s.stopAtLimit as Case).reply.stop).toBe("end_turn");
			},
			TIMEOUT,
		);

		it(
			"resumes the conversation on the next user turn with a session header",
			async () => {
				const s = scenario(await results(), "resumeWithHeader");
				expect(s.historyMode).toBe("resume");
				expect(s.upstreamCarriesFirstTurn).toBe(true);
				expect(s.upstreamCarriesSecondTurn).toBe(true);
				expect(s.r2).toMatchObject({ status: 200, stop: "end_turn" });
			},
			TIMEOUT,
		);

		it(
			"answers a side request on a copy of the session, which the next turn never sees",
			async () => {
				const s = scenario(await results(), "sideRequestFork");
				type Call = {
					status: number;
					cacheRead: number | null;
					tools: string[];
					text: string;
				};
				type Run = {
					reply: {
						status: number;
						stop: unknown;
						content?: unknown;
						errors?: Array<{ data: { error?: { code?: string } } }>;
					};
					row: Record<string, unknown>;
					upstream: Call[];
				};
				const side = s.side as Run;
				const next = s.next as Run;
				const toolSide = s.toolSide as Run;
				const toolNext = s.toolNext as Run;
				const textThenCall = s.textThenCall as Run;
				const onlyCall = s.onlyCall as Run;
				console.log(
					`[claude-sdk-bridge] side request cache reads: fork of a tool-free session ${side.upstream.map((c) => c.cacheRead)}, its next main turn ${next.upstream.map((c) => c.cacheRead)}; fork of a session with client tools ${toolSide.upstream.map((c) => c.cacheRead)}, its next main turn ${toolNext.upstream.map((c) => c.cacheRead)}`,
				);
				expect(side.reply).toMatchObject({ status: 200, stop: "end_turn" });
				expect(JSON.stringify(side.reply.content)).toContain(
					"echo: RECAP the session",
				);
				expect(side.row).toMatchObject({
					kind: "side_request",
					status: "completed",
					historyMode: "resume",
				});
				expect(side.upstream).toHaveLength(1);
				const [fork] = side.upstream;
				expect(fork?.text).toContain("hello fork");
				expect(fork?.cacheRead).toBeGreaterThan(0);
				// The next main turn resumes the conversation's own session.
				expect(next.row).toMatchObject({
					kind: "turn",
					status: "completed",
					historyMode: "resume",
				});
				expect(next.upstream[0]?.text).toContain("second main turn");
				expect(next.upstream[0]?.text).not.toContain("RECAP");
				expect(next.upstream[0]?.cacheRead).toBeGreaterThan(0);
				// The copy of a session with client tools sends those tools, so
				// the conversation's cached prefix holds.
				expect(toolSide.reply).toMatchObject({ status: 200, stop: "end_turn" });
				expect(toolSide.upstream.map((c) => c.tools)).toEqual([
					["mcp__c__read"],
				]);
				expect(toolSide.upstream[0]?.text).toContain("FORK-A");
				expect(toolSide.upstream[0]?.cacheRead).toBeGreaterThan(0);
				expect(toolNext.row).toMatchObject({
					kind: "turn",
					status: "completed",
					historyMode: "resume",
				});
				expect(toolNext.upstream[0]?.text).not.toContain("recap");
				expect(toolNext.upstream[0]?.cacheRead).toBeGreaterThan(0);
				// A tool call ends the copy after one model call: the text before
				// it is the answer, and a call alone is a coded error.
				expect(textThenCall.reply).toMatchObject({
					status: 200,
					stop: "end_turn",
					content: [{ type: "text", text: "echo: SAYTOOL recap" }],
				});
				expect(textThenCall.upstream).toHaveLength(1);
				expect(textThenCall.row).toMatchObject({ status: "completed" });
				expect(onlyCall.reply.errors?.[0]?.data.error?.code).toBe(
					"sdk_bridge_side_request_tool_call",
				);
				expect(onlyCall.upstream).toHaveLength(1);
				expect(onlyCall.row).toMatchObject({ status: "failed" });
				expect(s.forksLeft).toEqual([]);
			},
			TIMEOUT,
		);

		it(
			"rebuilds a header-less history as a transcript Claude Code replays",
			async () => {
				const s = scenario(await results(), "rebuildWithoutHeader");
				expect(s.historyMode).toBe("rebuild_transcript");
				expect(s.upstreamCarriesHistory).toBe(true);
				expect((s.upstreamRoles as string[]).slice(0, 3)).toEqual([
					"user",
					"assistant",
					"user",
				]);
			},
			TIMEOUT,
		);

		it(
			"kills the child when the client disconnects",
			async () => {
				const s = scenario(await results(), "abortCleanup");
				expect(s.during).toBe(1);
				expect(s.after).toBe(0);
				expect(s.live).toBe(0);
				expect(s.upstreamAborted).toBe(true);
			},
			TIMEOUT,
		);

		it(
			"leaves no transcript behind a closed query, and nothing at all after dispose",
			async () => {
				const r = await results();
				expect(r.staleGenerationRemoved).toBe(true);
				expect(scenario(r, "plain").transcriptsAfter).toEqual([]);
				expect(r.filesAfterDispose).toEqual([]);
			},
			TIMEOUT,
		);

		it(
			"counts the plain turn's model call once, from its row",
			async () => {
				const s = scenario(await results(), "plain");
				expect(s.innerCounters).toMatchObject({ innerErrors: 0 });
				expect(
					(s.innerCounters as { innerCalls: number }).innerCalls,
				).toBeGreaterThanOrEqual(1);
			},
			TIMEOUT,
		);

		it(
			"delivers text sent with tool results to the model, after the results",
			async () => {
				const s = scenario(await results(), "textWithToolResults");
				expect(s.r2).toMatchObject({ status: 200 });
				// One model call carries both, so the reply the client gets
				// answers the text too.
				expect(s.upstreamCalls).toBe(1);
				expect(s.textReachedUpstream).toBe(true);
				expect(s.resultBeforeText).toBe(true);
				expect(s.turn).toBe("completed");
			},
			TIMEOUT,
		);

		it(
			"rebuilds a continuation whose query timed out and serves it",
			async () => {
				const s = scenario(await results(), "deadContinuation");
				expect(s.firstStatus).toBe("timed_out");
				expect(s.continued).toBeNull();
				expect(s.r2).toMatchObject({
					status: 200,
					stop: "end_turn",
					content: [{ type: "text", text: "done: DEAD-RESULT" }],
				});
				expect(s).toMatchObject({
					historyMode: "rebuild_flattened",
					rebuildReason: "dead_continuation",
					turnStatus: "completed",
					upstreamCarriesCall: true,
					upstreamCarriesResult: true,
					upstreamHasToolResultBlock: false,
				});
			},
			TIMEOUT,
		);

		it(
			"refuses a model call larger than maxHistoryBytes with 413",
			async () => {
				const s = scenario(await results(), "oversizedInnerBody");
				expect(s.reply).toMatchObject({ status: 413 });
				expect(s.upstreamCalls).toBe(0);
				expect(s.turnStatus).toBe("failed");
				expect(s.innerCounters).toMatchObject({
					innerCalls: 0,
					innerErrors: 1,
				});
			},
			TIMEOUT,
		);

		it(
			"holds four parked processes at the cap, refuses a fifth, and leaves nothing at shutdown",
			async () => {
				const r = await results();
				const s = scenario(r, "rssAtCap");
				expect(s.parked).toBe(4);
				expect(s.processes).toBe(4);
				expect(s.fifthStatus).toBe(529);
				expect(s.leftAfterShutdown).toBe(0);
				expect(r.leftoverChildren).toBe(0);
				expect(r.upstreamPaths).toEqual(["POST /v1/messages?beta=true"]);
				const per = s.perProcess as Array<{ rss: number; hwm: number }>;
				console.log(
					`[claude-sdk-bridge] RSS at the cap: ${per.map((p) => `${Math.round(p.rss / MB)} MB`).join(", ")} (total ${Math.round((s.totalRssBytes as number) / MB)} MB, peak VmHWM ${Math.round((s.statusPeakRssBytes as number) / MB)} MB)`,
				);
			},
			TIMEOUT,
		);
	},
);
