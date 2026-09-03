import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	FamilyWeeklyUsage,
	PoolUsageResult,
} from "../../../lib/pool-usage";
import { PoolDetailSection } from "../../quota/PoolDetailSection";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function emptyPool(familyWeekly: FamilyWeeklyUsage[]): PoolUsageResult {
	return {
		contributing: [],
		exhausted: [],
		excluded: [],
		fallback: [],
		earliestResetMs: NOW + 3 * DAY,
		earliestResetAccountName: "alpha",
		atRisk: [],
		familyWeekly,
	};
}

function render(familyWeekly: FamilyWeeklyUsage[]): string {
	return renderToStaticMarkup(
		<PoolDetailSection result={emptyPool(familyWeekly)} window="seven_day" />,
	);
}

/**
 * The markup of one per-account row in the popover's family list, so an
 * assertion can be scoped to the account it is about rather than to the whole
 * document.
 */
function rowFor(html: string, name: string): string {
	const match = html.match(new RegExp(`title="${name}">[\\s\\S]*?</li>`));
	if (match === null) throw new Error(`no rendered row for "${name}"`);
	return match[0];
}

/**
 * The opening tag of the element that renders the projection line — the one
 * whose tone the test below is about.
 */
function projectionTag(html: string): string {
	const at = html.indexOf("projected to run out");
	if (at === -1) throw new Error("no projection line rendered");
	const start = html.lastIndexOf("<div", at);
	return html.slice(start, html.indexOf(">", start) + 1);
}

/** Absolute instants are rendered by the card's own locale formatter. */
function instantLabel(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function family(overrides: Partial<FamilyWeeklyUsage>): FamilyWeeklyUsage {
	return {
		family: "fable",
		label: "Fable",
		worstPct: 80,
		worstAccountName: "alpha",
		earliestResetMs: NOW + 3 * DAY,
		elevated: true,
		exhaustedCount: 0,
		elevatedCount: 1,
		atRiskCount: 0,
		soonestExhaustsAtMs: null,
		accounts: [
			{
				accountId: "id-alpha",
				name: "alpha",
				pct: 80,
				resetMs: NOW + 3 * DAY,
				exhaustsAtMs: null,
			},
		],
		...overrides,
	};
}

describe("PoolDetailSection family at-risk projection", () => {
	it("says nothing when no account is projected to run out", () => {
		const html = render([family({})]);
		expect(html).toContain("Fable");
		expect(html).not.toContain("projected to run out");
	});

	it("names the projected instant for a single-account family", () => {
		const exhaustsAtMs = NOW + DAY;
		const html = render([
			family({
				atRiskCount: 1,
				soonestExhaustsAtMs: exhaustsAtMs,
				accounts: [
					{
						accountId: "id-alpha",
						name: "alpha",
						pct: 80,
						resetMs: NOW + 3 * DAY,
						exhaustsAtMs,
					},
				],
			}),
		]);
		expect(html).toContain("projected to run out");
		expect(html).toContain(instantLabel(exhaustsAtMs));
		// A single-account family must not claim a pool-wide fraction.
		expect(html).not.toContain("of 1 projected");
	});

	it("states the fraction and the soonest instant across several accounts", () => {
		const soonest = NOW + DAY;
		const later = NOW + 2 * DAY;
		const html = render([
			family({
				worstPct: 90,
				worstAccountName: "sooner",
				atRiskCount: 2,
				soonestExhaustsAtMs: soonest,
				elevatedCount: 2,
				accounts: [
					{
						accountId: "id-sooner",
						name: "sooner",
						pct: 90,
						resetMs: NOW + 3 * DAY,
						exhaustsAtMs: soonest,
					},
					{
						accountId: "id-later",
						name: "later",
						pct: 80,
						resetMs: NOW + 3 * DAY,
						exhaustsAtMs: later,
					},
					{
						accountId: "id-fine",
						name: "fine",
						pct: 20,
						resetMs: NOW + 3 * DAY,
						exhaustsAtMs: null,
					},
				],
			}),
		]);
		expect(html).toContain("2 of 3 projected to run out");
		// Each row must carry ITS OWN instant, and the unprojected row none at all —
		// asserting the three strings appear somewhere would pass even if the
		// timestamps were rendered beside the wrong accounts.
		expect(rowFor(html, "sooner")).toContain(instantLabel(soonest));
		expect(rowFor(html, "later")).toContain(instantLabel(later));
		expect(rowFor(html, "fine")).not.toContain("out ");
		expect(rowFor(html, "fine")).toContain("20%");
	});

	it("does not tint the projection as a warning", () => {
		const exhaustsAtMs = NOW + DAY;
		const html = render([
			family({
				atRiskCount: 1,
				soonestExhaustsAtMs: exhaustsAtMs,
				accounts: [
					{
						accountId: "id-alpha",
						name: "alpha",
						pct: 80,
						resetMs: NOW + 3 * DAY,
						exhaustsAtMs,
					},
				],
			}),
		]);
		// The estimate is always the low-confidence lifetime average, so it must
		// never carry the warning or destructive tone the percentages use. The
		// line declares its tone as `data-tone`, so this holds the rule itself
		// rather than the class that currently implements it — and it is asserted
		// on the tag that OPENS the projection line, so neither a tint elsewhere
		// on the card nor a token rename can decide the outcome.
		const tag = projectionTag(html);
		expect(tag).toContain('data-tone="neutral"');
		expect(tag).not.toContain("warning");
		expect(tag).not.toContain("destructive");
	});
});
