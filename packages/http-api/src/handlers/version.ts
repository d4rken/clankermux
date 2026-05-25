import { readEnv } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "../utils/http-error";

const log = new Logger("VersionHandler");

// ClankerMux is build-from-source + systemd only (never published to npm), so
// "is there an update?" means "does the main branch of our GitHub repo have a
// commit this checkout doesn't?" — not a registry version lookup.
const DEFAULT_REPO = "d4rken/clankermux";
const DEFAULT_BRANCH = "main";

export type UpdateStatus = "current" | "available" | "unknown";

export interface CommitInfo {
	sha: string;
	shortSha: string;
	/** ISO-8601 committer date. */
	date: string;
}

interface CurrentCommitInfo extends CommitInfo {
	/** True if the working tree has uncommitted changes. */
	dirty: boolean;
}

/**
 * Decide whether the running checkout is behind the repo's main branch.
 *
 * Pure so it can be unit-tested without git or network. The decision uses the
 * ancestor relationship first (authoritative when the remote commit object is
 * present locally), then falls back to commit dates so an ahead/unpushed or
 * diverged checkout isn't mislabeled as "available".
 */
export function computeUpdateStatus(params: {
	current: CommitInfo | null;
	latest: CommitInfo | null;
	/** True if the remote commit is reachable from local HEAD (we contain it). */
	latestIsAncestorOfCurrent: boolean;
}): UpdateStatus {
	const { current, latest, latestIsAncestorOfCurrent } = params;
	if (!current || !latest) return "unknown";
	// Same commit → up to date.
	if (current.sha === latest.sha) return "current";
	// We already contain the remote commit → we're at or ahead of it.
	if (latestIsAncestorOfCurrent) return "current";
	// Remote has commits we don't; confirm direction by date so a local-ahead
	// checkout (whose remote object isn't present, so the ancestor check above
	// returned false) isn't reported as behind.
	if (Date.parse(latest.date) > Date.parse(current.date)) return "available";
	return "current";
}

function runGit(args: string[]): string | null {
	try {
		const proc = Bun.spawnSync(["git", ...args], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode !== 0) return null;
		return new TextDecoder().decode(proc.stdout).trim();
	} catch {
		return null;
	}
}

function getCurrentCommit(): CurrentCommitInfo | null {
	const sha = runGit(["rev-parse", "HEAD"]);
	if (!sha) return null;
	const date = runGit(["show", "-s", "--format=%cI", "HEAD"]) ?? "";
	const dirty = (runGit(["status", "--porcelain"]) ?? "").length > 0;
	return { sha, shortSha: sha.slice(0, 7), date, dirty };
}

function latestIsAncestorOfHead(latestSha: string): boolean {
	try {
		const proc = Bun.spawnSync(
			["git", "merge-base", "--is-ancestor", latestSha, "HEAD"],
			{ cwd: process.cwd(), stdout: "ignore", stderr: "ignore" },
		);
		return proc.exitCode === 0;
	} catch {
		return false;
	}
}

// Cache the GitHub response to avoid hammering the API (rate limited to 60
// unauthenticated requests/hour). The local git lookups are cheap and re-run.
interface RemoteCacheEntry {
	commit: CommitInfo;
	htmlUrl: string;
	timestamp: number;
}
let remoteCache: RemoteCacheEntry | null = null;
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

async function getLatestCommit(
	repo: string,
	branch: string,
): Promise<{ commit: CommitInfo; htmlUrl: string; cached: boolean }> {
	const now = Date.now();
	if (remoteCache && now - remoteCache.timestamp < CACHE_DURATION_MS) {
		return {
			commit: remoteCache.commit,
			htmlUrl: remoteCache.htmlUrl,
			cached: true,
		};
	}

	const response = await fetch(
		`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				// GitHub requires a User-Agent on every request.
				"User-Agent": "clankermux-update-check",
			},
		},
	);

	if (!response.ok) {
		throw new Error(`GitHub API returned status ${response.status}`);
	}

	const data = (await response.json()) as {
		sha?: string;
		html_url?: string;
		commit?: { committer?: { date?: string } };
	};

	if (!data.sha) {
		throw new Error("Commit SHA not found in GitHub API response");
	}

	const commit: CommitInfo = {
		sha: data.sha,
		shortSha: data.sha.slice(0, 7),
		date: data.commit?.committer?.date ?? "",
	};
	const htmlUrl =
		data.html_url ?? `https://github.com/${repo}/commits/${branch}`;

	remoteCache = { commit, htmlUrl, timestamp: now };
	return { commit, htmlUrl, cached: false };
}

// Cache the commits-behind count keyed on the (current, latest) sha pair so a
// re-check with unchanged commits doesn't spend another GitHub compare request.
interface BehindCacheEntry {
	base: string;
	head: string;
	behindBy: number;
	timestamp: number;
}
let behindCache: BehindCacheEntry | null = null;

/**
 * Count how many commits the local checkout is behind the remote HEAD.
 *
 * Tries local git first (free, no rate limit) in case the remote commit object
 * is already present locally; otherwise falls back to GitHub's compare API,
 * whose `ahead_by` is the number of commits the remote `head` has that our
 * `base` lacks — i.e. how many we're behind. Returns null when the count can't
 * be determined (so the UI can simply omit it rather than show a wrong number).
 */
async function getCommitsBehind(
	repo: string,
	base: string,
	head: string,
): Promise<number | null> {
	if (base === head) return 0;

	// Local attempt: only succeeds if the remote object is present locally.
	const local = runGit(["rev-list", "--count", `${base}..${head}`]);
	if (local !== null && /^\d+$/.test(local)) return Number(local);

	const now = Date.now();
	if (
		behindCache &&
		behindCache.base === base &&
		behindCache.head === head &&
		now - behindCache.timestamp < CACHE_DURATION_MS
	) {
		return behindCache.behindBy;
	}

	try {
		const response = await fetch(
			`https://api.github.com/repos/${repo}/compare/${base}...${head}`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "clankermux-update-check",
				},
			},
		);
		if (!response.ok) return null;
		const data = (await response.json()) as { ahead_by?: number };
		if (typeof data.ahead_by !== "number") return null;
		behindCache = { base, head, behindBy: data.ahead_by, timestamp: now };
		return data.ahead_by;
	} catch {
		return null;
	}
}

export function createVersionCheckHandler() {
	return async (): Promise<Response> => {
		const repo = readEnv("UPDATE_REPO") || DEFAULT_REPO;
		const branch = readEnv("UPDATE_BRANCH") || DEFAULT_BRANCH;

		try {
			const current = getCurrentCommit();
			const {
				commit: latest,
				htmlUrl,
				cached,
			} = await getLatestCommit(repo, branch);

			const status = computeUpdateStatus({
				current,
				latest,
				latestIsAncestorOfCurrent: current
					? latestIsAncestorOfHead(latest.sha)
					: false,
			});

			// Only spend a compare request when there's actually a gap to measure.
			const behindBy =
				status === "available" && current
					? await getCommitsBehind(repo, current.sha, latest.sha)
					: status === "current"
						? 0
						: null;

			return jsonResponse({
				status,
				repo,
				branch,
				behindBy,
				current: current
					? {
							sha: current.sha,
							shortSha: current.shortSha,
							date: current.date,
							dirty: current.dirty,
						}
					: null,
				latest: {
					sha: latest.sha,
					shortSha: latest.shortSha,
					date: latest.date,
					url: htmlUrl,
				},
				cached,
			});
		} catch (error) {
			log.error("Failed to check for updates from GitHub:", error);
			const message = error instanceof Error ? error.message : String(error);
			return errorResponse(
				InternalServerError(`Update check failed: ${message}`),
			);
		}
	};
}
