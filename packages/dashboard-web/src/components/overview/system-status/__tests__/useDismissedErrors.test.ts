import { describe, expect, it } from "bun:test";
import type { RecentErrorGroup } from "@clankermux/types";
import {
	markDismissed,
	mergeDismissals,
	readDismissals,
} from "../useDismissedErrors";

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function makeError(
	overrides: Partial<RecentErrorGroup> = {},
): RecentErrorGroup {
	return {
		errorCode: "rate_limited",
		accountId: "a1",
		accountName: "acct-one",
		provider: "anthropic",
		occurrenceCount: 3,
		latestTimestamp: NOW - 10_000,
		firstTimestamp: NOW - 60_000,
		latestRequestId: "req-1",
		model: "claude-opus-5",
		statusCode: 429,
		path: "/v1/messages",
		failoverAttempts: 1,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		...overrides,
	};
}

describe("markDismissed", () => {
	it("marks every supplied group in one pass", () => {
		const next = markDismissed(
			{},
			[
				makeError({ accountId: "a1", errorCode: "rate_limited" }),
				makeError({ accountId: "a2", errorCode: "upstream_error" }),
			],
			NOW,
		);

		expect(Object.keys(next).sort()).toEqual([
			"a1:rate_limited",
			"a2:upstream_error",
		]);
	});

	it("groups by account and error code, not by request", () => {
		const next = markDismissed(
			{},
			[
				makeError({ latestRequestId: "req-1" }),
				makeError({ latestRequestId: "req-2" }),
			],
			NOW,
		);

		expect(Object.keys(next)).toEqual(["a1:rate_limited"]);
	});

	it("keys an account-less group under the shared placeholder", () => {
		const next = markDismissed({}, [makeError({ accountId: null })], NOW);

		expect(Object.keys(next)).toEqual(["no_account:rate_limited"]);
	});

	it("keeps dismissals that are not part of this batch", () => {
		const next = markDismissed(
			{ "a9:old_error": { cutoff: NOW - 5_000, dismissedAt: NOW - 5_000 } },
			[makeError()],
			NOW,
		);

		expect(next["a9:old_error"]).toEqual({
			cutoff: NOW - 5_000,
			dismissedAt: NOW - 5_000,
		});
	});

	/**
	 * The cutoff is compared against the server's `latestTimestamp`, so it has to
	 * BE a server timestamp. Storing the local clock instead means a browser
	 * running fast writes a cutoff in the server's future and keeps recurrences
	 * hidden until the server catches up.
	 */
	it("cuts off at the server timestamp, not the local clock", () => {
		const group = makeError({ latestTimestamp: NOW - 10_000 });

		const next = markDismissed({}, [group], NOW + 60 * 60 * 1000);

		expect(next["a1:rate_limited"].cutoff).toBe(NOW - 10_000);
	});

	it("records the local clock separately, for pruning", () => {
		const next = markDismissed({}, [makeError()], NOW);

		expect(next["a1:rate_limited"].dismissedAt).toBe(NOW);
	});

	it("returns the same state object for an empty batch", () => {
		const state = { "a1:rate_limited": { cutoff: NOW, dismissedAt: NOW } };

		expect(markDismissed(state, [], NOW)).toBe(state);
	});

	it("advances the cutoff when a dismissed group recurs", () => {
		const next = markDismissed(
			{
				"a1:rate_limited": { cutoff: NOW - 60_000, dismissedAt: NOW - 60_000 },
			},
			[makeError({ latestTimestamp: NOW - 10_000 })],
			NOW,
		);

		expect(next["a1:rate_limited"].cutoff).toBe(NOW - 10_000);
	});

	/**
	 * A cached payload can carry an occurrence older than one already dismissed.
	 * Letting it lower the cutoff would un-hide rows the user had cleared.
	 */
	it("never lowers an existing cutoff", () => {
		const next = markDismissed(
			{ "a1:rate_limited": { cutoff: NOW, dismissedAt: NOW - 60_000 } },
			[makeError({ latestTimestamp: NOW - 90_000 })],
			NOW,
		);

		expect(next["a1:rate_limited"].cutoff).toBe(NOW);
	});
});

describe("readDismissals", () => {
	it("returns nothing for absent or unusable storage", () => {
		expect(readDismissals(null, NOW)).toEqual({});
		expect(readDismissals("not json", NOW)).toEqual({});
		expect(readDismissals("[1,2,3]", NOW)).toEqual({});
	});

	it("drops entries older than the retention window", () => {
		const raw = JSON.stringify({
			fresh: { cutoff: NOW - DAY, dismissedAt: NOW - DAY },
			stale: { cutoff: NOW - 31 * DAY, dismissedAt: NOW - 31 * DAY },
		});

		expect(Object.keys(readDismissals(raw, NOW))).toEqual(["fresh"]);
	});

	it("drops malformed entries without discarding the rest", () => {
		const raw = JSON.stringify({
			good: { cutoff: NOW, dismissedAt: NOW },
			bad: { cutoff: "soon" },
			alsoBad: null,
		});

		expect(Object.keys(readDismissals(raw, NOW))).toEqual(["good"]);
	});

	/**
	 * Dismissals persisted before the cutoff and the prune clock were split apart
	 * were a single `Date.now()` number. Reading them as both fields keeps what
	 * the user had hidden; the next dismissal of that group corrects the cutoff.
	 */
	it("migrates the legacy single-number encoding", () => {
		const raw = JSON.stringify({ "a1:rate_limited": NOW - DAY });

		expect(readDismissals(raw, NOW)).toEqual({
			"a1:rate_limited": { cutoff: NOW - DAY, dismissedAt: NOW - DAY },
		});
	});

	it("prunes legacy entries on the same retention window", () => {
		const raw = JSON.stringify({ "a1:rate_limited": NOW - 31 * DAY });

		expect(readDismissals(raw, NOW)).toEqual({});
	});
});

describe("mergeDismissals", () => {
	/**
	 * Each tab keeps its own copy of the map and persists the whole object, so a
	 * write that did not merge would erase whatever another tab had dismissed in
	 * the meantime — one Clear all click can drop many markers that way.
	 */
	it("keeps dismissals present on only one side", () => {
		const merged = mergeDismissals(
			{ mine: { cutoff: NOW, dismissedAt: NOW } },
			{ theirs: { cutoff: NOW, dismissedAt: NOW } },
		);

		expect(Object.keys(merged).sort()).toEqual(["mine", "theirs"]);
	});

	it("keeps the later cutoff when both sides know the group", () => {
		const merged = mergeDismissals(
			{ shared: { cutoff: NOW - 60_000, dismissedAt: NOW - 60_000 } },
			{ shared: { cutoff: NOW, dismissedAt: NOW } },
		);

		expect(merged.shared).toEqual({ cutoff: NOW, dismissedAt: NOW });
	});

	it("is order-independent", () => {
		const a = { shared: { cutoff: NOW, dismissedAt: NOW - 60_000 } };
		const b = { shared: { cutoff: NOW - 60_000, dismissedAt: NOW } };

		expect(mergeDismissals(a, b)).toEqual(mergeDismissals(b, a));
	});

	it("does not mutate either input", () => {
		const a = { shared: { cutoff: NOW - 60_000, dismissedAt: NOW - 60_000 } };
		const b = { shared: { cutoff: NOW, dismissedAt: NOW } };

		mergeDismissals(a, b);

		expect(a.shared.cutoff).toBe(NOW - 60_000);
	});
});
