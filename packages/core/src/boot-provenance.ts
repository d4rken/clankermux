/**
 * Which commit the RUNNING process was started from.
 *
 * The checkout is the deployment: systemd's WorkingDirectory is the live tree,
 * so merging into main without restarting moves HEAD under a running process.
 * Everything that reads git at request time (`/api/version/check`) then reports
 * the NEW commit as "current" while the old code is still serving traffic.
 * Capturing HEAD once at boot is what makes that divergence visible.
 *
 * The signal is precisely "checkout HEAD changed since boot" — comparing SHAs
 * does NOT detect tracked files edited in place without moving HEAD, and no
 * caller may word it as if it did.
 */

export interface BootProvenance {
	sha: string;
	shortSha: string;
	/** ISO-8601 committer date of the booted commit. */
	date: string;
	/** Epoch ms at which the provenance was captured (process boot). */
	bootedAt: number;
}

/** What a commit reader has to supply; the rest is derived. */
export interface CommitRead {
	sha: string;
	date: string;
}

/**
 * Read HEAD from the checkout the process is running out of.
 *
 * Deliberately local rather than shared with the version handler's `runGit`:
 * `@clankermux/core` cannot depend on `@clankermux/http-api` (the dependency
 * runs the other way), and this needs exactly one query where the handler needs
 * several.
 */
function readHeadCommit(): CommitRead | null {
	try {
		const sha = runGit(["rev-parse", "HEAD"]);
		if (!sha) return null;
		return { sha, date: runGit(["show", "-s", "--format=%cI", "HEAD"]) ?? "" };
	} catch {
		return null;
	}
}

function runGit(args: string[]): string | null {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) return null;
	return new TextDecoder().decode(proc.stdout).trim();
}

let provenance: BootProvenance | null = null;
let captureAttempted = false;

/**
 * Record the commit this process booted on. Idempotent: the first call decides,
 * later calls are no-ops that return the same value — including the failure
 * case, which is not retried (a later retry would read a moved HEAD and stamp
 * it as the boot commit).
 */
export function captureBootProvenance(options?: {
	readCommit?: () => CommitRead | null;
	now?: () => number;
}): BootProvenance | null {
	if (captureAttempted) return provenance;
	captureAttempted = true;

	const commit = (options?.readCommit ?? readHeadCommit)();
	if (!commit) return null;

	provenance = {
		sha: commit.sha,
		shortSha: commit.sha.slice(0, 7),
		date: commit.date,
		bootedAt: (options?.now ?? Date.now)(),
	};
	return provenance;
}

/**
 * The commit this process booted on, or null when it was never captured or
 * could not be read. Never captures on demand — doing so would stamp request
 * time instead of boot time, which is exactly the bug this module exists for.
 */
export function getBootProvenance(): BootProvenance | null {
	return provenance;
}

/**
 * True when the checkout's HEAD has moved away from the commit the process
 * booted on, i.e. a restart would change the running code. Null on either side
 * means "no signal" — never an invented one.
 */
export function isRestartPending(
	boot: BootProvenance | null,
	currentSha: string | null | undefined,
): boolean {
	if (!boot || !currentSha) return false;
	return boot.sha !== currentSha;
}

/** Test-only handle: forget the captured provenance so capture can be re-run. */
export const __bootProvenanceTestHooks = {
	reset(): void {
		provenance = null;
		captureAttempted = false;
	},
};
