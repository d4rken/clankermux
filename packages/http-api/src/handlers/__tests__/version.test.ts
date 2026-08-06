import { describe, expect, it } from "bun:test";
import type { BootProvenance } from "@clankermux/core";
import { computeUpdateStatus, createVersionCheckHandler } from "../version";

const current = {
	sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	shortSha: "aaaaaaa",
	date: "2026-05-20T10:00:00Z",
	dirty: false,
};

describe("computeUpdateStatus", () => {
	it("returns 'unknown' when the local commit can't be determined", () => {
		expect(
			computeUpdateStatus({
				current: null,
				latest: { ...current, sha: "bbbb", shortSha: "bbbb" },
				latestIsAncestorOfCurrent: false,
			}),
		).toBe("unknown");
	});

	it("returns 'unknown' when the remote commit can't be fetched", () => {
		expect(
			computeUpdateStatus({
				current,
				latest: null,
				latestIsAncestorOfCurrent: false,
			}),
		).toBe("unknown");
	});

	it("returns 'current' when local and remote point at the same commit", () => {
		expect(
			computeUpdateStatus({
				current,
				latest: { ...current },
				latestIsAncestorOfCurrent: true,
			}),
		).toBe("current");
	});

	it("returns 'current' when the local checkout is ahead of remote (remote is an ancestor)", () => {
		// Local has unpushed commits; remote HEAD is reachable from local HEAD.
		expect(
			computeUpdateStatus({
				current,
				latest: {
					sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					shortSha: "bbbbbbb",
					date: "2026-05-19T10:00:00Z",
				},
				latestIsAncestorOfCurrent: true,
			}),
		).toBe("current");
	});

	it("returns 'available' when remote has a newer commit the local checkout lacks", () => {
		expect(
			computeUpdateStatus({
				current,
				latest: {
					sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					shortSha: "bbbbbbb",
					date: "2026-05-21T10:00:00Z",
				},
				latestIsAncestorOfCurrent: false,
			}),
		).toBe("available");
	});

	it("returns 'current' when SHAs differ but the local commit date is newer (diverged/ahead, remote object absent)", () => {
		// Ancestor check can't confirm because the remote object isn't present
		// locally; fall back to commit dates — local is newer, so we're not behind.
		expect(
			computeUpdateStatus({
				current,
				latest: {
					sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					shortSha: "bbbbbbb",
					date: "2026-05-19T10:00:00Z",
				},
				latestIsAncestorOfCurrent: false,
			}),
		).toBe("current");
	});
});

const bootedOnCurrent: BootProvenance = {
	sha: current.sha,
	shortSha: current.shortSha,
	date: current.date,
	bootedAt: 1_700_000_000_000,
};

const remoteAhead = {
	sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	shortSha: "bbbbbbb",
	date: "2026-05-21T10:00:00Z",
};

function handlerWith(overrides: {
	currentSha?: string;
	boot?: BootProvenance | null;
	latest?: () => Promise<{
		commit: typeof remoteAhead;
		htmlUrl: string;
		cached: boolean;
	}>;
}) {
	return createVersionCheckHandler({
		readCurrentCommit: () => ({
			...current,
			sha: overrides.currentSha ?? current.sha,
		}),
		readBootProvenance: () => overrides.boot ?? null,
		fetchLatestCommit:
			overrides.latest ??
			(async () => ({
				commit: { sha: current.sha, shortSha: current.shortSha, date: current.date },
				htmlUrl: "https://example.invalid/commit",
				cached: false,
			})),
	});
}

describe("createVersionCheckHandler — boot provenance", () => {
	it("reports restartPending when the checkout moved since boot", async () => {
		const response = await handlerWith({
			currentSha: remoteAhead.sha,
			boot: bootedOnCurrent,
			latest: async () => ({
				commit: remoteAhead,
				htmlUrl: "https://example.invalid/commit",
				cached: false,
			}),
		})();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.restartPending).toBe(true);
		expect(body.boot).toEqual({
			sha: bootedOnCurrent.sha,
			shortSha: bootedOnCurrent.shortSha,
			date: bootedOnCurrent.date,
		});
		// The process is behind its own checkout, but the checkout matches the
		// remote — the two signals are independent.
		expect(body.status).toBe("current");
	});

	it("reports restartPending false when the process is on the checked-out commit", async () => {
		const body = await (await handlerWith({ boot: bootedOnCurrent })()).json();

		expect(body.restartPending).toBe(false);
		expect(body.boot?.sha).toBe(bootedOnCurrent.sha);
	});

	it("omits the signal entirely when boot provenance was never captured", async () => {
		// Absence of signal, never an invented one.
		const body = await (
			await handlerWith({ currentSha: remoteAhead.sha, boot: null })()
		).json();

		expect(body.boot).toBeNull();
		expect(body.restartPending).toBe(false);
	});

	it("keeps the local restart signal when the GitHub call fails", async () => {
		// The restart signal is entirely local. Returning 500 on a rate limit or
		// outage — as the outer catch used to — hid it exactly when an operator was
		// most likely to be looking.
		const response = await handlerWith({
			currentSha: remoteAhead.sha,
			boot: bootedOnCurrent,
			latest: async () => {
				throw new Error("GitHub API returned status 403");
			},
		})();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.status).toBe("unknown");
		expect(body.latest).toBeNull();
		expect(body.latestError).toBe("GitHub API returned status 403");
		expect(body.restartPending).toBe(true);
		expect(body.boot?.shortSha).toBe(bootedOnCurrent.shortSha);
		expect(body.current?.sha).toBe(remoteAhead.sha);
	});
});
