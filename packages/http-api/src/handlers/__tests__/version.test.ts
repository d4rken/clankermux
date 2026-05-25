import { describe, expect, it } from "bun:test";
import { computeUpdateStatus } from "../version";

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
