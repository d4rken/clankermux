import { describe, expect, it } from "bun:test";
import type { KeyRunway } from "@clankermux/core";
import { UNAUTHENTICATED_POOL_KEY_NAME } from "@clankermux/core";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import {
	computePoolUsage,
	type PoolUsageResult,
	poolClassOutlook,
} from "../../lib/pool-usage";
import { PoolQuotaCard } from "../quota/PoolQuotaCard";
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
		pin: { accountId: null, providers: null },
		eligibleAccountIds: ["acc-1", "acc-2"],
		outcome: {
			kind: "beyond-horizon",
			horizonMs: 14 * DAY,
			unprojectableAccountIds: [],
		},
		...overrides,
	};
}

function account(over: Partial<AccountResponse> = {}): AccountResponse {
	return {
		id: "acc-1",
		name: "alpha",
		provider: "anthropic",
		paused: false,
		rateLimitedUntil: null,
		tokenExpiresAt: null,
		hasRefreshToken: false,
		usageRateLimitedUntil: null,
		usageData: null,
		...over,
	} as unknown as AccountResponse;
}

/**
 * An Anthropic-style usage payload. Both window resets default to a FUTURE
 * instant: a past reset is a stale reading the panels deliberately refuse to
 * offer, so leaving one in by accident would silently disarm half these
 * assertions.
 */
function usage(
	fiveHourPct: number | null,
	sevenDayPct: number | null,
	over: {
		fiveHourResetMs?: number | null;
		sevenDayResetMs?: number | null;
	} = {},
) {
	const fiveHourResetMs =
		over.fiveHourResetMs === undefined ? NOW + 2 * HOUR : over.fiveHourResetMs;
	const sevenDayResetMs =
		over.sevenDayResetMs === undefined
			? NOW + 90 * 60_000
			: over.sevenDayResetMs;
	return {
		five_hour: {
			utilization: fiveHourPct,
			resets_at:
				fiveHourResetMs == null
					? null
					: new Date(fiveHourResetMs).toISOString(),
		},
		seven_day: {
			utilization: sevenDayPct,
			resets_at:
				sevenDayResetMs == null
					? null
					: new Date(sevenDayResetMs).toISOString(),
		},
	} as never;
}

/**
 * Two servable classes, so "tightest class" means something: the GPT account is
 * the most spent of the two least-used accounts and therefore binds.
 */
const DEFAULT_ACCOUNTS: AccountResponse[] = [
	account({ id: "acc-1", name: "alpha", usageData: usage(48, 48) }),
	account({
		id: "acc-2",
		name: "beta",
		usageData: usage(20, 20, { sevenDayResetMs: NOW + 5 * HOUR }),
	}),
	account({
		id: "acc-3",
		name: "gamma",
		provider: "codex",
		usageData: usage(30, 55, { sevenDayResetMs: NOW + 3 * DAY }),
	}),
];

function pools(accounts: AccountResponse[] = DEFAULT_ACCOUNTS, now = NOW) {
	return {
		fiveHour: computePoolUsage(accounts, "five_hour", now),
		sevenDay: computePoolUsage(accounts, "seven_day", now),
	};
}

function renderOverview(
	windows: {
		fiveHour: PoolUsageResult;
		sevenDay: PoolUsageResult;
	} = pools(),
	runwayProps: {
		runways?: KeyRunway[];
		runwaysLoading?: boolean;
		runwaysUnavailableReason?: string;
		windowsLoading?: boolean;
		windowsUnavailableReason?: string;
		now?: number;
	} = {},
) {
	return renderToStaticMarkup(
		<LimitsCapacityOverview
			fiveHour={windows.fiveHour}
			sevenDay={windows.sevenDay}
			now={runwayProps.now ?? NOW}
			runways={runwayProps.runways ?? [keyRunway()]}
			accounts={RUNWAY_ACCOUNTS}
			windowsLoading={runwayProps.windowsLoading}
			windowsUnavailableReason={runwayProps.windowsUnavailableReason}
			runwaysLoading={runwayProps.runwaysLoading ?? false}
			runwaysUnavailableReason={runwayProps.runwaysUnavailableReason}
		/>,
	);
}

/** How many times `needle` appears in `haystack` (non-overlapping). */
function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * The runway panel's own markup, sliced out of the card.
 *
 * Scoped rather than whole-card because several of these assert on the ABSENCE
 * of a glyph that the sibling panels legitimately render — the 5-hour pacing
 * headline is a count, and a resolved zero there is the reassuring answer.
 * Asserted against the whole card, those checks would fail on a neighbour's
 * correct output instead of on the runway panel's own.
 */
function renderRunway(
	runwayProps: {
		runways?: KeyRunway[];
		runwaysLoading?: boolean;
		runwaysUnavailableReason?: string;
		now?: number;
	} = {},
) {
	const html = renderOverview(pools(), runwayProps);
	const start = html.indexOf('aria-label="Quota runway"');
	if (start === -1) throw new Error("runway panel not rendered");
	return html.slice(start);
}

describe("LimitsCapacityOverview", () => {
	it("headlines the tightest class and the account with the most room in it", () => {
		const html = renderOverview();

		expect(html).toContain("Quota overview");
		expect(html).toContain("Weekly budget");
		expect(html).toContain("5-hour pacing");
		// GPT's least-used account sits at 55%, Claude's at 20%, so GPT binds.
		expect(html).toContain("55% used");
		expect(html).toContain("Tightest class");
		expect(html).toContain("GPT · lowest gamma");
	});

	it("drops the pooled average and the checkpoint cell entirely", () => {
		// Both stated a quantity nobody routes on: an average across accounts
		// that cannot cover for each other, and the next reset of whichever
		// account happened to be soonest regardless of class.
		const html = renderOverview();

		expect(html).not.toContain("Average quota used");
		expect(html).not.toContain("Next checkpoint");
	});

	it("gives every class a row with its own reading and reset", () => {
		const html = renderOverview();

		expect(html).toContain('aria-label="Weekly budget by class"');
		expect(html).toContain("20% used");
		expect(html).toContain("lowest beta");
		expect(html).toContain("resets in 1h 30m · alpha");
		expect(html).toContain("resets in 3d · gamma");
		expect(html).toContain("2 of 2 reporting");
	});

	it("states each class's burn against its sustainable pace", () => {
		// gamma is 55% used with three days left of a seven-day window, so an even
		// burn would sit at 4/7 = 57.1% and this reads just under sustainable.
		const html = renderOverview();

		// Two occurrences: the headline sub-line for the binding class and that
		// class's own row. The tinted span breaks the run of text, so the prefix
		// is asserted separately.
		expect(countOccurrences(html, "1.0× sustainable pace")).toBeGreaterThan(0);
		expect(html).toContain("GPT · lowest gamma");
	});

	it("says nothing about pace for a class with no reset to measure against", () => {
		const html = renderOverview(
			pools([
				account({
					id: "acc-1",
					name: "alpha",
					usageData: usage(20, 20, { sevenDayResetMs: null }),
				}),
			]),
		);

		expect(html).not.toContain("sustainable pace");
	});

	it("says a reset is not reported rather than inventing one", () => {
		const html = renderOverview(
			pools([
				account({
					id: "acc-1",
					name: "alpha",
					usageData: usage(20, 20, { sevenDayResetMs: null }),
				}),
			]),
		);

		expect(html).toContain("reset not reported");
	});

	it("reads a 5h-spent account as waiting on both panels", () => {
		const html = renderOverview(
			pools([
				account({ id: "acc-1", name: "alpha", usageData: usage(100, 40) }),
				account({ id: "acc-2", name: "beta", usageData: usage(20, 20) }),
			]),
		);

		// Weekly row: the account is not reporting weekly, and the reason it is
		// missing is the 5-hour limit rather than a spent weekly quota.
		expect(html).toContain("1 waiting on 5h");
		// Pacing row plus its headline lift time.
		expect(html).toContain("1 waiting");
		expect(html).toContain("next lift in 2h · alpha");
	});

	it("reads an account spent on both windows as weekly spent, not waiting", () => {
		// The 5-hour lift restores nothing here, so promising one would be a
		// promise of capacity that does not arrive until the weekly reset.
		const html = renderOverview(
			pools([
				account({ id: "acc-1", name: "alpha", usageData: usage(100, 100) }),
				account({ id: "acc-2", name: "beta", usageData: usage(20, 20) }),
			]),
		);

		expect(html).toContain("1 weekly spent");
		expect(html).not.toContain("1 waiting on 5h");
		expect(html).toContain("Nothing waiting to lift");
	});

	it("counts an unread account as unknown and never as zero percent", () => {
		// 25%, not 20%: "20% used" contains the literal "0%" and would let the
		// assertion below pass for the wrong reason.
		const html = renderOverview(
			pools([
				account({ id: "acc-1", name: "alpha", usageData: usage(25, 25) }),
				account({ id: "acc-2", name: "beta" }),
			]),
		);

		expect(html).toContain("1 unknown");
		expect(html).not.toContain("0%");
	});

	it("states nothing while the accounts read is in flight", () => {
		const html = renderOverview(pools(), { windowsLoading: true });

		expect(countOccurrences(html, "Reading accounts")).toBe(2);
		expect(html).toContain("Loading");
		expect(html).not.toContain("55% used");
		expect(html).not.toContain('aria-label="Weekly budget by class"');
	});

	it("reports a failed accounts read as unavailable, not as loading", () => {
		const html = renderOverview(pools(), {
			windowsLoading: true,
			windowsUnavailableReason: "Account data unavailable",
		});

		expect(countOccurrences(html, "Account data unavailable")).toBe(2);
		expect(html).not.toContain("Reading accounts");
		expect(html).not.toContain("55% used");
	});

	it("says there are no rolling-quota accounts rather than showing zero", () => {
		const html = renderOverview(pools([]));

		expect(countOccurrences(html, "No rolling-quota accounts")).toBe(2);
		expect(html).not.toContain("0%");
	});

	it("keeps the routing boundary and the calculation note close by", () => {
		const html = renderOverview();

		expect(html).toContain("polled quota state, not routing availability");
		expect(html).toContain('aria-label="About quota calculations"');
		expect(html).toContain('href="#account-utilization"');
	});

	it("describes non-window providers without assuming their billing model", () => {
		const html = renderOverview(
			pools([
				account({ id: "acc-1", name: "alpha", usageData: usage(20, 20) }),
				account({ id: "acc-9", name: "zai-1", provider: "zai" }),
			]),
		);

		expect(html).toContain(
			"Providers without this rolling window: zai-1 (zai)",
		);
	});

	it("agrees with the Overview card about the same class's figure and verdict", () => {
		// The regression this exists to make non-recurring: the two pages ran
		// separate rules for the same question and painted the same pool two
		// colours. Asserted against each other rather than against literals,
		// because pinning both to fixed strings is exactly how they drifted.
		const { fiveHour, sevenDay } = pools();
		const binding = sevenDay.bindingClass;
		if (!binding) throw new Error("no binding class");

		const panelHtml = renderOverview({ fiveHour, sevenDay });
		const cardHtml = renderToStaticMarkup(
			<PoolQuotaCard
				weekly={binding}
				fiveHour={
					fiveHour.classes.find((c) => c.classId === binding.classId) ?? null
				}
				weeklyResult={sevenDay}
			/>,
		);

		const headline = `${Math.round(binding.leastUsed?.pct ?? 0)}% used`;
		expect(panelHtml).toContain(headline);
		expect(cardHtml).toContain(headline);
		expect(panelHtml).toContain(poolClassOutlook(binding).label);
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
						exhaustsAtMs: NOW + 3 * DAY + 2 * HOUR,
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

		// Hedged rather than categorical, and warning rather than destructive:
		// acc-9 was DROPPED before the scan ran, so "spent" describes the accounts
		// that could be read, not the whole pool. The dropped one may be healthy.
		expect(html).toContain("Spent, unconfirmed");
		expect(html).not.toContain("Out of quota");
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
					pin: { accountId: null, providers: ["codex"] },
					eligibleAccountIds: ["acc-1"],
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

	it("counts a served runway down, then calls it out of quota at its deadline", () => {
		const runways = [
			keyRunway({
				outcome: {
					kind: "runway",
					exhaustsAtMs: NOW + 4 * HOUR,
					durationMs: 4 * HOUR,
					causes: [{ accountId: "acc-1", windowKind: "five_hour" }],
					unprojectableAccountIds: [],
				},
			}),
		];

		const fresh = renderRunway({ runways, now: NOW });
		expect(fresh).toContain("4h");
		expect(fresh).toContain("Runs out");

		const later = renderRunway({ runways, now: NOW + HOUR });
		expect(later).toContain("3h");

		// The rows are served from a poll, so a figure that outlived its own
		// deadline must not keep counting or drop to a zero.
		const expired = renderRunway({ runways, now: NOW + 5 * HOUR });
		expect(expired).toContain("Out of quota");
		expect(expired).toContain("alpha 5-hour");
		expect(expired).not.toContain("Runs out");
		expect(expired).not.toContain(">0<");
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
		// ">2 accounts<" is the runway panel's own cell.
		expect(html).not.toContain(">2 accounts<");
		expect(html).not.toContain("Unpinned");
		expect(html).not.toContain("prod");
		expect(html).toContain("Not reported");
		expect(countOccurrences(html, "Full breakdown")).toBe(0);
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
					pin: { accountId: null, providers: ["codex"] },
					eligibleAccountIds: ["acc-1"],
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
		expect(countOccurrences(html, "Full breakdown")).toBe(1);
		expect(html).not.toContain(">0<");
	});
});
