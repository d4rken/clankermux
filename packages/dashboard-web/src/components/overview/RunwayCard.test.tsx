import { describe, expect, it } from "bun:test";
import type { KeyRunway } from "@clankermux/core";
import { UNAUTHENTICATED_POOL_KEY_NAME } from "@clankermux/core";
import { renderToStaticMarkup } from "react-dom/server";
import { RunwayCard } from "./RunwayCard";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const DAY = 24 * HOUR;

const accounts = [
	{ id: "acc-1", name: "Primary" },
	{ id: "acc-2", name: "Backup" },
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
			horizonMs: 14 * DAY,
			unprojectableAccountIds: [],
		},
		...overrides,
	};
}

function render(props: Partial<Parameters<typeof RunwayCard>[0]> = {}) {
	return renderToStaticMarkup(
		<RunwayCard runways={[row()]} accounts={accounts} now={NOW} {...props} />,
	);
}

describe("RunwayCard", () => {
	it("states the horizon it checked behind the infinity glyph", () => {
		const html = render();

		expect(html).toContain("Quota Runway");
		expect(html).toContain("∞");
		expect(html).toContain("no run-out within 14d");
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
		expect(html).toContain("1 account unknown");
	});

	it("says out of quota rather than rendering a zero", () => {
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

		expect(html).toContain("Out of quota");
		expect(html).toContain("Primary 5-hour +1 more");
		expect(html).toContain("1 account unknown");
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

	it("captions nothing while the read is still in flight", () => {
		// The caption renders above MetricCard's skeleton, so an outcome-derived
		// caption would state a runway the card is simultaneously still loading.
		const html = render({ loading: true });

		expect(html).not.toContain("no run-out within 14d");
		expect(html).not.toContain("∞");
		expect(html).not.toContain(">0<");
	});

	it("captions nothing when the backing read failed", () => {
		const html = render({ unavailableReason: "API key data unavailable" });

		expect(html).toContain("API key data unavailable");
		expect(html).not.toContain("no run-out within 14d");
	});

	it("states an unknown headline as a resolved dash, not as unavailable", () => {
		// `unknown` outranks a finite runway for the headline, but it is a
		// RESOLVED outcome: the read succeeded and simply cannot be stated.
		// Routing it through MetricCard's unavailable slot would present a
		// successful read as a failed one.
		const html = render({
			runways: [
				row({ keyId: "k1", keyName: "prod", outcome: { kind: "unknown" } }),
				row({
					keyId: "k2",
					keyName: "codex-only",
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
		expect(html).toContain("—");
		// The reason rides in the caption; the warning styling belongs to a
		// backing-read failure alone.
		expect(html).not.toContain("text-warning-strong");
		expect(html).not.toContain(">0<");
	});

	it("presents a failed backing read as unavailable, value and all", () => {
		const html = render({
			unavailableReason: "API key data unavailable",
			runways: [
				row({ keyId: "k1", keyName: "prod" }),
				row({ keyId: "k2", keyName: "codex-only" }),
			],
		});

		expect(html).toContain("API key data unavailable");
		// A value derived from a read that failed must never render.
		expect(html).toContain("text-warning-strong");
		expect(html).not.toContain("∞");
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

	it("names the limiting key when a finite runway identifies one", () => {
		const html = render({
			runways: [
				row({ keyId: "k1", keyName: "prod" }),
				row({
					keyId: "k2",
					keyName: "codex-only",
					pin: { accountId: null, providers: ["codex"] },
					outcome: {
						kind: "runway",
						exhaustsAtMs: NOW + 4 * HOUR,
						durationMs: 4 * HOUR,
						causes: [{ accountId: "acc-1", windowKind: "five_hour" }],
						unprojectableAccountIds: [],
					},
				}),
				row({ keyId: "k3", keyName: "retired", isActive: false }),
			],
		});

		// The worst active key drives the headline and is named in the caption.
		expect(html).toContain("4h");
		expect(html).toContain("codex-only · Primary 5-hour");
		// Only the limiting key is named; the rest are not listed.
		expect(html).not.toContain("prod");
		expect(html).not.toContain("retired");
	});

	it("names no key when every key is beyond the horizon", () => {
		// All beyond-horizon keys tie on severity, so the "worst" is whichever
		// row came first out of the database. Nothing is constraining, so naming
		// that row would present database order as a finding. State the scope
		// the figure covers instead.
		const html = render({
			runways: [
				row({ keyId: "k1", keyName: "prod" }),
				row({ keyId: "k2", keyName: "codex-only" }),
				row({ keyId: "k3", keyName: "scratch" }),
				row({ keyId: "k4", keyName: "retired", isActive: false }),
			],
		});

		expect(html).toContain("3 keys · no run-out within 14d");
		expect(html).not.toContain("prod");
		expect(html).not.toContain("codex-only");
		expect(html).not.toContain("retired");
	});

	it("counts a single active key in the singular", () => {
		expect(render()).toContain("1 key · no run-out within 14d");
	});

	it("names no key when the sole outcome cannot be stated", () => {
		const html = render({
			runways: [
				row({ keyId: "k1", keyName: "prod", outcome: { kind: "unknown" } }),
				row({
					keyId: "k2",
					keyName: "codex-only",
					outcome: { kind: "unknown" },
				}),
			],
		});

		expect(html).toContain("No quota evidence for any account");
		expect(html).not.toContain("prod");
		expect(html).not.toContain("codex-only");
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
		expect(expired).not.toContain("4h");
		expect(expired).not.toContain(">0<");
	});

	it("summarises the synthetic row when authentication is off", () => {
		// With auth off there is a single synthetic key, so there is nothing to
		// disambiguate and its name is never worth the width.
		const html = render({
			runways: [row({ keyId: null, keyName: UNAUTHENTICATED_POOL_KEY_NAME })],
		});

		expect(html).toContain("∞");
		expect(html).toContain("1 key · no run-out within 14d");
		expect(html).not.toContain(UNAUTHENTICATED_POOL_KEY_NAME);
	});
});
