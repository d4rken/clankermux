import { describe, expect, it } from "bun:test";
import type { ApiKeyResponse } from "@clankermux/types";
import {
	computeApiKeyRunways,
	effectiveRunwayOutcome,
	type KeyRunway,
	type RunwayAccountSource,
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
