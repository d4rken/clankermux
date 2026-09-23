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
				expect(s.upstreamTools).toEqual(["mcp__client__read"]);
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
