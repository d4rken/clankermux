import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KeyRunway } from "../../lib/api-key-runway";
import { UNAUTHENTICATED_POOL_KEY_NAME } from "../../lib/api-key-runway";
import type { FamilyWeeklyUsage, PoolUsageResult } from "../../lib/pool-usage";
import { LimitsCapacityOverview } from "./LimitsCapacityOverview";

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const RUNWAY_ACCOUNTS = [
	{ id: "acc-1", name: "alpha" },
	{ id: "acc-2", name: "beta" },
];

function keyRunway(overrides: Partial<KeyRunway> = {}): KeyRunway {
	return {
		keyId: "k1",
		keyName: "prod",
		isActive: true,
		pinLabel: "Unpinned",
		eligibleAccountCount: 2,
		outcome: {
			kind: "beyond-horizon",
			horizonMs: 14 * DAY,
			unprojectableAccountIds: [],
		},
		...overrides,
	};
}

function poolResult(overrides: Partial<PoolUsageResult> = {}): PoolUsageResult {
	return {
		average: 34,
		activeAverage: 34,
		worst: { name: "alpha", pct: 48 },
		contributing: [
			{
				accountId: "acc-1",
				name: "alpha",
				pct: 48,
				resetMs: NOW + 90 * 60_000,
			},
			{
				accountId: "acc-2",
				name: "beta",
				pct: 20,
				resetMs: NOW + 3 * 60 * 60_000,
			},
		],
		exhausted: [],
		excluded: [],
		fallback: [],
		earliestResetMs: NOW + 90 * 60_000,
		earliestResetAccountName: "alpha",
		atRisk: [],
		familyWeekly: [],
		...overrides,
	};
}

function renderOverview(
	fiveHour = poolResult(),
	sevenDay = poolResult({
		average: 51,
		activeAverage: 51,
		worst: { name: "beta", pct: 62 },
	}),
	runwayProps: {
		runways?: KeyRunway[];
		runwaysLoading?: boolean;
		runwaysUnavailableReason?: string;
	} = {},
) {
	return renderToStaticMarkup(
		<LimitsCapacityOverview
			fiveHour={fiveHour}
			sevenDay={sevenDay}
			now={NOW}
			runways={runwayProps.runways ?? [keyRunway()]}
			accounts={RUNWAY_ACCOUNTS}
			runwaysLoading={runwayProps.runwaysLoading ?? false}
			runwaysUnavailableReason={runwayProps.runwaysUnavailableReason}
		/>,
	);
}

/** How many times `needle` appears in `haystack` (non-overlapping). */
function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function renderRunway(
	runwayProps: {
		runways?: KeyRunway[];
		runwaysLoading?: boolean;
		runwaysUnavailableReason?: string;
	} = {},
) {
	return renderOverview(poolResult(), poolResult(), runwayProps);
}

describe("LimitsCapacityOverview", () => {
	it("turns the two windows into comparable visual summaries", () => {
		const html = renderOverview();

		expect(html).toContain("Quota overview");
		expect(html).toContain("5-hour window");
		expect(html).toContain("7-day window");
		expect(html).toContain("34%");
		expect(html).toContain("51%");
		expect(html).toContain("Average quota used");
		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-valuenow="34"');
		expect(html).toContain("2 of 2 accounts");
		expect(html).toContain("in 1h 30m");
		expect(html).toContain("Next checkpoint");
		expect(html).toContain("On pace");
	});

	it("keeps the routing boundary and aggregation explanation close by", () => {
		const html = renderOverview();

		expect(html).toContain("polled quota state, not routing availability");
		expect(html).toContain('aria-label="About quota calculations"');
		expect(html).toContain("Full breakdown");
		expect(html).toContain('href="#account-utilization"');
	});

	it("surfaces only exceptional account and model-family states inline", () => {
		const family: FamilyWeeklyUsage = {
			family: "fable",
			label: "Fable",
			worstPct: 92,
			worstAccountName: "weekly-hot",
			earliestResetMs: NOW + 2 * 24 * 60 * 60_000,
			elevated: true,
			exhaustedCount: 0,
			elevatedCount: 1,
			accounts: [
				{
					name: "weekly-hot",
					pct: 92,
					resetMs: NOW + 2 * 24 * 60 * 60_000,
				},
			],
		};
		const sevenDay = poolResult({
			average: 74,
			activeAverage: 74,
			atRisk: [
				{
					accountId: "acc-2",
					name: "weekly-hot",
					pct: 74,
					resetMs: NOW + 24 * 60 * 60_000,
					exhaustsAtMs: NOW + 4 * 60 * 60_000,
					timeToExhaustMs: 4 * 60 * 60_000,
					remainingMs: 24 * 60 * 60_000,
				},
			],
			familyWeekly: [family],
		});

		const html = renderOverview(poolResult(), sevenDay);

		expect(html).toContain("1 account may exhaust before reset");
		expect(html).toContain("Fable weekly at 92%");
		expect(html).toContain("Watch");
	});

	it("distinguishes unavailable and unknown accounts from reported usage", () => {
		const fiveHour = poolResult({
			average: 56,
			activeAverage: 34,
			exhausted: [{ name: "paused", reason: "paused", resetMs: null }],
			excluded: [{ name: "waiting", reason: "no_usage_data", resetMs: null }],
		});

		const html = renderOverview(fiveHour);

		expect(html).toContain("2 of 4 accounts");
		expect(html).toContain("1 unavailable");
		expect(html).toContain("1 unknown");
		expect(html).not.toContain("2 of 4 active");
	});

	it("does not call a partial account-wide reading on pace", () => {
		const partial = poolResult({
			average: 20,
			activeAverage: 20,
			excluded: [{ name: "waiting", reason: "no_usage_data", resetMs: null }],
		});

		const html = renderOverview(partial, partial);

		expect(html).toContain("Watch");
		expect(html).not.toContain("On pace");
	});

	it("keeps scoped-family alerts separate from the account-wide outlook", () => {
		const exhaustedFamily: FamilyWeeklyUsage = {
			family: "fable",
			label: "Fable",
			worstPct: 100,
			worstAccountName: "weekly-hot",
			earliestResetMs: NOW + 2 * 24 * 60 * 60_000,
			elevated: true,
			exhaustedCount: 1,
			elevatedCount: 1,
			accounts: [
				{
					name: "weekly-hot",
					pct: 100,
					resetMs: NOW + 2 * 24 * 60 * 60_000,
				},
			],
		};
		const sevenDay = poolResult({ familyWeekly: [exhaustedFamily] });

		const html = renderOverview(poolResult(), sevenDay);

		expect(html).toContain("On pace");
		expect(html).not.toContain("Limit reached");
		expect(html).toContain("Fable weekly exhausted on 1 of 1 account");
	});

	it("never presents missing evidence as zero usage", () => {
		const empty = poolResult({
			average: null,
			activeAverage: null,
			worst: null,
			contributing: [],
			exhausted: [],
			excluded: [],
			earliestResetMs: null,
			earliestResetAccountName: null,
		});

		const html = renderOverview(empty, empty);

		expect(html).toContain("Account-wide unknown");
		expect(html).toContain("No reported account-wide average");
		expect(html).not.toContain("0%");
	});

	it("describes non-window providers without assuming their billing model", () => {
		const withFallback = poolResult({
			fallback: [{ name: "zai", provider: "zai" }],
		});

		const html = renderOverview(withFallback);

		expect(html).toContain("Providers without this rolling window");
		expect(html).not.toContain(
			"Pay-as-you-go accounts, not included in this rolling-quota average",
		);
	});
});

describe("LimitsCapacityOverview runway panel", () => {
	it("states the horizon it checked behind the infinity glyph", () => {
		const html = renderRunway();

		expect(html).toContain("Quota runway");
		expect(html).toContain("∞");
		expect(html).toContain("no run-out within 14d");
		expect(html).toContain("No run-out projected");
		expect(html).toContain("2 accounts");
	});

	it("names the account and window that runs out first", () => {
		const html = renderRunway({
			runways: [
				keyRunway({
					outcome: {
						kind: "runway",
						exhaustsAtMs: NOW + 3 * DAY,
						durationMs: 3 * DAY + 2 * HOUR,
						causes: [{ accountId: "acc-2", windowKind: "seven_day" }],
						unprojectableAccountIds: [],
					},
				}),
			],
		});

		expect(html).toContain("3d 2h");
		expect(html).toContain("beta weekly");
		expect(html).toContain("Binding window");
		expect(html).toContain("Runs out");
		expect(html).not.toContain("≥");
	});

	it("marks a figure computed without every account as a lower bound", () => {
		const html = renderRunway({
			runways: [
				keyRunway({
					outcome: {
						kind: "runway",
						exhaustsAtMs: NOW + 12 * HOUR,
						durationMs: 12 * HOUR,
						causes: [{ accountId: "acc-1", windowKind: "five_hour" }],
						unprojectableAccountIds: ["acc-9"],
					},
				}),
			],
		});

		expect(html).toContain("≥ 12h");
		expect(html).toContain("1 account unknown");
	});

	it("says out of quota, excluded accounts and all, rather than zero", () => {
		const html = renderRunway({
			runways: [
				keyRunway({
					outcome: {
						kind: "out-now",
						causes: [
							{ accountId: "acc-1", windowKind: "five_hour" },
							{ accountId: "acc-2", windowKind: "five_hour" },
						],
						unprojectableAccountIds: ["acc-9"],
					},
				}),
			],
		});

		expect(html).toContain("Out of quota");
		expect(html).toContain("alpha 5-hour +1 more");
		expect(html).toContain("1 account unknown");
		expect(html).not.toContain(">0<");
	});

	it("reports no quota evidence as a dash, never a zero", () => {
		const html = renderRunway({
			runways: [keyRunway({ outcome: { kind: "unknown" } })],
		});

		expect(html).toContain("No quota evidence for any account");
		expect(html).toContain("Runway unknown");
		expect(html).not.toContain("∞");
		expect(html).not.toContain(">0<");
	});

	it("reports a key that can route to nothing as a dash", () => {
		const html = renderRunway({
			runways: [keyRunway({ outcome: { kind: "no-accounts" } })],
		});

		expect(html).toContain("No accounts this key can route to");
		expect(html).not.toContain(">0<");
	});

	it("reports a failed accounts read as unavailable, not as loading", () => {
		const html = renderRunway({
			runwaysLoading: true,
			runwaysUnavailableReason: "Account data unavailable",
		});

		expect(html).toContain("Account data unavailable");
		expect(html).not.toContain("Reading keys and accounts");
		expect(html).not.toContain("∞");
		expect(html).not.toContain(">0<");
	});

	it("reports a failed API-key read as unavailable", () => {
		const html = renderRunway({
			runwaysUnavailableReason: "API key data unavailable",
		});

		expect(html).toContain("API key data unavailable");
		expect(html).not.toContain(">0<");
	});

	it("breaks down every active key and leaves the inactive ones out", () => {
		const html = renderRunway({
			runways: [
				keyRunway({ keyId: "k1", keyName: "prod" }),
				keyRunway({
					keyId: "k2",
					keyName: "codex-only",
					pinLabel: "Pinned → codex",
					eligibleAccountCount: 1,
					outcome: {
						kind: "runway",
						exhaustsAtMs: NOW + 4 * HOUR,
						durationMs: 4 * HOUR,
						causes: [{ accountId: "acc-1", windowKind: "five_hour" }],
						unprojectableAccountIds: [],
					},
				}),
				keyRunway({ keyId: "k3", keyName: "retired", isActive: false }),
			],
		});

		expect(html).toContain("prod");
		expect(html).toContain("codex-only");
		expect(html).toContain("Pinned → codex");
		expect(html).toContain("1 account");
		expect(html).not.toContain("retired");
		// The worst ACTIVE key drives the headline.
		expect(html).toContain("4h");
	});

	it("labels the synthetic row when authentication is off", () => {
		const html = renderRunway({
			runways: [
				keyRunway({ keyId: null, keyName: UNAUTHENTICATED_POOL_KEY_NAME }),
			],
		});

		expect(html).toContain(UNAUTHENTICATED_POOL_KEY_NAME);
	});

	it("states nothing at all while the key read is in flight", () => {
		// The tab computes runways from `apiKeys ?? []`, so a pending key read
		// still yields a full-looking row. None of it may be shown next to the
		// panel's own "Reading keys and accounts" subtext.
		const html = renderRunway({ runwaysLoading: true });

		expect(html).toContain("Reading keys and accounts");
		expect(html).toContain("Loading");
		// No figure, no eligible-account count, no pin label, no breakdown.
		expect(html).not.toContain("∞");
		expect(html).not.toContain("no run-out within 14d");
		// ">2 accounts<" is the runway panel's own cell; the window panels render
		// "2 of 2 accounts".
		expect(html).not.toContain(">2 accounts<");
		expect(html).not.toContain("Unpinned");
		expect(html).not.toContain("prod");
		expect(html).toContain("Not reported");
		// Only the two window panels disclose a breakdown.
		expect(countOccurrences(html, "Full breakdown")).toBe(2);
		expect(html).not.toContain(">0<");
	});

	it("keeps the breakdown under an unknown headline", () => {
		// `unknown` poisons the headline but is a RESOLVED outcome: the other
		// key's definite runway has to stay reachable.
		const html = renderRunway({
			runways: [
				keyRunway({
					keyId: "k1",
					keyName: "prod",
					outcome: { kind: "unknown" },
				}),
				keyRunway({
					keyId: "k2",
					keyName: "codex-only",
					pinLabel: "Pinned → codex",
					eligibleAccountCount: 1,
					outcome: {
						kind: "runway",
						exhaustsAtMs: NOW + 4 * HOUR,
						durationMs: 4 * HOUR,
						causes: [{ accountId: "acc-1", windowKind: "five_hour" }],
						unprojectableAccountIds: [],
					},
				}),
			],
		});

		expect(html).toContain("No quota evidence for any account");
		expect(html).toContain("codex-only");
		expect(html).toContain("Pinned → codex");
		expect(html).toContain("4h");
		expect(countOccurrences(html, "Full breakdown")).toBe(3);
		expect(html).not.toContain(">0<");
	});
});
