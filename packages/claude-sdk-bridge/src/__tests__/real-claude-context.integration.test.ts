/**
 * What the bundled Claude Code binary does on its own to a bridged
 * conversation's context and model, with the bridge's options and
 * environment: compaction, context editing, tool-result persistence and model
 * fallback. Each scenario that changes the environment keeps a control that
 * shows the mechanism firing, so a pass means the bridge's settings stop it,
 * not that the scenario never reached it.
 *
 * The scenarios run in a child process inside a fresh network namespace that
 * has nothing but loopback (`unshare -rn`), as in
 * `real-claude.integration.test.ts`. Where user namespaces are unavailable the
 * suite is skipped with the reason printed; it never runs with egress.
 */
import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudeExecutable } from "../spawn";

const SCRIPT = join(
	import.meta.dir,
	"fixtures",
	"real-claude-context-scenarios.ts",
);
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
		`[claude-sdk-bridge] real Claude Code context integration SKIPPED: ${reason}`,
	);

interface Call {
	status: number | null;
	model: string | null;
	betas: string[];
	bodyKeys: string[];
	messageCount: number;
	contextManagement: unknown;
	clearAt: boolean;
	summaryRequest: boolean;
	carriesSummary: boolean;
	clearedToolResult: boolean;
	persistedOutput: boolean;
	lastUserChars: number;
	toolResults: number;
	toolResultChars: number[];
}

interface Run {
	calls: Call[];
	tokenCounts: number;
	messages: Array<Record<string, unknown>>;
	result: {
		subtype: string;
		isError: boolean;
		terminalReason: string | null;
		result: string | null;
	} | null;
	systemSubtypes: string[];
}

interface Bridged {
	turnId: string;
	status: number;
	headers: Record<string, string>;
	body: string | null;
	replyModel: unknown;
	stop: unknown;
	text: string;
	row: {
		status: string;
		historyMode: string;
		rebuildReason: string | null;
		counters: { innerCalls: number; innerErrors: number };
	} | null;
	calls: Call[];
}

type Results = Record<string, unknown> & { egressBlocked?: unknown };

let pending: Promise<Results> | null = null;

function results(): Promise<Results> {
	pending ??= new Promise((resolve, reject) => {
		const dir = mkdtempSync(join(tmpdir(), "sdk-bridge-context-it-"));
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
				if (code !== 0) parsed.exit = { code };
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

async function scenario<T = Record<string, Run>>(name: string): Promise<T> {
	const s = (await results())[name] as ({ ok?: boolean } & T) | undefined;
	if (!s?.ok) throw new Error(`${name} failed: ${JSON.stringify(s)}`);
	return s;
}

/** Nothing in the run summarized, cleared or marked a compaction. */
function expectUncompacted(run: Run) {
	expect(run.calls.some((c) => c.summaryRequest)).toBe(false);
	expect(run.calls.some((c) => c.carriesSummary)).toBe(false);
	expect(run.calls.some((c) => c.clearedToolResult)).toBe(false);
	expect(run.systemSubtypes).not.toContain("compact_boundary");
	expect(run.systemSubtypes).not.toContain("microcompact_boundary");
}

const UNCOMPACTING_ENVS = [
	"bridge",
	"bridgePlusDisableCompact",
	"disableCompactOnly",
] as const;

describe.skipIf(reason !== null)(
	"real Claude Code's own context and model changes, on the bridge's options",
	() => {
		it(
			"cannot reach the network",
			async () => {
				expect((await results()).egressBlocked).toBe(true);
			},
			TIMEOUT,
		);

		it(
			"never auto-compacts: past the window the next call is refused, in the turn and after a resume",
			async () => {
				const s =
					await scenario<Record<string, { first: Run; second: Run }>>(
						"autoCompact",
					);
				for (const env of UNCOMPACTING_ENVS) {
					const { first, second } = s[env] as { first: Run; second: Run };
					expectUncompacted(first);
					expectUncompacted(second);
					// Only the call that reported 250k tokens went out; the result
					// never reached the model, and the resumed turn made no call.
					expect(first.calls).toHaveLength(1);
					expect(second.calls).toHaveLength(1);
					expect(first.result).toMatchObject({
						isError: true,
						terminalReason: "blocking_limit",
					});
					expect(second.result).toMatchObject({
						isError: true,
						terminalReason: "blocking_limit",
					});
				}
				// Control: without DISABLE_AUTO_COMPACT the same usage compacts,
				// and the resumed turn sends the summary instead of the history.
				const on = s.autoCompactOn as { first: Run; second: Run };
				expect(on.first.calls.some((c) => c.summaryRequest)).toBe(true);
				expect(on.first.systemSubtypes).toContain("compact_boundary");
				expect(on.second.calls.at(-1)?.carriesSummary).toBe(true);
			},
			TIMEOUT,
		);

		it(
			"never compacts reactively: a prompt_too_long 400 ends the turn",
			async () => {
				const s = await scenario("reactiveCompact");
				for (const env of UNCOMPACTING_ENVS) {
					const run = s[env] as Run;
					expectUncompacted(run);
					expect(run.calls.map((c) => c.status)).toEqual([200, 200, 200, 400]);
					expect(run.result).toMatchObject({
						isError: true,
						terminalReason: "prompt_too_long",
					});
				}
				// Control: auto-compact on summarizes and retries.
				const on = s.autoCompactOn as Run;
				expect(on.calls.some((c) => c.summaryRequest)).toBe(true);
				expect(on.systemSubtypes).toContain("compact_boundary");
				expect(on.result).toMatchObject({
					isError: false,
					terminalReason: "completed",
				});
			},
			TIMEOUT,
		);

		it(
			"never clears old tool results, over many rounds or on a 422",
			async () => {
				const s = await scenario<{ manyRounds: Run; hint422: Run }>(
					"microcompact",
				);
				const many = s.manyRounds;
				expectUncompacted(many);
				expect(many.calls).toHaveLength(13);
				const last = many.calls.at(-1) as Call;
				expect(last.toolResults).toBe(12);
				expect(new Set(last.toolResultChars).size).toBe(1);
				expect(last.toolResultChars[0]).toBeGreaterThan(20_000);
				// The context-hint request field and its beta never go out.
				for (const call of many.calls) {
					expect(call.bodyKeys).not.toContain("context_hint");
					expect(call.betas).not.toContain("context-hint-2026-04-09");
				}
				expect(many.result).toMatchObject({ terminalReason: "completed" });

				const hint = s.hint422;
				expectUncompacted(hint);
				expect(hint.calls.map((c) => c.status)).toEqual([200, 200, 422]);
				expect(hint.result).toMatchObject({
					isError: true,
					terminalReason: "api_error",
				});
			},
			TIMEOUT,
		);

		it(
			"asks for server-side context editing that keeps every thinking block, and nothing else",
			async () => {
				const r = await results();
				const calls: Call[] = [];
				const walk = (x: unknown) => {
					if (Array.isArray(x)) for (const v of x) walk(v);
					else if (x && typeof x === "object") {
						const calls_ = (x as { calls?: unknown }).calls;
						if (Array.isArray(calls_)) calls.push(...(calls_ as Call[]));
						for (const v of Object.values(x)) walk(v);
					}
				};
				walk(r);
				expect(calls.length).toBeGreaterThan(50);
				for (const call of calls) {
					expect(call.contextManagement).toEqual({
						edits: [{ type: "clear_thinking_20251015", keep: "all" }],
					});
					expect(call.betas).toContain("context-management-2025-06-27");
					expect(call.clearAt).toBe(false);
				}
			},
			TIMEOUT,
		);

		it(
			"hands the model client tool results whole up to 500,000 characters, with the bridge's tool listing",
			async () => {
				const s = await scenario<Record<string, Run>>("largeToolResult");
				const sent = (name: string) => s[name]?.calls.at(-1) as Call;
				const reply = (name: string) => String(s[name]?.result?.result);
				// The bridge's listing declares anthropic/maxResultSizeChars 500,000.
				for (const size of [51_000, 120_000, 499_000]) {
					const call = sent(`bridge ${size}`);
					expect(call.persistedOutput).toBe(false);
					expect(call.toolResultChars[0]).toBeGreaterThan(size);
				}
				// Claude Code's own ceiling, which the bridge refuses before it.
				expect(sent("bridge 501000").persistedOutput).toBe(true);
				// Control, the listing without the declaration: whole up to 50,000
				// characters, then a 2 KB preview naming a file the model has no
				// tool to read, and past MAX_MCP_OUTPUT_TOKENS (25,000 tokens by
				// /count_tokens) an error string.
				expect(sent("undeclared 49000").persistedOutput).toBe(false);
				expect(sent("undeclared 51000").persistedOutput).toBe(true);
				expect(sent("undeclared 51000").toolResultChars[0]).toBeLessThan(3_000);
				expect(reply("undeclared 120000")).toContain(
					"exceeds maximum allowed tokens",
				);
				expect(s["undeclared 120000"]?.tokenCounts).toBe(1);
				// Raising MAX_MCP_OUTPUT_TOKENS alone only swaps the error for the preview.
				expect(
					sent("undeclaredMaxMcpOutputTokens 120000").persistedOutput,
				).toBe(true);
				// Five 45 KB results in one message stay whole: no aggregate budget.
				const fan = sent("fanout");
				expect(fan.toolResults).toBe(5);
				expect(fan.persistedOutput).toBe(false);
				for (const chars of fan.toolResultChars)
					expect(chars).toBeGreaterThan(45_000);
			},
			TIMEOUT,
		);

		it(
			"sends a client message starting with /compact as text",
			async () => {
				const s =
					await scenario<Record<string, { first: Run; second: Run }>>(
						"slashCompact",
					);
				for (const env of [
					"bridge",
					"bridgePlusDisableCompact",
					"autoCompactOn",
				]) {
					const { second } = s[env] as { second: Run };
					expectUncompacted(second);
					expect(second.result?.result).toContain("echo: /compact");
				}
			},
			TIMEOUT,
		);

		it(
			"refuses a call itself past a bare id's 200k window, and past 1M for [1m]",
			async () => {
				const s = await scenario("window");
				const outcome = (name: string) => ({
					calls: s[name]?.calls.length,
					terminal: s[name]?.result?.terminalReason,
				});
				expect(outcome("claude-sonnet-5 150000")).toEqual({
					calls: 2,
					terminal: "completed",
				});
				expect(outcome("claude-sonnet-5 250000")).toEqual({
					calls: 1,
					terminal: "blocking_limit",
				});
				expect(outcome("claude-opus-5-5[1m] 900000")).toEqual({
					calls: 2,
					terminal: "completed",
				});
				expect(outcome("claude-opus-5-5[1m] 1020000")).toEqual({
					calls: 1,
					terminal: "blocking_limit",
				});
			},
			TIMEOUT,
		);

		it(
			"never switches model on an overload",
			async () => {
				const s = await scenario("overloaded");
				for (const [model, wire] of [
					["claude-sonnet-5", "claude-sonnet-5"],
					["claude-fable-5-1", "claude-fable-5-1"],
					["claude-opus-5-5", "claude-opus-5-5"],
					["claude-opus-5-5[1m]", "claude-opus-5-5"],
				] as const) {
					const run = s[model] as Run;
					expect(run.calls.map((c) => [c.status, c.model])).toEqual([
						[529, wire],
					]);
					expect(run.result).toMatchObject({ terminalReason: "api_error" });
					expect(run.systemSubtypes).not.toContain("model_fallback");
				}
			},
			TIMEOUT,
		);

		it(
			"keeps a refusal on the requested model; without CLAUDE_CODE_NO_MODEL_FALLBACK, Fable 5.1 and Opus 5.5 retry on Opus 4.8",
			async () => {
				const s = await scenario("refusal");
				for (const [model, wire] of [
					["claude-sonnet-5", "claude-sonnet-5"],
					["claude-fable-5-1", "claude-fable-5-1"],
					["claude-opus-5-5", "claude-opus-5-5"],
					["claude-opus-5-5[1m]", "claude-opus-5-5"],
				] as const) {
					const run = s[model] as Run;
					expect(run.calls.map((c) => c.model)).toEqual([wire]);
					expect(run.systemSubtypes).toContain("model_refusal_no_fallback");
					expect(run.systemSubtypes).not.toContain("model_refusal_fallback");
				}
				// No call anywhere asks the server to fall back on its own.
				for (const run of Object.values(s))
					for (const call of (run as Run).calls ?? [])
						expect(call.betas.join(",")).not.toContain("server-side-fallback");
				// Control: the same refusal without the setting.
				const on = await scenario("refusalFallbackOn");
				for (const model of ["claude-fable-5-1", "claude-opus-5-5"]) {
					const run = on[model] as Run;
					expect(run.calls.map((c) => c.model)).toEqual([
						model,
						"claude-opus-4-8",
					]);
					expect(run.systemSubtypes).toContain("model_refusal_fallback");
				}
			},
			TIMEOUT,
		);

		it(
			"sends a [1m] model as its bare id with the 1M beta on every call, resumed included",
			async () => {
				const s = await scenario<{ first: Run; second: Run }>("oneMillion");
				const calls = s.second.calls;
				expect(calls.length).toBeGreaterThanOrEqual(3);
				for (const call of calls) {
					expect(call.model).toBe("claude-opus-5-5");
					expect(call.betas).toContain("context-1m-2025-08-07");
				}
			},
			TIMEOUT,
		);

		it(
			"through the bridge: a refusal reaches the client with stop_reason refusal, and the turn completes",
			async () => {
				const s = await scenario<{ refusal: Record<string, Bridged> }>(
					"bridged",
				);
				for (const model of [
					"claude-sonnet-5",
					"claude-fable-5-1",
					"claude-opus-5-5",
				]) {
					const turn = s.refusal[model] as Bridged;
					expect(turn.calls.map((c) => c.model)).toEqual([model]);
					expect(turn).toMatchObject({
						status: 200,
						replyModel: model,
						stop: "refusal",
					});
					expect(turn.row?.status).toBe("completed");
					expect(turn.row?.counters.innerErrors).toBe(0);
				}
			},
			TIMEOUT,
		);

		it(
			"through the bridge: the reply names the model the upstream reported",
			async () => {
				const s = await scenario<{ reported: Bridged }>("bridged");
				expect(s.reported.calls.map((c) => c.model)).toEqual([
					"claude-sonnet-5",
				]);
				expect(s.reported.replyModel).toBe("claude-haiku-4-5");
			},
			TIMEOUT,
		);

		it(
			"through the bridge: overflow reaches the client as context_length_exceeded, never compacted",
			async () => {
				const s = await scenario<{
					reactive: Bridged;
					blocking: Bridged;
					blockingResult: Bridged;
				}>("bridged");
				const overflow = {
					type: "error",
					error: {
						type: "invalid_request_error",
						code: "context_length_exceeded",
					},
				};
				expect(s.reactive.status).toBe(400);
				expect(JSON.parse(String(s.reactive.body))).toMatchObject(overflow);
				expect(s.reactive.calls.map((c) => c.status)).toEqual([400]);
				// The tool call goes out; its result meets the blocking limit.
				expect(s.blocking.stop).toBe("tool_use");
				expect(s.blockingResult.status).toBe(400);
				expect(JSON.parse(String(s.blockingResult.body))).toMatchObject(
					overflow,
				);
				expect(s.blockingResult.calls).toHaveLength(1);
				for (const turn of [s.reactive, s.blockingResult])
					expect(turn.calls.some((c) => c.summaryRequest)).toBe(false);
			},
			TIMEOUT,
		);

		it(
			"through the bridge: a live 60 KB tool result reaches the model whole, one past 500,000 characters is refused",
			async () => {
				const s = await scenario<{
					bigLive: Bridged;
					hugeRefused: Bridged;
					hugeStillWaits: boolean;
					bigRebuild: Bridged;
				}>("bridged");
				const live = s.bigLive.calls.at(-1) as Call;
				expect(live.persistedOutput).toBe(false);
				expect(live.toolResultChars[0]).toBeGreaterThan(60_000);
				expect(s.hugeRefused.status).toBe(400);
				expect(JSON.parse(String(s.hugeRefused.body))).toMatchObject({
					error: {
						type: "invalid_request_error",
						code: "sdk_bridge_tool_result_too_large",
					},
				});
				// Nothing reached the model, and the turn still waits on its call.
				expect(s.hugeRefused.calls).toHaveLength(1);
				expect(s.hugeStillWaits).toBe(true);
				expect(s.bigRebuild.row?.historyMode).toBe("rebuild_transcript");
				const rebuilt = s.bigRebuild.calls[0] as Call;
				expect(rebuilt.persistedOutput).toBe(false);
				expect(rebuilt.toolResultChars).toEqual([60_000]);
			},
			TIMEOUT,
		);

		it(
			"through the bridge: results past 500,000 characters carried as message content reach the model whole",
			async () => {
				const s = await scenario<
					Record<string, Bridged> & { statusBefore?: unknown }
				>("bigHistory");
				expect(s.statusBefore as unknown).toBe("released");
				for (const [name, mode, reason] of [
					["transcript", "rebuild_transcript", "unknown"],
					["flattened", "rebuild_flattened", "unknown"],
					["dead", "rebuild_flattened", "dead_continuation"],
				] as const) {
					const turn = s[name] as Bridged;
					expect(turn.status).toBe(200);
					expect(turn.row).toMatchObject({
						status: "completed",
						historyMode: mode,
						rebuildReason: reason,
					});
					const call = turn.calls.at(-1) as Call;
					expect(call.persistedOutput).toBe(false);
					expect(
						Math.max(call.lastUserChars, ...call.toolResultChars),
					).toBeGreaterThanOrEqual(600_000);
				}
				// A released park's resume hands the results over as its prompt.
				const resumed = s.resumed as Bridged;
				expect(resumed.status).toBe(200);
				expect(resumed.calls.at(-1)?.toolResultChars).toEqual([600_000]);
			},
			TIMEOUT,
		);

		it(
			"through the bridge: every response names its turn's history decision, an account change included",
			async () => {
				const s = await scenario<{
					accountChange: { first: Bridged; second: Bridged };
					reactive: Bridged;
					hugeRefused: Bridged;
				}>("bridged");
				const { first, second } = s.accountChange;
				expect(second.row).toMatchObject({
					historyMode: "resume",
					rebuildReason: "account_change",
				});
				const history = (turn: Bridged) =>
					turn.headers["x-clankermux-sdk-bridge-history"];
				expect(history(first)).toBe("fresh");
				expect(history(second)).toBe("resume; reason=account_change");
				// Errors too: a turn's own, and a refused continuation leg's.
				expect(history(s.reactive)).toBe("rebuild_transcript; reason=unknown");
				expect(history(s.hugeRefused)).toBe("fresh");
			},
			TIMEOUT,
		);
	},
);
