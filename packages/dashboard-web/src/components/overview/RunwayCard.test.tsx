import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KeyRunway } from "../../lib/api-key-runway";
import { UNAUTHENTICATED_POOL_KEY_NAME } from "../../lib/api-key-runway";
import { RunwayCard } from "./RunwayCard";

const HOUR = 60 * 60 * 1000;
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

function render(props: Partial<Parameters<typeof RunwayCard>[0]> = {}) {
	return renderToStaticMarkup(
		<RunwayCard runways={[row()]} accounts={accounts} {...props} />,
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
						exhaustsAtMs: 1,
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
						exhaustsAtMs: 1,
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

	it("lists one sub-row per active key and names the limiting one", () => {
		const html = render({
			runways: [
				row({ keyId: "k1", keyName: "prod" }),
				row({
					keyId: "k2",
					keyName: "codex-only",
					pinLabel: "Pinned → codex",
					outcome: {
						kind: "runway",
						exhaustsAtMs: 1,
						durationMs: 4 * HOUR,
						causes: [{ accountId: "acc-1", windowKind: "five_hour" }],
						unprojectableAccountIds: [],
					},
				}),
				row({ keyId: "k3", keyName: "retired", isActive: false }),
			],
		});

		expect(html).toContain("prod");
		expect(html).toContain("codex-only");
		// Inactive keys describe no traffic, so they stay out of the breakdown.
		expect(html).not.toContain("retired");
		// The worst active key drives the headline and is named in the caption.
		expect(html).toContain("4h");
		expect(html).toContain("codex-only · Primary 5-hour");
	});

	it("labels the synthetic row when authentication is off", () => {
		const html = render({
			runways: [row({ keyId: null, keyName: UNAUTHENTICATED_POOL_KEY_NAME })],
		});

		expect(html).toContain(UNAUTHENTICATED_POOL_KEY_NAME);
	});
});
