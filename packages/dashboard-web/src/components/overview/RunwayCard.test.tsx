import { describe, expect, it } from "bun:test";
import type { KeyRunway } from "@clankermux/core";
import { UNAUTHENTICATED_POOL_KEY_NAME } from "@clankermux/core";
import type { RunwayAccountSummary } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { RunwayCard } from "./RunwayCard";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const DAY = 24 * HOUR;
const HORIZON = 14 * DAY;

function account(
	id: string,
	name: string,
	windows: RunwayAccountSummary["windows"] = [],
): RunwayAccountSummary {
	return {
		id,
		name,
		provider: "anthropic",
		metered: true,
		usageAsOfMs: NOW,
		windows,
	};
}

const accounts: RunwayAccountSummary[] = [
	account("acc-1", "Primary", [
		{
			kind: "five_hour",
			utilizationPct: 12,
			resetsAtMs: NOW + 2 * HOUR,
			prediction: null,
		},
		{
			kind: "seven_day",
			utilizationPct: 45,
			resetsAtMs: NOW + 4 * DAY,
			prediction: null,
		},
	]),
	account("acc-2", "Backup", [
		{
			kind: "five_hour",
			utilizationPct: 3,
			resetsAtMs: NOW + 5 * HOUR,
			prediction: null,
		},
	]),
];

function row(overrides: Partial<KeyRunway> = {}): KeyRunway {
	return {
		keyId: "k1",
		keyName: "prod",
		isActive: true,
		pin: { accountId: null, providers: null },
		eligibleAccountIds: ["acc-1", "acc-2"],
		outcome: {
			kind: "beyond-horizon",
			horizonMs: HORIZON,
			unprojectableAccountIds: [],
		},
		...overrides,
	};
}

function render(props: Partial<Parameters<typeof RunwayCard>[0]> = {}) {
	return renderToStaticMarkup(
		<RunwayCard
			runways={[row()]}
			accounts={accounts}
			horizonMs={HORIZON}
			now={NOW}
			{...props}
		/>,
	);
}

describe("RunwayCard", () => {
	it("states the horizon it checked behind the infinity glyph", () => {
		const html = render();

		expect(html).toContain("Quota Runway");
		expect(html).toContain("∞");
		// The strip carries the scope the glyph is measured against, so the
		// figure can be read rather than decoded from a caption.
		expect(html).toContain("no run-out");
		expect(html).toContain("14d");
		expect(html).not.toContain(">0<");
	});

	it("shows a finite runway with the account and window that ran out", () => {
		const html = render({
			runways: [
				row({
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
		// The cause sits under the marker on the strip, at the instant it
		// explains, rather than competing for the caption line.
		expect(html).toContain("Backup weekly");
		expect(html).not.toContain("≥");
	});

	it("marks a figure computed without every account as a lower bound", () => {
		const html = render({
			runways: [
				row({
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
		expect(html).toContain("Unobserved");
		expect(html).toContain("1 account");
	});

	it("hedges a spent pool it could not fully see, and never zeroes", () => {
		const html = render({
			runways: [
				row({
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

		// Hedged, not categorical: the scan dropped acc-9 before running, so
		// "spent" describes the accounts it could read, not the whole pool.
		expect(html).toContain("Spent, unconfirmed");
		expect(html).not.toContain("Out of quota");
		expect(html).toContain("Primary 5-hour +1 more");
		expect(html).toContain("1 account");
		expect(html).not.toContain(">0<");
	});

	it("renders a dash and a reason when no account has quota evidence", () => {
		const html = render({
			runways: [row({ outcome: { kind: "unknown" } })],
		});

		expect(html).toContain("—");
		expect(html).toContain("No quota evidence for any account");
		expect(html).not.toContain("∞");
		expect(html).not.toContain(">0<");
	});

	it("renders a dash when a key can route to nothing", () => {
		const html = render({
			runways: [row({ outcome: { kind: "no-accounts" } })],
		});

		expect(html).toContain("—");
		expect(html).toContain("No accounts this key can route to");
		expect(html).not.toContain(">0<");
	});

	it("reports a failed accounts read as unavailable, not as loading", () => {
		const html = render({
			loading: true,
			unavailableReason: "Account data unavailable",
		});

		expect(html).toContain("—");
		expect(html).toContain("Account data unavailable");
		expect(html).not.toContain("∞");
		expect(html).not.toContain(">0<");
	});

	it("reports a failed API-key read as unavailable", () => {
		const html = render({ unavailableReason: "API key data unavailable" });

		expect(html).toContain("—");
		expect(html).toContain("API key data unavailable");
		expect(html).not.toContain(">0<");
	});

	it("draws no strip or sub-rows while the read is still in flight", () => {
		// Everything derived from the read shares one gate. The strip renders
		// under the value inside MetricCard's resolved branch, so a pending read
		// cannot put a horizon beside its own skeleton.
		const html = render({ loading: true });

		expect(html).not.toContain("no run-out");
		expect(html).not.toContain("∞");
		expect(html).not.toContain("Tightest");
		expect(html).not.toContain(">0<");
	});

	it("draws no strip or sub-rows when the backing read failed", () => {
		const html = render({ unavailableReason: "API key data unavailable" });

		expect(html).toContain("API key data unavailable");
		expect(html).not.toContain("no run-out");
		expect(html).not.toContain("Tightest");
	});

	it("renders no per-key rows, only the summary", () => {
		// The Overview tile is a summary in proportion with its neighbours; the
		// per-key breakdown lives on the Usage page.
		const html = render({
			runways: [
				row({ keyId: "k1", keyName: "prod" }),
				row({ keyId: "k2", keyName: "codex-only" }),
				row({ keyId: "k3", keyName: "retired", isActive: false }),
			],
		});

		expect(html).not.toContain("prod");
		expect(html).not.toContain("codex-only");
		expect(html).not.toContain("retired");
		expect(html).toContain("∞");
	});

	it("captions the scope the figure covers, not a key name", () => {
		// All beyond-horizon keys tie on severity, so the "worst" is whichever
		// row came first out of the database. Nothing is constraining, so naming
		// that row would present database order as a finding.
		const html = render({
			runways: [
				row({ keyId: "k1", keyName: "prod" }),
				row({ keyId: "k2", keyName: "codex-only" }),
				row({ keyId: "k3", keyName: "scratch" }),
				row({ keyId: "k4", keyName: "retired", isActive: false }),
			],
		});

		expect(html).toContain("3 keys");
		expect(html).not.toContain("prod");
		expect(html).not.toContain("retired");
	});

	it("counts a single active key in the singular", () => {
		expect(render()).toContain("1 key");
	});

	describe("evidence sub-rows", () => {
		it("reports the tightest window and the soonest reset", () => {
			const html = render();

			// The BINDING constraint, not the pool average the tiles beside it
			// report: acc-1's weekly window at 45% beats every 5-hour reading.
			expect(html).toContain("Tightest");
			expect(html).toContain("weekly · 45%");
			expect(html).toContain("Next reset");
			expect(html).toContain("2h");
		});

		it("dashes rather than zeroes when no window reports anything", () => {
			const html = render({
				accounts: [account("acc-1", "Primary"), account("acc-2", "Backup")],
			});

			expect(html).toContain("Tightest");
			expect(html).not.toContain(">0<");
			expect(html).not.toContain("0%");
		});

		it("ignores accounts no active key can reach", () => {
			// A reading from an account outside every key's pin never fed the
			// runway figure, so it must not drive the sub-rows either.
			const html = render({
				runways: [row({ eligibleAccountIds: ["acc-2"] })],
			});

			expect(html).toContain("5-hour · 3%");
			expect(html).not.toContain("weekly · 45%");
		});
	});

	describe("keys with no evidence", () => {
		const cold = () =>
			row({ keyId: "k2", keyName: "codex-only", outcome: { kind: "unknown" } });

		it("keeps a stateable figure and says how many keys it covers", () => {
			// The whole point of the stateable headline: one un-polled account
			// used to blank a summary the other key had perfect evidence for.
			const html = render({ runways: [row(), cold()] });

			expect(html).toContain("∞");
			expect(html).toContain("1 of 2 keys");
			expect(html).toContain("Unobserved");
			expect(html).toContain("1 key");
			expect(html).not.toContain("No quota evidence for any account");
		});

		it("falls back to a dash when no key can be stated at all", () => {
			// The floor holds: with no evidence anywhere the tile still refuses to
			// name a figure rather than reaching for the least-bad row.
			const html = render({
				runways: [
					row({ outcome: { kind: "unknown" } }),
					row({ keyId: "k2", outcome: { kind: "unknown" } }),
				],
			});

			expect(html).toContain("—");
			expect(html).toContain("No quota evidence for any account");
			expect(html).not.toContain("∞");
			// A RESOLVED dash, not the unavailable slot: the read succeeded and
			// simply has nothing to project from. The warning styling belongs to a
			// backing-read failure alone.
			expect(html).not.toContain("text-warning-strong");
		});

		it("marks a genuinely failed read with the warning styling", () => {
			// The other side of the same line — this read produced nothing at all.
			const html = render({ unavailableReason: "Runway data unavailable" });

			expect(html).toContain("text-warning-strong");
			expect(html).toContain("Runway data unavailable");
		});

		it("counts both missing keys and missing accounts", () => {
			const html = render({
				runways: [
					row({
						outcome: {
							kind: "runway",
							exhaustsAtMs: NOW + 6 * HOUR,
							durationMs: 6 * HOUR,
							causes: [{ accountId: "acc-1", windowKind: "five_hour" }],
							unprojectableAccountIds: ["acc-9", "acc-8"],
						},
					}),
					cold(),
				],
			});

			// The two pull the figure in OPPOSITE directions — a hidden key can
			// only make it longer, a hidden account only shorter — so both are on
			// screen rather than collapsed into one number.
			expect(html).toContain("1 key · 2 accounts");
			// And the `≥` is withdrawn: it asserts "at least 6h", which the hidden
			// key falsifies outright if it runs out in two. With the bounds
			// pointing opposite ways the only honest figure is the bare duration.
			expect(html).toContain("6h");
			expect(html).not.toContain("≥");
		});

		it("keeps the lower-bound marker when only accounts are missing", () => {
			// One direction alone: every key is stateable, so the figure can only
			// be shortened by the accounts the winning key could not read.
			const html = render({
				runways: [
					row({
						outcome: {
							kind: "runway",
							exhaustsAtMs: NOW + 6 * HOUR,
							durationMs: 6 * HOUR,
							causes: [{ accountId: "acc-1", windowKind: "five_hour" }],
							unprojectableAccountIds: ["acc-9"],
						},
					}),
				],
			});

			expect(html).toContain("≥ 6h");
			expect(html).toContain("1 account");
		});

		it("says nothing about unobserved keys when every key is stateable", () => {
			expect(render()).not.toContain("Unobserved");
		});
	});

	it("counts a served runway down against its own clock", () => {
		// The rows come from a poll, so rendering the server's `durationMs` would
		// freeze the figure between refreshes.
		const runways = [
			row({
				outcome: {
					kind: "runway",
					exhaustsAtMs: NOW + 4 * HOUR,
					durationMs: 4 * HOUR,
					causes: [{ accountId: "acc-1", windowKind: "five_hour" }],
					unprojectableAccountIds: [],
				},
			}),
		];

		expect(render({ runways, now: NOW })).toContain("4h");
		expect(render({ runways, now: NOW + HOUR })).toContain("3h");
		// Past its own deadline with no newer data, the projection's answer is
		// that there is no quota — not a stale "4h" and not a zero.
		const expired = render({ runways, now: NOW + 5 * HOUR });
		expect(expired).toContain("Out of quota");
		expect(expired).not.toContain(">0<");
	});

	it("summarises the synthetic row when authentication is off", () => {
		const html = render({
			runways: [row({ keyId: null, keyName: UNAUTHENTICATED_POOL_KEY_NAME })],
		});

		expect(html).toContain("∞");
		expect(html).toContain("1 key");
		expect(html).not.toContain(UNAUTHENTICATED_POOL_KEY_NAME);
	});
});
