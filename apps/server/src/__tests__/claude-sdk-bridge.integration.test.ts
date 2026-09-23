/**
 * pi-style clients on /wire/openai (Responses and Chat Completions) served by
 * the real Claude Code binary through a composed ClankerMux gateway, whose two
 * official Anthropic OAuth accounts point at a loopback mock upstream.
 *
 * The scenarios run in a child process inside a fresh network namespace that
 * has nothing but loopback (`unshare -rn`), so neither the gateway nor Claude
 * Code can reach Anthropic whatever they try. Where user namespaces are
 * unavailable the suite is skipped with the reason printed; it never runs with
 * egress.
 */
import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudeExecutable } from "../../../../packages/claude-sdk-bridge/src/spawn";

const SCRIPT = join(
	import.meta.dir,
	"fixtures",
	"sdk-bridge-gateway-scenarios.ts",
);
const TIMEOUT = 600_000;

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
		`[claude-sdk-bridge] gateway integration with real Claude Code SKIPPED: ${reason}`,
	);

type Scenario = Record<string, unknown> & { ok?: boolean; error?: string };
type Results = Record<string, unknown>;

interface Reply {
	status: number;
	requestId: string | null;
	retryAfter: string | null;
	answer: string;
	toolCalls: Array<{ id: string; name: string; arguments: string }>;
	error: string | null;
	elapsedMs: number;
}
type Row = Record<string, unknown>;

/** Account rows with the per-run ids dropped, for comparing two runs. */
function withoutIds(rows: unknown): Row[] {
	return (rows as Row[]).map(({ id: _id, ...rest }) => rest);
}

let pending: Promise<Results> | null = null;

function results(): Promise<Results> {
	pending ??= new Promise((resolve, reject) => {
		const dir = mkdtempSync(join(tmpdir(), "cmx-gateway-it-"));
		const home = join(dir, "home");
		mkdirSync(home);
		const out = join(dir, "results.json");
		const child = spawn(
			"unshare",
			["-rn", "sh", "-c", `ip link set lo up && bun '${SCRIPT}' '${out}'`],
			{
				stdio: ["ignore", "inherit", "inherit"],
				// A throwaway HOME: nothing the gateway or Claude Code writes lands in
				// the real one.
				env: { ...process.env, HOME: home, XDG_CACHE_HOME: join(dir, "cache") },
			},
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

async function scenario(name: string): Promise<Scenario> {
	const s = (await results())[name] as Scenario | undefined;
	if (!s?.ok) throw new Error(`${name} failed: ${JSON.stringify(s)}`);
	// Every scenario ends with no Claude Code process left and the bridge idle,
	// and nothing in the gateway process tried to reach Anthropic.
	expect(s.bridgeIdle).toBe(true);
	expect(s.processesGone).toBe(true);
	expect(
		(s.blockedEgress as string[]).filter((h) => /anthropic|claude/i.test(h)),
	).toEqual([]);
	return s;
}

describe.skipIf(reason !== null)(
	"SDK bridge through the gateway, real Claude Code, loopback only",
	() => {
		it(
			"cannot reach the network; the mock saw only Messages calls; no process outlived the run",
			async () => {
				const r = await results();
				expect(r.egressBlocked).toBe(true);
				for (const path of r.upstreamPaths as string[])
					expect(path).toMatch(/^POST \/v1\/messages(\?beta=true)?$/);
				expect(r.leftoverChildren).toBe(0);
				expect(r.exit).toBeUndefined();
			},
			TIMEOUT,
		);

		for (const endpoint of ["responses", "chat"] as const) {
			const name = (s: string) => `${endpoint}.${s}`;

			it(
				`${endpoint}: G1 swaps credentials and records the turn under the outer client`,
				async () => {
					const s = await scenario(name("g1CredentialSwap"));
					const reply = s.reply as Reply;
					expect(reply.status).toBe(200);
					expect(reply.answer).toBe("echo: hello via gateway");
					// The account's Bearer, never the client's key; ClankerMux adds
					// the OAuth beta; nothing internal leaks; honestly labelled.
					expect(s.authorization).toStartWith("Bearer sk-ant-oat01-ACCT-A-");
					expect(s.carriesClientKey).toBe(false);
					expect(s.beta).toContain("oauth-2025-04-20");
					expect(s.leakedHeaders).toEqual([]);
					expect(s.userAgent).toContain("sdk-ts");
					const [turn] = s.turns as Row[];
					const [leg] = s.legs as Row[];
					const [inner] = s.innerRows as Row[];
					expect(leg?.id).toBe(reply.requestId);
					expect(leg?.turn_id).toBe(turn?.id);
					expect(turn).toMatchObject({
						history_mode: "fresh",
						client_harness: "pi",
					});
					expect(inner).toMatchObject({
						sdk_bridge_turn_id: turn?.id,
						client_harness: "pi",
						api_key_id: s.apiKeyId,
						status_code: 200,
					});
				},
				TIMEOUT,
			);

			it(
				`${endpoint}: G2 round-trips a tool call and resumes the next user turn on one account`,
				async () => {
					const s = await scenario(name("g2ToolRoundTrip"));
					const [r1, r2, r3] = [s.r1, s.r2, s.r3] as Reply[];
					expect(r1?.toolCalls).toEqual([
						{
							id: expect.any(String),
							name: "read",
							arguments: '{"path":"a.txt"}',
						},
					]);
					expect(r2?.answer).toBe("done: GW-CONTENT");
					expect(r3?.answer).toBe("echo: third turn");
					expect(s.upstreamAccounts as string[]).toHaveLength(1);
					expect(new Set(s.cliRetries as string[])).toEqual(new Set(["0"]));
					const turns = s.turns as Row[];
					const legs = s.legs as Row[];
					expect(turns).toHaveLength(2);
					expect(turns[0]).toMatchObject({
						history_mode: "fresh",
						status: "completed",
					});
					// The second user turn resumes the Claude Code session: the
					// history the client sent back matched what the bridge recorded.
					expect(turns[1]?.history_mode).toBe("resume");
					expect(turns[1]?.rebuild_reason).toBeNull();
					expect(legs.map((l) => [l.id, l.turn_id, l.kind])).toEqual([
						[r1?.requestId, turns[0]?.id, "start"],
						[r2?.requestId, turns[0]?.id, "continue"],
						[r3?.requestId, turns[1]?.id, "start"],
					]);
					const inner = s.innerRows as Row[];
					expect(inner.map((row) => row.sdk_bridge_turn_id)).toEqual([
						turns[0]?.id,
						turns[0]?.id,
						turns[1]?.id,
					]);
					expect(new Set(inner.map((row) => row.client_harness))).toEqual(
						new Set(["pi"]),
					);
				},
				TIMEOUT,
			);

			it(
				`${endpoint}: G3 a client abort cancels the upstream call and ends the child`,
				async () => {
					const s = await scenario(name("g3Abort"));
					expect(s.liveDuring).toBe(1);
					expect(s.processesDuring).toBeGreaterThanOrEqual(1);
					expect(s.clientSaw).toBe("aborted");
					expect(s.upstreamAborted).toBe(true);
					expect(s.legs).toEqual([
						expect.objectContaining({
							http_status: 499,
							error_type: "client_closed_request",
						}),
					]);
				},
				TIMEOUT,
			);

			it(
				`${endpoint}: G4 one 529 reaches the client as 529 with Retry-After (Claude Code does not retry)`,
				async () => {
					const s = await scenario(name("g4OneOverload"));
					const reply = s.reply as Reply;
					expect(reply.status).toBe(529);
					expect(Number(reply.retryAfter)).toBeGreaterThan(0);
					expect(reply.error).toContain("mock 529");
					expect(s.upstream).toEqual([
						expect.objectContaining({ status: 529, cliRetry: "0" }),
					]);
				},
				TIMEOUT,
			);

			it(
				`${endpoint}: G5 a 429 on one account fails over inside one Claude Code attempt`,
				async () => {
					const s = await scenario(name("g5FailoverInsideOneAttempt"));
					const reply = s.reply as Reply;
					expect(reply.status).toBe(200);
					expect(reply.answer).toBe("echo: 429 on A");
					const upstream = s.upstream as Row[];
					expect(upstream.map((u) => u.status)).toEqual([429, 200]);
					expect(upstream[0]?.account).not.toBe(upstream[1]?.account);
					expect(new Set(upstream.map((u) => u.cliRetry))).toEqual(
						new Set(["0"]),
					);
				},
				TIMEOUT,
			);

			it(
				`${endpoint}: G6 a 429 on every account is a fast error with Retry-After`,
				async () => {
					const s = await scenario(name("g6AllRateLimited"));
					const reply = s.reply as Reply;
					expect(reply.status).toBe(503);
					expect(Number(reply.retryAfter)).toBeGreaterThan(0);
					// Claude Code's own backoff made this 594 s in the spike.
					expect(s.sinceFirstUpstreamMs as number).toBeLessThan(5_000);
					expect(reply.elapsedMs).toBeLessThan(30_000);
					const upstream = s.upstream as Row[];
					expect(upstream.map((u) => u.status)).toEqual([429, 429]);
					expect(new Set(upstream.map((u) => u.cliRetry))).toEqual(
						new Set(["0"]),
					);
				},
				TIMEOUT,
			);

			it(
				`${endpoint}: an out_of_credits 429 gets the account's long cooldown, as direct traffic does, and the turn fails over`,
				async () => {
					const s = await scenario(name("overage429"));
					expect((s.reply as Reply).status).toBe(200);
					expect((s.upstream as Row[]).map((u) => u.status)).toEqual([
						429, 200,
					]);
					expect(s.accounts).toEqual([
						expect.objectContaining({
							paused: 0,
							rate_limited_reason: "out_of_credits",
							cooling: 1,
						}),
						expect.objectContaining({ paused: 0, rate_limited_reason: null }),
					]);
					const direct = await scenario("direct.overage429");
					expect(direct.status).toBe(200);
					expect(withoutIds(s.accounts)).toEqual(withoutIds(direct.accounts));
				},
				TIMEOUT,
			);

			it(
				`${endpoint}: an "out of extra usage" 400 reaches the client verbatim and changes no account, as for direct traffic`,
				async () => {
					const s = await scenario(name("overage400"));
					const reply = s.reply as Reply;
					expect(reply.status).toBe(400);
					expect(reply.error).toContain("You're out of extra usage.");
					expect(s.accounts).toEqual([
						expect.objectContaining({
							paused: 0,
							rate_limited_reason: null,
							rate_limited_until: null,
						}),
						expect.objectContaining({
							paused: 0,
							rate_limited_reason: null,
							rate_limited_until: null,
						}),
					]);
					const direct = await scenario("direct.overage400");
					expect(direct.status).toBe(400);
					expect(direct.text).toContain("You're out of extra usage.");
					expect(withoutIds(s.accounts)).toEqual(withoutIds(direct.accounts));
				},
				TIMEOUT,
			);
		}
	},
);
