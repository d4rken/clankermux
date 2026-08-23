import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import type { AnyUsageData } from "@clankermux/providers";
import type { UsageSnapshotSample } from "@clankermux/types";
import { buildPredictionsForAccounts } from "./build-account-predictions-for";

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function usage(fivePct: number, resetMs: number): AnyUsageData {
	return {
		five_hour: {
			utilization: fivePct,
			resets_at: new Date(resetMs).toISOString(),
		},
		seven_day: {
			utilization: 20,
			resets_at: new Date(resetMs).toISOString(),
		},
	} as unknown as AnyUsageData;
}

/** Rising 5h history: 10/20/30 over the last three hours. */
function risingSnapshots(accountId: string, resetMs: number) {
	return [3, 2, 1].map((hoursAgo, index) => ({
		accountId,
		provider: "anthropic",
		sampledAt: NOW - hoursAgo * HOUR_MS,
		fiveHourPct: 10 * (index + 1),
		fiveHourReset: resetMs,
		sevenDayPct: 20,
		sevenDayReset: resetMs,
	})) satisfies UsageSnapshotSample[];
}

function makeDbOps(options: {
	snapshots?: UsageSnapshotSample[];
	onQuery?: (accountIds: string[], since: number) => void;
	throws?: boolean;
}): DatabaseOperations {
	return {
		getRecentUsageSnapshotsForAccounts: async (
			accountIds: string[],
			since: number,
		) => {
			options.onQuery?.(accountIds, since);
			if (options.throws) throw new Error("snapshot read failed");
			return (options.snapshots ?? []).filter((s) =>
				accountIds.includes(s.accountId),
			);
		},
	} as unknown as DatabaseOperations;
}

describe("buildPredictionsForAccounts", () => {
	it("predicts from stored snapshots plus the routing-fresh live reading", async () => {
		const reset = NOW + 3 * HOUR_MS;
		const predictions = await buildPredictionsForAccounts(
			makeDbOps({ snapshots: risingSnapshots("acc-1", reset) }),
			[{ id: "acc-1", provider: "anthropic" }],
			new Map([["acc-1", usage(60, reset)]]),
			NOW,
		);

		expect(predictions.get("acc-1")?.fiveHour?.state).toBe("rising");
	});

	it("never serves a weekly prediction, however much weekly history exists", async () => {
		const reset = NOW + 3 * HOUR_MS;
		const predictions = await buildPredictionsForAccounts(
			makeDbOps({ snapshots: risingSnapshots("acc-1", reset) }),
			[{ id: "acc-1", provider: "anthropic" }],
			new Map([["acc-1", usage(60, reset)]]),
			NOW,
		);

		// The weekly display path reads the lifetime average instead; a regression
		// here would be a worse estimator the client would prefer over it.
		expect(predictions.get("acc-1")?.sevenDay).toBeUndefined();
		expect(Object.keys(predictions.get("acc-1") ?? {})).toEqual(["fiveHour"]);
	});

	it("still predicts for a reading that carries only the weekly window", async () => {
		// The eligibility guard is unchanged: an account whose live payload has no
		// 5h block can still have 5h history in the snapshots, so dropping it here
		// would lose a prediction the sampler already paid for.
		const reset = NOW + 3 * HOUR_MS;
		const predictions = await buildPredictionsForAccounts(
			makeDbOps({ snapshots: risingSnapshots("acc-1", reset) }),
			[{ id: "acc-1", provider: "anthropic" }],
			new Map([
				[
					"acc-1",
					{
						seven_day: {
							utilization: 20,
							resets_at: new Date(reset).toISOString(),
						},
					} as unknown as AnyUsageData,
				],
			]),
			NOW,
		);

		expect(predictions.get("acc-1")?.fiveHour?.state).toBe("rising");
	});

	it("looks back 24 hours for snapshots", async () => {
		let seen: { accountIds: string[]; since: number } | null = null;
		await buildPredictionsForAccounts(
			makeDbOps({
				onQuery: (accountIds, since) => {
					seen = { accountIds, since };
				},
			}),
			[{ id: "acc-1", provider: "anthropic" }],
			new Map([["acc-1", usage(60, NOW + 3 * HOUR_MS)]]),
			NOW,
		);

		expect(seen).toEqual({
			accountIds: ["acc-1"],
			since: NOW - 24 * HOUR_MS,
		});
	});

	it("only considers anthropic and codex accounts", async () => {
		let seen: string[] = [];
		const reset = NOW + 3 * HOUR_MS;
		const predictions = await buildPredictionsForAccounts(
			makeDbOps({
				snapshots: [
					...risingSnapshots("anthropic-1", reset),
					...risingSnapshots("codex-1", reset),
					...risingSnapshots("zai-1", reset),
				],
				onQuery: (accountIds) => {
					seen = accountIds;
				},
			}),
			[
				{ id: "anthropic-1", provider: "anthropic" },
				{ id: "codex-1", provider: "codex" },
				{ id: "zai-1", provider: "zai" },
				// A null provider is the legacy Anthropic default.
				{ id: "legacy-1", provider: null },
			],
			new Map([
				["anthropic-1", usage(60, reset)],
				["codex-1", usage(60, reset)],
				["zai-1", usage(60, reset)],
				["legacy-1", usage(60, reset)],
			]),
			NOW,
		);

		expect(seen.sort()).toEqual(["anthropic-1", "codex-1", "legacy-1"]);
		expect(predictions.has("zai-1")).toBe(false);
	});

	it("skips an account whose cached reading has neither window", async () => {
		let seen: string[] = [];
		await buildPredictionsForAccounts(
			makeDbOps({
				onQuery: (accountIds) => {
					seen = accountIds;
				},
			}),
			[
				{ id: "acc-1", provider: "anthropic" },
				{ id: "acc-2", provider: "anthropic" },
			],
			new Map([
				["acc-1", usage(60, NOW + 3 * HOUR_MS)],
				["acc-2", { credits: { balance: 5 } } as unknown as AnyUsageData],
			]),
			NOW,
		);

		expect(seen).toEqual(["acc-1"]);
	});

	it("excludes an account with no routing-fresh reading", async () => {
		// A reading past the routing TTL arrives here as `null`: it must not enter
		// the regression stamped `t: now`, and it must not be substituted for.
		const predictions = await buildPredictionsForAccounts(
			makeDbOps({
				snapshots: risingSnapshots("aged-1", NOW + 3 * HOUR_MS),
			}),
			[
				{ id: "aged-1", provider: "anthropic" },
				{ id: "absent-1", provider: "anthropic" },
			],
			new Map([["aged-1", null]]),
			NOW,
		);

		expect(predictions.size).toBe(0);
	});

	it("converts the live reading's ISO reset instants to epoch ms", async () => {
		const reset = NOW + 3 * HOUR_MS;
		const predictions = await buildPredictionsForAccounts(
			makeDbOps({ snapshots: risingSnapshots("acc-1", reset) }),
			[{ id: "acc-1", provider: "anthropic" }],
			new Map([["acc-1", usage(60, reset)]]),
			NOW,
		);

		// The snapshots carry epoch-ms resets; the live point carries the same
		// instant as an ISO string. Only a correct conversion segments them into
		// ONE window, which is what lets a slope be established at all.
		expect(predictions.get("acc-1")?.fiveHour?.resetsAtMs).toBe(reset);
	});

	it("tolerates an unparseable reset rather than dropping the reading", async () => {
		const predictions = await buildPredictionsForAccounts(
			makeDbOps({}),
			[{ id: "acc-1", provider: "anthropic" }],
			new Map([
				[
					"acc-1",
					{
						five_hour: { utilization: 60, resets_at: "not-a-date" },
					} as unknown as AnyUsageData,
				],
			]),
			NOW,
		);

		expect(predictions.get("acc-1")?.fiveHour?.resetsAtMs).toBeNull();
	});

	it("yields an empty map when the snapshot query throws", async () => {
		// The prediction is best-effort garnish on a response that must still be
		// served: a DB failure means "no prediction", never a failed request.
		const predictions = await buildPredictionsForAccounts(
			makeDbOps({ throws: true }),
			[{ id: "acc-1", provider: "anthropic" }],
			new Map([["acc-1", usage(60, NOW + 3 * HOUR_MS)]]),
			NOW,
		);

		expect(predictions.size).toBe(0);
	});

	it("does not query at all when nothing is predictable", async () => {
		let queried = false;
		const predictions = await buildPredictionsForAccounts(
			makeDbOps({
				onQuery: () => {
					queried = true;
				},
			}),
			[{ id: "zai-1", provider: "zai" }],
			new Map([["zai-1", usage(60, NOW + 3 * HOUR_MS)]]),
			NOW,
		);

		expect(queried).toBe(false);
		expect(predictions.size).toBe(0);
	});
});
