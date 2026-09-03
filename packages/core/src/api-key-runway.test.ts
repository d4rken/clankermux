import { describe, expect, it } from "bun:test";
import type { ApiKeyResponse } from "@clankermux/types";
import {
	computeApiKeyRunways,
	effectiveRunwayOutcome,
	type KeyRunway,
	type RunwayAccountSource,
	summarizeKeyRunways,
	UNAUTHENTICATED_POOL_KEY_NAME,
	worstKeyRunway,
} from "./api-key-runway";

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function mkAccount(partial: Partial<RunwayAccountSource>): RunwayAccountSource {
	return {
		id: partial.id ?? partial.name ?? "id",
		name: partial.name ?? "acc",
		provider: partial.provider ?? "anthropic",
		usageData: null,
		...partial,
	};
}

/** Anthropic-shaped usage payload with explicit account-wide windows. */
function usage(
	fivePct: number,
	fiveResetMs: number,
	sevenPct: number,
	sevenResetMs: number,
) {
	return {
		five_hour: {
			utilization: fivePct,
			resets_at: new Date(fiveResetMs).toISOString(),
		},
		seven_day: {
			utilization: sevenPct,
			resets_at: new Date(sevenResetMs).toISOString(),
		},
	} as never;
}

/** Barely-used account: no run-out projected inside the horizon. */
function healthy(id: string, provider = "anthropic"): RunwayAccountSource {
	return mkAccount({
		id,
		name: id,
		provider,
		usageData: usage(10, NOW + 4 * HOUR, 5, NOW + 6 * DAY),
	});
}

/** Account whose 5-hour window is already spent. */
function spent(id: string, provider = "anthropic"): RunwayAccountSource {
	return mkAccount({
		id,
		name: id,
		provider,
		usageData: usage(100, NOW + 2 * HOUR, 20, NOW + 6 * DAY),
	});
}

function mkKey(partial: Partial<ApiKeyResponse>): ApiKeyResponse {
	return {
		id: partial.id ?? "key",
		name: partial.name ?? "Key",
		prefixLast8: "abcdefgh",
		createdAt: new Date(NOW).toISOString(),
		lastUsed: null,
		usageCount: 0,
		isActive: true,
		pinnedAccountId: null,
		pinnedProviders: null,
		...partial,
	};
}

function byId(runways: KeyRunway[], id: string | null): KeyRunway {
	const found = runways.find((r) => r.keyId === id);
	if (!found) throw new Error(`no runway row for ${id}`);
	return found;
}

describe("computeApiKeyRunways", () => {
	it("scopes an account-pinned key to that one account", () => {
		const accounts = [spent("acc-1"), healthy("acc-2")];
		const keys = [
			mkKey({ id: "k1", name: "Pinned", pinnedAccountId: "acc-1" }),
			mkKey({ id: "k2", name: "Open" }),
		];

		const runways = computeApiKeyRunways(keys, accounts, NOW);

		const pinned = byId(runways, "k1");
		expect(pinned.eligibleAccountIds).toEqual(["acc-1"]);
		expect(pinned.pin).toEqual({ accountId: "acc-1", providers: null });
		expect(pinned.outcome.kind).toBe("out-now");

		// The unpinned key still has the healthy account to fall back on.
		const open = byId(runways, "k2");
		expect(open.eligibleAccountIds).toEqual(["acc-1", "acc-2"]);
		expect(open.outcome.kind).toBe("beyond-horizon");
	});

	it("scopes a class-pinned key to that provider", () => {
		const accounts = [
			spent("codex-1", "codex"),
			healthy("anthropic-1", "anthropic"),
		];
		const keys = [
			mkKey({ id: "k1", name: "Codex only", pinnedProviders: ["codex"] }),
		];

		const runways = computeApiKeyRunways(keys, accounts, NOW);

		expect(runways).toHaveLength(1);
		expect(runways[0].eligibleAccountIds).toEqual(["codex-1"]);
		expect(runways[0].pin).toEqual({
			accountId: null,
			providers: ["codex"],
		});
		expect(runways[0].outcome.kind).toBe("out-now");
	});

	it("reports no accounts for a pin naming an account that is gone", () => {
		const runways = computeApiKeyRunways(
			[mkKey({ id: "k1", pinnedAccountId: "deleted" })],
			[healthy("acc-1")],
			NOW,
		);

		expect(runways[0].eligibleAccountIds).toEqual([]);
		expect(runways[0].outcome).toEqual({ kind: "no-accounts" });
	});

	it("emits exactly one synthetic row when no key is active", () => {
		const accounts = [healthy("acc-1"), healthy("acc-2")];
		const keys = [
			mkKey({ id: "k1", name: "Retired", isActive: false }),
			mkKey({ id: "k2", name: "Also retired", isActive: false }),
		];

		const runways = computeApiKeyRunways(keys, accounts, NOW);

		// Authentication is off in this state, so every request routes over the
		// unpinned pool and the disabled keys describe nothing.
		expect(runways).toHaveLength(1);
		expect(runways[0].keyId).toBeNull();
		expect(runways[0].keyName).toBe(UNAUTHENTICATED_POOL_KEY_NAME);
		expect(runways[0].isActive).toBe(true);
		expect(runways[0].pin).toEqual({ accountId: null, providers: null });
		expect(runways[0].eligibleAccountIds).toEqual(["acc-1", "acc-2"]);
		expect(runways[0].outcome.kind).toBe("beyond-horizon");
	});

	it("lists inactive keys alongside active ones", () => {
		const runways = computeApiKeyRunways(
			[
				mkKey({ id: "k1", name: "Live" }),
				mkKey({ id: "k2", name: "Disabled", isActive: false }),
			],
			[healthy("acc-1")],
			NOW,
		);

		expect(runways.map((r) => r.keyId)).toEqual(["k1", "k2"]);
		expect(byId(runways, "k2").isActive).toBe(false);
	});

	it("treats a provider with no account-wide window as always in quota", () => {
		const runways = computeApiKeyRunways(
			[mkKey({ id: "k1" })],
			[mkAccount({ id: "local", name: "local", provider: "ollama" })],
			NOW,
		);

		expect(runways[0].eligibleAccountIds).toEqual(["local"]);
		expect(runways[0].outcome.kind).toBe("beyond-horizon");
		if (runways[0].outcome.kind !== "beyond-horizon") {
			throw new Error("unreachable");
		}
		expect(runways[0].outcome.unprojectableAccountIds).toEqual([]);
	});

	it("reports an account with no usage evidence as unprojectable", () => {
		const runways = computeApiKeyRunways(
			[mkKey({ id: "k1" })],
			[mkAccount({ id: "quiet", name: "quiet", provider: "anthropic" })],
			NOW,
		);

		expect(runways[0].outcome).toEqual({ kind: "unknown" });
	});

	it("keeps a lower bound when only some accounts are unreadable", () => {
		const accounts = [
			spent("acc-1"),
			mkAccount({ id: "quiet", name: "quiet", provider: "anthropic" }),
		];

		const runways = computeApiKeyRunways([mkKey({ id: "k1" })], accounts, NOW);

		expect(runways[0].outcome.kind).toBe("out-now");
		if (runways[0].outcome.kind !== "out-now") throw new Error("unreachable");
		expect(runways[0].outcome.unprojectableAccountIds).toEqual(["quiet"]);
	});

	it("counts a five-hour-only provider as metered on that window alone", () => {
		// Zai reports a token window but no weekly one; it must not be mistaken for
		// a provider with no account-wide quota at all.
		const runways = computeApiKeyRunways(
			[mkKey({ id: "k1" })],
			[
				mkAccount({
					id: "zai-1",
					name: "zai-1",
					provider: "zai",
					usageData: {
						tokens_limit: {
							percentage: 100,
							resetAt: NOW + HOUR,
						},
					} as never,
				}),
			],
			NOW,
		);

		expect(runways[0].outcome.kind).toBe("out-now");
	});

	it("feeds each account's server prediction into its own windows", () => {
		// A rising regression on the 5h window projects a run-out the lifetime
		// average would not: 30% used with a 20%/h slope is spent in 3.5h, inside
		// the window. `prediction` being optional is what lets AccountResponse be
		// passed here unchanged.
		const resetMs = NOW + 4 * HOUR;
		const runways = computeApiKeyRunways(
			[mkKey({ id: "k1" })],
			[
				mkAccount({
					id: "acc-1",
					name: "acc-1",
					usageData: usage(30, resetMs, 5, NOW + 6 * DAY),
					prediction: {
						fiveHour: {
							state: "rising",
							slopePerHour: 20,
							etaExhaustMs: NOW + 3.5 * HOUR,
							predictedAtReset: 100,
							resetsAtMs: resetMs,
							willExhaustBeforeReset: true,
							lowConfidence: false,
						},
					},
				}),
			],
			NOW,
		);

		expect(runways[0].outcome.kind).toBe("runway");
		if (runways[0].outcome.kind !== "runway") throw new Error("unreachable");
		expect(runways[0].outcome.exhaustsAtMs).toBe(NOW + 3.5 * HOUR);
		expect(runways[0].outcome.causes).toEqual([
			{ accountId: "acc-1", windowKind: "five_hour" },
		]);
	});
});

function row(outcome: KeyRunway["outcome"], isActive = true): KeyRunway {
	return {
		keyId: `k-${outcome.kind}`,
		keyName: outcome.kind,
		isActive,
		pin: { accountId: null, providers: null },
		eligibleAccountIds: ["acc-1"],
		outcome,
	};
}

const NO_ACCOUNTS = row({ kind: "no-accounts" });
const OUT_NOW = row({
	kind: "out-now",
	causes: [],
	unprojectableAccountIds: [],
});
const UNKNOWN = row({ kind: "unknown" });
const BEYOND = row({
	kind: "beyond-horizon",
	horizonMs: 14 * DAY,
	unprojectableAccountIds: [],
});

function runwayRow(durationMs: number, keyId: string): KeyRunway {
	return {
		keyId,
		keyName: keyId,
		isActive: true,
		pin: { accountId: null, providers: null },
		eligibleAccountIds: ["acc-1"],
		outcome: {
			kind: "runway",
			exhaustsAtMs: NOW + durationMs,
			durationMs,
			causes: [],
			unprojectableAccountIds: [],
		},
	};
}

describe("effectiveRunwayOutcome", () => {
	it("reads a runway past its own deadline as out of quota", () => {
		const outcome = runwayRow(4 * HOUR, "a").outcome;

		const effective = effectiveRunwayOutcome(outcome, NOW + 5 * HOUR);

		expect(effective.kind).toBe("out-now");
		if (effective.kind !== "out-now") throw new Error("unreachable");
		expect(effective.causes).toEqual([]);
		expect(effective.unprojectableAccountIds).toEqual([]);
	});

	it("leaves an outcome that has not expired exactly as served", () => {
		const outcome = runwayRow(4 * HOUR, "a").outcome;

		expect(effectiveRunwayOutcome(outcome, NOW)).toBe(outcome);
		expect(effectiveRunwayOutcome({ kind: "unknown" }, NOW + 5 * HOUR)).toEqual(
			{ kind: "unknown" },
		);
	});
});

describe("worstKeyRunway", () => {
	it("returns null when there is nothing active to report", () => {
		expect(worstKeyRunway([], NOW)).toBeNull();
		expect(worstKeyRunway([row({ kind: "unknown" }, false)], NOW)).toBeNull();
	});

	it("ranks no-accounts worst: the key can reach nothing at all", () => {
		expect(
			worstKeyRunway([BEYOND, OUT_NOW, NO_ACCOUNTS], NOW)?.outcome.kind,
		).toBe("no-accounts");
	});

	it("ranks out-now above unknown", () => {
		expect(worstKeyRunway([UNKNOWN, OUT_NOW], NOW)?.outcome.kind).toBe(
			"out-now",
		);
	});

	// Unknown poisons the headline: it could be worse than any finite value, so
	// the headline must not claim better while the per-key rows still show their
	// own definite numbers.
	it("ranks unknown above any finite runway", () => {
		expect(
			worstKeyRunway([runwayRow(HOUR, "a"), UNKNOWN], NOW)?.outcome.kind,
		).toBe("unknown");
	});

	it("ranks a finite runway above beyond-horizon", () => {
		expect(worstKeyRunway([BEYOND, runwayRow(5 * DAY, "a")], NOW)?.keyId).toBe(
			"a",
		);
	});

	it("prefers the shortest runway among finite ones", () => {
		const worst = worstKeyRunway(
			[
				runwayRow(5 * DAY, "long"),
				runwayRow(2 * HOUR, "short"),
				runwayRow(12 * HOUR, "medium"),
			],
			NOW,
		);

		expect(worst?.keyId).toBe("short");
	});

	it("ignores inactive keys entirely", () => {
		const worst = worstKeyRunway(
			[row({ kind: "no-accounts" }, false), runwayRow(5 * DAY, "live")],
			NOW,
		);

		expect(worst?.keyId).toBe("live");
	});

	// The rows come from a poll. Ranking the outcome AS SERVED would leave the
	// headline on `unknown` while the row beneath it already reads "Out of
	// quota", because `unknown` outranks `runway` in the severity order.
	it("ranks an expired runway as out-now, ahead of an unknown key", () => {
		const expired = runwayRow(4 * HOUR, "expired");
		const at = NOW + 5 * HOUR;

		const worst = worstKeyRunway([UNKNOWN, expired], at);

		expect(worst?.keyId).toBe("expired");
		expect(effectiveRunwayOutcome(expired.outcome, at).kind).toBe("out-now");
	});

	// `durationMs` is measured from the moment the response was generated, so
	// rows generated at different times are not comparable through it. Remaining
	// time against the caller's clock is.
	it("orders by remaining time, not by the served durationMs", () => {
		const soon = runwayRow(6 * HOUR, "soon");
		// Served with a SHORTER durationMs, but its deadline is later: it was
		// generated earlier and has more time left at `now`.
		const later: KeyRunway = {
			...runwayRow(2 * HOUR, "later"),
			outcome: {
				kind: "runway",
				exhaustsAtMs: NOW + 8 * HOUR,
				durationMs: 2 * HOUR,
				causes: [],
				unprojectableAccountIds: [],
			},
		};

		expect(worstKeyRunway([later, soon], NOW)?.keyId).toBe("soon");
		expect(worstKeyRunway([soon, later], NOW)?.keyId).toBe("soon");
	});
});

describe("windowObservations fallback", () => {
	it("projects from pre-extracted readings when there is no payload", () => {
		const accounts = [
			mkAccount({
				id: "restored",
				name: "restored",
				usageData: null,
				windowObservations: {
					fiveHour: { pct: 100, resetMs: NOW + 2 * HOUR },
					sevenDay: { pct: 20, resetMs: NOW + 6 * DAY },
				},
			}),
		];

		const runways = computeApiKeyRunways([mkKey({ id: "k1" })], accounts, NOW);

		// Without the fallback this account has no readable window and the key is
		// `unknown`; with it, the spent 5-hour window is seen.
		expect(byId(runways, "k1").outcome.kind).toBe("out-now");
	});

	it("ignores the readings when a live payload is present", () => {
		const accounts = [
			mkAccount({
				id: "live",
				name: "live",
				usageData: usage(10, NOW + 4 * HOUR, 5, NOW + 6 * DAY),
				windowObservations: {
					fiveHour: { pct: 100, resetMs: NOW + 2 * HOUR },
					sevenDay: { pct: 100, resetMs: NOW + 6 * DAY },
				},
			}),
		];

		const runways = computeApiKeyRunways([mkKey({ id: "k1" })], accounts, NOW);

		// The payload wins outright. A merge would let one window come from the
		// live read and the other from an older one.
		expect(byId(runways, "k1").outcome.kind).toBe("beyond-horizon");
	});

	it("leaves an account unprojectable when neither source reads", () => {
		const accounts = [mkAccount({ id: "cold", name: "cold", usageData: null })];

		const runways = computeApiKeyRunways([mkKey({ id: "k1" })], accounts, NOW);

		expect(byId(runways, "k1").outcome.kind).toBe("unknown");
	});
});

describe("burn anchors", () => {
	it("threads a weekly anchor into the projection", () => {
		const sevenReset = NOW + 1.5 * DAY;
		// 40% weekly at 1.5d-to-reset: structurally that is 40% over 5.5 days —
		// far too slow to exhaust before reset. With the gift anchored 12h ago
		// the true rate is 40%/12h, which exhausts in 18h (< 1.5d), so the
		// anchor is what flips the outcome to a runway.
		const accounts = [
			mkAccount({
				id: "gifted",
				name: "gifted",
				usageData: usage(10, NOW + 4 * HOUR, 40, sevenReset),
				usageObservedAtMs: NOW,
				burnAnchors: {
					sevenDay: {
						anchorMs: NOW - 12 * HOUR,
						anchorPct: 0,
						windowResetMs: sevenReset,
					},
				},
			}),
		];

		const runways = computeApiKeyRunways([mkKey({ id: "k1" })], accounts, NOW);
		const outcome = byId(runways, "k1").outcome;

		expect(outcome.kind).toBe("runway");
		if (outcome.kind === "runway") {
			expect(outcome.exhaustsAtMs).toBe(NOW + 18 * HOUR);
		}
	});

	it("ignores an anchor keyed to a different window instance", () => {
		const sevenReset = NOW + 1.5 * DAY;
		const anchored = mkAccount({
			id: "stale-anchor",
			name: "stale-anchor",
			usageData: usage(10, NOW + 4 * HOUR, 40, sevenReset),
			usageObservedAtMs: NOW,
			burnAnchors: {
				sevenDay: {
					anchorMs: NOW - 12 * HOUR,
					anchorPct: 0,
					// A reset from the PREVIOUS window instance.
					windowResetMs: sevenReset - 7 * DAY,
				},
			},
		});
		const plain = mkAccount({
			id: "stale-anchor",
			name: "stale-anchor",
			usageData: usage(10, NOW + 4 * HOUR, 40, sevenReset),
			usageObservedAtMs: NOW,
		});

		const withAnchor = computeApiKeyRunways(
			[mkKey({ id: "k1" })],
			[anchored],
			NOW,
		);
		const without = computeApiKeyRunways([mkKey({ id: "k1" })], [plain], NOW);

		expect(byId(withAnchor, "k1").outcome).toEqual(byId(without, "k1").outcome);
	});
});

describe("reset-credit bank pass-through", () => {
	it("threads the bank into the scan and surfaces the assumption", () => {
		const accounts = [
			mkAccount({
				id: "codex-1",
				name: "codex-1",
				provider: "codex",
				usageData: {
					five_hour: null,
					seven_day: {
						utilization: 100,
						resets_at: new Date(NOW + 2 * DAY).toISOString(),
					},
				} as never,
				codexResetCredits: {
					onWeeklyLimitEnabled: true,
					onExpiryEnabled: false,
					credits: [{ expiresAtMs: null }],
				},
			}),
		];

		const runways = computeApiKeyRunways([mkKey({ id: "k1" })], accounts, NOW);
		const outcome = byId(runways, "k1").outcome;

		// Without the bank this pool is out now; the modeled revival (5d to
		// re-burn a 7d window with 2d left) clears the horizon instead.
		expect(outcome.kind).toBe("beyond-horizon");
		if (outcome.kind === "beyond-horizon") {
			expect(outcome.assumedResetCredits).toEqual([
				{ accountId: "codex-1", count: 1 },
			]);
		}
	});
});

describe("summarizeKeyRunways", () => {
	function rowWith(
		keyId: string,
		outcome: KeyRunway["outcome"],
		isActive = true,
	): KeyRunway {
		return {
			keyId,
			keyName: keyId,
			isActive,
			pin: { accountId: null, providers: null },
			eligibleAccountIds: [],
			outcome,
		};
	}

	const BEYOND: KeyRunway["outcome"] = {
		kind: "beyond-horizon",
		horizonMs: 14 * DAY,
		unprojectableAccountIds: [],
	};
	const UNKNOWN: KeyRunway["outcome"] = { kind: "unknown" };

	it("keeps a stateable figure when another key has no evidence", () => {
		const summary = summarizeKeyRunways(
			[rowWith("known", BEYOND), rowWith("cold", UNKNOWN)],
			NOW,
		);

		// The whole point: `worstKeyRunway` would rank the unknown key worst and
		// the headline would have nothing to say, even though `known` has perfect
		// evidence.
		expect(
			worstKeyRunway([rowWith("known", BEYOND), rowWith("cold", UNKNOWN)], NOW)
				?.keyId,
		).toBe("cold");
		expect(summary.worst?.keyId).toBe("known");
		expect(summary.statedKeyCount).toBe(1);
		expect(summary.unobservedKeyCount).toBe(1);
		expect(summary.activeKeyCount).toBe(2);
	});

	it("reports nothing stateable when every active key is unknown", () => {
		const summary = summarizeKeyRunways(
			[rowWith("a", UNKNOWN), rowWith("b", UNKNOWN)],
			NOW,
		);

		// The floor holds: with no evidence anywhere the headline still refuses to
		// name a figure rather than reaching for the least-bad row.
		expect(summary.worst).toBeNull();
		expect(summary.statedKeyCount).toBe(0);
		expect(summary.unobservedKeyCount).toBe(2);
	});

	it("keeps no-accounts in the headline", () => {
		const summary = summarizeKeyRunways(
			[rowWith("empty", { kind: "no-accounts" }), rowWith("ok", BEYOND)],
			NOW,
		);

		// "This key can reach nothing" is a definite finding and the most severe
		// one there is — only MISSING EVIDENCE is set aside.
		expect(summary.worst?.keyId).toBe("empty");
		expect(summary.unobservedKeyCount).toBe(0);
	});

	it("ignores inactive keys entirely", () => {
		const summary = summarizeKeyRunways(
			[rowWith("live", BEYOND), rowWith("disabled", UNKNOWN, false)],
			NOW,
		);

		expect(summary.activeKeyCount).toBe(1);
		expect(summary.unobservedKeyCount).toBe(0);
		expect(summary.worst?.keyId).toBe("live");
	});

	it("ranks a served runway past its deadline as out-now", () => {
		const expired: KeyRunway["outcome"] = {
			kind: "runway",
			exhaustsAtMs: NOW - HOUR,
			durationMs: HOUR,
			causes: [],
			unprojectableAccountIds: [],
		};

		const summary = summarizeKeyRunways(
			[rowWith("beyond", BEYOND), rowWith("expired", expired)],
			NOW,
		);

		expect(summary.worst?.keyId).toBe("expired");
		expect(
			effectiveRunwayOutcome(summary.worst?.outcome ?? UNKNOWN, NOW).kind,
		).toBe("out-now");
	});

	it("ties beyond-horizon rows toward the most fragile paceMargin", () => {
		// The headline row is the only one whose paceMargin any surface renders,
		// so among tied beyond-horizon keys the knife-edge one must win over a
		// robust one — in either input order — and the smaller flip multiplier
		// over the larger.
		const fragile = rowWith("fragile", {
			...BEYOND,
			paceMargin: { multiplier: 1.02, exhaustsAtMs: NOW + 2 * DAY },
		});
		const lessFragile = rowWith("less-fragile", {
			...BEYOND,
			paceMargin: { multiplier: 1.4, exhaustsAtMs: NOW + 10 * DAY },
		});
		const robust = rowWith("robust", BEYOND);

		expect(worstKeyRunway([robust, fragile], NOW)?.keyId).toBe("fragile");
		expect(worstKeyRunway([fragile, robust], NOW)?.keyId).toBe("fragile");
		expect(worstKeyRunway([lessFragile, fragile], NOW)?.keyId).toBe("fragile");
		// A finite runway still outranks any beyond-horizon, margin or not.
		const finite = rowWith("finite", {
			kind: "runway",
			exhaustsAtMs: NOW + DAY,
			durationMs: DAY,
			causes: [],
			unprojectableAccountIds: [],
		});
		expect(worstKeyRunway([fragile, finite], NOW)?.keyId).toBe("finite");
	});
});

describe("runway band on each key row", () => {
	it("carries a band for the key it was computed from", () => {
		// Two keys over different account sets, so a shared band would be
		// visibly wrong: the pinned key sees only the spent account.
		const accounts = [
			mkAccount({
				id: "acc-1",
				name: "acc-1",
				usageData: usage(10, NOW + 4 * HOUR, 40, NOW + 6 * DAY),
			}),
			healthy("acc-2"),
		];
		const keys = [
			mkKey({ id: "k1", name: "Pinned", pinnedAccountId: "acc-1" }),
			mkKey({ id: "k2", name: "Open" }),
		];

		const runways = computeApiKeyRunways(keys, accounts, NOW);

		for (const runway of runways) {
			expect(runway).toHaveProperty("band");
		}
		const pinned = byId(runways, "k1");
		expect(pinned.outcome.kind).toBe("runway");
		expect(pinned.band).not.toBeNull();
		expect(pinned.band?.halfWidthPct).toBe(0.5);
	});

	it("states no band for a key with no accounts to scan", () => {
		const runways = computeApiKeyRunways(
			[mkKey({ id: "k1", pinnedAccountId: "missing" })],
			[healthy("acc-1")],
			NOW,
		);

		expect(byId(runways, "k1").outcome.kind).toBe("no-accounts");
		expect(byId(runways, "k1").band).toBeNull();
	});
});
