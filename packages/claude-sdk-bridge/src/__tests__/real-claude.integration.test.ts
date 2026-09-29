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
			"appends another model's turns to the stored session, replaying Claude Code's own prefix",
			async () => {
				const s = scenario(await results(), "extendAfterOtherModel");
				type Cache = { read: number; creation: number };
				type Turn = {
					messages: unknown[];
					cache: Cache;
					thinkingVerified: number;
					tailCounts: number[];
				};
				const one = s.turnOne as {
					calls: number;
					systemTexts: string[];
					cache: Cache;
					lastMessages: unknown[];
				};
				const two = s.two as Turn;
				const three = s.three as Turn;
				const four = s.four as { cache: Cache; thinkingVerified: number };
				console.log(
					`[claude-sdk-bridge] extended resume first-call cache reads: turn 1 last call wrote up to ${one.cache.read + one.cache.creation}; first extension read ${two.cache.read}, wrote ${two.cache.creation}; second read ${three.cache.read}, wrote ${three.cache.creation}; plain resume after read ${four.cache.read}`,
				);
				expect(s.rows).toEqual([
					{ historyMode: "fresh", rebuildReason: null },
					{ historyMode: "resume_extended", rebuildReason: "continuation" },
					{ historyMode: "resume_extended", rebuildReason: "continuation" },
					{ historyMode: "resume", rebuildReason: null },
				]);
				for (const r of s.replies as Array<{ status: number; stop: unknown }>)
					expect(r).toMatchObject({ status: 200, stop: "end_turn" });

				// Turn 1's last model call, Claude Code's date and model system
				// messages included, opens the extended turn's first call as sent.
				expect(one.calls).toBe(3);
				expect(one.systemTexts).toEqual([
					expect.stringContaining("Today's date is"),
					expect.stringContaining("You are powered by the model"),
				]);
				const prefix = one.lastMessages;
				expect(two.messages.slice(0, prefix.length)).toEqual(prefix);
				const text = (t: string) => [{ type: "text", text: t }];
				expect(two.messages.slice(prefix.length)).toEqual([
					// Turn 1's final reply, unchanged.
					{ role: "assistant", content: text("done: CONTENT-X") },
					// The other model's turn, once.
					{ role: "user", content: text("GPT-Q1 question") },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "GPT reading 1." },
							{
								type: "tool_use",
								id: "call_x1|fc_x1",
								name: "mcp__c__read",
								input: { path: "g1.txt" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_x1|fc_x1",
								content: "GPT-RESULT-1",
							},
						],
					},
					{ role: "assistant", content: text("GPT answer 1") },
					// The new prompt.
					{ role: "user", content: text("EXTEND-ONE back to claude") },
				]);
				// The call id appears in the call and its result, nowhere else.
				expect(two.tailCounts).toEqual([1, 1, 1, 1, 2]);
				expect(two.cache.read).toBe(one.cache.read + one.cache.creation);

				// Extended again: the first extension stays as it was sent, its
				// assistant messages unmerged, and the new turn follows once.
				expect(three.messages.slice(0, two.messages.length)).toEqual(
					two.messages,
				);
				expect(three.messages.slice(two.messages.length)).toEqual([
					{
						role: "assistant",
						content: text("echo: EXTEND-ONE back to claude"),
					},
					{ role: "user", content: text("GPT-Q2 question") },
					{ role: "assistant", content: text("GPT answer 2") },
					{ role: "user", content: text("EXTEND-TWO again") },
				]);
				expect(three.tailCounts).toEqual([1, 1, 1]);
				expect(three.cache.read).toBe(two.cache.read + two.cache.creation);

				// Turn 1's signed thinking stayed bound to its history throughout.
				expect(s.refusals).toEqual([]);
				for (const t of [two, three, four])
					expect(t.thinkingVerified).toBeGreaterThan(0);
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
				const cutOff = s.cutOff as Run;
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
				expect(cutOff.reply).toMatchObject({
					status: 200,
					stop: "max_tokens",
					content: [{ type: "text", text: "echo: MAXTOK recap" }],
				});
				expect(cutOff.upstream).toHaveLength(1);
				expect(cutOff.row).toMatchObject({ status: "completed" });
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
			"resumes a released park at its call, and only there",
			async () => {
				const s = scenario(await results(), "releasedParkResume");
				type Msg = { role: string; content: Array<Record<string, unknown>> };
				const [a, b] = s.toolUseIds as string[];
				expect(s.toolUseIds).toHaveLength(2);
				// SIGTERM writes nothing onto the conversation's chain.
				expect(s.addedByRelease).not.toContain("user");
				expect(s.addedByRelease).not.toContain("assistant");
				expect(s.resumeAtIsStoredEntry).toBe(true);

				// A plain resume answers the calls itself, as interrupted, and
				// the client's results never reach the model.
				const plain = s.plain as { messages: Msg[] };
				expect(JSON.stringify(plain.messages)).not.toContain("RELEASED-B");

				// Resumed at the call: the calls, then their results, image and
				// typed text in one user message, on the cached prefix.
				const resumed = s.resumed as {
					result: { subtype: string };
					reply: unknown;
					cache: { read: number };
					messages: Msg[];
				};
				expect(resumed.result.subtype).toBe("success");
				expect(resumed.reply).toEqual([
					{ type: "text", text: "done: RELEASED-A" },
				]);
				// The mock's prompt cache is shared by every scenario, so the
				// first call may already have read part of its prefix.
				expect(resumed.cache.read).toBe(
					(s.firstCallCacheRead as number) +
						(s.firstCallCacheCreation as number),
				);
				const [assistant, user] = resumed.messages.slice(-2) as [Msg, Msg];
				expect(assistant.role).toBe("assistant");
				expect(assistant.content.map((c) => c.type)).toEqual([
					"thinking",
					"tool_use",
					"tool_use",
				]);
				expect(typeof assistant.content[0]?.signature).toBe("string");
				expect(user.role).toBe("user");
				expect(
					user.content.map((c) => [c.type, c.tool_use_id ?? c.text]),
				).toEqual([
					["tool_result", a],
					["tool_result", b],
					["text", "TYPED-WITH-RESULTS"],
				]);
				expect(JSON.stringify(user.content[0])).toContain('"image"');
				const sent = JSON.stringify(resumed.messages);
				expect(sent).not.toContain("interrupted");
				expect(sent).not.toContain("No response requested");

				// The conversation's next turn resumes the session plainly.
				const next = s.next as { reply: unknown; messages: Msg[] };
				expect(next.reply).toEqual([
					{ type: "text", text: "echo: NEXT after release" },
				]);
				expect(JSON.stringify(next.messages)).toContain("RELEASED-B");
				expect(JSON.stringify(next.messages)).not.toContain("interrupted");

				// A resume point the session lacks fails before any model call.
				expect(s.unknownPoint).toMatchObject({
					subtype: "error_during_execution",
				});
				expect(
					(s.unknownPoint as { errors: string[] }).errors.join(" "),
				).toContain("No message found with message.uuid");
			},
			TIMEOUT,
		);

		it(
			"releases a parked turn and resumes it, in process and after a restart",
			async () => {
				const s = scenario(await results(), "releaseThenResume");
				type Shape = {
					cacheRead: number;
					text: string;
					tail: Array<{ role: string; blocks: unknown[] }>;
				};
				const inProcess = s.inProcess as Record<string, unknown> & {
					resumed: Shape;
				};
				expect(inProcess).toMatchObject({
					r1Stop: "tool_use",
					statusAfterPark: "released",
					childrenWhileReleased: 0,
					turnStatus: "completed",
					r2: {
						status: 200,
						stop: "end_turn",
						content: [{ type: "text", text: "done: RELEASED-RESULT" }],
					},
				});
				// The whole prefix the first call wrote is read back.
				expect(inProcess.resumed.cacheRead).toBe(
					inProcess.firstCacheCreation as number,
				);
				expect(inProcess.resumed.text).not.toContain("interrupted");
				expect(inProcess.resumed.text).not.toContain("No response requested");

				const restart = s.restart as Record<string, unknown> & {
					resumed: Shape;
				};
				expect(restart).toMatchObject({
					stop: "tool_use",
					toolUses: 2,
					statusBeforeRestart: "released",
					recovered: 1,
					turnStatus: "completed",
					parksLeft: 0,
					filesLeft: [],
					r3: {
						status: 200,
						content: [{ type: "text", text: "done: RESTART-A" }],
					},
				});
				expect(restart.resumed.cacheRead).toBeGreaterThan(0);
				const [assistant, user] = restart.resumed.tail as [
					{ role: string; blocks: unknown[][] },
					{ role: string; blocks: unknown[][] },
				];
				expect(assistant.role).toBe("assistant");
				expect(assistant.blocks.map((b) => b[0])).toEqual([
					"thinking",
					"tool_use",
					"tool_use",
				]);
				expect(assistant.blocks[0]?.[2]).toBe(true);
				const [, a, b] = assistant.blocks.map((x) => x[1]);
				expect(user.blocks).toEqual([
					["tool_result", a, ["text", "image"]],
					["tool_result", b, false],
					["text", null, false],
				]);
				expect(restart.resumed.text).toContain("TYPED-AFTER-RESTART");
				expect(restart.resumed.text).not.toContain("interrupted");
			},
			TIMEOUT,
		);

		it(
			"resumes parks released from resumed sessions and from a call after text",
			async () => {
				const s = scenario(await results(), "releasedParkOfResumedSession");
				type Leg = {
					stop: unknown;
					status: unknown;
					historyMode: unknown;
					reply: unknown;
					turnStatus: unknown;
					cacheRead: number | null;
					parkedCallCacheCreation: number | null;
					parkedCallCacheRead: number | null;
					resultReachedModel: boolean;
					resultBlocks: string[];
					lastMessage: unknown;
					expectedLastMessage: unknown;
					interrupted: boolean;
				};
				const released = (leg: Leg, historyMode: string, result: string) => {
					expect(leg).toMatchObject({
						stop: "tool_use",
						status: "released",
						historyMode,
						reply: {
							status: 200,
							stop: "end_turn",
							content: [{ type: "text", text: `done: ${result}` }],
						},
						turnStatus: "completed",
						resultReachedModel: true,
						resultBlocks: [result],
						interrupted: false,
					});
					// The client's result alone, with no text: nothing injected.
					expect(leg.lastMessage).toEqual(leg.expectedLastMessage);
					// The whole prefix the parked call sent is read back.
					expect(leg.cacheRead).toBe(
						(leg.parkedCallCacheRead ?? 0) + (leg.parkedCallCacheCreation ?? 0),
					);
				};
				expect(s.r1Stop).toBe("end_turn");
				released(s.second as Leg, "resume", "SECOND-RESULT");
				released(s.third as Leg, "resume", "THIRD-RESULT");
				// The next turn resumes the conversation with both results.
				expect(s.r4).toMatchObject({
					status: 200,
					content: [{ type: "text", text: "echo: NEXT after two releases" }],
				});
				expect(s.r4Carries).toEqual([
					"SECOND-RESULT",
					"THIRD-RESULT",
					"NEXT after two releases",
				]);
				expect(s.r4Interrupted).toBe(false);
				released(s.restart as Leg, "resume", "RESTART-RESULT");
				released(s.textThenCall as Leg, "fresh", "SAID-RESULT");
				expect(s.parksLeft).toBe(0);
			},
			TIMEOUT,
		);

		it(
			"resumes a turn released twice, on a first turn and on a resumed session",
			async () => {
				const s = scenario(await results(), "releasedTwiceInOneTurn");
				type Twice = {
					lastMessages: unknown[];
					expectedLastMessages: unknown[];
				};
				const twice = (leg: unknown, historyMode: string) => {
					// Each resume's last message is the client's result alone.
					expect((leg as Twice).lastMessages).toEqual(
						(leg as Twice).expectedLastMessages,
					);
					expect(leg).toMatchObject({
						historyMode,
						statuses: [200, 200, 200],
						stops: ["tool_use", "tool_use", "end_turn"],
						r3: { content: [{ type: "text", text: "done: FINAL-RESULT" }] },
						turnStatus: "completed",
						distinctCalls: 2,
						firstRelease: {
							status: "released",
							holdsCall: true,
							holdsAnyResult: false,
						},
						// The second park holds the client's first result, and no
						// answer the first resume loaded.
						secondRelease: {
							status: "released",
							holdsSecondCall: true,
							firstResults: ["AGAIN-FIRST"],
							emptyResults: 0,
						},
						emptyAfterSecondRelease: [],
						emptyAtEnd: [],
						modelCalls: 1,
						firstResults: ["AGAIN-FIRST"],
						secondResults: ["FINAL-RESULT"],
						interrupted: false,
					});
				};
				twice(s.firstTurn, "fresh");
				expect(s.openerStop).toBe("end_turn");
				twice(s.resumedTurn, "resume");
				expect(s.parksLeft).toBe(0);
			},
			TIMEOUT,
		);

		it(
			"resumes a park whose message also called a tool the client was not offered",
			async () => {
				const s = scenario(await results(), "releasedWithUnforwardedCall");
				const common = {
					r1Stop: "tool_use",
					forwarded: [["tool_use", "read"]],
					awaited: 1,
					r2: { status: 200, stop: "end_turn" },
					turnStatus: "completed",
					lastBlockTypes: ["tool_result", "tool_result"],
					interrupted: false,
				};
				// Claude Code runs the calls in order: the client's parks first,
				// so the stray one after it has no result when the turn is released.
				expect(s.strayAfter).toMatchObject({
					...common,
					parkedCalls: [
						["mcp__c__read", 0],
						["no_such_tool", 0],
					],
					resumedResults: [
						["mcp__c__read", ["CLIENT-RESULT"]],
						["no_such_tool", ["[Tool result missing due to internal error]"]],
					],
				});
				// Before it, Claude Code answers the stray call itself.
				expect(s.unmappedFirst).toMatchObject({
					...common,
					parkedCalls: [
						["mcp__c__unmapped_tool", 1],
						["mcp__c__read", 0],
					],
					resumedResults: [
						[
							"mcp__c__unmapped_tool",
							[
								"<tool_use_error>Error: No such tool available: mcp__c__unmapped_tool</tool_use_error>",
							],
						],
						["mcp__c__read", ["CLIENT-RESULT"]],
					],
				});
			},
			TIMEOUT,
		);

		type ChildPathsRun = {
			resumedReleased: string;
			restartReleased: string;
			stops: unknown[];
			historyModes: unknown[];
			tamperedHistory: { status: number; message: string };
			calls: Array<{
				status: number | null;
				thinkingVerified: number;
				excerptArrived: boolean;
				leaks: string[];
				clientCwdInSystem: boolean;
			}>;
		};

		/** The childPathsInContext run of one model family, checked to have run as intended. */
		async function childPathsRun(family: string): Promise<ChildPathsRun> {
			const run = scenario(await results(), "childPathsInContext")[
				family
			] as ChildPathsRun;
			// Two live tool rounds, a park released and resumed in process,
			// one resumed after a restart and calling again, two more turns,
			// and parallel calls answered with an image, text and typed text.
			expect(run.resumedReleased).toBe("released");
			expect(run.restartReleased).toBe("released");
			expect(run.stops).toEqual([
				"tool_use",
				"end_turn",
				"tool_use",
				"end_turn",
				"tool_use",
				"tool_use",
				"end_turn",
				"end_turn",
				"end_turn",
				"tool_use",
				"end_turn",
			]);
			expect(run.historyModes).toEqual([
				"fresh",
				"resume",
				"resume",
				"resume",
				"resume",
				"resume",
			]);
			expect(run.calls.length).toBeGreaterThanOrEqual(11);
			return run;
		}

		// Also the CLI-bump guard: a new wording of Claude Code's environment
		// block that the listener no longer recognises shows up here as a leak.
		it(
			"never shows the model Claude Code's own directories, only the client's",
			async () => {
				for (const family of ["sonnet", "opus", "fable", "drop"]) {
					const run = await childPathsRun(family);
					for (const call of run.calls) {
						expect(call.status).toBe(200);
						expect(call.leaks).toEqual([]);
						// pi's prompt names its cwd; the drop policy sends none.
						expect(call.clientCwdInSystem).toBe(family !== "drop");
					}
					// A block the client pasted, naming its own directory, stays.
					expect(run.calls.at(-1)?.excerptArrived).toBe(true);
				}
			},
			TIMEOUT,
		);

		it(
			"keeps signed thinking bound to its conversation across resumes, released parks and a restart",
			async () => {
				for (const family of ["opus", "fable"]) {
					const run = await childPathsRun(family);
					for (const call of run.calls) expect(call.status).toBe(200);
					// Every call after the first carried the earlier turns' thinking,
					// each checked against the history before it.
					expect(run.calls[0]?.thinkingVerified).toBe(0);
					for (const call of run.calls.slice(1))
						expect(call.thinkingVerified).toBeGreaterThan(0);
					expect(run.calls.at(-1)?.thinkingVerified).toBe(4);
					// Control: the check refuses a changed history.
					expect(run.tamperedHistory).toEqual({
						status: 400,
						message: expect.stringContaining(
							"bound to a different conversation",
						),
					});
				}
			},
			TIMEOUT,
		);

		it(
			"recovers a released park whose thinking was signed before the cut, with one refused call",
			async () => {
				const s = scenario(await results(), "thinkingCutover");
				for (const family of ["opus", "fable"]) {
					const run = s[family] as {
						released: string;
						signedBeforeCut: number;
						replies: Array<{ status: number; stop: string; text: string }>;
						turn: { status: string; counters: Record<string, number> };
						afterCut: Array<{
							status: number | null;
							carriesOld: boolean;
							cacheRead: number | null;
						}>;
					};
					expect(run.released).toBe("released");
					expect(run.signedBeforeCut).toBe(1);
					expect(run.replies).toEqual([
						{ status: 200, stop: "end_turn", text: "done: CUTOVER-RESULT" },
						{ status: 200, stop: "end_turn", text: "echo: THINK and then" },
						{ status: 200, stop: "end_turn", text: "echo: last" },
					]);
					expect(run.turn.status).toBe("completed");
					expect(run.turn.counters.innerErrors).toBe(1);
					// Claude Code drops the refused thinking and asks again at once,
					// reading the cached prefix; it never sends that thinking again.
					const [refused, retried, ...later] = run.afterCut;
					expect(refused).toMatchObject({ status: 400, carriesOld: true });
					expect(retried?.status).toBe(200);
					expect(retried?.carriesOld).toBe(false);
					expect(retried?.cacheRead).toBeGreaterThan(0);
					expect(later.length).toBeGreaterThanOrEqual(2);
					for (const call of later)
						expect(call).toMatchObject({ status: 200, carriesOld: false });
				}
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
