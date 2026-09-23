import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
	SpawnedProcess,
	SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

function isMusl(): boolean {
	const arch =
		process.arch === "x64"
			? "x86_64"
			: process.arch === "arm64"
				? "aarch64"
				: process.arch;
	return existsSync(`/lib/ld-musl-${arch}.so.1`);
}

/**
 * The Claude Code binary the SDK bundles for this platform, resolved once and
 * synchronously so availability is known before the first turn (and so the
 * SDK never runs its own libc probe, which blocks the event loop).
 */
export function resolveClaudeExecutable():
	| { path: string }
	| { error: string } {
	const libc = process.platform === "linux" && isMusl() ? "-musl" : "";
	const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}`;
	const binary = process.platform === "win32" ? "claude.exe" : "claude";
	try {
		const require = createRequire(import.meta.url);
		const manifest = require.resolve(`${pkg}/package.json`);
		const path = join(dirname(manifest), binary);
		if (!existsSync(path)) return { error: `${pkg} has no ${binary} binary` };
		return { path };
	} catch (error) {
		return {
			error: `Claude Code binary package ${pkg} is not installed (${error instanceof Error ? error.message : String(error)})`,
		};
	}
}

/** Peak resident set size of a live process, from /proc. Null where unreadable. */
export function readPeakRssBytes(pid: number): number | null {
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const match = /^VmHWM:\s+(\d+)\s+kB/m.exec(status);
		return match ? Number(match[1]) * 1024 : null;
	} catch {
		return null;
	}
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		// Negative pid: the whole process group the child leads.
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

/**
 * Starts Claude Code in its own process group and remembers every child, so a
 * teardown can kill the child and anything it started, and a final dispose can
 * SIGKILL whatever is left.
 */
export class ProcessGroupSpawner {
	private readonly live = new Map<number, ChildProcess>();

	constructor(
		private readonly onStderr: (pid: number, text: string) => void = () => {},
	) {}

	get pids(): number[] {
		return [...this.live.keys()];
	}

	spawn(
		options: SpawnOptions,
		onSpawn?: (pid: number) => void,
	): SpawnedProcess {
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env as NodeJS.ProcessEnv,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
			windowsHide: true,
		});
		const pid = child.pid;
		if (pid !== undefined) {
			this.live.set(pid, child);
			onSpawn?.(pid);
			child.once("exit", () => this.live.delete(pid));
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (text: string) => this.onStderr(pid, text));
			// The SDK aborts this signal only after closing stdin and a grace
			// period, so the child has already had its chance to exit cleanly.
			options.signal.addEventListener(
				"abort",
				() => this.kill(pid, "SIGTERM"),
				{ once: true },
			);
		}
		return child as unknown as SpawnedProcess;
	}

	isAlive(pid: number): boolean {
		return this.live.has(pid);
	}

	kill(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
		signalGroup(pid, signal);
	}

	killAll(signal: NodeJS.Signals = "SIGKILL"): void {
		for (const pid of this.live.keys()) signalGroup(pid, signal);
	}
}
